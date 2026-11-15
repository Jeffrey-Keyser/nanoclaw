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

Eligible items carry `promptInstanceId`, `kind`, and the retained `promptText`. The consumer sends a plain-text kind label followed by the exact retained prompt (`<label>\n\n<promptText>`). Known kinds map to owner-facing labels; unknown historical kinds use `Conversation starter`. Messages are split deterministically within Telegram's 4096-character limit.

Before each unsent prompt, and before each remaining multipart part, the consumer rechecks current outbox eligibility. When an instance disappears, unsent work pauses and no acknowledgment is sent for it.

## Receipts and restart

Confirmed Telegram message identities are persisted before acknowledgment in additive local SQLite storage (`migrations/013_life_prompt_deliveries.sql`), scoped by endpoint, journal, credential fingerprint, verified destination, and prompt instance. Bearer tokens are never persisted; only a SHA-256 fingerprint scopes the rows.

After all parts are confirmed, the consumer acknowledges:

`POST /api/v1/journals/{journalId}/prompt-instances/{promptInstanceId}/telegram-delivery`

with a stable printable `sourceMessageKey` derived from the destination and confirmed Telegram message identity (within Life's 256-character limit). The returned prompt identity must match before the receipt is marked acknowledged. Failed sends are never acknowledged; failed or conflicting acknowledgments retain receipts without resending confirmed parts.

Restart resumes acknowledgment from confirmed receipts without repeating recorded parts, including when current eligibility reads suppress the instance. Configuration changes never send or acknowledge another scope's work.

## Uncertain-send window

A crash or uncertain network result after Telegram accepts a message but before receipt persistence can still cause a repeat send on retry. Receipt persistence happens immediately after each confirmed send to narrow this window, but the transport does not provide exactly-once delivery. Live delivery quality and owner assessment of prompt text remain operational evaluations outside automated verification.

## Logging

Logs omit bearer tokens, prompt text, and unsafe raw transport errors. Entries carry stable codes such as `prompt_delivery_send_failed` and `prompt_delivery_acknowledged`.
