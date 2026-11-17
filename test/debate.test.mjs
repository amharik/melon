import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDebateMentions,
  isDebateTrigger,
  buildDebateTurnPrompt,
  synthesizeDebateConsensus,
} from "../web/shared/debate.js";
import {
  getChannelBlackboard,
  updateChannelBlackboard,
  readBlackboard,
} from "../server/blackboard.mjs";

test("parseDebateMentions extracts unique lowercase handles", () => {
  const text = "@chatgpt propose architecture, @claude review, and @agy implement it with @chatgpt";
  const mentions = parseDebateMentions(text);
  assert.deepEqual(mentions, ["chatgpt", "claude", "agy"]);

  assert.deepEqual(parseDebateMentions(""), []);
  assert.deepEqual(parseDebateMentions(null), []);
});

test("isDebateTrigger detects multi-agent mentions and /debate command", () => {
  assert.equal(isDebateTrigger("@chatgpt and @claude debate optimal state management"), true);
  assert.equal(isDebateTrigger("/debate Compare REST vs GraphQL"), true);
  assert.equal(isDebateTrigger("@chatgpt tell me a joke"), false);
  assert.equal(isDebateTrigger("hello team"), false);
});

test("buildDebateTurnPrompt builds contextual prompts for proposer, critic, and implementer", () => {
  const p1 = buildDebateTurnPrompt({
    topic: "JWT vs Session tokens",
    role: "proposer",
    roundNumber: 1,
  });
  assert.ok(p1.includes("JWT vs Session tokens"));
  assert.ok(p1.includes("Lead Architect / Proposer"));

  const p2 = buildDebateTurnPrompt({
    topic: "JWT vs Session tokens",
    role: "critic",
    roundNumber: 2,
    previousOutput: "Use RS256 signed JWTs stored in memory.",
  });
  assert.ok(p2.includes("Adversarial Critic & Reviewer"));
  assert.ok(p2.includes("Use RS256 signed JWTs"));

  const p3 = buildDebateTurnPrompt({
    topic: "JWT vs Session tokens",
    role: "implementer",
    roundNumber: 3,
    initialProposal: "Use RS256 signed JWTs",
    previousOutput: "Add token revocation blocklist via Redis.",
  });
  assert.ok(p3.includes("Lead Implementer & Verifier"));
  assert.ok(p3.includes("Add token revocation"));
});

test("synthesizeDebateConsensus aggregates rounds and debaters into markdown verdict", () => {
  const summary = synthesizeDebateConsensus({
    topic: "Distributed Lock Mechanism",
    turns: [
      { speaker: "ChatGPT", role: "proposer", content: "Use Redis redlock algorithm." },
      { speaker: "Claude", role: "critic", content: "Consider network partition clock drift; use Postgres advisory locks." },
      { speaker: "Agy", role: "implementer", content: "Implemented lock guard with tests." },
    ],
    artifacts: [{ filename: "lock.rs", language: "rust", content: "fn acquire() {}" }],
  });

  assert.ok(summary.includes("Distributed Lock Mechanism"));
  assert.ok(summary.includes("ChatGPT, Claude, Agy"));
  assert.ok(summary.includes("1 concrete artifact(s)"));
});

test("server/blackboard manages channel-scoped blackboards while keeping readBlackboard backwards compatible", () => {
  // Legacy readBlackboard
  const legacy = readBlackboard({});
  assert.equal(legacy.ok, false);

  // Channel blackboard CRUD
  const b1 = getChannelBlackboard("general-war-room");
  assert.equal(b1.ok, true);
  assert.equal(b1.blackboard.channelId, "general-war-room");
  assert.equal(b1.blackboard.status, "idle");

  const updated = updateChannelBlackboard("general-war-room", {
    topic: "Optimize SQLite queries",
    status: "debating",
    round: 1,
    participants: ["@chatgpt", "@claude"],
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.blackboard.topic, "Optimize SQLite queries");
  assert.equal(updated.blackboard.status, "debating");
  assert.equal(updated.blackboard.round, 1);
  assert.deepEqual(updated.blackboard.participants, ["@chatgpt", "@claude"]);

  // Scoped to channel: other channels remain untouched
  const b2 = getChannelBlackboard("code-review");
  assert.equal(b2.blackboard.channelId, "code-review");
  assert.equal(b2.blackboard.status, "idle");
  assert.equal(b2.blackboard.topic, "");
});

test("DOM markup, CSS, and app.js wire autonomous debates, native canvas arena, and channel blackboard", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");

  const html = fs.readFileSync(path.resolve("web/index.html"), "utf8");
  assert.ok(html.includes('id="btn-channel-start-debate"'));
  assert.ok(html.includes('id="btn-toggle-blackboard"'));
  assert.ok(html.includes('id="slack-canvas-arena"'));
  assert.ok(html.includes('id="channel-blackboard-pane"'));
  assert.ok(html.includes('id="modal-channel-debate"'));

  const css = fs.readFileSync(path.resolve("web/styles.css"), "utf8");
  assert.ok(css.includes(".slack-canvas-arena"));
  assert.ok(css.includes(".channel-blackboard-pane"));
  assert.ok(css.includes(".blackboard-consensus-box"));
  assert.ok(css.includes(".debate-banner"));
  assert.ok(css.includes(".debate-turn-card"));

  const appJs = fs.readFileSync(path.resolve("web/app.js"), "utf8");
  assert.ok(appJs.includes("startChannelAutonomousDebate"));
  assert.ok(appJs.includes("renderChannelBlackboardPane"));
  assert.ok(appJs.includes("renderSlackCanvasArena"));
  assert.ok(appJs.includes("saveChannelBlackboard"));
});
