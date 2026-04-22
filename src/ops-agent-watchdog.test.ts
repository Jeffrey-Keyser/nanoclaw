import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process before imports
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock runtime-adapter
vi.mock('./runtime-adapter.js', () => ({
  getAgentRuntime: vi.fn(() => ({
    listSessionNames: vi.fn(() => []),
  })),
}));

// Mock dispatch-slot-backends
vi.mock('./dispatch-slot-backends.js', () => ({
  getDispatchSlotBackend: vi.fn(() => ({
    name: 'sqlite',
    listActiveSlots: vi.fn(async () => []),
  })),
}));

import { execSync } from 'child_process';
import { getAgentRuntime } from './runtime-adapter.js';
import { getDispatchSlotBackend } from './dispatch-slot-backends.js';
import {
  detectStuckSlots,
  restartNanoClaw,
  runWatchdogTick,
  startOpsAgentWatchdog,
  stopOpsAgentWatchdog,
  _resetWatchdogState,
} from './ops-agent-watchdog.js';
import type { SchedulerDependencies } from './task-scheduler.js';
import type { GroupQueue } from './group-queue.js';

function makeMockDeps(
  overrides?: Partial<SchedulerDependencies>,
): SchedulerDependencies {
  return {
    registeredGroups: () => ({
      'ceo@g.us': {
        name: 'CEO',
        folder: 'ceo',
        trigger: '',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      },
    }),
    getSessions: () => ({}),
    queue: {
      enqueueTask: vi.fn(),
      registerProcess: vi.fn(),
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as GroupQueue,
    onProcess: vi.fn(),
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

describe('ops-agent-watchdog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetWatchdogState();

    fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    // Reset mocks
    vi.mocked(getAgentRuntime).mockReturnValue({
      listSessionNames: vi.fn(() => []),
      descriptor: {
        kind: 'tmux-host',
        displayName: 'tmux host sessions',
        isolation: 'host-process',
        dependency: 'tmux',
        proxyBindHost: '127.0.0.1',
        preferredTarget: 'micro-vm',
      },
      stopSession: vi.fn(() => ''),
      hasSession: vi.fn(() => false),
      ensureReady: vi.fn(),
      cleanupOrphans: vi.fn(),
      getStatus: vi.fn(() => ({
        descriptor: {} as never,
        ready: true,
        activeSessions: [],
      })),
    });

    vi.mocked(getDispatchSlotBackend).mockReturnValue({
      name: 'sqlite',
      listActiveSlots: vi.fn(async () => []),
      claimSlot: vi.fn(async () => null),
      markExecuting: vi.fn(async () => {}),
      markReleasing: vi.fn(async () => {}),
      freeSlot: vi.fn(async () => {}),
      recoverStaleSlots: vi.fn(async () => []),
      pruneHistory: vi.fn(() => 0),
    });
  });

  afterEach(() => {
    stopOpsAgentWatchdog();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('detectStuckSlots', () => {
    it('returns empty when no active slots', async () => {
      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });

    it('returns empty when active slots have corresponding tmux sessions', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-1',
            state: 'executing',
            worktreePath: null,
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => ['nanoclaw-worker-123456']),
      });

      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });

    it('detects stuck slots when executing but no tmux sessions', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-1',
            state: 'executing',
            worktreePath: null,
          },
          {
            slotId: 2,
            slotIndex: 1,
            ahqTaskId: 'task-2',
            state: 'executing',
            worktreePath: null,
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // No tmux sessions
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      const result = await detectStuckSlots();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        slotId: 1,
        slotIndex: 0,
        ahqTaskId: 'task-1',
        state: 'executing',
      });
      expect(result[1]).toEqual({
        slotId: 2,
        slotIndex: 1,
        ahqTaskId: 'task-2',
        state: 'executing',
      });
    });

    it('ignores non-executing slots (acquiring/releasing)', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-1',
            state: 'acquiring',
            worktreePath: null,
          },
          {
            slotId: 2,
            slotIndex: 1,
            ahqTaskId: 'task-2',
            state: 'releasing',
            worktreePath: null,
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });

    it('returns empty when listActiveSlots throws', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => {
          throw new Error('DB error');
        }),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });

    it('returns empty when tmux listing throws (avoids false positive)', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'task-1',
            state: 'executing',
            worktreePath: null,
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => {
          throw new Error('tmux not available');
        }),
      });

      const result = await detectStuckSlots();
      expect(result).toEqual([]);
    });
  });

  describe('restartNanoClaw', () => {
    it('calls systemctl restart and returns true', () => {
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      const result = restartNanoClaw();
      expect(result).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        'systemctl --user restart nanoclaw',
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('returns false when systemctl fails', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('systemctl failed');
      });
      const result = restartNanoClaw();
      expect(result).toBe(false);
    });

    it('respects restart cooldown', () => {
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));

      // First restart succeeds
      expect(restartNanoClaw()).toBe(true);

      // Second restart within cooldown should be rejected
      vi.advanceTimersByTime(5 * 60_000); // 5 minutes (< 20 min cooldown)
      expect(restartNanoClaw()).toBe(false);

      // After cooldown, restart should work
      vi.advanceTimersByTime(16 * 60_000); // +16 more minutes (total 21 min)
      expect(restartNanoClaw()).toBe(true);
    });
  });

  describe('runWatchdogTick', () => {
    it('does nothing when no stuck slots detected', async () => {
      const deps = makeMockDeps();
      await runWatchdogTick(deps, () => false);

      expect(deps.sendMessage).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does nothing when stopping', async () => {
      const deps = makeMockDeps();
      await runWatchdogTick(deps, () => true);

      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('sends notification, logs to AHQ, and restarts when stuck slots found', async () => {
      // Set up stuck slot scenario
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'stuck-task-1',
            state: 'executing',
            worktreePath: null,
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      // No tmux sessions
      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      // Mock systemctl restart
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));

      // Mock Agency HQ notification POST
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      const deps = makeMockDeps();
      await runWatchdogTick(deps, () => false);

      // Should have sent Telegram notification to CEO
      expect(deps.sendMessage).toHaveBeenCalledTimes(1);
      const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as string;
      expect(sentMsg).toContain('Ops Watchdog Recovery');
      expect(sentMsg).toContain('stuck-task-1');

      // Should have logged to Agency HQ
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const postCall = fetchMock.mock.calls[0];
      expect(postCall[0]).toContain('/notifications');
      const body = JSON.parse(postCall[1].body);
      expect(body.type).toBe('dispatch-watchdog-recovery');

      // Should have called systemctl restart
      expect(execSync).toHaveBeenCalledWith(
        'systemctl --user restart nanoclaw',
        expect.anything(),
      );
    });

    it('sends notification even when CEO group is not registered', async () => {
      // Set up stuck slot scenario
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'stuck-task-1',
            state: 'executing',
            worktreePath: null,
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      // No CEO group registered
      const deps = makeMockDeps({
        registeredGroups: () => ({}),
      });

      await runWatchdogTick(deps, () => false);

      // Should NOT have sent Telegram (no CEO group)
      expect(deps.sendMessage).not.toHaveBeenCalled();

      // Should still log to AHQ and restart
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(execSync).toHaveBeenCalled();
    });

    it('uses notification batcher when available', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => [
          {
            slotId: 1,
            slotIndex: 0,
            ahqTaskId: 'stuck-task-1',
            state: 'executing',
            worktreePath: null,
          },
        ]),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      vi.mocked(getAgentRuntime).mockReturnValue({
        ...getAgentRuntime(),
        listSessionNames: vi.fn(() => []),
      });

      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      const mockBatcher = {
        send: vi.fn().mockResolvedValue(undefined),
        flushAll: vi.fn().mockResolvedValue(undefined),
      };

      const deps = makeMockDeps();
      await runWatchdogTick(
        deps,
        () => false,
        mockBatcher as unknown as import('./notification-batcher.js').NotificationBatcher,
      );

      // Should use batcher instead of direct sendMessage
      expect(mockBatcher.send).toHaveBeenCalledTimes(1);
      expect(mockBatcher.send).toHaveBeenCalledWith(
        'ceo@g.us',
        expect.stringContaining('Ops Watchdog Recovery'),
        'critical',
      );
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('starts and stops cleanly', () => {
      const deps = makeMockDeps();
      startOpsAgentWatchdog(deps, () => false);
      stopOpsAgentWatchdog();
      // No errors thrown
    });

    it('runs tick on interval', async () => {
      vi.mocked(getDispatchSlotBackend).mockReturnValue({
        name: 'sqlite',
        listActiveSlots: vi.fn(async () => []),
        claimSlot: vi.fn(async () => null),
        markExecuting: vi.fn(async () => {}),
        markReleasing: vi.fn(async () => {}),
        freeSlot: vi.fn(async () => {}),
        recoverStaleSlots: vi.fn(async () => []),
        pruneHistory: vi.fn(() => 0),
      });

      const deps = makeMockDeps();
      startOpsAgentWatchdog(deps, () => false);

      // Advance past the 15-minute interval
      await vi.advanceTimersByTimeAsync(15 * 60_000);

      // listActiveSlots should have been called (tick ran)
      const backend = getDispatchSlotBackend();
      expect(backend.listActiveSlots).toHaveBeenCalled();

      stopOpsAgentWatchdog();
    });
  });
});
