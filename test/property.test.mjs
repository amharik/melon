import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { splitArgs, parseAgyLine } from "../server/agy.mjs";
import { createSanitizer } from "../web/shared/sanitize.js";

const token = fc.stringMatching(/^[^\s"']{1,20}$/);
const sanitizer = createSanitizer(
  createDOMPurify(new JSDOM("<!doctype html><html><body></body></html>").window),
);

test("splitArgs round-trips quote-free tokens", () => {
  fc.assert(
    fc.property(fc.array(token, { maxLength: 20 }), (tokens) => {
      assert.deepEqual(splitArgs(tokens.join(" ")), tokens);
    }),
  );
});

test("parseAgyLine never throws on arbitrary input", () => {
  fc.assert(
    fc.property(fc.string(), (line) => {
      const event = parseAgyLine(line);
      assert.ok(event === null || typeof event === "object");
    }),
  );
});

test("SVG sanitizer removes scriptable constructs for arbitrary attributes", () => {
  fc.assert(
    fc.property(fc.stringMatching(/^[a-z]{1,12}$/), fc.stringMatching(/^[^\s"'<>]{0,40}$/), (name, value) => {
      const svg = `<svg><script>alert(1)</script><rect on${name}="${value}" href="javascript:alert(1)"/></svg>`;
      const clean = sanitizer.svg(svg);
      assert.ok(!/<script/i.test(clean));
      assert.ok(!/\son[a-z]+\s*=/i.test(clean));
      assert.ok(!/javascript:/i.test(clean));
    }),
  );
});
