#!/bin/sh
# Codex Projects Management — Linux launcher.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Node.js 22+ is required: https://nodejs.org"; exit 1; }
nohup node server.mjs --open >/dev/null 2>&1 &
