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
import { countToolCallEvents } from './db/session-db.js';
import { openOutboundDb } from './session-manager.js';
import { isContainerRunning } from './container-runner.js';
import {
  ActivityEventLogger,
  ACTIVITY_OUTPUT_CAP,
  ACTIVITY_USAGE,
  renderActivityStream,
} from './modules/activity-events/index.js';

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
    return { action: 'respond', text: handleHostCommand(command, text, agentGroupId) };
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

function handleHostCommand(command: string, fullText: string, callingAgentGroupId: string): string {
  switch (command) {
    case '/activity':
      return runActivityCommand(fullText, callingAgentGroupId);
    case '/topology':
      return buildTopologyReport();
    default:
      return `Unknown host command: ${command}`;
  }
}

interface ParsedActivityArgs {
  agent: string;
  sinceMinutes: number;
}

/**
 * Parse `/activity [agent] [minutes]`. Returns null on malformed input
 * (extra args, non-numeric minutes, negative minutes). Calling agent's
 * own name is used when no agent is specified.
 */
export function parseActivityArgs(rest: string[], fallbackAgent: string): ParsedActivityArgs | null {
  if (rest.length > 2) return null;
  let agent = fallbackAgent;
  let minutes = 30;

  if (rest.length === 0) {
    return { agent, sinceMinutes: minutes };
  }

  // Anything looking like a leading-sign number is treated as an
  // attempted-but-malformed minutes argument, not a clever agent name.
  const looksNumeric = (s: string): boolean => /^-?\d+$/.test(s);

  if (rest.length === 1 && looksNumeric(rest[0]!)) {
    const m = Number(rest[0]);
    if (!Number.isFinite(m) || m <= 0) return null;
    return { agent, sinceMinutes: m };
  }

  // Heuristic: first arg is the agent name. Reject obviously bad tokens
  // (leading '-', empty) before accepting it.
  if (rest[0]!.startsWith('-') || rest[0]!.length === 0) return null;
  agent = rest[0]!;

  if (rest.length === 2) {
    if (!looksNumeric(rest[1]!)) return null;
    const m = Number(rest[1]);
    if (!Number.isFinite(m) || m <= 0) return null;
    minutes = m;
  }
  return { agent, sinceMinutes: minutes };
}

function runActivityCommand(fullText: string, callingAgentGroupId: string): string {
  const tokens = fullText.split(/\s+/).filter((t) => t.length > 0);
  const rest = tokens.slice(1); // drop "/activity"

  const callingAgent = getAgentGroup(callingAgentGroupId);
  const fallback = callingAgent?.name ?? callingAgentGroupId;

  const parsed = parseActivityArgs(rest, fallback);
  if (!parsed) return ACTIVITY_USAGE;

  const agentArg = parsed.agent;
  const queryAgent = agentArg.toLowerCase() === 'all' ? '*' : agentArg;
  const sinceMinutes = parsed.sinceMinutes;

  const logger = new ActivityEventLogger(getDb());
  // Pull one extra row so we can detect truncation.
  const fetched = logger.queryRecent(queryAgent, sinceMinutes, ACTIVITY_OUTPUT_CAP + 1);
  const truncated = fetched.length > ACTIVITY_OUTPUT_CAP;
  const rows = truncated ? fetched.slice(0, ACTIVITY_OUTPUT_CAP) : fetched;

  return renderActivityStream(rows, {
    agentLabel: agentArg,
    sinceMinutes,
    totalAvailable: truncated ? fetched.length : rows.length,
  });
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
