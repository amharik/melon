# Enhancement Blueprint — Feasibility Critique

Date: 2026-11-13
Subject: "Melon Project Review & 100x–1000x Enhancement Blueprint"
Method: claims checked against the current `dev` tree (`core-runtime/src/lib.rs`,
`server/hub.mjs`, `extension/content.js`, `extension/background.js`,
`web/app.js`, `docs/*`).

Implementation status (2026-11-13): Phase 0–3 of the revised sequencing below is
implemented on `dev` — in-memory threads/status, the agy/stdio adapter,
approval-gated tool execution confined to worktrees, the read-only blackboard,
confirmed screenshot insertion, and the fixed-brief eval harness. ACP, rooms,
reverse CLI→web routing, CDP, artifact harvesting, and autonomous sprint loops
remain out of scope. Tool execution is human-gated, not autonomous.

## Verdict

The blueprint is directionally right about the wedge — **web minds + local CLI
hands** is the most defensible thing Melon could become. But it is not a 100x
extension of the current codebase; it is a **second product phase** with a
different trust model, new transports, and new security surfaces.

Roughly:

- **~20%** is already latent in the code or a small adapter.
- **~40%** is genuinely valuable but requires new subsystems.
- **~40%** is speculative, overclaimed, or contradicts a deliberate current
  decision (no CDP, no persistence, one-time consent, no autonomous command
  execution).

The three "immediate quick-wins" are mis-sized. One is medium, one is
security-critical, one touches the deterministic core.

## Scorecard

| Blueprint claim | Reality in code | Feasibility | Payoff |
| --- | --- | --- | --- |
| ACP as universal bus | No ACP code. opencode is HTTP/SSE, not ACP. ACP is stdio client↔agent, not cross-tab RPC. | Medium | High |
| Web tabs as virtual ACP servers | Extension has no session, thread, or capability model; `run()` is one-shot. | Medium–high | High |
| Synthetic `melon:exec` tool calls | Implemented as human-approved `melon:tool` requests; worktree-scoped, not an OS sandbox. | High effort, high risk | High if sandboxed |
| Reverse CLI→web research | No peer routing; extension routes only `agent.run`/`agent.plan`/`cancel`. | High | Medium–high |
| Rooms / @mentions / standups | Core is DAG message routing; cycles are warnings only. No peers. | High | Medium |
| Shared blackboard | Implemented: read-only `.melon/blackboard.md`; still no hub persistence. | Medium | High |
| Session continuity + compaction | Implemented: in-memory thread IDs and turns; no compaction/reset loop yet. | Medium–high | High |
| Multimodal screenshot→web chat | Implemented: confirmed capture plus synthetic paste; no auto-send. | Medium–high | High |
| Artifact harvesting into git | Hub has no filesystem write path; by design. | High risk | Medium |
| CDP / `chrome.debugger` driver | Not a permission; docs explicitly reject it. | High effort, high risk | Medium |
| Spatial office UI | 2,482-line vanilla canvas; only chunk/done/error/cancelled events exist. | Medium–high | Low–medium |
| Autonomous sprint loop | Premature; needs eval harness + governance first. | Very high | Speculative |

## Code-grounded reality check

### 1. The core is a DAG executor, not an office

`core-runtime/src/lib.rs` validates ports, routes messages, enforces `trigger`
(`any`/`all`), concurrency, bounded inboxes, and one terminal event per job. Cycles
are **allowed but only reported as warnings** (`find_cycle`, lib.rs:289). There is
no iteration counter, no room, no peer identity, no thread ID. A "debate loop" is
not a flag flip; it needs either:

- an orchestrator loop in the JS host / hub that re-fires nodes with budget and
  stop rules, or
- new explicit loop semantics in the core (iteration limits, convergence, state
  reset), which touches the deterministic contract and its tests.

The blueprint's "add a loop or feedback channel" underestimates this: the graph
already tolerates cycles but nothing prevents an infinite debate or attributes
turns.

### 2. The extension is one-shot by construction

`content.js:242-342` does exactly one cycle: fill composer → submit → poll
`snapshot()` → emit deltas → finish on stop-button absence or a 5s plateau. It
holds one `current` job per tab (`content.js:366`), has no listener for peer
messages, no conversation ID, and no way to inject a "system" turn that is not
just another user prompt. Multi-turn collaboration means rebuilding the run
lifecycle around threads, not adding an event.

Also, results from `ext` nodes are already tainted (`taint: untrusted`). Any
synthetic tool output injected back into a tab must stay tainted and be
distinguishable from user input, or the office becomes an injection amplifier.

### 3. ACP is not the universal bus the blueprint claims

`docs/ARCHITECTURE.md:366` is explicit: ACP is a client-to-agent stdio protocol,
not a cross-tab RPC. Today the hub talks to opencode over its **HTTP + SSE session
API** (`hub.mjs:426-620`), with v1/v2 route tolerance. `opencode acp` is a
different transport (stdio) and would require spawning a child process and framing
JSON-RPC — a real adapter, not a rename.

"Virtual ACP wrapper for web tabs" is therefore a **new protocol translation
layer**: ACP methods (`session/prompt`, `textDelta`, `tool/call`) mapped onto the
extension's one-shot `agent.run` and DOM polling. That is a reasonable design, but
it is not "use ACP natively"; it is invent a bridge and maintain it.

### 4. `agy` is unverified in this repo

There is no `agy` reference in the tree. The blueprint assumes a CLI with
`agy acp` and/or `--input-format stream-json`. If that binary and those flags
exist, an adapter is a contained change: `hub.mjs:983` already validates target
types, so adding `"agy"` follows the opencode/LLM pattern. If not, this is a
dependency on an external tool that is not part of the deliverable.

### 5. Synthetic tool execution is the highest-risk idea

The blueprint proposes parsing model Markdown, running commands in the workspace,
and typing results back. Missing pieces:

- `content.js` never inspects message code blocks; `snapshot()` returns text.
- The hub has no command execution or filesystem write path — deliberately.
- Pasting `[System - Executed by @agy]` into a composer is **not** a system
  message; it is attacker-influenceable text. A bridged page or a poisoned
  response can spoof it, and the model has no reliable way to tell it apart from
  its own instructions.
- Arbitrary command execution requested by untrusted web content is remote code
  execution by another name.

If pursued, the safe shape is: explicit user-approved, allowlisted commands;
execution outside the page; signed/structured `tool.request`/`tool.result`
messages; never auto-execute model-emitted text; visible approval gate and audit.
That is a feature project, not a quick win.

### 6. CDP claims are overstated and reverse a documented decision

`docs/FEASIBILITY.md:40-42` chooses MV3 content scripts and explicitly declines
`chrome.debugger`/CDP. The blueprint's Pillar 6 would add a `debugger` permission,
a scary install prompt, and a "started debugging" bar, and it conflicts with the
user's own DevTools.

- **AXTree semantic roles** do reduce selector drift, but chat UIs use custom
  roles and shadow DOM; it reduces, not eliminates, fragility.
- **"Bypasses Cloudflare bot detection"** is not credible as stated. CDP/automation
  is detectable; the 2026-11-09 evidence shows Cloudflare challenges on
  unauthenticated probes regardless. Synthetic events are not a Cloudflare
  bypass.
- **Reading stream frames via CDP Network** is possible
  (`Network.webSocketFrameReceived`) but payloads are often protobuf/SSE-wrapped
  and not guaranteed plain text; "zero latency, no DOM lag" is marketing.

CDP is defensible as an **opt-in parallel driver with its own consent and warning**,
not as a replacement for the default path.

### 7. "Zero-API-cost" is false

Web frontier chats are paid subscriptions; driving them via automation can violate
site terms and triggers rate limits/challenges. Local CLI models may be free, but
the blueprint silently assumes unlimited use of accounts the user pays for.

### 8. The security model is the real blocker, not the graph

Current guarantees: localhost hub, token-gated WS, one-time consent, per-tab
control IDs, taint propagation, metadata-only audit log, no persistence.
The blueprint's shared blackboard, command execution, artifact writes, and
autonomous loops all expand that model. None of the pillars discuss:

- per-run approval vs one-time consent;
- command/filesystem allowlists;
- cross-agent spoofing and identity;
- data residency of the blackboard (hub? disk? git?);
- what the audit log records for tool calls.

Without those, the "office" is a privilege-escalation layer.

## Contradictions and overclaims

1. **"Do not invent a proprietary schema"** — then proposes `melon:exec` tags,
   an office message router, @mention syntax, and a virtual ACP wrapper. That is
   a new protocol. Choose ACP mapping explicitly or own the new schema; don't
   claim both.
2. **"Native ACP"** — current opencode integration is HTTP/SSE; ACP is stdio. The
   transport gap is the work.
3. **"Zero selector drift"** — no CDP/AXTree approach eliminates drift; it changes
   the failure mode. Keep the health check and adapter packs.
4. **"Bypass Cloudflare"** — contradicted by the repo's own live-probe evidence.
5. **"100x–1000x"** — unmeasurable. There is no eval harness, rubric, or baseline.
   The repo's own next-experiment list (fixed brief, single vs join vs moderator)
   is the honest prerequisite.
6. **"Autonomous studio"** vs **one-time consent + no command execution** — a
   direct reversal of the current trust posture without a migration plan.
7. **Quick-win "multi-turn looping in core"** — cycles already exist as warnings;
   adding real iteration is core-contract work, not a small patch.

## What is actually a good idea

- **ACP/stream-json CLI adapter** next to opencode. High strategic value, contained
  boundary. Do this first.
- **Thread/session layer at the hub**, with `threadId` on runs and explicit
  history owned by the client/extension, not the core. This unlocks multi-turn
  without changing the scheduler.
- **Status taxonomy** (`thinking`, `typing`, `waiting`, `running-tool`) as a first
  class event in hub/extension. Cheap, and it makes any future office UI real
  rather than cosmetic.
- **Evaluation harness** with fixed briefs and a rubric. Without it, "1000x" is
  unfalsifiable and reviewers cannot approve scope.
- **Explicit tool protocol** with approval gates. Prototype it as a *consented,
  allowlisted* path before any autonomous claims.

## Revised sequencing

| Phase | Work | Why |
| --- | --- | --- |
| 0 | Finish v0.1 blockers: authenticated live-tab lane, hardware WebGPU. Add fixed-brief eval harness. | You cannot plan the office on an unverified bridge. |
| 1 | Hub thread/session layer; ACP or stream-json CLI adapter; status events; shared read-only blackboard file. | Highest payoff per unit of risk; no core rewrite. |
| 2 | Explicit, user-approved tool bridge (allowlist, structured messages, audit, taint). | The real wedge, but only with a policy model. |
| 3 | Multimodal capture → web chat (screenshots, artifacts) with approval. | Valuable, moderate risk. |
| 4 | Spatial office UI and intercom on top of real status/thread data. | Cosmetic until phase 1–2 exist. |
| Optional | CDP driver behind a separate, clearly-warned capability grant. | Do not make it the default path. |

## Bottom line

The blueprint's **product instinct is strong** (web minds + CLI hands), and two
of its ideas — an ACP/stream-json CLI adapter and a thread layer — are real,
near-term leverage. Its **amplification narrative is not yet grounded**: the core
is a DAG executor, the extension is one-shot, ACP is not a cross-tab bus, CDP is
not a Cloudflare bypass, and the autonomy/tool-execution proposals reverse the
current security model. Treat it as a **phase-2 product thesis**, not a roadmap
you can start executing line by line.
