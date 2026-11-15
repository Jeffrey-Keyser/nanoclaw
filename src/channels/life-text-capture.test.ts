import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  forwardTextCapture,
  LIFE_TEXT_MAX_CHARS,
} from './life-text-capture.js';
import type { LifeTextFetch } from './life-text-capture.js';
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
const SECRET_TEXT = 'secret-text-abc-123-unique';
const BASE_URL = 'https://life.example.com';
const JOURNAL_ID = 'journal-1';
const SOURCE_KEY = 'telegram:111:222';

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
  expect(text).not.toContain(SECRET_TEXT);
  expect(text).not.toContain(SOURCE_KEY);
  expect(text).not.toContain('api.telegram.org');
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): {
  fetchImpl: LifeTextFetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: LifeTextFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

describe('forwardTextCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts JSON to the literal receiver path with Bearer auth and source identity', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(
        { success: true, data: { captureId: 'cap-1', entryId: 42 } },
        201,
      ),
    );

    const result = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: 'hello   world',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'saved', captureId: 'cap-1', entryId: 42 });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(
      `${BASE_URL}/api/v1/journals/${JOURNAL_ID}/text/captures`,
    );
    expect(call.url).toContain('/api/v1/journals/journal-1/text/captures');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    const parsed = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(parsed).toEqual({
      sourceMessageKey: SOURCE_KEY,
      text: 'hello   world',
    });
    expectNoSecrets();
  });

  it('accepts 200 with replayed true as replayed', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(
        { success: true, data: { captureId: 'cap-r', entryId: 7, replayed: true } },
        200,
      ),
    );
    const result = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: 'hi',
      sourceMessageKey: SOURCE_KEY,
    });
    expect(result).toEqual({ outcome: 'replayed', captureId: 'cap-r', entryId: 7 });
    expectNoSecrets();
  });

  it('sends identical redelivery identity on repeated calls', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(
        { success: true, data: { captureId: 'cap-d', entryId: 9, replayed: true } },
        200,
      ),
    );
    const input = {
      fetchImpl,
      config: config(),
      text: 'same',
      sourceMessageKey: SOURCE_KEY,
    };
    await forwardTextCapture(input);
    await forwardTextCapture(input);
    expect(calls).toHaveLength(2);
    const first = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    const second = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
    expect(first['sourceMessageKey']).toBe(SOURCE_KEY);
    expect(second['sourceMessageKey']).toBe(SOURCE_KEY);
    expect(first).toEqual(second);
    expectNoSecrets();
  });

  it('returns rejected on 409 conflict', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ success: false, error: 'conflict' }, 409),
    );
    const result = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: 'hi',
      sourceMessageKey: SOURCE_KEY,
    });
    expect(result.outcome).toBe('rejected');
    expect(result.code).toBe('conflict');
    expect(calls).toHaveLength(1);
    expectNoSecrets();
  });

  it('returns unconfirmed on malformed envelope', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ ok: true }, 201),
    );
    const result = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: 'hi',
      sourceMessageKey: SOURCE_KEY,
    });
    expect(result.outcome).toBe('unconfirmed');
    expectNoSecrets();
  });

  it('returns unconfirmed when entry ID is missing', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ success: true, data: { captureId: 'cap-x' } }, 201),
    );
    const result = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: 'hi',
      sourceMessageKey: SOURCE_KEY,
    });
    expect(result.outcome).toBe('unconfirmed');
    expect(result.code).toBe('missing_entry_id');
    expectNoSecrets();
  });

  it('returns unconfirmed when entry ID is not positive', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(
        { success: true, data: { captureId: 'cap-x', entryId: 0 } },
        201,
      ),
    );
    const result = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: 'hi',
      sourceMessageKey: SOURCE_KEY,
    });
    expect(result.outcome).toBe('unconfirmed');
    expectNoSecrets();
  });

  it('rejects blank and oversized payloads without a request', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ success: true, data: { captureId: 'c', entryId: 1 } }, 201),
    );
    const blank = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: '',
      sourceMessageKey: SOURCE_KEY,
    });
    expect(blank.outcome).toBe('rejected');
    expect(blank.code).toBe('invalid_payload');

    const oversized = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: 'x'.repeat(LIFE_TEXT_MAX_CHARS + 1),
      sourceMessageKey: SOURCE_KEY,
    });
    expect(oversized.outcome).toBe('rejected');
    expect(calls).toHaveLength(0);
    expectNoSecrets();
  });

  it('returns rejected on authentication rejection', async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = recordingFetch(() =>
        jsonResponse({ success: false }, status),
      );
      const result = await forwardTextCapture({
        fetchImpl,
        config: config(),
        text: 'hi',
        sourceMessageKey: SOURCE_KEY,
      });
      expect(result.outcome).toBe('rejected');
      expect(result.code).toBe('auth_rejected');
    }
    expectNoSecrets();
  });

  it('returns unconfirmed on server failure', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ success: false }, 500),
    );
    const result = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: 'hi',
      sourceMessageKey: SOURCE_KEY,
    });
    expect(result.outcome).toBe('unconfirmed');
    expect(result.code).toBe('server_error');
    expectNoSecrets();
  });

  it('returns unconfirmed on timeout without retry', async () => {
    const fetchImpl: LifeTextFetch = async (_input, init) => {
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
    const result = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: SECRET_TEXT,
      sourceMessageKey: SOURCE_KEY,
      timeoutMs: 10,
    });
    expect(result.outcome).toBe('unconfirmed');
    expect(result.code).toBe('timeout');
    expectNoSecrets();
  });

  it('returns unconfirmed on transport interruption', async () => {
    const fetchImpl: LifeTextFetch = async () => {
      throw new Error('network down');
    };
    const result = await forwardTextCapture({
      fetchImpl,
      config: config(),
      text: 'hi',
      sourceMessageKey: SOURCE_KEY,
    });
    expect(result.outcome).toBe('unconfirmed');
    expect(result.code).toBe('transport_error');
    expectNoSecrets();
  });
});
