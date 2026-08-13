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
  timeoutMs: 5_000,
  pollIntervalMs: 0,
  runId: 'TEST_RUN',
};

function successfulDependencies(
  overrides: {
    firstResult?: string;
    followUpResult?: string;
    followUpExecutionId?: string;
    primaryAvailable?: boolean;
    fallbackAvailable?: boolean;
  } = {},
): AgentEventSmokeDependencies {
  let postCount = 0;
  let firstStatusReads = 0;
  return {
    fetchHealth: vi.fn(async () => ({
      status: 'ok',
      providers: {
        primary: { available: overrides.primaryAvailable ?? true },
        fallback: { available: overrides.fallbackAvailable ?? true },
      },
    })),
    postAgentEvent: vi.fn(async () => {
      postCount += 1;
      return { id: `event-${postCount}`, status: 'queued-for-agent' };
    }),
    getAgentEvent: vi.fn(async (id: string) => {
      if (id === 'event-1' && firstStatusReads++ === 0) {
        return { id, status: 'running', execution_id: 'runner-1' };
      }
      if (id === 'event-1') {
        return {
          id,
          status: 'completed',
          execution_id: 'runner-1',
          result: overrides.firstResult ?? 'NANOCLAW_CANARY_TEST_RUN_FIRST',
        };
      }
      return {
        id,
        status: 'completed',
        execution_id: overrides.followUpExecutionId ?? 'runner-2',
        result:
          overrides.followUpResult ?? 'NANOCLAW_CANARY_TEST_RUN_FOLLOW_UP',
      };
    }),
    sleep: vi.fn(async () => undefined),
  };
}

describe('agent event deployment smoke', () => {
  it('captures a follow-up through a separate runner without channel delivery', async () => {
    const dependencies = successfulDependencies();

    const result = await runAgentEventSmoke(options, dependencies);

    expect(result.eventIds).toEqual(['event-1', 'event-2']);
    expect(result.runnerInvocations).toBe(2);
    expect(dependencies.postAgentEvent).toHaveBeenCalledTimes(2);
    expect(dependencies.postAgentEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ delivery: 'capture' }),
    );
  });

  it('rejects an unexpected captured result', async () => {
    const dependencies = successfulDependencies({
      firstResult: 'Agent-event deployment canary. Reply with exactly ...',
    });

    await expect(runAgentEventSmoke(options, dependencies)).rejects.toThrow(
      'Unexpected first canary result',
    );
  });

  it('requires a fresh invocation for the queued follow-up', async () => {
    const dependencies = successfulDependencies({
      followUpExecutionId: 'runner-1',
    });

    await expect(runAgentEventSmoke(options, dependencies)).rejects.toThrow(
      'separate runner invocation',
    );
  });

  it('continues when only the fallback provider is available', async () => {
    const dependencies = successfulDependencies({
      primaryAvailable: false,
      fallbackAvailable: true,
    });

    await expect(
      runAgentEventSmoke(options, dependencies),
    ).resolves.toMatchObject({ runnerInvocations: 2 });
  });

  it('fails before sending when every provider is unavailable', async () => {
    const dependencies = successfulDependencies({
      primaryAvailable: false,
      fallbackAvailable: false,
    });

    await expect(runAgentEventSmoke(options, dependencies)).rejects.toThrow(
      'no available agent provider',
    );
    expect(dependencies.postAgentEvent).not.toHaveBeenCalled();
  });
});
