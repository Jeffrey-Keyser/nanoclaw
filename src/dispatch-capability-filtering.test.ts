/**
 * Dispatch Capability Filtering Tests
 *
 * Verifies that the dispatch loop correctly filters agents based on
 * capability constraints.  Specifically, leadership-only agents (e.g. CEO)
 * must NOT be dispatched for implementation tasks — tasks with a `repository`
 * field that require hands-on code changes.
 *
 * Implementation-capable agents (e.g. engineering-lead) must still be
 * eligible for the same task type.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agency-hq-client.js', () => ({
  agencyFetch: vi.fn(),
  fetchPersona: vi.fn().mockResolvedValue(null),
}));

vi.mock('./worktree-manager.js', () => ({
  cleanupOrphanedWorktrees: vi.fn(),
  createWorktree: vi.fn().mockReturnValue(null),
  removeWorktree: vi.fn(),
}));

import { agencyFetch } from './agency-hq-client.js';
import { _initTestDatabase } from './db/index.js';
import {
  dispatchReadyTasks,
  dispatchRetryCount,
  dispatchSkipTicks,
  IMPLEMENTATION_EXCLUDED_AGENTS,
  resetDispatchLoopState,
} from './dispatch-loop.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDeps() {
  return {
    registeredGroups: () => ({
      'main@g.us': { isMain: true as const, folder: 'main', name: 'Main' },
    }),
    getSessions: () => ({}),
    queue: { enqueueTask: vi.fn() },
    onProcess: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _initTestDatabase();
  resetDispatchLoopState();
  dispatchRetryCount.clear();
  dispatchSkipTicks.clear();
  vi.clearAllMocks();
});

// ===========================================================================
// Capability Filtering: CEO agent excluded from implementation tasks
// ===========================================================================
describe('Dispatch capability filtering', () => {
  it('CEO agent is in the IMPLEMENTATION_EXCLUDED_AGENTS set', () => {
    expect(IMPLEMENTATION_EXCLUDED_AGENTS.has('agency/leadership/ceo')).toBe(
      true,
    );
  });

  it('skips implementation task assigned to CEO agent', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    const enqueueCalls: string[] = [];

    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/tasks?status=ready') {
        return mockResponse({
          success: true,
          data: [
            {
              id: 'task-impl-ceo',
              title: 'Implement feature X',
              description: 'Add new feature',
              status: 'ready',
              repository: 'org/repo',
              assigned_to: 'agency/leadership/ceo',
              assigned_at: null,
              scheduled_dispatch_at: null,
              dispatch_blocked_until: null,
              dispatch_attempts: 0,
              sprint_id: null,
            },
          ],
        });
      }
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    await dispatchReadyTasks(deps, () => false);

    // CEO-assigned implementation task must NOT be enqueued
    expect(deps.queue.enqueueTask).not.toHaveBeenCalled();

    // No PUT to mark in-progress should have been made — the task was
    // filtered out before dispatch, so the only call is the initial GET.
    const putCalls = mockFetch.mock.calls.filter(
      ([, opts]) => (opts as RequestInit | undefined)?.method === 'PUT',
    );
    expect(putCalls).toHaveLength(0);
  });

  it('allows engineering-lead agent for implementation tasks with repository', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    mockFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/tasks?status=ready') {
        return mockResponse({
          success: true,
          data: [
            {
              id: 'task-impl-eng',
              title: 'Implement feature Y',
              description: 'Add another feature',
              status: 'ready',
              repository: 'org/repo',
              assigned_to: 'agency/leadership/engineering-lead',
              scheduled_dispatch_at: null,
              dispatch_blocked_until: null,
              dispatch_attempts: 0,
              sprint_id: null,
            },
          ],
        });
      }
      // PUT in-progress
      if (
        path === '/tasks/task-impl-eng' &&
        opts?.method === 'PUT'
      ) {
        return mockResponse({ success: true });
      }
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    await dispatchReadyTasks(deps, () => false);

    // engineering-lead IS eligible — task must be enqueued
    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);

    // PUT in-progress must have been called
    const putCalls = mockFetch.mock.calls.filter(
      ([, opts]) => {
        const init = opts as RequestInit | undefined;
        if (init?.method !== 'PUT') return false;
        const body = JSON.parse(init.body as string) as { status?: string };
        return body.status === 'in-progress';
      },
    );
    expect(putCalls).toHaveLength(1);
  });

  it('allows CEO agent for non-implementation tasks (no repository)', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    mockFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/tasks?status=ready') {
        return mockResponse({
          success: true,
          data: [
            {
              id: 'task-planning-ceo',
              title: 'Review quarterly roadmap',
              description: 'Strategic planning',
              status: 'ready',
              // No repository field — this is a planning/strategy task
              assigned_to: 'agency/leadership/ceo',
              scheduled_dispatch_at: null,
              dispatch_blocked_until: null,
              dispatch_attempts: 0,
              sprint_id: null,
            },
          ],
        });
      }
      if (
        path === '/tasks/task-planning-ceo' &&
        opts?.method === 'PUT'
      ) {
        return mockResponse({ success: true });
      }
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    await dispatchReadyTasks(deps, () => false);

    // CEO IS eligible for non-implementation (no repo) tasks
    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);
  });

  it('allows unassigned tasks with repository (no assigned_to)', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    mockFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/tasks?status=ready') {
        return mockResponse({
          success: true,
          data: [
            {
              id: 'task-impl-unassigned',
              title: 'Fix bug Z',
              description: 'Bug fix',
              status: 'ready',
              repository: 'org/repo',
              // No assigned_to — uses default persona
              scheduled_dispatch_at: null,
              dispatch_blocked_until: null,
              dispatch_attempts: 0,
              sprint_id: null,
            },
          ],
        });
      }
      if (
        path === '/tasks/task-impl-unassigned' &&
        opts?.method === 'PUT'
      ) {
        return mockResponse({ success: true });
      }
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    await dispatchReadyTasks(deps, () => false);

    // Unassigned implementation tasks must still be dispatched
    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);
  });

  it('filters CEO but dispatches engineering-lead in the same batch', async () => {
    const mockFetch = vi.mocked(agencyFetch);

    mockFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/tasks?status=ready') {
        return mockResponse({
          success: true,
          data: [
            {
              id: 'task-ceo-blocked',
              title: 'CEO impl task',
              description: 'Should be skipped',
              status: 'ready',
              repository: 'org/repo',
              assigned_to: 'agency/leadership/ceo',
              scheduled_dispatch_at: null,
              dispatch_blocked_until: null,
              dispatch_attempts: 0,
              sprint_id: null,
            },
            {
              id: 'task-eng-allowed',
              title: 'Eng impl task',
              description: 'Should be dispatched',
              status: 'ready',
              repository: 'org/repo',
              assigned_to: 'agency/leadership/engineering-lead',
              scheduled_dispatch_at: null,
              dispatch_blocked_until: null,
              dispatch_attempts: 0,
              sprint_id: null,
            },
          ],
        });
      }
      if (opts?.method === 'PUT') {
        return mockResponse({ success: true });
      }
      return mockResponse({ success: true });
    });

    const deps = makeMockDeps();
    await dispatchReadyTasks(deps, () => false);

    // Only the engineering-lead task should be enqueued
    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);

    // Verify the enqueued task is the engineering-lead one
    const enqueueCall = (deps.queue.enqueueTask as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    const enqueuedLocalTaskId = enqueueCall[1] as string;
    expect(enqueuedLocalTaskId).toContain('ahq-task-eng-allowed');
  });
});
