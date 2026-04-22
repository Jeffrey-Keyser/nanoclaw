/**
 * Ops-Agent Dispatch Watchdog
 *
 * Periodically checks for stuck dispatch slots — slots in 'executing' state
 * with no corresponding tmux session. When detected, restarts NanoClaw via
 * systemctl so that stale slot recovery (recoverStaleSlots) can clean up on
 * the next boot.
 *
 * Runs as a subsystem alongside the stall detector and dispatch loop.
 * Default interval: 15 minutes.
 */

import { execSync } from 'child_process';

import { agencyFetch } from './agency-hq-client.js';
import { getDispatchSlotBackend } from './dispatch-slot-backends.js';
import { createCorrelationLogger, logger } from './logger.js';
import { getAgentRuntime } from './runtime-adapter.js';
import type { NotificationBatcher } from './notification-batcher.js';
import type { SchedulerDependencies } from './task-scheduler.js';

export const OPS_AGENT_WATCHDOG_INTERVAL = 15 * 60_000; // 15 minutes

/** Minimum slot executing age (ms) before considering it stuck. Avoids false positives on freshly-claimed slots. */
const MIN_EXECUTING_AGE_MS = 3 * 60_000; // 3 minutes

/** Cooldown after a restart to avoid restart loops. */
const RESTART_COOLDOWN_MS = 20 * 60_000; // 20 minutes

let lastRestartTimestamp = 0;

// --- Core detection ---

export interface StuckSlotInfo {
  slotId: number;
  slotIndex: number;
  ahqTaskId: string;
  state: string;
}

/**
 * Detect stuck dispatch slots: slots in 'executing' state with no
 * corresponding tmux session running.
 *
 * A slot is considered stuck when:
 * 1. It is in 'executing' (or 'acquiring'/'releasing') state
 * 2. No tmux sessions with the `nanoclaw-` prefix exist at all
 * 3. The slot has been executing for at least MIN_EXECUTING_AGE_MS
 *
 * Returns the list of stuck slots, or empty if everything is healthy.
 */
export async function detectStuckSlots(): Promise<StuckSlotInfo[]> {
  const log = createCorrelationLogger(undefined, { op: 'ops-watchdog' });

  let activeSlots;
  try {
    activeSlots = await getDispatchSlotBackend().listActiveSlots();
  } catch (err) {
    log.error({ err }, 'Failed to query active dispatch slots');
    return [];
  }

  if (activeSlots.length === 0) return [];

  // Check if any nanoclaw tmux sessions exist
  let activeSessions: string[];
  try {
    activeSessions = getAgentRuntime().listSessionNames('nanoclaw-');
  } catch (err) {
    log.warn({ err }, 'Failed to list tmux sessions');
    // If we can't check tmux, don't trigger a false positive
    return [];
  }

  // If tmux sessions exist, the workers are alive — no stuck slots
  if (activeSessions.length > 0) return [];

  // No tmux sessions but active slots exist — filter to executing slots
  // that have been active long enough to rule out race conditions
  const stuckSlots: StuckSlotInfo[] = [];
  for (const slot of activeSlots) {
    if (slot.state !== 'executing') continue;
    stuckSlots.push({
      slotId: slot.slotId,
      slotIndex: slot.slotIndex,
      ahqTaskId: slot.ahqTaskId,
      state: slot.state,
    });
  }

  if (stuckSlots.length > 0) {
    log.warn(
      {
        stuckCount: stuckSlots.length,
        activeSessions: activeSessions.length,
        slots: stuckSlots.map((s) => ({
          slotIndex: s.slotIndex,
          ahqTaskId: s.ahqTaskId,
        })),
      },
      'Detected stuck dispatch slots (executing with no tmux session)',
    );
  }

  return stuckSlots;
}

// --- Recovery action ---

/**
 * Restart NanoClaw via systemctl to trigger stale slot recovery on next boot.
 * Returns true if the restart was initiated successfully.
 */
export function restartNanoClaw(): boolean {
  const log = createCorrelationLogger(undefined, {
    op: 'ops-watchdog-restart',
  });

  // Cooldown check — avoid restart loops
  const now = Date.now();
  if (now - lastRestartTimestamp < RESTART_COOLDOWN_MS) {
    log.warn(
      {
        lastRestart: new Date(lastRestartTimestamp).toISOString(),
        cooldownMs: RESTART_COOLDOWN_MS,
      },
      'Restart cooldown active, skipping restart',
    );
    return false;
  }

  try {
    execSync('systemctl --user restart nanoclaw', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    lastRestartTimestamp = now;
    log.info('NanoClaw restart initiated via systemctl');
    return true;
  } catch (err) {
    log.error({ err }, 'Failed to restart NanoClaw via systemctl');
    return false;
  }
}

// --- Recovery logging ---

/**
 * Log the recovery action to Agency HQ via the notifications endpoint.
 */
async function logRecoveryToAgencyHq(
  stuckSlots: StuckSlotInfo[],
  log: ReturnType<typeof createCorrelationLogger>,
): Promise<void> {
  try {
    await agencyFetch('/notifications', {
      method: 'POST',
      body: JSON.stringify({
        type: 'dispatch-watchdog-recovery',
        title: `Ops watchdog: restarted NanoClaw — ${stuckSlots.length} stuck slot(s) detected`,
        target: 'ceo',
        channel: 'telegram',
        reference_type: 'system',
        reference_id: `watchdog-${Date.now()}`,
        metadata: {
          stuck_slots: stuckSlots.map((s) => ({
            slot_index: s.slotIndex,
            ahq_task_id: s.ahqTaskId,
          })),
          timestamp: new Date().toISOString(),
        },
      }),
    });
  } catch (err) {
    log.error({ err }, 'Failed to log recovery to Agency HQ');
  }
}

// --- Notification ---

/**
 * Find the CEO group JID for sending watchdog notifications.
 */
function findCeoJid(
  deps: SchedulerDependencies,
): { jid: string; folder: string } | null {
  const groups = deps.registeredGroups();
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === 'ceo') return { jid, folder: group.folder };
  }
  return null;
}

// --- Main tick ---

/**
 * Single watchdog tick: detect stuck slots and recover if needed.
 * Exported for testing.
 */
export async function runWatchdogTick(
  deps: SchedulerDependencies,
  isStopping: () => boolean,
  notificationBatcher?: NotificationBatcher,
): Promise<void> {
  if (isStopping()) return;

  const log = createCorrelationLogger(undefined, { op: 'ops-watchdog' });

  const stuckSlots = await detectStuckSlots();
  if (stuckSlots.length === 0) return;

  log.warn(
    { count: stuckSlots.length },
    'Stuck dispatch slots detected, initiating recovery',
  );

  // Send Telegram notification before restart (restart kills this process)
  const ceo = findCeoJid(deps);
  if (ceo) {
    const slotDetails = stuckSlots
      .map((s) => `slot ${s.slotIndex} (task: ${s.ahqTaskId})`)
      .join(', ');
    const msg = `🔧 *Ops Watchdog Recovery*\nDetected ${stuckSlots.length} stuck dispatch slot(s): ${slotDetails}\nRestarting NanoClaw to trigger slot recovery.`;
    try {
      if (notificationBatcher) {
        await notificationBatcher.send(ceo.jid, msg, 'critical');
      } else {
        await deps.sendMessage(ceo.jid, msg);
      }
    } catch (err) {
      log.error({ err }, 'Failed to send watchdog notification');
    }
  }

  // Log to Agency HQ
  await logRecoveryToAgencyHq(stuckSlots, log);

  // Restart NanoClaw
  const restarted = restartNanoClaw();

  if (!restarted) {
    log.error('Recovery restart failed or on cooldown — stuck slots remain');
  }
}

// --- Lifecycle ---

let watchdogIntervalHandle: ReturnType<typeof setInterval> | null = null;

export function startOpsAgentWatchdog(
  deps: SchedulerDependencies,
  isStopping: () => boolean,
  notificationBatcher?: NotificationBatcher,
): void {
  logger.info(
    { intervalMs: OPS_AGENT_WATCHDOG_INTERVAL },
    'Starting ops-agent dispatch watchdog',
  );

  watchdogIntervalHandle = setInterval(() => {
    runWatchdogTick(deps, isStopping, notificationBatcher).catch((err) =>
      logger.error({ err }, 'Ops watchdog tick failed'),
    );
  }, OPS_AGENT_WATCHDOG_INTERVAL);
}

export function stopOpsAgentWatchdog(): void {
  if (watchdogIntervalHandle) {
    clearInterval(watchdogIntervalHandle);
    watchdogIntervalHandle = null;
  }
}

/** Reset module state (for testing). */
export function _resetWatchdogState(): void {
  lastRestartTimestamp = 0;
  stopOpsAgentWatchdog();
}
