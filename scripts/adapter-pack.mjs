#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_PACK_ALGORITHM,
  createSignedPack,
  packSummary,
  readPackFile,
  verifySignedPack,
} from "../server/adapter-pack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_KEY_ID = "melon-dev";
const DEFAULT_PRIVATE = path.join(ROOT, ".melon", "adapter-pack", "private.pem");
const DEFAULT_PUBLIC = path.join(ROOT, "adapters", "adapter-pack.pub.json");
const DEFAULT_PACK = path.join(ROOT, "adapters", "adapter-pack.json");
const KEY_FILE = path.join(ROOT, "extension", "adapter-pack-key.js");

function usage() {
  console.log(`Usage:
  node scripts/adapter-pack.mjs keygen [--key-id melon-dev] [--private FILE] [--public FILE] [--force]
  node scripts/adapter-pack.mjs sign [--private FILE] [--key-id ID] [--version N]
       [--expires-days N] [--min-extension 0.1.0] [--out FILE] [--public FILE]
  node scripts/adapter-pack.mjs verify [--pack FILE] [--public FILE] [--current-version N]`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index];
    if (item === "--force") options.force = true;
    else if (item === "--help" || item === "-h") options.help = true;
    else if (item.startsWith("--")) {
      const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      const value = rest[++index];
      if (value == null) throw new Error(`${item} requires a value`);
      options[key] = value;
    } else {
      throw new Error(`unexpected argument ${item}`);
    }
  }
  return { command, options };
}

function publicKeyBase64(privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  return publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

function writeKeyFiles({ keyId, publicKey, publicFile }) {
  const record = { keyId, algorithm: ADAPTER_PACK_ALGORITHM, publicKey };
  fs.mkdirSync(path.dirname(publicFile), { recursive: true });
  fs.writeFileSync(publicFile, `${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(
    KEY_FILE,
    `(function (root) {\n  "use strict";\n  root.MELON_ADAPTER_PACK_KEY = ${JSON.stringify(
      record,
      null,
      2
    )};\n})(typeof globalThis !== "undefined" ? globalThis : this);\n`
  );
  return record;
}

function keygen(options) {
  const privateFile = path.resolve(options.private || DEFAULT_PRIVATE);
  const publicFile = path.resolve(options.public || DEFAULT_PUBLIC);
  if (fs.existsSync(privateFile) && !options.force) {
    throw new Error(`${privateFile} already exists; use --force to replace it`);
  }
  fs.mkdirSync(path.dirname(privateFile), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  fs.writeFileSync(privateFile, pem, { mode: 0o600 });
  const keyId = options.keyId || DEFAULT_KEY_ID;
  const publicKey = publicKeyBase64(pem);
  writeKeyFiles({ keyId, publicKey, publicFile });
  console.log(JSON.stringify({ ok: true, keyId, privateFile, publicFile, keyFile: KEY_FILE }, null, 2));
}

function loadCatalog() {
  const source = fs.readFileSync(path.join(ROOT, "extension", "adapters.js"), "utf8");
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "extension/adapters.js" });
  const catalog = context.MELON_ADAPTERS?.catalog;
  if (!catalog) throw new Error("extension/adapters.js did not expose MELON_ADAPTERS.catalog");
  return JSON.parse(JSON.stringify(catalog));
}

function sign(options) {
  const privateFile = path.resolve(options.private || DEFAULT_PRIVATE);
  const publicFile = path.resolve(options.public || DEFAULT_PUBLIC);
  const outFile = path.resolve(options.out || DEFAULT_PACK);
  const privateKey = fs.readFileSync(privateFile);
  const publicKey = publicKeyBase64(privateKey);
  const keyId = options.keyId || DEFAULT_KEY_ID;
  const version = Number(options.version || 2);
  const expiresDays = Number(options.expiresDays || 365);
  const now = new Date();
  const pack = {
    schema: 1,
    packId: "melon-adapters",
    version,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresDays * 86400000).toISOString(),
    minExtensionVersion: options.minExtension || "0.1.0",
    adapters: loadCatalog(),
  };
  const envelope = createSignedPack({ pack, privateKey, keyId });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(envelope, null, 2)}\n`);
  writeKeyFiles({ keyId, publicKey, publicFile });
  console.log(JSON.stringify({ ok: true, outFile, publicFile, keyFile: KEY_FILE, ...packSummary(envelope) }, null, 2));
}

function verify(options) {
  const packFile = path.resolve(options.pack || DEFAULT_PACK);
  const publicFile = path.resolve(options.public || DEFAULT_PUBLIC);
  const envelope = readPackFile(packFile);
  const pub = readPackFile(publicFile);
  const result = verifySignedPack(envelope, {
    publicKey: pub.publicKey,
    keyId: pub.keyId,
    currentVersion: Number(options.currentVersion || 0),
    minExtensionVersion: options.extensionVersion || "0.1.0",
  });
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        update: result.update,
        errors: result.errors,
        ...(result.pack ? packSummary(envelope) : {}),
      },
      null,
      2
    )
  );
  if (!result.ok) process.exitCode = 1;
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help || !command) usage();
  else if (command === "keygen") keygen(options);
  else if (command === "sign") sign(options);
  else if (command === "verify") verify(options);
  else {
    usage();
    throw new Error(`unknown command ${command}`);
  }
} catch (err) {
  console.error(`adapter-pack: ${err.message}`);
  process.exitCode = 1;
}
