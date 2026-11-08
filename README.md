# Melon

A browser-based runtime for an **agentic office**: browser tabs are treated as
agents, wired into a dataflow canvas, and streamed into a shared result.

Melon is deliberately small:

- **Rust core compiled to WASM** — graph validation, scheduling, bounded queues,
  fan-out/join, concurrency, cancellation, metrics. No model logic.
- **One local Node hub** — static server, SSE to the canvas, WebSocket to the
  extension, plus opencode and OpenAI-compatible adapters. No database, no
  conversation history.
- **Vanilla canvas UI** — no bundler, no framework. Nodes, ports, drag-to-connect,
  inspector, activity log, demo tabs.
- **MV3 extension bridge** — drives real ChatGPT, Claude, Gemini and Mistral tabs
  with DOM adapters, because normal pages cannot script other origins.

This is a runnable prototype, not a product. The interesting part is the
boundary: what a browser can honestly do, and what needs an explicit capability
grant.

## Quick start

Requirements: Node 20+ (tested on 24). Rust is only needed to rebuild the WASM
core; the repository already includes `web/wasm/melon_core.wasm`.

```bash
node server/hub.mjs
```

The hub prints a canvas URL and an extension token. Open the URL:

```text
http://127.0.0.1:8787/
```

Click **Play** (or **Send into graph**). The example graph runs entirely locally
with deterministic demo agents, so you can see streaming, fan-out, a join, and a
sink without configuring anything.

### Real browser agents

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
   and select the `extension/` directory.
2. Open the extension's options, paste the token printed by the hub, accept the
   one-time bridge consent, and save.
3. Open `https://claude.ai/` (or ChatGPT, Gemini, Mistral) in a tab and start a
   chat.
4. In Melon, select an agent node, find the tab under **Bridged tabs**, and click
   **Use**. Set its adapter to the bound tab.
5. Run the graph. The extension fills the composed prompt, submits it, reads the
   streaming reply, and sends chunks back through the hub. While it works, the
   tab shows a Melon badge with its unique control id (for example `T-16`), and
   the same id appears in the canvas.

The extension is intentionally the only component with permission to read and
type into third-party tabs. It does nothing until a run targets a tab you bound.

### Adapter catalog

Site adapters live in `extension/adapters.js` as data: host regexes plus ordered
selector candidates for the composer, send, stop, and response fields. The
resolver skips hidden/disabled controls, penalizes search boxes, and deduplicates
nested response matches. `melon.ping` reports the selected adapter and field
health before a run. The **Bridged tabs** panel asks each supported tab for that
health and shows whether the composer/send controls are ready, missing, or the
bridge needs a reload. Health is cached briefly, and tabs without a built-in
adapter are disabled. Fixture tests under `test/fixtures/adapters/` exercise current
ChatGPT and Claude markup, fallback selectors, and bad-selector rejection.

### Local AI (optional)

The extension can host a small planner model locally with WebGPU. It is off by
default and does not change the deterministic tab adapters.

```bash
npm run vendor:ai
```

Then reload the unpacked extension, open its options, enable **Local AI assist**,
pick a model, and choose **Download & load**. Chrome asks for permission to fetch
model files from Hugging Face. No prompt or page text is sent there; only model
weights and tokenizer files are downloaded. The picker includes:

| Model | Approx. size | Notes |
| --- | --- | --- |
| Qwen2.5 1.5B Instruct | ~1.25 GB | Recommended balance |
| Qwen2.5 0.5B Instruct | ~500 MB | Faster, lower memory |
| Llama 3.2 1B Instruct | ~1.1 GB | Llama-family alternative |
| LFM2.5 350M | ~270 MB | Smallest, weakest reasoning |

The model host runs in an MV3 offscreen document because service workers are
ephemeral and the model should stay resident. Models are pinned to a Hugging
Face revision and cached by the browser. **Unload** frees memory; it does not
delete the cache. If WebGPU, permissions, the download, or the model runtime
fails, Melon reports it in the options page and deterministic adapters continue
to work.

With a model loaded, **Plan graph** sends the current brief to the extension,
asks the model for a JSON graph, and validates it in the hub against the canvas
schema (`web/shared/planner.js`). The canvas shows the proposal and only replaces
the workspace after you choose **Apply plan**. The planner endpoint is
`POST /api/plan` with `{ "goal": "...", "candidates": 3 }`.
When the hub has Kev configured, the canvas asks for three valid candidates and
Kev selects one before the proposal is shown.

### Kev reranker (optional)

Melon can use a local [Kev](https://ollama.com/library/kev) decision model as a
reranker. Kev does not generate text; it scores a bounded choice. Start Ollama and
point the hub at it:

```bash
ollama pull kev
KEV_URL=http://127.0.0.1:11434 KEV_MODEL=kev node server/hub.mjs
```

Kev is opt-in. Point `KEV_URL` at a local Ollama for local-only reranking; a
remote URL would send candidate text there. When configured, the hub exposes
`POST /api/kev/rerank` and uses it for:

- **Planner candidates:** choose among up to four schema-valid graphs.
- **Upstream inputs:** reorder and trim multiple agent outputs before a join or
  moderator.
- **Adapter selectors:** break ties when the deterministic resolver finds
  competing composer/send candidates.
- **Page context:** an `ext` node can opt into retrieving visible page passages
  and Kev-reranking the top three into the prompt.

Every path falls back to deterministic behavior if Kev is unavailable. Kev is a
decision model, not a general-purpose reranker; treat its ranking as an optional
heuristic and keep the deterministic adapter resolver as the control path.

### Audit log (optional)

The hub can append run metadata to a local JSONL file. It is off by default:

```bash
MELON_AUDIT_LOG=/path/to/audit.jsonl node server/hub.mjs
# or write .melon/audit.jsonl in the project:
MELON_AUDIT=1 node server/hub.mjs
```

Each line records the timestamp, run id, target type, node/label, adapter, tab and
control id, outcome, duration, character count, and timeout flag. It deliberately
does **not** record prompts, model output, page text, or errors that might echo
content. The file is append-only and created with mode `0600`; rotate it by
stopping the hub and moving the file. This covers hub-routed runs, not demo tabs
that run entirely in the browser. `GET /api/health` reports whether auditing is
enabled.

### opencode

Run opencode in server mode and start the hub with its URL:

```bash
opencode serve --port 4096
OPENCODE_URL=http://127.0.0.1:4096 node server/hub.mjs
```

An agent node with adapter `opencode` will create a session, send the prompt, and
stream events from opencode's SSE endpoint. The hub tries both the v1 and v2
route shapes because opencode has moved them across releases.

### Any OpenAI-compatible model

```bash
LLM_URL=http://127.0.0.1:11434/v1 \
LLM_MODEL=llama3.1 \
LLM_KEY=optional \
node server/hub.mjs
```

Agent nodes with adapter `llm` stream from `/chat/completions`. The browser can
also call `POST /api/llm` directly; that path is intended for local models and
same-origin use.

## What is real vs simulated

| Path | Status |
| --- | --- |
| WASM scheduler, queues, joins, cancellation | Real |
| Same-origin demo tabs over `BroadcastChannel` | Real |
| Extension bridge and DOM adapters | Real, selector-dependent |
| opencode adapter | Real, tolerant of v1/v2 routes |
| OpenAI-compatible streaming | Real |
| Built-in demo agents | Deterministic simulation, not models |
| Local model graph proposal | Real, optional, schema-validated before apply |
| Kev reranking | Optional local decision model over bounded candidates |

## Graph semantics

- A node runs when its `trigger` is satisfied: `any` (default) or `all`.
- Inputs are queues. Each node has `concurrency` (default `1`) and a bounded
  inbox (default `2048`, `drop-oldest`).
- Agent-style nodes emit `stream` chunks and a final `result`. Both are ordinary
  ports; connect whichever you need.
- Jobs have exactly one terminal event: `done`, `error`, or `cancelled`.
- Cycles are allowed but reported as warnings; this is a dataflow canvas, not a
  workflow engine with implicit loop semantics.

The example graph:

```text
Brief ──► Claude ──rev1──┐
   └────► Gemini ──rev2──┴──► Moderator ──► Decision
```

## Runs, versions and controls

- **Play** starts a full run from the selected/first source. **Pause** stops
  scheduling new jobs while active jobs finish. **Resume** drains the queue.
  **Stop all** cancels every adapter and resets the core.
- Every run gets a run id (`r1`, `r2`, ...). Every node output is stored as a
  versioned record with `runId`, `runSeq`, `workflowVersion`, status, format and
  text. New runs create new records instead of appending to old text.
- Changing a runtime input (adapter, binding, prompt instructions, result format,
  ports, trigger, concurrency, edges, nodes or source topic) bumps
  `workflowVersion` and marks older node outputs stale. The inspector shows the
  output history for the selected node.
- Select a node and use **Rerun node** to execute just that node, or **Resume
  from here** to execute it and route its output downstream. The prompt/config
  is read fresh, so changed instructions apply on rerun.
- The source node has its own **Source topic**; the left Brief box edits the
  selected source. Changing the topic updates the prompt for the next run.
- Agent nodes have **Prompt instructions** and a declared **Result format**
  (`markdown`, `text`, `json`, `image`). The format is metadata for the sink and
  inspector; adapters are not asked to convert output automatically.
- The demo moderator synthesizes upstream reviews into Decision, Consensus,
  Disagreements, Risks, Next actions and Open questions instead of pasting the
  reviews back.

## Project layout

```text
core-runtime/        Rust dataflow core and tests
  src/lib.rs         runtime, JSON command protocol, WASM ABI
web/                 canvas UI and demo agent tabs
  shared/wasm.js     raw WASM ABI loader
  shared/protocol.js tab bus contract
  shared/simulator.js deterministic demo agents
  app.js             graph editor, runtime host, adapters
server/hub.mjs       zero-dependency HTTP/SSE/WebSocket hub
extension/           MV3 bridge (background, content adapters, options)
  ai/                model catalog and offscreen model host
  vendor/            generated local AI runtime (npm run vendor:ai)
test/                Node tests for the hub, WASM ABI, extension, AI catalog and simulator
scripts/build.sh     test + build + copy the WASM artifact
scripts/vendor-ai.sh download and vendor Transformers.js + ONNX runtime
scripts/e2e-remote.sh sync and test the working tree on sillyoci
scripts/setup-remote.sh provision Node + Playwright Chromium on sillyoci
docs/                feasibility, architecture, and milestone notes
```

## Build and test

```bash
# Rust unit tests
cd core-runtime && cargo test

# Rebuild the WASM artifact into web/wasm/
./scripts/build.sh

# Hub, WASM, extension, AI catalog and simulator tests
npm test

# Real Chromium E2E against synthetic ChatGPT, Claude, Gemini, and Mistral fixtures
# Set CHROME_PATH if Chrome/Chromium is not auto-detected.
npm run e2e

# Optional local AI smoke test: loads a tiny ONNX model on WebGPU
# Requires Hugging Face access; uses a temporary test-only extension copy.
# Set MELON_E2E_AI_MODEL (JSON) and MELON_E2E_AI_GENERATE=1 to test generation.
npm run e2e:ai

# Real planner graph validation on CPU/WASM (remote Chromium lane).
MELON_E2E_AI_DEVICE=wasm MELON_E2E_AI_PLANNER=1 \
  MELON_E2E_AI_MODEL="{...}" npm run e2e:ai

# Hardware WebGPU. Needs a display/GPU; on Haswell Vulkan this can stall.
sg render -c 'xvfb-run -a env MELON_E2E_AI_HARDWARE=1 MELON_E2E_AI_PLANNER=1 \
  MELON_E2E_AI_MODEL="{...}" npm run e2e:ai'

# Planner-only knobs: MELON_E2E_AI_GOAL, MELON_E2E_AI_PLANNER_ATTEMPTS,
# MELON_E2E_AI_PLANNER_MAX_NEW_TOKENS, MELON_E2E_AI_GENERATE_TIMEOUT.
npm run e2e:ai

# Live-site smoke test: opens real tabs and records health, login/challenge
# state, screenshots, and metadata in .melon/live/report.json.
npm run e2e:live

# One-time login profile; later runs reuse the cookies.
MELON_LIVE_HEADLESS=0 MELON_LIVE_PROFILE=~/.cache/melon-live/profile npm run e2e:live

# Headful login helper: opens the real tabs and waits for you to sign in.
MELON_LIVE_LOGIN=1 npm run e2e:live

# Reuse exported cookies for authenticated automation (JSON array of cookies).
MELON_LIVE_COOKIES=/path/cookies.json npm run e2e:live

# Send a real prompt only to tabs whose health is ready. Creates real messages.
MELON_LIVE_SEND=1 MELON_LIVE_PROMPT='Reply with exactly: MELON_LIVE_OK' npm run e2e:live

# Optional filters and strict mode.
MELON_LIVE_SITES=chatgpt,gemini MELON_LIVE_STRICT=1 npm run e2e:live

# Bound the whole run and guarantee Chrome/hub cleanup on timeout.
MELON_LIVE_TOTAL_TIMEOUT=240000 npm run e2e:live

# Local AI runtime (required only if you enable Local AI)
npm run vendor:ai
```

### Remote Linux/arm64 test lane

`ubuntu@sillyoci` is the pinned remote runner. Provision it once, then sync the
working tree and run `npm test` plus `npm run e2e` there:

```bash
./scripts/setup-remote.sh
npm run test:remote
```

The remote runner uses Node 24 and Playwright's Chromium. Override
`MELON_REMOTE`, `MELON_REMOTE_DIR`, or `MELON_REMOTE_AI=1` as needed. Local AI
verification stays opt-in because it needs WebGPU and Hugging Face access.

GitHub Actions runs `npm test` and `npm run e2e` for every push and pull request
targeting `dev` (`.github/workflows/ci.yml`).

The core ABI is a raw C-style boundary, deliberately avoiding wasm-bindgen:
`melon_alloc`, `melon_call`, `melon_out_len`, `melon_version`, with JSON in and
JSON out. See `docs/ARCHITECTURE.md`.

## Security and trust boundaries

Read this before pointing Melon at an account you care about.

- The hub binds to `127.0.0.1` by default and stores no conversation history. It
  still sees prompt and streamed text in memory for the duration of a run, and
  any local process can call it. Treat it as part of the local trusted client,
  not as an untrusted cloud backend. Do not expose it to a network interface
  without authentication and TLS. A stricter design would relay through the
  extension content script via `postMessage` and keep the hub out of the data
  path.
- Mutating API routes are POST-only, reject disallowed `Origin` headers, and
  require `application/json` for body-bearing routes. CORS is restricted to
  same-origin and extension origins. Together these block drive-by web requests;
  they are not a substitute for OS-level isolation.
- The extension token gates the WebSocket. It is written to `.melon-token`
  (mode `0600`) and printed at startup. Rotate it by deleting the file and
  restarting the hub.
- The extension asks for a one-time consent in its options before it will drive
  real tabs. That is the capability grant, not a per-run approval. Each controlled
  tab shows a Melon badge with a unique control id, also shown in the canvas, so
  you can tell which tab is being driven. Opt-in audit logs record that control
  id and the run outcome, never the prompt or output text.
- The extension can read and type into the tabs you bind. It cannot read cookies
  or passwords, but a malicious page can still prompt-inject the model or
  exfiltrate text the model can see. Treat a bridged tab as an untrusted
  participant, not as a trusted tool. Bridged-tab results are marked
  `taint: untrusted`; downstream prompts label them as untrusted browser content
  and instruct the model to treat them as data, never as instructions. The canvas
  marks tainted nodes and output lineage.
- DOM adapters are brittle. Site markup changes will break selectors. The
  adapter health check is the tab's `melon.ping`; failures surface as run errors.
  Keep the fallback to a human handoff.
- Never put secrets in a prompt that a third-party tab will see.
- Local AI is opt-in. Model files are fetched from Hugging Face only after you
  grant optional host permission; prompts stay in the offscreen document and are
  never sent to Hugging Face. The model runtime is vendored locally, not loaded
  from a CDN, so the extension CSP stays self-only.

## Known limitations

- Firefox is supported in principle (MV3), but the extension is tested against
  Chrome/Edge. The demo UI runs in Firefox.
- Adapters are heuristic and do not handle every modal, login wall, or A/B
  variant. There is no automatic selector update.
- The hub's opencode and LLM adapters are route-tolerant guesses; versions vary.
- Local AI requires a WebGPU-capable Chromium build. It is disabled on Firefox
  and on hardware without a usable WebGPU adapter. Model downloads are large and
  model quality varies; deterministic adapters remain the fallback.
- No persistence, no multi-user sync, no hosted deployment, no mobile support.
- Run/output history and workflow version live in memory and the saved graph;
  output text is intentionally not written to localStorage or the hub.
- The canvas is mouse-first; keyboard support is limited to Escape and
  Ctrl/Cmd+Enter. Delete nodes from the inspector and edges by double-clicking them.
