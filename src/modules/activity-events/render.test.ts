import { describe, expect, it } from 'vitest';

import type { ActivityEventRow } from './logger.js';
import { ACTIVITY_OUTPUT_CAP, renderActivityStream } from './render.js';

function row(opts: Partial<ActivityEventRow> & { event_type: ActivityEventRow['event_type']; agent: string }): ActivityEventRow {
  return {
    id: 0,
    session_id: 's1',
    payload: '{}',
    tool_name: null,
    timestamp: Date.now(),
    ...opts,
  } as ActivityEventRow;
}

describe('renderActivityStream', () => {
  it('renders one line per event in chronological order', () => {
    const t0 = Date.parse('2026-04-27T10:00:00Z');
    const rows: ActivityEventRow[] = [
      row({ event_type: 'tool_call_start', agent: 'ceo', tool_name: 'Bash', timestamp: t0 }),
      row({ event_type: 'tool_call_complete', agent: 'ceo', tool_name: 'Bash', timestamp: t0 + 100 }),
      row({ event_type: 'decision', agent: 'ceo', payload: '{"summary":"picked endpoint"}', timestamp: t0 + 200 }),
    ];

    const out = renderActivityStream(rows, { agentLabel: 'ceo', sinceMinutes: 30 });
    const lines = out.split('\n');
    // Header (1 line) + blank + 3 event lines = 5
    expect(lines.length).toBe(5);
    expect(lines[2]).toContain('Bash');
    expect(lines[3]).toContain('tool_call_complete');
    expect(lines[4]).toContain('picked endpoint');
  });

  it('mentions truncation when totalAvailable > rows.length', () => {
    const rows: ActivityEventRow[] = Array.from({ length: 50 }, (_, i) =>
      row({
        event_type: 'tool_call_start',
        agent: 'ceo',
        tool_name: `T${i}`,
        timestamp: Date.now() + i,
      }),
    );

    const out = renderActivityStream(rows, { totalAvailable: 75 });
    expect(out).toContain('older events truncated');
    expect(out).toMatch(/showing 50 of 75/);
  });

  it('omits truncation note when nothing was cut', () => {
    const rows: ActivityEventRow[] = [row({ event_type: 'decision', agent: 'ceo' })];
    const out = renderActivityStream(rows, { totalAvailable: 1 });
    expect(out).not.toContain('older events truncated');
  });

  it('handles empty stream', () => {
    const out = renderActivityStream([]);
    expect(out).toContain('(no events)');
  });

  it('exposes a sane cap', () => {
    expect(ACTIVITY_OUTPUT_CAP).toBe(50);
  });
});
