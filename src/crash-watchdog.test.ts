import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process.spawn before importing modules that use it
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock the crash handler to isolate watchdog behavior
vi.mock('./crash-handler.js', () => ({
  handleCrashEvent: vi.fn().mockResolvedValue({
    unit: 'test.service',
    logs: 'mock logs',
    restarted: true,
    notified: true,
    followUpCreated: false,
  }),
}));

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

import { handleCrashEvent } from './crash-handler.js';
import { DATA_DIR } from './config.js';
import {
  parseFailedUnits,
  pollForCrashes,
  processCrashEventFiles,
  startCrashWatchdog,
  stopCrashWatchdog,
  _resetHandledCrashesForTesting,
} from './crash-watchdog.js';
import type { CrashWatchdogDeps } from './crash-watchdog.js';

function createMockProcess(
  stdout: string,
  exitCode: number,
): ReturnType<typeof spawn> {
  const proc = new EventEmitter() as ReturnType<typeof spawn>;
  const stdoutEmitter = new EventEmitter();
  (proc as unknown as { stdout: EventEmitter }).stdout = stdoutEmitter;

  // Use process.nextTick so it fires reliably with both real and fake timers
  process.nextTick(() => {
    stdoutEmitter.emit('data', Buffer.from(stdout));
    proc.emit('close', exitCode);
  });

  return proc;
}

function makeDeps(overrides?: Partial<CrashWatchdogDeps>): CrashWatchdogDeps {
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

describe('crash-watchdog', () => {
  const mockSpawn = vi.mocked(spawn);
  const mockHandleCrashEvent = vi.mocked(handleCrashEvent);

  beforeEach(() => {
    vi.clearAllMocks();
    _resetHandledCrashesForTesting();
  });

  afterEach(() => {
    stopCrashWatchdog();
    vi.restoreAllMocks();
  });

  describe('parseFailedUnits', () => {
    it('parses systemctl --state=failed output', () => {
      const output = [
        '  myapp.service loaded failed failed My App',
        '  other.service loaded failed failed Other',
        '',
      ].join('\n');

      const units = parseFailedUnits(output);

      expect(units).toEqual(['myapp.service', 'other.service']);
    });

    it('returns empty array for no failures', () => {
      expect(parseFailedUnits('')).toEqual([]);
      expect(parseFailedUnits('\n\n')).toEqual([]);
    });

    it('filters out non-service units', () => {
      const output = 'myapp.socket loaded failed failed\n';
      expect(parseFailedUnits(output)).toEqual([]);
    });
  });

  describe('pollForCrashes', () => {
    // These tests use real timers since pollForCrashes doesn't use setTimeout

    it('detects new failures and triggers crash handler', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      mockSpawn.mockReturnValueOnce(
        createMockProcess('  test.service loaded failed failed Test\n', 0),
      );

      const deps = makeDeps();
      await pollForCrashes(deps);

      expect(mockHandleCrashEvent).toHaveBeenCalledTimes(1);
      expect(mockHandleCrashEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          unit: 'test.service',
          source: 'watchdog',
        }),
        deps,
      );
    });

    it('does not duplicate handling for the same failure', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      // First poll
      mockSpawn.mockReturnValueOnce(
        createMockProcess('  test.service loaded failed failed\n', 0),
      );
      mockHandleCrashEvent.mockResolvedValueOnce({
        unit: 'test.service',
        logs: '',
        restarted: false,
        notified: true,
        followUpCreated: true,
      });

      const deps = makeDeps();
      await pollForCrashes(deps);

      // Second poll — same failure still present
      mockSpawn.mockReturnValueOnce(
        createMockProcess('  test.service loaded failed failed\n', 0),
      );
      await pollForCrashes(deps);

      // Should only handle once
      expect(mockHandleCrashEvent).toHaveBeenCalledTimes(1);
    });

    it('clears handled state when service recovers', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      // First poll — service failed
      mockSpawn.mockReturnValueOnce(
        createMockProcess('  test.service loaded failed failed\n', 0),
      );
      mockHandleCrashEvent.mockResolvedValueOnce({
        unit: 'test.service',
        logs: '',
        restarted: false,
        notified: true,
        followUpCreated: false,
      });

      const deps = makeDeps();
      await pollForCrashes(deps);
      expect(mockHandleCrashEvent).toHaveBeenCalledTimes(1);

      // Second poll — service recovered (no failures)
      mockSpawn.mockReturnValueOnce(createMockProcess('', 0));
      await pollForCrashes(deps);

      // Third poll — service fails again
      mockSpawn.mockReturnValueOnce(
        createMockProcess('  test.service loaded failed failed\n', 0),
      );
      await pollForCrashes(deps);

      // Should handle the second crash
      expect(mockHandleCrashEvent).toHaveBeenCalledTimes(2);
    });

    it('removes from handled when restart succeeds', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      mockSpawn.mockReturnValueOnce(
        createMockProcess('  test.service loaded failed failed\n', 0),
      );
      mockHandleCrashEvent.mockResolvedValueOnce({
        unit: 'test.service',
        logs: '',
        restarted: true,
        notified: true,
        followUpCreated: false,
      });

      const deps = makeDeps();
      await pollForCrashes(deps);

      // Next poll — same service fails again (should be handled since restart succeeded)
      mockSpawn.mockReturnValueOnce(
        createMockProcess('  test.service loaded failed failed\n', 0),
      );
      mockHandleCrashEvent.mockResolvedValueOnce({
        unit: 'test.service',
        logs: '',
        restarted: true,
        notified: true,
        followUpCreated: false,
      });
      await pollForCrashes(deps);

      expect(mockHandleCrashEvent).toHaveBeenCalledTimes(2);
    });

    it('handles multiple simultaneous failures', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      mockSpawn.mockReturnValueOnce(
        createMockProcess(
          '  app1.service loaded failed failed\n  app2.service loaded failed failed\n',
          0,
        ),
      );

      const deps = makeDeps();
      await pollForCrashes(deps);

      expect(mockHandleCrashEvent).toHaveBeenCalledTimes(2);
      expect(mockHandleCrashEvent).toHaveBeenCalledWith(
        expect.objectContaining({ unit: 'app1.service' }),
        deps,
      );
      expect(mockHandleCrashEvent).toHaveBeenCalledWith(
        expect.objectContaining({ unit: 'app2.service' }),
        deps,
      );
    });
  });

  describe('processCrashEventFiles', () => {
    it('processes OnFailure event files', async () => {
      const crashEventsDir = path.join(DATA_DIR, 'crash-events');
      const testFile = 'crash-test.service-1234.json';
      const eventData = {
        unit: 'test.service',
        timestamp: '2026-04-22T10:00:00Z',
        source: 'onfailure',
      };

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readdirSync').mockReturnValue([
        testFile,
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(eventData));
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);

      const deps = makeDeps();
      await processCrashEventFiles(deps);

      expect(mockHandleCrashEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          unit: 'test.service',
          source: 'onfailure',
        }),
        deps,
      );
      expect(unlinkSpy).toHaveBeenCalledWith(
        path.join(crashEventsDir, testFile),
      );
    });

    it('skips when crash-events directory does not exist', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const deps = makeDeps();
      await processCrashEventFiles(deps);

      expect(mockHandleCrashEvent).not.toHaveBeenCalled();
    });

    it('renames malformed files to .failed', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readdirSync').mockReturnValue([
        'bad.json',
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('not valid json {{{');
      const renameSpy = vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);

      const deps = makeDeps();
      await processCrashEventFiles(deps);

      expect(renameSpy).toHaveBeenCalledWith(
        expect.stringContaining('bad.json'),
        expect.stringContaining('bad.json.failed'),
      );
    });
  });

  describe('startCrashWatchdog / stopCrashWatchdog', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts polling and stops cleanly', async () => {
      mockSpawn.mockReturnValue(createMockProcess('', 0));
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const deps = makeDeps({ intervalMs: 1000 });
      startCrashWatchdog(deps);

      // Advance past first interval
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockSpawn).toHaveBeenCalled();

      stopCrashWatchdog();

      // Advance again — no more calls
      const callCount = mockSpawn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockSpawn.mock.calls.length).toBe(callCount);
    });

    it('defers first poll by one interval', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const deps = makeDeps({ intervalMs: 5000 });
      startCrashWatchdog(deps);

      // Should not poll immediately
      expect(mockSpawn).not.toHaveBeenCalled();

      // Should poll after interval
      mockSpawn.mockReturnValue(createMockProcess('', 0));
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockSpawn).toHaveBeenCalled();
    });
  });
});
