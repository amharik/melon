#!/usr/bin/env bash
set -euo pipefail

REMOTE="${MELON_REMOTE:-ubuntu@sillyoci}"
NODE_VERSION="${NODE_VERSION:-24.20.0}"

ssh "$REMOTE" "NODE_VERSION=$NODE_VERSION bash -s" <<'EOF'
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24.20.0}"
case "$(uname -m)" in
  aarch64 | arm64) NODE_ARCH=arm64 ;;
  x86_64 | amd64) NODE_ARCH=x64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

NODE_HOME="$HOME/.local/node-v$NODE_VERSION-linux-$NODE_ARCH"
if [ ! -x "$NODE_HOME/bin/node" ]; then
  mkdir -p "$HOME/.local"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" \
    -o /tmp/melon-node.tar.xz
  tar -xJf /tmp/melon-node.tar.xz -C "$HOME/.local"
  rm -f /tmp/melon-node.tar.xz
fi
ln -sfn "$NODE_HOME" "$HOME/.local/node"
export PATH="$HOME/.local/node/bin:$PATH"

node --version
npm --version
npm install -g playwright@1.65.0
playwright install --with-deps chromium
EOF
