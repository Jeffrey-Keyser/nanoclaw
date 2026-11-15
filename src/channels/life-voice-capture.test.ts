import { describe, it, expect, vi, beforeEach } from 'vitest';
import { forwardVoiceCapture } from './life-voice-capture.js';
import type { LifeVoiceFetch } from './life-voice-capture.js';
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
const AUDIO_TEXT = 'AUDIO-BYTES-xyz-123-unique';
const FILE_URL = 'https://api.telegram.org/file/botABC/voice/file_123.ogg';
const BASE_URL = 'https://life.example.com';
const JOURNAL_ID = '42';
const SOURCE_KEY = 'telegram:111:222';

const CAP_NEW = '11111111-1111-4111-8111-111111111111';
const CAP_REPLAY = '22222222-2222-4222-8222-222222222222';
const CAP_DONE = '33333333-3333-4333-8333-333333333333';
const CAP_RESOLVE = '44444444-4444-4434-8434-444444444444';
const CAP_WAIT = '55555555-5555-4535-8535-555555555555';
const CAP_FAILED = '66666666-6666-4636-8636-666666666666';
const CAP_UNRESOLVED = '77777777-7777-4737-8737-777777777777';
const CAP_BAD = '88888888-8888-4838-8838-888888888888';

function audioBytes(): Uint8Array {
  return new TextEncoder().encode(AUDIO_TEXT);
}

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
  expect(text).not.toContain(AUDIO_TEXT);
  expect(text).not.toContain(FILE_URL);
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
  fetchImpl: LifeVoiceFetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: LifeVoiceFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

async function readFormField(body: unknown, name: string): Promise<unknown> {
  if (body instanceof FormData) return body.get(name);
  throw new Error('expected FormData body');
}

function receiptUrl(): string {
  return `${BASE_URL}/api/v1/journals/${JOURNAL_ID}/voice/captures`;
}

describe('forwardVoiceCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads multipart audio with bearer auth then processes and completes for a new receipt', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
      durationSeconds: 12,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_NEW });
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);

    const receipt = calls[0];
    expect(receipt.url).toBe(receiptUrl());
    expect(receipt.url).toContain('/api/v1/journals/42/voice/captures');
    const headers = receipt.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    const sourceValue = await readFormField(
      receipt.init?.body,
      'sourceMessageKey',
    );
    expect(sourceValue).toBe(SOURCE_KEY);
    const audioPart = (await readFormField(
      receipt.init?.body,
      'audio',
    )) as Blob;
    expect(audioPart).toBeInstanceOf(Blob);
    expect(audioPart.type).toBe('audio/ogg');
    expect(await audioPart.text()).toBe(AUDIO_TEXT);
    for (const call of calls.slice(1)) {
      const h = call.init?.headers as Record<string, string>;
      expect(h['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);
    }
    expectNoSecrets();
  });

  it('processes an unfinished replayed receipt through to completion', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_REPLAY, state: 'unfinished', replayed: true },
          },
          200,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_REPLAY, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_REPLAY, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_REPLAY });
    expect(calls).toHaveLength(3);
    expectNoSecrets();
  });

  it('returns completed immediately for an already completed receipt without further mutation', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_DONE, state: 'completed', replayed: true },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'completed', captureId: CAP_DONE });
    expect(calls).toHaveLength(1);
    expectNoSecrets();
  });

  it('returns review_in_life for a resolve nextAction without calling complete', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_RESOLVE, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_RESOLVE, state: 'unresolved', nextAction: 'resolve' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'review_in_life', captureId: CAP_RESOLVE });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);
    expectNoSecrets();
  });

  it('returns review_in_life for a wait nextAction without calling complete', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_WAIT, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_WAIT, state: 'unfinished', nextAction: 'wait' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/mpeg',
      sourceMessageKey: SOURCE_KEY,
      durationSeconds: 5,
    });

    expect(result).toEqual({ outcome: 'review_in_life', captureId: CAP_WAIT });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);
    expectNoSecrets();
  });

  it('returns review_in_life for an unresolved receipt without invoking process', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_UNRESOLVED, state: 'unresolved' } },
          201,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'review_in_life', captureId: CAP_UNRESOLVED });
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);
    expectNoSecrets();
  });

  it('returns failed for an explicit capture failure state', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_FAILED, state: 'failed', code: 'transcription_failed' },
          },
          201,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(result.captureId).toBe(CAP_FAILED);
    expect(result.code).toBe('transcription_failed');
    expect(calls).toHaveLength(1);
    expectNoSecrets();
  });

  it('returns failed with Life code on receipt 4xx without throwing', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse({ success: false, code: 'invalid_audio' }, 422);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({ outcome: 'failed', code: 'invalid_audio' });
    expect(calls).toHaveLength(1);
    expectNoSecrets();
  });

  it('returns failed on receipt 5xx without throwing', async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse({ success: false, code: 'internal_error' }, 500);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('internal_error');
    expectNoSecrets();
  });

  it('returns failed on process redeliver without calling complete', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_BAD, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_BAD, state: 'unfinished', nextAction: 'redeliver', code: 'retry_later' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result).toEqual({
      outcome: 'failed',
      captureId: CAP_BAD,
      code: 'retry_later',
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expectNoSecrets();
  });

  it('returns failed on process 5xx without throwing', async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_BAD, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse({ success: false, code: 'process_down' }, 503);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('process_down');
    expectNoSecrets();
  });

  it('returns failed when fetch throws without throwing', async () => {
    const fetchImpl: LifeVoiceFetch = async () => {
      throw new Error('network down');
    };

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(typeof result.code).toBe('string');
    expectNoSecrets();
  });

  it('returns failed on malformed success envelopes without reporting completed', async () => {
    for (const malformed of [
      { success: true },
      { success: true, data: null },
      { success: true, data: { state: 'unfinished' } },
      { ok: true, data: { captureId: CAP_BAD, state: 'unfinished' } },
    ]) {
      const { fetchImpl } = recordingFetch((url) => {
        if (url === receiptUrl()) {
          return jsonResponse(malformed, 201);
        }
        throw new Error(`unexpected url ${url}`);
      });
      const result = await forwardVoiceCapture({
        fetchImpl,
        config: config(),
        audio: audioBytes(),
        mimeType: 'audio/ogg',
        sourceMessageKey: SOURCE_KEY,
      });
      expect(result.outcome).toBe('failed');
    }
    expectNoSecrets();
  });

  it('returns failed when completion capture identity does not match', async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_BAD, state: 'completed' },
          },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('completion_mismatch');
    expectNoSecrets();
  });

  it('returns failed when completion state is not completed', async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    expect(result.outcome).toBe('failed');
    expect(result.code).toBe('completion_mismatch');
    expectNoSecrets();
  });

  it('never calls resolve', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === receiptUrl()) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'unfinished' } },
          201,
        );
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          {
            success: true,
            data: { captureId: CAP_NEW, state: 'unfinished', nextAction: 'complete' },
          },
          200,
        );
      }
      if (url.endsWith('/complete')) {
        return jsonResponse(
          { success: true, data: { captureId: CAP_NEW, state: 'completed' } },
          200,
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    await forwardVoiceCapture({
      fetchImpl,
      config: config(),
      audio: audioBytes(),
      mimeType: 'audio/ogg',
      sourceMessageKey: SOURCE_KEY,
    });

    for (const call of calls) {
      expect(call.url).not.toContain('resolve');
    }
    expectNoSecrets();
  });
});
