/**
 * Activity-stream background loop. Independent of host-sweep so we get
 * sub-second responsiveness for /activity output and the auto-stream
 * Telegram push without coupling to the heavyweight 60s sweep.
 *
 * Each tick:
 *   1. For every active session, mirror new tool_call_events into the
 *      central activity_events table.
 *   2. For each newly-mirrored event, ask the auto-stream publisher to
 *      forward it if it's "major" and the per-agent throttle window
 *      has elapsed.
 *   3. Once per `RETENTION_TICK_INTERVAL_MS`, prune events older than the
 *      retention window.
 *
 * All writes are wrapped in try/catch — a failure in this loop must
 * never break the main agent flow.
 */
import { getActiveSessions } from '../../db/sessions.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { openOutboundDb, outboundDbPath } from '../../session-manager.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import fs from 'fs';

import { mirrorSessionToolCalls } from './sync.js';
import { pruneRetention } from './retention.js';
import {
  AutoStreamPublisher,
  getOperatorChat,
  isAutoStreamEnabled,
  publishEventIfMajor,
  type OperatorChatTarget,
} from './auto-stream.js';
import type { ActivityEventRow } from './logger.js';

export const ACTIVITY_POLL_INTERVAL_MS = 5_000;
export const RETENTION_TICK_INTERVAL_MS = 60 * 60 * 1000; // 1h between prunes

let running = false;
let lastRetentionAt = 0;
const publisher = new AutoStreamPublisher();

async function tick(): Promise<void> {
  if (!running) return;
  try {
    await tickOnce();
  } catch (err) {
    log.error('activity-events tick threw', { err });
  }
  setTimeout(tick, ACTIVITY_POLL_INTERVAL_MS);
}

export async function tickOnce(now: number = Date.now()): Promise<void> {
  const centralDb = getDb();
  const target: OperatorChatTarget | null = isAutoStreamEnabled() ? getOperatorChat() : null;

  const sessions = getActiveSessions();
  for (const session of sessions) {
    const ag = getAgentGroup(session.agent_group_id);
    if (!ag) continue;

    const path = outboundDbPath(ag.id, session.id);
    if (!fs.existsSync(path)) continue;

    let outDb;
    try {
      outDb = openOutboundDb(ag.id, session.id);
    } catch {
      continue;
    }

    try {
      const beforeId = lastIdInActivity(centralDb);
      const mirrored = mirrorSessionToolCalls(centralDb, outDb, session.id, ag.name ?? ag.id);
      if (mirrored > 0 && target) {
        const fresh = freshEventsSince(centralDb, beforeId, ag.name ?? ag.id);
        for (const ev of fresh) {
          // Sequential — adapter.deliver is a network call but throttling
          // already keeps the volume low.
          await publishEventIfMajor(ev, { publisher, target, now: () => now });
        }
      }
    } finally {
      outDb.close();
    }
  }

  if (now - lastRetentionAt >= RETENTION_TICK_INTERVAL_MS) {
    const removed = pruneRetention(centralDb, now);
    if (removed > 0) log.info('activity-events retention pruned', { rows: removed });
    lastRetentionAt = now;
  }
}

function lastIdInActivity(db: ReturnType<typeof getDb>): number {
  try {
    const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM activity_events').get() as { id: number };
    return row.id;
  } catch {
    return 0;
  }
}

function freshEventsSince(db: ReturnType<typeof getDb>, lastId: number, agent: string): ActivityEventRow[] {
  try {
    return db
      .prepare(
        `SELECT id, session_id, agent, event_type, tool_name, payload, timestamp
           FROM activity_events
          WHERE id > ? AND agent = ?
          ORDER BY id ASC`,
      )
      .all(lastId, agent) as ActivityEventRow[];
  } catch {
    return [];
  }
}

export function startActivityEventsPoll(): void {
  if (running) return;
  running = true;
  void tick();
}

export function stopActivityEventsPoll(): void {
  running = false;
}

/** Test helper. Resets internal state so the loop can be re-driven from tests. */
export function _resetActivityPollState(): void {
  running = false;
  lastRetentionAt = 0;
  publisher.reset();
}
