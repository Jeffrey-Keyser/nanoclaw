import { describe, expect, it } from 'vitest';

import {
  AutoStreamPublisher,
  isAutoStreamEnabled,
  isMajorEvent,
  parseOperatorChat,
  publishEventIfMajor,
} from './auto-stream.js';
import type { ActivityEventRow } from './logger.js';

function makeRow(opts: Partial<ActivityEventRow> & { event_type: ActivityEventRow['event_type']; agent: string }): ActivityEventRow {
  return {
    id: 1,
    session_id: 's1',
    payload: '{}',
    tool_name: null,
    timestamp: Date.now(),
    ...opts,
  } as ActivityEventRow;
}

describe('isAutoStreamEnabled', () => {
  it('defaults to false when env var is absent', () => {
    expect(isAutoStreamEnabled({})).toBe(false);
  });

  it('parses common true values', () => {
    expect(isAutoStreamEnabled({ NANOCLAW_ACTIVITY_AUTO_TELEGRAM: 'true' })).toBe(true);
    expect(isAutoStreamEnabled({ NANOCLAW_ACTIVITY_AUTO_TELEGRAM: '1' })).toBe(true);
    expect(isAutoStreamEnabled({ NANOCLAW_ACTIVITY_AUTO_TELEGRAM: 'YES' })).toBe(true);
  });

  it('treats other values as false', () => {
    expect(isAutoStreamEnabled({ NANOCLAW_ACTIVITY_AUTO_TELEGRAM: 'maybe' })).toBe(false);
    expect(isAutoStreamEnabled({ NANOCLAW_ACTIVITY_AUTO_TELEGRAM: '0' })).toBe(false);
  });
});

describe('parseOperatorChat', () => {
  it('parses channel:platform', () => {
    expect(parseOperatorChat('telegram:123456789')).toEqual({
      channelType: 'telegram',
      platformId: '123456789',
      threadId: null,
    });
  });

  it('parses channel:platform:thread', () => {
    expect(parseOperatorChat('slack:C123:thread-1.0')).toEqual({
      channelType: 'slack',
      platformId: 'C123',
      threadId: 'thread-1.0',
    });
  });

  it('rejects malformed specs', () => {
    expect(parseOperatorChat('')).toBeNull();
    expect(parseOperatorChat('telegram')).toBeNull();
    expect(parseOperatorChat(undefined)).toBeNull();
  });
});

describe('isMajorEvent', () => {
  it('treats decisions as major', () => {
    expect(isMajorEvent(makeRow({ event_type: 'decision', agent: 'ceo' }))).toBe(true);
  });

  it('treats tool_call_start of non-trivial tools as major', () => {
    expect(isMajorEvent(makeRow({ event_type: 'tool_call_start', agent: 'ceo', tool_name: 'Bash' }))).toBe(true);
  });

  it('skips trivial tools', () => {
    expect(isMajorEvent(makeRow({ event_type: 'tool_call_start', agent: 'ceo', tool_name: 'Read' }))).toBe(false);
    expect(isMajorEvent(makeRow({ event_type: 'tool_call_start', agent: 'ceo', tool_name: 'Glob' }))).toBe(false);
  });

  it('skips tool_call_complete and reasoning_step', () => {
    expect(isMajorEvent(makeRow({ event_type: 'tool_call_complete', agent: 'ceo', tool_name: 'Bash' }))).toBe(false);
    expect(isMajorEvent(makeRow({ event_type: 'reasoning_step', agent: 'ceo' }))).toBe(false);
  });
});

describe('AutoStreamPublisher throttling', () => {
  it('lets the first event through and blocks a follow-up within the window', () => {
    const pub = new AutoStreamPublisher(2000);
    const t = Date.now();
    expect(pub.shouldPush('ceo', t)).toBe(true);
    expect(pub.shouldPush('ceo', t + 500)).toBe(false);
    expect(pub.shouldPush('ceo', t + 1999)).toBe(false);
    expect(pub.shouldPush('ceo', t + 2000)).toBe(true);
  });

  it('throttles per-agent independently', () => {
    const pub = new AutoStreamPublisher(2000);
    const t = Date.now();
    expect(pub.shouldPush('ceo', t)).toBe(true);
    expect(pub.shouldPush('ops', t)).toBe(true);
    expect(pub.shouldPush('ceo', t + 100)).toBe(false);
    expect(pub.shouldPush('ops', t + 100)).toBe(false);
  });
});

describe('publishEventIfMajor', () => {
  it('forwards a major event through the adapter', async () => {
    const calls: Array<{ platformId: string; threadId: string | null; kind: string }> = [];
    const adapter = {
      channelType: 'telegram',
      supportsThreads: false,
      async deliver(platformId: string, threadId: string | null, msg: { kind: string }) {
        calls.push({ platformId, threadId, kind: msg.kind });
      },
    } as unknown as Parameters<NonNullable<Parameters<typeof publishEventIfMajor>[1]['resolveAdapter']>>[0] extends string
      ? never
      : Parameters<typeof publishEventIfMajor>[1]['resolveAdapter'] extends (s: string) => infer A
        ? A
        : never;

    const pushed = await publishEventIfMajor(
      makeRow({ event_type: 'decision', agent: 'ceo', payload: '{"summary":"chose path A"}' }),
      {
        publisher: new AutoStreamPublisher(),
        target: { channelType: 'telegram', platformId: '123', threadId: null },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolveAdapter: () => adapter as any,
      },
    );

    expect(pushed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.platformId).toBe('123');
  });

  it('skips minor events', async () => {
    let called = false;
    const pushed = await publishEventIfMajor(
      makeRow({ event_type: 'reasoning_step', agent: 'ceo' }),
      {
        publisher: new AutoStreamPublisher(),
        target: { channelType: 'telegram', platformId: '123', threadId: null },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolveAdapter: () => ({ deliver: async () => { called = true; } }) as any,
      },
    );
    expect(pushed).toBe(false);
    expect(called).toBe(false);
  });

  it('skips when no target is configured', async () => {
    const pushed = await publishEventIfMajor(
      makeRow({ event_type: 'decision', agent: 'ceo' }),
      { publisher: new AutoStreamPublisher(), target: null },
    );
    expect(pushed).toBe(false);
  });
});
