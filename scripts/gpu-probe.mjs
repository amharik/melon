#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.MELON_GPU_EVIDENCE_DIR
  ? path.resolve(process.env.MELON_GPU_EVIDENCE_DIR)
  : path.join(ROOT, ".melon", "gpu");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>Melon GPU probe</title><body>Melon GPU probe</body>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;

const browser = await chromium.launch({
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    "--disable-gpu-watchdog",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/`);
  const info = await page.evaluate(async () => {
    const webgl = document.createElement("canvas").getContext("webgl2");
    const debug = webgl?.getExtension("WEBGL_debug_renderer_info");
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    const details = adapter?.info || {};
    return {
      secureContext: isSecureContext,
      webgpuAvailable: !!navigator.gpu,
      adapterAvailable: !!adapter,
      vendor: details.vendor || "",
      architecture: details.architecture || "",
      device: details.device || "",
      description: details.description || "",
      webglRenderer: debug ? webgl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "",
    };
  });
  const result = {
    checkedAt: new Date().toISOString(),
    browserVersion: browser.version(),
    ...info,
  };
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "gpu.json"), `${JSON.stringify(result, null, 2)}\n`);

  const rows = [
    ["Secure context", result.secureContext],
    ["WebGPU available", result.webgpuAvailable],
    ["Adapter available", result.adapterAvailable],
    ["WebGPU vendor", result.vendor || "(none)"],
    ["WebGPU architecture", result.architecture || "(none)"],
    ["WebGL renderer", result.webglRenderer || "(none)"],
    ["Browser", result.browserVersion],
    ["Checked", result.checkedAt],
  ];
  await page.setContent(`<!doctype html>
<meta charset="utf-8">
<title>Melon GPU evidence</title>
<style>
  body { margin: 0; padding: 56px; background: #f6f5f1; color: #1d1c1a; font: 16px/1.5 system-ui, sans-serif; }
  h1 { margin: 0 0 8px; font-size: 30px; }
  p { margin: 0 0 28px; color: #625f58; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d8d4cc; }
  td { padding: 14px 18px; border-bottom: 1px solid #eeeae3; vertical-align: top; }
  td:first-child { width: 34%; color: #625f58; }
  code { font-family: ui-monospace, monospace; font-size: 14px; }
  .note { margin-top: 24px; padding: 16px 18px; background: #fff4df; border: 1px solid #e7c98f; }
</style>
<h1>Melon GPU evidence</h1>
<p>Remote Chromium probe used for the hardware WebGPU milestone.</p>
<table>${rows
    .map(
      ([label, value]) =>
        `<tr><td>${escapeHtml(label)}</td><td><code>${escapeHtml(value)}</code></td></tr>`
    )
    .join("")}</table>
<div class="note">A <code>google/swiftshader</code> adapter is CPU-backed. It does not satisfy the hardware WebGPU milestone.</div>`);
  await page.screenshot({ path: path.join(OUT_DIR, "gpu-adapter.png"), fullPage: true });
  console.log(JSON.stringify({ ok: true, outDir: OUT_DIR, ...result }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
