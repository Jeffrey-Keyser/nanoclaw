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
import { countToolCallEvents, getToolCallEvents } from './db/session-db.js';
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

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (HOST_COMMANDS.has(command)) {
    if (!isAdmin(userId, agentGroupId)) {
      return { action: 'deny', command };
    }
    return { action: 'respond', text: handleHostCommand(command) };
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

function handleHostCommand(command: string): string {
  switch (command) {
    case '/activity':
      return buildActivityReport();
    case '/topology':
      return buildTopologyReport();
    default:
      return `Unknown host command: ${command}`;
  }
}

function buildActivityReport(): string {
  const sessions = getActiveSessions();
  if (sessions.length === 0) return 'No active sessions.';

  const lines: string[] = ['**Agent Activity Report**', ''];

  for (const session of sessions) {
    const agentGroup = getAgentGroup(session.agent_group_id);
    const name = agentGroup?.name ?? session.agent_group_id;

    let outDb;
    try {
      outDb = openOutboundDb(session.agent_group_id, session.id);
    } catch {
      continue;
    }

    try {
      const count = countToolCallEvents(outDb);
      if (count === 0) continue;

      const recent = getToolCallEvents(outDb, 5);
      lines.push(`**${name}** (session: \`${session.id.slice(0, 12)}\`) — ${count} tool calls`);
      for (const ev of recent) {
        const dur = ev.duration_ms != null ? `${ev.duration_ms}ms` : '?';
        const err = ev.error ? ` [error]` : '';
        lines.push(`  • ${ev.tool_name} (${dur})${err} — ${ev.started_at}`);
      }
      lines.push('');
    } finally {
      outDb.close();
    }
  }

  return lines.length <= 2 ? 'No tool call activity recorded yet.' : lines.join('\n');
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
