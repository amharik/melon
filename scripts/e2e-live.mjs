#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const OUT_DIR = path.join(ROOT, ".melon", "live");
const REPORT = path.join(OUT_DIR, "report.json");

const SITES = [
  {
    id: "chatgpt",
    host: "chatgpt.com",
    aliases: ["chat.openai.com"],
    url: "https://chatgpt.com/",
    adapter: "chatgpt",
  },
  {
    id: "claude",
    host: "claude.ai",
    aliases: [],
    url: "https://claude.ai/",
    adapter: "claude",
  },
  {
    id: "gemini",
    host: "gemini.google.com",
    aliases: [],
    url: "https://gemini.google.com/app",
    adapter: "gemini",
  },
  {
    id: "mistral",
    host: "chat.mistral.ai",
    aliases: [],
    url: "https://chat.mistral.ai/chat",
    adapter: "mistral",
  },
];

const LOGIN = process.env.MELON_LIVE_LOGIN === "1";
const HEADLESS = LOGIN ? false : process.env.MELON_LIVE_HEADLESS !== "0";
const SEND = process.env.MELON_LIVE_SEND === "1";
const STRICT = process.env.MELON_LIVE_STRICT === "1";
const PROMPT =
  process.env.MELON_LIVE_PROMPT || "Reply with exactly: MELON_LIVE_OK";
const SETTLE_MS = Math.max(500, Number(process.env.MELON_LIVE_SETTLE_MS) || 3000);
const PAGE_TIMEOUT = Math.max(5000, Number(process.env.MELON_LIVE_PAGE_TIMEOUT) || 20000);
const RUN_TIMEOUT = Math.max(30000, Number(process.env.MELON_LIVE_RUN_TIMEOUT) || 180000);
const PROFILE =
  process.env.MELON_LIVE_PROFILE || path.join(os.homedir(), ".cache", "melon-live", "profile");
const COOKIES_FILE = process.env.MELON_LIVE_COOKIES || null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const selectedSites = process.env.MELON_LIVE_SITES
  ? new Set(
      process.env.MELON_LIVE_SITES.split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    )
  : null;

function log(message) {
  console.log(`[e2e:live] ${message}`);
}

function selected(site) {
  if (!selectedSites) return true;
  return [site.id, site.host, ...site.aliases].some((value) =>
    selectedSites.has(value.toLowerCase())
  );
}

function extensionIdForPath(dir) {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [];
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    const entries = await fs.readdir(cache);
    const versions = entries
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const version of versions) {
      candidates.push(path.join(cache, version, "chrome-linux64", "chrome"));
      candidates.push(path.join(cache, version, "chrome-linux", "chrome"));
    }
  } catch {}
  candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("Chromium not found. Set CHROME_PATH or install Chrome/Chromium.");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, label, timeout = 20000, interval = 100) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${body.error || ""}`);
  return body;
}

function matchesSite(tab, site) {
  try {
    const host = new URL(tab.url).hostname;
    return host === site.host || site.aliases.includes(host);
  } catch {
    return false;
  }
}

class CDP {
  static async connect(url) {
    const cdp = new CDP(url);
    await cdp.opened;
    return cdp;
  }

  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluation failed";
      throw new Error(text);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function browserWs(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  const data = await response.json();
  return data.webSocketDebuggerUrl;
}

function normalizeSameSite(value) {
  const next = String(value || "").toLowerCase();
  if (next === "none" || next === "no_restriction") return "None";
  if (next === "lax") return "Lax";
  if (next === "strict") return "Strict";
  return undefined;
}

async function loadCookies(file) {
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.cookies) ? raw.cookies : null;
  if (!list) throw new Error("MELON_LIVE_COOKIES must be a JSON array or {cookies: []}.");
  return list.filter((cookie) => cookie && cookie.name && cookie.value);
}

async function importCookies(browserCdp, debugPort, cookies) {
  if (!cookies.length) return 0;
  const target = await browserCdp.send("Target.createTarget", { url: "about:blank" });
  const page = await waitFor(async () => {
    const list = await targets(debugPort);
    return list.find((item) => item.id === target.targetId && item.type === "page");
  }, "cookie import page");
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send("Network.enable");
  let imported = 0;
  try {
    for (const cookie of cookies) {
      const domain = String(cookie.domain || "").trim();
      const host = domain.replace(/^\./, "");
      if (!host && !cookie.url) continue;
      const url = cookie.url || `https://${host}${cookie.path || "/"}`;
      const params = {
        name: String(cookie.name),
        value: String(cookie.value),
        url,
        path: cookie.path || "/",
        secure: cookie.secure !== false,
        httpOnly: !!cookie.httpOnly,
      };
      if (domain) params.domain = domain;
      if (Number.isFinite(Number(cookie.expires)) && Number(cookie.expires) > 0) {
        params.expires = Math.floor(Number(cookie.expires));
      }
      const sameSite = normalizeSameSite(cookie.sameSite);
      if (sameSite) params.sameSite = sameSite;
      const result = await cdp.send("Network.setCookie", params);
      if (result?.success) imported += 1;
    }
  } finally {
    cdp.close();
    await browserCdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
  }
  return imported;
}

async function sseQueue(response) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5)));
          }
        }
      }
    } catch {}
  })();
  return {
    next(predicate, timeout = 20000) {
      return waitFor(
        () => {
          const index = events.findIndex(predicate);
          return index >= 0 ? events.splice(index, 1)[0] : null;
        },
        "SSE event",
        timeout,
        50
      );
    },
    close() {
      reader.cancel().catch(() => {});
      return pump.catch(() => {});
    },
  };
}

async function readPage(cdp) {
  await waitFor(
    () => cdp.evaluate(`document.readyState === "complete"`),
    "page load",
    PAGE_TIMEOUT
  ).catch(() => {});
  await sleep(SETTLE_MS);
  return cdp.evaluate(`(() => {
    const text = String(document.body?.innerText || "").replace(/\\s+/g, " ").trim();
    const title = String(document.title || "");
    const signal = title + " " + text;
    return {
      href: location.href,
      title,
      text: text.slice(0, 1600),
      composer: !!document.querySelector('textarea, [contenteditable="true"]'),
      login: /\\b(log in|sign in|sign up|continue with google|welcome back)\\b/i.test(signal),
      challenge: /verify (that )?you are human|checking your browser|just a moment|cloudflare|attention required|captcha/i.test(signal),
    };
  })()`);
}

async function screenshot(cdp, site) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const shot = await Promise.race([
    cdp.send("Page.captureScreenshot", { format: "png", fromSurface: false }),
    sleep(8000).then(() => {
      throw new Error("screenshot timed out");
    }),
  ]);
  const file = path.join(OUT_DIR, `${site.id}-${Date.now().toString(36)}.png`);
  await fs.writeFile(file, Buffer.from(shot.data, "base64"));
  return path.relative(ROOT, file);
}

function classify(tab, page) {
  if (page?.challenge) return "challenge";
  if (!tab) return "no-tab";
  if (!tab.supported) return "unsupported";
  if (tab.health?.fields?.composer?.ok && tab.health?.fields?.send?.ok) return "ready";
  if (page?.login) return "login-required";
  if (tab.healthError) return "health-error";
  if (tab.health) return "degraded";
  return "unknown";
}

function summarize(result) {
  const fields = result.tab?.health?.fields || {};
  const ok = Object.entries(fields)
    .filter(([, value]) => value.ok)
    .map(([name]) => name)
    .join(",");
  const missing = Object.entries(fields)
    .filter(([, value]) => !value.ok)
    .map(([name]) => name)
    .join(",");
  return [
    result.id,
    result.status,
    result.tab?.adapter || result.adapter,
    ok ? `ok=${ok}` : "",
    missing ? `missing=${missing}` : "",
    result.page?.title ? `title=${JSON.stringify(result.page.title).slice(0, 80)}` : "",
    result.run ? `run=${result.run.status}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function writeReport(report) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
}

async function bridgeState(optionsCdp, tabId) {
  return optionsCdp.evaluate(`(async () => {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: ${Number(tabId)} },
      func: () => ({
        bridge: !!window.__melonAgentBridge,
        adapters: !!globalThis.MELON_ADAPTERS,
        href: location.href,
      }),
    });
    return frames.map((frame) => frame.result);
  })()`);
}

async function runPrompt(sse, base, site, tab) {
  const runId = `live-${site.id}-${Date.now().toString(36)}`;
  const started = Date.now();
  await json(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId,
      prompt: PROMPT,
      target: {
        type: "extension",
        tabId: tab.id,
        adapter: site.adapter,
        node: `live-${site.id}`,
        label: `Live ${site.id}`,
        timeoutMs: RUN_TIMEOUT,
      },
    }),
  });

  const terminal = await sse.next(
    (event) =>
      event.type === "run.event" &&
      event.runId === runId &&
      ["done", "error", "cancelled"].includes(event.event?.type),
    RUN_TIMEOUT + 15000
  );

  return {
    id: runId,
    status: terminal.event?.type || "unknown",
    text: String(terminal.event?.text || ""),
    error: terminal.event?.error?.message || null,
    durationMs: Date.now() - started,
  };
}

async function main() {
  if (LOGIN && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("MELON_LIVE_LOGIN=1 needs a display. Run under a desktop or xvfb-run with manual login.");
  }

  const sites = SITES.filter(selected);
  if (!sites.length) throw new Error("MELON_LIVE_SITES selected no known sites.");

  const chromePath = await findChrome();
  const extensionId = extensionIdForPath(await fs.realpath(EXT));
  await fs.mkdir(path.dirname(PROFILE), { recursive: true });
  await fs.chmod(path.dirname(PROFILE), 0o700).catch(() => {});
  await fs.mkdir(OUT_DIR, { recursive: true });

  const hubPort = await freePort();
  const hubToken = `live-${Date.now().toString(36)}`;
  const hub = spawn(process.execPath, ["server/hub.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(hubPort),
      HOST: "127.0.0.1",
      MELON_TOKEN: hubToken,
      OPENCODE_URL: "http://127.0.0.1:1",
      KEV_URL: "",
      MELON_AUDIT_LOG: path.join(OUT_DIR, "audit.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let hubLogs = "";
  hub.stdout.on("data", (data) => (hubLogs += data));
  hub.stderr.on("data", (data) => (hubLogs += data));
  hub.stdout.on("error", () => {});
  hub.stderr.on("error", () => {});
  const base = `http://127.0.0.1:${hubPort}`;

  const debugPort = await freePort();
  const chrome = spawn(
    chromePath,
    [
      HEADLESS ? "--headless=new" : null,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--password-store=basic",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--window-size=1280,900",
      "about:blank",
    ].filter(Boolean),
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    }
  );
  let chromeLogs = "";
  chrome.stdout.on("data", (data) => (chromeLogs += data));
  chrome.stderr.on("data", (data) => (chromeLogs += data));
  chrome.stdout.on("error", () => {});
  chrome.stderr.on("error", () => {});
  chrome.on("error", (err) => (chromeLogs += `spawn error: ${err.message}\n`));
  chrome.on("exit", (code, signal) => (chromeLogs += `chrome exited: ${code} ${signal}\n`));

  const report = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    headless: HEADLESS,
    loginMode: LOGIN,
    sendsPrompts: SEND,
    prompt: SEND ? PROMPT : null,
    profile: PROFILE,
    hub: base,
    cookiesImported: 0,
    sites: [],
    error: null,
  };

  let browserCdp = null;
  let optionsCdp = null;
  let sse = null;
  let pageCdp = null;
  try {
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, "hub health");
    log(`hub ${base}`);
    log(`Chromium pid ${chrome.pid} debug port ${debugPort} headless=${HEADLESS}`);

    await waitFor(async () => {
      let port = debugPort;
      try {
        const active = await fs.readFile(
          path.join(PROFILE, "DevToolsActivePort"),
          "utf8"
        );
        port = Number(active.split("\n")[0]) || port;
      } catch {}
      const response = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      return response?.ok;
    }, "Chromium DevTools", 30000);

    const worker = await waitFor(async () => {
      const list = await targets(debugPort);
      return list.find(
        (target) =>
          target.type === "service_worker" &&
          target.url === `chrome-extension://${extensionId}/background.js`
      );
    }, "extension service worker");
    log(`extension worker ${worker.url}`);

    browserCdp = await CDP.connect(await browserWs(debugPort));
    const optionsTarget = await browserCdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/options.html`,
    });
    const optionsPage = await waitFor(async () => {
      const list = await targets(debugPort);
      return list.find((target) => target.id === optionsTarget.targetId);
    }, "extension options page");
    optionsCdp = await CDP.connect(optionsPage.webSocketDebuggerUrl);
    await optionsCdp.send("Runtime.enable");
    await waitFor(
      () => optionsCdp.evaluate(`typeof chrome !== "undefined" && !!chrome.storage?.local`),
      "extension options context",
      8000
    );
    await optionsCdp.evaluate(`(async () => {
      await chrome.storage.local.set({
        hubUrl: ${JSON.stringify(base)},
        token: ${JSON.stringify(hubToken)},
        consentVersion: 1,
        consentAt: Date.now(),
      });
      return true;
    })()`);
    log("bridge configured for this live run");

    let cookiesImported = 0;
    if (COOKIES_FILE) {
      const cookies = await loadCookies(path.resolve(COOKIES_FILE));
      cookiesImported = await importCookies(browserCdp, debugPort, cookies);
      log(`imported ${cookiesImported}/${cookies.length} cookies from ${COOKIES_FILE}`);
      report.cookiesImported = cookiesImported;
    }

    const created = [];
    for (const site of sites) {
      try {
        const target = await browserCdp.send("Target.createTarget", { url: site.url });
        created.push({ site, targetId: target.targetId });
      } catch (err) {
        report.sites.push({
          id: site.id,
          host: site.host,
          url: site.url,
          adapter: site.adapter,
          status: "error",
          error: `could not open tab: ${err.message}`,
        });
        log(`${site.id} error: ${err.message}`);
      }
    }

    if (LOGIN) {
      log("Log in to each open tab, then return here.");
      if (process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        await rl.question("[e2e:live] Press Enter after login is complete: ");
        rl.close();
      } else {
        log("stdin is not a TTY; waiting 90s for login.");
        await sleep(90000);
      }
    }

    if (SEND) {
      sse = await sseQueue(await fetch(`${base}/api/events`));
      await sse.next((event) => event.type === "hello");
    }

    for (const entry of created) {
      const { site, targetId } = entry;
      const started = Date.now();
      const result = {
        id: site.id,
        host: site.host,
        url: site.url,
        adapter: site.adapter,
        targetId,
        status: "unknown",
        tab: null,
        page: null,
        pageAfter: null,
        screenshot: null,
        screenshotAfter: null,
        run: null,
        error: null,
        timings: {},
        elapsedMs: null,
      };
      try {
        let stepAt = Date.now();
        const target = await waitFor(async () => {
          const list = await targets(debugPort);
          return list.find((item) => item.id === targetId && item.type === "page");
        }, `${site.id} page target`);
        pageCdp = await CDP.connect(target.webSocketDebuggerUrl);
        await pageCdp.send("Runtime.enable");
        await pageCdp.send("Page.enable");
        result.timings.targetMs = Date.now() - stepAt;

        stepAt = Date.now();
        result.page = await readPage(pageCdp);
        result.timings.pageMs = Date.now() - stepAt;

        stepAt = Date.now();
        result.screenshot = await screenshot(pageCdp, site).catch((err) => {
          result.screenshotError = err.message;
          return null;
        });
        result.timings.screenshotMs = Date.now() - stepAt;

        if (!result.page?.challenge) {
          stepAt = Date.now();
          result.tab =
            (await waitFor(async () => {
              const data = await json(`${base}/api/tabs`);
              const tab = data.tabs.find((item) => matchesSite(item, site));
              if (!tab) return null;
              return tab.health || !tab.supported ? tab : null;
            }, `${site.id} extension health`, 20000).catch(async () => {
              const data = await json(`${base}/api/tabs`);
              return data.tabs.find((item) => matchesSite(item, site)) || null;
            })) || null;
          result.timings.tabMs = Date.now() - stepAt;
          if (process.env.MELON_LIVE_DEBUG === "1" && result.tab) {
            result.bridge = await bridgeState(optionsCdp, result.tab.id).catch((err) => ({
              error: String(err?.message || err),
            }));
            log(`${site.id}: bridge=${JSON.stringify(result.bridge)}`);
            if (!result.bridge?.[0]?.bridge) {
              result.bridgeInjection = await optionsCdp
                .evaluate(
                  `chrome.scripting.executeScript({
                    target: { tabId: ${Number(result.tab.id)} },
                    files: ["adapters.js", "content.js"],
                  }).then(() => "injected").catch((err) => String(err?.message || err))`
                )
                .catch((err) => String(err?.message || err));
              await sleep(500);
              result.bridgeAfter = await bridgeState(optionsCdp, result.tab.id).catch((err) => ({
                error: String(err?.message || err),
              }));
              log(
                `${site.id}: inject=${result.bridgeInjection} bridgeAfter=${JSON.stringify(
                  result.bridgeAfter
                )}`
              );
            }
          }
        }

        result.status = classify(result.tab, result.page);
        log(
          `${summarize(result)} timings=${JSON.stringify(result.timings)}`
        );

        if (SEND && result.status === "ready" && result.tab) {
          log(`${site.id}: sending live prompt`);
          stepAt = Date.now();
          result.run = await runPrompt(sse, base, site, result.tab);
          result.timings.runMs = Date.now() - stepAt;
          result.pageAfter = await readPage(pageCdp).catch(() => null);
          result.screenshotAfter = await screenshot(pageCdp, site).catch(() => null);
          log(
            `${site.id}: run ${result.run.status} in ${result.run.durationMs}ms, ${result.run.text.length} chars`
          );
        }
      } catch (err) {
        result.status = "error";
        result.error = String(err?.message || err);
        log(`${site.id} error: ${result.error}`);
      } finally {
        pageCdp?.close();
        pageCdp = null;
        result.elapsedMs = Date.now() - started;
        report.sites.push(result);
        await writeReport(report).catch(() => {});
      }
    }

    const ready = report.sites.filter((site) => site.status === "ready").length;
    const blocked = report.sites.filter((site) =>
      ["login-required", "challenge", "unsupported", "no-tab", "health-error"].includes(
        site.status
      )
    ).length;
    log(`${ready}/${report.sites.length} sites ready; ${blocked} blocked or degraded`);

    if (SEND) {
      const failed = report.sites.filter(
        (site) => site.run && site.run.status !== "done"
      );
      if (failed.length) {
        process.exitCode = 1;
        log(`${failed.length} live run(s) failed`);
      }
    }
    if (!ready) {
      process.exitCode = 1;
      log("no site was ready for a run");
    }
    if (STRICT && report.sites.some((site) => site.status !== "ready")) {
      process.exitCode = 1;
      log("strict mode: at least one site was not ready");
    }
  } catch (err) {
    report.error = String(err?.stack || err);
    console.error(`[e2e:live] FAIL: ${err.stack || err}`);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeReport(report).catch(() => {});
    sse?.close();
    optionsCdp?.close();
    browserCdp?.close();
    pageCdp?.close();
    try {
      process.kill(-chrome.pid, "SIGTERM");
    } catch {
      chrome.kill("SIGTERM");
    }
    hub.kill("SIGTERM");
    await sleep(500);
    try {
      process.kill(-chrome.pid, "SIGKILL");
    } catch {}
    hub.kill("SIGKILL");
    if (report.error || process.exitCode) {
      if (hubLogs.trim()) console.error(`\n[hub]\n${hubLogs.trim().slice(-2000)}`);
      if (chromeLogs.trim()) console.error(`\n[chromium]\n${chromeLogs.trim().slice(-2000)}`);
    }
    log(`report ${path.relative(ROOT, REPORT)}`);
    await sleep(100);
    process.exit(process.exitCode || 0);
  }
}

main();
