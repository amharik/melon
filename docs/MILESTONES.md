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
- [x] Live-site health/login/challenge probe with report and optional cookie import.
- [ ] Real planner inference on hardware WebGPU with a production model.
- [ ] Authenticated live-tab run in CI or on a persistent login profile.
- [ ] Remote adapter-pack signing, hosting, and update verification.

Tracking rules:

- Keep `dev` as the integration branch; push after each verified slice.
- Update this milestone when a criterion changes state.
- Run `npm test` and `npm run e2e` before every push.
- Use `npm run test:remote` for the pinned remote Linux/arm64 test lane.
