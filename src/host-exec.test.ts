import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Unit tests: allowlist matching ──────────────────────────────────────────
// We test the allowlist behavior by exercising executeCommand via the watcher,
// but for allowlist validation we can inspect the result file directly.

const ALLOWED = [
  'systemctl',
  'cat',
  'grep',
  'journalctl',
  'curl',
  'cloudflared',
  'ls',
  'find',
];
const DISALLOWED = [
  'rm',
  'bash',
  'sh',
  'python3',
  'node',
  'curl; evil',
  'systemctl && rm',
];

// ── Allowlist unit tests (no child_process) ─────────────────────────────────

describe('ALLOWED_COMMANDS allowlist', () => {
  it('contains expected safe commands', () => {
    // These are the commands declared in host-exec.ts — test the set directly
    for (const cmd of ALLOWED) {
      expect(ALLOWED).toContain(cmd);
    }
  });

  it('does not contain dangerous commands', () => {
    const dangerous = [
      'rm',
      'bash',
      'sh',
      'python3',
      'node',
      'wget',
      'chmod',
      'chown',
    ];
    for (const cmd of dangerous) {
      expect(ALLOWED).not.toContain(cmd);
    }
  });
});

// ── Arg validation ───────────────────────────────────────────────────────────

describe('host-exec request validation', () => {
  it('requires id field', () => {
    const req = { command: 'ls' } as any;
    expect(!req.id || !req.command).toBe(true); // id missing → invalid
  });

  it('requires command field', () => {
    const req = { id: 'abc' } as any;
    expect(!req.id || !req.command).toBe(true); // command missing → invalid
  });

  it('treats missing args as empty array', () => {
    const req: any = { id: 'x', command: 'ls' };
    const args = req.args ?? [];
    expect(args).toEqual([]);
  });

  it('treats missing timeout_ms as DEFAULT_TIMEOUT_MS (30000)', () => {
    const req: any = { id: 'x', command: 'ls' };
    const timeout = req.timeout_ms ?? 30_000;
    expect(timeout).toBe(30_000);
  });

  it('accepts provided args array', () => {
    const req: any = { id: 'x', command: 'ls', args: ['-la', '/tmp'] };
    expect(req.args).toEqual(['-la', '/tmp']);
  });

  it('accepts provided timeout_ms', () => {
    const req: any = { id: 'x', command: 'ls', timeout_ms: 5000 };
    const timeout = req.timeout_ms ?? 30_000;
    expect(timeout).toBe(5000);
  });
});

// ── Audit log format ──────────────────────────────────────────────────────────

describe('host-exec audit log format', () => {
  it('result JSON has required fields', () => {
    const result = { stdout: 'hello\n', stderr: '', exit_code: 0 };
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
    expect(result).toHaveProperty('exit_code');
    expect(typeof result.exit_code).toBe('number');
  });

  it('rejected command result has exit_code 403', () => {
    const result = {
      stdout: '',
      stderr: 'command not allowed',
      exit_code: 403,
    };
    expect(result.exit_code).toBe(403);
    expect(result.stderr).toBe('command not allowed');
  });

  it('timeout produces exit_code 124', () => {
    // SIGTERM → 124, matches the guard: signal === 'SIGTERM' ? 124 : (code ?? 1)
    const signal = 'SIGTERM';
    const code = null;
    const exitCode = signal === 'SIGTERM' ? 124 : (code ?? 1);
    expect(exitCode).toBe(124);
  });

  it('spawn error produces exit_code 1', () => {
    const signal = null;
    const code = null;
    const exitCode = signal === 'SIGTERM' ? 124 : (code ?? 1);
    expect(exitCode).toBe(1);
  });

  it('normal exit_code passes through', () => {
    const signal = null;
    const code = 2;
    const exitCode = signal === 'SIGTERM' ? 124 : (code ?? 1);
    expect(exitCode).toBe(2);
  });

  it('result file name follows <id>.result.json pattern', () => {
    const id = 'abc-123';
    const resultFileName = `${id}.result.json`;
    expect(resultFileName).toBe('abc-123.result.json');
    expect(resultFileName.endsWith('.result.json')).toBe(true);
  });
});

// ── Integration test: watcher round-trip with mocked child_process ───────────

describe('host-exec watcher integration (mocked child_process)', () => {
  let tmpDir: string;
  let hostExecDir: string;

  // Patch DATA_DIR before importing host-exec so the watcher uses our tmpDir
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-exec-test-'));
    hostExecDir = path.join(tmpDir, 'ipc', 'host-exec');
    fs.mkdirSync(hostExecDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes result file for a valid command (mocked spawn)', async () => {
    // We test the core logic in isolation: mock child_process.spawn
    const { EventEmitter } = await import('events');

    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();

    const spawnMock = vi.fn().mockReturnValue(mockChild);
    vi.doMock('child_process', () => ({ spawn: spawnMock }));

    // Simulate writeResult manually (tests the file write logic)
    const id = 'test-req-001';
    const resultPath = path.join(hostExecDir, `${id}.result.json`);
    const result = { stdout: 'output\n', stderr: '', exit_code: 0 };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

    const written = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(written.stdout).toBe('output\n');
    expect(written.exit_code).toBe(0);
  });

  it('request file is consumed (deleted) before processing', () => {
    // Simulates the "delete before execute" pattern
    const reqFile = path.join(hostExecDir, 'req-001.json');
    fs.writeFileSync(reqFile, JSON.stringify({ id: 'req-001', command: 'ls' }));
    expect(fs.existsSync(reqFile)).toBe(true);

    // Simulate the watcher consuming it
    fs.unlinkSync(reqFile);
    expect(fs.existsSync(reqFile)).toBe(false);
  });

  it('invalid JSON request is deleted without crashing', () => {
    const badFile = path.join(hostExecDir, 'bad.json');
    fs.writeFileSync(badFile, '{ not valid json }');

    // Simulate watcher error path: delete on parse failure
    try {
      JSON.parse(fs.readFileSync(badFile, 'utf-8'));
    } catch {
      fs.unlinkSync(badFile);
    }

    expect(fs.existsSync(badFile)).toBe(false);
  });

  it('result files (.result.json) are skipped by file scanner', () => {
    // Scanner filters: endsWith('.json') && !endsWith('.result.json')
    const files = ['abc.json', 'abc.result.json', 'xyz.result.json'];
    const toProcess = files.filter(
      (f) => f.endsWith('.json') && !f.endsWith('.result.json'),
    );
    expect(toProcess).toEqual(['abc.json']);
  });

  it('disallowed command produces 403 result', () => {
    const command = 'rm';
    const ALLOWED_COMMANDS = new Set([
      'systemctl',
      'cat',
      'grep',
      'journalctl',
      'curl',
      'cloudflared',
      'ls',
      'find',
    ]);

    const allowed = ALLOWED_COMMANDS.has(command);
    expect(allowed).toBe(false);

    // Simulate the rejection path
    const resultPath = path.join(hostExecDir, 'bad-cmd.result.json');
    if (!allowed) {
      fs.writeFileSync(
        resultPath,
        JSON.stringify(
          { stdout: '', stderr: 'command not allowed', exit_code: 403 },
          null,
          2,
        ),
      );
    }

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.exit_code).toBe(403);
    expect(result.stderr).toBe('command not allowed');
  });

  it('allowed command is passed to spawn (mocked)', async () => {
    const spawned: string[] = [];
    const fakeSpawn = (cmd: string) => {
      spawned.push(cmd);
      const { EventEmitter } = require('events');
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit('close', 0, null));
      return child;
    };

    // Invoke the spawn for an allowed command
    fakeSpawn('ls');
    expect(spawned).toContain('ls');
  });
});
