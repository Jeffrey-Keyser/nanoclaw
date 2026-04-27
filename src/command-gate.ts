/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Host-intercepted commands: admin-gated, then handled host-side
 *   (never reach the container). Response text is returned in the result.
 * - Normal messages: pass through unchanged
 */
import { getDb, hasTable } from './db/connection.js';

import { getActiveSessions } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { countToolCallEvents, getToolCallEvents, type ToolCallEvent } from './db/session-db.js';
import { openOutboundDb } from './session-manager.js';
import { isContainerRunning } from './container-runner.js';

export type GateResult =
  | { action: 'pass' }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'respond'; text: string };

const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files']);

/** Commands intercepted and handled entirely host-side (never reach the container). */
const HOST_COMMANDS = new Set(['/activity', '/topology']);

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands, 'respond' for host-intercepted commands.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (!text.startsWith('/')) return { action: 'pass' };

  const tokens = text.split(/\s+/);
  const command = tokens[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (HOST_COMMANDS.has(command)) {
    if (!isAdmin(userId, agentGroupId)) {
      return { action: 'deny', command };
    }
    return { action: 'respond', text: handleHostCommand(command, tokens.slice(1)) };
  }

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

function isAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}

function handleHostCommand(command: string, args: string[]): string {
  switch (command) {
    case '/activity':
      return buildActivityReport(parseActivityArgs(args));
    case '/topology':
      return buildTopologyReport();
    default:
      return `Unknown host command: ${command}`;
  }
}

const DEFAULT_ACTIVITY_MINUTES = 15;
const MAX_ACTIVITY_MINUTES = 1440;
/** Hard cap on event lines per response — Telegram messages cap at ~4096 chars. */
const MAX_EVENT_LINES = 200;

export interface ActivityArgs {
  /** Optional substring to filter agent group name (case-insensitive). */
  filter: string | null;
  /** Time window in minutes. Always within [1, MAX_ACTIVITY_MINUTES]. */
  minutes: number;
}

/**
 * Parse `/activity` arguments. Accepts:
 *   /activity                   — all sessions, default window
 *   /activity 30                — all sessions, 30-min window
 *   /activity my-agent          — sessions whose name contains "my-agent",
 *                                 default window
 *   /activity my-agent 30       — both
 *
 * Numeric args are clamped to [1, MAX_ACTIVITY_MINUTES] (1440 = one day).
 * The original task spec used `[ceo|ops]` for a role filter; this codebase
 * has agent groups instead of fixed roles, so the filter accepts any
 * substring of the agent group name.
 */
export function parseActivityArgs(args: string[]): ActivityArgs {
  let filter: string | null = null;
  let minutes = DEFAULT_ACTIVITY_MINUTES;

  for (const arg of args) {
    if (!arg) continue;
    const asNum = Number(arg);
    if (Number.isFinite(asNum) && Number.isInteger(asNum)) {
      minutes = Math.max(1, Math.min(MAX_ACTIVITY_MINUTES, asNum));
    } else if (filter === null) {
      filter = arg.toLowerCase();
    }
  }

  return { filter, minutes };
}

function buildActivityReport(args: ActivityArgs): string {
  const { filter, minutes } = args;
  const sessions = getActiveSessions();
  if (sessions.length === 0) {
    return `No active sessions in the last ${minutes}m.`;
  }

  const sinceIso = new Date(Date.now() - minutes * 60_000).toISOString();
  const sections: string[] = [];
  let totalEvents = 0;

  for (const session of sessions) {
    const agentGroup = getAgentGroup(session.agent_group_id);
    const name = agentGroup?.name ?? session.agent_group_id;

    if (filter && !name.toLowerCase().includes(filter)) continue;

    let outDb;
    try {
      outDb = openOutboundDb(session.agent_group_id, session.id);
    } catch {
      continue;
    }

    try {
      const events = getToolCallEvents(outDb, { sinceIso });
      if (events.length === 0) continue;

      const remaining = MAX_EVENT_LINES - totalEvents;
      if (remaining <= 0) {
        sections.push(`(More events truncated — narrow the window or filter to see them.)`);
        break;
      }
      const slice = events.slice(0, remaining);
      totalEvents += slice.length;

      const lines: string[] = [`**${name}** (session: \`${session.id.slice(0, 12)}\`) — ${events.length} event(s)`];
      for (const ev of slice) lines.push(`  • ${formatEvent(ev)}`);
      if (slice.length < events.length) {
        lines.push(`  …(+${events.length - slice.length} more)`);
      }
      sections.push(lines.join('\n'));
    } finally {
      outDb.close();
    }
  }

  if (sections.length === 0) {
    const scope = filter ? ` matching "${filter}"` : '';
    return `No recent activity${scope} in the last ${minutes}m.`;
  }

  return [`**Agent Activity** (last ${minutes}m)`, '', ...sections].join('\n\n').trimEnd();
}

/**
 * Format one event line. Exported for testing the chronological-order +
 * formatting contract without a live DB.
 */
export function formatEvent(ev: ToolCallEvent): string {
  const time = ev.started_at;
  const tool = ev.tool_name ?? 'unknown';
  if (ev.event_type === 'decision') {
    return `[${time}] decision: ${tool}`;
  }
  if (ev.event_type === 'tool_call_start') {
    return `[${time}] start: ${tool}`;
  }
  const dur = ev.duration_ms != null ? ` (${ev.duration_ms}ms)` : '';
  const err = ev.error ? ` [error]` : '';
  return `[${time}] complete: ${tool}${dur}${err}`;
}

function buildTopologyReport(): string {
  const sessions = getActiveSessions();
  if (sessions.length === 0) return 'No active sessions.';

  const lines: string[] = ['**Agent Topology**', ''];

  for (const session of sessions) {
    const agentGroup = getAgentGroup(session.agent_group_id);
    const name = agentGroup?.name ?? session.agent_group_id;
    const running = isContainerRunning(session.id);
    const status = running ? 'running' : session.container_status;

    let toolCount = 0;
    try {
      const outDb = openOutboundDb(session.agent_group_id, session.id);
      try {
        toolCount = countToolCallEvents(outDb);
      } finally {
        outDb.close();
      }
    } catch {
      // outbound.db may not exist yet
    }

    const statusIcon = running ? '[active]' : `[${status}]`;
    lines.push(`${statusIcon} **${name}** — ${toolCount} tool calls — session \`${session.id.slice(0, 12)}\``);
  }

  return lines.join('\n');
}
