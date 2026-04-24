#!/bin/bash
# tool-observer.sh — Captures PostToolUse and PostToolUseFailure events
# from Claude Code agent sessions and writes them as JSON files to the
# IPC tool-events directory for host-side collection.
#
# PostToolUse / PostToolUseFailure hook for Claude Code.
# Receives JSON on stdin with tool_name, tool_use_id, session_id,
# tool_input, tool_response, and hook_event_name.

INPUT=$(cat)

# Debug log directory — writes to the IPC parent's debug/ folder when NANOCLAW_TOOL_OBSERVER_DEBUG=1
DEBUG_ENABLED="${NANOCLAW_TOOL_OBSERVER_DEBUG:-0}"

# Extract fields from hook JSON
TOOL=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "PostToolUse"')
TS=$(date +%s%N)

# Determine IPC output directory from environment
IPC_DIR="${NANOCLAW_IPC_INPUT_DIR:-/workspace/ipc/input}"
TOOL_EVENTS_DIR="$(dirname "$IPC_DIR")/tool-events"
mkdir -p "$TOOL_EVENTS_DIR"

# Debug: log hook invocation details
if [ "$DEBUG_ENABLED" = "1" ]; then
  DEBUG_DIR="$(dirname "$IPC_DIR")/debug"
  mkdir -p "$DEBUG_DIR"
  {
    echo "=== tool-observer.sh invoked at $(date -Iseconds) ==="
    echo "TOOL=$TOOL EVENT=$EVENT"
    echo "NANOCLAW_IPC_INPUT_DIR=$NANOCLAW_IPC_INPUT_DIR"
    echo "TOOL_EVENTS_DIR=$TOOL_EVENTS_DIR"
    echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-<unset>}"
    echo "INPUT_LENGTH=${#INPUT}"
    echo "---"
  } >> "$DEBUG_DIR/tool-observer.log" 2>/dev/null
fi

# Write event file with truncated tool_response (max 2000 chars)
OUTPUT_FILE="${TOOL_EVENTS_DIR}/${TS}-${TOOL}.json"
echo "$INPUT" | jq -c --arg event "$EVENT" '{
  tool_name: .tool_name,
  tool_use_id: .tool_use_id,
  session_id: .session_id,
  hook_event: $event,
  tool_input: (.tool_input | tostring | .[0:1000]),
  tool_response: (.tool_response | tostring | .[0:2000])
}' > "$OUTPUT_FILE" 2>/dev/null

# Debug: confirm file was written
if [ "$DEBUG_ENABLED" = "1" ]; then
  if [ -f "$OUTPUT_FILE" ]; then
    echo "[$(date -Iseconds)] Wrote $OUTPUT_FILE ($(wc -c < "$OUTPUT_FILE") bytes)" >> "$DEBUG_DIR/tool-observer.log" 2>/dev/null
  else
    echo "[$(date -Iseconds)] FAILED to write $OUTPUT_FILE (jq exit=$?)" >> "$DEBUG_DIR/tool-observer.log" 2>/dev/null
  fi
fi

# Always exit 0 — observability hooks must never block tool execution
exit 0
