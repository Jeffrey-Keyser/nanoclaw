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
const JOURNAL_ID = 'journal-1';
const SOURCE_KEY = 'telegram:111:222';

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

describe('forwardVoiceCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads multipart audio with bearer auth then processes and completes', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === `${BASE_URL}/api/v1/journals/${JOURNAL_ID}/voice-captures`) {
        return jsonResponse({ captureId: 'cap-1' }, 201);
      }
      if (url.endsWith('/process')) {
        return jsonResponse({ nextAction: 'complete' }, 200);
      }
      if (url.endsWith('/complete')) {
        return jsonResponse({ ok: true }, 200);
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

    expect(result).toEqual({ outcome: 'completed', captureId: 'cap-1' });
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);

    const receipt = calls[0];
    expect(receipt.url).toBe(
      `${BASE_URL}/api/v1/journals/${JOURNAL_ID}/voice-captures`,
    );
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
    expectNoSecrets();
  });

  it('treats 200 with replayed true as receipt success', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url === `${BASE_URL}/api/v1/journals/${JOURNAL_ID}/voice-captures`) {
        return jsonResponse({ captureId: 'cap-replay', replayed: true }, 200);
      }
      if (url.endsWith('/process')) {
        return jsonResponse({ nextAction: 'complete' }, 200);
      }
      if (url.endsWith('/complete')) {
        return jsonResponse({ ok: true }, 200);
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

    expect(result.outcome).toBe('completed');
    expect(result.captureId).toBe('cap-replay');
    expect(calls).toHaveLength(3);
    expectNoSecrets();
  });

  it('returns review_in_life for resolve without calling complete', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith('/voice-captures')) {
        return jsonResponse({ captureId: 'cap-2' }, 201);
      }
      if (url.endsWith('/process')) {
        return jsonResponse({ nextAction: 'resolve' }, 200);
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

    expect(result).toEqual({ outcome: 'review_in_life', captureId: 'cap-2' });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);
    expectNoSecrets();
  });

  it('returns review_in_life for review_in_life without calling complete', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith('/voice-captures')) {
        return jsonResponse({ captureId: 'cap-3' }, 201);
      }
      if (url.endsWith('/process')) {
        return jsonResponse({ nextAction: 'review_in_life' }, 200);
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

    expect(result).toEqual({ outcome: 'review_in_life', captureId: 'cap-3' });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes('resolve'))).toBe(false);
    expectNoSecrets();
  });

  it('returns failed with Life code on receipt 4xx without throwing', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith('/voice-captures')) {
        return jsonResponse({ code: 'invalid_audio' }, 422);
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
      if (url.endsWith('/voice-captures')) {
        return jsonResponse({ code: 'internal_error' }, 500);
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
      if (url.endsWith('/voice-captures')) {
        return jsonResponse({ captureId: 'cap-4' }, 201);
      }
      if (url.endsWith('/process')) {
        return jsonResponse(
          { nextAction: 'redeliver', code: 'retry_later' },
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
      captureId: 'cap-4',
      code: 'retry_later',
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    expectNoSecrets();
  });

  it('returns failed on process 5xx without throwing', async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith('/voice-captures')) {
        return jsonResponse({ captureId: 'cap-5' }, 201);
      }
      if (url.endsWith('/process')) {
        return jsonResponse({ code: 'process_down' }, 503);
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

  it('never calls resolve', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith('/voice-captures')) {
        return jsonResponse({ captureId: 'cap-6' }, 201);
      }
      if (url.endsWith('/process')) {
        return jsonResponse({ nextAction: 'complete' }, 200);
      }
      if (url.endsWith('/complete')) {
        return jsonResponse({ ok: true }, 200);
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
