import fs from 'fs';
import path from 'path';
import { AGENCY_HQ_URL } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import type { RegisteredGroup, ContainerConfig } from './types.js';

export interface ModelRow {
  provider: string;
  model: string | null;
  thinking_level?: string | null;
  auto_fallback: boolean;
  updated_at: string;
}
export interface ModelLookup {
  state: 'available' | 'missing' | 'unavailable';
  row?: ModelRow;
}
export function groupConfiguration(
  group: RegisteredGroup,
): ContainerConfig | undefined {
  try {
    const folder = JSON.parse(
      fs.readFileSync(
        path.join(resolveGroupFolderPath(group.folder), 'container.json'),
        'utf8',
      ),
    );
    if (!folder || typeof folder !== 'object' || Array.isArray(folder))
      return group.containerConfig;
    return { ...group.containerConfig, ...folder };
  } catch {
    return group.containerConfig;
  }
}
export async function lookupConversationModel(): Promise<ModelLookup> {
  try {
    const response = await fetch(`${AGENCY_HQ_URL}/api/v1/dispatch-config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { state: 'unavailable' };
    const body = (await response.json()) as {
      data?: Array<ModelRow & { role: string }>;
    };
    if (!Array.isArray(body.data)) return { state: 'unavailable' };
    const row = body.data.find((r) => r.role === 'nanoclaw-main');
    return row ? { state: 'available', row } : { state: 'missing' };
  } catch {
    return { state: 'unavailable' };
  }
}
function defaultModel(provider: string): string {
  return provider === 'codex' ? '' : 'opencode-go/deepseek-v4-flash';
}
function validate(
  provider: string | undefined,
  model: string | undefined,
): void {
  if (provider !== 'codex' && provider !== 'opencode')
    throw new Error('Unsupported conversation provider');
  if (
    model &&
    (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(model) ||
      (provider === 'codex' ? !model.startsWith('gpt-') : !model.includes('/')))
  )
    throw new Error('Invalid conversation model');
}
/** Only selectors are returned as status; the session environment can contain credentials. */
export function applyConversationModel(
  env: Record<string, string>,
  config: ContainerConfig | undefined,
  lookup: ModelLookup,
  operatorOverride = process.env.NANOCLAW_MODEL_SOURCE === 'env',
) {
  let source = 'legacy-default';
  const row = lookup.row;
  if (!operatorOverride && lookup.state === 'available') {
    if (
      !row ||
      typeof row.auto_fallback !== 'boolean' ||
      !(row.model === null || typeof row.model === 'string')
    )
      throw new Error('Invalid conversation configuration');
    validate(row.provider, row.model ?? '');
    if (env.AGENT_RUNNER_BACKEND !== row.provider)
      env.AGENT_CLI_BIN = row.provider;
    env.AGENT_RUNNER_BACKEND = row.provider;
    env.AGENT_MODEL = row.model || defaultModel(row.provider);
    env.AGENT_THINKING_LEVEL = row.thinking_level || '';
    if (!row.auto_fallback) {
      delete env.AGENT_FALLBACK_BACKEND;
      delete env.AGENT_FALLBACK_CLI_BIN;
      delete env.AGENT_FALLBACK_MODEL;
    }
    source = 'central';
  } else if (operatorOverride) source = 'operator-override';
  if (config?.provider) {
    if (config.provider !== env.AGENT_RUNNER_BACKEND) {
      env.AGENT_CLI_BIN = config.provider;
      env.AGENT_MODEL = defaultModel(config.provider);
      env.AGENT_THINKING_LEVEL = '';
    }
    env.AGENT_RUNNER_BACKEND = config.provider;
  }
  if (config?.cliBin) env.AGENT_CLI_BIN = config.cliBin;
  if (config?.model !== undefined) {
    env.AGENT_MODEL = config.model;
    env.AGENT_THINKING_LEVEL = '';
  }
  if (config?.fallbackProvider === null) {
    delete env.AGENT_FALLBACK_BACKEND;
    delete env.AGENT_FALLBACK_CLI_BIN;
    delete env.AGENT_FALLBACK_MODEL;
  } else if (config?.fallbackProvider) {
    if (config.fallbackProvider !== env.AGENT_FALLBACK_BACKEND) {
      env.AGENT_FALLBACK_CLI_BIN = config.fallbackProvider;
      env.AGENT_FALLBACK_MODEL = defaultModel(config.fallbackProvider);
    }
    env.AGENT_FALLBACK_BACKEND = config.fallbackProvider;
  }
  if (config?.fallbackCliBin)
    env.AGENT_FALLBACK_CLI_BIN = config.fallbackCliBin;
  if (config?.fallbackModel !== undefined)
    env.AGENT_FALLBACK_MODEL = config.fallbackModel;
  const override =
    !!config &&
    [
      'provider',
      'model',
      'cliBin',
      'fallbackProvider',
      'fallbackModel',
      'fallbackCliBin',
    ].some((k) => Object.hasOwn(config, k));
  validate(env.AGENT_RUNNER_BACKEND, env.AGENT_MODEL);
  if (env.AGENT_FALLBACK_BACKEND)
    validate(env.AGENT_FALLBACK_BACKEND, env.AGENT_FALLBACK_MODEL);
  return {
    source: override ? 'group-override' : source,
    baseSource: source,
    lookup: lookup.state,
    revision: row?.updated_at ?? null,
    provider: env.AGENT_RUNNER_BACKEND,
    model: env.AGENT_MODEL || '',
    thinkingLevel: env.AGENT_THINKING_LEVEL || '',
    fallbackProvider: env.AGENT_FALLBACK_BACKEND || null,
    fallbackModel: env.AGENT_FALLBACK_MODEL || '',
    customCli: !!config?.cliBin,
  };
}
export type ModelSelection = ReturnType<typeof applyConversationModel>;
export interface ModelExecution {
  provider: string;
  model: string;
  fallback: boolean;
}
const observations = new Map<
  string,
  {
    selection: ModelSelection;
    at: string;
    state: string;
    execution: ModelExecution | null;
  }
>();
export function recordConversationModel(
  group: string,
  selection: ModelSelection,
  state: string,
  execution?: ModelExecution,
) {
  // Bounded, process-local evidence. A restart must not imply a successful invocation.
  if (observations.size >= 200 && !observations.has(group))
    observations.delete(observations.keys().next().value!);
  observations.set(group, {
    selection,
    at: new Date().toISOString(),
    state,
    execution: execution ?? null,
  });
}
export function conversationModelObservations() {
  return Object.fromEntries(observations);
}

export async function conversationModelStatus() {
  const [{ getAllRegisteredGroups }, config] = await Promise.all([
    import('./db/index.js'),
    import('./config.js'),
  ]);
  const lookup = await lookupConversationModel();
  const groups = Object.values(getAllRegisteredGroups()).map((group) => {
    const env = {
      AGENT_RUNNER_BACKEND: config.AGENT_RUNNER_BACKEND,
      AGENT_MODEL: config.AGENT_MODEL,
      AGENT_CLI_BIN: config.AGENT_CLI_BIN,
      AGENT_FALLBACK_BACKEND: config.AGENT_FALLBACK_BACKEND,
      AGENT_FALLBACK_MODEL: config.AGENT_FALLBACK_MODEL,
      AGENT_FALLBACK_CLI_BIN: config.AGENT_FALLBACK_CLI_BIN,
    };
    try {
      return {
        group: group.folder,
        effective: applyConversationModel(
          env,
          groupConfiguration(group),
          lookup,
        ),
        lastInvocation: observations.get(group.folder) ?? null,
      };
    } catch {
      return {
        group: group.folder,
        effective: null,
        error: 'Invalid model configuration',
        lastInvocation: observations.get(group.folder) ?? null,
      };
    }
  });
  return {
    schema: 'nanoclaw-model-status/v1',
    role: 'nanoclaw-main',
    lookup: lookup.state,
    configured: lookup.row ?? null,
    groups,
  };
}
