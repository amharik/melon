import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

await import("../extension/adapters.js");

const A = globalThis.MELON_ADAPTERS;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test/fixtures/adapters");

function visible(el) {
  return !!el?.isConnected && el.getBoundingClientRect().width > 1;
}

function makeElement(spec) {
  const attrs = spec.attrs || {};
  const children = [];
  const el = {
    tagName: spec.tag || "DIV",
    isConnected: spec.connected !== false,
    disabled: !!spec.disabled,
    readOnly: !!spec.readOnly,
    isContentEditable: !!spec.contentEditable,
    innerText: spec.text || "",
    textContent: spec.text || "",
    __melonOrder: spec.order || 0,
    children,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? String(attrs[name]) : null;
    },
    getBoundingClientRect() {
      return spec.visible === false
        ? { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }
        : { width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 };
    },
    contains(other) {
      return children.some((child) => child === other || child.contains(other));
    },
    compareDocumentPosition(other) {
      if (this.__melonOrder < other.__melonOrder) return 4;
      if (this.__melonOrder > other.__melonOrder) return 2;
      return 0;
    },
  };
  return el;
}

async function loadFixture(name) {
  const fixture = JSON.parse(await fs.readFile(path.join(FIXTURES, `${name}.json`), "utf8"));
  const byKey = new Map();
  for (const spec of fixture.elements) byKey.set(spec.key, makeElement(spec));
  for (const spec of fixture.elements) {
    if (spec.parent) byKey.get(spec.parent).children.push(byKey.get(spec.key));
  }
  const doc = {
    querySelectorAll(selector) {
      return (fixture.selectors[selector] || []).map((key) => byKey.get(key));
    },
  };
  return { fixture, doc, byKey };
}

test("adapter catalog is valid and includes all supported sites", () => {
  assert.equal(A.SCHEMA_VERSION, 1);
  assert.deepEqual(A.validateCatalog(A.catalog), []);
  assert.deepEqual(Object.keys(A.catalog).sort(), ["chatgpt", "claude", "gemini", "mistral"]);
});

test("adapter resolution uses explicit names and host fallback", () => {
  assert.equal(A.resolveAdapter("auto", "chatgpt.com").id, "chatgpt");
  assert.equal(A.resolveAdapter("auto", "chat.openai.com").id, "chatgpt");
  assert.equal(A.resolveAdapter("auto", "claude.ai").id, "claude");
  assert.equal(A.resolveAdapter("auto", "gemini.google.com").id, "gemini");
  assert.equal(A.resolveAdapter("auto", "chat.mistral.ai").id, "mistral");
  assert.equal(A.resolveAdapter("auto", "example.com"), null);
  assert.equal(A.resolveAdapter("claude", "chatgpt.com").id, "claude");
  assert.equal(A.resolveAdapter("missing", "claude.ai").id, "claude");
  assert.equal(A.resolveAdapter("missing", "example.com"), null);
});

test("ChatGPT fixture resolves the composer, send, stop, and latest response", async () => {
  const { fixture, doc } = await loadFixture("chatgpt");
  const adapter = A.resolveAdapter(fixture.adapter, fixture.hostname);

  const composer = A.resolveElement(doc, adapter, "composer", { visible });
  assert.equal(composer.selector, "#prompt-textarea");

  const send = A.resolveElement(doc, adapter, "send", { visible, composer: composer.el });
  assert.equal(send.selector, 'button[aria-label*="Send"]');
  assert.equal(send.el.getAttribute("aria-label"), "Send message");

  const stop = A.resolveElement(doc, adapter, "stop", { visible });
  assert.equal(stop.selector, 'button[aria-label*="Stop"]');

  const snap = A.snapshot(doc, adapter, { visible });
  assert.equal(snap.count, 2);
  assert.equal(snap.text, "Second answer");
  assert.equal(snap.selector, '[data-message-author-role="assistant"]');
});

test("Claude fixture skips search boxes and disabled stop buttons", async () => {
  const { fixture, doc } = await loadFixture("claude");
  const adapter = A.resolveAdapter(fixture.adapter, fixture.hostname);

  const composer = A.resolveElement(doc, adapter, "composer", { visible });
  assert.equal(composer.selector, 'div[contenteditable="true"].ProseMirror');
  assert.equal(composer.el.getAttribute("role"), null);

  const send = A.resolveElement(doc, adapter, "send", { visible, composer: composer.el });
  assert.equal(send.selector, 'button[aria-label="Send message"]');

  assert.equal(A.resolveElement(doc, adapter, "stop", { visible }), null);

  const snap = A.snapshot(doc, adapter, { visible });
  assert.equal(snap.count, 1);
  assert.equal(snap.text, "Claude answer");
});

test("Gemini fixture resolves its rich composer and collapses nested responses", async () => {
  const { fixture, doc } = await loadFixture("gemini");
  const adapter = A.resolveAdapter(fixture.adapter, fixture.hostname);

  const composer = A.resolveElement(doc, adapter, "composer", { visible });
  assert.equal(composer.selector, 'rich-textarea div[contenteditable="true"]');
  assert.equal(composer.el.getAttribute("aria-label"), "Enter a prompt here");

  const send = A.resolveElement(doc, adapter, "send", { visible, composer: composer.el });
  assert.equal(send.selector, 'button[aria-label*="Send"]');
  assert.equal(send.el.getAttribute("aria-label"), "Send message");

  const stop = A.resolveElement(doc, adapter, "stop", { visible });
  assert.equal(stop.el.getAttribute("aria-disabled"), null);

  const snap = A.snapshot(doc, adapter, { visible });
  assert.equal(snap.count, 1);
  assert.equal(snap.text, "Gemini answer");
  assert.equal(snap.selector, "model-response");
});

test("Mistral fixture prefers the chat composer and latest response", async () => {
  const { fixture, doc } = await loadFixture("mistral");
  const adapter = A.resolveAdapter(fixture.adapter, fixture.hostname);

  const composer = A.resolveElement(doc, adapter, "composer", { visible });
  assert.equal(composer.selector, "textarea");
  assert.equal(composer.el.getAttribute("placeholder"), "Type your message");

  const send = A.resolveElement(doc, adapter, "send", { visible, composer: composer.el });
  assert.equal(send.selector, 'button[type="submit"]');
  assert.equal(send.el.getAttribute("aria-disabled"), null);

  const stop = A.resolveElement(doc, adapter, "stop", { visible });
  assert.equal(stop.el.getAttribute("aria-label"), "Stop generating");

  const snap = A.snapshot(doc, adapter, { visible });
  assert.equal(snap.count, 2);
  assert.equal(snap.text, "Second Mistral answer");
  assert.equal(snap.selector, '[data-message-author-role="assistant"]');
});

test("resolver falls back to lower-priority selectors", () => {
  const composer = makeElement({ tag: "TEXTAREA", attrs: { placeholder: "Ask anything" } });
  const send = makeElement({
    tag: "BUTTON",
    attrs: { type: "submit", "aria-label": "Submit" },
  });
  const doc = {
    querySelectorAll(selector) {
      if (selector === "textarea") return [composer];
      if (selector === 'button[type="submit"]') return [send];
      return [];
    },
  };
  const adapter = A.catalog.chatgpt;

  assert.equal(A.resolveElement(doc, adapter, "composer", { visible }).selector, "textarea");
  assert.equal(
    A.resolveElement(doc, adapter, "send", { visible, composer }).selector,
    'button[type="submit"]'
  );

  const status = A.health(doc, adapter, { visible });
  assert.equal(status.ok, true);
  assert.equal(status.fields.response.ok, false);
});

test("candidate ranking exposes descriptions for Kev-assisted resolution", async () => {
  const { fixture, doc } = await loadFixture("chatgpt");
  const adapter = A.resolveAdapter(fixture.adapter, fixture.hostname);
  const ranked = A.rankCandidates(doc, adapter, "send", {
    visible,
    composer: A.resolveElement(doc, adapter, "composer", { visible }).el,
  });
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].selector, 'button[aria-label*="Send"]');
  assert.match(ranked[0].description, /aria-label: Send message/);
  assert.equal(ranked[0].rank, 0);
  assert.ok(ranked[0].confidence > 0);
  assert.equal(typeof ranked[0].el, "object");
});

test("health reports missing required fields and schema validation catches bad adapters", () => {
  const doc = { querySelectorAll: () => [] };
  const status = A.health(doc, A.catalog.claude, { visible });
  assert.equal(status.ok, false);
  assert.equal(status.fields.composer.ok, false);
  assert.equal(status.fields.response.ok, false);

  const bad = {
    id: "Bad",
    version: 0,
    hosts: ["["],
    fields: {
      composer: { candidates: [] },
      send: { candidates: ["button"] },
      stop: { candidates: ["button"] },
      response: { candidates: ["div"] },
    },
  };
  const errors = A.validateAdapter(bad);
  assert.ok(errors.some((error) => /id/.test(error)));
  assert.ok(errors.some((error) => /version/.test(error)));
  assert.ok(errors.some((error) => /hosts\[0\]/.test(error)));
  assert.ok(errors.some((error) => /composer\.candidates/.test(error)));

  const duplicate = A.validateCatalog({
    chatgpt: { ...A.catalog.chatgpt, id: "claude" },
    claude: A.catalog.claude,
  });
  assert.ok(duplicate.some((error) => /duplicate id/.test(error)));
});
