# Life Prompt Delivery

NanoClaw reuses the existing Life configuration (`LIFE_API_URL`, `LIFE_JOURNAL_ID`, `LIFE_API_TOKEN`) to deliver Life's queued prompts through the existing Telegram bot.

## Activation

The consumer starts after either Telegram transport (polling or webhook) connects and stops on disconnect. Delivery requires all of the following:

- Life configuration present (`LIFE_API_URL`, `LIFE_JOURNAL_ID`, `LIFE_API_TOKEN`).
- Exactly one registered positive Telegram destination (`tg:<id>`) whose folder is `ceo`.
- Bot verification that the destination chat type is `private`.
- Routing is revalidated before sends; missing, ambiguous, or non-private routing leaves the integration inactive.

## Polling

After a successful connection the consumer polls immediately, then every 60 seconds. Ticks are serialized so overlapping polls never run concurrently, requests are bounded with an abort timeout, and disconnect cancels further polling and prevents subsequent sends.

Each tick reads the canonical outbox:

`GET /api/v1/journals/{journalId}/prompt-instances/telegram-outbox`

with bearer authorization, and validates the `success` / `data.deliveries` envelope. Empty, rejected, or malformed reads send nothing. Life remains the sole prompt issuance and eligibility owner.

Eligible items carry `promptInstanceId` (or `prompt_instance_id` / `id`), `kind`, and the retained canonical `prompt` (`promptText` / `prompt_text` / `text` remain accepted as legacy spellings). The consumer sends a plain-text kind label followed by the exact retained prompt (`<label>\n\n<prompt>`). Current Life kinds map to distinct owner-facing labels: `reflective_question` to `Reflective question`, `ai_follow_up` to `AI follow-up`, `archive_gap` to `Archive gap`, `recording_gap` to `Recording gap`, `recent_entry_follow_up` to `Recent follow-up`, and `life_event` to `Life event`. Known legacy kinds keep their existing labels; an explicit canonical `kind: null` and any unrecognized string use `Conversation starter`. Malformed envelopes (missing identity, missing prompt text, or missing/invalid kind outside the canonical null case) send nothing. Messages are split deterministically within Telegram's 4096-character limit.

For the six current kinds, the consumer splits the former `Conversation starter` rendering first and then substitutes the shorter kind label in the first part. Body segments keep their original indices and the part count is unchanged, so existing receipts stay valid and previously confirmed Telegram messages keep their original headers.

Before each unsent prompt, and before each remaining multipart part, the consumer rechecks current outbox eligibility. When an instance disappears, unsent work pauses and no acknowledgment is sent for it.

## Receipts and restart

Confirmed Telegram message identities are persisted before acknowledgment in additive local SQLite storage (`migrations/013_life_prompt_deliveries.sql`), scoped by endpoint, journal, credential fingerprint, verified destination, and prompt instance. Bearer tokens are never persisted; only a SHA-256 fingerprint scopes the rows.

After all parts are confirmed, the consumer acknowledges:

`POST /api/v1/journals/{journalId}/prompt-instances/{promptInstanceId}/telegram-delivery`

with a stable printable `sourceMessageKey` derived from the destination and confirmed Telegram message identity (within Life's 256-character limit). The returned prompt identity must match before the receipt is marked acknowledged. Failed sends are never acknowledged; failed or conflicting acknowledgments retain receipts without resending confirmed parts.

Restart resumes acknowledgment from confirmed receipts without repeating recorded parts, including when current eligibility reads suppress the instance. Configuration changes never send or acknowledge another scope's work.

## Uncertain-send window

A crash or uncertain network result after Telegram accepts a message but before receipt persistence can still cause a repeat send on retry. Receipt persistence happens immediately after each confirmed send to narrow this window, but the transport does not provide exactly-once delivery. Live delivery quality and owner assessment of prompt text remain operational evaluations outside automated verification.

## Prompt replies (text and voice)

An ordinary owner reply to a retained delivered prompt is routed before
unrelated flows: text before pending-response and assistant handling,
voice before generic storage and forwarding. Each matched reply receives
exactly one routing decision. Admission requires the owner sender in the
registered private `ceo` destination with current Life configuration,
endpoint normalization, credential fingerprinting, and destination
verification. Slash commands bypass reply routing.

Reverse lookup uses the complete current delivery scope plus
`reply_to_message.message_id`. Any confirmed multipart receipt part
identifies its prompt, including before acknowledgment succeeds. Exactly
one distinct prompt identity is required. Unknown messages remain ordinary
messages; ambiguous matches and lookup failures stop capture with
contained guidance and never supply a guessed prompt.

Both forwarders accept an optional `promptInstanceId`: text includes it in
the JSON receipt, voice includes it in the initial multipart receipt. The
original audio bytes and the existing receipt, processing, review, and
completion protocol are preserved. The incoming reply's Telegram identity
supplies `sourceMessageKey`; the delivered prompt message supplies only
the association lookup. Redelivery reuses these identities.

Life remains authoritative for prompt validity, account and journal scope,
replay conflicts, and transactional association. Receiver failures and
uncertain results never trigger an unassociated fallback. Historical
messages without retained receipts keep ordinary handling.

Text guidance preserves saved, rejected, and unconfirmed outcomes. Voice
guidance distinguishes completed, review-in-Life, and failed outcomes
without claiming unfinished processing succeeded:

- `Saved to Life.` — voice completed.
- `Voice held for review in Life.` — voice unresolved or awaiting review.
- `Life voice capture failed.` — voice receipt, processing, completion,
  download, or transport failure.
- `Life prompt reply ambiguous.` / `Life prompt reply unavailable.` —
  contained lookup stops without capture.

## Logging

Logs omit bearer tokens, prompt text, and unsafe raw transport errors. Entries carry stable codes such as `prompt_delivery_send_failed` and `prompt_delivery_acknowledged`. Prompt-reply diagnostics use fixed codes (`life_prompt_reply_lookup_failed`, `life_prompt_reply_ambiguous`, `life_prompt_reply_forward_failed`, `life_prompt_voice_download_failed`, `life_prompt_voice_too_large`, and related codes) without message bodies, audio, or credentials.
