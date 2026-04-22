#!/bin/bash
# dispatch-watchdog.sh — Detect stuck Agency HQ dispatch slots and recover.
#
# A dispatch slot is "stuck" when Agency HQ reports it as 'executing' but the
# corresponding tmux session no longer exists (crash, OOM-kill, etc.).
#
# Recovery steps for each stuck slot:
#   1. Restart NanoClaw via systemctl --user restart nanoclaw
#   2. POST a recovery event to Agency HQ /api/v1/ops-events
#   3. Send a Telegram notification via the sibling ops/notify.sh script
#
# Usage:
#   ./ops/dispatch-watchdog.sh
#
# Environment:
#   AGENCY_HQ_URL  — Agency HQ base URL (default: http://localhost:3040)
#
# Dependencies: curl, jq, tmux, systemctl
#
# Exit codes:
#   0 — success (no stuck slots, or recovery completed)
#   1 — fatal error (missing dependency, API unreachable, recovery failed)
set -euo pipefail

AGENCY_HQ_URL="${AGENCY_HQ_URL:-http://localhost:3040}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Dependency checks ---

for cmd in curl jq tmux systemctl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: required command '$cmd' not found" >&2
    exit 1
  fi
done

# --- Fetch executing dispatch slots from Agency HQ ---

SLOTS_RESPONSE=$(curl -sf --max-time 10 \
  "${AGENCY_HQ_URL}/api/v1/dispatch-slots" 2>&1) || {
  echo "ERROR: failed to query dispatch slots at ${AGENCY_HQ_URL}/api/v1/dispatch-slots" >&2
  exit 1
}

# Extract slots with status/state = 'executing'
EXECUTING_SLOTS=$(echo "$SLOTS_RESPONSE" | jq -c '
  [(.data // [])[] | select(.status == "executing" or .state == "executing")]
')

SLOT_COUNT=$(echo "$EXECUTING_SLOTS" | jq 'length')

if [ "$SLOT_COUNT" -eq 0 ]; then
  echo "OK: no executing dispatch slots found"
  exit 0
fi

echo "Found $SLOT_COUNT executing slot(s), checking tmux sessions..."

# --- Check each executing slot for a live tmux session ---

STUCK_SLOTS=()

for i in $(seq 0 $((SLOT_COUNT - 1))); do
  SLOT=$(echo "$EXECUTING_SLOTS" | jq -c ".[$i]")
  SLOT_ID=$(echo "$SLOT" | jq -r '.slot_index // .slot_id // .id')
  SESSION_NAME=$(echo "$SLOT" | jq -r '.session_name // empty')

  # If no explicit session_name, check for any nanoclaw- tmux session
  # matching this slot. The tmux session naming convention is
  # nanoclaw-{safeName}-{timestamp} so we grep for the prefix.
  if [ -z "$SESSION_NAME" ]; then
    # Check if any nanoclaw-prefixed tmux session exists at all
    if tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -q '^nanoclaw-'; then
      echo "  Slot $SLOT_ID: tmux session(s) exist, slot appears healthy"
      continue
    else
      echo "  Slot $SLOT_ID: NO tmux sessions found — slot is stuck"
      STUCK_SLOTS+=("$SLOT_ID")
    fi
  else
    # Explicit session name — check directly
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
      echo "  Slot $SLOT_ID ($SESSION_NAME): tmux session exists, healthy"
      continue
    else
      echo "  Slot $SLOT_ID ($SESSION_NAME): tmux session MISSING — slot is stuck"
      STUCK_SLOTS+=("$SLOT_ID")
    fi
  fi
done

if [ ${#STUCK_SLOTS[@]} -eq 0 ]; then
  echo "OK: all executing slots have live tmux sessions"
  exit 0
fi

echo "Detected ${#STUCK_SLOTS[@]} stuck slot(s): ${STUCK_SLOTS[*]}"

# --- Recovery: restart NanoClaw ---

echo "Restarting NanoClaw via systemctl..."
if ! systemctl --user restart nanoclaw; then
  echo "ERROR: failed to restart NanoClaw" >&2
  exit 1
fi
echo "NanoClaw restarted successfully"

# --- Post recovery events and notifications for each stuck slot ---

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RECOVERY_FAILED=0

for SLOT_ID in "${STUCK_SLOTS[@]}"; do
  # POST recovery event to Agency HQ
  EVENT_PAYLOAD=$(jq -n \
    --arg event_type "stuck_slot_recovery" \
    --arg slot_id "$SLOT_ID" \
    --arg action "nanoclaw_restart" \
    --arg reason "tmux_session_missing" \
    --arg timestamp "$TIMESTAMP" \
    '{
      event_type: $event_type,
      slot_id: $slot_id,
      details: {
        action: $action,
        reason: $reason
      },
      timestamp: $timestamp
    }')

  if curl -sf --max-time 10 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$EVENT_PAYLOAD" \
    "${AGENCY_HQ_URL}/api/v1/ops-events" >/dev/null 2>&1; then
    echo "  Posted recovery event for slot $SLOT_ID"
  else
    echo "  WARNING: failed to post recovery event for slot $SLOT_ID" >&2
    RECOVERY_FAILED=1
  fi

  # Send Telegram notification via notify.sh
  NOTIFY_SCRIPT="${SCRIPT_DIR}/notify.sh"
  if [ -x "$NOTIFY_SCRIPT" ]; then
    if "$NOTIFY_SCRIPT" "Ops-Agent: Detected stuck dispatch slot ${SLOT_ID}, restarted NanoClaw"; then
      echo "  Sent Telegram notification for slot $SLOT_ID"
    else
      echo "  WARNING: notify.sh failed for slot $SLOT_ID" >&2
      RECOVERY_FAILED=1
    fi
  else
    echo "  WARNING: notify.sh not found or not executable at $NOTIFY_SCRIPT" >&2
    RECOVERY_FAILED=1
  fi
done

if [ "$RECOVERY_FAILED" -ne 0 ]; then
  echo "Recovery completed with warnings (see above)"
  exit 1
fi

echo "Recovery completed successfully for ${#STUCK_SLOTS[@]} stuck slot(s)"
exit 0
