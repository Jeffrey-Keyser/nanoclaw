# Life text capture (`/life`)

Save an explicit Telegram message to Life as a typed text entry.

## Syntax

In the registered private `ceo` chat, send:

```
/life <text>
```

- The command must come from the matching sender (the private chat owner).
- Bot-qualified commands (`/life@<bot> <text>`) are accepted.
- Payload is everything after the command entity. Internal whitespace and
  punctuation are preserved; only surrounding whitespace is trimmed.
- Receiver limit: 1–20000 characters after trimming. Blank or oversized
  payloads are rejected without a Life request.

Explicit `/life` commands bypass pending-reply and assistant handling.
Ordinary text and voice handling are unchanged.

## Configuration

Reuses the existing Life connection variables through the shared reader:

- `LIFE_API_URL`
- `LIFE_JOURNAL_ID`
- `LIFE_API_TOKEN`

Missing configuration produces an explicit unavailable reply and makes no
HTTP request.

## Receiver

`POST /api/v1/journals/{journalId}/text/captures`

- JSON body: `{ "sourceMessageKey": "telegram:<chatId>:<messageId>", "text": "<trimmed>" }`
- Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
- Bounded timeout: 10s; single attempt, no automatic retries.

The nested envelope is validated:

```json
{ "success": true, "data": { "captureId": "cap-1", "entryId": 42 } }
```

- `201` with a capture ID and positive entry ID: new capture.
- `200` with `data.replayed: true` plus capture ID and positive entry ID:
  confirmed replay (same `sourceMessageKey` is reused on redelivery).
- `409` conflicts, `401`/`403` auth rejection, and `400`/`422` invalid
  payloads are confirmed rejections.
- `5xx`, timeouts, transport failures, and malformed envelopes (missing
  `success:true`, missing `data`, missing capture/entry IDs, unexpected
  status) are unconfirmed.

## Replies

Concise replies never echo submitted text:

- `Saved to Life.` — new capture or confirmed replay.
- `Life capture unavailable.` — missing Life configuration.
- `Life capture rejected.` — invalid payload, conflict, or auth rejection.
- `Life capture unconfirmed.` — timeout, transport, server failure, or
  malformed/unexpected receipt.

Diagnostics use fixed codes (`timeout`, `transport_error`, `auth_rejected`,
`conflict`, `invalid_payload`, `malformed_envelope`, `missing_capture_id`,
`missing_entry_id`, `server_error`, `unexpected_status`) without logging
text, credentials, source keys, or response bodies.
