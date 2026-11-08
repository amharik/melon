import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  createSignedPack,
  packEtag,
  readPackFile,
  sha256Hex,
  validatePack,
  verifySignedPack,
} from "../server/adapter-pack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadCatalog() {
  const source = fs.readFileSync(path.join(ROOT, "extension", "adapters.js"), "utf8");
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "extension/adapters.js" });
  return JSON.parse(JSON.stringify(context.MELON_ADAPTERS.catalog));
}

function loadBrowserPack() {
  const source = fs.readFileSync(path.join(ROOT, "extension", "adapter-pack.js"), "utf8");
  const context = {
    globalThis: null,
    crypto: globalThis.crypto,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    TextEncoder,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "extension/adapter-pack.js" });
  return context.MELON_ADAPTER_PACK;
}

function loadPinnedKey() {
  const source = fs.readFileSync(path.join(ROOT, "extension", "adapter-pack-key.js"), "utf8");
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "extension/adapter-pack-key.js" });
  return context.MELON_ADAPTER_PACK_KEY;
}

function fixturePack(overrides = {}) {
  const now = new Date();
  return {
    schema: 1,
    packId: "melon-adapters",
    version: 2,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86400000).toISOString(),
    minExtensionVersion: "0.1.0",
    adapters: loadCatalog(),
    ...overrides,
  };
}

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

test("signed adapter packs round-trip through node and browser verification", async () => {
  const keys = keypair();
  const envelope = createSignedPack({
    pack: fixturePack(),
    privateKey: keys.privateKey,
    keyId: "test-key",
  });
  const nodeResult = verifySignedPack(envelope, {
    publicKey: keys.publicKey,
    keyId: "test-key",
    currentVersion: 1,
  });
  assert.equal(nodeResult.ok, true, nodeResult.errors.join("; "));
  assert.equal(nodeResult.update, true);
  assert.equal(nodeResult.sha256, sha256Hex(canonicalJson(envelope.payload)));

  const browserResult = await loadBrowserPack().verify(envelope, {
    publicKey: keys.publicKey,
    keyId: "test-key",
    currentVersion: 1,
    extensionVersion: "0.1.0",
  });
  assert.equal(browserResult.ok, true, browserResult.errors.join("; "));
  assert.equal(browserResult.update, true);
  assert.equal(browserResult.sha256, nodeResult.sha256);
});

test("adapter packs reject tampering, downgrades, expiry, and old extensions", async () => {
  const keys = keypair();
  const envelope = createSignedPack({
    pack: fixturePack(),
    privateKey: keys.privateKey,
    keyId: "test-key",
  });
  const browser = loadBrowserPack();
  const options = {
    publicKey: keys.publicKey,
    keyId: "test-key",
    extensionVersion: "0.1.0",
  };

  const tampered = JSON.parse(JSON.stringify(envelope));
  tampered.payload.adapters.chatgpt.label = "Tampered";
  assert.equal(verifySignedPack(tampered, options).ok, false);
  assert.equal((await browser.verify(tampered, options)).ok, false);

  const downgrade = verifySignedPack(envelope, { ...options, currentVersion: 3 });
  assert.equal(downgrade.ok, false);
  assert.match(downgrade.errors.join("; "), /older than current/);

  const expired = createSignedPack({
    pack: fixturePack({
      generatedAt: new Date(Date.now() - 200000).toISOString(),
      expiresAt: new Date(Date.now() - 100000).toISOString(),
    }),
    privateKey: keys.privateKey,
    keyId: "test-key",
  });
  assert.equal(verifySignedPack(expired, options).ok, false);

  const tooNew = createSignedPack({
    pack: fixturePack({ minExtensionVersion: "9.0.0" }),
    privateKey: keys.privateKey,
    keyId: "test-key",
  });
  assert.equal(verifySignedPack(tooNew, options).ok, false);
  assert.equal((await browser.verify(tooNew, options)).ok, false);
});

test("pack validation catches malformed adapter catalogs", () => {
  const pack = fixturePack();
  delete pack.adapters.chatgpt.fields.composer;
  const result = validatePack(pack);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("; "), /composer/);
});

test("published adapter pack verifies against the pinned extension key", async () => {
  const envelope = readPackFile(path.join(ROOT, "adapters", "adapter-pack.json"));
  const pub = readPackFile(path.join(ROOT, "adapters", "adapter-pack.pub.json"));
  const pinned = loadPinnedKey();
  assert.equal(pinned.keyId, pub.keyId);
  assert.equal(pinned.publicKey, pub.publicKey);

  const result = verifySignedPack(envelope, {
    publicKey: pinned.publicKey,
    keyId: pinned.keyId,
    currentVersion: 1,
    minExtensionVersion: "0.1.0",
  });
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.update, true);
  assert.equal(packEtag(envelope), `"sha256-${envelope.sha256}"`);

  const browserResult = await loadBrowserPack().verify(envelope, {
    publicKey: pinned.publicKey,
    keyId: pinned.keyId,
    currentVersion: 1,
    extensionVersion: "0.1.0",
  });
  assert.equal(browserResult.ok, true, browserResult.errors.join("; "));
});
