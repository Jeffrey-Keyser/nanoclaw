/**
 * Renderer for /activity output. Plain-text Telegram-friendly format —
 * no Markdown nesting that could trip up the platform sanitizers.
 *
 * One line per event:
 *   HH:MM:SS  agent       event_type        label
 * Times in the host TZ. The `label` is the tool name for tool_call_*
 * events, otherwise the first ~80 chars of the payload (single-line).
 */
import type { ActivityEventRow } from './logger.js';

export const ACTIVITY_OUTPUT_CAP = 50;
const LABEL_MAX = 80;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function fmtAgent(agent: string): string {
  return agent.length > 8 ? agent.slice(0, 8) : agent.padEnd(8);
}

function fmtEventType(t: string): string {
  return t.length > 18 ? t.slice(0, 18) : t.padEnd(18);
}

function payloadLabel(row: ActivityEventRow): string {
  if (row.tool_name) return row.tool_name;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    /* fall through to raw */
  }
  let summary: string;
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    if (typeof p.summary === 'string') summary = p.summary;
    else if (typeof p.message === 'string') summary = p.message;
    else if (typeof p.label === 'string') summary = p.label;
    else if (typeof p._preview === 'string') summary = String(p._preview);
    else summary = row.payload;
  } else {
    summary = row.payload;
  }
  // Collapse whitespace to keep one line per event.
  summary = summary.replace(/\s+/g, ' ').trim();
  if (summary.length > LABEL_MAX) summary = summary.slice(0, LABEL_MAX - 1) + '…';
  return summary;
}

export interface RenderOptions {
  agentLabel?: string;
  sinceMinutes?: number;
  /** Total rows that matched the query, before the cap. Lets us mention truncation. */
  totalAvailable?: number;
}

export function renderActivityStream(rows: ActivityEventRow[], opts: RenderOptions = {}): string {
  const header: string[] = [];
  const scopeBits: string[] = [];
  if (opts.agentLabel) scopeBits.push(opts.agentLabel);
  if (typeof opts.sinceMinutes === 'number') scopeBits.push(`last ${opts.sinceMinutes}m`);
  header.push(`Activity stream${scopeBits.length ? ' — ' + scopeBits.join(', ') : ''}`);

  if (rows.length === 0) {
    header.push('(no events)');
    return header.join('\n');
  }

  const lines: string[] = [...header, ''];
  for (const r of rows) {
    lines.push(`${fmtTime(r.timestamp)}  ${fmtAgent(r.agent)}  ${fmtEventType(r.event_type)}  ${payloadLabel(r)}`);
  }

  const total = opts.totalAvailable ?? rows.length;
  if (total > rows.length) {
    lines.push('');
    lines.push(`… (showing ${rows.length} of ${total}; older events truncated)`);
  }

  return lines.join('\n');
}

export const ACTIVITY_USAGE = 'Usage: /activity [ceo|ops|<agent>|all] [minutes]  (default: 30 minutes)';
