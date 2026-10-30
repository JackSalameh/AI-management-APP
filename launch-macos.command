#!/bin/bash
# Codex Projects Management — macOS launcher (double-click in Finder).
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { osascript -e 'display alert "Node.js 22+ is required" message "Install it from https://nodejs.org"'; exit 1; }
nohup node server.mjs --open >/dev/null 2>&1 &
