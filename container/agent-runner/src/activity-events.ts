/**
 * Container-side helper for the structured activity-event stream.
 *
 * Writes rows into outbound.db's `tool_call_events` table. The host reads
 * them (read-only) for the `/activity` command. All writes are best-effort:
 * if the DB call throws, we log to stderr and return — the agent must never
 * crash because instrumentation failed.
 *
 * Three event types share the table:
 *   - tool_call_start    written by PreToolUse  (one per tool invocation)
 *   - tool_call_complete written by PostToolUse (one per tool invocation)
 *   - decision           written by the runtime at meaningful branch points
 *
 * Lives in its own file so future qwibitai/nanoclaw rebases don't conflict
 * on the provider/poll-loop hot paths.
 */
import { getOutboundDb } from './db/connection.js';
import { writeMessageOut } from './db/messages-out.js';

function log(msg: string): void {
  console.error(`[activity-events] ${msg}`);
}

export type ActivityEventType = 'tool_call_start' | 'tool_call_complete' | 'decision';

export interface ActivityEventInput {
  eventType: ActivityEventType;
  toolName: string | null;
  /** Free-form JSON payload — caller is responsible for sanitizing. */
  payload?: Record<string, unknown> | null;
  /** ISO timestamp; defaults to now. Used by tool_call_complete to backfill the start time. */
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number | null;
  error?: string | null;
}

/**
 * Keys whose values must be redacted whenever they appear in a tool input.
 * Match is case-insensitive on the key name; the substring check catches
 * common variants like `x-api-key`, `Authorization`, `Cookie`, `set-cookie`.
 */
const REDACT_KEY_PATTERNS = ['authorization', 'api_key', 'apikey', 'api-key', 'cookie', 'secret', 'password', 'token'];

const REDACTED = '[REDACTED]';
const MAX_PAYLOAD_BYTES = 4096;

export function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Recursively redact sensitive keys from a value. Strings and primitives are
 * returned as-is; arrays are mapped element-wise; objects have matching keys
 * replaced with [REDACTED]. Cycles are not expected in tool inputs (they're
 * always JSON-serializable from the SDK), but we cap recursion depth as
 * defense-in-depth.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[depth-cap]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = shouldRedactKey(k) ? REDACTED : redactSensitive(v, depth + 1);
  }
  return out;
}

/**
 * Serialize a payload to a JSON string suitable for the `tool_input` column,
 * after redaction. Truncates the resulting string to MAX_PAYLOAD_BYTES so a
 * monstrous payload (e.g. a giant Bash output captured in args) can't blow
 * out the row.
 */
export function serializePayload(payload: Record<string, unknown> | null | undefined): string | null {
  if (payload == null) return null;
  let json: string;
  try {
    json = JSON.stringify(redactSensitive(payload));
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
  if (json.length > MAX_PAYLOAD_BYTES) return json.slice(0, MAX_PAYLOAD_BYTES) + '…';
  return json;
}

function generateEventId(): string {
  return `ae-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Single emit point for activity events. Fail-soft: any DB error is logged
 * and swallowed so agent execution continues.
 */
export function emitActivityEvent(input: ActivityEventInput): void {
  try {
    const now = new Date().toISOString();
    const startedAt = input.startedAt ?? now;
    const finishedAt = input.finishedAt ?? startedAt;
    getOutboundDb()
      .prepare(
        `INSERT OR IGNORE INTO tool_call_events
           (id, event_type, tool_name, tool_input, started_at, finished_at, duration_ms, error)
         VALUES ($id, $event_type, $tool_name, $tool_input, $started_at, $finished_at, $duration_ms, $error)`,
      )
      .run({
        $id: generateEventId(),
        $event_type: input.eventType,
        $tool_name: input.toolName ?? null,
        $tool_input: serializePayload(input.payload),
        $started_at: startedAt,
        $finished_at: finishedAt,
        $duration_ms: input.durationMs ?? null,
        $error: input.error ?? null,
      });
  } catch (err) {
    log(`emit failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (shouldAutoStream(input.eventType)) {
    try {
      broadcast(input);
    } catch (err) {
      log(`broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Auto-stream gate. Off by default. Only `tool_call_start` and `decision`
 * events get pushed to chat — `tool_call_complete` is too noisy for an
 * always-on stream and `/activity` already covers the post-hoc view.
 */
function shouldAutoStream(eventType: ActivityEventType): boolean {
  if (process.env.ACTIVITY_AUTO_STREAM !== 'true') return false;
  return eventType === 'tool_call_start' || eventType === 'decision';
}

function broadcast(input: ActivityEventInput): void {
  const text = formatBroadcast(input);
  if (!text) return;
  // Read the session's default reply target so the broadcast lands in the
  // same chat the conversation is happening in. If no routing is configured
  // (e.g. agent-to-agent session), drop silently rather than emit an
  // un-routable message.
  const routing = getOutboundDb()
    .prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1')
    .get() as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  if (!routing?.channel_type || !routing?.platform_id) return;

  writeMessageOut({
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id ?? null,
    content: JSON.stringify({ text }),
  });
}

function formatBroadcast(input: ActivityEventInput): string {
  if (input.eventType === 'tool_call_start') {
    return `🛠️ ${input.toolName ?? 'tool'} starting…`;
  }
  if (input.eventType === 'decision') {
    const name = input.toolName ?? 'decision';
    const detail = input.payload?.summary ? ` — ${String(input.payload.summary)}` : '';
    return `🧭 ${name}${detail}`;
  }
  return '';
}
