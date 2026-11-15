# Life archive questions (`/lifeask`)

Ask the Life archive a conversational question from Telegram and display its
grounded answer as plain text.

## Syntax

In the registered private `ceo` chat, send:

```
/lifeask <question>
```

- The command must come from the matching sender (the private chat owner).
- Bot-qualified commands (`/lifeask@<bot> <question>`) are accepted.
- Payload is everything after the command entity. Internal whitespace and
  punctuation are preserved; only surrounding whitespace is trimmed.
- Receiver limit: 1–8000 characters after trimming. Blank payloads receive
  usage guidance and oversized payloads are rejected, both without a Life
  request.

Explicit `/lifeask` commands bypass pending-reply and assistant handling.
Ordinary text and voice handling are unchanged.

## Configuration

Reuses the existing Life connection variables through the shared reader:

- `LIFE_API_URL`
- `LIFE_JOURNAL_ID`
- `LIFE_API_TOKEN`

Missing configuration produces an explicit unavailable reply and makes no
HTTP request.

## Receiver

`POST /api/v1/journals/{journalId}/archive-questions`

- JSON body: exactly `{ "sourceThreadKey": "telegram:<chatId>",
  "sourceMessageKey": "telegram:<chatId>:<messageId>",
  "question": "<trimmed>" }`
- Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
- Bounded timeout: 30s; single attempt, no automatic retries.

Life remains the sole answer and conversation-history owner. Successive
questions from one chat reuse the same continuing thread identity
(`telegram:<chatId>`) with a distinct message identity per Telegram message.
Redelivery preserves both identities and relies on Life's stored history.

The nested envelope is validated, including thread and turn identities,
generation, answer, and entry-count metadata:

```json
{
  "success": true,
  "data": {
    "threadKey": "telegram:111",
    "turnId": "turn-1",
    "answer": "...",
    "generation": "gen-1",
    "entryCount": 3,
    "replayed": false
  }
}
```

- `201` with `data.replayed: false` plus matching thread key, turn ID,
  non-empty answer and generation, and a non-negative entry count: new turn.
- `200` with `data.replayed: true` plus the same validated fields:
  confirmed replay (both source identities are reused on redelivery).
- `409` conflicts, `401`/`403` auth rejection, and `400`/`404`/`422`
  invalid payloads are confirmed rejections.
- `5xx`, timeouts, transport failures, and malformed envelopes (missing
  `success:true`, missing `data`, missing thread/turn/answer/generation/
  entry-count fields, thread mismatch, unexpected status) are unconfirmed.

## Replies

Concise replies never echo the submitted question:

- `<answer>` — validated answer delivered as plain text, split into ordered
  Telegram-sized (4096-character) parts preserving the text. Send failures
  stay contained.
- `Usage: /lifeask <question>` — blank payload.
- `Life ask unavailable.` — missing Life configuration.
- `Life ask rejected.` — invalid payload, conflict, or auth rejection.
- `Life ask unconfirmed.` — timeout, transport, server failure, or
  malformed/unexpected receipt.

Diagnostics use fixed codes (`timeout`, `transport_error`, `auth_rejected`,
`conflict`, `invalid_payload`, `malformed_envelope`, `missing_thread_key`,
`missing_turn_id`, `missing_answer`, `missing_generation`,
`missing_entry_count`, `thread_mismatch`, `server_error`,
`unexpected_status`) with safe chat/message identifiers, without logging
credentials, question or answer bodies, source keys, or raw transport errors.

## Rollout and compatibility

Uses the existing configured Life endpoint and credentials against its
already-mounted archive-question receiver. Missing configuration keeps the
command unavailable. Deploy NanoClaw through its established release process
after verification. No migration or additional package is required.
Application rollback leaves Life's retained question threads available.
