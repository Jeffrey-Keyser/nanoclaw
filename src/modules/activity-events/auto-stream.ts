/**
 * Auto-stream toggle: push selected activity events to a configured
 * operator chat as separate messages, in near-real-time.
 *
 * Configuration (env, since NanoClaw doesn't ship a YAML config layer):
 *   NANOCLAW_ACTIVITY_AUTO_TELEGRAM=true   — turn on
 *   NANOCLAW_ACTIVITY_OPERATOR_CHAT=<chan>:<platform_id>[:<thread_id>]
 *      Example:  telegram:123456789
 *      Example:  slack:C0123:thread-1.0
 *
 * Throttling: at most one push per 2s per agent — keeps a chatty agent from
 * flooding the operator chat during a tool-heavy turn.
 *
 * Filtering: only `tool_call_start` (with the bulk of tools the agent
 * actually invokes) and `decision` events are forwarded. Skipped:
 *   - `tool_call_complete` (the start already announced what's happening)
 *   - `reasoning_step` (volume + low signal)
 *   - tool_call_start for tools in TRIVIAL_TOOLS (Read/Glob/Grep noise)
 */
import type { ChannelAdapter } from '../../channels/adapter.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';
import type { ActivityEventRow } from './logger.js';

const TRIVIAL_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'TaskOutput']);
export const PER_AGENT_THROTTLE_MS = 2000;

export interface OperatorChatTarget {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export function parseOperatorChat(spec: string | undefined | null): OperatorChatTarget | null {
  if (!spec) return null;
  const parts = spec.split(':');
  if (parts.length < 2) return null;
  const channelType = parts[0]!.trim();
  const platformId = parts[1]!.trim();
  if (!channelType || !platformId) return null;
  const threadId = parts.length >= 3 && parts[2] ? parts[2]!.trim() : null;
  return { channelType, platformId, threadId };
}

export function isAutoStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.NANOCLAW_ACTIVITY_AUTO_TELEGRAM ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function getOperatorChat(env: NodeJS.ProcessEnv = process.env): OperatorChatTarget | null {
  return parseOperatorChat(env.NANOCLAW_ACTIVITY_OPERATOR_CHAT);
}

/**
 * Decide whether `row` is a "major" event worth surfacing. Pure for
 * testability — no I/O, no time.
 */
export function isMajorEvent(row: ActivityEventRow): boolean {
  if (row.event_type === 'decision') return true;
  if (row.event_type === 'tool_call_start') {
    if (!row.tool_name) return false;
    return !TRIVIAL_TOOLS.has(row.tool_name);
  }
  return false;
}

function formatLine(row: ActivityEventRow): string {
  const ts = new Date(row.timestamp).toISOString().slice(11, 19); // HH:MM:SS
  const tag = row.event_type === 'decision' ? '🔀' : '🔧';
  const what = row.tool_name ?? extractDecisionLabel(row.payload);
  return `${tag} ${ts} [${row.agent}] ${row.event_type}: ${what}`;
}

function extractDecisionLabel(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (typeof parsed.summary === 'string') return parsed.summary;
    if (typeof parsed.label === 'string') return parsed.label;
    if (typeof parsed.choice === 'string') return parsed.choice;
  } catch {
    /* fall through */
  }
  return payload.length > 80 ? payload.slice(0, 79) + '…' : payload;
}

/**
 * Throttle gate keyed by agent. Stateless caller, stateful instance —
 * orchestration creates one of these on startup and feeds events through it.
 */
export class AutoStreamPublisher {
  private lastPushAtPerAgent = new Map<string, number>();
  private readonly throttleMs: number;

  constructor(throttleMs: number = PER_AGENT_THROTTLE_MS) {
    this.throttleMs = throttleMs;
  }

  /**
   * Returns true if the event should be pushed right now (records the
   * timestamp); false if it should be skipped due to throttle.
   */
  shouldPush(agent: string, now: number = Date.now()): boolean {
    const last = this.lastPushAtPerAgent.get(agent) ?? 0;
    if (now - last < this.throttleMs) return false;
    this.lastPushAtPerAgent.set(agent, now);
    return true;
  }

  /** For test cleanup. */
  reset(): void {
    this.lastPushAtPerAgent.clear();
  }
}

interface PushDeps {
  publisher: AutoStreamPublisher;
  target: OperatorChatTarget | null;
  /** Override the adapter lookup in tests. */
  resolveAdapter?: (channelType: string) => ChannelAdapter | undefined;
  /** Override the clock in tests. */
  now?: () => number;
}

/**
 * Publish a single event to the operator chat if all gates pass:
 *  - auto-stream enabled (caller decides)
 *  - target configured
 *  - event is "major"
 *  - per-agent throttle window has elapsed
 */
export async function publishEventIfMajor(row: ActivityEventRow, deps: PushDeps): Promise<boolean> {
  if (!deps.target) return false;
  if (!isMajorEvent(row)) return false;
  if (!deps.publisher.shouldPush(row.agent, deps.now ? deps.now() : undefined)) return false;

  const adapter = (deps.resolveAdapter ?? getChannelAdapter)(deps.target.channelType);
  if (!adapter) {
    log.warn('activity auto-stream: no adapter for operator chat', {
      channelType: deps.target.channelType,
    });
    return false;
  }

  try {
    await adapter.deliver(deps.target.platformId, deps.target.threadId, {
      kind: 'chat',
      content: { text: formatLine(row) },
    });
    return true;
  } catch (err) {
    log.warn('activity auto-stream: deliver failed (swallowed)', {
      channelType: deps.target.channelType,
      err,
    });
    return false;
  }
}
