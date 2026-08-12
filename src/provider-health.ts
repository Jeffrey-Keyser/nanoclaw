import { spawnSync } from 'child_process';

import {
  AGENT_CLI_BIN,
  AGENT_FALLBACK_BACKEND,
  AGENT_FALLBACK_CLI_BIN,
  AGENT_FALLBACK_MODEL,
  AGENT_MODEL,
  AGENT_RUNNER_BACKEND,
} from './config.js';

export interface ProviderDiagnostic {
  provider: string;
  model: string | null;
  binary: string;
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface ProviderDiagnostics {
  primary: ProviderDiagnostic;
  fallback: ProviderDiagnostic | null;
}

export function checkProvider(
  provider: string,
  model: string | null,
  binary: string,
): ProviderDiagnostic {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const available = !result.error && result.status === 0;
  return {
    provider,
    model,
    binary,
    available,
    version: available
      ? (result.stdout || result.stderr || '').trim().split('\n')[0] || null
      : null,
    error: available
      ? null
      : result.error?.message ||
        (result.stderr || '').trim() ||
        `exit ${result.status}`,
  };
}

export function getProviderDiagnostics(): ProviderDiagnostics {
  return {
    primary: checkProvider(
      AGENT_RUNNER_BACKEND,
      AGENT_MODEL || null,
      AGENT_CLI_BIN,
    ),
    fallback: AGENT_FALLBACK_BACKEND
      ? checkProvider(
          AGENT_FALLBACK_BACKEND,
          AGENT_FALLBACK_MODEL || null,
          AGENT_FALLBACK_CLI_BIN,
        )
      : null,
  };
}
