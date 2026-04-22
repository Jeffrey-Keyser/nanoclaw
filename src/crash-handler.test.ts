import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process.spawn before importing the module
vi.mock('child_process', () => {
  const EventEmitter = require('events');
  return {
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdio = ['ignore', child.stdout, child.stderr];
      setTimeout(() => child.emit('close', 0), 0);
      return child;
    }),
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    })),
  },
  createCorrelationLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  })),
  generateCorrelationId: vi.fn(() => 'test-corr-id'),
}));

import { spawn } from 'child_process';
import EventEmitter from 'events';

import {
  extractErrors,
  formatCrashNotification,
  handleServiceCrash,
  readServiceLogs,
  restartService,
  runCommand,
  _resetForTesting,
  type CrashEvent,
  type CrashHandlerDeps,
} from './crash-handler.js';

function mockSpawnResult(
  stdout: string,
  stderr = '',
  exitCode = 0,
): ReturnType<typeof vi.fn> {
  return vi.fn(() => {
    const child = new EventEmitter();
    (child as any).stdout = new EventEmitter();
    (child as any).stderr = new EventEmitter();
    setTimeout(() => {
      if (stdout) (child as any).stdout.emit('data', Buffer.from(stdout));
      if (stderr) (child as any).stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    }, 0);
    return child;
  });
}

function makeMockDeps(overrides?: Partial<CrashHandlerDeps>): CrashHandlerDeps {
  return {
    registeredGroups: () => ({
      'tg:123': {
        name: 'Main',
        folder: 'main',
        trigger: '',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      },
    }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe('crash-handler', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetForTesting();
    fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockFetchResponse({ success: true, data: { id: 'task-123' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetForTesting();
  });

  describe('runCommand', () => {
    it('resolves with stdout and exit code', async () => {
      vi.mocked(spawn).mockImplementation(
        mockSpawnResult('hello world', '', 0) as any,
      );
      const result = await runCommand('echo', ['hello']);
      expect(result.stdout).toBe('hello world');
      expect(result.exitCode).toBe(0);
    });

    it('resolves with exit code 1 on spawn error', async () => {
      vi.mocked(spawn).mockImplementation(() => {
        const child = new EventEmitter();
        (child as any).stdout = new EventEmitter();
        (child as any).stderr = new EventEmitter();
        setTimeout(() => child.emit('error', new Error('ENOENT')), 0);
        return child as any;
      });
      const result = await runCommand('nonexistent', []);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
    });

    it('captures stderr output', async () => {
      vi.mocked(spawn).mockImplementation(
        mockSpawnResult('', 'permission denied', 1) as any,
      );
      const result = await runCommand('test', []);
      expect(result.stderr).toBe('permission denied');
      expect(result.exitCode).toBe(1);
    });
  });

  describe('readServiceLogs', () => {
    it('calls journalctl with --user flag and correct arguments', async () => {
      const spawnMock = mockSpawnResult('some logs\n');
      vi.mocked(spawn).mockImplementation(spawnMock as any);

      await readServiceLogs('nanoclaw.service');

      expect(spawnMock).toHaveBeenCalledWith(
        'journalctl',
        [
          '--user',
          '-u',
          'nanoclaw.service',
          '--since',
          '5 minutes ago',
          '--no-pager',
          '--output=short',
        ],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
    });

    it('returns trimmed stdout', async () => {
      vi.mocked(spawn).mockImplementation(
        mockSpawnResult('  log line\n', '', 0) as any,
      );
      const result = await readServiceLogs('test.service');
      expect(result).toBe('log line');
    });

    it('falls back to stderr when stdout is empty', async () => {
      vi.mocked(spawn).mockImplementation(
        mockSpawnResult('', 'journal error output', 0) as any,
      );
      const result = await readServiceLogs('test.service');
      expect(result).toBe('journal error output');
    });
  });

  describe('restartService', () => {
    it('calls systemctl --user restart with service name', async () => {
      const spawnMock = mockSpawnResult('', '', 0);
      vi.mocked(spawn).mockImplementation(spawnMock as any);

      const result = await restartService('nanoclaw.service');

      expect(spawnMock).toHaveBeenCalledWith(
        'systemctl',
        ['--user', 'restart', 'nanoclaw.service'],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(result.success).toBe(true);
    });

    it('returns failure when exit code is non-zero', async () => {
      vi.mocked(spawn).mockImplementation(
        mockSpawnResult('', 'Failed to restart', 1) as any,
      );
      const result = await restartService('broken.service');
      expect(result.success).toBe(false);
      expect(result.output).toContain('Failed to restart');
    });
  });

  describe('extractErrors', () => {
    it('returns fallback for empty logs', () => {
      expect(extractErrors('')).toBe('(no log output)');
    });

    it('extracts error lines from journal output', () => {
      const logs = [
        'Apr 20 10:00:01 host service[1234]: Starting up',
        'Apr 20 10:00:02 host service[1234]: Error: Connection refused',
        'Apr 20 10:00:02 host service[1234]:   at connect (/app/src/db.ts:42)',
        'Apr 20 10:00:03 host service[1234]: Shutting down',
      ].join('\n');

      const result = extractErrors(logs);
      expect(result).toContain('Error: Connection refused');
      expect(result).toContain('at connect');
    });

    it('extracts fatal and exception lines', () => {
      const logs = [
        'Apr 20 10:00:01 host svc[1]: Normal log',
        'Apr 20 10:00:02 host svc[1]: FATAL: out of memory',
        'Apr 20 10:00:03 host svc[1]: exception in thread main',
      ].join('\n');

      const result = extractErrors(logs);
      expect(result).toContain('FATAL: out of memory');
      expect(result).toContain('exception in thread main');
    });

    it('captures Node.js TypeError and stack trace', () => {
      const logs = [
        'Apr 20 10:00:01 host svc[1]: TypeError: Cannot read properties of undefined',
        'Apr 20 10:00:01 host svc[1]:     at Object.<anonymous> (/app/src/index.ts:10:5)',
        'Apr 20 10:00:01 host svc[1]:     at Module._compile (node:internal/modules/cjs/loader:1234:14)',
      ].join('\n');

      const result = extractErrors(logs);
      expect(result).toContain('TypeError');
      expect(result).toContain('at Object.<anonymous>');
      expect(result).toContain('at Module._compile');
    });

    it('captures UnhandledPromiseRejection', () => {
      const logs = [
        'Apr 20 10:00:01 host svc[1]: UnhandledPromiseRejection: Error: fetch failed',
      ].join('\n');

      const result = extractErrors(logs);
      expect(result).toContain('UnhandledPromiseRejection');
    });

    it('falls back to last 10 lines when no errors found', () => {
      const logs = Array.from(
        { length: 15 },
        (_, i) =>
          `Apr 20 10:00:${String(i).padStart(2, '0')} host svc[1]: Line ${i}`,
      ).join('\n');

      const result = extractErrors(logs);
      expect(result).toContain('Line 14');
      expect(result).toContain('Line 5');
      expect(result).not.toContain('Line 4');
    });

    it('truncates output beyond 1500 chars', () => {
      const logs = Array.from(
        { length: 50 },
        (_, i) =>
          `Apr 20 10:00:00 host svc[1]: Error: ${'x'.repeat(100)} line ${i}`,
      ).join('\n');

      const result = extractErrors(logs);
      expect(result.length).toBeLessThanOrEqual(1500);
      expect(result).toMatch(/\.\.\.$/);
    });

    it('detects OOM and SIGABRT patterns', () => {
      const logs = [
        'host svc[1]: killed by OOM killer',
        'host svc[1]: received SIGABRT',
      ].join('\n');

      const result = extractErrors(logs);
      expect(result).toContain('OOM');
      expect(result).toContain('SIGABRT');
    });

    it('detects segfault and SIGSEGV', () => {
      const logs = ['host svc[1]: segfault at 0x0000'].join('\n');
      const result = extractErrors(logs);
      expect(result).toContain('segfault');
    });
  });

  describe('formatCrashNotification', () => {
    it('formats successful restart notification', () => {
      const event: CrashEvent = {
        service: 'my-service.service',
        errorSummary: 'Error: Connection refused',
        logTail: 'some logs',
        restartAttempted: true,
        restartSuccess: true,
        timestamp: '2026-04-20T10:00:00Z',
      };

      const msg = formatCrashNotification(event);
      expect(msg).toContain('RECOVERED');
      expect(msg).toContain('my-service.service');
      expect(msg).toContain('Successful');
      expect(msg).toContain('Error: Connection refused');
      expect(msg).not.toContain('Follow-up task');
    });

    it('formats failed restart notification with follow-up task ID', () => {
      const event: CrashEvent = {
        service: 'broken.service',
        errorSummary: 'FATAL: segfault',
        logTail: 'crash logs',
        restartAttempted: true,
        restartSuccess: false,
        timestamp: '2026-04-20T10:00:00Z',
        followUpTaskId: 'task-abc-123',
      };

      const msg = formatCrashNotification(event);
      expect(msg).toContain('RESTART FAILED');
      expect(msg).toContain('broken.service');
      expect(msg).toContain('Failed');
      expect(msg).toContain('task-abc-123');
      expect(msg).toContain('Follow-up task created in Agency HQ');
    });

    it('shows task creation failure when no task ID', () => {
      const event: CrashEvent = {
        service: 'broken.service',
        errorSummary: 'FATAL: segfault',
        logTail: 'crash logs',
        restartAttempted: true,
        restartSuccess: false,
        timestamp: '2026-04-20T10:00:00Z',
      };

      const msg = formatCrashNotification(event);
      expect(msg).toContain('RESTART FAILED');
      expect(msg).toContain('Follow-up task creation failed');
    });

    it('truncates long error summaries', () => {
      const event: CrashEvent = {
        service: 'svc.service',
        errorSummary: 'x'.repeat(1000),
        logTail: '',
        restartAttempted: true,
        restartSuccess: true,
        timestamp: '2026-04-20T10:00:00Z',
      };

      const msg = formatCrashNotification(event);
      const codeBlock = msg.split('```')[1];
      expect(codeBlock.trim().length).toBeLessThanOrEqual(800);
    });

    it('includes all required fields: service name, error summary, restart status', () => {
      const event: CrashEvent = {
        service: 'nanoclaw.service',
        errorSummary: 'Error: ECONNREFUSED',
        logTail: '',
        restartAttempted: true,
        restartSuccess: true,
        timestamp: '2026-04-20T10:00:00Z',
      };

      const msg = formatCrashNotification(event);
      // Service name
      expect(msg).toContain('nanoclaw.service');
      // Error summary in code block
      expect(msg).toContain('Error: ECONNREFUSED');
      // Restart status
      expect(msg).toContain('Restart:');
      expect(msg).toContain('Successful');
    });
  });

  describe('handleServiceCrash', () => {
    it('runs full workflow and sends notification on successful restart', async () => {
      const spawnMock = vi.mocked(spawn);
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        callCount++;
        const child = new EventEmitter();
        (child as any).stdout = new EventEmitter();
        (child as any).stderr = new EventEmitter();
        setTimeout(() => {
          if (callCount === 1) {
            // journalctl call — return error logs
            (child as any).stdout.emit(
              'data',
              Buffer.from('Apr 20 10:00:02 host svc[1]: Error: ECONNREFUSED\n'),
            );
          }
          // restart call (callCount === 2) — succeed
          child.emit('close', 0);
        }, 0);
        return child as any;
      });

      const deps = makeMockDeps();
      const event = await handleServiceCrash('test.service', deps);

      expect(event.service).toBe('test.service');
      expect(event.restartAttempted).toBe(true);
      expect(event.restartSuccess).toBe(true);
      expect(event.errorSummary).toContain('ECONNREFUSED');
      expect(event.followUpTaskId).toBeUndefined();

      // Telegram notification was sent
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1];
      expect(sentMsg).toContain('RECOVERED');

      // No follow-up task created (restart succeeded)
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('creates follow-up task and includes task ID in notification when restart fails', async () => {
      const spawnMock = vi.mocked(spawn);
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        callCount++;
        const child = new EventEmitter();
        (child as any).stdout = new EventEmitter();
        (child as any).stderr = new EventEmitter();
        setTimeout(() => {
          if (callCount === 1) {
            (child as any).stdout.emit(
              'data',
              Buffer.from('Apr 20 10:00:02 host svc[1]: FATAL: segfault\n'),
            );
          }
          // restart call fails
          child.emit('close', callCount === 1 ? 0 : 1);
        }, 0);
        return child as any;
      });

      const deps = makeMockDeps();
      const event = await handleServiceCrash('broken.service', deps);

      expect(event.restartSuccess).toBe(false);
      expect(event.followUpTaskId).toBe('task-123');

      // Telegram notification includes task ID
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1];
      expect(sentMsg).toContain('RESTART FAILED');
      expect(sentMsg).toContain('task-123');

      // Follow-up task created in Agency HQ
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/api/v1/tasks');
      const body = JSON.parse(opts.body);
      expect(body.title).toContain('broken.service');
      expect(body.status).toBe('ready');
    });

    it('handles Agency HQ task creation failure gracefully', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse({ error: 'Internal error' }, false, 500),
      );

      const spawnMock = vi.mocked(spawn);
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        callCount++;
        const child = new EventEmitter();
        (child as any).stdout = new EventEmitter();
        (child as any).stderr = new EventEmitter();
        setTimeout(() => {
          child.emit('close', callCount === 1 ? 0 : 1);
        }, 0);
        return child as any;
      });

      const deps = makeMockDeps();
      const event = await handleServiceCrash('broken.service', deps);

      expect(event.restartSuccess).toBe(false);
      expect(event.followUpTaskId).toBeUndefined();

      // Notification should indicate task creation failed
      const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1];
      expect(sentMsg).toContain('Follow-up task creation failed');
    });

    it('handles Agency HQ network error gracefully', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const spawnMock = vi.mocked(spawn);
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        callCount++;
        const child = new EventEmitter();
        (child as any).stdout = new EventEmitter();
        (child as any).stderr = new EventEmitter();
        setTimeout(() => {
          child.emit('close', callCount === 1 ? 0 : 1);
        }, 0);
        return child as any;
      });

      const deps = makeMockDeps();
      const event = await handleServiceCrash('broken.service', deps);

      expect(event.restartSuccess).toBe(false);
      expect(event.followUpTaskId).toBeUndefined();
      // Should not throw — error is caught
    });

    it('skips notification when no main group registered', async () => {
      const spawnMock = vi.mocked(spawn);
      spawnMock.mockImplementation(() => {
        const child = new EventEmitter();
        (child as any).stdout = new EventEmitter();
        (child as any).stderr = new EventEmitter();
        setTimeout(() => child.emit('close', 0), 0);
        return child as any;
      });

      const deps = makeMockDeps({
        registeredGroups: () => ({}),
      });

      const event = await handleServiceCrash('svc.service', deps);
      expect(event.restartSuccess).toBe(true);
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('uses notification batcher when available', async () => {
      const spawnMock = vi.mocked(spawn);
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        callCount++;
        const child = new EventEmitter();
        (child as any).stdout = new EventEmitter();
        (child as any).stderr = new EventEmitter();
        setTimeout(() => {
          if (callCount === 1) {
            (child as any).stdout.emit(
              'data',
              Buffer.from('Error: something broke\n'),
            );
          }
          child.emit('close', 0);
        }, 0);
        return child as any;
      });

      const batcherSend = vi.fn().mockResolvedValue(undefined);
      const deps = makeMockDeps({
        notificationBatcher: {
          send: batcherSend,
        } as any,
      });

      await handleServiceCrash('svc.service', deps);

      expect(batcherSend).toHaveBeenCalledTimes(1);
      expect(batcherSend).toHaveBeenCalledWith(
        'tg:123',
        expect.stringContaining('RECOVERED'),
        'warning',
      );
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('uses error severity for failed restart notifications', async () => {
      const spawnMock = vi.mocked(spawn);
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        callCount++;
        const child = new EventEmitter();
        (child as any).stdout = new EventEmitter();
        (child as any).stderr = new EventEmitter();
        setTimeout(() => {
          child.emit('close', callCount === 1 ? 0 : 1);
        }, 0);
        return child as any;
      });

      const batcherSend = vi.fn().mockResolvedValue(undefined);
      const deps = makeMockDeps({
        notificationBatcher: {
          send: batcherSend,
        } as any,
      });

      await handleServiceCrash('broken.service', deps);

      expect(batcherSend).toHaveBeenCalledWith(
        'tg:123',
        expect.stringContaining('RESTART FAILED'),
        'error',
      );
    });

    it('handles sendMessage error gracefully', async () => {
      const spawnMock = vi.mocked(spawn);
      spawnMock.mockImplementation(() => {
        const child = new EventEmitter();
        (child as any).stdout = new EventEmitter();
        (child as any).stderr = new EventEmitter();
        setTimeout(() => child.emit('close', 0), 0);
        return child as any;
      });

      const deps = makeMockDeps({
        sendMessage: vi.fn().mockRejectedValue(new Error('send failed')),
      });

      // Should not throw
      const event = await handleServiceCrash('svc.service', deps);
      expect(event.restartSuccess).toBe(true);
    });
  });
});
