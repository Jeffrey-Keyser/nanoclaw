import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { createCorrelationLogger } from './logger.js';
import type { NotificationBatcher } from './notification-batcher.js';
import type { RegisteredGroup } from './types.js';

export interface CrashEvent {
  unit: string;
  timestamp: string;
  source: 'watchdog' | 'onfailure';
}

export interface CrashHandlerDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  notificationBatcher?: NotificationBatcher;
  /** Emit a follow-up task via IPC when restart fails. */
  emitFollowUpTask?: (unit: string, logs: string) => void;
}

export interface CrashHandlerResult {
  unit: string;
  logs: string;
  restarted: boolean;
  notified: boolean;
  followUpCreated: boolean;
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
 * Find the main group JID for sending crash notifications.
 */
function findMainJid(
  deps: CrashHandlerDeps,
): { jid: string; folder: string } | null {
  const groups = deps.registeredGroups();
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) return { jid, folder: group.folder };
  }
  return null;
}

/**
 * Read recent journal logs for a failed service unit.
 */
export async function readServiceLogs(unit: string): Promise<string> {
  const { stdout } = await runCommand('journalctl', [
    '--user',
    '-n',
    '40',
    '-u',
    unit,
    '--no-pager',
    '--output=short',
  ]);
  return stdout.trim() || '(no journal output)';
}

/**
 * Attempt to restart a failed systemd user service.
 * Returns true if the service is active after the restart attempt.
 */
export async function restartService(unit: string): Promise<boolean> {
  const log = createCorrelationLogger(undefined, {
    op: 'crash-handler',
    unit,
  });

  const { exitCode } = await runCommand('systemctl', [
    '--user',
    'restart',
    unit,
  ]);

  if (exitCode !== 0) {
    log.warn({ unit, exitCode }, 'systemctl restart returned non-zero');
    return false;
  }

  // Wait briefly for the service to stabilize
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check if it's actually running now
  const { exitCode: checkCode } = await runCommand('systemctl', [
    '--user',
    'is-active',
    unit,
  ]);

  const active = checkCode === 0;
  log.info({ unit, active }, 'Restart attempt result');
  return active;
}

/**
 * Handle a service crash event end-to-end:
 * 1. Read logs from the failed service
 * 2. Attempt restart
 * 3. Send Telegram notification
 * 4. Create follow-up task if restart fails
 */
export async function handleCrashEvent(
  event: CrashEvent,
  deps: CrashHandlerDeps,
): Promise<CrashHandlerResult> {
  const log = createCorrelationLogger(undefined, {
    op: 'crash-handler',
    unit: event.unit,
    source: event.source,
  });

  const result: CrashHandlerResult = {
    unit: event.unit,
    logs: '',
    restarted: false,
    notified: false,
    followUpCreated: false,
  };

  // 1. Read logs
  log.info('Reading journal logs for crashed service');
  result.logs = await readServiceLogs(event.unit);
  const logTail = result.logs.slice(-1500);

  // 2. Attempt restart
  log.info('Attempting service restart');
  result.restarted = await restartService(event.unit);

  // 3. Send notification
  const main = findMainJid(deps);
  if (main) {
    const status = result.restarted ? 'restarted' : 'RESTART FAILED';
    const emoji = result.restarted ? '🔄' : '🔴';
    const msg = [
      `${emoji} *[CRASH] ${event.unit}* — ${status}`,
      '',
      `Source: ${event.source}`,
      `Time: ${event.timestamp}`,
      '',
      '```',
      logTail,
      '```',
    ].join('\n');

    try {
      if (deps.notificationBatcher) {
        const severity = result.restarted ? 'warning' : 'error';
        await deps.notificationBatcher.send(main.jid, msg, severity);
      } else {
        await deps.sendMessage(main.jid, msg);
      }
      result.notified = true;
      log.info({ restarted: result.restarted }, 'Crash notification sent');
    } catch (err) {
      log.error({ err }, 'Failed to send crash notification');
    }
  } else {
    log.warn('No main group registered — cannot send crash notification');
  }

  // 4. Create follow-up task if restart failed
  if (!result.restarted && deps.emitFollowUpTask) {
    try {
      deps.emitFollowUpTask(event.unit, logTail);
      result.followUpCreated = true;
      log.info('Follow-up task created for failed restart');
    } catch (err) {
      log.error({ err }, 'Failed to create follow-up task');
    }
  }

  return result;
}

/**
 * Emit a follow-up task as a JSON file in the main group's IPC tasks directory.
 * This triggers the ops-agent to investigate the crash further.
 */
export function createFollowUpTaskEmitter(
  mainGroupFolder: string,
): (unit: string, logs: string) => void {
  return (unit: string, logs: string) => {
    const tasksDir = path.join(DATA_DIR, 'ipc', mainGroupFolder, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });

    const task = {
      type: 'schedule_task',
      prompt: [
        `Investigate crash of systemd service "${unit}". `,
        'The automatic restart failed. ',
        'Check the service status, recent logs, and resource usage. ',
        'Determine root cause and fix the issue or escalate.\n\n',
        'Recent logs:\n```\n',
        logs.slice(-800),
        '\n```',
      ].join(''),
      schedule_type: 'once',
      schedule_value: new Date(Date.now() + 30_000).toISOString(),
      context_mode: 'group',
      targetJid: '__self__',
    };

    const filename = `crash-followup-${unit.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(tasksDir, filename),
      JSON.stringify(task, null, 2),
    );
  };
}
