(function (root) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const FIELD_NAMES = ["composer", "send", "stop", "response"];

  const BUILT_INS = {
    chatgpt: {
      id: "chatgpt",
      version: 1,
      label: "ChatGPT",
      hosts: ["(^|\\.)chatgpt\\.com$", "(^|\\.)chat\\.openai\\.com$"],
      fields: {
        composer: {
          required: true,
          candidates: [
            "#prompt-textarea",
            'div.ProseMirror[contenteditable="true"]',
            "textarea",
          ],
        },
        send: {
          required: false,
          candidates: [
            '[data-testid="send-button"]',
            'button[aria-label*="Send"]',
            'button[type="submit"]',
            'button[aria-label*="send" i]',
            'button[aria-label*="Submit" i]',
            'button[class*="SendButton"]',
          ],
        },
        stop: {
          required: false,
          candidates: [
            '[data-testid="stop-button"]',
            'button[data-testid="stop-button"]',
            'button[aria-label*="Stop"]',
            'button[aria-label*="stop" i]',
            'button[class*="StopButton"]',
          ],
        },
        response: {
          required: false,
          candidates: [
            '[data-message-author-role="assistant"] .markdown',
            '[data-message-author-role="assistant"]',
            'article[data-testid^="conversation-turn-"] .markdown',
            'article[data-testid^="conversation-turn-"] div.prose',
            'article:not(:has([data-message-author-role="user"])) [data-message-author-role="assistant"]',
            'article:not(:has([data-message-author-role="user"])) .markdown',
            'article:not(:has([data-message-author-role="user"])) [class*="markdown"]',
            'article:not(:has([data-message-author-role="user"]))',
            '[data-testid^="conversation-turn-"]:not(:has([data-message-author-role="user"]))',
            '[class*="MarkdownRoot"]',
            '[class*="DilResponseRoot"]',
            '[class*="DilRenderer"]',
            '.agent-turn .markdown',
            '.agent-turn',
            'div[data-message-model-slug]',
            'div.markdown',
          ],
        },
      },
    },
    claude: {
      id: "claude",
      version: 1,
      label: "Claude",
      hosts: ["(^|\\.)claude\\.ai$"],
      fields: {
        composer: {
          required: true,
          candidates: [
            'div[contenteditable="true"].ProseMirror',
            'div[contenteditable="true"]',
          ],
        },
        send: {
          required: false,
          candidates: [
            'button[aria-label="Send message"]',
            'button[aria-label*="Send"]',
            'button[type="submit"]',
          ],
        },
        stop: {
          required: false,
          candidates: ['button[aria-label*="Stop"]', 'button[aria-label*="stop"]'],
        },
        response: {
          required: false,
          candidates: [
            "div[data-is-streaming] .font-claude-message",
            '[data-testid="assistant-message"]',
            ".font-claude-message",
          ],
        },
      },
    },
    gemini: {
      id: "gemini",
      version: 1,
      label: "Gemini",
      hosts: ["(^|\\.)gemini\\.google\\.com$"],
      fields: {
        composer: {
          required: true,
          candidates: [
            'rich-textarea div[contenteditable="true"]',
            'div[contenteditable="true"]',
            "textarea",
          ],
        },
        send: {
          required: false,
          candidates: ['button[aria-label*="Send"]', "button.send-button", 'button[type="submit"]'],
        },
        stop: {
          required: false,
          candidates: ['button[aria-label*="Stop"]', 'button[aria-label*="stop"]'],
        },
        response: {
          required: false,
          candidates: [
            "model-response",
            "message-content",
            ".model-response-text",
            "message-content .markdown",
            "model-response message-content .markdown",
            "model-response .markdown",
            ".model-response-contents",
            'div[data-message-author-role="model"]',
            'message-content [class*="markdown"]',
          ],
        },
      },
    },
    mistral: {
      id: "mistral",
      version: 1,
      label: "Mistral",
      hosts: ["(^|\\.)chat\\.mistral\\.ai$"],
      fields: {
        composer: {
          required: true,
          candidates: ["textarea", 'div[contenteditable="true"]'],
        },
        send: {
          required: false,
          candidates: ['button[type="submit"]', 'button[aria-label*="Send"]'],
        },
        stop: {
          required: false,
          candidates: ['button[aria-label*="Stop"]', 'button[aria-label*="stop"]'],
        },
        response: {
          required: false,
          candidates: ['[data-message-author-role="assistant"]', ".prose"],
        },
      },
    },
  };

  let activeCatalog = BUILT_INS;

  function attr(el, name) {
    try {
      return String(el?.getAttribute?.(name) ?? "");
    } catch {
      return "";
    }
  }

  function tagOf(el) {
    return String(el?.tagName || "").toLowerCase();
  }

  function textOf(el) {
    if (!el) return "";
    let raw = "";
    if (el.shadowRoot) {
      try {
        const shadowText = typeof el.shadowRoot.innerText === "string" ? el.shadowRoot.innerText.trim() : "";
        raw = shadowText || el.shadowRoot.textContent || "";
      } catch {}
    }
    if (!raw) {
      const inner = typeof el.innerText === "string" ? el.innerText.trim() : "";
      raw = inner || (typeof el.textContent === "string" ? el.textContent.trim() : "");
    }
    return String(raw || "").replace(/\u200b/g, "").trim();
  }

  function metaOf(el) {
    return [
      attr(el, "aria-label"),
      attr(el, "title"),
      attr(el, "placeholder"),
      attr(el, "name"),
      attr(el, "id"),
      attr(el, "type"),
      attr(el, "role"),
      attr(el, "data-testid"),
      textOf(el),
    ]
      .join(" ")
      .toLowerCase();
  }

  function defaultVisible(el, fieldName) {
    if (!el || !el.isConnected) return false;
    if (typeof getComputedStyle === "function") {
      try {
        const style = getComputedStyle(el);
        if (
          style?.display === "none" ||
          style?.visibility === "hidden" ||
          style?.opacity === "0"
        ) {
          return false;
        }
      } catch {}
    }
    if (fieldName === "response" || (typeof document !== "undefined" && document.hidden)) return true;
    const rect = el.getBoundingClientRect?.();
    return !rect || (rect.width > 0 && rect.height > 0);
  }

  function candidatesOf(field) {
    return Array.isArray(field?.candidates) ? field.candidates : [];
  }

  function queryAll(doc, selector) {
    try {
      return Array.from(doc?.querySelectorAll?.(selector) || []);
    } catch {
      return [];
    }
  }

  function matchesHost(adapter, hostname) {
    return (adapter?.hosts || []).some((pattern) => {
      try {
        return new RegExp(pattern, "i").test(String(hostname || ""));
      } catch {
        return false;
      }
    });
  }

  function resolveAdapter(name, hostname, catalog = activeCatalog) {
    const entries = Object.values(catalog || {});
    if (name && name !== "auto") {
      const named = entries.find((adapter) => adapter.id === name);
      if (named) return { ...named, name: named.id };
    }
    const matched = entries.find((adapter) => matchesHost(adapter, hostname));
    return matched ? { ...matched, name: matched.id } : null;
  }

  function isDisabled(el) {
    return !!el?.disabled || attr(el, "aria-disabled").toLowerCase() === "true";
  }

  function isButton(el) {
    const tag = tagOf(el);
    return tag === "button" || tag === "input" || attr(el, "role").toLowerCase() === "button";
  }

  function isEditable(el) {
    const tag = tagOf(el);
    if (el?.isContentEditable) return true;
    if (el?.readOnly) return false;
    if (attr(el, "contenteditable") === "true" || attr(el, "contenteditable") === "") return true;
    if (tag === "textarea") return true;
    if (tag === "input") {
      return !/^(button|submit|reset|checkbox|radio|file|image|hidden)$/i.test(attr(el, "type"));
    }
    return false;
  }

  function compareDocumentOrder(a, b) {
    if (a === b) return 0;
    if (typeof a?.compareDocumentPosition === "function") {
      const position = a.compareDocumentPosition(b);
      if (position & 4) return -1;
      if (position & 2) return 1;
    }
    return Number(a?.__melonOrder || 0) - Number(b?.__melonOrder || 0);
  }

  function collectCandidates(doc, adapter, fieldName, visible) {
    const field = adapter?.fields?.[fieldName];
    const out = [];
    const seen = new Set();
    candidatesOf(field).forEach((selector, index) => {
      for (const el of queryAll(doc, selector)) {
        if (seen.has(el) || !visible(el, fieldName)) continue;
        seen.add(el);
        out.push({ el, selector, index });
      }
    });
    return out;
  }

  function sameForm(a, b) {
    if (a?.form && b?.form) return a.form === b.form;
    if (typeof a?.closest === "function" && typeof b?.closest === "function") {
      const first = a.closest("form");
      const second = b.closest("form");
      return !!first && first === second;
    }
    return false;
  }

  function distancePenalty(el, composer) {
    const a = el?.getBoundingClientRect?.();
    const b = composer?.getBoundingClientRect?.();
    if (!a || !b) return 0;
    const dx = Math.abs(Number(a.left || 0) - Number(b.left || 0));
    const dy = Math.abs(Number(a.top || 0) - Number(b.top || 0));
    return Math.min(20, Math.round((dx + dy) / 40));
  }

  function scoreCandidate(item, fieldName, options) {
    const el = item.el;
    const meta = metaOf(el);
    let score = 100 - item.index * 8;

    if (fieldName === "composer") {
      if (/\b(message|prompt|ask|chat)\b/.test(meta)) score += 8;
      if (/\b(search|find|filter)\b/.test(meta)) score -= 120;
      if (attr(el, "role").toLowerCase() === "searchbox") score -= 120;
    } else if (fieldName === "send") {
      if (/\b(send|submit|ask|go)\b/.test(meta)) score += 30;
      if (/\bstop\b/.test(meta)) score -= 120;
      if (/\b(search|find|filter)\b/.test(meta)) score -= 120;
      if (options.composer && sameForm(el, options.composer)) score += 20;
      if (options.composer) score -= distancePenalty(el, options.composer);
    } else if (fieldName === "stop") {
      if (/\bstop\b/.test(meta)) score += 30;
      if (/\b(send|submit)\b/.test(meta)) score -= 120;
      if (/\b(search|find|filter)\b/.test(meta)) score -= 120;
    }

    return score;
  }

  function eligible(item, fieldName, visible) {
    if (!visible(item.el, fieldName)) return false;
    if (fieldName === "composer") return isEditable(item.el);
    if (fieldName === "send" || fieldName === "stop") {
      return isButton(item.el) && !isDisabled(item.el);
    }
    return true;
  }

  function describeCandidate(item, fieldName) {
    const el = item.el;
    const pieces = [
      `selector: ${item.selector}`,
      `field: ${fieldName}`,
      `tag: ${tagOf(el)}`,
      attr(el, "role") ? `role: ${attr(el, "role")}` : "",
      attr(el, "aria-label") ? `aria-label: ${attr(el, "aria-label")}` : "",
      attr(el, "placeholder") ? `placeholder: ${attr(el, "placeholder")}` : "",
      attr(el, "data-testid") ? `data-testid: ${attr(el, "data-testid")}` : "",
      textOf(el) ? `text: ${textOf(el).slice(0, 240)}` : "",
    ];
    return pieces.filter(Boolean).join(" | ").slice(0, 700);
  }

  function rankCandidates(doc, adapter, fieldName, options = {}) {
    const visible = options.visible || defaultVisible;
    return collectCandidates(doc, adapter, fieldName, visible)
      .filter((item) => eligible(item, fieldName, visible))
      .map((item) => ({
        ...item,
        score: scoreCandidate(item, fieldName, options),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.index - b.index ||
          compareDocumentOrder(a.el, b.el)
      )
      .filter((item) => item.score >= 0)
      .map((item, rank) => ({
        ...item,
        rank,
        confidence: Math.max(0, Math.min(1, item.score / 130)),
        description: describeCandidate(item, fieldName),
      }));
  }

  function resolveElement(doc, adapter, fieldName, options = {}) {
    const best = rankCandidates(doc, adapter, fieldName, options)[0];
    if (!best) return null;
    return {
      el: best.el,
      selector: best.selector,
      index: best.index,
      score: best.score,
      confidence: best.confidence,
    };
  }

  function resolveResponses(doc, adapter, options = {}) {
    const visible = options.visible || defaultVisible;
    const items = collectCandidates(doc, adapter, "response", visible);
    const topLevel = items.filter(
      (item) =>
        !items.some(
          (other) =>
            other.el !== item.el &&
            typeof other.el.contains === "function" &&
            other.el.contains(item.el)
        )
    );
    const unique = [];
    for (const item of topLevel) {
      if (!unique.some((seen) => seen.el === item.el)) unique.push(item);
    }
    unique.sort((a, b) => compareDocumentOrder(a.el, b.el));
    return unique;
  }

  function snapshot(doc, adapter, options = {}) {
    const responses = resolveResponses(doc, adapter, options);
    const last = responses[responses.length - 1];
    let element = last?.el || null;
    let text = "";
    if (element) {
      const inner =
        element.querySelector?.('.markdown, .prose, message-content, [class*="markdown"], [class*="prose"], .model-response-text') ||
        element;
      text = textOf(inner) || textOf(element);
    }
    return {
      count: responses.length,
      text,
      selector: last?.selector || null,
      element,
    };
  }

  function health(doc, adapter, options = {}) {
    const fields = {};
    for (const name of FIELD_NAMES) {
      if (name === "response") {
        const current = snapshot(doc, adapter, options);
        fields.response = current.count
          ? { ok: true, selector: current.selector, count: current.count }
          : { ok: false, reason: "no visible response" };
        continue;
      }
      const hit = resolveElement(doc, adapter, name, options);
      fields[name] = hit
        ? { ok: true, selector: hit.selector, score: hit.score }
        : { ok: false, reason: "no visible match" };
    }

    const required = Object.entries(adapter.fields)
      .filter(([, field]) => field.required)
      .map(([name]) => name);
    return {
      ok: required.every((name) => fields[name]?.ok),
      adapter: adapter.id,
      schemaVersion: SCHEMA_VERSION,
      fields,
    };
  }

  function validateField(name, field) {
    const errors = [];
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      return [`fields.${name} must be an object`];
    }
    if (!Array.isArray(field.candidates) || field.candidates.length === 0) {
      errors.push(`fields.${name}.candidates must be a non-empty array`);
    } else {
      field.candidates.forEach((selector, index) => {
        if (typeof selector !== "string" || !selector.trim()) {
          errors.push(`fields.${name}.candidates[${index}] must be a non-empty string`);
        }
      });
    }
    if (field.required !== undefined && typeof field.required !== "boolean") {
      errors.push(`fields.${name}.required must be a boolean`);
    }
    return errors;
  }

  function validateAdapter(adapter) {
    const errors = [];
    if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
      return ["adapter must be an object"];
    }
    if (typeof adapter.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(adapter.id)) {
      errors.push("id must be a lowercase identifier");
    }
    if (!Number.isInteger(adapter.version) || adapter.version < 1) {
      errors.push("version must be a positive integer");
    }
    if (!Array.isArray(adapter.hosts) || adapter.hosts.length === 0) {
      errors.push("hosts must be a non-empty array");
    } else {
      adapter.hosts.forEach((pattern, index) => {
        if (typeof pattern !== "string") {
          errors.push(`hosts[${index}] must be a string`);
          return;
        }
        try {
          new RegExp(pattern, "i");
        } catch {
          errors.push(`hosts[${index}] must be a valid regular expression`);
        }
      });
    }
    if (!adapter.fields || typeof adapter.fields !== "object" || Array.isArray(adapter.fields)) {
      errors.push("fields must be an object");
    } else {
      for (const name of FIELD_NAMES) {
        if (!adapter.fields[name]) errors.push(`fields.${name} is required`);
        else errors.push(...validateField(name, adapter.fields[name]));
      }
    }
    return errors;
  }

  function validateCatalog(catalog) {
    const errors = [];
    const ids = new Set();
    for (const [key, adapter] of Object.entries(catalog || {})) {
      if (adapter?.id !== key) errors.push(`${key}: id must match catalog key`);
      if (ids.has(adapter?.id)) errors.push(`${key}: duplicate id ${adapter.id}`);
      ids.add(adapter?.id);
      errors.push(...validateAdapter(adapter).map((error) => `${key}: ${error}`));
    }
    return errors;
  }

  function setCatalog(next) {
    if (!next) {
      activeCatalog = BUILT_INS;
      return;
    }
    const errors = validateCatalog(next);
    if (errors.length) throw new Error(errors.join("; "));
    activeCatalog = next;
  }

  const api = {
    SCHEMA_VERSION,
    FIELD_NAMES,
    catalog: BUILT_INS,
    getCatalog: () => activeCatalog,
    setCatalog,
    validateAdapter,
    validateCatalog,
    resolveAdapter,
    rankCandidates,
    resolveElement,
    resolveResponses,
    snapshot,
    health,
    textOf,
    defaultVisible,
  };

  root.MELON_ADAPTERS = api;
  root.MelonAdapters = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
