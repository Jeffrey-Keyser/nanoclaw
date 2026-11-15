import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './index.js';
import {
  getLifePromptDeliveryReceipts,
  insertLifePromptDeliveryReceipt,
  isLifePromptDeliveryAcknowledged,
  listLifePromptDeliveryPromptIds,
  listUnacknowledgedLifePromptIds,
  markLifePromptDeliveryAcknowledged,
  updateLifePromptDeliverySourceKey,
  type LifePromptDeliveryScope,
} from './life-prompt-deliveries.js';

const SCOPE: LifePromptDeliveryScope = {
  endpoint: 'https://life.example.com',
  journalId: 'journal-1',
  credentialFingerprint: 'fp-aaa',
  destination: 'tg:111',
};

const OTHER_SCOPE: LifePromptDeliveryScope = {
  ...SCOPE,
  credentialFingerprint: 'fp-bbb',
};

describe('life-prompt-deliveries', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('persists confirmed part receipts scoped by endpoint journal credential destination and prompt', () => {
    insertLifePromptDeliveryReceipt({
      scope: SCOPE,
      promptInstanceId: 'prompt-1',
      partIndex: 0,
      partCount: 2,
      telegramMessageId: 501,
      sourceMessageKey: 'telegram:111:501',
    });
    insertLifePromptDeliveryReceipt({
      scope: SCOPE,
      promptInstanceId: 'prompt-1',
      partIndex: 1,
      partCount: 2,
      telegramMessageId: 502,
      sourceMessageKey: 'telegram:111:501.502',
    });

    const receipts = getLifePromptDeliveryReceipts(SCOPE, 'prompt-1');
    expect(receipts).toHaveLength(2);
    expect(receipts[0].part_index).toBe(0);
    expect(receipts[1].part_index).toBe(1);
    expect(receipts[0].telegram_message_id).toBe(501);
    expect(receipts[1].telegram_message_id).toBe(502);
    expect(receipts[0].acknowledged).toBe(0);
    expect(isLifePromptDeliveryAcknowledged(SCOPE, 'prompt-1')).toBe(false);
  });

  it('isolates receipts across credential fingerprints and destinations', () => {
    insertLifePromptDeliveryReceipt({
      scope: SCOPE,
      promptInstanceId: 'prompt-1',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 501,
      sourceMessageKey: 'telegram:111:501',
    });

    expect(getLifePromptDeliveryReceipts(OTHER_SCOPE, 'prompt-1')).toHaveLength(0);
    expect(
      getLifePromptDeliveryReceipts(
        { ...SCOPE, destination: 'tg:222' },
        'prompt-1',
      ),
    ).toHaveLength(0);
    expect(listLifePromptDeliveryPromptIds(SCOPE)).toEqual(['prompt-1']);
    expect(listLifePromptDeliveryPromptIds(OTHER_SCOPE)).toEqual([]);
  });

  it('retains unacknowledged state until explicitly marked and survives reinsert', () => {
    insertLifePromptDeliveryReceipt({
      scope: SCOPE,
      promptInstanceId: 'prompt-9',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 901,
      sourceMessageKey: 'telegram:111:901',
    });
    expect(listUnacknowledgedLifePromptIds(SCOPE)).toEqual(['prompt-9']);

    insertLifePromptDeliveryReceipt({
      scope: SCOPE,
      promptInstanceId: 'prompt-9',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 901,
      sourceMessageKey: 'telegram:111:901',
    });
    expect(isLifePromptDeliveryAcknowledged(SCOPE, 'prompt-9')).toBe(false);

    markLifePromptDeliveryAcknowledged(SCOPE, 'prompt-9');
    expect(isLifePromptDeliveryAcknowledged(SCOPE, 'prompt-9')).toBe(true);
    expect(listUnacknowledgedLifePromptIds(SCOPE)).toEqual([]);
  });

  it('updates the stable source key without touching other scopes', () => {
    insertLifePromptDeliveryReceipt({
      scope: SCOPE,
      promptInstanceId: 'prompt-2',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 701,
      sourceMessageKey: 'telegram:111:701',
    });
    insertLifePromptDeliveryReceipt({
      scope: OTHER_SCOPE,
      promptInstanceId: 'prompt-2',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 702,
      sourceMessageKey: 'telegram:111:702',
    });

    updateLifePromptDeliverySourceKey(SCOPE, 'prompt-2', 'telegram:111:701.final');

    const updated = getLifePromptDeliveryReceipts(SCOPE, 'prompt-2');
    expect(updated[0].source_message_key).toBe('telegram:111:701.final');
    const other = getLifePromptDeliveryReceipts(OTHER_SCOPE, 'prompt-2');
    expect(other[0].source_message_key).toBe('telegram:111:702');
  });

  it('never persists bearer tokens in stored rows', () => {
    insertLifePromptDeliveryReceipt({
      scope: SCOPE,
      promptInstanceId: 'prompt-3',
      partIndex: 0,
      partCount: 1,
      telegramMessageId: 801,
      sourceMessageKey: 'telegram:111:801',
    });
    const receipts = getLifePromptDeliveryReceipts(SCOPE, 'prompt-3');
    expect(JSON.stringify(receipts)).not.toContain('secret-token');
  });
});
