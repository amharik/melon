# Architecture

Melon separates three concerns that are easy to conflate:

1. **Scheduling** — when a node runs, what it receives, and how backpressure is
   applied. Owned by the Rust/WASM core.
2. **Transport** — how a command reaches a browser tab, an opencode server, or an
   LLM endpoint. Owned by the local hub and the extension.
3. **Policy** — which tabs are bound, what prompt is sent, and what the human sees.
   Owned by the canvas and the user.

The core never knows what a model is. The extension never schedules. The hub
stores no conversation content; an optional audit log stores run metadata only.

## Component map

```text
┌──────────────────────────── browser ────────────────────────────┐
│                                                                  │
│  canvas (web/)                    same-origin demo tabs          │
│  ┌──────────────┐  BroadcastChannel  ┌──────────────────┐        │
│  │ graph editor │◄───────────────────►│ agent.html?role= │        │
│  │ WASM core    │                     └──────────────────┘        │
│  └──────┬───────┘                                                │
│         │ HTTP + SSE                                             │
│  ┌──────▼─────────────────────────────────────────────────────┐  │
│  │ local hub (server/hub.mjs)                                 │  │
│  │ static · SSE · run broker · opencode · OpenAI-compatible   │  │
│  └──────┬──────────────────────────────┬──────────────────────┘  │
│         │ WebSocket (token)            │ HTTP + SSE              │
│  ┌──────▼────────────┐          ┌──────▼──────────────┐          │
│  │ MV3 extension     │          │ opencode serve      │          │
│  │ background + DOM  │          │ or LLM endpoint     │          │
│  └──────┬────────────┘          └─────────────────────┘          │
│         │ chrome.tabs / scripting                                │
│  ┌──────▼─────────────────────────────────────────────────────┐  │
│  │ third-party tabs: ChatGPT, Claude, Gemini, Mistral         │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Runtime core

`core-runtime/src/lib.rs` is a deterministic dataflow engine compiled both for
the host (unit tests) and `wasm32-unknown-unknown` (browser).

### Graph model

A node has:

```json
{
  "id": "claude",
  "kind": "agent",
  "label": "Claude",
  "trigger": "any",
  "concurrency": 1,
  "inputs": ["in"],
  "outputs": ["stream", "result"],
  "config": {},
  "x": 270,
  "y": 60
}
```

Edges connect `{ node, port }` endpoints. The core validates that ports exist and
rejects a graph atomically on error.

- `trigger: "any"` starts a job when any input port receives a message.
- `trigger: "all"` requires at least one message on every input port.
- `concurrency` limits simultaneous jobs per node. Extra inputs queue.
- Inbox size defaults to `2048` with `drop-oldest`; a `backpressure` event is
  emitted with the dropped count.
- Cycles are allowed but reported as warnings. There are no implicit iteration
  semantics beyond message routing.

### Job lifecycle

1. The core emits a `run` command for a ready node with resolved `inputs`.
2. The JS host executes the node. For an agent it streams `chunk` messages and
   emits a final `result`, then calls `finish`.
3. `finish` with no error produces `job.finished`. With an error it also carries
   the error. Cancellation is `finish` with `{ "message": "cancelled" }`.
4. A job ends exactly once. Late events for an unknown job are ignored by the hub.

### Command protocol

All calls are JSON in, JSON out:

| Op | Purpose |
| --- | --- |
| `ping` | Version handshake |
| `set_graph` | Validate and replace the graph |
| `emit` | Send messages from a source node port |
| `output` | Send messages from a running job port |
| `finish` | Complete a job, optionally with an error |
| `cancel` | Complete a job with a cancellation error |
| `input` | Inject directly into a node inbox (tests/tools) |
| `reset` | Clear queues, jobs, metrics |
| `snapshot` | Graph plus queue/running/job state |
| `metrics` | Counters and per-node metrics |

Every response includes `ok`, `events`, `commands`, and `metrics` for that call
only. Events include `job.started`, `job.finished`, `backpressure`, and warnings.

### WASM ABI

No wasm-bindgen. The boundary is four exported functions:

```c
uint8_t* melon_alloc(size_t len);
const uint8_t* melon_call(uint8_t* ptr, size_t len); // consumes ptr
size_t melon_out_len(void);
uint32_t melon_version(void);
```

The output buffer is reused, so the host copies bytes out before the next call.
`web/shared/wasm.js` implements this. The benefit is a small artifact (~205 KB)
and no generated glue; the cost is manual memory discipline.

## Canvas host

`web/app.js` is the runtime host:

- Loads the WASM module and applies the persisted graph from `localStorage`.
- Owns node execution: demo agents, bound demo tabs, extension tabs, opencode,
  and LLM.
- Serializes jobs through `activeJobs` and `MAX_ACTIVE` (12).
- On stop, cancels hub runs, posts cancel to the extension, rejects pending tab
  runs, and finishes active jobs with cancellation.
- Tracks runs as `run_<n>` and stores per-node output records keyed by run and
  workflow version. Streaming writes go to the command's own record, so a
  concurrent or later run cannot append into an earlier node preview.
- Supports Play/Pause/Resume/Stop all, per-node rerun and resume-from-here.
  Manual reruns reuse the last resolved inputs and execute the node with its
  current config, then optionally route the result into downstream nodes.

Agent adapters emit:

```json
{ "type": "chunk", "text": "..." }
{ "type": "done", "text": "..." }
{ "type": "error", "error": { "message": "..." } }
{ "type": "cancelled" }
```

### Same-origin tab bus

Demo tabs use `BroadcastChannel("melon.office.demo")` with
`PROTOCOL = "melon.office.v1"`:

- `presence.request` / `presence` — heartbeat and role info.
- `run` — `{ runId, role, prompt }`
- `chunk` / `done` / `error` / `cancelled` — correlated by `runId`.
- App-side outputs also carry `runId`, `runSeq`, `workflowVersion` and `format`
  (`markdown`, `text`, `json`, `image`). The format is declared metadata; the
  core routes messages opaquely.
- `cancel` — best-effort cancellation.

This path is real tab-to-tab messaging, but only same-origin. It is a proof of the
routing contract, not a substitute for the extension.

## Hub

`server/hub.mjs` uses only Node built-ins.

### HTTP

- `GET /` and static files from `web/`.
- `GET /api/health` — version, uptime, adapters, extension/tab/run counts, and
  whether the audit log is enabled.
- `GET /api/config` — non-secret adapter configuration.
- `GET /api/tabs` — aggregated tabs from connected extensions.
- `GET /api/events` — SSE: `hello`, `tabs`, `run.event`.
- `POST /api/runs` — `{ runId, prompt, target }`, where target is one of:
  - `{ "type": "extension", "tabId": 42, "adapter": "auto" }`
  - `{ "type": "opencode", "url": "http://127.0.0.1:4096" }`
  - `{ "type": "llm" }`
- `POST /api/runs/:id/cancel`
- `POST /api/llm` — streaming proxy for same-origin use.

Run IDs are client-generated and unique. The hub returns `202` immediately and
streams progress over SSE.

### Audit log

`MELON_AUDIT_LOG=/path/to/audit.jsonl` (or `MELON_AUDIT=1` for
`.melon/audit.jsonl`) enables an append-only JSONL log. `server/audit.mjs` writes
only an allowlist of fields: timestamp, event, run id, target, node, label,
adapter, tab/control id, status, duration, character count, and timeout flag.
Prompts, streamed text, page context, and raw error messages are dropped before
serialization. The file is created with mode `0600`. This is operational
metadata for a local run, not a conversation transcript.

### Extension WebSocket

`GET /extension?token=...` upgrades to a WebSocket. The token is compared in
constant time against `.melon-token` (or `MELON_TOKEN`).

Extension to hub:

```json
{ "type": "hello", "name": "melon-extension", "tabs": [] }
{ "type": "tabs", "tabs": [{ "id": 42, "title": "...", "url": "...", "active": true, "attached": true }] }
{ "type": "run.event", "runId": "run-1", "event": { "type": "chunk", "text": "..." } }
{ "type": "pong", "t": 123 }
```

Hub to extension:

```json
{ "type": "agent.run", "runId": "run-1", "tabId": "42", "controlId": "T-16", "prompt": "...", "adapter": "auto" }
{ "type": "cancel", "runId": "run-1" }
{ "type": "ping", "t": 123 }
```

The hub routes a run to the extension client that currently reports the target
tab. If the client disconnects, its in-flight extension runs are failed.

## Extension

MV3 service worker (`extension/background.js`):

- Holds one WebSocket to the hub, with exponential backoff.
- Reports tabs on create/remove/update/activate (debounced).
- Injects `adapters.js` and `content.js` on demand if a target tab does not answer
  `melon.ping`.
- Buffers events briefly while reconnecting; the hub's 25s ping keeps the worker
  active.
- Opens options on install when no token is configured.

Adapter catalog (`extension/adapters.js`):

- Host regexes, ordered selector candidates, and required-field metadata are data,
  not executable site integrations.
- The resolver prefers earlier candidates, rejects hidden or disabled controls,
  penalizes search boxes, and keeps send/stop away from the composer when possible.
- Response snapshots deduplicate nested matches, keep top-level messages, and pick
  the latest one by document order. This avoids counting a `.markdown` child twice.
- `validateAdapter`/`validateCatalog` catch malformed host regexes, empty
  selector lists, duplicate ids, and invalid required flags.
- `melon.ping` returns the resolved adapter id, schema version, and per-field
  health, so failures are visible before a run starts.
- Fixture tests in `test/fixtures/adapters/` simulate current ChatGPT and Claude
  markup and exercise fallback and safety behavior.

```js
{
  id: "claude",
  version: 1,
  hosts: ["(^|\\.)claude\\.ai$"],
  fields: {
    composer: { required: true, candidates: ['div[contenteditable="true"].ProseMirror'] },
    send: { required: false, candidates: ['button[aria-label="Send message"]'] },
    stop: { required: false, candidates: ['button[aria-label*="Stop"]'] },
    response: { required: false, candidates: ['[data-testid="assistant-message"]'] }
  }
}
```

Content script (`extension/content.js`):

- Picks an adapter by hostname or by explicit name; unknown names fall back to the
  hostname, which keeps the canvas's generic `ext` binding working.
- Uses the resolver for composer, send, stop, and response rather than querying
  selector strings directly.
- Finds the composer, sets native values or uses `execCommand("insertText")` for
  contenteditable editors, and submits with the send button or Enter.
- Snapshots the last response element before submission, then polls for a new or
  changed response. Deltas become `chunk`; stability with no stop button (or a 5s
  plateau) becomes `done`.
- Cancellation clicks the site's stop button if one is present.
- The extension caches `melon.ping` health for each supported tab and reports the
  selected adapter, field readiness, busy state, and errors through `/api/tabs`.
  The canvas shows this before binding and disables unsupported sites.
- Results from `ext` nodes carry `taint: "untrusted"` on chunks and results.
  `promptFromInputs` labels tainted ports, `composePrompt` adds a data-not-
  instructions guard, and the canvas marks the node plus downstream lineage.
- A one-time consent in the options page gates real-tab runs. Each tab gets a
  short control id (`T-...`), passed with `agent.run`. While controlled, the tab
  shows a shadow-DOM badge with that id and a Stop action; the canvas shows the
  same id in its tab list.
- When Kev is configured, the resolver sends up to six competing composer/send
  candidates to the hub only when the deterministic scores are close. Static
  resolution remains the fallback.
- An `ext` node can opt into page-context retrieval. The content script collects
  visible `p`, `li`, `pre`, and `blockquote` text from the page's main region and
  asks Kev for the three most relevant passages before submitting the prompt.

This is still the brittle part. Selectors are best-effort against current markup
and need maintenance.

## Local AI host

Local AI is optional and lives beside the deterministic adapters:

```text
options page -> background -> offscreen document -> Transformers.js
                    |                 |
                 ai.status        WebGPU model + cache
```

- `extension/ai/models.js` is the single model catalog used by the options page,
  background worker, and offscreen host. It pins each Hugging Face revision and
  records dtype, approximate size, and license.
- `extension/ai/offscreen.html` hosts Transformers.js. Offscreen is used instead
  of the service worker because model state should survive worker suspension and
  because ONNX Runtime is happiest with a full DOM context.
- `extension/vendor/` is generated by `scripts/vendor-ai.sh`; it contains the
  pinned Transformers.js bundle and ONNX Runtime WebGPU worker/WASM assets. It is
  not loaded from a CDN, so the extension CSP remains `script-src 'self'`.
- The background owns lifecycle and status. Users explicitly enable AI, pick a
  model, and grant optional Hugging Face host permission before a download.
- Model weights are fetched only on opt-in, pinned by revision, and cached by the
  browser. Prompts and page text are not sent to Hugging Face.
- If WebGPU, permissions, the download, or the model runtime fails, the failure
  is reported in options; deterministic adapter runs are unaffected.

The model host supports selecting, downloading, loading, unloading, and
smoke-testing the selected planner model. Graph planning and optional Kev
reranking are wired through `POST /api/plan`:

```text
canvas brief -> hub /api/plan -> extension WS agent.plan -> offscreen ai.generate
     ^                                                              |
     |                                                              v
     +-- validated graph <- web/shared/planner.js <- raw JSON <- model
                              |
                              +-> optional Kev rerank of valid candidates
```

- The extension builds the planner prompt in `extension/ai/planner.js`; the hub
  sends only the goal and does not load a model itself.
- `web/shared/planner.js` extracts JSON, normalizes ids/adapters, infers layout,
  checks ports, rejects cycles/unreachable nodes, and enforces exactly one source
  and sink. The canvas previews the result and requires **Apply plan**.
- The planner is opt-in and does not change deterministic run behavior.
- When `KEV_URL` is set, the hub can generate up to four candidate graphs per
  request, validate each, and ask Kev to choose one. Invalid candidates are
  discarded before reranking; Kev failure falls back to the first valid graph.
- Kev is a System One decision model served by Ollama at `/v1/systemone`, not a
  generator. The hub owns the HTTP call and exposes `POST /api/kev/rerank` with
  `{query, candidates: [{id, text}], topK}`. Candidate text is local to the hub.
- The canvas uses Kev to reorder/trim upstream agent results before a join or
  moderator when Kev is configured. The extension proxies Kev calls for ambiguous
  adapter selectors and opt-in page-context retrieval. All paths fall back to
  deterministic behavior.
- Kev's published evaluations show decision models are not automatically better
  rerankers. Melon treats this layer as an optional heuristic, never as the sole
  control for whether a DOM action or graph is applied.

## opencode adapter

opencode is treated as an HTTP service, not as a local process:

1. Create a session. The hub tries `/session` then `/api/session`.
2. Subscribe to the session event stream (SSE).
3. Send a prompt. Routes tried: `/session/:id/prompt_async`,
   `/session/:id/message`, `/api/session/:id/prompt`.
4. Extract text deltas from event payloads and forward them as run chunks.
5. Cancel via `/session/:id/abort` or `/api/session/:id/abort`.

The v1/v2 tolerance is intentional because opencode route shapes have changed.
If none match, the run fails with the last HTTP status.

Note: ACP (Zed's Agent Client Protocol) is a *client-to-agent* stdio protocol.
It is not a cross-tab RPC. Melon can add an ACP adapter, but it would sit next to
the opencode HTTP adapter, not replace the hub.

## Security model

- The hub is a local trusted service. Binding to localhost is the boundary.
- The extension token gates privileged tab access. It is not an API auth token for
  local processes.
- CORS is restricted to same-origin and extension origins, so an arbitrary website
  cannot read `/api/tabs`. Mutating routes additionally reject disallowed
  `Origin` headers and require `application/json` for body-bearing requests,
  which blocks simple cross-origin POSTs. A local process can still call the hub.
- Bridged tabs are capability grants. Real-tab runs require a one-time consent in
  the extension options. A bridged tab can see the prompt and can influence
  downstream agents; prompt injection and data exfiltration through the model are
  still in scope. Each controlled tab advertises a unique control id in-page and
  in the canvas so the grant is observable. Bridged-tab output is tainted and
  downstream prompts explicitly label it as untrusted data.
- The hub deliberately keeps no history. It holds prompts and streamed text in
  memory only for the lifetime of a run.
- Local AI downloads model files from Hugging Face only after an explicit
  optional-permission grant. The runtime is vendored locally; model output is
  treated as untrusted and never executed as code.

## Decisions

| Decision | Reason |
| --- | --- |
| Rust over Zig for the core | Mature `wasm32-unknown-unknown` support, tooling, and tests; the workload is I/O-bound. |
| Raw WASM ABI, no wasm-bindgen | Smaller artifact, no codegen, explicit memory; the boundary is four functions. |
| Local hub, no cloud | Preserves signed-in browser sessions and avoids a server that sees conversations. |
| MV3 extension for third-party tabs | Pages cannot script other origins; CDP alone requires a full-browser debugging grant. |
| Vanilla UI, no bundler | One less toolchain; the prototype stays inspectable. |
| Offscreen document for local AI | Keeps a WebGPU model resident outside the ephemeral MV3 worker. |
| Zero-dependency Node hub | Custom SSE/WebSocket is enough for local, single-user traffic. |
| Deterministic demo agents | The graph is testable without keys, tabs, or network. |
