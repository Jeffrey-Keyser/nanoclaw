/**
 * Crash Handler — automated service crash recovery workflow.
 *
 * Five-step workflow:
 *   1. Read logs via `journalctl --user -u <service> --since "5 minutes ago"`
 *   2. Extract error messages and stack traces
 *   3. Attempt restart via `systemctl --user restart <service>`
 *   4. Send Telegram notification with crash summary and restart status
 *   5. Create follow-up task in Agency HQ if restart fails
 */
import { spawn } from 'child_process';

import { agencyFetch } from './agency-hq-client.js';
import { createCorrelationLogger, logger } from './logger.js';
import type { NotificationBatcher } from './notification-batcher.js';
import { RegisteredGroup } from './types.js';

// --- Config ---

const POLL_INTERVAL_MS = parseInt(
  process.env.CRASH_HANDLER_INTERVAL_MS || '60000',
  10,
);
const LOG_WINDOW = process.env.CRASH_HANDLER_LOG_WINDOW || '5 minutes ago';
const COMMAND_TIMEOUT_MS = 15_000;

// --- Types ---

export interface CrashHandlerDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  notificationBatcher?: NotificationBatcher;
}

export interface CrashEvent {
  service: string;
  errorSummary: string;
  logTail: string;
  restartAttempted: boolean;
  restartSuccess: boolean;
  timestamp: string;
  followUpTaskId?: string;
}

// --- Command execution ---

export function runCommand(
  command: string,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code ?? 1,
      });
    });
    child.on('error', (err) => {
      logger.debug({ err, command, args }, 'Command spawn error');
      resolve({ stdout: '', stderr: '', exitCode: 1 });
    });
  });
}

// --- Step 1: Read service logs ---

export async function readServiceLogs(service: string): Promise<string> {
  const { stdout, stderr } = await runCommand('journalctl', [
    '--user',
    '-u',
    service,
    '--since',
    LOG_WINDOW,
    '--no-pager',
    '--output=short',
  ]);
  // Include stderr in output if stdout is empty (journalctl may write errors there)
  const combined = stdout.trim() || stderr.trim();
  return combined;
}

// --- Step 2: Extract error messages and stack traces ---

/**
 * Extract error lines, stack traces, and crash-relevant output from journal logs.
 * Returns a concise summary suitable for Telegram notifications.
 */
export function extractErrors(logs: string): string {
  if (!logs) return '(no log output)';

  const lines = logs.split('\n');
  const errorLines: string[] = [];

  // Match common crash indicators across Node.js, Java, Python, and system signals
  const errorPattern =
    /\b(error|Error|ERROR|exception|Exception|EXCEPTION|fatal|Fatal|FATAL|panic|segfault|SIGABRT|SIGSEGV|SIGTERM|SIGKILL|killed|OOM|out of memory|unhandled|uncaught|UnhandledPromiseRejection|TypeError|ReferenceError|SyntaxError|RangeError|EvalError)\b/;

  // Match stack trace continuation lines.
  // Journal lines carry a prefix (e.g. "Apr 20 host svc[1]:") so we look for
  // "at " preceded by whitespace anywhere in the line, not just at the start.
  const stackPattern = /\s+at\s+\S|Caused by:|\.{3}\s\d+\smore|\s+\^$/;

  let inStack = false;
  for (const line of lines) {
    if (errorPattern.test(line)) {
      errorLines.push(line.trim());
      inStack = true;
    } else if (inStack && stackPattern.test(line)) {
      errorLines.push(line.trim());
    } else {
      inStack = false;
    }
  }

  if (errorLines.length === 0) {
    // Fall back to last 10 lines if no recognizable errors found
    const tail = lines.slice(-10).join('\n').trim();
    return tail || '(no recognizable errors found)';
  }

  // Limit to ~1500 chars for Telegram readability
  const joined = errorLines.join('\n');
  if (joined.length > 1500) {
    return joined.slice(0, 1497) + '...';
  }
  return joined;
}

// --- Step 3: Attempt service restart ---

export async function restartService(
  service: string,
): Promise<{ success: boolean; output: string }> {
  const { stdout, stderr, exitCode } = await runCommand('systemctl', [
    '--user',
    'restart',
    service,
  ]);
  return {
    success: exitCode === 0,
    output: (stdout + stderr).trim(),
  };
}

// --- Step 4: Send Telegram notification ---

export function formatCrashNotification(event: CrashEvent): string {
  const status = event.restartSuccess ? 'RECOVERED' : 'RESTART FAILED';
  const emoji = event.restartSuccess ? '\u2705' : '\u274C';

  const lines: string[] = [
    `*[${status}] Service crash: ${event.service}*`,
    '',
    `${emoji} *Restart:* ${event.restartSuccess ? 'Successful' : 'Failed'}`,
    '',
    '*Error summary:*',
    '```',
    event.errorSummary.slice(0, 800),
    '```',
  ];

  if (!event.restartSuccess) {
    if (event.followUpTaskId) {
      lines.push(
        '',
        `_Follow-up task created in Agency HQ: \`${event.followUpTaskId}\`_`,
      );
    } else {
      lines.push('', '_Follow-up task creation failed._');
    }
  }

  return lines.join('\n');
}

// --- Step 5: Create follow-up task in Agency HQ ---

export async function createFollowUpTask(
  service: string,
  errorSummary: string,
): Promise<string | null> {
  try {
    const res = await agencyFetch('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: `Investigate crash: ${service}`,
        description: [
          `Service \`${service}\` crashed and automatic restart failed.`,
          '',
          'Error summary:',
          '```',
          errorSummary.slice(0, 2000),
          '```',
          '',
          'Steps needed:',
          '1. Check full journal logs: `journalctl --user -u ' +
            service +
            ' --since "1 hour ago"`',
          '2. Identify root cause',
          '3. Fix and restart the service',
          '4. Verify the service is stable',
        ].join('\n'),
        acceptance_criteria: [
          `- Service \`${service}\` is running and stable`,
          '- Root cause identified and documented',
          '- Fix applied or workaround in place',
        ].join('\n'),
        status: 'ready',
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body, service },
        'Failed to create follow-up task in Agency HQ',
      );
      return null;
    }

    const json = (await res.json()) as {
      success: boolean;
      data?: { id: string };
    };
    return json.data?.id ?? null;
  } catch (err) {
    logger.error({ err, service }, 'Error creating follow-up task');
    return null;
  }
}

// --- Orchestrator: full crash handling workflow ---

function findMainJid(
  deps: CrashHandlerDeps,
): { jid: string; folder: string } | null {
  const groups = deps.registeredGroups();
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) return { jid, folder: group.folder };
  }
  return null;
}

export async function handleServiceCrash(
  service: string,
  deps: CrashHandlerDeps,
): Promise<CrashEvent> {
  const log = createCorrelationLogger(undefined, {
    op: 'crash-handler',
    service,
  });

  log.info('Starting crash recovery workflow');

  // Step 1: Read logs
  const logs = await readServiceLogs(service);
  log.debug({ logLength: logs.length }, 'Service logs read');

  // Step 2: Extract errors
  const errorSummary = extractErrors(logs);
  log.info({ errorSummary: errorSummary.slice(0, 200) }, 'Errors extracted');

  // Step 3: Attempt restart
  const restart = await restartService(service);
  log.info(
    { restartSuccess: restart.success, output: restart.output },
    'Restart attempted',
  );

  const event: CrashEvent = {
    service,
    errorSummary,
    logTail: logs.slice(-2000),
    restartAttempted: true,
    restartSuccess: restart.success,
    timestamp: new Date().toISOString(),
  };

  // Step 5: Create follow-up task if restart failed (before notification so we can include task ID)
  if (!restart.success) {
    const taskId = await createFollowUpTask(service, errorSummary);
    if (taskId) {
      event.followUpTaskId = taskId;
      log.info({ taskId }, 'Follow-up task created in Agency HQ');
    } else {
      log.error('Failed to create follow-up task');
    }
  }

  // Step 4: Send Telegram notification (after task creation so ID is available)
  const target = findMainJid(deps);
  if (target) {
    const message = formatCrashNotification(event);
    try {
      if (deps.notificationBatcher) {
        const severity = restart.success ? 'warning' : 'error';
        await deps.notificationBatcher.send(target.jid, message, severity);
      } else {
        await deps.sendMessage(target.jid, message);
      }
      log.info('Crash notification sent');
    } catch (err) {
      log.error({ err }, 'Failed to send crash notification');
    }
  } else {
    log.warn('No main group registered, cannot send crash notification');
  }

  return event;
}

// --- Polling-based crash detection ---

const handledCrashes = new Set<string>();
let pollHandle: ReturnType<typeof setTimeout> | null = null;

async function detectAndHandleCrashes(deps: CrashHandlerDeps): Promise<void> {
  const { stdout } = await runCommand('systemctl', [
    '--user',
    'list-units',
    '--state=failed',
    '--no-legend',
    '--no-pager',
  ]);

  const failedUnits = stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => unit && unit.length > 0);

  for (const unit of failedUnits) {
    if (!handledCrashes.has(unit)) {
      handledCrashes.add(unit);
      try {
        await handleServiceCrash(unit, deps);
      } catch (err) {
        logger.error({ err, unit }, 'Crash handler: unexpected error');
      }
    }
  }

  // Clear recovered services from tracking
  for (const unit of handledCrashes) {
    if (!failedUnits.includes(unit)) {
      handledCrashes.delete(unit);
    }
  }
}

// --- Lifecycle ---

export function startCrashHandler(deps: CrashHandlerDeps): void {
  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'Crash handler started');

  const poll = () => {
    detectAndHandleCrashes(deps).catch((err) =>
      logger.error({ err }, 'Crash handler: poll cycle error'),
    );
    pollHandle = setTimeout(poll, POLL_INTERVAL_MS);
  };

  // First check after one interval to let channels connect first
  pollHandle = setTimeout(poll, POLL_INTERVAL_MS);
}

export function stopCrashHandler(): void {
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
    logger.info('Crash handler stopped');
  }
}

/** @internal — reset in-memory state for testing */
export function _resetForTesting(): void {
  handledCrashes.clear();
  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
  }
}
