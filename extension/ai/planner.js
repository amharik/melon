(function (root) {
  "use strict";

  const MAX_GOAL = 8000;
  const ALLOWED_ADAPTERS = [
    "demo:claude",
    "demo:gemini",
    "demo:mistral",
    "demo:chatgpt",
    "demo:moderator",
    "ext",
    "opencode",
    "llm",
  ];

  const SYSTEM_PROMPT = `You are Melon's graph planner. Turn the user's goal into one JSON dataflow graph.

Return ONLY one JSON object. Do not use markdown fences. Do not add commentary.

Required shape:
{
  "nodes": [
    {"id": "brief", "kind": "source", "label": "Brief", "config": {"topic": "the user's goal"}},
    {"id": "claude", "kind": "agent", "label": "Claude", "config": {"adapter": "demo:claude"}},
    {"id": "decision", "kind": "sink", "label": "Decision"}
  ],
  "edges": [
    {"id": "e1", "from": {"node": "brief", "port": "out"}, "to": {"node": "claude", "port": "in"}},
    {"id": "e2", "from": {"node": "claude", "port": "result"}, "to": {"node": "decision", "port": "in"}}
  ]
}

Rules:
- Exactly one source node and exactly one sink node.
- source has no inputs and one output: "out".
- agent normally has one input: "in"; outputs: "stream" and "result".
- A demo:moderator agent may set inputs to ["rev1", "rev2"] when it synthesizes two reviewers; trigger becomes "all".
- join has inputs: "in1" and "in2"; output: "result".
- sink has one input: "in"; no outputs.
- Allowed agent adapters are: ${ALLOWED_ADAPTERS.join(", ")}.
- Use demo:moderator to synthesize multiple reviewers. Use join only for deterministic fan-in without synthesis.
- Every node must be reachable from the source. No cycles.
- Use stable lower-case ids. Keep labels short.
- The source topic must contain the user's goal.
- Do not include extTabId, credentials, or any secret.
- Maximum 12 nodes and 24 edges.`;

  const VARIANTS = [
    "",
    "Prefer the smallest coherent graph that still solves the goal. Use one reviewer unless the goal clearly needs independent perspectives.",
    "Prefer independent parallel reviewers and a demo:moderator that synthesizes their outputs.",
    "Prefer an explicit join when deterministic fan-in is clearer than synthesis, or a moderator when judgment is needed.",
  ];

  function messagesForGoal(goal, variant = 0) {
    const clean = String(goal || "").trim().slice(0, MAX_GOAL);
    if (!clean) throw new Error("A planning goal is required.");
    const style = VARIANTS[Math.abs(Number(variant) || 0) % VARIANTS.length];
    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: style ? `${clean}\n\nPlanning preference: ${style}` : clean },
    ];
  }

  root.MELON_PLANNER = {
    MAX_GOAL,
    ALLOWED_ADAPTERS,
    SYSTEM_PROMPT,
    VARIANTS,
    messagesForGoal,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
