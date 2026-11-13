import { test } from "node:test";
import assert from "node:assert/strict";
import { runEval } from "../scripts/eval.mjs";

test("fixed-brief eval harness produces a moderator lift over single-agent", () => {
  const report = runEval({ minScore: 0.5 });
  assert.equal(report.results.length, 4);
  assert.equal(report.summary.pass, true);
  assert.ok(report.summary.moderatorAvg >= report.summary.singleAvg);
  assert.ok(report.summary.moderatorAvg >= 0.5);
  for (const item of report.results) {
    assert.ok(item.single.score >= 0, item.id);
    assert.ok(item.moderator.score <= 1, item.id);
    assert.ok(item.lift >= 0, `${item.id} should not regress`);
  }
});
