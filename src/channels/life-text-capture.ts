import { logger } from '../logger.js';

export interface LifeTextCaptureConfig {
  baseUrl: string;
  journalId: string;
  token: string;
}

export type LifeTextFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ForwardTextCaptureInput {
  fetchImpl: LifeTextFetch;
  config: LifeTextCaptureConfig;
  text: string;
  sourceMessageKey: string;
  promptInstanceId?: string;
  timeoutMs?: number;
}

export type ForwardTextCaptureOutcome =
  | 'saved'
  | 'replayed'
  | 'rejected'
  | 'unconfirmed';

export interface ForwardTextCaptureResult {
  outcome: ForwardTextCaptureOutcome;
  captureId?: string;
  entryId?: number;
  code?: string;
}

export const LIFE_TEXT_MAX_CHARS = 20000;
export const LIFE_TEXT_TIMEOUT_MS = 10000;
export const LIFE_TEXT_CAPTURES_PATH = '/api/v1/journals/{journalId}/text/captures';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function buildTextCaptureUrl(baseUrl: string, journalId: string): string {
  const base = trimTrailingSlash(baseUrl);
  const journalSegment = encodeURIComponent(journalId);
  return `${base}/api/v1/journals/${journalSegment}/text/captures`;
}

async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function captureIdFromData(data: Record<string, unknown>): string | undefined {
  for (const key of ['captureId', 'id', 'capture_id']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function entryIdFromData(data: Record<string, unknown>): number | undefined {
  for (const key of ['entryId', 'entry_id']) {
    const value = data[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}

export async function forwardTextCapture(
  input: ForwardTextCaptureInput,
): Promise<ForwardTextCaptureResult> {
  const { fetchImpl, config, sourceMessageKey: _sourceMessageKey } = input;
  void _sourceMessageKey;
  const text = input.text;
  const timeoutMs =
    typeof input.timeoutMs === 'number' &&
    Number.isFinite(input.timeoutMs) &&
    input.timeoutMs > 0
      ? input.timeoutMs
      : LIFE_TEXT_TIMEOUT_MS;

  if (!text || text.length === 0 || text.length > LIFE_TEXT_MAX_CHARS) {
    logger.warn({ code: 'invalid_payload' }, 'Life text capture rejected');
    return { outcome: 'rejected', code: 'invalid_payload' };
  }

  const url = buildTextCaptureUrl(config.baseUrl, config.journalId);
  const authHeader = `Bearer ${config.token}`;
  const payload: Record<string, unknown> = {
    sourceMessageKey: input.sourceMessageKey,
    text,
  };
  if (
    typeof input.promptInstanceId === 'string' &&
    input.promptInstanceId.length > 0
  ) {
    payload['promptInstanceId'] = input.promptInstanceId;
  }
  const body = JSON.stringify(payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const isTimeout =
      (err as { name?: string })?.name === 'AbortError' ||
      (err as { name?: string })?.name === 'TimeoutError';
    const code = isTimeout ? 'timeout' : 'transport_error';
    if (isTimeout) {
      logger.error({ code }, 'Life text capture timed out');
    } else {
      logger.error({ code }, 'Life text capture request failed');
    }
    return { outcome: 'unconfirmed', code };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    logger.warn(
      { code: 'auth_rejected', status: res.status },
      'Life text capture rejected',
    );
    return { outcome: 'rejected', code: 'auth_rejected' };
  }

  if (res.status === 409) {
    logger.warn(
      { code: 'conflict', status: res.status },
      'Life text capture conflict',
    );
    return { outcome: 'rejected', code: 'conflict' };
  }

  if (res.status === 400 || res.status === 422 || res.status === 404) {
    logger.warn(
      { code: 'invalid_payload', status: res.status },
      'Life text capture rejected',
    );
    return { outcome: 'rejected', code: 'invalid_payload' };
  }

  if (res.status >= 500) {
    logger.error(
      { code: 'server_error', status: res.status },
      'Life text capture server failure',
    );
    return { outcome: 'unconfirmed', code: 'server_error' };
  }

  const parsed = await readJsonBody(res);
  if (parsed['success'] !== true) {
    if (res.status >= 400 && res.status < 500) {
      logger.warn(
        { code: 'invalid_payload', status: res.status },
        'Life text capture rejected',
      );
      return { outcome: 'rejected', code: 'invalid_payload' };
    }
    logger.warn(
      { code: 'malformed_envelope', status: res.status },
      'Life text capture malformed envelope',
    );
    return { outcome: 'unconfirmed', code: 'malformed_envelope' };
  }

  const data = parsed['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    logger.warn(
      { code: 'malformed_envelope', status: res.status },
      'Life text capture malformed envelope',
    );
    return { outcome: 'unconfirmed', code: 'malformed_envelope' };
  }
  const dataRecord = data as Record<string, unknown>;

  const captureId = captureIdFromData(dataRecord);
  if (!captureId) {
    logger.warn(
      { code: 'missing_capture_id', status: res.status },
      'Life text capture missing capture id',
    );
    return { outcome: 'unconfirmed', code: 'missing_capture_id' };
  }

  const entryId = entryIdFromData(dataRecord);
  if (entryId === undefined) {
    logger.warn(
      { code: 'missing_entry_id', status: res.status },
      'Life text capture missing entry id',
    );
    return { outcome: 'unconfirmed', code: 'missing_entry_id' };
  }

  const replayed = dataRecord['replayed'] === true;
  if (res.status === 201 && !replayed) {
    logger.info({ code: 'saved' }, 'Life text capture saved');
    return { outcome: 'saved', captureId, entryId };
  }
  if (res.status === 200 && replayed) {
    logger.info({ code: 'replayed' }, 'Life text capture replayed');
    return { outcome: 'replayed', captureId, entryId };
  }

  logger.warn(
    { code: 'unexpected_status', status: res.status },
    'Life text capture unexpected status',
  );
  return { outcome: 'unconfirmed', code: 'unexpected_status' };
}
