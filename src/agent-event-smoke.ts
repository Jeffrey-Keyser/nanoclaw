import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export interface AgentEventSmokeOptions {
  recipient: string;
  messageApiUrl: string;
  healthUrl: string;
  logFile: string;
  timeoutMs: number;
  pollIntervalMs: number;
  runId?: string;
}

interface HealthSnapshot {
  status?: string;
  runtime?: { activeSessionCount?: number };
  providers?: {
    primary?: { available?: boolean };
    fallback?: { available?: boolean };
  };
}

interface AgentEventResponse {
  id?: string;
  status?: string;
  error?: string;
}

export interface AgentEventSmokeDependencies {
  fetchHealth: () => Promise<HealthSnapshot>;
  postAgentEvent: (body: {
    recipient: string;
    instruction: string;
    source: string;
  }) => Promise<AgentEventResponse>;
  readNewLogs: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

export interface AgentEventSmokeResult {
  runId: string;
  eventIds: [string, string];
  outputs: [string, string];
  runnerInvocations: number;
  durationMs: number;
}

function smokeRunId(): string {
  return `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`.toUpperCase();
}

function agentInstruction(output: string): string {
  return `Agent-event deployment canary. Reply with exactly ${output} and nothing else.`;
}

async function waitUntil(
  description: string,
  deadline: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
  predicate: () => Promise<boolean>,
): Promise<void> {
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function runAgentEventSmoke(
  options: AgentEventSmokeOptions,
  dependencies: AgentEventSmokeDependencies,
): Promise<AgentEventSmokeResult> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const runId = options.runId || smokeRunId();
  const firstOutput = `NANOCLAW_CANARY_${runId}_FIRST`;
  const followUpOutput = `NANOCLAW_CANARY_${runId}_FOLLOW_UP`;
  const source = `nanoclaw-deployment-canary-${runId}`;

  const initialHealth = await dependencies.fetchHealth();
  if (initialHealth.status !== 'ok') {
    throw new Error(
      `NanoClaw is not healthy: ${JSON.stringify(initialHealth)}`,
    );
  }
  const primaryAvailable = initialHealth.providers?.primary?.available === true;
  const fallbackAvailable =
    initialHealth.providers?.fallback?.available === true;
  if (!primaryAvailable && !fallbackAvailable) {
    throw new Error('NanoClaw has no available agent provider');
  }

  const eventIds: string[] = [];
  const firstResponse = await dependencies.postAgentEvent({
    recipient: options.recipient,
    instruction: agentInstruction(firstOutput),
    source,
  });
  if (firstResponse.status !== 'queued-for-agent' || !firstResponse.id) {
    throw new Error(
      `First event was not queued: ${JSON.stringify(firstResponse)}`,
    );
  }
  eventIds.push(firstResponse.id);

  await waitUntil(
    'the first agent runner to become active',
    deadline,
    options.pollIntervalMs,
    dependencies.sleep,
    async () =>
      ((await dependencies.fetchHealth()).runtime?.activeSessionCount ?? 0) > 0,
  );

  // This event is intentionally submitted while the first one is active. A
  // one-shot provider must drain it through a fresh invocation.
  const followUpResponse = await dependencies.postAgentEvent({
    recipient: options.recipient,
    instruction: agentInstruction(followUpOutput),
    source,
  });
  if (followUpResponse.status !== 'queued-for-agent' || !followUpResponse.id) {
    throw new Error(
      `Follow-up event was not queued: ${JSON.stringify(followUpResponse)}`,
    );
  }
  eventIds.push(followUpResponse.id);

  let logs = '';
  await waitUntil(
    'both exact canary outputs from separate runner invocations',
    deadline,
    options.pollIntervalMs,
    dependencies.sleep,
    async () => {
      logs += await dependencies.readNewLogs();
      const invocationCount = (logs.match(/Spawning tmux agent session/g) || [])
        .length;
      return (
        logs.includes(`Agent output: ${firstOutput}`) &&
        logs.includes(`Agent output: ${followUpOutput}`) &&
        invocationCount >= 2
      );
    },
  );

  if (logs.includes('Agent output: Agent-event deployment canary.')) {
    throw new Error('Raw canary instructions were emitted as agent output');
  }

  const runnerInvocations = (logs.match(/Spawning tmux agent session/g) || [])
    .length;
  return {
    runId,
    eventIds: eventIds as [string, string],
    outputs: [firstOutput, followUpOutput],
    runnerInvocations,
    durationMs: Date.now() - startedAt,
  };
}

export function createLiveSmokeDependencies(options: AgentEventSmokeOptions): {
  dependencies: AgentEventSmokeDependencies;
  initialize: () => Promise<void>;
} {
  let logOffset = 0;

  async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(url, init);
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} from ${url}: ${JSON.stringify(body)}`,
      );
    }
    return body;
  }

  return {
    initialize: async () => {
      logOffset = (await fs.stat(options.logFile)).size;
    },
    dependencies: {
      fetchHealth: async () =>
        (await fetchJson(options.healthUrl)) as HealthSnapshot,
      postAgentEvent: async (body) =>
        (await fetchJson(`${options.messageApiUrl}/api/v1/agent-events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })) as AgentEventResponse,
      readNewLogs: async () => {
        const handle = await fs.open(options.logFile, 'r');
        try {
          const size = (await handle.stat()).size;
          if (size < logOffset) logOffset = 0;
          if (size === logOffset) return '';
          const buffer = Buffer.alloc(size - logOffset);
          await handle.read(buffer, 0, buffer.length, logOffset);
          logOffset = size;
          return buffer.toString('utf8');
        } finally {
          await handle.close();
        }
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  };
}
