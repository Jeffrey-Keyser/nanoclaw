#!/bin/bash
# NanoClaw deploy script — graceful restart that waits for active agent sessions
set -e

# beelink-deploy runs as a system service without the user D-Bus session, so
# `systemctl --user` fails with "Failed to connect to bus" unless these are set.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

echo "Deploying NanoClaw..."

# Pull latest
git pull origin main

# Install dependencies needed to build both the core and the agent-runner
npm ci --include=dev
npm --prefix container/agent-runner ci --include=dev

# Build NanoClaw core and host-side agent-runner bundle
npm run build:core
npm run build:agent-runner

# Validate tmux runtime before we touch the running service
npm run smoke:runtime

# Trim dev dependencies after build so the deployed service matches runtime needs
npm prune --omit=dev
npm --prefix container/agent-runner prune --omit=dev

# Check for active agent sessions before restarting
ACTIVE=$(tmux ls 2>/dev/null | grep "^nanoclaw-" | wc -l)
if [ "$ACTIVE" -gt 0 ]; then
  echo "Waiting for $ACTIVE active agent session(s) to complete (max 120s)..."
  WAITED=0
  while [ "$WAITED" -lt 120 ]; do
    ACTIVE=$(tmux ls 2>/dev/null | grep "^nanoclaw-" | wc -l)
    if [ "$ACTIVE" -eq 0 ]; then
      echo "All sessions completed."
      break
    fi
    sleep 5
    WAITED=$((WAITED + 5))
  done
  ACTIVE=$(tmux ls 2>/dev/null | grep "^nanoclaw-" | wc -l)
  if [ "$ACTIVE" -gt 0 ]; then
    echo "Timeout reached, $ACTIVE session(s) still running — restarting anyway."
  fi
fi

# Restart (user service, no sudo needed)
systemctl --user restart nanoclaw

# Smoke-check the main service health endpoint after restart. The port lives
# in the systemd unit (SKILL_SERVER_PORT=3101), not in this shell, and the
# script's 3002 default is the Prompt Registry.
SKILL_SERVER_PORT="${SKILL_SERVER_PORT:-$(systemctl --user show nanoclaw -p Environment --value | tr ' ' '\n' | sed -n 's/^SKILL_SERVER_PORT=//p')}"
export SKILL_SERVER_PORT
npm run smoke:health

echo "Deploy complete."
