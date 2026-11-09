# Milestones

## v0.1 — local-first browser agent workspace

Status: in progress (`dev` branch)

Goal: a local hub and MV3 extension that can drive real AI tabs as dataflow
nodes without cloud-side conversation storage.

Acceptance criteria:

- [x] Rust/WASM dataflow core with routed runs, join, fan-out, and loop diagnostics.
- [x] Hub with SSE events, extension WebSocket bridge, metadata-only audit log.
- [x] ChatGPT, Claude, Gemini, and Mistral content adapters with shared resolver.
- [x] One-time bridge consent, per-tab control IDs, in-page stop badge.
- [x] Taint propagation from browser tabs into prompts and downstream nodes.
- [x] Planner request/validate/review/apply flow with deterministic fallback.
- [x] Optional Kev reranking for adapter candidates and page context.
- [x] Synthetic real-Chromium E2E for all four adapters.
- [x] Local AI model catalog, WebGPU offscreen host, model load/unload smoke test.
- [x] Local AI smoke test on the remote Linux/arm64 Playwright Chromium.
- [x] Live-site health/login/challenge probe with report and optional cookie import.
- [x] Pinned Linux/arm64 test lane on sillyoci and CI on every `dev` push.
- [x] Real planner inference with a production model and validated graph on the pinned remote Chromium lane (Qwen2.5-0.5B-Instruct q4, WASM).
- [ ] Hardware WebGPU planner run with a production model. Local Intel gen-7 adapter and SmolLM2 load were verified, but Haswell Vulkan stalls during full graph generation; the remote Chromium runner exposes only a `google/swiftshader` WebGPU adapter.
- [ ] Authenticated live-tab run in CI or on a persistent login profile. Remote probes hit Cloudflare challenges on ChatGPT/Claude/Mistral and Google login-required on Gemini.
- [x] Remote adapter-pack signing, hosting, and update verification.

Evidence from the 2026-11-09 remote Chromium run: [`docs/evidence/2026-11-09/README.md`](evidence/2026-11-09/README.md).

Tracking rules:

- Keep `dev` as the integration branch; push after each verified slice.
- Update this milestone when a criterion changes state.
- Run `npm test` and `npm run e2e` before every push.
- Use `npm run test:remote` for the pinned remote Linux/arm64 test lane.
