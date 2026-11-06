// Deterministic demo agents. These are not models; they exist so the dataflow
// canvas is runnable without keys or tabs. Real agents plug into the same
// message contract through the extension or the opencode/LLM adapters.

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function subjectOf(prompt) {
  const clean = String(prompt || "").replace(/\s+/g, " ").trim();
  const subject = clean.match(/(?:subject|review|decision|adr|proposal)\s*[:\-]\s*([^.!?]{3,90})/i);
  if (subject) return subject[1].trim();
  if (!clean) return "the current proposal";
  const first = clean.split(/[.!?]/)[0].trim();
  return (first.length > 92 ? first.slice(0, 89) + "..." : first) || "the current proposal";
}

function bulletList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function reviewBlocks(prompt) {
  const blocks = [];
  const text = String(prompt || "");
  const re = /(?:^|\n\n)(rev[\w-]+)\n([\s\S]*?)(?=\n\nrev[\w-]+\n|$)/g;
  for (const match of text.matchAll(re)) {
    const body = match[2].trim();
    if (!body) continue;
    const bullets = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+/.test(line))
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean);
    const questions = body
      .split("\n")
      .map((line) => line.trim().replace(/^[-*]\s+/, ""))
      .filter((line) => line.endsWith("?"));
    blocks.push({ label: match[1], body, bullets, questions });
  }
  return blocks;
}

function words(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

function similar(a, b) {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return false;
  let overlap = 0;
  for (const word of left) if (right.has(word)) overlap += 1;
  return overlap / Math.min(left.size, right.size) > 0.42;
}

function synthesizeReviews(prompt) {
  const blocks = reviewBlocks(prompt);
  if (blocks.length < 2) return null;
  const [first, second] = blocks;
  const firstLine = first.body.split("\n").find((line) => line.trim()) || first.body;
  const subject =
    subjectOf(firstLine)
      .replace(/^(architecture|risk|implementation|decision)\s+/i, "")
      .replace(/^(review|register|plan|record)\s*[—:-]\s*/i, "") || "the current proposal";
  const consensus = [];
  const disagreements = [];
  for (const left of first.bullets) {
    const match = second.bullets.find((right) => similar(left, right));
    if (match && !consensus.some((item) => similar(item, left))) consensus.push(left);
  }
  for (const item of first.bullets) {
    if (!consensus.some((entry) => similar(entry, item)) && !disagreements.some((entry) => similar(entry, item))) {
      disagreements.push(`rev1 — ${item}`);
    }
  }
  for (const item of second.bullets) {
    if (!consensus.some((entry) => similar(entry, item)) && !disagreements.some((entry) => similar(entry, item))) {
      disagreements.push(`rev2 — ${item}`);
    }
  }
  const riskWords = /risk|fail|brittle|timeout|cancel|backpressure|security|consent|drift|boundary|throttl|suspend/i;
  const risks = [
    ...new Set(
      [...first.bullets, ...second.bullets].filter(
        (item) =>
          riskWords.test(item) &&
          !/\b(is clear|are clear|what holds|sound|workable)\b/i.test(item) &&
          !consensus.some((entry) => similar(entry, item)),
      ),
    ),
  ].slice(0, 4);
  const actionWords = /^(add|ship|land|document|keep|treat|use|do not|make|build|verify|test|pin)\b/i;
  const actions = [...new Set([...first.bullets, ...second.bullets].filter((item) => actionWords.test(item)))].slice(0, 4);
  const questions = [...new Set([...first.questions, ...second.questions])].slice(0, 4);
  const decision =
    disagreements.length > 6
      ? "Proceed only after the trust boundary, cancellation and adapter fallback are specified."
      : "Proceed with a narrow local-first prototype; keep the browser trust boundary explicit and reversible.";
  return [
    `# Decision — ${subject}`,
    "",
    "## Decision",
    decision,
    "",
    "## Consensus",
    bulletList(
      consensus.slice(0, 4).length
        ? consensus.slice(0, 4)
        : ["The runtime is tractable if transports stay behind adapters.", "Human control must stay visible."],
    ),
    "",
    "## Disagreements",
    bulletList(
      disagreements.slice(0, 4).length
        ? disagreements.slice(0, 4)
        : ["No material disagreement found in the extracted bullets."],
    ),
    "",
    "## Risks",
    bulletList(
      risks.length
        ? risks
        : ["Completion detection and cancellation across suspended tabs remain the highest risks."],
    ),
    "",
    "## Next actions",
    bulletList(
      actions.length
        ? actions
        : [
            "Prove one real web-tab adapter end to end.",
            "Add a run ledger with run id, workflow version, adapter and terminal state.",
            "Keep a human stop path for every adapter.",
          ],
    ),
    "",
    "## Open questions",
    bulletList(
      questions.length
        ? questions
        : [
            "Which tab may see which upstream output?",
            "What is the fallback when an adapter breaks?",
          ],
    ),
    "",
    "## Provenance",
    `- ${first.label}: ${first.body.split("\n")[0]}`,
    `- ${second.label}: ${second.body.split("\n")[0]}`,
  ].join("\n");
}

export function buildResponse(role, prompt = "", context = "") {
  const subject = subjectOf(prompt);
  const all = `${prompt}\n${context}`.toLowerCase();
  const mentions = (...words) => words.some((w) => all.includes(w));
  const seed = hash(subject);
  const openings = [
    "The brief is directionally right, but it hides a sharp edge.",
    "The shape is sound. The risk is in the seams between components.",
    "There is a workable design here, provided the boundaries are explicit.",
  ];
  const opener = openings[seed % openings.length];

  switch (role) {
    case "claude":
      return [
        `Architecture review — ${subject}`,
        "",
        "What holds",
        bulletList([
          "The primary boundary is clear enough to test in isolation.",
          "The proposal keeps policy and mechanism separate, which will matter when the runtime changes.",
          "There is a credible path to a small, observable first slice.",
        ]),
        "",
        "Concerns",
        bulletList([
          mentions("tab", "browser")
            ? "Browser tab boundaries are a security boundary, not just a transport detail. The bridge must never grant a tab more capability than the user granted the run."
            : "The interface contract is under-specified at the failure path.",
          "Backpressure is implied but not designed. Streams need a bounded queue and a visible drop policy.",
          "The happy path assumes every participant is cooperative. Add timeout, cancellation and partial-result semantics.",
        ]),
        "",
        "Recommendation",
        `${opener} Ship the deterministic scheduler first, keep transports behind adapters, and make the extension a capability provider rather than an agent.`,
      ].join("\n");

    case "gemini":
      return [
        `Risk register — ${subject}`,
        "",
        "Operational risks",
        bulletList([
          "Cross-origin tabs cannot be scripted from page JavaScript. The extension is mandatory for third-party web agents; pretending otherwise will produce a brittle design.",
          "DOM adapters drift. Every site adapter needs a health check, a version pin and a cheap fallback to a human handoff.",
          "Long-lived streams across service-worker suspension need resumable run IDs and idempotent completion.",
        ]),
        "",
        "Questions worth answering now",
        bulletList([
          "What is the trust boundary between the canvas and a tab that is logged into a customer account?",
          "Can a downstream agent distinguish a complete result from a truncated stream?",
          "Who owns cancellation when two agents disagree and one is still running?",
        ]),
        "",
        "Assessment",
        "Feasible. The hard part is not the runtime; it is consent, capability scoping and observability across tabs. Treat the flow graph as a policy document, not only as a wiring diagram.",
      ].join("\n");

    case "mistral":
      return [
        `Implementation plan — ${subject}`,
        "",
        "Slice 1 (days, not weeks)",
        bulletList([
          "Rust/WASM core: graph validation, ready-node scheduling, bounded inboxes, job lifecycle.",
          "Local hub: one WebSocket for privileged adapters, one SSE stream for the UI, no database.",
          "Two adapters: a same-origin demo tab and one real web agent behind the extension.",
        ]),
        "",
        "Interfaces",
        "- `run` commands carry a job id, resolved inputs, context and node config.",
        "- Adapters emit `chunk` events and exactly one terminal `done` or `error`.",
        "- The core never knows what a model is; it only routes opaque messages.",
        "",
        "Non-goals for the first slice",
        "Multi-user sync, hosted persistence, visual debugging of every token, and autonomous tab creation. Add those only after the cancellation and backpressure paths are proven.",
      ].join("\n");

    case "chatgpt":
      return [
        `Decision record draft — ${subject}`,
        "",
        "Context",
        "We want multiple browser-based agents to collaborate on one artifact while a human keeps the wiring, the credentials and the stop button.",
        "",
        "Decision",
        "Use a deterministic dataflow core compiled to WASM, with browser tabs exposed as capability-scoped adapters through a local bridge. The canvas owns the graph; the hub owns transport; no agent owns the others.",
        "",
        "Alternatives considered",
        bulletList([
          "Pure BroadcastChannel: only works same-origin and cannot reach ChatGPT, Claude, Gemini or Mistral.",
          "Raw CDP from the page: no access to an already-running browser; requires a debugging port and a full-browser trust grant.",
          "Server-side orchestration only: loses the user's signed-in tabs, which is the main advantage of this design.",
        ]),
        "",
        "Consequences",
        "We accept an extension install and a local hub. In exchange we get real sessions, real streaming and a clean path to ACP/opencode for coding agents.",
      ].join("\n");

    case "moderator":
      {
        const synthesis = synthesizeReviews(prompt);
        if (synthesis) return synthesis;
      }
      return [
        `Synthesis — ${subject}`,
        "",
        "Decision",
        "Proceed with a narrow, local-first prototype: deterministic flow core, one hub, two adapters, explicit consent per tab. Do not market it as autonomous until cancellation and audit are real.",
        "",
        "Why",
        "The reviews converge on the same point: the runtime is tractable, but the browser trust boundary is the product. A design that hides that boundary will fail in the field.",
        "",
        "Action items",
        bulletList([
          "Land the graph runtime and its backpressure tests.",
          "Ship the extension bridge for one site end to end before adding a second.",
          "Add a run ledger: prompt, tab, adapter, byte counts, cancellation and terminal state.",
          "Document the fallback: when an adapter breaks, hand the tab back to the human instead of guessing.",
        ]),
        "",
        "Open questions",
        "Which tab is allowed to see which upstream output? That answer should live in the graph, not in prompt text.",
      ].join("\n");

    default:
      return [
        `Agent response — ${subject}`,
        "",
        `${opener} I received ${prompt.length} characters of input and ${context.length} characters of upstream context.`,
        "",
        "This is the deterministic demo adapter. Open an agent tab, or configure the extension, opencode or an LLM endpoint to replace it with a real agent.",
      ].join("\n");
  }
}

export function roleLabel(role) {
  const names = {
    claude: "Claude",
    gemini: "Gemini",
    mistral: "Mistral",
    chatgpt: "ChatGPT",
    moderator: "Moderator",
    echo: "Echo",
  };
  return names[role] || role;
}

export async function streamText(text, onChunk, options = {}) {
  const { signal, delay = 16, wordsPerChunk = 4 } = options;
  const tokens = String(text).match(/\S+\s*/g) || [String(text)];
  for (let i = 0; i < tokens.length; i += wordsPerChunk) {
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    onChunk(tokens.slice(i, i + wordsPerChunk).join(""));
    await new Promise((resolve) => setTimeout(resolve, delay + (i % 3) * 6));
  }
}
