(function (root) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const ALGORITHM = "Ed25519";

  function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
      return out;
    }
    return value;
  }

  function canonicalJson(value) {
    return JSON.stringify(sortValue(value));
  }

  function bytesFromBase64(value) {
    const text = atob(String(value || ""));
    const out = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index);
    return out;
  }

  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
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

  function validatePack(pack) {
    const errors = [];
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
      return { ok: false, errors: ["pack must be an object"] };
    }
    if (pack.schema !== SCHEMA_VERSION) errors.push(`schema must be ${SCHEMA_VERSION}`);
    if (typeof pack.packId !== "string" || !pack.packId.trim()) errors.push("packId is required");
    if (!Number.isInteger(pack.version) || pack.version < 1) {
      errors.push("version must be a positive integer");
    }
    if (typeof pack.generatedAt !== "string" || !Number.isFinite(Date.parse(pack.generatedAt))) {
      errors.push("generatedAt must be an ISO timestamp");
    }
    if (pack.expiresAt != null && !Number.isFinite(Date.parse(pack.expiresAt))) {
      errors.push("expiresAt must be an ISO timestamp");
    }
    if (pack.minExtensionVersion != null && !semverParts(pack.minExtensionVersion)) {
      errors.push("minExtensionVersion must be a semantic version");
    }
    if (!pack.adapters || typeof pack.adapters !== "object" || Array.isArray(pack.adapters)) {
      errors.push("adapters must be an object");
    } else if (!Object.keys(pack.adapters).length) {
      errors.push("adapters must not be empty");
    }
    return { ok: errors.length === 0, errors };
  }

  async function verify(envelope, options = {}) {
    const errors = [];
    const now = Number(options.now) || Date.now();
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      return { ok: false, errors: ["envelope must be an object"], pack: null, update: false };
    }
    if (envelope.schema !== SCHEMA_VERSION) errors.push(`envelope schema must be ${SCHEMA_VERSION}`);
    if (envelope.algorithm !== ALGORITHM) errors.push(`algorithm must be ${ALGORITHM}`);
    if (!envelope.keyId) errors.push("keyId is required");
    if (options.keyId && envelope.keyId !== options.keyId) {
      errors.push(`unexpected keyId ${envelope.keyId}`);
    }
    if (typeof envelope.signature !== "string" || !envelope.signature) {
      errors.push("signature is required");
    }

    const checked = validatePack(envelope.payload);
    if (!checked.ok) errors.push(...checked.errors);
    if (errors.length) return { ok: false, errors, pack: null, update: false };

    const pack = envelope.payload;
    const canonical = canonicalJson(pack);
    const digest = await sha256Hex(canonical);
    if (envelope.sha256 && envelope.sha256 !== digest) errors.push("payload digest does not match");

    try {
      const key = await crypto.subtle.importKey(
        "spki",
        bytesFromBase64(options.publicKey),
        { name: ALGORITHM },
        false,
        ["verify"]
      );
      const valid = await crypto.subtle.verify(
        ALGORITHM,
        key,
        bytesFromBase64(envelope.signature),
        new TextEncoder().encode(canonical)
      );
      if (!valid) errors.push("signature verification failed");
    } catch (err) {
      errors.push(`signature verification failed: ${String(err?.message || err)}`);
    }

    if (pack.expiresAt && Date.parse(pack.expiresAt) < now) errors.push("adapter pack has expired");
    if (pack.minExtensionVersion && !semverAtLeast(options.extensionVersion, pack.minExtensionVersion)) {
      errors.push(
        `extension ${options.extensionVersion || "unknown"} is older than required ${pack.minExtensionVersion}`
      );
    }
    const currentVersion = Number(options.currentVersion) || 0;
    if (currentVersion > 0 && pack.version < currentVersion) {
      errors.push(`adapter pack version ${pack.version} is older than current ${currentVersion}`);
    }

    return {
      ok: errors.length === 0,
      errors,
      pack,
      update: pack.version > currentVersion,
      sha256: digest,
    };
  }

  root.MELON_ADAPTER_PACK = {
    SCHEMA_VERSION,
    ALGORITHM,
    canonicalJson,
    sha256Hex,
    validatePack,
    verify,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
