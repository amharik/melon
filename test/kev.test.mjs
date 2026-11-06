import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createKevClient,
  normalizeCandidates,
  scoreChoiceAnswer,
} from "../server/kev.mjs";

test("Kev candidates normalize ids, strings, and empty entries", () => {
  const list = normalizeCandidates([
    { id: "alpha", text: " first " },
    "second",
    { id: "empty", text: "   " },
  ]);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((item) => item.id), ["alpha", "candidate-2"]);
  assert.deepEqual(list.map((item) => item.text), ["first", "second"]);
  assert.throws(() => normalizeCandidates([]), /at least one/);
  assert.throws(() => normalizeCandidates(new Array(33).fill("x")), /at most 32/);
});

test("Kev choice scores sort by probability with stable ties", () => {
  const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const result = scoreChoiceAnswer(candidates, {
    type: "choice",
    choice: "c2",
    confidence: 0.8,
    probabilities: { c0: 0.1, c1: 0.1, c2: 0.8 },
  }, 2);
  assert.deepEqual(result.ranked, ["c", "a", "b"]);
  assert.deepEqual(result.selected, ["c", "a"]);
  assert.equal(result.scores[0].rank, 1);
});

test("Kev client sends one choice question and normalizes endpoint", async () => {
  let request;
  const client = createKevClient({
    url: "http://127.0.0.1:11434/",
    model: "kev:4b",
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return new Response(
        JSON.stringify({
          model: "kev:4b",
          answers: {
            rank: {
              type: "choice",
              choice: "c1",
              confidence: 0.7,
              probabilities: { c0: 0.2, c1: 0.7, c2: 0.1 },
            },
          },
          usage: { input_tokens: 12, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });
  const result = await client.rerank("best plan", [
    { id: "one", text: "plan one" },
    { id: "two", text: "plan two" },
    { id: "three", text: "plan three" },
  ], { topK: 1, instructions: "pick one" });
  assert.equal(request.url, "http://127.0.0.1:11434/v1/systemone");
  assert.equal(request.body.model, "kev:4b");
  assert.equal(request.body.state, "best plan");
  assert.deepEqual(Object.keys(request.body.questions.rank.criteria), ["c0", "c1", "c2"]);
  assert.equal(result.selected[0], "two");
  assert.equal(result.confidence, 0.7);
});

test("Kev client rejects malformed choice responses", async () => {
  const client = createKevClient({
    url: "http://kev.local",
    fetchImpl: async () =>
      new Response(JSON.stringify({ answers: { rank: { type: "choice" } } }), { status: 200 }),
  });
  await assert.rejects(
    () => client.rerank("goal", [{ id: "a", text: "A" }, { id: "b", text: "B" }]),
    /no choice probabilities/
  );
});
