import { describe, expect, it } from 'vitest';

import { formatEvent, parseActivityArgs } from './command-gate.js';
import type { ToolCallEvent } from './db/session-db.js';

describe('parseActivityArgs', () => {
  it('defaults to 15-minute window with no filter', () => {
    expect(parseActivityArgs([])).toEqual({ filter: null, minutes: 15 });
  });

  it('parses a numeric window argument', () => {
    expect(parseActivityArgs(['30'])).toEqual({ filter: null, minutes: 30 });
  });

  it('parses an agent filter argument', () => {
    expect(parseActivityArgs(['ops'])).toEqual({ filter: 'ops', minutes: 15 });
  });

  it('accepts both filter and window in either order', () => {
    expect(parseActivityArgs(['ops', '60'])).toEqual({ filter: 'ops', minutes: 60 });
    expect(parseActivityArgs(['60', 'ops'])).toEqual({ filter: 'ops', minutes: 60 });
  });

  it('clamps the window to [1, 1440]', () => {
    expect(parseActivityArgs(['0']).minutes).toBe(1);
    expect(parseActivityArgs(['-5']).minutes).toBe(1);
    expect(parseActivityArgs(['9999']).minutes).toBe(1440);
  });

  it('lowercases the filter for case-insensitive matching', () => {
    expect(parseActivityArgs(['CEO']).filter).toBe('ceo');
  });

  it('ignores non-numeric tokens after the first filter', () => {
    expect(parseActivityArgs(['ops', 'noise'])).toEqual({ filter: 'ops', minutes: 15 });
  });
});

describe('formatEvent', () => {
  function event(partial: Partial<ToolCallEvent>): ToolCallEvent {
    return {
      id: 'x',
      event_type: 'tool_call_complete',
      tool_name: 'Bash',
      tool_input: null,
      started_at: '2026-04-27T12:00:00.000Z',
      finished_at: '2026-04-27T12:00:01.000Z',
      duration_ms: 1000,
      error: null,
      ...partial,
    };
  }

  it('formats a tool_call_complete with duration', () => {
    expect(formatEvent(event({}))).toBe('[2026-04-27T12:00:00.000Z] complete: Bash (1000ms)');
  });

  it('marks errored completions', () => {
    expect(formatEvent(event({ error: 'tool_use_failure' }))).toContain('[error]');
  });

  it('formats a tool_call_start without duration', () => {
    expect(formatEvent(event({ event_type: 'tool_call_start', duration_ms: null }))).toBe(
      '[2026-04-27T12:00:00.000Z] start: Bash',
    );
  });

  it('formats a decision event using tool_name as the label', () => {
    expect(formatEvent(event({ event_type: 'decision', tool_name: 'session_clear' }))).toBe(
      '[2026-04-27T12:00:00.000Z] decision: session_clear',
    );
  });

  it('falls back to "unknown" when tool_name is null', () => {
    expect(formatEvent(event({ tool_name: null }))).toContain('unknown');
  });
});
