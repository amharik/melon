# Melon — PRD Review Summary

Status: v0.1 prototype, `dev` branch
Last reviewed: 2026-11-13
Sources: `README.md`, `docs/FEASIBILITY.md`, `docs/ARCHITECTURE.md`, `docs/MILESTONES.md`, `docs/evidence/2026-11-09/`

## 1. One-liner

Melon is a local-first browser runtime for an **agentic office**: browser tabs are
treated as agents, wired into a dataflow canvas, and streamed into a shared result.

## 2. Problem

Knowledge work is spread across multiple AI chat tabs (ChatGPT, Claude, Gemini,
Mistral) plus local coding agents. Today a user manually copies a brief into each
tab, reconciles the answers by hand, and loses the provenance and streaming state
of each contribution.

Melon tests the hypothesis: **can a browser-based, lightweight runtime make tabs
behave like agents, with a dataflow graph wiring their inputs and outputs, so
multiple assistants can collaborate on a design review or ADR?**

## 3. Target user

- Technical power users and developers who already use multiple AI tabs and a
  local coding agent (opencode / Ollama).
- Users who value local execution, signed-in web sessions, and inspectability over
  cloud orchestration.
- Not (yet) a multi-user, hosted, or mobile product.

## 4. Goals

- Treat real, signed-in third-party AI tabs as capability-scoped agents.
- Expose multi-agent collaboration as an inspectable dataflow graph:
  fan-out, join, streaming, cancellation, metrics.
- Keep conversation storage out of the hub: local transport only, optional
  metadata-only audit log.
- Ship selector fixes and graph proposals without a full extension release.
- Fail back to deterministic behavior whenever optional AI features are absent.

## 5. Non-goals

- Hosted/cloud deployment, multi-user sync, mobile.
- Conversation history or transcript persistence.
- Unattended, high-reliability DOM automation.
- Being a general workflow engine with implicit loop semantics.
- Replacing MCP/ACP/A2A; interop may be added at the edge later.

## 6. Core constraint

A normal page cannot script other origins. Therefore any claim that a web page can
drive real ChatGPT/Claude tabs is false. The feasible options are `BroadcastChannel`
(same-origin only), cooperating popups, an MV3 extension, `chrome.debugger`/CDP, or
server-side APIs. Melon deliberately chooses the **least powerful option that
reaches real tabs: an MV3 extension + content scripts**, with a local hub as
transport. It does not use CDP.

## 7. Solution overview

| Component | Responsibility |
| --- | --- |
| **Rust → WASM core** (`core-runtime/`) | Deterministic scheduling: graph validation, any/all triggers, bounded queues, fan-out/join, concurrency, cancellation, metrics. No model logic. |
| **Local Node hub** (`server/hub.mjs`) | Static server, SSE to canvas, token-gated WebSocket to extension, opencode + agy/stdio + OpenAI-compatible adapters, in-memory threads, approval-gated tool execution, worktrees, read-only blackboard, audit log, adapter-pack hosting. No database. |
| **Vanilla canvas UI** (`web/`) | Graph editor, drag-to-connect, inspector, activity log, run versioning, demo tabs. No bundler/framework. |
| **MV3 extension** (`extension/`) | The only component allowed to read/type into third-party tabs. DOM adapters, health checks, control badges, consent gate, local AI offscreen host. |

Key boundaries: the core never knows what a model is; the extension never
schedules; the hub stores no persistent conversation content (bounded threads are
in-memory only).

## 8. Current capabilities

- Dataflow core with joins, fan-out, backpressure (`drop-oldest`, inbox 2048),
  concurrency, cancellation, and cycle warnings.
- Canvas run controls: Play, Pause, Resume, Stop all; per-node rerun and
  resume-from-here; versioned outputs keyed by `runId`, `runSeq`,
  `workflowVersion`; stale-output marking.
- Hub APIs: `GET /api/health`, `/api/config`, `/api/tabs`, `/api/events` (SSE),
  `POST /api/runs`, run cancel, threads (`/api/threads`), tool approvals
  (`/api/tool-requests`), worktrees, blackboard, screenshot requests,
  `POST /api/llm`, `POST /api/plan`, `POST /api/kev/rerank`, signed adapter-pack
  endpoints.
- Phase 0–3 host orchestration: in-memory threads and statuses; agy/stdio CLI
  adapter; human-approved tool execution confined to git worktrees with untrusted
  output; read-only `.melon/blackboard.md`; confirmed screenshot insertion.
- Deterministic fixed-brief evaluation (`npm run eval`) comparing a single agent
  with a two-reviewer moderator.
- Extension bridge: ChatGPT, Claude, Gemini, Mistral DOM adapters; selector
  resolver with health (`melon.ping`); streaming delta and completion heuristics;
  stop-button cancellation.
- Trust controls: one-time bridge consent, per-tab control IDs (`T-…`) shown
  in-page and in canvas, taint propagation for browser results, CORS/origin
  checks, localhost binding, file-mode `0600` token and audit log.
- Optional local AI: WebGPU offscreen host, pinned model catalog (Qwen 1.5B/0.5B,
  Llama 3.2 1B, LFM2.5 350M), planner `POST /api/plan` with schema validation and
  explicit **Apply plan**.
- Optional Kev decision-model reranking: planner candidates, upstream trim,
  adapter selector tie-breaks, page-context passages; deterministic fallback.
- Signed Ed25519 adapter packs hosted by the hub with ETag/304 updates and
  downgrade/expiry rejection.
- Same-origin `BroadcastChannel` demo agents for keyless, deterministic testing.

## 9. Real vs simulated

| Path | Status |
| --- | --- |
| WASM scheduler, queues, joins, cancellation | Real |
| Same-origin demo tabs over `BroadcastChannel` | Real |
| Extension bridge + DOM adapters | Real, selector-dependent |
| opencode adapter | Real, tolerant of v1/v2 routes |
| agy / stdio CLI adapter | Real when `AGY_CMD` exists; NDJSON contract |
| Threads and run status | Real, in-memory and non-persistent |
| Approval-gated tool execution | Real; worktree-scoped, human-approved, untrusted output |
| Shared blackboard | Real, read-only |
| Screenshot insertion | Real, best-effort, confirmed and never auto-sent |
| OpenAI-compatible streaming | Real |
| Demo agents | Deterministic simulation |
| Local model graph proposal | Real, optional, validated before apply |
| Kev reranking | Optional local decision model |

## 10. Evidence and verification

Remote Chromium lane: `ubuntu@sillyoci`, Playwright Chromium 158 (Linux/arm64).

| Check | Result |
| --- | --- |
| Node + hub tests | 52/52 passed |
| Signed adapter pack | v2 verified against pinned key |
| Synthetic adapter E2E | ChatGPT, Claude, Gemini, Mistral passed |
| Live-tab probe | 0/4 ready (Cloudflare / Google login challenges) |
| WebGPU adapter | `google/swiftshader` only (software) |

Local: `cargo test`, `npm test` (runtime, audit, hub, kev, extension, adapters,
planner, protocol, simulator, ai, adapter-pack, threads, worktrees, agy, phase
approvals, evals), `npm run eval`, and `npm run e2e`. The eval harness reports
single-agent 0.60 / moderator 0.888 / lift 0.288 on the current fixed briefs. CI
runs `npm test` + `npm run e2e` on every push/PR to `dev`.

## 11. Milestone status (v0.1)

- [x] Rust/WASM dataflow core
- [x] Hub + SSE + extension WebSocket + metadata audit log
- [x] Four site adapters + shared resolver
- [x] Bridge consent, control IDs, in-page stop badge
- [x] Taint propagation
- [x] Planner validate → review → apply flow
- [x] Optional Kev reranking
- [x] Synthetic real-Chromium E2E for all four adapters
- [x] Local AI catalog + WebGPU offscreen smoke test
- [x] Live-site health/login/challenge probe
- [x] Pinned arm64 test lane + CI
- [x] Real planner inference on remote WASM lane
- [x] Signed adapter-pack hosting + update verification
- [x] Phase 0: threads, run status, host-level orchestration
- [x] Phase 1: agy/stdio CLI adapter with worktree selection
- [x] Phase 2: approval-gated tool execution confined to worktrees, untrusted output
- [x] Phase 3: read-only blackboard, screenshot insertion, fixed-brief eval harness
- [ ] **Hardware WebGPU planner run** — blocked: Haswell Vulkan stalls; remote
      only exposes SwiftShader.
- [ ] **Authenticated live-tab run in CI** — blocked by Cloudflare/Google login.

## 12. Risks

| Risk | Impact | Current mitigation |
| --- | --- | --- |
| DOM selectors change | Failed or wrong-tab runs | Health dashboard, visible errors, fixtures, signed adapter packs |
| Prompt injection from a bridged tab | Exfiltration / bad downstream actions | Consent, human binding, control IDs, taint labels, no secrets in prompts |
| Extension has broad tab access | High blast radius | Token-gated local WS, host allowlist, one-time consent, audit metadata |
| Hub exposed beyond localhost | Anyone can start runs | Localhost default, CORS/origin checks; auth + TLS required before network binding |
| Service-worker suspension | Lost socket/events | 25s ping, reconnect/backoff, event buffer |
| Streaming heuristics | Truncated / duplicated output | Stop-button check + stability window |
| opencode API drift | Adapter failure | v1/v2 route fallbacks, last-error reporting |
| Model output nondeterminism | Variable review quality | Human-in-the-loop, inspectable versions |
| Hub sees run text in memory | Trust-boundary caveat | No persistence; bounded in-memory threads; page-to-content-script relay is the stricter future design |
| Approved command is malicious or over-broad | Local code execution as the user | Explicit human approval, worktree-confined cwd, timeout; not an OS sandbox |
| Tool output carries instructions | Prompt injection into the tab | Always `taint: untrusted`; inserted with a warning and never auto-submitted |

## 13. Open product questions for PRD review

1. **Positioning:** developer demo/prototype, or a shippable local product? The
   README currently says "runnable prototype, not a product."
2. **Reliability bar:** is selector-dependent DOM automation acceptable for the
   target user, given the documented fallback to human handoff?
3. **Permission model:** will users accept broad host permissions plus a one-time
   consent? Is per-run approval needed for high-risk sites?
4. **Local AI value:** does on-device planning/reranking justify large model
   downloads versus using the already-connected tabs or a local LLM endpoint?
5. **Hub trust:** is "local trusted service that sees text in memory" acceptable,
   or is keeping the hub out of the data path a v0.1 requirement?
6. **Interop:** should ACP/A2A adapters be prioritized next to opencode?
7. **Success metric:** what proves the agentic-office thesis — review quality vs
   single-agent, time saved, or adapter reliability?

## 14. Recommended next steps

1. Resolve the two blocked milestones: hardware WebGPU run and authenticated
   live-tab run (persistent login profile or CI secret).
2. Replace streaming stability heuristics with per-adapter completion signals.
3. Extend the fixed-brief eval (`npm run eval`) with real adapters and compare
   single agent vs two-agent join vs moderator against a stable rubric.
4. Review the per-run approval UX and decide whether high-risk sites need a
   stricter command allowlist or an OS sandbox.
5. Add ACP and A2A adapters at the edge without changing the core contracts.

## 15. Known limitations

- Firefox supported in principle; extension tested on Chrome/Edge.
- Adapters are heuristic; no automatic selector repair beyond signed packs.
- opencode/LLM adapters are route-tolerant guesses across releases.
- Local AI requires WebGPU-capable Chromium; downloads are large.
- No persistence, multi-user sync, hosted deployment, or mobile support. Threads
  and run status reset when the hub restarts.
- Approved tool execution is worktree-scoped but not OS-sandboxed; the `agy` CLI
  flags are configuration, not a pinned integration.
- Screenshot capture depends on Chrome's active-tab rules and site paste support.
- Canvas is mouse-first; keyboard support limited to Escape and Ctrl/Cmd+Enter.
