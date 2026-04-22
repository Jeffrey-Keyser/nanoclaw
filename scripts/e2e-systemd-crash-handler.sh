#!/usr/bin/env bash
#
# End-to-end test for the systemd crash handler (uptime-monitor).
#
# Creates a dummy systemd user service that intentionally crashes,
# then verifies the uptime monitor detects the failure and would
# send alerts (via a mock Telegram notification channel).
#
# Requirements:
#   - Linux with systemd --user support
#   - Node.js (for running the JS test harness)
#   - Project must be built (npm run build:core)
#
# Usage:
#   bash scripts/e2e-systemd-crash-handler.sh
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_NAME="nanoclaw-e2e-crash-test"
SERVICE_UNIT="${SERVICE_NAME}.service"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/${SERVICE_UNIT}"
HARNESS_FILE="${PROJECT_DIR}/scripts/_e2e-crash-harness.mjs"

PASSED=0
FAILED=0
CLEANED_UP=false

# --- Helpers ---

log() { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
pass() { printf '\033[1;32m[PASS]\033[0m %s\n' "$*"; PASSED=$((PASSED + 1)); }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*"; FAILED=$((FAILED + 1)); }

cleanup() {
  if [ "$CLEANED_UP" = "true" ]; then return; fi
  CLEANED_UP=true

  log "Cleaning up..."

  # Stop the service if running
  systemctl --user stop "$SERVICE_UNIT" 2>/dev/null || true

  # Reset failed state
  systemctl --user reset-failed "$SERVICE_UNIT" 2>/dev/null || true

  # Remove service file
  if [ -f "$SERVICE_FILE" ]; then
    rm -f "$SERVICE_FILE"
    log "Removed $SERVICE_FILE"
  fi

  # Reload daemon
  systemctl --user daemon-reload 2>/dev/null || true

  log "Cleanup complete."
}

# Always clean up on exit
trap cleanup EXIT

# --- Preflight ---

log "Preflight checks..."

# Verify systemd user session is available
if ! systemctl --user list-units --no-pager >/dev/null 2>&1; then
  fail "systemd --user session not available (is DBUS_SESSION_BUS_ADDRESS set?)"
  exit 1
fi

# Verify Node.js
if ! command -v node >/dev/null 2>&1; then
  fail "node not found"
  exit 1
fi

pass "Preflight checks passed"

# --- Step 1: Create dummy service that crashes ---

log "Step 1: Creating dummy service '${SERVICE_UNIT}' that exits with failure..."

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=NanoClaw E2E Crash Test Dummy Service

[Service]
Type=oneshot
RemainAfterExit=no
ExecStart=/bin/false
Restart=no
EOF

systemctl --user daemon-reload

pass "Dummy service created at $SERVICE_FILE"

# --- Step 2: Start (and crash) the service ---

log "Step 2: Starting dummy service (will immediately fail)..."

# Start the service - it WILL fail, that's intentional
systemctl --user start "$SERVICE_UNIT" 2>/dev/null && {
  fail "Service should have failed but succeeded"
} || {
  pass "Service crashed as expected (exit code non-zero)"
}

# --- Step 3: Verify systemctl reports the failure ---

log "Step 3: Verifying systemctl reports the service as failed..."

sleep 1  # Brief pause for systemd state propagation

FAILED_OUTPUT=$(systemctl --user list-units --state=failed --no-legend --no-pager 2>/dev/null || true)
if echo "$FAILED_OUTPUT" | grep -q "$SERVICE_NAME"; then
  pass "systemctl --user reports '${SERVICE_UNIT}' as failed"
else
  fail "systemctl --user does not report '${SERVICE_UNIT}' as failed"
  echo "  Failed units output: ${FAILED_OUTPUT:-"(empty)"}"
fi

# --- Step 4: Verify journalctl has log entries ---

log "Step 4: Checking journalctl for crash entries..."

JOURNAL_OUTPUT=$(journalctl --user -u "$SERVICE_UNIT" -n 10 --no-pager --output=short 2>/dev/null || true)
if [ -n "$JOURNAL_OUTPUT" ]; then
  pass "journalctl has entries for ${SERVICE_UNIT}"
else
  fail "journalctl has no entries for ${SERVICE_UNIT}"
fi

# --- Step 5: Run the JS test harness that exercises the uptime monitor ---

log "Step 5: Running uptime-monitor detection harness..."

# The harness imports checkServices with mocked deps and verifies
# it detects the crashed service and formats the alert correctly
if node "$HARNESS_FILE" "$SERVICE_UNIT" 2>&1; then
  pass "Uptime monitor detected crash and formatted alert"
else
  fail "Uptime monitor harness failed"
fi

# --- Step 6: Verify recovery detection ---

log "Step 6: Resetting service and verifying recovery detection..."

systemctl --user reset-failed "$SERVICE_UNIT" 2>/dev/null || true

# After reset, the service should no longer be in the failed list
FAILED_AFTER_RESET=$(systemctl --user list-units --state=failed --no-legend --no-pager 2>/dev/null || true)
if echo "$FAILED_AFTER_RESET" | grep -q "$SERVICE_NAME"; then
  fail "Service still appears as failed after reset"
else
  pass "Service cleared from failed list after reset"
fi

# Run the harness again to verify recovery notification
if node "$HARNESS_FILE" "$SERVICE_UNIT" --recovery 2>&1; then
  pass "Uptime monitor detected recovery and sent notification"
else
  fail "Uptime monitor recovery harness failed"
fi

# --- Summary ---

echo ""
log "=========================================="
log "Results: ${PASSED} passed, ${FAILED} failed"
log "=========================================="

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

exit 0
