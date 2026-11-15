import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildArchiveQuestionUrl,
  buildSourceMessageKey,
  buildSourceThreadKey,
  forwardArchiveQuestion,
  LIFE_ARCHIVE_QUESTION_MAX_CHARS,
  splitArchiveAnswerParts,
  TELEGRAM_ARCHIVE_ANSWER_MAX_LENGTH,
} from './life-archive-question.js';
import type { LifeArchiveQuestionFetch } from './life-archive-question.js';
import { logger } from '../logger.js';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const SECRET_TOKEN = 'secret-token-xyz-987';
const SECRET_QUESTION = 'secret-question-abc-123-unique';
const SECRET_ANSWER = 'secret-answer-def-456-unique';
const BASE_URL = 'https://life.example.com';
const JOURNAL_ID = 'journal-1';
const CHAT_ID = '111';
const MESSAGE_ID = '222';
const THREAD_KEY = `telegram:${CHAT_ID}`;
const MESSAGE_KEY = `telegram:${CHAT_ID}:${MESSAGE_ID}`;

function config() {
  return { baseUrl: BASE_URL, journalId: JOURNAL_ID, token: SECRET_TOKEN };
}

function loggedText(): string {
  const mocked = logger as unknown as {
    info: { mock: { calls: unknown[][] } };
    warn: { mock: { calls: unknown[][] } };
    error: { mock: { calls: unknown[][] } };
    debug: { mock: { calls: unknown[][] } };
  };
  const all = [
    ...mocked.info.mock.calls,
    ...mocked.warn.mock.calls,
    ...mocked.error.mock.calls,
    ...mocked.debug.mock.calls,
  ];
  return JSON.stringify(all);
}

function expectNoSecrets() {
  const text = loggedText();
  expect(text).not.toContain(SECRET_TOKEN);
  expect(text).not.toContain(SECRET_QUESTION);
  expect(text).not.toContain(SECRET_ANSWER);
  expect(text).not.toContain(THREAD_KEY);
  expect(text).not.toContain(MESSAGE_KEY);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function successData(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      threadKey: THREAD_KEY,
      turnId: 'turn-1',
      answer: 'The archive remembers.',
      generation: 'gen-1',
      entryCount: 3,
      replayed: false,
      ...overrides,
    },
  };
}

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): {
  fetchImpl: LifeArchiveQuestionFetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: LifeArchiveQuestionFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

describe('life-archive-question forwarder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts exactly sourceThreadKey, sourceMessageKey and question with Bearer auth', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(successData(), 201),
    );
    const result = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'what happened in march?',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(result.outcome).toBe('answered');
    expect(result.answer).toBe('The archive remembers.');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `${BASE_URL}/api/v1/journals/${JOURNAL_ID}/archive-questions`,
    );
    expect(calls[0].url).toBe(buildArchiveQuestionUrl(BASE_URL, JOURNAL_ID));
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    const parsed = JSON.parse(String(calls[0].init?.body));
    expect(Object.keys(parsed).sort()).toEqual(
      ['question', 'sourceMessageKey', 'sourceThreadKey'].sort(),
    );
    expect(parsed).toEqual({
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
      question: 'what happened in march?',
    });
    expectNoSecrets();
  });

  it('uses telegram chat and message identities', () => {
    expect(buildSourceThreadKey(CHAT_ID)).toBe(`telegram:${CHAT_ID}`);
    expect(buildSourceMessageKey(CHAT_ID, MESSAGE_ID)).toBe(
      `telegram:${CHAT_ID}:${MESSAGE_ID}`,
    );
  });

  it('accepts 201 with replayed false as a new turn', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(successData({ replayed: false }), 201),
    );
    const result = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'q',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(result.outcome).toBe('answered');
    expectNoSecrets();
  });

  it('accepts 200 with replayed true as a stored replay', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(
        successData({ replayed: true, answer: 'Stored answer.' }),
        200,
      ),
    );
    const result = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'same question',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(result).toEqual({ outcome: 'replayed', answer: 'Stored answer.' });
    expectNoSecrets();
  });

  it('preserves source identities on redelivery', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(successData({ replayed: true }), 200),
    );
    const input = {
      fetchImpl,
      config: config(),
      question: 'same',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    };
    await forwardArchiveQuestion(input);
    await forwardArchiveQuestion(input);
    expect(calls).toHaveLength(2);
    const first = JSON.parse(String(calls[0].init?.body));
    const second = JSON.parse(String(calls[1].init?.body));
    expect(first['sourceThreadKey']).toBe(THREAD_KEY);
    expect(first['sourceMessageKey']).toBe(MESSAGE_KEY);
    expect(second).toEqual(first);
    expectNoSecrets();
  });

  it('keeps successive message identities distinct under one thread key', async () => {
    const seen: string[] = [];
    const { fetchImpl, calls } = recordingFetch((url, init) => {
      seen.push(String(url));
      void init;
      return jsonResponse(successData(), 201);
    });
    await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'first',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: `telegram:${CHAT_ID}:1`,
    });
    await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'follow-up',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: `telegram:${CHAT_ID}:2`,
    });
    expect(calls).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    const b1 = JSON.parse(String(calls[0].init?.body));
    const b2 = JSON.parse(String(calls[1].init?.body));
    expect(b1['sourceThreadKey']).toBe(THREAD_KEY);
    expect(b2['sourceThreadKey']).toBe(THREAD_KEY);
    expect(b1['sourceMessageKey']).toBe(`telegram:${CHAT_ID}:1`);
    expect(b2['sourceMessageKey']).toBe(`telegram:${CHAT_ID}:2`);
    expectNoSecrets();
  });

  it('rejects blank and oversized questions without a request', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(successData(), 201),
    );
    const blank = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: '',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(blank.outcome).toBe('rejected');
    const oversized = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'x'.repeat(LIFE_ARCHIVE_QUESTION_MAX_CHARS + 1),
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(oversized.outcome).toBe('rejected');
    const boundary = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'x'.repeat(LIFE_ARCHIVE_QUESTION_MAX_CHARS),
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(boundary.outcome).toBe('answered');
    expect(calls).toHaveLength(1);
    expectNoSecrets();
  });

  it('rejects authentication failures', async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = recordingFetch(() =>
        jsonResponse({ success: false }, status),
      );
      const result = await forwardArchiveQuestion({
        fetchImpl,
        config: config(),
        question: 'q',
        sourceThreadKey: THREAD_KEY,
        sourceMessageKey: MESSAGE_KEY,
      });
      expect(result.outcome).toBe('rejected');
      expect(result.code).toBe('auth_rejected');
    }
    expectNoSecrets();
  });

  it('rejects conflicts', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ success: false }, 409),
    );
    const result = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'q',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(result.outcome).toBe('rejected');
    expect(result.code).toBe('conflict');
    expectNoSecrets();
  });

  it('returns unconfirmed on malformed envelopes', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ ok: true }, 201),
    );
    const result = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'q',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(result.outcome).toBe('unconfirmed');
    expectNoSecrets();
  });

  it('returns unconfirmed when thread, turn, answer, generation or entry count are missing', async () => {
    const cases: Array<{ overrides: Record<string, unknown>; code: string }> = [
      { overrides: { threadKey: undefined, sourceThreadKey: undefined }, code: 'missing_thread_key' },
      { overrides: { turnId: '' }, code: 'missing_turn_id' },
      { overrides: { answer: '' }, code: 'missing_answer' },
      { overrides: { generation: '' }, code: 'missing_generation' },
      { overrides: { entryCount: undefined }, code: 'missing_entry_count' },
    ];
    for (const c of cases) {
      const data: Record<string, unknown> = {
        threadKey: THREAD_KEY,
        turnId: 'turn-1',
        answer: 'a',
        generation: 'g',
        entryCount: 1,
        replayed: false,
        ...c.overrides,
      };
      for (const k of Object.keys(c.overrides)) {
        if (c.overrides[k] === undefined) delete data[k];
      }
      const { fetchImpl } = recordingFetch(() =>
        jsonResponse({ success: true, data }, 201),
      );
      const result = await forwardArchiveQuestion({
        fetchImpl,
        config: config(),
        question: SECRET_QUESTION,
        sourceThreadKey: THREAD_KEY,
        sourceMessageKey: MESSAGE_KEY,
      });
      expect(result.outcome).toBe('unconfirmed');
      expect(result.code).toBe(c.code);
    }
    expectNoSecrets();
  });

  it('returns unconfirmed on thread mismatch', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(successData({ threadKey: 'telegram:999' }), 201),
    );
    const result = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'q',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(result.outcome).toBe('unconfirmed');
    expect(result.code).toBe('thread_mismatch');
    expectNoSecrets();
  });

  it('returns unconfirmed on unexpected status and replay combinations', async () => {
    const combos: Array<{ status: number; replayed: boolean }> = [
      { status: 201, replayed: true },
      { status: 200, replayed: false },
    ];
    for (const combo of combos) {
      const { fetchImpl } = recordingFetch(() =>
        jsonResponse(successData({ replayed: combo.replayed }), combo.status),
      );
      const result = await forwardArchiveQuestion({
        fetchImpl,
        config: config(),
        question: 'q',
        sourceThreadKey: THREAD_KEY,
        sourceMessageKey: MESSAGE_KEY,
      });
      expect(result.outcome).toBe('unconfirmed');
      expect(result.code).toBe('unexpected_status');
    }
    expectNoSecrets();
  });

  it('returns unconfirmed on server failure', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ success: false }, 500),
    );
    const result = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'q',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(result.outcome).toBe('unconfirmed');
    expect(result.code).toBe('server_error');
    expectNoSecrets();
  });

  it('returns unconfirmed on timeout without retry', async () => {
    const fetchImpl: LifeArchiveQuestionFetch = async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
      throw new Error('unreachable');
    };
    const result = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: SECRET_QUESTION,
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
      timeoutMs: 10,
    });
    expect(result.outcome).toBe('unconfirmed');
    expect(result.code).toBe('timeout');
    expectNoSecrets();
  });

  it('returns unconfirmed on transport interruption', async () => {
    const fetchImpl: LifeArchiveQuestionFetch = async () => {
      throw new Error('network down');
    };
    const result = await forwardArchiveQuestion({
      fetchImpl,
      config: config(),
      question: 'q',
      sourceThreadKey: THREAD_KEY,
      sourceMessageKey: MESSAGE_KEY,
    });
    expect(result.outcome).toBe('unconfirmed');
    expect(result.code).toBe('transport_error');
    expectNoSecrets();
  });

  it('splits long answers into ordered Telegram-sized parts preserving text', () => {
    const answer = 'a'.repeat(TELEGRAM_ARCHIVE_ANSWER_MAX_LENGTH + 10) + 'TAIL';
    const parts = splitArchiveAnswerParts(answer);
    expect(parts.length).toBe(2);
    expect(parts.join('')).toBe(answer);
    expect(parts[0].length).toBe(TELEGRAM_ARCHIVE_ANSWER_MAX_LENGTH);
    expect(parts[1]).toBe('a'.repeat(10) + 'TAIL');
    expect(splitArchiveAnswerParts('short')).toEqual(['short']);
  });
});
