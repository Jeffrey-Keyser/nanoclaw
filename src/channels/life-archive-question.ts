import { logger } from '../logger.js';

export interface LifeArchiveQuestionConfig {
  baseUrl: string;
  journalId: string;
  token: string;
}

export type LifeArchiveQuestionFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ForwardArchiveQuestionInput {
  fetchImpl: LifeArchiveQuestionFetch;
  config: LifeArchiveQuestionConfig;
  question: string;
  sourceThreadKey: string;
  sourceMessageKey: string;
  timeoutMs?: number;
}

export type ForwardArchiveQuestionOutcome =
  | 'answered'
  | 'replayed'
  | 'rejected'
  | 'unconfirmed';

export interface ForwardArchiveQuestionResult {
  outcome: ForwardArchiveQuestionOutcome;
  answer?: string;
  code?: string;
}

export const LIFE_ARCHIVE_QUESTION_MAX_CHARS = 8000;
export const LIFE_ARCHIVE_QUESTION_TIMEOUT_MS = 30000;
export const TELEGRAM_ARCHIVE_ANSWER_MAX_LENGTH = 4096;

export const LIFE_ARCHIVE_QUESTION_GUIDANCE = {
  usage: 'Usage: /lifeask <question>',
  rejected: 'Life ask rejected.',
  unavailable: 'Life ask unavailable.',
  unconfirmed: 'Life ask unconfirmed.',
} as const;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function buildArchiveQuestionUrl(
  baseUrl: string,
  journalId: string,
): string {
  const base = trimTrailingSlash(baseUrl);
  const journalSegment = encodeURIComponent(journalId);
  return `${base}/api/v1/journals/${journalSegment}/archive-questions`;
}

export function buildSourceThreadKey(chatId: string): string {
  return `telegram:${chatId}`;
}

export function buildSourceMessageKey(
  chatId: string,
  messageId: string,
): string {
  return `telegram:${chatId}:${messageId}`;
}

export function splitArchiveAnswerParts(answer: string): string[] {
  if (answer.length <= TELEGRAM_ARCHIVE_ANSWER_MAX_LENGTH) return [answer];
  const parts: string[] = [];
  for (
    let i = 0;
    i < answer.length;
    i += TELEGRAM_ARCHIVE_ANSWER_MAX_LENGTH
  ) {
    parts.push(answer.slice(i, i + TELEGRAM_ARCHIVE_ANSWER_MAX_LENGTH));
  }
  return parts;
}

export function extractLifeAskPayload(
  match: unknown,
  messageText: string,
  entities?: Array<{ type: string; offset: number; length: number }>,
): string {
  if (typeof match === 'string') return match;
  const list = entities ?? [];
  const cmd = list.find((e) => e.type === 'bot_command' && e.offset === 0);
  if (!cmd) {
    const m = messageText.match(/^\/lifeask(?:@[A-Za-z0-9_]+)?\s*([\s\S]*)$/);
    return m ? (m[1] ?? '') : '';
  }
  return messageText.slice(cmd.offset + cmd.length);
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function entryCountFromData(data: Record<string, unknown>): number | undefined {
  for (const key of ['entryCount', 'entry_count', 'entriesCount']) {
    const value = data[key];
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0
    ) {
      return value;
    }
  }
  return undefined;
}

export async function forwardArchiveQuestion(
  input: ForwardArchiveQuestionInput,
): Promise<ForwardArchiveQuestionResult> {
  const { fetchImpl, config, sourceThreadKey, sourceMessageKey } = input;
  const question = input.question;
  const timeoutMs =
    typeof input.timeoutMs === 'number' &&
    Number.isFinite(input.timeoutMs) &&
    input.timeoutMs > 0
      ? input.timeoutMs
      : LIFE_ARCHIVE_QUESTION_TIMEOUT_MS;

  if (
    !question ||
    question.length === 0 ||
    question.length > LIFE_ARCHIVE_QUESTION_MAX_CHARS
  ) {
    logger.warn({ code: 'invalid_payload' }, 'Life archive question rejected');
    return { outcome: 'rejected', code: 'invalid_payload' };
  }

  const url = buildArchiveQuestionUrl(config.baseUrl, config.journalId);
  const authHeader = `Bearer ${config.token}`;
  const body = JSON.stringify({
    sourceThreadKey,
    sourceMessageKey,
    question,
  });

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
      logger.error({ code }, 'Life archive question timed out');
    } else {
      logger.error({ code }, 'Life archive question request failed');
    }
    return { outcome: 'unconfirmed', code };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    logger.warn(
      { code: 'auth_rejected', status: res.status },
      'Life archive question rejected',
    );
    return { outcome: 'rejected', code: 'auth_rejected' };
  }

  if (res.status === 409) {
    logger.warn(
      { code: 'conflict', status: res.status },
      'Life archive question conflict',
    );
    return { outcome: 'rejected', code: 'conflict' };
  }

  if (res.status === 400 || res.status === 422 || res.status === 404) {
    logger.warn(
      { code: 'invalid_payload', status: res.status },
      'Life archive question rejected',
    );
    return { outcome: 'rejected', code: 'invalid_payload' };
  }

  if (res.status >= 500) {
    logger.error(
      { code: 'server_error', status: res.status },
      'Life archive question server failure',
    );
    return { outcome: 'unconfirmed', code: 'server_error' };
  }

  const parsed = await readJsonBody(res);
  if (parsed['success'] !== true) {
    if (res.status >= 400 && res.status < 500) {
      logger.warn(
        { code: 'invalid_payload', status: res.status },
        'Life archive question rejected',
      );
      return { outcome: 'rejected', code: 'invalid_payload' };
    }
    logger.warn(
      { code: 'malformed_envelope', status: res.status },
      'Life archive question malformed envelope',
    );
    return { outcome: 'unconfirmed', code: 'malformed_envelope' };
  }

  const data = parsed['data'];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    logger.warn(
      { code: 'malformed_envelope', status: res.status },
      'Life archive question malformed envelope',
    );
    return { outcome: 'unconfirmed', code: 'malformed_envelope' };
  }
  const record = data as Record<string, unknown>;

  const threadKey = record['threadKey'] ?? record['sourceThreadKey'];
  if (!nonEmptyString(threadKey)) {
    logger.warn(
      { code: 'missing_thread_key', status: res.status },
      'Life archive question missing thread identity',
    );
    return { outcome: 'unconfirmed', code: 'missing_thread_key' };
  }
  if (threadKey !== sourceThreadKey) {
    logger.warn(
      { code: 'thread_mismatch', status: res.status },
      'Life archive question thread mismatch',
    );
    return { outcome: 'unconfirmed', code: 'thread_mismatch' };
  }

  const turnId = record['turnId'] ?? record['turn_id'];
  if (!nonEmptyString(turnId)) {
    logger.warn(
      { code: 'missing_turn_id', status: res.status },
      'Life archive question missing turn identity',
    );
    return { outcome: 'unconfirmed', code: 'missing_turn_id' };
  }

  const answer = record['answer'];
  if (!nonEmptyString(answer)) {
    logger.warn(
      { code: 'missing_answer', status: res.status },
      'Life archive question missing answer',
    );
    return { outcome: 'unconfirmed', code: 'missing_answer' };
  }

  const generation = record['generation'];
  if (!nonEmptyString(generation)) {
    logger.warn(
      { code: 'missing_generation', status: res.status },
      'Life archive question missing generation',
    );
    return { outcome: 'unconfirmed', code: 'missing_generation' };
  }

  const entryCount = entryCountFromData(record);
  if (entryCount === undefined) {
    logger.warn(
      { code: 'missing_entry_count', status: res.status },
      'Life archive question missing entry count',
    );
    return { outcome: 'unconfirmed', code: 'missing_entry_count' };
  }

  const replayed = record['replayed'] === true;
  if (res.status === 201 && !replayed) {
    logger.info({ code: 'answered' }, 'Life archive question answered');
    return { outcome: 'answered', answer };
  }
  if (res.status === 200 && replayed) {
    logger.info({ code: 'replayed' }, 'Life archive question replayed');
    return { outcome: 'replayed', answer };
  }

  logger.warn(
    { code: 'unexpected_status', status: res.status },
    'Life archive question unexpected status',
  );
  return { outcome: 'unconfirmed', code: 'unexpected_status' };
}
