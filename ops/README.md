# ops/

Operational scripts and systemd units for NanoClaw.

## Dispatch Watchdog

`dispatch-watchdog.sh` detects stuck Agency HQ dispatch slots (marked as
`executing` but with no corresponding tmux session) and recovers by restarting
NanoClaw, posting a recovery event to Agency HQ, and sending a Telegram
notification.

### Installation

Symlink the timer and service into the systemd user unit directory:

```bash
ln -sf /home/jkeyser/nanoclaw/ops/dispatch-watchdog.{timer,service} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dispatch-watchdog.timer
```

### Verify

```bash
systemctl --user status dispatch-watchdog.timer
```

The timer fires every 5 minutes (`OnBootSec=5min`, `OnUnitActiveSec=5min`).

### Manual run

```bash
./ops/dispatch-watchdog.sh
```

### Tests

```bash
./ops/dispatch-watchdog.test.sh
```
