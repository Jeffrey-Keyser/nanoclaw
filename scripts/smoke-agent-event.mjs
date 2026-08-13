#!/usr/bin/env node
import {
  createLiveSmokeDependencies,
  runAgentEventSmoke,
} from '../dist/agent-event-smoke.js';

const recipient = process.env.NANOCLAW_SMOKE_RECIPIENT;

if (!recipient) {
  console.error(
    'NANOCLAW_SMOKE_RECIPIENT is required (for example, tg:123456789).',
  );
  process.exit(2);
}

const options = {
  recipient,
  messageApiUrl:
    process.env.NANOCLAW_MESSAGE_API_URL || 'http://127.0.0.1:3102',
  healthUrl: process.env.NANOCLAW_HEALTH_URL || 'http://127.0.0.1:3101/health',
  timeoutMs: Number(process.env.NANOCLAW_SMOKE_TIMEOUT_MS || 120_000),
  pollIntervalMs: Number(process.env.NANOCLAW_SMOKE_POLL_INTERVAL_MS || 500),
};

const live = createLiveSmokeDependencies(options);

try {
  const result = await runAgentEventSmoke(options, live.dependencies);
  console.log(
    `Silent agent-event smoke passed (${result.runId}, events=${result.eventIds.join(',')}, runners=${result.runnerInvocations}, duration=${result.durationMs}ms)`,
  );
} catch (error) {
  console.error(
    `Silent agent-event smoke failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
