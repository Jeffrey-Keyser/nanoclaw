#!/bin/bash
# dispatch-watchdog.test.sh — Integration tests for dispatch-watchdog.sh
#
# Stubs out curl, tmux, and systemctl to test script logic without real
# services. Each test function creates a temporary PATH with stub scripts.
#
# Usage:
#   ./ops/dispatch-watchdog.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG="${SCRIPT_DIR}/dispatch-watchdog.sh"
PASS=0
FAIL=0

# --- Helpers ---

setup_stubs() {
  STUB_DIR=$(mktemp -d)
  # Preserve real commands we need
  cp "$(command -v jq)" "$STUB_DIR/jq" 2>/dev/null || ln -s "$(command -v jq)" "$STUB_DIR/jq"
  cp "$(command -v bash)" "$STUB_DIR/bash" 2>/dev/null || ln -s "$(command -v bash)" "$STUB_DIR/bash"
  cp "$(command -v date)" "$STUB_DIR/date" 2>/dev/null || ln -s "$(command -v date)" "$STUB_DIR/date"
  cp "$(command -v seq)" "$STUB_DIR/seq" 2>/dev/null || ln -s "$(command -v seq)" "$STUB_DIR/seq"
  cp "$(command -v grep)" "$STUB_DIR/grep" 2>/dev/null || ln -s "$(command -v grep)" "$STUB_DIR/grep"
  cp "$(command -v dirname)" "$STUB_DIR/dirname" 2>/dev/null || ln -s "$(command -v dirname)" "$STUB_DIR/dirname"
  cp "$(command -v cd)" "$STUB_DIR/cd" 2>/dev/null || true
  # Also need basic coreutils
  for cmd in cat echo printf test [ wc tr cut chmod mkdir rm; do
    if command -v "$cmd" &>/dev/null; then
      ln -sf "$(command -v "$cmd")" "$STUB_DIR/$cmd" 2>/dev/null || true
    fi
  done
}

teardown_stubs() {
  rm -rf "$STUB_DIR"
}

assert_exit_code() {
  local expected=$1
  local actual=$2
  local test_name=$3

  if [ "$actual" -eq "$expected" ]; then
    echo "  PASS: $test_name (exit code $actual)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $test_name (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_output_contains() {
  local output="$1"
  local pattern="$2"
  local test_name="$3"

  if echo "$output" | grep -q "$pattern"; then
    echo "  PASS: $test_name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $test_name — output did not contain '$pattern'"
    echo "  Output was: $output"
    FAIL=$((FAIL + 1))
  fi
}

# --- Test: no executing slots ---

test_no_executing_slots() {
  echo "Test: no executing slots returns OK"
  setup_stubs

  # Stub curl to return empty data array
  cat > "$STUB_DIR/curl" << 'STUB'
#!/bin/bash
echo '{"data": []}'
STUB
  chmod +x "$STUB_DIR/curl"

  # Stub tmux (should not be called)
  cat > "$STUB_DIR/tmux" << 'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "$STUB_DIR/tmux"

  # Stub systemctl (should not be called)
  cat > "$STUB_DIR/systemctl" << 'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "$STUB_DIR/systemctl"

  # Stub command -v to succeed for dependency checks
  cat > "$STUB_DIR/command" << 'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "$STUB_DIR/command"

  EXIT_CODE=0
  OUTPUT=$(PATH="$STUB_DIR:$PATH" bash "$WATCHDOG" 2>&1) || EXIT_CODE=$?

  assert_exit_code 0 $EXIT_CODE "exits 0 with no executing slots"
  assert_output_contains "$OUTPUT" "no executing dispatch slots" "reports no executing slots"

  teardown_stubs
}

# --- Test: executing slot with live tmux session ---

test_executing_slot_healthy() {
  echo "Test: executing slot with live tmux session"
  setup_stubs

  # Stub curl to return one executing slot
  cat > "$STUB_DIR/curl" << 'STUB'
#!/bin/bash
echo '{"data": [{"slot_index": 0, "status": "executing", "ahq_task_id": "task-123"}]}'
STUB
  chmod +x "$STUB_DIR/curl"

  # Stub tmux to report sessions exist
  cat > "$STUB_DIR/tmux" << 'STUB'
#!/bin/bash
if [ "$1" = "list-sessions" ]; then
  echo "nanoclaw-main-1713787200000"
  exit 0
fi
exit 0
STUB
  chmod +x "$STUB_DIR/tmux"

  cat > "$STUB_DIR/systemctl" << 'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "$STUB_DIR/systemctl"

  EXIT_CODE=0
  OUTPUT=$(PATH="$STUB_DIR:$PATH" bash "$WATCHDOG" 2>&1) || EXIT_CODE=$?

  assert_exit_code 0 $EXIT_CODE "exits 0 when slot has live session"
  assert_output_contains "$OUTPUT" "all executing slots have live tmux sessions" "reports healthy"

  teardown_stubs
}

# --- Test: stuck slot triggers recovery ---

test_stuck_slot_recovery() {
  echo "Test: stuck slot triggers recovery"
  setup_stubs

  CURL_CALL_LOG=$(mktemp)
  SYSTEMCTL_CALL_LOG=$(mktemp)

  # Stub curl: first call returns executing slot, subsequent POST calls succeed
  cat > "$STUB_DIR/curl" << STUB
#!/bin/bash
echo "\$@" >> "$CURL_CALL_LOG"
# Check if this is the GET dispatch-slots call (no -X flag or -X GET)
if echo "\$@" | grep -q "dispatch-slots" && ! echo "\$@" | grep -q "ops-events"; then
  echo '{"data": [{"slot_index": 2, "status": "executing", "ahq_task_id": "task-456"}]}'
  exit 0
fi
# POST calls (ops-events)
exit 0
STUB
  chmod +x "$STUB_DIR/curl"

  # Stub tmux: no nanoclaw sessions exist
  cat > "$STUB_DIR/tmux" << 'STUB'
#!/bin/bash
if [ "$1" = "list-sessions" ]; then
  exit 1  # no sessions
fi
if [ "$1" = "has-session" ]; then
  exit 1  # session not found
fi
exit 0
STUB
  chmod +x "$STUB_DIR/tmux"

  # Stub systemctl: record restart call
  cat > "$STUB_DIR/systemctl" << STUB
#!/bin/bash
echo "\$@" >> "$SYSTEMCTL_CALL_LOG"
exit 0
STUB
  chmod +x "$STUB_DIR/systemctl"

  # Create a mock notify.sh
  NOTIFY_LOG=$(mktemp)
  cat > "$SCRIPT_DIR/notify.sh" << STUB
#!/bin/bash
echo "\$@" >> "$NOTIFY_LOG"
exit 0
STUB
  chmod +x "$SCRIPT_DIR/notify.sh"

  EXIT_CODE=0
  OUTPUT=$(PATH="$STUB_DIR:$PATH" bash "$WATCHDOG" 2>&1) || EXIT_CODE=$?

  assert_exit_code 0 $EXIT_CODE "exits 0 after successful recovery"
  assert_output_contains "$OUTPUT" "stuck" "detects stuck slot"
  assert_output_contains "$OUTPUT" "Restarting NanoClaw" "restarts NanoClaw"
  assert_output_contains "$OUTPUT" "Recovery completed successfully" "reports success"

  # Check systemctl was called with --user restart nanoclaw
  if [ -f "$SYSTEMCTL_CALL_LOG" ] && grep -q "restart nanoclaw" "$SYSTEMCTL_CALL_LOG"; then
    echo "  PASS: systemctl --user restart nanoclaw was called"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: systemctl restart was not called"
    FAIL=$((FAIL + 1))
  fi

  # Check ops-events POST was attempted
  if [ -f "$CURL_CALL_LOG" ] && grep -q "ops-events" "$CURL_CALL_LOG"; then
    echo "  PASS: ops-events POST was attempted"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: ops-events POST was not attempted"
    FAIL=$((FAIL + 1))
  fi

  # Check notify.sh was called
  if [ -f "$NOTIFY_LOG" ] && grep -q "stuck dispatch slot" "$NOTIFY_LOG"; then
    echo "  PASS: notify.sh was called with stuck slot message"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: notify.sh was not called correctly"
    FAIL=$((FAIL + 1))
  fi

  # Clean up
  rm -f "$CURL_CALL_LOG" "$SYSTEMCTL_CALL_LOG" "$NOTIFY_LOG"
  rm -f "$SCRIPT_DIR/notify.sh"
  teardown_stubs
}

# --- Test: curl failure exits with error ---

test_curl_failure() {
  echo "Test: curl failure exits with error"
  setup_stubs

  # Stub curl to fail
  cat > "$STUB_DIR/curl" << 'STUB'
#!/bin/bash
exit 1
STUB
  chmod +x "$STUB_DIR/curl"

  cat > "$STUB_DIR/tmux" << 'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "$STUB_DIR/tmux"

  cat > "$STUB_DIR/systemctl" << 'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "$STUB_DIR/systemctl"

  EXIT_CODE=0
  OUTPUT=$(PATH="$STUB_DIR:$PATH" bash "$WATCHDOG" 2>&1) || EXIT_CODE=$?

  assert_exit_code 1 $EXIT_CODE "exits 1 when curl fails"
  assert_output_contains "$OUTPUT" "ERROR.*failed to query" "reports API failure"

  teardown_stubs
}

# --- Test: systemctl restart failure exits with error ---

test_systemctl_failure() {
  echo "Test: systemctl restart failure exits with error"
  setup_stubs

  cat > "$STUB_DIR/curl" << 'STUB'
#!/bin/bash
if echo "$@" | grep -q "dispatch-slots" && ! echo "$@" | grep -q "ops-events"; then
  echo '{"data": [{"slot_index": 0, "status": "executing"}]}'
  exit 0
fi
exit 0
STUB
  chmod +x "$STUB_DIR/curl"

  cat > "$STUB_DIR/tmux" << 'STUB'
#!/bin/bash
exit 1
STUB
  chmod +x "$STUB_DIR/tmux"

  cat > "$STUB_DIR/systemctl" << 'STUB'
#!/bin/bash
exit 1
STUB
  chmod +x "$STUB_DIR/systemctl"

  EXIT_CODE=0
  OUTPUT=$(PATH="$STUB_DIR:$PATH" bash "$WATCHDOG" 2>&1) || EXIT_CODE=$?

  assert_exit_code 1 $EXIT_CODE "exits 1 when systemctl fails"
  assert_output_contains "$OUTPUT" "ERROR.*failed to restart" "reports restart failure"

  teardown_stubs
}

# --- Run all tests ---

echo "=== dispatch-watchdog.sh tests ==="
echo ""

test_no_executing_slots
echo ""
test_executing_slot_healthy
echo ""
test_stuck_slot_recovery
echo ""
test_curl_failure
echo ""
test_systemctl_failure
echo ""

echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
