import { describe, expect, it, vi } from 'vitest';

import {
  FallbackBackend,
  ProviderBackend,
} from '../container/agent-runner/src/backend-factory.js';
import type {
  RunOptions,
  RunnerBackend,
} from '../container/agent-runner/src/runner-backend.js';

const options: RunOptions = {
  cwd: '/tmp',
  env: {},
  model: 'primary-model',
};

function fakeBackend(invoke: RunnerBackend['invoke']): RunnerBackend {
  return { supportsResume: true, invoke };
}

describe('provider-neutral agent runner', () => {
  it('only resumes continuation IDs owned by the selected provider', async () => {
    const invoke = vi.fn().mockResolvedValue({
      output: 'done',
      newSessionId: 'next-session',
      exitCode: 0,
    });
    const backend = new ProviderBackend('opencode', fakeBackend(invoke));

    const result = await backend.invoke('work', {
      ...options,
      sessionId: 'codex:foreign-session',
    });

    expect(invoke).toHaveBeenCalledWith(
      'work',
      expect.objectContaining({ sessionId: undefined }),
    );
    expect(result.newSessionId).toBe('opencode:next-session');
  });

  it('strips the provider prefix when resuming its own session', async () => {
    const invoke = vi.fn().mockResolvedValue({
      output: 'done',
      newSessionId: 'same-session',
      exitCode: 0,
    });
    const backend = new ProviderBackend('codex', fakeBackend(invoke));

    await backend.invoke('work', {
      ...options,
      sessionId: 'codex:same-session',
    });

    expect(invoke).toHaveBeenCalledWith(
      'work',
      expect.objectContaining({ sessionId: 'same-session' }),
    );
  });

  it('uses a fresh fallback session and the fallback model', async () => {
    const primary = fakeBackend(
      vi.fn().mockResolvedValue({ output: 'failed', exitCode: 1 }),
    );
    const fallbackInvoke = vi.fn().mockResolvedValue({
      output: 'recovered',
      newSessionId: 'codex:recovery',
      exitCode: 0,
    });
    const fallback = fakeBackend(fallbackInvoke);
    const previousModel = process.env.AGENT_FALLBACK_MODEL;
    process.env.AGENT_FALLBACK_MODEL = 'fallback-model';
    try {
      const result = await new FallbackBackend(primary, fallback).invoke(
        'work',
        { ...options, sessionId: 'opencode:old-session' },
      );

      expect(fallbackInvoke).toHaveBeenCalledWith(
        'work',
        expect.objectContaining({
          sessionId: undefined,
          model: 'fallback-model',
        }),
      );
      expect(result.output).toBe('recovered');
    } finally {
      if (previousModel === undefined) delete process.env.AGENT_FALLBACK_MODEL;
      else process.env.AGENT_FALLBACK_MODEL = previousModel;
    }
  });
});
