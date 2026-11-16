import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { createSanitizer } from "../web/shared/sanitize.js";
import { createMarkdownRenderer } from "../web/shared/markdown.js";

const sanitizer = createSanitizer(
  createDOMPurify(new JSDOM("<!doctype html><html><body></body></html>").window),
);
const render = createMarkdownRenderer({ sanitizer });

test("markdown renderer parses standard markdown without placeholder leakage", () => {
  const html = render(
    "# Heading\n\n**bold** and *italic* with [a link](https://example.com).\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
  );
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<a href="https:\/\/example\.com"[^>]*>a link<\/a>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<table class="slack-table">/);
  assert.doesNotMatch(html, /@@MELON_/);
});

test("markdown renderer preserves inline SVG and img markup while stripping scripts", () => {
  const html = render(
    '<svg viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="4" onload="alert(2)"/></svg>\n\n<img src="https://example.com/graphic.png" onerror="alert(3)">',
  );
  assert.match(html, /<svg viewBox="0 0 10 10">/);
  assert.match(html, /<circle cx="5" cy="5" r="4">/);
  assert.match(html, /<img src="https:\/\/example\.com\/graphic\.png">/);
  assert.doesNotMatch(html, /<script|onload|onerror|alert\(/);
  assert.doesNotMatch(html, /&lt;svg/);
  assert.doesNotMatch(html, /&lt;img/);
});

test("markdown renderer turns SVG data-URI images into sanitized vector diagram cards", () => {
  const svg =
    '<svg viewBox="0 0 20 20"><rect width="20" height="20" onload="alert(1)"/><script>alert(2)</script></svg>';
  const html = render(`![Vector Diagram](data:image/svg+xml;utf8,${encodeURIComponent(svg)})`);
  assert.match(html, /class="arch-diagram-card svg-card"/);
  assert.match(html, /data-diagram-meta="/);
  assert.match(html, /<rect width="20" height="20">/);
  assert.doesNotMatch(html, /<script|onload|alert\(/);
});

test("markdown renderer preserves fenced diagrams and code blocks", () => {
  const html = render(
    "```mermaid\ngraph TD\n  Client --> Server\n```\n\n```js\nconst value = 1;\n```\n\n```\n┌────┐\n│ DB │\n└────┘\n```",
  );
  assert.match(html, /class="arch-diagram-card mermaid-card"/);
  assert.match(html, /Rendering Architecture Flowchart/);
  assert.match(html, /class="md-code-block"/);
  assert.match(html, /const value = 1;/);
  assert.match(html, /class="arch-diagram-card box-card"/);
});

test("markdown renderer drops unsafe link and image URLs", () => {
  const html = render(
    '[bad](javascript:alert(1)) and ![bad](javascript:alert(2))\n\n<img src="data:text/html,<script>alert(3)</script>">',
  );
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /data:text\/html/);
  assert.doesNotMatch(html, /<script/);
});
