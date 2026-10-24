---
name: logos
description: Forward the daily Logos proposals digest to Telegram, and route typed approve/reject/comment replies on Logos proposals back to the Logos API. Use when a `logos.digest.ready` event arrives on RabbitMQ exchange `logos.events`, or when an incoming Telegram message matches the `approve <id>` / `reject <id> <reason>` / `comment <id> <text>` reply grammar. New-proposal notifications are Agency HQ approve/reject cards, not this skill.
allowed-tools: Bash(curl:*), Bash(rabbitmqadmin:*), Bash(jq:*)
---

# Logos Proposal Replies + Daily Digest

Logos publishes proposal lifecycle events on the `logos.events` topic exchange (RabbitMQ). This skill forwards `logos.digest.ready` to Telegram and routes the user's typed reply on a proposal back to the Logos HTTP API.

> **New proposals arrive as Agency HQ cards.** Agency HQ consumes `logos.proposal.created` (queue `agency-hq.logos-proposal-cards`) and sends one Telegram card per proposal with ✅ Approve and preset ❌ reject buttons. Those taps go straight from Agency HQ to Logos. **Do not send your own nudge for `logos.proposal.created`** — it would duplicate the card. Typed `comment <short-id> …` replies (requested by the card) and typed approve/reject replies still come through you.

## Endpoints + constants

```
RabbitMQ exchange:  logos.events            (topic, durable)
Routing keys (in):  logos.proposal.created
                    logos.digest.ready
Logos base URL:     https://logos.jeffreykeyser.net
Auth:               Authorization: Bearer ${LOGOS_SERVICE_TOKEN}
Endpoints:
  POST /v1/proposals/:id/approve   — body: {} (empty)
  POST /v1/proposals/:id/reject    — body: { "reason": "<text>" }
  POST /v1/proposals/:id/comment   — body: { "comment": "<text>" }
```

> **Comment payload key.** Logos expects `{ "comment": "..." }`, **not** `{ "text": "..." }`. The user-facing reply command uses the word `comment`, but the JSON field on the wire is also `comment` — keep them aligned.

## Event payload (`logos.proposal.created`)

```json
{
  "proposal_id": "<uuid>",
  "page_slug":   "<slug-or-null-for-new>",
  "kind":        "create_page" | "update_page"
}
```

Source of truth: `LogosProposalCreatedEvent` in `@jeffrey-keyser/message-contracts/dist/logos/events.d.ts`. Field names are snake_case to match the wire format. The daily digest event (`logos.digest.ready`) has its own section below; everything else on this exchange (`logos.ingest.completed`, `logos.proposal.applied`, etc.) is out of scope.

## When `logos.proposal.created` arrives

Do nothing. Agency HQ owns the notification (see above). The payload is documented above only so replies can be understood.

## Reply parsing

Match incoming Telegram text against the following grammar. Commands are **case-insensitive**; `<id>` is the 8-char short-id; whitespace between tokens is collapsed.

| Reply | Regex (anchored, `i` flag) |
|---|---|
| Approve | `^\s*approve\s+([0-9a-f]{8})\s*$` |
| Reject  | `^\s*reject\s+([0-9a-f]{8})\s+(.+\S)\s*$` |
| Comment | `^\s*comment\s+([0-9a-f]{8})\s+(.+\S)\s*$` |

If the input doesn't match any of these, **don't act** — leave it for the normal conversational path. False positives here would call Logos with garbage.

## Short-id resolution

Replies carry the 8-hex short-id (first 8 chars of the proposal UUID, as printed on the Agency HQ card). Resolve it against Logos itself — only pending/commented proposals can be acted on:

```bash
short_id="1a2b3c4d"
proposal_id=$(for s in pending commented; do
  curl -s "https://logos.jeffreykeyser.net/v1/proposals?status=${s}&limit=200" \
    -H "Authorization: Bearer ${LOGOS_SERVICE_TOKEN}" | jq -r '.proposals[].id'
done | grep "^${short_id}" | head -n 1)
```

Empty result → reply `No pending Logos proposal <short-id>` (already decided, or wrong id). If the user pastes a full UUID, use it directly.

## Calling Logos

`LOGOS_SERVICE_TOKEN` is provided to the container via the host (Solo Vault: `logos/production/service-token`). All calls use Bearer auth.

```bash
# approve
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST "https://logos.jeffreykeyser.net/v1/proposals/${proposal_id}/approve" \
  -H "Authorization: Bearer ${LOGOS_SERVICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}'

# reject
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST "https://logos.jeffreykeyser.net/v1/proposals/${proposal_id}/reject" \
  -H "Authorization: Bearer ${LOGOS_SERVICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg r "$reason" '{reason:$r}')"

# comment
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST "https://logos.jeffreykeyser.net/v1/proposals/${proposal_id}/comment" \
  -H "Authorization: Bearer ${LOGOS_SERVICE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$comment" '{comment:$c}')"
```

Use `jq -n --arg` to JSON-escape user input — never concatenate raw user text into a JSON string. A reject reason of `bad "logo"` would otherwise break the JSON.

### Response handling

- **2xx** — reply in the same Telegram thread with one of:
  - `Approved <short-id>`
  - `Rejected <short-id>`
  - `Comment posted on <short-id>` (Logos returns `{ old_proposal_id, new_proposal_id }` because comment supersedes the proposal — surface the new short-id if you have screen real estate, otherwise just confirm).
- **non-2xx** — reply with `Error <code>: <body>` (truncate body to ~300 chars). Common cases:
  - `404` — proposal id not found (mapping stale or wrong short-id).
  - `400` — proposal already approved/rejected, or missing `reason`/`comment`.
  - `401` — service token missing or wrong; flag this loudly because every subsequent call will also 401.

**No retries.** A single attempt is the whole story for this surface. If the user wants to try again they can re-send the reply.

## Event payload (`logos.digest.ready`)

```json
{
  "message": string
}
```

Routing key: `logos.digest.ready` · Exchange: `logos.events` (topic, durable) · Frequency: daily at 15:00 UTC (09:00 CST).

Digest body is precomputed by Logos — pending proposals listed as short-id (first 8 hex), kind, and page slug, or the literal `No pending Logos proposals.` when the queue is empty. No other fields are emitted; do not assume future enrichment.

## What to do when an event arrives

When the routing key is `logos.digest.ready`, forward `message` to Telegram **verbatim** via your `send_message` destination — no reformatting, no enrichment, no truncation, and no reply prompt appended. Logos owns the wording. One message per event; no retries; no reply path back to Logos for this event (the digest is notify-only — replies, if any, fall through to the normal conversational path).

Smoke it with the `rabbitmqadmin` pattern from "Subscribing to the exchange" below:

```bash
rabbitmqadmin publish \
  exchange=logos.events \
  routing_key=logos.digest.ready \
  payload='{"message":"No pending Logos proposals."}'
```

## Subscribing to the exchange (debugging + smoke)

Day-to-day, host-side wiring delivers the event payload to the agent (NanoClaw routes the parsed event into the agent group like any other prompt — see `~/nanoclaw/src/router.ts`). For manual smoke or debugging from inside the container, you can publish or consume directly with `rabbitmqadmin`:

```bash
# Publish a synthetic event (smoke test)
rabbitmqadmin publish \
  exchange=logos.events \
  routing_key=logos.proposal.created \
  payload='{"proposal_id":"00000000-0000-0000-0000-000000000000","page_slug":"smoke-test","kind":"update_page"}'

# Bind a one-shot temp queue to inspect what's flowing past
rabbitmqadmin declare queue name=logos.smoke.$$ durable=false auto_delete=true
rabbitmqadmin declare binding source=logos.events destination=logos.smoke.$$ \
  routing_key=logos.proposal.created
rabbitmqadmin get queue=logos.smoke.$$ count=1 ackmode=ack_requeue_false
```

The shared consumer queue `logos.events.consumer` belongs to Logos itself — do not bind to that queue or you'll steal events from the producer. Use a temp queue with a unique name for inspection.

## Out of scope

- Inline keyboard buttons and new-proposal nudges — Agency HQ owns those cards (`src/services/logos-proposal-cards.ts`).
- Threading state across multiple proposals (no "active proposal" — every reply must include the short-id).
- Durable consumer queue owned by NanoClaw. The host-side router or a temp queue is enough for v1.
- Backfill of historical proposals.
- Other routing keys on `logos.events` (`proposal.created`, `ingest.completed`, `proposal.applied`, etc.) — only `logos.digest.ready` is handled here.
