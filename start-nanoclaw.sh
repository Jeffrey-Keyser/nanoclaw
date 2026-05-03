#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw with docker group active
# Needed because systemd user session may not inherit docker group from /etc/group
# set -a exports all vars so they survive through sg's new shell
set -a
source "$(dirname "$0")/.env" 2>/dev/null || true
set +a
exec sg docker -c "/usr/bin/node /home/jkeyser/nanoclaw/dist/index.js"
