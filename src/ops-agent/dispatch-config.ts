/**
 * Dispatch Config Client
 *
 * Fetches provider/model configuration from Agency HQ's dispatch-config API
 * at runtime. Polls periodically (default: 60s) so config changes take effect
 * without a restart. Falls back to environment variables when the API is
 * unavailable or returns empty values.
 */
import { agencyFetch } from '../agency-hq-client.js';
import {
  AGENT_CLI_BIN as ENV_AGENT_CLI_BIN,
  AGENT_RUNNER_BACKEND as ENV_AGENT_RUNNER_BACKEND,
} from '../config.js';
import { logger } from '../logger.js';

// --- Types ---

export interface DispatchConfig {
  provider: string;
  model: string;
}

// --- Configuration ---

const POLL_INTERVAL_MS = parseInt(
  process.env.DISPATCH_CONFIG_POLL_INTERVAL_MS || '60000',
  10,
);

// --- State ---

let cachedConfig: DispatchConfig | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// --- Helpers ---

/** Map a provider name to the corresponding CLI binary. */
function providerToCliBin(provider: string): string {
  switch (provider) {
    case 'claude':
      return 'claude';
    default:
      return provider;
  }
}

/** Fetch dispatch config from Agency HQ. Returns null on failure. */
export async function fetchDispatchConfig(): Promise<DispatchConfig | null> {
  try {
    const res = await agencyFetch('/dispatch-config');
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        'dispatch-config API returned non-OK status',
      );
      return null;
    }
    const json = (await res.json()) as {
      success?: boolean;
      data?: { provider?: string; model?: string };
    };
    const data = json.data;
    if (!data?.provider && !data?.model) {
      return null;
    }
    return {
      provider: data.provider || ENV_AGENT_RUNNER_BACKEND,
      model: data.model || '',
    };
  } catch (err) {
    logger.debug({ err }, 'Failed to fetch dispatch-config (falling back to env)');
    return null;
  }
}

/** Refresh the cached config from the API. */
export async function refreshConfig(): Promise<void> {
  const config = await fetchDispatchConfig();
  if (config) {
    const prev = cachedConfig;
    cachedConfig = config;
    if (
      prev &&
      (prev.provider !== config.provider || prev.model !== config.model)
    ) {
      logger.info(
        {
          prevProvider: prev.provider,
          newProvider: config.provider,
          prevModel: prev.model,
          newModel: config.model,
        },
        'Dispatch config updated',
      );
    }
  }
  // On failure, keep previous cached value (or null → env fallback)
}

/** Get the resolved CLI binary name. Uses API config if available, else env var. */
export function getAgentCliBin(): string {
  if (cachedConfig?.provider) {
    return providerToCliBin(cachedConfig.provider);
  }
  return ENV_AGENT_CLI_BIN;
}

/** Get the resolved runner backend. Uses API config if available, else env var. */
export function getAgentRunnerBackend(): string {
  if (cachedConfig?.provider) {
    return cachedConfig.provider;
  }
  return ENV_AGENT_RUNNER_BACKEND;
}

/** Get the resolved model string (empty string means use backend default). */
export function getModel(): string {
  return cachedConfig?.model || '';
}

/** Start periodic config polling. Fetches immediately, then every POLL_INTERVAL_MS. */
export async function startConfigPolling(): Promise<() => void> {
  // Initial fetch
  await refreshConfig();

  logger.info(
    {
      pollIntervalMs: POLL_INTERVAL_MS,
      provider: getAgentRunnerBackend(),
      cliBin: getAgentCliBin(),
      model: getModel() || '(default)',
    },
    'Dispatch config polling started',
  );

  pollTimer = setInterval(refreshConfig, POLL_INTERVAL_MS);

  return stopConfigPolling;
}

/** Stop the config polling timer. */
export function stopConfigPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Reset internal state (for testing). */
export function _resetForTest(): void {
  cachedConfig = null;
  stopConfigPolling();
}

/** Expose cached config for testing. */
export function _getCachedConfig(): DispatchConfig | null {
  return cachedConfig;
}
