import crypto from 'crypto';

import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import {
  getLifePromptDeliveryReceipts,
  insertLifePromptDeliveryReceipt,
  listUnacknowledgedLifePromptIds,
  markLifePromptDeliveryAcknowledged,
  updateLifePromptDeliverySourceKey,
  type LifePromptDeliveryScope,
} from '../db/life-prompt-deliveries.js';

export const LIFE_PROMPT_POLL_INTERVAL_MS = 60000;
export const LIFE_PROMPT_REQUEST_TIMEOUT_MS = 10000;
export const TELEGRAM_PROMPT_MAX_LENGTH = 4096;
export const LIFE_PROMPT_SOURCE_KEY_MAX = 256;

export interface LifePromptDeliveryConfig {
  baseUrl: string;
  journalId: string;
  token: string;
}

export interface LifePromptDeliveryItem {
  promptInstanceId: string;
  kind: string;
  promptText: string;
}

export interface PromptBotAdapter {
  getChatType(chatId: string): Promise<string | undefined>;
  sendText(chatId: string, text: string): Promise<number>;
}

export type LifePromptFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface LifePromptDeliveryDeps {
  configProvider: () => LifePromptDeliveryConfig | null;
  groupsProvider: () => Record<string, RegisteredGroup>;
  botProvider: () => PromptBotAdapter | null;
  fetchImpl?: LifePromptFetch;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

const CONVERSATION_STARTER_LABEL = 'Conversation starter';

const KIND_LABELS: Record<string, string> = {
  morning: 'Morning check-in',
  evening: 'Evening reflection',
  checkin: 'Check-in',
  check_in: 'Check-in',
  reflection: 'Reflection',
  nudge: 'Nudge',
  reminder: 'Reminder',
  prompt: 'Prompt',
  journal: 'Journal prompt',
  reflective_question: 'Reflective question',
  ai_follow_up: 'AI follow-up',
  archive_gap: 'Archive gap',
  recording_gap: 'Recording gap',
  recent_entry_follow_up: 'Recent follow-up',
  life_event: 'Life event',
};

const CURRENT_LIFE_KIND_COMPACTS: ReadonlySet<string> = new Set(
  [
    'reflective_question',
    'ai_follow_up',
    'archive_gap',
    'recording_gap',
    'recent_entry_follow_up',
    'life_event',
  ].map((key) => key.replace(/[\s_-]+/g, '')),
);

function compactKind(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function isCurrentLifeKind(kind: string): boolean {
  return CURRENT_LIFE_KIND_COMPACTS.has(compactKind(kind));
}

export function normalizeEndpoint(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function credentialFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function resolveCeoDestination(
  groups: Record<string, RegisteredGroup>,
): string | null {
  const matches = Object.keys(groups).filter((jid) => {
    const group = groups[jid];
    if (!group || group.folder !== 'ceo') return false;
    const m = jid.match(/^tg:(\d+)$/);
    if (!m) return false;
    const numeric = Number(m[1]);
    return Number.isInteger(numeric) && numeric > 0;
  });
  if (matches.length !== 1) return null;
  return matches[0];
}

export function ceoDestinationNumeric(destination: string): string {
  return destination.replace(/^tg:/, '');
}

export function kindLabelFor(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  const direct = KIND_LABELS[normalized];
  if (direct) return direct;
  const compact = normalized.replace(/[\s_-]+/g, '');
  for (const [key, label] of Object.entries(KIND_LABELS)) {
    if (key.replace(/[\s_-]+/g, '') === compact) return label;
  }
  return CONVERSATION_STARTER_LABEL;
}

export function buildPromptText(kind: string, promptText: string): string {
  return `${kindLabelFor(kind)}\n\n${promptText}`;
}

export function buildPromptParts(kind: string, promptText: string): string[] {
  if (!isCurrentLifeKind(kind)) {
    return splitTelegramParts(buildPromptText(kind, promptText));
  }
  const baseParts = splitTelegramParts(
    `${CONVERSATION_STARTER_LABEL}\n\n${promptText}`,
  );
  const label = kindLabelFor(kind);
  const first = label + baseParts[0].slice(CONVERSATION_STARTER_LABEL.length);
  return [first, ...baseParts.slice(1)];
}

export function splitTelegramParts(fullText: string): string[] {
  if (fullText.length <= TELEGRAM_PROMPT_MAX_LENGTH) return [fullText];
  const parts: string[] = [];
  for (let i = 0; i < fullText.length; i += TELEGRAM_PROMPT_MAX_LENGTH) {
    parts.push(fullText.slice(i, i + TELEGRAM_PROMPT_MAX_LENGTH));
  }
  return parts;
}

export function buildSourceMessageKey(
  destinationNumeric: string,
  messageIds: number[],
): string {
  const printable = messageIds
    .map((id) => String(Math.trunc(id)))
    .join('.');
  const direct = `telegram:${destinationNumeric}:${printable}`;
  if (direct.length <= LIFE_PROMPT_SOURCE_KEY_MAX) return direct;
  const digest = crypto
    .createHash('sha256')
    .update(`${destinationNumeric}:${printable}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `telegram:${destinationNumeric}:sha256:${digest}`;
}

export function buildOutboxUrl(endpoint: string, journalId: string): string {
  return `${normalizeEndpoint(endpoint)}/api/v1/journals/${encodeURIComponent(journalId)}/prompt-instances/telegram-outbox`;
}

export function buildDeliveryUrl(
  endpoint: string,
  journalId: string,
  promptInstanceId: string,
): string {
  return `${normalizeEndpoint(endpoint)}/api/v1/journals/${encodeURIComponent(journalId)}/prompt-instances/${encodeURIComponent(promptInstanceId)}/telegram-delivery`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deliveryItemFromRecord(
  value: unknown,
): LifePromptDeliveryItem | undefined {
  if (!isRecord(value)) return undefined;
  const rawId =
    value['promptInstanceId'] ?? value['prompt_instance_id'] ?? value['id'];
  const rawKind = value['kind'];
  const rawCanonicalText = value['prompt'];
  const rawLegacyText =
    value['promptText'] ?? value['prompt_text'] ?? value['text'];
  let rawText: unknown;
  let isCanonical = false;
  if (typeof rawCanonicalText === 'string' && rawCanonicalText.length > 0) {
    rawText = rawCanonicalText;
    isCanonical = true;
  } else {
    rawText = rawLegacyText;
  }
  if (typeof rawId !== 'string' || rawId.length === 0) return undefined;
  if (typeof rawText !== 'string' || rawText.length === 0) return undefined;
  if (typeof rawKind === 'string' && rawKind.length > 0) {
    return { promptInstanceId: rawId, kind: rawKind, promptText: rawText };
  }
  if (rawKind === null && isCanonical) {
    return { promptInstanceId: rawId, kind: '', promptText: rawText };
  }
  return undefined;
}

export function parseOutboxEnvelope(
  body: unknown,
): LifePromptDeliveryItem[] | undefined {
  if (!isRecord(body)) return undefined;
  if (body['success'] !== true) return undefined;
  const data = body['data'];
  if (!isRecord(data)) return undefined;
  const deliveries = data['deliveries'];
  if (!Array.isArray(deliveries)) return undefined;
  const items: LifePromptDeliveryItem[] = [];
  for (const entry of deliveries) {
    const item = deliveryItemFromRecord(entry);
    if (!item) return undefined;
  }
  for (const entry of deliveries) {
    items.push(deliveryItemFromRecord(entry) as LifePromptDeliveryItem);
  }
  return items;
}

function deliveryAckIdFromData(data: Record<string, unknown>): string | undefined {
  for (const key of ['promptInstanceId', 'prompt_instance_id', 'id']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    if (isRecord(body)) return body;
    return {};
  } catch {
    return {};
  }
}

async function fetchWithTimeout(
  fetchImpl: LifePromptFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class LifePromptDeliveryConsumer {
  private deps: LifePromptDeliveryDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private stopped = true;

  constructor(deps: LifePromptDeliveryDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.pollOnce();
    const interval =
      this.deps.pollIntervalMs ?? LIFE_PROMPT_POLL_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, interval);
    if (typeof this.timer === 'object' && this.timer !== null) {
      const t = this.timer as unknown as { unref?: () => void };
      if (typeof t.unref === 'function') t.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    if (this.stopped || this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.tick();
    } finally {
      this.tickRunning = false;
    }
  }

  private currentScope(
    config: LifePromptDeliveryConfig,
    destination: string,
  ): LifePromptDeliveryScope {
    return {
      endpoint: normalizeEndpoint(config.baseUrl),
      journalId: config.journalId,
      credentialFingerprint: credentialFingerprint(config.token),
      destination,
    };
  }

  private async verifiedDestination(
    config: LifePromptDeliveryConfig,
  ): Promise<{ destination: string; numeric: string; scope: LifePromptDeliveryScope } | null> {
    const destination = resolveCeoDestination(this.deps.groupsProvider());
    if (!destination) {
      logger.warn(
        { code: 'prompt_delivery_no_destination' },
        'Life prompt delivery inactive',
      );
      return null;
    }
    const bot = this.deps.botProvider();
    if (!bot) return null;
    const numeric = ceoDestinationNumeric(destination);
    let chatType: string | undefined;
    try {
      chatType = await bot.getChatType(numeric);
    } catch {
      logger.warn(
        { code: 'prompt_delivery_verify_failed' },
        'Life prompt delivery verification failed',
      );
      return null;
    }
    if (chatType !== 'private') {
      logger.warn(
        { code: 'prompt_delivery_not_private' },
        'Life prompt delivery inactive',
      );
      return null;
    }
    return { destination, numeric, scope: this.currentScope(config, destination) };
  }

  private async readOutbox(
    config: LifePromptDeliveryConfig,
  ): Promise<LifePromptDeliveryItem[] | null> {
    const fetchImpl =
      this.deps.fetchImpl ??
      (fetch as unknown as LifePromptFetch);
    const timeoutMs =
      this.deps.requestTimeoutMs ?? LIFE_PROMPT_REQUEST_TIMEOUT_MS;
    const url = buildOutboxUrl(config.baseUrl, config.journalId);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        fetchImpl,
        url,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${config.token}` },
        },
        timeoutMs,
      );
    } catch {
      logger.warn(
        { code: 'prompt_delivery_outbox_unreachable' },
        'Life prompt outbox unreachable',
      );
      return null;
    }
    if (!res.ok) {
      logger.warn(
        { code: 'prompt_delivery_outbox_rejected', status: res.status },
        'Life prompt outbox rejected',
      );
      return null;
    }
    const body = await readJsonBody(res);
    const items = parseOutboxEnvelope(body);
    if (!items) {
      logger.warn(
        { code: 'prompt_delivery_outbox_malformed', status: res.status },
        'Life prompt outbox malformed',
      );
      return null;
    }
    return items;
  }

  private async sendPromptParts(
    bot: PromptBotAdapter,
    numeric: string,
    scope: LifePromptDeliveryScope,
    item: LifePromptDeliveryItem,
  ): Promise<number[] | null> {
    const parts = buildPromptParts(item.kind, item.promptText);
    const existing = getLifePromptDeliveryReceipts(
      scope,
      item.promptInstanceId,
    );
    if (existing.length > 0) {
      const recordedCount = existing[0].part_count;
      if (recordedCount !== parts.length) {
        logger.warn(
          { code: 'prompt_delivery_part_mismatch' },
          'Life prompt delivery paused',
        );
        return null;
      }
      const byIndex = new Map(existing.map((r) => [r.part_index, r]));
      let complete = true;
      for (let i = 0; i < parts.length; i += 1) {
        if (!byIndex.has(i)) {
          complete = false;
          break;
        }
      }
      if (complete) {
        return existing
          .slice()
          .sort((a, b) => a.part_index - b.part_index)
          .map((r) => r.telegram_message_id);
      }
    }
    const knownIds: number[] = existing
      .slice()
      .sort((a, b) => a.part_index - b.part_index)
      .map((r) => r.telegram_message_id);
    const existingIndexes = new Set(existing.map((r) => r.part_index));
    for (let i = 0; i < parts.length; i += 1) {
      if (this.stopped) return null;
      if (existingIndexes.has(i)) continue;
      if (i > 0) {
        const config = this.deps.configProvider();
        if (!config) return null;
        const fresh = await this.readOutbox(config);
        if (!fresh || !fresh.some((d) => d.promptInstanceId === item.promptInstanceId)) {
          logger.warn(
            { code: 'prompt_delivery_withdrawn' },
            'Life prompt delivery paused',
          );
          return null;
        }
        const recheck = await this.verifiedDestination(config);
        if (!recheck || recheck.destination !== scope.destination) {
          logger.warn(
            { code: 'prompt_delivery_route_changed' },
            'Life prompt delivery paused',
          );
          return null;
        }
      }
      let messageId: number;
      try {
        messageId = await bot.sendText(numeric, parts[i]);
      } catch {
        logger.warn(
          { code: 'prompt_delivery_send_failed' },
          'Life prompt delivery send failed',
        );
        return null;
      }
      if (this.stopped) return null;
      if (!Number.isInteger(messageId)) {
        logger.warn(
          { code: 'prompt_delivery_send_failed' },
          'Life prompt delivery send failed',
        );
        return null;
      }
      knownIds[i] = messageId;
      const provisional = buildSourceMessageKey(numeric, [messageId]);
      try {
        insertLifePromptDeliveryReceipt({
          scope,
          promptInstanceId: item.promptInstanceId,
          partIndex: i,
          partCount: parts.length,
          telegramMessageId: messageId,
          sourceMessageKey: provisional,
        });
      } catch {
        logger.warn(
          { code: 'prompt_delivery_receipt_failed' },
          'Life prompt delivery receipt failed',
        );
        return null;
      }
      existingIndexes.add(i);
    }
    const ordered = knownIds.slice(0, parts.length);
    if (ordered.length !== parts.length || ordered.some((id) => !Number.isInteger(id))) {
      return null;
    }
    return ordered;
  }

  private async acknowledgePrompt(
    config: LifePromptDeliveryConfig,
    scope: LifePromptDeliveryScope,
    promptInstanceId: string,
    numeric: string,
    messageIds: number[],
  ): Promise<boolean> {
    if (this.stopped) return false;
    const sourceMessageKey = buildSourceMessageKey(numeric, messageIds);
    try {
      updateLifePromptDeliverySourceKey(scope, promptInstanceId, sourceMessageKey);
    } catch {
      logger.warn(
        { code: 'prompt_delivery_receipt_failed' },
        'Life prompt delivery receipt failed',
      );
      return false;
    }
    const fetchImpl =
      this.deps.fetchImpl ??
      (fetch as unknown as LifePromptFetch);
    const timeoutMs =
      this.deps.requestTimeoutMs ?? LIFE_PROMPT_REQUEST_TIMEOUT_MS;
    const url = buildDeliveryUrl(config.baseUrl, config.journalId, promptInstanceId);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sourceMessageKey }),
        },
        timeoutMs,
      );
    } catch {
      logger.warn(
        { code: 'prompt_delivery_ack_unreachable' },
        'Life prompt delivery acknowledgment pending',
      );
      return false;
    }
    if (res.status === 409) {
      logger.warn(
        { code: 'prompt_delivery_ack_conflict', status: res.status },
        'Life prompt delivery acknowledgment conflict',
      );
      return false;
    }
    if (!res.ok) {
      logger.warn(
        { code: 'prompt_delivery_ack_rejected', status: res.status },
        'Life prompt delivery acknowledgment pending',
      );
      return false;
    }
    const body = await readJsonBody(res);
    if (body['success'] !== true || !isRecord(body['data'])) {
      logger.warn(
        { code: 'prompt_delivery_ack_malformed', status: res.status },
        'Life prompt delivery acknowledgment pending',
      );
      return false;
    }
    const returnedId = deliveryAckIdFromData(body['data'] as Record<string, unknown>);
    if (!returnedId || returnedId !== promptInstanceId) {
      logger.warn(
        { code: 'prompt_delivery_ack_mismatch', status: res.status },
        'Life prompt delivery acknowledgment mismatch',
      );
      return false;
    }
    try {
      markLifePromptDeliveryAcknowledged(scope, promptInstanceId);
    } catch {
      logger.warn(
        { code: 'prompt_delivery_receipt_failed' },
        'Life prompt delivery receipt failed',
      );
      return false;
    }
    logger.info(
      { code: 'prompt_delivery_acknowledged' },
      'Life prompt delivery acknowledged',
    );
    return true;
  }

  private async tick(): Promise<void> {
    const config = this.deps.configProvider();
    if (!config) {
      logger.warn(
        { code: 'prompt_delivery_no_config' },
        'Life prompt delivery inactive',
      );
      return;
    }
    const verified = await this.verifiedDestination(config);
    if (!verified || this.stopped) return;
    const bot = this.deps.botProvider();
    if (!bot || this.stopped) return;
    const items = await this.readOutbox(config);
    if (!items || this.stopped) return;
    const handled = new Set<string>();
    for (const item of items) {
      if (this.stopped) return;
      const current = this.deps.configProvider();
      if (!current) return;
      const recheck = await this.verifiedDestination(current);
      if (!recheck || recheck.destination !== verified.destination) {
        logger.warn(
          { code: 'prompt_delivery_route_changed' },
          'Life prompt delivery paused',
        );
        return;
      }
      const scope = this.currentScope(current, verified.destination);
      const receipts = getLifePromptDeliveryReceipts(scope, item.promptInstanceId);
      const acknowledged =
        receipts.length > 0 && receipts.every((r) => r.acknowledged === 1);
      if (acknowledged) {
        handled.add(item.promptInstanceId);
        continue;
      }
      const messageIds = await this.sendPromptParts(
        bot,
        verified.numeric,
        scope,
        item,
      );
      if (!messageIds) continue;
      await this.acknowledgePrompt(
        current,
        scope,
        item.promptInstanceId,
        verified.numeric,
        messageIds,
      );
      handled.add(item.promptInstanceId);
      if (this.stopped) return;
    }
    if (this.stopped) return;
    const pending = listUnacknowledgedLifePromptIds(verified.scope);
    for (const promptInstanceId of pending) {
      if (this.stopped) return;
      if (handled.has(promptInstanceId)) continue;
      const current = this.deps.configProvider();
      if (!current) return;
      const recheck = await this.verifiedDestination(current);
      if (!recheck || recheck.destination !== verified.destination) return;
      const scope = this.currentScope(current, verified.destination);
      const receipts = getLifePromptDeliveryReceipts(scope, promptInstanceId);
      if (receipts.length === 0) continue;
      const ordered = receipts
        .slice()
        .sort((a, b) => a.part_index - b.part_index);
      const partCount = ordered[0].part_count;
      if (ordered.length !== partCount) continue;
      if (ordered.some((r) => r.part_count !== partCount)) continue;
      await this.acknowledgePrompt(
        current,
        scope,
        promptInstanceId,
        verified.numeric,
        ordered.map((r) => r.telegram_message_id),
      );
    }
  }
}
