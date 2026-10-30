#!/usr/bin/env bash
# Starts Workshop Inventory. First run installs dependencies.
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --omit=dev
export PORT="${PORT:-3100}"
echo "Open http://localhost:$PORT (or http://<this-computer's-ip>:$PORT from your phone)"
node dist/index.js
