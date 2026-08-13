import { describe, expect, it, vi } from 'vitest';

import {
  AgentEventSmokeDependencies,
  AgentEventSmokeOptions,
  runAgentEventSmoke,
} from './agent-event-smoke.js';

const options: AgentEventSmokeOptions = {
  recipient: 'tg:123',
  messageApiUrl: 'http://127.0.0.1:3102',
  healthUrl: 'http://127.0.0.1:3101/health',
  logFile: '/tmp/nanoclaw-test.log',
  timeoutMs: 5_000,
  pollIntervalMs: 0,
  runId: 'TEST_RUN',
};

describe('agent event deployment smoke', () => {
  it('queues a follow-up while active and requires two exact outputs', async () => {
    let postCount = 0;
    const dependencies: AgentEventSmokeDependencies = {
      fetchHealth: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'ok',
          providers: { primary: { available: true } },
          runtime: { activeSessionCount: 0 },
        })
        .mockResolvedValue({
          status: 'ok',
          providers: { primary: { available: true } },
          runtime: { activeSessionCount: 1 },
        }),
      postAgentEvent: vi.fn(async () => {
        postCount += 1;
        return { id: `event-${postCount}`, status: 'queued-for-agent' };
      }),
      readNewLogs: vi.fn(async () =>
        [
          'Spawning tmux agent session',
          'Agent output: NANOCLAW_CANARY_TEST_RUN_FIRST',
          'Spawning tmux agent session',
          'Agent output: NANOCLAW_CANARY_TEST_RUN_FOLLOW_UP',
        ].join('\n'),
      ),
      sleep: vi.fn(async () => undefined),
    };

    const result = await runAgentEventSmoke(options, dependencies);

    expect(result.eventIds).toEqual(['event-1', 'event-2']);
    expect(result.runnerInvocations).toBe(2);
    expect(dependencies.postAgentEvent).toHaveBeenCalledTimes(2);
  });

  it('rejects a raw instruction echo', async () => {
    const dependencies: AgentEventSmokeDependencies = {
      fetchHealth: vi.fn(async () => ({
        status: 'ok',
        providers: { primary: { available: true } },
        runtime: { activeSessionCount: 1 },
      })),
      postAgentEvent: vi
        .fn()
        .mockResolvedValueOnce({ id: 'event-1', status: 'queued-for-agent' })
        .mockResolvedValueOnce({ id: 'event-2', status: 'queued-for-agent' }),
      readNewLogs: vi.fn(async () =>
        [
          'Spawning tmux agent session',
          'Agent output: NANOCLAW_CANARY_TEST_RUN_FIRST',
          'Spawning tmux agent session',
          'Agent output: NANOCLAW_CANARY_TEST_RUN_FOLLOW_UP',
          'Agent output: Agent-event deployment canary.',
        ].join('\n'),
      ),
      sleep: vi.fn(async () => undefined),
    };

    await expect(runAgentEventSmoke(options, dependencies)).rejects.toThrow(
      'Raw canary instructions were emitted',
    );
  });

  it('continues when only the fallback provider is available', async () => {
    const dependencies: AgentEventSmokeDependencies = {
      fetchHealth: vi.fn(async () => ({
        status: 'ok',
        providers: {
          primary: { available: false },
          fallback: { available: true },
        },
        runtime: { activeSessionCount: 1 },
      })),
      postAgentEvent: vi
        .fn()
        .mockResolvedValueOnce({ id: 'event-1', status: 'queued-for-agent' })
        .mockResolvedValueOnce({ id: 'event-2', status: 'queued-for-agent' }),
      readNewLogs: vi.fn(async () =>
        [
          'Spawning tmux agent session',
          'Agent output: NANOCLAW_CANARY_TEST_RUN_FIRST',
          'Spawning tmux agent session',
          'Agent output: NANOCLAW_CANARY_TEST_RUN_FOLLOW_UP',
        ].join('\n'),
      ),
      sleep: vi.fn(async () => undefined),
    };

    await expect(
      runAgentEventSmoke(options, dependencies),
    ).resolves.toMatchObject({
      eventIds: ['event-1', 'event-2'],
    });
  });

  it('fails before sending when every provider is unavailable', async () => {
    const dependencies: AgentEventSmokeDependencies = {
      fetchHealth: vi.fn(async () => ({
        status: 'ok',
        providers: {
          primary: { available: false },
          fallback: { available: false },
        },
      })),
      postAgentEvent: vi.fn(),
      readNewLogs: vi.fn(),
      sleep: vi.fn(async () => undefined),
    };

    await expect(runAgentEventSmoke(options, dependencies)).rejects.toThrow(
      'no available agent provider',
    );
    expect(dependencies.postAgentEvent).not.toHaveBeenCalled();
  });
});
