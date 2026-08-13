import crypto from 'node:crypto';

export interface AgentEventSmokeOptions {
  recipient: string;
  messageApiUrl: string;
  healthUrl: string;
  timeoutMs: number;
  pollIntervalMs: number;
  runId?: string;
}

interface HealthSnapshot {
  status?: string;
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

interface AgentEventStatusResponse extends AgentEventResponse {
  delivery?: string;
  execution_id?: string | null;
  result?: string | null;
}

export interface AgentEventSmokeDependencies {
  fetchHealth: () => Promise<HealthSnapshot>;
  postAgentEvent: (body: {
    recipient: string;
    instruction: string;
    source: string;
    delivery: 'capture';
  }) => Promise<AgentEventResponse>;
  getAgentEvent: (id: string) => Promise<AgentEventStatusResponse>;
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

  const firstResponse = await dependencies.postAgentEvent({
    recipient: options.recipient,
    instruction: agentInstruction(firstOutput),
    source,
    delivery: 'capture',
  });
  if (firstResponse.status !== 'queued-for-agent' || !firstResponse.id) {
    throw new Error(
      `First event was not queued: ${JSON.stringify(firstResponse)}`,
    );
  }

  await waitUntil(
    'the first captured event to enter a runner',
    deadline,
    options.pollIntervalMs,
    dependencies.sleep,
    async () =>
      (await dependencies.getAgentEvent(firstResponse.id!)).status ===
      'running',
  );

  // Intentionally submit while the first event is running. A one-shot
  // provider must drain this through a fresh invocation.
  const followUpResponse = await dependencies.postAgentEvent({
    recipient: options.recipient,
    instruction: agentInstruction(followUpOutput),
    source,
    delivery: 'capture',
  });
  if (followUpResponse.status !== 'queued-for-agent' || !followUpResponse.id) {
    throw new Error(
      `Follow-up event was not queued: ${JSON.stringify(followUpResponse)}`,
    );
  }

  let firstEvent: AgentEventStatusResponse | undefined;
  let followUpEvent: AgentEventStatusResponse | undefined;
  await waitUntil(
    'both captured canary results',
    deadline,
    options.pollIntervalMs,
    dependencies.sleep,
    async () => {
      [firstEvent, followUpEvent] = await Promise.all([
        dependencies.getAgentEvent(firstResponse.id!),
        dependencies.getAgentEvent(followUpResponse.id!),
      ]);
      return (
        firstEvent.status === 'completed' &&
        followUpEvent.status === 'completed'
      );
    },
  );

  if (firstEvent?.result !== firstOutput) {
    throw new Error(
      `Unexpected first canary result: ${JSON.stringify(firstEvent?.result)}`,
    );
  }
  if (followUpEvent?.result !== followUpOutput) {
    throw new Error(
      `Unexpected follow-up canary result: ${JSON.stringify(followUpEvent?.result)}`,
    );
  }
  if (
    !firstEvent.execution_id ||
    !followUpEvent.execution_id ||
    firstEvent.execution_id === followUpEvent.execution_id
  ) {
    throw new Error(
      'Canary follow-up did not use a separate runner invocation',
    );
  }

  return {
    runId,
    eventIds: [firstResponse.id, followUpResponse.id],
    outputs: [firstOutput, followUpOutput],
    runnerInvocations: 2,
    durationMs: Date.now() - startedAt,
  };
}

export function createLiveSmokeDependencies(options: AgentEventSmokeOptions): {
  dependencies: AgentEventSmokeDependencies;
} {
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
    dependencies: {
      fetchHealth: async () =>
        (await fetchJson(options.healthUrl)) as HealthSnapshot,
      postAgentEvent: async (body) =>
        (await fetchJson(`${options.messageApiUrl}/api/v1/agent-events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })) as AgentEventResponse,
      getAgentEvent: async (id) =>
        (await fetchJson(
          `${options.messageApiUrl}/api/v1/agent-events/${encodeURIComponent(id)}`,
        )) as AgentEventStatusResponse,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  };
}
