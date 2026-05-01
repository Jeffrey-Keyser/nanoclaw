---
name: logos
description: Surface new Logos proposals to the user via Telegram and route approve/reject/comment replies back to the Logos API. Use when a `logos.proposal.created` event arrives on RabbitMQ exchange `logos.events`, or when an incoming Telegram message matches the `approve <id>` / `reject <id> <reason>` / `comment <id> <text>` reply grammar.
allowed-tools: Bash(curl:*), Bash(rabbitmqadmin:*), Bash(jq:*)
---

# Logos Proposal Push + Reply

Logos publishes proposal lifecycle events on the `logos.events` topic exchange (RabbitMQ). This skill turns one of those events — `logos.proposal.created` — into a Telegram nudge and routes the user's reply back to the Logos HTTP API.

## Endpoints + constants

```
RabbitMQ exchange:  logos.events            (topic, durable)
Routing key (in):   logos.proposal.created
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

Source of truth: `LogosProposalCreatedEvent` in `@jeffrey-keyser/message-contracts/dist/logos/events.d.ts`. Field names are snake_case to match the wire format. Other Logos events on the same exchange (`logos.ingest.completed`, `logos.proposal.applied`, etc.) are out of scope here — ignore everything except `logos.proposal.created`.

## What to do when an event arrives

1. **Compute short-id** = first 8 hex chars of `proposal_id` (e.g. `1a2b3c4d`). Drop dashes if you slice from the raw UUID; just take the first 8 of the lowercased hex.
2. **Render `<page-or-new>`** = `page_slug` if `kind === "update_page"`, otherwise the literal string `new` for `kind === "create_page"`.
3. **Persist mapping** — append `{ short_id, proposal_id, kind, page_slug, created_at }` to `/workspace/agent/logos-proposals.json` so a Telegram reply can resolve the short-id back to the full UUID after a container restart. See "Short-id mapping" below.
4. **Send Telegram** — one message via your `send_message` destination (do not loop or retry):

   ```
   New Logos proposal: <kind> on <page-or-new>. Reply `approve <short-id>` / `reject <short-id> reason` / `comment <short-id> your-comment`.
   ```

   Example: `New Logos proposal: update_page on example-domain. Reply ` + backtick + `approve 1a2b3c4d` + backtick + `…`

## Reply parsing

Match incoming Telegram text against the following grammar. Commands are **case-insensitive**; `<id>` is the 8-char short-id; whitespace between tokens is collapsed.

| Reply | Regex (anchored, `i` flag) |
|---|---|
| Approve | `^\s*approve\s+([0-9a-f]{8})\s*$` |
| Reject  | `^\s*reject\s+([0-9a-f]{8})\s+(.+\S)\s*$` |
| Comment | `^\s*comment\s+([0-9a-f]{8})\s+(.+\S)\s*$` |

If the input doesn't match any of these, **don't act** — leave it for the normal conversational path. False positives here would call Logos with garbage.

## Short-id mapping

Persist mappings as line-delimited JSON at `/workspace/agent/logos-proposals.json` (workspace is mounted, survives container restarts):

```bash
mkdir -p /workspace/agent
echo '{"short_id":"1a2b3c4d","proposal_id":"1a2b3c4d-e5f6-7890-abcd-ef0123456789","kind":"update_page","page_slug":"example-domain","created_at":"2026-05-01T18:00:00Z"}' >> /workspace/agent/logos-proposals.json
```

To resolve a short-id back to the full UUID:

```bash
short_id="1a2b3c4d"
proposal_id=$(grep -F "\"short_id\":\"${short_id}\"" /workspace/agent/logos-proposals.json | tail -n 1 | jq -r .proposal_id)
```

Two short-ids could collide (8 hex = 1 in 4B). On collision, the most recent entry wins (use `tail -n 1`); if the user complains about wrong proposal, ask them to paste the full UUID.

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

- Inline keyboard buttons. Plain reply commands only.
- Threading state across multiple proposals (no "active proposal" — every reply must include the short-id).
- Durable consumer queue owned by NanoClaw. The host-side router or a temp queue is enough for v1.
- Backfill of historical proposals.
- Other routing keys on `logos.events` (`ingest.completed`, `proposal.applied`, etc.).
