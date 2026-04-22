import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  CrashEvent,
  CrashHandlerDeps,
  handleCrashEvent,
} from './crash-handler.js';
import { logger } from './logger.js';

/** Poll interval: check for newly-failed services every 30 seconds. */
const WATCHDOG_INTERVAL_MS = 30_000;

export interface CrashWatchdogDeps extends CrashHandlerDeps {
  /** Override poll interval for testing. */
  intervalMs?: number;
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString('utf-8'),
        exitCode: code ?? 1,
      });
    });
    child.on('error', () => resolve({ stdout: '', exitCode: 1 }));
  });
}

/**
 * Track which units we've already handled crash events for.
 * Prevents duplicate crash handling for the same failure.
 * Cleared when a service recovers so the next failure is handled.
 */
const handledCrashes = new Set<string>();

/**
 * Parse `systemctl --user list-units --state=failed` output into unit names.
 */
export function parseFailedUnits(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => unit && unit.length > 0 && unit.endsWith('.service'));
}

/**
 * Process crash event JSON files written by the OnFailure template service.
 * Each file is read, parsed, dispatched to the crash handler, then deleted.
 */
export async function processCrashEventFiles(
  deps: CrashHandlerDeps,
): Promise<void> {
  const crashEventsDir = path.join(DATA_DIR, 'crash-events');
  if (!fs.existsSync(crashEventsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(crashEventsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = path.join(crashEventsDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as {
        unit?: string;
        timestamp?: string;
        source?: string;
      };

      if (data.unit) {
        // Mark as handled so the polling watchdog doesn't duplicate
        handledCrashes.add(data.unit);

        const event: CrashEvent = {
          unit: data.unit,
          timestamp: data.timestamp || new Date().toISOString(),
          source: 'onfailure',
        };

        logger.info({ unit: data.unit, file }, 'Processing OnFailure event');
        const result = await handleCrashEvent(event, deps);

        if (result.restarted) {
          handledCrashes.delete(data.unit);
        }
      }

      // Delete processed file
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error({ err, file }, 'Failed to process crash event file');
      // Move to a .failed extension to avoid infinite retry
      try {
        fs.renameSync(filePath, filePath + '.failed');
      } catch {
        // Best effort
      }
    }
  }
}

/**
 * Single poll cycle: detect newly-failed services and trigger crash handler.
 * Also processes any OnFailure event files from the crash-events directory.
 */
export async function pollForCrashes(deps: CrashWatchdogDeps): Promise<void> {
  // Process OnFailure event files first (higher priority, more specific)
  await processCrashEventFiles(deps);

  const { stdout } = await runCommand('systemctl', [
    '--user',
    'list-units',
    '--state=failed',
    '--no-legend',
    '--no-pager',
  ]);

  const currentFailures = new Set(parseFailedUnits(stdout));

  // Handle new crashes
  for (const unit of currentFailures) {
    if (!handledCrashes.has(unit)) {
      handledCrashes.add(unit);

      const event: CrashEvent = {
        unit,
        timestamp: new Date().toISOString(),
        source: 'watchdog',
      };

      logger.info({ unit }, 'Crash watchdog: new failure detected');

      try {
        const result = await handleCrashEvent(event, deps);
        logger.info(
          {
            unit,
            restarted: result.restarted,
            notified: result.notified,
            followUpCreated: result.followUpCreated,
          },
          'Crash watchdog: event handled',
        );

        // If restart succeeded, remove from handled so we catch next failure
        if (result.restarted) {
          handledCrashes.delete(unit);
        }
      } catch (err) {
        logger.error({ err, unit }, 'Crash watchdog: failed to handle event');
      }
    }
  }

  // Clear tracking for recovered services
  for (const unit of handledCrashes) {
    if (!currentFailures.has(unit)) {
      handledCrashes.delete(unit);
      logger.info({ unit }, 'Crash watchdog: service recovered, cleared');
    }
  }
}

let pollHandle: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the crash watchdog polling loop.
 * Checks systemctl --user for failed services every 30 seconds (configurable).
 * On new failure: reads logs, attempts restart, sends notification, creates follow-up task.
 */
export function startCrashWatchdog(deps: CrashWatchdogDeps): void {
  const intervalMs = deps.intervalMs ?? WATCHDOG_INTERVAL_MS;

  logger.info({ intervalMs }, 'Crash watchdog started');

  const poll = () => {
    pollForCrashes(deps).catch((err) =>
      logger.error({ err }, 'Crash watchdog: unexpected error'),
    );
    pollHandle = setTimeout(poll, intervalMs);
  };

  // First check after one interval to let services stabilize at startup
  pollHandle = setTimeout(poll, intervalMs);
}

export function stopCrashWatchdog(): void {
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
    logger.info('Crash watchdog stopped');
  }
}

/**
 * Handle an OnFailure event from systemd.
 * Called externally (e.g., by a crash-notify service) via IPC or direct invocation.
 */
export async function handleOnFailureEvent(
  unit: string,
  deps: CrashHandlerDeps,
): Promise<void> {
  // Mark as handled so the watchdog doesn't duplicate
  handledCrashes.add(unit);

  const event: CrashEvent = {
    unit,
    timestamp: new Date().toISOString(),
    source: 'onfailure',
  };

  logger.info({ unit }, 'OnFailure event received');

  const result = await handleCrashEvent(event, deps);

  if (result.restarted) {
    handledCrashes.delete(unit);
  }

  logger.info(
    {
      unit,
      restarted: result.restarted,
      notified: result.notified,
      followUpCreated: result.followUpCreated,
    },
    'OnFailure event handled',
  );
}

/** Reset internal state (for testing). */
export function _resetHandledCrashesForTesting(): void {
  handledCrashes.clear();
}
