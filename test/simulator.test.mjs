import { test } from "node:test";
import assert from "node:assert/strict";

import { buildResponse } from "../web/shared/simulator.js";

const moderatorPrompt = `You are the moderator.

---

rev1
Architecture review — browser tab runtime

What holds
- The primary boundary is clear.
- Browser tab trust matters.

Concerns
- Backpressure is implied but not designed.
- Add timeout and cancellation.

rev2
Risk register — browser tab runtime

Operational risks
- Browser tab trust matters.
- DOM adapters drift and need health checks.
- Add timeout and cancellation.

Questions
- Who owns cancellation?`;

test("moderator synthesizes instead of pasting both reviews", () => {
  const text = buildResponse("moderator", moderatorPrompt, "");
  for (const heading of [
    "## Decision",
    "## Consensus",
    "## Disagreements",
    "## Risks",
    "## Next actions",
    "## Open questions",
    "## Provenance",
  ]) {
    assert.match(text, new RegExp(heading.replace("#", "\\#")));
  }
  assert.match(text, /rev1 —/);
  assert.match(text, /rev2 —/);
  assert.equal((text.match(/Browser tab trust matters\./g) || []).length, 1);
  assert.doesNotMatch(text, /Operational risks\n- Browser tab trust matters\.\n- DOM adapters drift/);
});

test("moderator has a fallback when upstream ports are not labelled", () => {
  const text = buildResponse("moderator", "Subject: local runtime", "");
  assert.match(text, /^Synthesis/);
  assert.match(text, /Decision/);
});
