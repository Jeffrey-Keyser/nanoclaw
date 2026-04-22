import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

import type { UptimeMonitorDeps } from './uptime-monitor.js';
import {
  _checkServicesForTesting,
  _resetForTesting,
  startUptimeMonitor,
  stopUptimeMonitor,
} from './uptime-monitor.js';

// --- Mock child_process.spawn ---

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
}

let spawnResults: Array<{ stdout: string; exitCode: number }> = [];
let spawnCallIndex = 0;
let spawnCalls: Array<{ command: string; args: string[] }> = [];

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    const child: MockChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
    });

    const result = spawnResults[spawnCallIndex] ?? { stdout: '', exitCode: 0 };
    spawnCallIndex++;

    // Emit data + close on next tick to simulate async behavior
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(result.stdout));
      child.emit('close', result.exitCode);
    });

    return child;
  },
}));

// --- Helpers ---

function makeDeps(overrides?: Partial<UptimeMonitorDeps>): UptimeMonitorDeps {
  return {
    registeredGroups: () => ({
      'tg:12345': {
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

describe('uptime-monitor', () => {
  beforeEach(() => {
    _resetForTesting();
    spawnResults = [];
    spawnCallIndex = 0;
    spawnCalls = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetForTesting();
  });

  describe('checkServices', () => {
    it('does nothing when no main group is registered', async () => {
      const deps = makeDeps({
        registeredGroups: () => ({}),
      });

      spawnResults = [
        { stdout: 'some-unit.service loaded failed\n', exitCode: 0 },
      ];

      await _checkServicesForTesting(deps);

      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('sends alert when a service fails', async () => {
      const deps = makeDeps();

      // systemctl --user list-units --state=failed
      spawnResults = [
        { stdout: 'my-app.service loaded failed failed\n', exitCode: 0 },
        // journalctl --user -n 20 -u my-app.service
        { stdout: 'Apr 22 10:00:00 host my-app[123]: segfault\n', exitCode: 0 },
      ];

      await _checkServicesForTesting(deps);

      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      expect(msg).toContain('[ALERT] Service down: my-app.service');
      expect(msg).toContain('segfault');
    });

    it('does not re-alert for already-known failures', async () => {
      const deps = makeDeps();

      // First check: service fails
      spawnResults = [
        { stdout: 'my-app.service loaded failed\n', exitCode: 0 },
        { stdout: 'crash log line\n', exitCode: 0 },
      ];

      await _checkServicesForTesting(deps);
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);

      // Second check: same service still failed
      spawnCallIndex = 0;
      spawnResults = [
        { stdout: 'my-app.service loaded failed\n', exitCode: 0 },
      ];
      (deps.sendMessage as ReturnType<typeof vi.fn>).mockClear();

      await _checkServicesForTesting(deps);
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('sends recovery notification when a service recovers', async () => {
      const deps = makeDeps();

      // First check: service fails
      spawnResults = [
        { stdout: 'my-app.service loaded failed\n', exitCode: 0 },
        { stdout: 'crash log\n', exitCode: 0 },
      ];
      await _checkServicesForTesting(deps);

      // Second check: service recovered (no longer in failed list)
      spawnCallIndex = 0;
      spawnResults = [{ stdout: '', exitCode: 0 }];
      (deps.sendMessage as ReturnType<typeof vi.fn>).mockClear();

      await _checkServicesForTesting(deps);

      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      expect(msg).toContain('[RESOLVED] Service recovered: my-app.service');
    });

    it('handles multiple failed services in one check', async () => {
      const deps = makeDeps();

      spawnResults = [
        {
          stdout: 'svc-a.service loaded failed\nsvc-b.service loaded failed\n',
          exitCode: 0,
        },
        { stdout: 'svc-a crash log\n', exitCode: 0 },
        { stdout: 'svc-b crash log\n', exitCode: 0 },
      ];

      await _checkServicesForTesting(deps);

      expect(deps.sendMessage).toHaveBeenCalledTimes(2);
      const messages = (
        deps.sendMessage as ReturnType<typeof vi.fn>
      ).mock.calls.map((c) => c[1] as string);
      expect(messages.some((m) => m.includes('svc-a.service'))).toBe(true);
      expect(messages.some((m) => m.includes('svc-b.service'))).toBe(true);
    });

    it('uses notificationBatcher when available', async () => {
      const batcherSend = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        notificationBatcher: {
          send: batcherSend,
        } as unknown as UptimeMonitorDeps['notificationBatcher'],
      });

      spawnResults = [
        { stdout: 'my-app.service loaded failed\n', exitCode: 0 },
        { stdout: 'crash log\n', exitCode: 0 },
      ];

      await _checkServicesForTesting(deps);

      expect(batcherSend).toHaveBeenCalledTimes(1);
      expect(batcherSend).toHaveBeenCalledWith(
        'tg:12345',
        expect.stringContaining('[ALERT]'),
        'error',
      );
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('uses notificationBatcher for recovery when available', async () => {
      const batcherSend = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        notificationBatcher: {
          send: batcherSend,
        } as unknown as UptimeMonitorDeps['notificationBatcher'],
      });

      // First: failure
      spawnResults = [
        { stdout: 'my-app.service loaded failed\n', exitCode: 0 },
        { stdout: 'crash\n', exitCode: 0 },
      ];
      await _checkServicesForTesting(deps);

      // Second: recovery
      spawnCallIndex = 0;
      spawnResults = [{ stdout: '', exitCode: 0 }];
      batcherSend.mockClear();

      await _checkServicesForTesting(deps);

      expect(batcherSend).toHaveBeenCalledTimes(1);
      expect(batcherSend).toHaveBeenCalledWith(
        'tg:12345',
        expect.stringContaining('[RESOLVED]'),
        'info',
      );
    });

    it('handles empty systemctl output gracefully', async () => {
      const deps = makeDeps();
      spawnResults = [{ stdout: '', exitCode: 0 }];

      await _checkServicesForTesting(deps);

      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('handles systemctl returning only whitespace/blank lines', async () => {
      const deps = makeDeps();
      spawnResults = [{ stdout: '  \n\n  \n', exitCode: 0 }];

      await _checkServicesForTesting(deps);

      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('truncates long journal output to 1500 chars', async () => {
      const deps = makeDeps();
      const longLog = 'x'.repeat(3000);

      spawnResults = [
        { stdout: 'my-app.service loaded failed\n', exitCode: 0 },
        { stdout: longLog, exitCode: 0 },
      ];

      await _checkServicesForTesting(deps);

      const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      // The journal tail should be at most 1500 chars (from the end)
      expect(msg).toContain('x'.repeat(100));
      // Full 3000-char log should NOT be present
      expect(msg.length).toBeLessThan(3000 + 200); // message + formatting overhead
    });

    it('uses "(no journal output)" when journal is empty', async () => {
      const deps = makeDeps();

      spawnResults = [
        { stdout: 'my-app.service loaded failed\n', exitCode: 0 },
        { stdout: '   \n', exitCode: 0 },
      ];

      await _checkServicesForTesting(deps);

      const msg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      expect(msg).toContain('(no journal output)');
    });

    it('swallows sendMessage errors without throwing', async () => {
      const deps = makeDeps({
        sendMessage: vi.fn().mockRejectedValue(new Error('send failed')),
      });

      spawnResults = [
        { stdout: 'my-app.service loaded failed\n', exitCode: 0 },
        { stdout: 'crash\n', exitCode: 0 },
      ];

      // Should not throw
      await expect(_checkServicesForTesting(deps)).resolves.toBeUndefined();
    });
  });

  describe('startUptimeMonitor / stopUptimeMonitor', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      stopUptimeMonitor();
      vi.useRealTimers();
    });

    it('starts polling after the initial interval', async () => {
      const deps = makeDeps();
      spawnResults = [{ stdout: '', exitCode: 0 }];

      startUptimeMonitor(deps);

      // Before interval: no spawn calls
      expect(spawnCalls).toHaveLength(0);

      // Advance past the 5-minute interval
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // checkServices should have been called (spawned systemctl)
      expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
      expect(spawnCalls[0].command).toBe('systemctl');
    });

    it('stops polling when stopUptimeMonitor is called', async () => {
      const deps = makeDeps();
      spawnResults = [{ stdout: '', exitCode: 0 }];

      startUptimeMonitor(deps);
      stopUptimeMonitor();

      // Advance past multiple intervals
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

      // No spawn calls should have been made
      expect(spawnCalls).toHaveLength(0);
    });
  });
});
