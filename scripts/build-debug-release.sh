#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT/dist/debug-release"
VERSION="0.1.0-debug.1"

echo "=== Building Melon Multiplatform Debug Release ($VERSION) ==="
mkdir -p "$DIST_DIR"

# 1. Build WASM Core Runtime
echo "--> Building WASM Core Runtime..."
"$ROOT/scripts/build.sh"

# 2. Detect Host OS
OS="$(uname -s)"
ARCH="$(uname -m)"
echo "Host platform: $OS ($ARCH)"

if [ "$OS" = "Darwin" ]; then
  echo "--> Building macOS Debug Release (Intel x86_64 and Apple Silicon aarch64)..."
  
  # Ensure targets are installed
  for TARGET in "x86_64-apple-darwin" "aarch64-apple-darwin"; do
    if ! rustup target list --installed | grep -qx "$TARGET"; then
      echo "Installing target $TARGET..."
      rustup target add "$TARGET"
    fi
  done

  # Build Mac Intel
  echo "--> Compiling for Mac Intel (x86_64-apple-darwin)..."
  npx tauri build --debug --target x86_64-apple-darwin --no-sign

  # Build Mac Silicon
  echo "--> Compiling for Mac Silicon (aarch64-apple-darwin)..."
  npx tauri build --debug --target aarch64-apple-darwin --no-sign

  # Package bundles
  echo "--> Packaging macOS bundles..."
  cp -v "$ROOT/src-tauri/target/x86_64-apple-darwin/debug/bundle/dmg/"*.dmg "$DIST_DIR/melon-macos-intel-debug.dmg" 2>/dev/null || true
  cp -v "$ROOT/src-tauri/target/aarch64-apple-darwin/debug/bundle/dmg/"*.dmg "$DIST_DIR/melon-macos-silicon-debug.dmg" 2>/dev/null || true

  tar -czf "$DIST_DIR/melon-macos-intel-debug.app.tar.gz" -C "$ROOT/src-tauri/target/x86_64-apple-darwin/debug/bundle/macos" melon.app 2>/dev/null || true
  tar -czf "$DIST_DIR/melon-macos-silicon-debug.app.tar.gz" -C "$ROOT/src-tauri/target/aarch64-apple-darwin/debug/bundle/macos" melon.app 2>/dev/null || true

  # Check if iOS targets can be built
  if rustup target list --installed | grep -q "apple-ios"; then
    echo "--> Attempting iOS debug target bundle..."
    npx tauri ios init --ci 2>/dev/null || true
    npx tauri ios build --debug --no-sign 2>/dev/null || true
  fi
fi

# 3. Generate SHA256 checksums
echo "--> Generating SHA256 Checksums..."
cd "$DIST_DIR"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum * > SHA256SUMS.txt 2>/dev/null || true
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 * > SHA256SUMS.txt 2>/dev/null || true
fi

echo "=== Debug Release Build Finished ==="
ls -lh "$DIST_DIR"
