import crypto from "node:crypto";
import fs from "node:fs";

export const ADAPTER_PACK_SCHEMA = 1;
export const ADAPTER_PACK_ALGORITHM = "Ed25519";
export const ADAPTER_FIELD_NAMES = ["composer", "send", "stop", "response"];

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function publicKeyFromBase64(publicKey) {
  return crypto.createPublicKey({
    key: Buffer.from(String(publicKey || ""), "base64"),
    format: "der",
    type: "spki",
  });
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function semverParts(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function semverAtLeast(version, minimum) {
  const a = semverParts(version);
  const b = semverParts(minimum);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index] > b[index]) return true;
    if (a[index] < b[index]) return false;
  }
  return true;
}

function validateField(key, name, field, errors) {
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    errors.push(`${key}: fields.${name} must be an object`);
    return;
  }
  if (!Array.isArray(field.candidates) || field.candidates.length === 0) {
    errors.push(`${key}: fields.${name}.candidates must be a non-empty array`);
    return;
  }
  field.candidates.forEach((candidate, index) => {
    if (typeof candidate !== "string" || !candidate.trim()) {
      errors.push(`${key}: fields.${name}.candidates[${index}] must be a non-empty string`);
    }
  });
  if (name === "composer" && field.required !== true) {
    errors.push(`${key}: fields.composer.required must be true`);
  }
}

export function validatePack(pack) {
  const errors = [];
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    return { ok: false, errors: ["pack must be an object"] };
  }
  if (pack.schema !== ADAPTER_PACK_SCHEMA) errors.push(`schema must be ${ADAPTER_PACK_SCHEMA}`);
  if (typeof pack.packId !== "string" || !pack.packId.trim()) errors.push("packId is required");
  if (!Number.isInteger(pack.version) || pack.version < 1) {
    errors.push("version must be a positive integer");
  }
  if (!validDate(pack.generatedAt)) errors.push("generatedAt must be an ISO timestamp");
  if (pack.expiresAt != null && !validDate(pack.expiresAt)) {
    errors.push("expiresAt must be an ISO timestamp");
  }
  if (pack.minExtensionVersion != null && !semverParts(pack.minExtensionVersion)) {
    errors.push("minExtensionVersion must be a semantic version");
  }

  const adapters = pack.adapters;
  if (!adapters || typeof adapters !== "object" || Array.isArray(adapters)) {
    errors.push("adapters must be an object");
    return { ok: errors.length === 0, errors };
  }
  const entries = Object.entries(adapters);
  if (!entries.length) errors.push("adapters must not be empty");
  for (const [key, adapter] of entries) {
    if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
      errors.push(`${key}: adapter must be an object`);
      continue;
    }
    if (adapter.id !== key) errors.push(`${key}: id must match catalog key`);
    if (!Number.isInteger(adapter.version) || adapter.version < 1) {
      errors.push(`${key}: version must be a positive integer`);
    }
    if (typeof adapter.label !== "string" || !adapter.label.trim()) {
      errors.push(`${key}: label is required`);
    }
    if (!Array.isArray(adapter.hosts) || adapter.hosts.length === 0) {
      errors.push(`${key}: hosts must be a non-empty array`);
    } else {
      adapter.hosts.forEach((pattern, index) => {
        if (typeof pattern !== "string") {
          errors.push(`${key}: hosts[${index}] must be a string`);
          return;
        }
        try {
          new RegExp(pattern, "i");
        } catch {
          errors.push(`${key}: hosts[${index}] must be a valid regular expression`);
        }
      });
    }
    if (!adapter.fields || typeof adapter.fields !== "object" || Array.isArray(adapter.fields)) {
      errors.push(`${key}: fields must be an object`);
      continue;
    }
    for (const name of ADAPTER_FIELD_NAMES) {
      if (!adapter.fields[name]) errors.push(`${key}: fields.${name} is required`);
      else validateField(key, name, adapter.fields[name], errors);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function createSignedPack({ pack, privateKey, keyId }) {
  const checked = validatePack(pack);
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  const canonical = canonicalJson(pack);
  const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString("base64");
  return {
    schema: ADAPTER_PACK_SCHEMA,
    keyId: String(keyId || "melon-dev"),
    algorithm: ADAPTER_PACK_ALGORITHM,
    payload: pack,
    sha256: sha256Hex(canonical),
    signature,
  };
}

export function verifySignedPack(
  envelope,
  {
    publicKey,
    keyId,
    currentVersion = 0,
    minExtensionVersion = "0.1.0",
    now = Date.now(),
  } = {}
) {
  const errors = [];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, errors: ["envelope must be an object"], pack: null, update: false };
  }
  if (envelope.schema !== ADAPTER_PACK_SCHEMA) errors.push(`envelope schema must be ${ADAPTER_PACK_SCHEMA}`);
  if (envelope.algorithm !== ADAPTER_PACK_ALGORITHM) {
    errors.push(`algorithm must be ${ADAPTER_PACK_ALGORITHM}`);
  }
  if (!envelope.keyId) errors.push("keyId is required");
  if (keyId && envelope.keyId !== keyId) errors.push(`unexpected keyId ${envelope.keyId}`);
  if (typeof envelope.signature !== "string" || !envelope.signature) {
    errors.push("signature is required");
  }

  const checked = validatePack(envelope.payload);
  if (!checked.ok) errors.push(...checked.errors);
  if (errors.length) {
    return { ok: false, errors, pack: null, update: false };
  }

  const pack = envelope.payload;
  const canonical = canonicalJson(pack);
  const digest = sha256Hex(canonical);
  if (envelope.sha256 && envelope.sha256 !== digest) errors.push("payload digest does not match");

  try {
    const key = publicKeyFromBase64(publicKey);
    const signature = Buffer.from(envelope.signature, "base64");
    if (!crypto.verify(null, Buffer.from(canonical), key, signature)) {
      errors.push("signature verification failed");
    }
  } catch (err) {
    errors.push(`signature verification failed: ${err.message}`);
  }

  if (pack.expiresAt && Date.parse(pack.expiresAt) < now) errors.push("adapter pack has expired");
  if (pack.minExtensionVersion && !semverAtLeast(minExtensionVersion, pack.minExtensionVersion)) {
    errors.push(`extension ${minExtensionVersion} is older than required ${pack.minExtensionVersion}`);
  }
  if (currentVersion > 0 && pack.version < currentVersion) {
    errors.push(`adapter pack version ${pack.version} is older than current ${currentVersion}`);
  }

  const update = pack.version > currentVersion;
  return {
    ok: errors.length === 0,
    errors,
    pack,
    update,
    sha256: digest,
  };
}

export function readPackFile(file) {
  const text = fs.readFileSync(file, "utf8");
  return JSON.parse(text);
}

export function packEtag(envelope) {
  return `"sha256-${envelope.sha256 || sha256Hex(canonicalJson(envelope.payload))}"`;
}

export function packSummary(envelope) {
  if (!envelope?.payload) return null;
  return {
    packId: envelope.payload.packId,
    version: envelope.payload.version,
    keyId: envelope.keyId,
    sha256: envelope.sha256 || null,
    generatedAt: envelope.payload.generatedAt,
    expiresAt: envelope.payload.expiresAt || null,
  };
}
