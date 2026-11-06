# Feasibility notes

The original question: can a browser-based, lightweight runtime make tabs behave
like agents, with a dataflow canvas wiring their inputs and outputs, so that
ChatGPT, Claude, Gemini, Mistral and local opencode can collaborate on a design
review or ADR?

Short answer: **yes, with an explicit capability bridge.** The canvas, scheduler,
and same-origin tab routing are ordinary web technology. Driving *other* origins
from a normal page is not. That single constraint determines the architecture.

## The browser trust boundary

A page can script:

- its own origin;
- windows it opened or embedded, with their cooperation (`postMessage`), and even
  then it cannot read their DOM unless same-origin;
- workers and `BroadcastChannel` on the same origin.

A page cannot:

- enumerate or read arbitrary tabs;
- inject text into `chatgpt.com` from `127.0.0.1`;
- attach a debugger to the browser;
- read another origin's DOM, storage, or network responses.

Therefore any design that claims a normal web page can orchestrate signed-in
third-party tabs is wrong. The options are:

| Approach | Reach | Cost |
| --- | --- | --- |
| `BroadcastChannel` / `SharedWorker` | Same-origin tabs only | No install, no third-party agents |
| Open a popup and use `postMessage` | Only cooperating pages you control | Does not work with real ChatGPT/Claude |
| Browser extension + content scripts | Any permitted tab | Install, broad host permissions, brittle DOM |
| Extension + `chrome.debugger` (CDP) | CDP over any permitted tab | Scarier permission, more power, more breakage |
| Launch Chrome with `--remote-debugging-port` | Full CDP from a local process | Not the user's existing browser session by default |
| Server-side API calls | Models directly | Loses the user's signed-in tab and web-only features |

Melon chooses the least powerful option that reaches the real tabs: **MV3
extension + content scripts**, with the local hub as transport. It does not use
`chrome.debugger` or CDP. The extension is a capability provider, not an agent.

## Protocol landscape

These names sound adjacent but solve different problems:

- **ACP (Agent Client Protocol, Zed)** — JSON-RPC over stdio between a client such
  as an editor and a coding agent. opencode exposes `opencode acp`. It is not a
  cross-tab or agent-to-agent bus.
- **A2A (Agent2Agent)** — HTTP/JSON-RPC + SSE, agent discovery via Agent Cards.
  A reasonable future adapter for remote agents, but it does not solve browser
  tab access.
- **WebMCP** — a proposed browser API for exposing page functionality as tools to
  an agent. It is a page-to-agent surface, not arbitrary cross-origin tab RPC.
- **MCP (Model Context Protocol)** — tool/resource access for models. Useful for
  local tools, not for driving a chat UI.

Conclusion: none of these replaces the extension for third-party tab control.
Melon's internal contracts are intentionally small JSON messages so any of them
can be adapted at the edge later.

## Runtime choice

**Rust + WASM** for the scheduler:

- The core is stateful, benefits from exhaustive tests, and must run identically
  in the browser and in Node tests.
- `wasm32-unknown-unknown` is mature, the target is installed, and the artifact
  is small without a framework.
- The workload is I/O-bound, so WASM is for portability and determinism, not raw
  speed.

**Zig** would also work and produces small WASM, but the Rust toolchain here is
more complete for testing and JSON handling. There was no performance reason to
prefer either.

**No wasm-bindgen**: a four-function ABI (`alloc`, `call`, `out_len`, `version`)
keeps the artifact dependency-free. The trade-off is manual UTF-8 and buffer
copying in `web/shared/wasm.js`, which is ~30 lines.

## What was built

A runnable vertical slice:

- graph validation, any/all triggers, fan-out, joins, queues, concurrency,
  backpressure, cancellation, metrics;
- a local hub with SSE, a token-gated extension WebSocket, opencode and
  OpenAI-compatible adapters;
- a canvas with drag-to-connect, inspector, activity log, and deterministic demo
  agents;
- an MV3 extension with adapters for ChatGPT, Claude, Gemini, and Mistral;
- same-origin demo agent tabs using `BroadcastChannel`;
- Rust, WASM ABI, and hub integration tests;
- an opt-in, metadata-only local audit log for hub-routed runs.

Verified in headless Firefox through Marionette: the page loads the WASM core,
opens SSE, runs the example graph, streams through the join, and completes with
the sink populated. The extension is syntactically validated but not end-to-end
tested here because this environment has no Chrome/Chromium.

## Adapter matrix

| Surface | Mechanism | Confidence |
| --- | --- | --- |
| Same-origin demo tab | `BroadcastChannel` | High |
| opencode | HTTP session + SSE | Medium; route shapes vary |
| OpenAI-compatible LLM | `/chat/completions` streaming | High |
| ChatGPT web | Extension DOM adapter | Medium; selector drift |
| Claude web | Extension DOM adapter | Medium; streaming/stop heuristics |
| Gemini web | Extension DOM adapter | Medium; shadow DOM risk |
| Mistral web | Extension DOM adapter | Low/medium; markup varies |

The extension adapters are configuration, not deep integrations. They deliberately
avoid site-specific React internals and instead look for composer, send, stop, and
last-response elements.

## Risk register

| Risk | Impact | Current mitigation | Next step |
| --- | --- | --- | --- |
| Cross-origin scripting impossible from page | Architecture invalid without extension | Extension mandatory, documented | Keep a no-extension demo path |
| DOM selectors change | Runs fail or read the wrong node | Ping/health dashboard, visible errors | Recorded selector fixtures in real Chrome |
| Prompt injection from a bridged tab | Data exfiltration, bad downstream actions | One-time consent, human binding, control ids, taint labels, metadata audit log, no secrets in prompts | Per-run approval for high-risk sites |
| Extension has broad tab access | High blast radius | Token-gated local WS, origin allowlist, one-time consent, per-tab control ids, metadata audit log | Signed adapter manifests |
| Hub exposed beyond localhost | Anyone can start runs | Defaults to `127.0.0.1`, CORS restricted | Auth + TLS before any network binding |
| Service worker suspension | Lost WebSocket/events | 25s hub ping, reconnect/backoff, event buffer | Resumable run IDs, idempotent completion |
| Streaming completion heuristics | Truncated or duplicated results | Stop-button check plus stability window | Explicit per-site completion signals |
| opencode API drift | Adapter fails | Try v1 and v2 routes, report last error | Pin a tested opencode version |
| Model output nondeterminism | Review quality varies | Human-in-the-loop stop and inspection | Evaluation harness with fixed briefs |

## What this proves

- The dataflow model is a good fit for multi-agent review: fan-out, join, and a
  final sink map directly onto "ask two reviewers, reconcile, decide."
- Tabs can be treated as capability-scoped agents without a server seeing their
  sessions, provided the user grants the bridge.
- A small deterministic core plus a dumb transport is enough to make the system
  inspectable. The hard problems are policy, selectors, and failure semantics.

## What it does not prove

- That DOM automation is reliable enough for unattended production use;
- that users will accept the permission model;
- that a web UI is the best place to configure complex agent graphs;
- that any particular model or site adapter will remain stable;
- that the hub's opencode/LLM route guesses match every release;
- that the hub is invisible to the conversation: it sees run text in memory,
  even though it persists nothing. Keeping the hub out of the data path would
  require a page-to-content-script relay or a native messaging host.

## Recommended next experiments

1. Run the extension end-to-end in Chrome against one site with a recorded
   selector fixture, and record failure modes.
2. Replace the streaming stability heuristic with per-adapter completion signals
   (DOM attribute or stop-button disappearance).
3. Add an ACP adapter next to opencode, and an A2A adapter for remote agents.
4. Test resumable runs across service-worker suspension, using the audit log for
   run diagnostics.
5. Evaluate review quality with a fixed brief and a rubric, comparing
   single-agent, two-agent join, and moderator configurations.
