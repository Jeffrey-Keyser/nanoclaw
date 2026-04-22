# Systemd Crash Handler Testing

The uptime monitor (`src/uptime-monitor.ts`) watches for failed systemd user services and sends Telegram alerts. This document describes the test suite.

## Unit Tests (Vitest)

`src/uptime-monitor.test.ts` — mocks `child_process.spawn` to test the detection logic in isolation.

```bash
npx vitest run src/uptime-monitor.test.ts
```

**Coverage:**

- Detects newly failed services and sends alerts
- Skips repeat alerts for already-known failures (state-transition guard)
- Sends recovery notifications when services return to healthy
- Handles multiple simultaneous failures
- Routes through `NotificationBatcher` when available
- Truncates long journal output to 1500 chars
- Handles empty/whitespace systemctl output gracefully
- Swallows sendMessage errors without crashing
- Start/stop lifecycle with polling interval

## End-to-End Test (systemd)

`scripts/e2e-systemd-crash-handler.sh` — creates a real dummy systemd user service, crashes it, and verifies the full detection pipeline.

### Requirements

- Linux with systemd `--user` support
- `DBUS_SESSION_BUS_ADDRESS` must be set (standard on graphical sessions; for SSH, run `loginctl enable-linger $USER` first)
- Node.js available on `PATH`

### Usage

```bash
bash scripts/e2e-systemd-crash-handler.sh
```

### What It Does

1. **Creates** a dummy service (`nanoclaw-e2e-crash-test.service`) that runs `/bin/false` to guarantee immediate failure
2. **Starts** the service — it crashes instantly
3. **Verifies** `systemctl --user` reports the service as failed
4. **Verifies** `journalctl --user` has log entries for the crash
5. **Runs a JS harness** (`scripts/_e2e-crash-harness.mjs`) that exercises the same systemctl/journalctl parsing logic as the uptime monitor to confirm:
   - The crashed service is detected
   - The alert message contains `[ALERT] Service down:` with journal output
   - A Telegram notification would be sent with severity `error`
6. **Resets** the service and verifies recovery detection
7. **Cleans up** — removes the dummy service unit file and reloads the systemd daemon

### Cleanup

The script cleans up automatically via an `EXIT` trap, even on failure or interruption. If cleanup fails, manually run:

```bash
systemctl --user stop nanoclaw-e2e-crash-test.service 2>/dev/null
systemctl --user reset-failed nanoclaw-e2e-crash-test.service 2>/dev/null
rm -f ~/.config/systemd/user/nanoclaw-e2e-crash-test.service
systemctl --user daemon-reload
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0    | All checks passed |
| 1    | One or more checks failed |

### Telegram Notification Verification

The e2e test does not send real Telegram messages. Instead, the JS harness captures what _would_ be sent and validates the message format:

- Subject line: `*[ALERT] Service down: <unit>*`
- Body: journal tail in a code block
- Severity: `error` (routed via `NotificationBatcher`)
- Recovery: `*[RESOLVED] Service recovered: <unit>*`

To test with a real Telegram channel, run NanoClaw in dev mode (`npm run dev`) and crash a systemd user service — the uptime monitor will send the alert to your configured main group.
