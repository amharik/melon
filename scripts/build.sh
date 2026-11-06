#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="wasm32-unknown-unknown"
OUT="$ROOT/web/wasm/melon_core.wasm"

if ! rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
  echo "adding Rust target $TARGET"
  rustup target add "$TARGET"
fi

echo "testing core"
(cd "$ROOT/core-runtime" && cargo test)

echo "building $TARGET"
(cd "$ROOT/core-runtime" && cargo build --target "$TARGET" --release)

mkdir -p "$ROOT/web/wasm"
cp "$ROOT/core-runtime/target/$TARGET/release/melon_core.wasm" "$OUT"

if command -v wasm-opt >/dev/null 2>&1; then
  echo "optimizing with wasm-opt"
  wasm-opt -Oz -o "$OUT.tmp" "$OUT"
  mv "$OUT.tmp" "$OUT"
fi

bytes="$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")"
echo "wrote $OUT ($bytes bytes)"
