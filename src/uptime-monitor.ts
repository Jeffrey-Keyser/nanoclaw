import { spawn } from 'child_process';
import { hostname } from 'os';
import { z } from 'zod';

import { getRouterState, setRouterState } from './db/index.js';
import { logger } from './logger.js';
import type { NotificationBatcher } from './notification-batcher.js';
import { RegisteredGroup } from './types.js';

const INTERVAL_MS = 5 * 60 * 1000;
const DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STATE_KEY = 'uptime_monitor_v1';
const MAX_DIGEST_UNITS = 20;

const stateSchema = z.object({
  failures: z.record(
    z.string(),
    z.object({
      firstSeenAt: z.number(),
      lastSeenAt: z.number(),
      alerted: z.boolean(),
    }),
  ),
  recoveries: z.record(z.string(), z.number()),
  lastDigestAt: z.number(),
});
type MonitorState = z.infer<typeof stateSchema>;

export interface UptimeMonitorDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  notificationBatcher?: NotificationBatcher;
}

function runCommand(): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      'systemctl',
      [
        '--user',
        'list-units',
        '--type=service',
        '--state=failed',
        '--plain',
        '--no-legend',
        '--no-pager',
      ],
      {
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SYSTEMD_COLORS: '0', LC_ALL: 'C' },
      },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.resume();
    child.on('close', (code) =>
      resolve({
        stdout: Buffer.concat(chunks).toString('utf-8'),
        exitCode: code ?? 1,
      }),
    );
    child.on('error', () => resolve({ stdout: '', exitCode: 1 }));
  });
}

export function parseFailedServices(stdout: string): Set<string> {
  return new Set(
    stdout.split('\n').flatMap((line) => {
      // --plain removes systemd's bullet. Also tolerate it when reading older
      // output, and reject headers/footers rather than inventing unit names.
      const match = line
        .trim()
        .match(/^(?:●\s+)?([^\s]+\.service)\s+\S+\s+failed\s+failed(?:\s|$)/);
      return match ? [match[1]] : [];
    }),
  );
}

function loadState(now: number): MonitorState {
  const raw = getRouterState(STATE_KEY);
  if (raw) {
    try {
      return stateSchema.parse(JSON.parse(raw));
    } catch (err) {
      logger.warn(
        { err },
        'Uptime monitor: invalid saved state, starting fresh',
      );
    }
  }
  return { failures: {}, recoveries: {}, lastDigestAt: now };
}

// Exposed for regression tests. All incident and digest state lives in SQLite,
// so restarting NanoClaw does not resend alerts or discard pending recoveries.
export async function checkServices(deps: UptimeMonitorDeps): Promise<void> {
  const { stdout, exitCode } = await runCommand();
  if (exitCode !== 0) {
    logger.warn(
      { exitCode },
      'Uptime monitor: systemctl failed; retaining incident state',
    );
    return;
  }
  const currentFailures = parseFailedServices(stdout);
  const now = Date.now();
  const state = loadState(now);
  const mainJid = Object.entries(deps.registeredGroups()).find(
    ([, g]) => g.isMain,
  )?.[0];

  for (const unit of currentFailures) {
    const failure = state.failures[unit];
    if (!failure) {
      state.failures[unit] = {
        firstSeenAt: now,
        lastSeenAt: now,
        alerted: false,
      };
      continue;
    }
    // After a long monitoring gap, require a fresh confirming observation.
    const consecutive = now - failure.lastSeenAt <= INTERVAL_MS * 2;
    failure.lastSeenAt = now;
    if (!consecutive && !failure.alerted) failure.firstSeenAt = now;
    if (failure.alerted || !mainJid || now - failure.firstSeenAt < INTERVAL_MS)
      continue;

    const quotedUnit = `'${unit.replace(/'/g, "'\\''")}'`;
    const minutes = Math.floor((now - failure.firstSeenAt) / 60_000);
    const msg =
      `*[ACTION NEEDED] User service failed: ${unit}*\nHost: ${hostname()}\n` +
      `Impact: This background service is stopped; features depending on it may be unavailable.\n` +
      `Observed failed for at least ${minutes} minutes.\n` +
      `Recovery: This monitor has not attempted a restart.\n\n` +
      `Inspect on ${hostname()}:\n\`systemctl --user status ${quotedUnit}\`\n` +
      `\`journalctl --user -u ${quotedUnit} -n 50\`\n` +
      `After checking the cause, restart with:\n\`systemctl --user restart ${quotedUnit}\``;
    try {
      if (deps.notificationBatcher)
        await deps.notificationBatcher.send(mainJid, msg, 'error');
      else await deps.sendMessage(mainJid, msg);
      failure.alerted = true;
      logger.warn(
        { unit },
        'Uptime monitor: confirmed service failure, alerted owner',
      );
    } catch (err) {
      logger.error(
        { err, unit },
        'Uptime monitor: failed to send alert; will retry',
      );
    }
  }

  for (const unit of Object.keys(state.failures)) {
    if (currentFailures.has(unit)) continue;
    delete state.failures[unit];
    // A count per unit bounds storage, even if a service flaps frequently.
    state.recoveries[unit] = (state.recoveries[unit] ?? 0) + 1;
    logger.info(
      { unit },
      'Uptime monitor: service recovered, queued for daily summary',
    );
  }

  // Persist before delivery so a failed digest send can be retried after restart.
  setRouterState(STATE_KEY, JSON.stringify(state));
  if (now - state.lastDigestAt < DIGEST_INTERVAL_MS || !mainJid) return;
  const entries = Object.entries(state.recoveries).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length) {
    const details = entries
      .slice(0, MAX_DIGEST_UNITS)
      .map(
        ([unit, count]) =>
          `• ${unit}: ${count} ${count === 1 ? 'recovery' : 'recoveries'}${currentFailures.has(unit) ? ' (currently failed again)' : ''}`,
      );
    if (entries.length > MAX_DIGEST_UNITS)
      details.push(`• ${entries.length - MAX_DIGEST_UNITS} more services`);
    const msg =
      `*Daily service recovery summary — ${hostname()}*\n` +
      `Recovered since ${new Date(state.lastDigestAt).toISOString()}:\n${details.join('\n')}\n\n` +
      `No action is needed for recovered services. Current confirmed failures are alerted separately.`;
    // Deliver directly: this is already the daily batch, and successful delivery
    // must be known before its durable queue is cleared.
    await deps.sendMessage(mainJid, msg);
  }
  state.recoveries = {};
  state.lastDigestAt = now;
  setRouterState(STATE_KEY, JSON.stringify(state));
}

let pollHandle: ReturnType<typeof setTimeout> | null = null;

export function startUptimeMonitor(deps: UptimeMonitorDeps): void {
  stopUptimeMonitor();
  logger.info({ intervalMs: INTERVAL_MS }, 'Uptime monitor started');
  const poll = async () => {
    try {
      await checkServices(deps);
    } catch (err) {
      logger.error({ err }, 'Uptime monitor: unexpected error');
    }
    // Schedule after completion to prevent overlapping polls and digest sends.
    if (pollHandle) pollHandle = setTimeout(poll, INTERVAL_MS);
  };
  pollHandle = setTimeout(poll, INTERVAL_MS);
}

export function stopUptimeMonitor(): void {
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
    logger.info('Uptime monitor stopped');
  }
}
