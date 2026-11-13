#!/usr/bin/env node
// Fixed-brief evaluation harness. This is a deterministic baseline, not a model
// benchmark: it exercises the same prompt/rubric pipeline without keys, tabs, or
// network. Swap the single/moderator runners for real adapters when available.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildResponse } from "../web/shared/simulator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIEFS = path.join(__dirname, "..", "test", "evals", "briefs.json");

const SECTIONS = /##\s+(Decision|Consensus|Disagreements|Risks|Next actions|Open questions)/gi;

export function scoreText(text, brief) {
  const lower = String(text || "").toLowerCase();
  const terms = Array.isArray(brief.expect) ? brief.expect : [];
  const hits = terms.filter((term) => lower.includes(String(term).toLowerCase()));
  let score = terms.length ? hits.length / terms.length : 0;
  const sections = new Set([...String(text || "").matchAll(SECTIONS)].map((match) => match[1].toLowerCase()));
  if (sections.size >= 4) score += 0.2;
  if (/provenance/i.test(text)) score += 0.05;
  return { score: Math.min(1, Number(score.toFixed(3))), hits, sections: sections.size };
}

export function runEval({ cases, minScore = 0.5 } = {}) {
  const briefs = cases || JSON.parse(fs.readFileSync(BRIEFS, "utf8"));
  const results = briefs.map((brief) => {
    const singleText = buildResponse("claude", brief.goal);
    const reviewerA = buildResponse("claude", brief.goal);
    const reviewerB = buildResponse("gemini", brief.goal);
    const moderatorText = buildResponse(
      "moderator",
      `${brief.goal}\n\nrev1\n${reviewerA}\n\nrev2\n${reviewerB}`,
    );
    const single = scoreText(singleText, brief);
    const moderator = scoreText(moderatorText, brief);
    return {
      id: brief.id,
      goal: brief.goal,
      single: { ...single, chars: singleText.length },
      moderator: { ...moderator, chars: moderatorText.length },
      lift: Number((moderator.score - single.score).toFixed(3)),
    };
  });
  const avg = (key) =>
    Number((results.reduce((sum, item) => sum + item[key].score, 0) / (results.length || 1)).toFixed(3));
  const summary = {
    cases: results.length,
    singleAvg: avg("single"),
    moderatorAvg: avg("moderator"),
    lift: Number((avg("moderator") - avg("single")).toFixed(3)),
    pass: results.every((item) => item.moderator.score >= minScore && item.lift >= 0),
  };
  return { results, summary, minScore };
}

function print(report) {
  console.log("brief                 single  moderator  lift");
  console.log("--------------------  ------  ---------  ----");
  for (const item of report.results) {
    console.log(
      `${item.id.padEnd(20)}  ${String(item.single.score.toFixed(2)).padStart(6)}  ${String(
        item.moderator.score.toFixed(2),
      ).padStart(9)}  ${String(item.lift.toFixed(2)).padStart(4)}`,
    );
  }
  console.log("");
  console.log(
    `avg: single ${report.summary.singleAvg} · moderator ${report.summary.moderatorAvg} · lift ${report.summary.lift}`,
  );
  console.log(`threshold ${report.minScore} · ${report.summary.pass ? "PASS" : "FAIL"}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes("--json");
  const report = runEval({ minScore: 0.5 });
  if (json) console.log(JSON.stringify(report, null, 2));
  else print(report);
  process.exit(report.summary.pass ? 0 : 1);
}
