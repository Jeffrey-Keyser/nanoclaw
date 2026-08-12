/**
 * Backend factory — returns the appropriate RunnerBackend based on env config.
 */

import type { RunOptions, RunResult, RunnerBackend } from './runner-backend.js';
import { CodexCliBackend } from './codex-cli-backend.js';
import { OpenCodeCliBackend } from './opencode-cli-backend.js';

export class ProviderBackend implements RunnerBackend {
  readonly supportsResume: boolean;

  constructor(
    private readonly provider: string,
    private readonly delegate: RunnerBackend,
  ) {
    this.supportsResume = delegate.supportsResume;
  }

  async invoke(prompt: string, options: RunOptions): Promise<RunResult> {
    const prefix = `${this.provider}:`;
    const sessionId = options.sessionId?.startsWith(prefix)
      ? options.sessionId.slice(prefix.length)
      : undefined;
    const result = await this.delegate.invoke(prompt, {
      ...options,
      sessionId,
    });
    return {
      ...result,
      newSessionId: result.newSessionId
        ? `${this.provider}:${result.newSessionId}`
        : undefined,
    };
  }
}

export class FallbackBackend implements RunnerBackend {
  readonly supportsResume: boolean;

  constructor(
    private readonly primary: RunnerBackend,
    private readonly fallback?: RunnerBackend,
  ) {
    this.supportsResume = primary.supportsResume;
  }

  async invoke(
    prompt: string,
    options: Parameters<RunnerBackend['invoke']>[1],
  ) {
    try {
      const result = await this.primary.invoke(prompt, options);
      if (result.exitCode === 0 || !this.fallback) return result;
    } catch (err) {
      if (!this.fallback) throw err;
    }
    return this.fallback.invoke(prompt, {
      ...options,
      sessionId: undefined,
      model: process.env.AGENT_FALLBACK_MODEL || undefined,
    });
  }
}

function backend(name: string, binary?: string): RunnerBackend {
  let delegate: RunnerBackend;
  switch (name) {
    case 'opencode':
      delegate = new OpenCodeCliBackend(binary || 'opencode');
      break;
    case 'codex':
      delegate = new CodexCliBackend(binary || 'codex');
      break;
    default:
      throw new Error(
        `Unknown runner backend: "${name}". Supported: opencode, codex`,
      );
  }
  return new ProviderBackend(name, delegate);
}

/**
 * Create a RunnerBackend based on the AGENT_RUNNER_BACKEND env var.
 * Default: OpenCode, with an optional independently configured fallback.
 */
export function createBackend(): RunnerBackend {
  const primaryName = process.env.AGENT_RUNNER_BACKEND || 'opencode';
  const fallbackName = process.env.AGENT_FALLBACK_BACKEND;
  return new FallbackBackend(
    backend(primaryName, process.env.AGENT_CLI_BIN),
    fallbackName
      ? backend(fallbackName, process.env.AGENT_FALLBACK_CLI_BIN)
      : undefined,
  );
}
