import { spawnSync } from 'child_process';
import fs from 'fs';

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

const CACHE_TTL_MS = 5 * 60_000;
let cachedDiagnostics:
  | { value: ProviderDiagnostics; expiresAt: number }
  | undefined;

export function checkProvider(
  provider: string,
  model: string | null,
  binary: string,
): ProviderDiagnostic {
  // Health requests must never block the service on a provider CLI. Presence
  // and executability are sufficient for readiness; the real deployment
  // canary verifies that the provider can actually complete work.
  if (binary.includes('/')) {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
    } catch (err) {
      return {
        provider,
        model,
        binary,
        available: false,
        version: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      provider,
      model,
      binary,
      available: true,
      version: null,
      error: null,
    };
  }

  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 1_000,
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
  if (cachedDiagnostics && cachedDiagnostics.expiresAt > Date.now()) {
    return cachedDiagnostics.value;
  }
  const value = {
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
  cachedDiagnostics = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}
