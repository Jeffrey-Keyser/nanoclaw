import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrashEvent, CrashHandlerDeps } from './crash-handler.js';

// Mock child_process.spawn before importing modules that use it
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs for follow-up task emitter tests
vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(true),
      readdirSync: vi.fn().mockReturnValue([]),
    },
  };
});

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';

import {
  handleCrashEvent,
  readServiceLogs,
  restartService,
  createFollowUpTaskEmitter,
} from './crash-handler.js';

/**
 * Returns a function that, when called by the mocked `spawn`, creates a
 * mock ChildProcess that emits stdout data and close on the next tick.
 * This ensures `process.nextTick` fires AFTER `runCommand` has attached
 * its listeners — not at mock-creation time.
 */
function spawnReturning(
  stdout: string,
  exitCode: number,
): () => ReturnType<typeof spawn> {
  return () => {
    const proc = new EventEmitter() as ReturnType<typeof spawn>;
    const stdoutEmitter = new EventEmitter();
    (proc as unknown as { stdout: EventEmitter }).stdout = stdoutEmitter;

    process.nextTick(() => {
      stdoutEmitter.emit('data', Buffer.from(stdout));
      proc.emit('close', exitCode);
    });

    return proc;
  };
}

function makeDeps(overrides?: Partial<CrashHandlerDeps>): CrashHandlerDeps {
  return {
    registeredGroups: () => ({
      'main-jid': {
        name: 'Main',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      },
    }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('crash-handler', () => {
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readServiceLogs', () => {
    it('reads journal logs for a service unit', async () => {
      mockSpawn.mockImplementationOnce(
        spawnReturning('Apr 22 10:00:00 host nanoclaw[1234]: fatal error', 0),
      );

      const logs = await readServiceLogs('nanoclaw.service');

      expect(mockSpawn).toHaveBeenCalledWith(
        'journalctl',
        [
          '--user',
          '-n',
          '40',
          '-u',
          'nanoclaw.service',
          '--no-pager',
          '--output=short',
        ],
        expect.objectContaining({ timeout: 15_000 }),
      );
      expect(logs).toContain('fatal error');
    });

    it('returns fallback text when journal is empty', async () => {
      mockSpawn.mockImplementationOnce(spawnReturning('', 0));

      const logs = await readServiceLogs('empty.service');

      expect(logs).toBe('(no journal output)');
    });
  });

  describe('restartService', () => {
    it('returns true when restart succeeds and service is active', async () => {
      mockSpawn.mockImplementationOnce(spawnReturning('', 0));
      mockSpawn.mockImplementationOnce(spawnReturning('active', 0));

      const result = await restartService('test.service');

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('returns false when restart command fails', async () => {
      mockSpawn.mockImplementationOnce(spawnReturning('', 1));

      const result = await restartService('broken.service');

      expect(result).toBe(false);
    });

    it('returns false when service is not active after restart', async () => {
      mockSpawn.mockImplementationOnce(spawnReturning('', 0));
      mockSpawn.mockImplementationOnce(spawnReturning('failed', 3));

      const result = await restartService('flaky.service');

      expect(result).toBe(false);
    }, 10_000);
  });

  describe('handleCrashEvent', () => {
    it('reads logs, restarts, and sends notification on successful restart', async () => {
      // readServiceLogs (journalctl)
      mockSpawn.mockImplementationOnce(spawnReturning('some log output', 0));
      // restartService: systemctl restart
      mockSpawn.mockImplementationOnce(spawnReturning('', 0));
      // restartService: systemctl is-active
      mockSpawn.mockImplementationOnce(spawnReturning('active', 0));

      const deps = makeDeps();
      const event: CrashEvent = {
        unit: 'test.service',
        timestamp: '2026-04-22T10:00:00Z',
        source: 'watchdog',
      };

      const result = await handleCrashEvent(event, deps);

      expect(result.unit).toBe('test.service');
      expect(result.logs).toContain('some log output');
      expect(result.restarted).toBe(true);
      expect(result.notified).toBe(true);
      expect(result.followUpCreated).toBe(false);
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      expect(msg).toContain('[CRASH] test.service');
      expect(msg).toContain('restarted');
    }, 10_000);

    it('creates follow-up task when restart fails', async () => {
      // readServiceLogs
      mockSpawn.mockImplementationOnce(spawnReturning('OOM killed', 0));
      // restartService: systemctl restart (fails)
      mockSpawn.mockImplementationOnce(spawnReturning('', 1));

      const emitFollowUpTask = vi.fn();
      const deps = makeDeps({ emitFollowUpTask });
      const event: CrashEvent = {
        unit: 'oom.service',
        timestamp: '2026-04-22T10:00:00Z',
        source: 'onfailure',
      };

      const result = await handleCrashEvent(event, deps);

      expect(result.restarted).toBe(false);
      expect(result.notified).toBe(true);
      expect(result.followUpCreated).toBe(true);
      expect(emitFollowUpTask).toHaveBeenCalledWith(
        'oom.service',
        expect.any(String),
      );
      const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      expect(msg).toContain('RESTART FAILED');
    });

    it('handles missing main group gracefully', async () => {
      // readServiceLogs
      mockSpawn.mockImplementationOnce(spawnReturning('logs', 0));
      // restartService: restart
      mockSpawn.mockImplementationOnce(spawnReturning('', 0));
      // restartService: is-active
      mockSpawn.mockImplementationOnce(spawnReturning('active', 0));

      const deps = makeDeps({
        registeredGroups: () => ({}),
      });
      const event: CrashEvent = {
        unit: 'test.service',
        timestamp: '2026-04-22T10:00:00Z',
        source: 'watchdog',
      };

      const result = await handleCrashEvent(event, deps);

      expect(result.notified).toBe(false);
      expect(deps.sendMessage).not.toHaveBeenCalled();
    }, 10_000);

    it('uses notification batcher when available', async () => {
      // readServiceLogs
      mockSpawn.mockImplementationOnce(spawnReturning('crash data', 0));
      // restartService: restart
      mockSpawn.mockImplementationOnce(spawnReturning('', 0));
      // restartService: is-active
      mockSpawn.mockImplementationOnce(spawnReturning('active', 0));

      const batcherSend = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        notificationBatcher: {
          send: batcherSend,
        } as unknown as CrashHandlerDeps['notificationBatcher'],
      });
      const event: CrashEvent = {
        unit: 'test.service',
        timestamp: '2026-04-22T10:00:00Z',
        source: 'watchdog',
      };

      const result = await handleCrashEvent(event, deps);

      expect(result.notified).toBe(true);
      expect(batcherSend).toHaveBeenCalledTimes(1);
      expect(batcherSend).toHaveBeenCalledWith(
        'main-jid',
        expect.stringContaining('[CRASH]'),
        'warning',
      );
      expect(deps.sendMessage).not.toHaveBeenCalled();
    }, 10_000);

    it('uses error severity when restart fails', async () => {
      // readServiceLogs
      mockSpawn.mockImplementationOnce(spawnReturning('crash', 0));
      // restartService: restart fails
      mockSpawn.mockImplementationOnce(spawnReturning('', 1));

      const batcherSend = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        notificationBatcher: {
          send: batcherSend,
        } as unknown as CrashHandlerDeps['notificationBatcher'],
      });
      const event: CrashEvent = {
        unit: 'dead.service',
        timestamp: '2026-04-22T10:00:00Z',
        source: 'onfailure',
      };

      await handleCrashEvent(event, deps);

      expect(batcherSend).toHaveBeenCalledWith(
        'main-jid',
        expect.stringContaining('RESTART FAILED'),
        'error',
      );
    });
  });

  describe('createFollowUpTaskEmitter', () => {
    it('writes a JSON task file to the IPC tasks directory', () => {
      const emitter = createFollowUpTaskEmitter('main');

      emitter('crashed.service', 'some crash logs');

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const [filepath, content] = (fs.writeFileSync as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(filepath).toContain('crash-followup-crashed_service');
      const parsed = JSON.parse(content as string);
      expect(parsed.type).toBe('schedule_task');
      expect(parsed.prompt).toContain('crashed.service');
      expect(parsed.schedule_type).toBe('once');
    });
  });
});
