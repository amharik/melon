#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${MELON_REMOTE:-ubuntu@sillyoci}"
REMOTE_DIR="${MELON_REMOTE_DIR:-melon}"

rsync -az --delete \
  --exclude '.git' \
  --exclude '.melon' \
  --exclude '.melon-token' \
  --exclude 'node_modules' \
  --exclude 'core-runtime/target' \
  --exclude 'extension/vendor' \
  --exclude '*.log' \
  "$ROOT/" "$REMOTE:$REMOTE_DIR/"

ssh "$REMOTE" "export PATH=\"\$HOME/.local/node/bin:\$PATH\"; cd \"\$HOME/$REMOTE_DIR\" && npm ci --no-audit --no-fund && npm test && npm run e2e"

if [ "${MELON_REMOTE_AI:-0}" = "1" ]; then
  ssh "$REMOTE" "export PATH=\"\$HOME/.local/node/bin:\$PATH\"; cd \"\$HOME/$REMOTE_DIR\" && npm run vendor:ai && npm run e2e:ai"
fi
