#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/extension/vendor"
TRANSFORMERS_VERSION="4.3.2"
ORT_VERSION="1.31.0-dev.20260914-8d85527a0"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/transformers" "$TMP/ort" "$DEST"

(cd "$TMP" && npm pack "@huggingface/transformers@${TRANSFORMERS_VERSION}" --silent >/dev/null)
(cd "$TMP" && npm pack "onnxruntime-web@${ORT_VERSION}" --silent >/dev/null)

tar -xzf "$TMP/huggingface-transformers-${TRANSFORMERS_VERSION}.tgz" -C "$TMP/transformers"
tar -xzf "$TMP/onnxruntime-web-${ORT_VERSION}.tgz" -C "$TMP/ort"

cp "$TMP/transformers/package/dist/transformers.min.js" "$DEST/transformers.min.js"
cp "$TMP/ort/package/dist/ort.webgpu.bundle.min.mjs" "$DEST/"
cp "$TMP/ort/package/dist/ort-wasm-simd-threaded.asyncify.mjs" "$DEST/"
cp "$TMP/ort/package/dist/ort-wasm-simd-threaded.asyncify.wasm" "$DEST/"

echo "Vendored local AI runtime into $DEST"
du -sh "$DEST"
