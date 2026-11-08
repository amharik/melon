#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const SITES = [
  {
    host: "chatgpt.com",
    adapter: "chatgpt",
    fixture: "chatgpt.html",
    composer: `document.querySelector("#prompt-textarea")?.value || ""`,
    response: `document.querySelector('[data-message-author-role="assistant"]')?.innerText || ""`,
  },
  {
    host: "claude.ai",
    adapter: "claude",
    fixture: "claude.html",
    composer: `document.querySelector('div[contenteditable="true"].ProseMirror')?.innerText || ""`,
    response: `document.querySelector('[data-testid="assistant-message"]')?.innerText || ""`,
  },
  {
    host: "gemini.google.com",
    adapter: "gemini",
    fixture: "gemini.html",
    composer: `document.querySelector('rich-textarea div[contenteditable="true"]')?.innerText || ""`,
    response: `document.querySelector("model-response")?.innerText || ""`,
  },
  {
    host: "chat.mistral.ai",
    adapter: "mistral",
    fixture: "mistral.html",
    composer: `document.querySelector("textarea")?.value || ""`,
    response: `document.querySelector('[data-message-author-role="assistant"]')?.innerText || ""`,
  },
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extensionIdForPath(dir) {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

function log(message) {
  console.log(`[e2e] ${message}`);
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

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
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
      candidates.push(path.join(cache, version, "chrome-linux-arm64", "chrome"));
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

function makeCertificate(dir, hosts) {
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "key.pem",
      "-out",
      "cert.pem",
      "-days",
      "1",
      "-subj",
      `/CN=${hosts[0]}`,
      "-addext",
      `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}`,
    ],
    { cwd: dir, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`openssl failed: ${result.stderr || result.stdout}`);
  }
}

function proxyServer(targetPort, hosts) {
  const allowed = new Set(hosts.map((host) => `${host}:443`));
  const proxy = http.createServer((req, res) => {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("CONNECT required");
  });
  proxy.on("connect", (req, socket, head) => {
    socket.on("error", () => {});
    if (!allowed.has(req.url)) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return proxy;
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
      }, 15000);
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
      return waitFor(() => {
        const index = events.findIndex(predicate);
        return index >= 0 ? events.splice(index, 1)[0] : null;
      }, "SSE event", timeout, 50);
    },
    close() {
      reader.cancel().catch(() => {});
      return pump.catch(() => {});
    },
  };
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

async function main() {
  const chromePath = await findChrome();
  const extensionId = extensionIdForPath(await fs.realpath(EXT));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "melon-e2e-"));
  const fixtures = Object.fromEntries(
    await Promise.all(
      SITES.map(async (site) => [
        site.host,
        await fs.readFile(
          path.join(ROOT, "test", "fixtures", "site", site.fixture),
          "utf8"
        ),
      ])
    )
  );
  const hosts = SITES.map((site) => site.host);
  makeCertificate(tmp, hosts);
  const [key, cert] = await Promise.all([
    fs.readFile(path.join(tmp, "key.pem")),
    fs.readFile(path.join(tmp, "cert.pem")),
  ]);

  const httpsServer = https.createServer({ key, cert }, (req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    const fixture = fixtures[host];
    if (req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (fixture && (req.url === "/" || req.url.startsWith("/?"))) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(fixture);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  httpsServer.on("clientError", (err, socket) => socket.destroy());
  httpsServer.on("tlsClientError", () => {});
  const httpsPort = await listen(httpsServer);

  const proxy = proxyServer(httpsPort, hosts);
  const proxyPort = await listen(proxy);

  const hubPort = await freePort();
  const hubToken = `e2e-${Date.now().toString(36)}`;
  const hub = spawn(process.execPath, ["server/hub.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(hubPort),
      HOST: "127.0.0.1",
      MELON_TOKEN: hubToken,
      OPENCODE_URL: "http://127.0.0.1:1",
      KEV_URL: "",
      MELON_AUDIT_LOG: path.join(tmp, "audit.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let hubLogs = "";
  hub.stdout.on("data", (data) => (hubLogs += data));
  hub.stderr.on("data", (data) => (hubLogs += data));
  hub.stdout.on("error", () => {});
  hub.stderr.on("error", () => {});
  const hubBase = `http://127.0.0.1:${hubPort}`;

  const profile = path.join(tmp, "profile");
  const debugPort = await freePort();
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-quic",
      "--password-store=basic",
      "--ignore-certificate-errors",
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      "--proxy-bypass-list=127.0.0.1;localhost",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--window-size=1280,900",
      "about:blank",
    ],
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

  let sse = null;
  let fixtureTarget = null;
  let browserCdp = null;
  let optionsCdp = null;
  let pageCdp = null;
  try {
    await waitFor(async () => (await fetch(`${hubBase}/api/health`)).ok, "hub health");
    log(`hub ${hubBase}`);

    log(`Chromium pid ${chrome.pid} debug port ${debugPort}`);
    await waitFor(async () => {
      let port = debugPort;
      try {
        const active = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8");
        port = Number(active.split("\n")[0]) || port;
      } catch {}
      const response = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      return response?.ok;
    }, "Chromium DevTools", 30000);
    log(`Chromium ${chromePath}`);

    const workerTarget = await waitFor(async () => {
      const list = await targets(debugPort);
      return list.find(
        (target) =>
          target.type === "service_worker" &&
          target.url === `chrome-extension://${extensionId}/background.js`
      );
    }, "extension service worker");
    log(`extension worker ${workerTarget.url}`);

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
        hubUrl: ${JSON.stringify(hubBase)},
        token: ${JSON.stringify(hubToken)},
        consentVersion: 1,
        consentAt: Date.now(),
      });
      return true;
    })()`);
    const packState = await waitFor(async () => {
      const result = await optionsCdp.evaluate(
        `chrome.runtime.sendMessage({ type: "melon.adapters.pack" })`
      );
      return result?.ok && result.version === 2 ? result : null;
    }, "signed adapter pack verification", 10000);
    const packedAdapters = packState.pack?.adapters || [];
    if (!["chatgpt", "claude", "gemini", "mistral"].every((id) => packedAdapters.includes(id))) {
      throw new Error(`adapter pack missing built-ins: ${JSON.stringify(packedAdapters)}`);
    }
    log(`adapter pack v${packState.version} verified (${packState.sha256.slice(0, 12)}…)`);
    await browserCdp.send("Target.closeTarget", { targetId: optionsTarget.targetId });

    sse = await sseQueue(await fetch(`${hubBase}/api/events`));
    await sse.next((event) => event.type === "hello");

    const prompt = "Reply with the fixture text and nothing else.";
    for (const site of SITES) {
      const pageUrl = `https://${site.host}/`;
      fixtureTarget = await browserCdp.send("Target.createTarget", { url: pageUrl });
      await waitFor(async () => {
        const list = await targets(debugPort);
        return list.find(
          (target) => target.id === fixtureTarget.targetId && target.type === "page"
        );
      }, `${site.adapter} fixture page target`);

      const tab = await waitFor(async () => {
        const data = await json(`${hubBase}/api/tabs`);
        return data.tabs.find(
          (item) =>
            item.url.startsWith(pageUrl) &&
            item.adapter === site.adapter &&
            item.supported &&
            item.health?.fields?.composer?.ok &&
            item.health?.fields?.send?.ok
        );
      }, `healthy ${site.adapter} fixture tab`);
      log(`tab ${tab.controlId} adapter=${tab.adapter} host=${site.host}`);

      const pageTarget = await waitFor(async () => {
        const list = await targets(debugPort);
        return list.find((target) => target.id === fixtureTarget.targetId);
      }, `${site.adapter} fixture page target`);
      pageCdp = await CDP.connect(pageTarget.webSocketDebuggerUrl);
      await pageCdp.send("Runtime.enable");

      const runId = `e2e-${site.adapter}-${Date.now().toString(36)}`;
      await json(`${hubBase}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          prompt,
          target: {
            type: "extension",
            tabId: tab.id,
            adapter: site.adapter,
            node: "reviewer",
            label: `Fixture ${site.adapter} reviewer`,
          },
        }),
      });

      const sawBadge = await waitFor(
        () => pageCdp.evaluate(`!!document.querySelector("melon-control")`),
        `${site.adapter} in-page control badge`,
        8000,
        100
      );
      if (!sawBadge) throw new Error(`${site.adapter} control badge did not appear`);
      log(`run ${runId} started; control badge visible`);

      const terminal = await sse.next(
        (event) =>
          event.type === "run.event" &&
          event.runId === runId &&
          ["done", "error", "cancelled"].includes(event.event?.type),
        25000
      );
      if (terminal.event?.type !== "done") {
        throw new Error(
          `${site.adapter} run ended with ${terminal.event?.type}: ${JSON.stringify(
            terminal.event
          )}`
        );
      }
      log(`done: ${String(terminal.event.text || "").slice(0, 80)}…`);

      await waitFor(
        () => pageCdp.evaluate(`!document.querySelector("melon-control")`),
        `${site.adapter} control badge removal`,
        8000,
        100
      );
      const state = await pageCdp.evaluate(`(() => ({
        composer: ${site.composer},
        response: ${site.response},
        badge: !!document.querySelector("melon-control"),
      }))()`);

      if (!String(terminal.event.text || "").includes("Fixture reply to:")) {
        throw new Error(`${site.adapter} unexpected run text: ${terminal.event.text}`);
      }
      if (!state.composer.includes(prompt)) {
        throw new Error(`${site.adapter} composer did not retain prompt: ${state.composer}`);
      }
      if (
        !state.response.includes("Fixture reply to:") ||
        !state.response.includes(prompt)
      ) {
        throw new Error(`${site.adapter} unexpected page response: ${state.response}`);
      }
      if (state.badge) throw new Error(`${site.adapter} control badge was not removed`);
      log(`${site.adapter}: filled, submitted, streamed, and read the response`);
      pageCdp.close();
      pageCdp = null;
    }
    log(`${SITES.length} adapters passed real-Chromium content-script runs`);
    log("PASS");
  } catch (err) {
    console.error(`[e2e] FAIL: ${err.stack || err}`);
    try {
      console.error(`[tabs] ${JSON.stringify(await json(`${hubBase}/api/tabs`))}`);
    } catch (debugError) {
      console.error(`[tabs] ${debugError.message}`);
    }
    try {
      const list = await targets(debugPort);
      const target =
        list.find((item) => item.id === fixtureTarget?.targetId) ||
        list.find(
          (item) =>
            item.type === "page" &&
            SITES.some((site) => item.url.startsWith(`https://${site.host}/`))
        );
      console.error(`[page] ${JSON.stringify(target ? { url: target.url, title: target.title } : null)}`);
      if (target) {
        const cdp = await CDP.connect(target.webSocketDebuggerUrl);
        await cdp.send("Runtime.enable");
        console.error(
          `[page state] ${JSON.stringify(
            await cdp.evaluate(`({
              href: location.href,
              title: document.title,
              text: document.body?.innerText?.slice(0, 300) || "",
              composer: !!document.querySelector('textarea, [contenteditable="true"]'),
              melon: !!document.querySelector("melon-control"),
            })`)
          )}`
        );
        cdp.close();
      }
    } catch (debugError) {
      console.error(`[page] ${debugError.message}`);
    }
    if (hubLogs.trim()) console.error(`\n[hub]\n${hubLogs.trim().slice(-4000)}`);
    if (chromeLogs.trim()) console.error(`\n[chromium]\n${chromeLogs.trim().slice(-4000)}`);
    process.exitCode = 1;
  } finally {
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
    await Promise.all([closeServer(proxy), closeServer(httpsServer)]);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

main();
