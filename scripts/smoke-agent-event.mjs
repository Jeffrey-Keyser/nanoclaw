#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createLiveSmokeDependencies,
  runAgentEventSmoke,
} from '../dist/agent-event-smoke.js';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
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
  logFile:
    process.env.NANOCLAW_LOG_FILE ||
    path.join(projectRoot, 'logs', 'nanoclaw.log'),
  timeoutMs: Number(process.env.NANOCLAW_SMOKE_TIMEOUT_MS || 120_000),
  pollIntervalMs: Number(process.env.NANOCLAW_SMOKE_POLL_INTERVAL_MS || 500),
};

const live = createLiveSmokeDependencies(options);
await live.initialize();

try {
  const result = await runAgentEventSmoke(options, live.dependencies);
  console.log(
    `Agent-event smoke passed (${result.runId}, events=${result.eventIds.join(',')}, runners=${result.runnerInvocations}, duration=${result.durationMs}ms)`,
  );
} catch (error) {
  console.error(
    `Agent-event smoke failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
