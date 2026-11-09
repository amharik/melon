# Remote Chromium evidence — 2026-11-09

Captured on `ubuntu@sillyoci` with Playwright Chromium 158.0.8127.18
(`chromium-1254`, Linux/arm64). No local browser was used.

## Verification summary

| Check | Result |
| --- | --- |
| Node + hub tests | 45/45 passed |
| Signed adapter pack | v2 verified against pinned Ed25519 key |
| Synthetic adapter E2E | ChatGPT, Claude, Gemini, Mistral passed |
| Live-tab probe | 0/4 ready; Cloudflare challenges on ChatGPT/Claude/Mistral, Google login on Gemini |
| WebGPU adapter | `google/swiftshader` (CPU-backed, not hardware) |

Commands used:

```bash
MELON_E2E_SCREENSHOT_DIR="$PWD/docs/evidence/2026-11-09/adapters" npm run e2e
MELON_LIVE_SCREENSHOT_DIR="$PWD/docs/evidence/2026-11-09/live" \
  MELON_LIVE_SITES=chatgpt,claude,gemini,mistral npm run e2e:live
MELON_GPU_EVIDENCE_DIR="$PWD/docs/evidence/2026-11-09/hardware" npm run e2e:gpu
```

## Synthetic adapter runs

Each adapter was driven end to end against the recorded HTML fixtures: loaded,
composer filled with the bridge badge visible, then response read and badge
removed. These prove the content-script path, not live-site availability.

### ChatGPT

| Loaded | Running | Done |
| --- | --- | --- |
| <img src="adapters/chatgpt-01-loaded.png" width="320"> | <img src="adapters/chatgpt-02-running.png" width="320"> | <img src="adapters/chatgpt-03-done.png" width="320"> |

### Claude

| Loaded | Running | Done |
| --- | --- | --- |
| <img src="adapters/claude-01-loaded.png" width="320"> | <img src="adapters/claude-02-running.png" width="320"> | <img src="adapters/claude-03-done.png" width="320"> |

### Gemini

| Loaded | Running | Done |
| --- | --- | --- |
| <img src="adapters/gemini-01-loaded.png" width="320"> | <img src="adapters/gemini-02-running.png" width="320"> | <img src="adapters/gemini-03-done.png" width="320"> |

### Mistral

| Loaded | Running | Done |
| --- | --- | --- |
| <img src="adapters/mistral-01-loaded.png" width="320"> | <img src="adapters/mistral-02-running.png" width="320"> | <img src="adapters/mistral-03-done.png" width="320"> |

## Live-tab probe

The live probe opened the real sites in the remote headless Chromium. No
authenticated profile or cookies were available, so every site was blocked
before the bridge could run.

### ChatGPT

| Landing | Classified |
| --- | --- |
| <img src="live/chatgpt-01-landing.png" width="480"> | <img src="live/chatgpt-02-challenge.png" width="480"> |

### Claude

| Landing | Classified |
| --- | --- |
| _Landing capture timed out while Cloudflare rendered._ | <img src="live/claude-02-challenge.png" width="480"> |

### Gemini

| Landing | Classified |
| --- | --- |
| <img src="live/gemini-01-landing.png" width="480"> | <img src="live/gemini-02-login-required.png" width="480"> |

### Mistral

| Landing | Classified |
| --- | --- |
| <img src="live/mistral-01-landing.png" width="480"> | <img src="live/mistral-02-challenge.png" width="480"> |

## Hardware WebGPU probe

The remote runner exposes a software `google/swiftshader` adapter. This does not
satisfy the hardware WebGPU milestone; a machine with a real GPU is still
required.

<img src="hardware/gpu-adapter.png" width="720">

Raw probe output: [`hardware/gpu.json`](hardware/gpu.json).
