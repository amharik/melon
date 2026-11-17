/**
 * Melon Tauri Native Desktop Bridge
 * Enables direct communication with Tauri 2.0 Rust backend,
 * managing child webviews (ChatGPT, Gemini, Claude) and native CLI agents (opencode, agy).
 */

export const WEB_AGENT_DEFAULTS = {
  chatgpt: {
    name: "ChatGPT",
    url: "https://chatgpt.com",
    avatar: "🧠",
    tag: "CHATGPT",
    adapter: "chatgpt",
  },
  claude: {
    name: "Claude",
    url: "https://claude.ai",
    avatar: "🤖",
    tag: "CLAUDE",
    adapter: "claude",
  },
  gemini: {
    name: "Gemini",
    url: "https://gemini.google.com",
    avatar: "⚡",
    tag: "GEMINI",
    adapter: "gemini",
  },
  deepseek: {
    name: "DeepSeek",
    url: "https://chat.deepseek.com",
    avatar: "🐳",
    tag: "DEEPSEEK",
    adapter: "deepseek",
  },
  mistral: {
    name: "Mistral",
    url: "https://chat.mistral.ai",
    avatar: "🌪️",
    tag: "MISTRAL",
    adapter: "mistral",
  },
};

export function isTauri() {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.__TAURI_INTERNALS__ ||
      (window.__TAURI__ && typeof window.__TAURI__.core?.invoke === "function"),
  );
}

export function apiUrl(path) {
  if (
    isTauri() &&
    typeof window !== "undefined" &&
    (window.location?.origin?.includes("tauri.localhost") ||
      window.location?.protocol === "tauri:" ||
      window.location?.protocol === "asset:")
  ) {
    return `http://127.0.0.1:4096${path.startsWith("/") ? path : `/${path}`}`;
  }
  return path;
}

export async function tauriInvoke(cmd, args = {}) {
  if (!isTauri()) return null;
  const invokeFn =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI__?.invoke ||
    window.__TAURI_INTERNALS__?.invoke;
  if (typeof invokeFn === "function") {
    return await invokeFn(cmd, args);
  }
  return null;
}

export async function pingTauri() {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke("ping");
  } catch (err) {
    console.warn("[TauriBridge] ping error:", err);
    return null;
  }
}

export async function spawnAgentWebview({ id, title, url, visible = false }) {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke("spawn_agent_window", {
      config: { id, title, url, visible },
    });
  } catch (err) {
    console.error(`[TauriBridge] failed to spawn agent webview ${id}:`, err);
    return false;
  }
}

export async function toggleAgentWebview(id, visible = null) {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke("toggle_agent_window", { id, visible });
  } catch (err) {
    console.error(`[TauriBridge] failed to toggle agent webview ${id}:`, err);
    return false;
  }
}

export async function evalAgentScript(id, script) {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke("eval_agent_script", { id, script });
  } catch (err) {
    console.error(`[TauriBridge] failed to eval script in webview ${id}:`, err);
    return false;
  }
}

export async function getAgentWindowTitle(id) {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke("get_agent_window_title", { id });
  } catch (err) {
    return null;
  }
}

export async function isAgentWindowOpen(id) {
  if (!isTauri()) return false;
  try {
    return Boolean(await tauriInvoke("is_agent_window_open", { id }));
  } catch {
    return false;
  }
}

export async function closeAgentWindow(id) {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke("close_agent_window", { id });
  } catch {
    return false;
  }
}

export async function setAgentWebviewBounds(id, bounds) {
  if (!isTauri() || !bounds) return false;
  try {
    return await tauriInvoke("set_agent_webview_bounds", { id, bounds });
  } catch (err) {
    console.debug(`[TauriBridge] failed to set bounds for ${id}:`, err);
    return false;
  }
}

export async function hideAllAgentWindows() {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke("hide_all_agent_windows");
  } catch {
    return false;
  }
}

export function getContentBounds(element = null) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { x: 260, y: 50, width: 900, height: 700 };
  }
  const el =
    element ||
    (typeof document.querySelector === "function"
      ? document.querySelector("#slack-messages-feed") ||
        document.querySelector(".slack-main")
      : null);
  if (!el || typeof el.getBoundingClientRect !== "function") {
    const sX = typeof window.screenX === "number" ? window.screenX : 0;
    const sY = typeof window.screenY === "number" ? window.screenY : 0;
    return {
      x: sX + 260,
      y: sY + 50,
      width: Math.max(400, (window.innerWidth || 1200) - 260),
      height: Math.max(300, (window.innerHeight || 800) - 50),
    };
  }
  const rect = el.getBoundingClientRect();
  const screenX = typeof window.screenX === "number" ? window.screenX : 0;
  const screenY = typeof window.screenY === "number" ? window.screenY : 0;

  return {
    x: Math.round(screenX + rect.left),
    y: Math.round(screenY + rect.top),
    width: Math.max(320, Math.round(rect.width)),
    height: Math.max(240, Math.round(rect.height)),
  };
}

export async function getAgentMessage(id) {
  if (!isTauri()) return null;
  try {
    const raw = await tauriInvoke("get_agent_message", { id });
    if (!raw) return null;
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(decodeURIComponent(raw));
    } catch {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
  } catch (err) {
    return null;
  }
}

export async function clearAgentMessage(id) {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke("clear_agent_message", { id });
  } catch {
    return false;
  }
}

export async function runCliAgent(
  { runId, agentName, command, args = [], prompt, cwd = null },
  { onChunk, onDone, onError },
) {
  if (!isTauri()) return false;

  const eventApi = window.__TAURI__?.event || window.__TAURI_INTERNALS__?.event;
  let unlisten = null;

  if (eventApi && typeof eventApi.listen === "function") {
    unlisten = await eventApi.listen("cli-output", (event) => {
      const payload = event.payload || {};
      if (payload.run_id !== runId) return;

      if (payload.chunk && typeof onChunk === "function") {
        onChunk(payload.chunk);
      }

      if (payload.is_done) {
        if (payload.is_error && typeof onError === "function") {
          onError(payload.chunk || "Process exited with error");
        } else if (typeof onDone === "function") {
          onDone();
        }
        if (typeof unlisten === "function") {
          unlisten();
        }
      }
    });
  }

  try {
    await tauriInvoke("run_cli_agent", {
      req: {
        run_id: runId,
        agent_name: agentName,
        command,
        args,
        prompt,
        cwd,
      },
    });
    return true;
  } catch (err) {
    if (typeof onError === "function") onError(String(err));
    if (typeof unlisten === "function") unlisten();
    return false;
  }
}

/**
 * Builds the DOM probe script to check if an agent is authenticated
 */
export function buildAuthCheckScript(serviceId = "chatgpt") {
  return `(function() {
    try {
      const serviceId = ${JSON.stringify(serviceId)};
      const composerSelectors = [
        '#prompt-textarea',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"]',
        'textarea'
      ];
      let hasComposer = false;
      for (const sel of composerSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          hasComposer = true;
          break;
        }
      }

      const loginSelectors = [
        '[data-testid="login-button"]',
        'a[href*="login"]',
        'a[href*="signin"]',
        'a[href*="accounts.google.com"]',
        'button[aria-label*="Sign in" i]',
        'button[aria-label*="Log in" i]'
      ];
      const hasLogin = Boolean(document.querySelector(loginSelectors.join(',')));

      const profileSelectors = [
        '[data-testid="profile-button"]',
        '[data-testid="user-menu"]',
        'button[aria-label*="User profile" i]',
        'button[aria-label*="Account" i]',
        'button[aria-label*="Settings" i]',
        'img[alt*="User" i]'
      ];
      const hasProfile = Boolean(document.querySelector(profileSelectors.join(',')));

      // Authenticated if composer or profile is present and not sitting on a pure login page
      const authenticated = (hasComposer || hasProfile) && !hasLogin;
      const state = { ok: true, type: "auth_check", authenticated, hasComposer, hasLogin, hasProfile, serviceId };
      try {
        window.location.assign("melon-bridge://" + serviceId + "?data=" + encodeURIComponent(JSON.stringify(state)));
      } catch(e) {}
      document.title = "__melon_msg__:" + encodeURIComponent(JSON.stringify(state));
      return state;
    } catch(err) {
      const state = { ok: false, type: "auth_check", authenticated: false, error: String(err) };
      try {
        window.location.assign("melon-bridge://" + ${JSON.stringify(serviceId)} + "?data=" + encodeURIComponent(JSON.stringify(state)));
      } catch(e) {}
      return state;
    }
  })();`;
}

/**
 * Builds the DOM prompt injection script for external webviews
 */
export function buildPromptInjectionScript(prompt, runId, serviceId = "chatgpt") {
  return `(function() {
    try {
      const promptText = ${JSON.stringify(prompt)};
      const runId = ${JSON.stringify(runId)};
      const serviceId = ${JSON.stringify(serviceId)};

      // 1. Check for composer elements
      const composerSelectors = [
        '#prompt-textarea',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"]',
        'textarea'
      ];

      let composer = null;
      for (const sel of composerSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          composer = el;
          break;
        }
      }

      // Check if login/auth page is shown
      const loginCheck = document.querySelector(
        '[data-testid="login-button"], a[href*="login"], a[href*="signin"], a[href*="accounts.google.com"], button[aria-label*="Sign in" i], button[aria-label*="Log in" i]'
      );

      if (!composer) {
        const state = { ok: false, status: "needs_auth", hasLogin: Boolean(loginCheck), runId, serviceId };
        try {
          window.location.assign("melon-bridge://" + serviceId + "?data=" + encodeURIComponent(JSON.stringify(state)));
        } catch(e) {}
        document.title = "__melon_msg__:" + encodeURIComponent(JSON.stringify(state));
        return state;
      }

      // 2. Insert text with React 18/19 compatibility
      composer.focus();
      if (composer.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        let inserted = false;
        try {
          inserted = document.execCommand("insertText", false, promptText);
        } catch(e) {}
        if (!inserted || !composer.textContent.includes(promptText)) {
          composer.textContent = promptText;
        }
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: promptText }));
        composer.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const proto = HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(composer, promptText);
        else composer.value = promptText;
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: promptText }));
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        composer.dispatchEvent(new Event("change", { bubbles: true }));
      }

      // 3. Find send button or trigger Enter
      const sendSelectors = [
        '[data-testid="send-button"]',
        'button[aria-label*="Send" i]',
        'button.bg-composer-primary',
        'button[type="submit"]',
        'button[aria-label="Send message"]'
      ];
      let btn = null;
      for (const sel of sendSelectors) {
        const el = document.querySelector(sel);
        if (el && !el.disabled && el.getAttribute("aria-disabled") !== "true") {
          btn = el;
          break;
        }
      }

      if (btn) {
        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        btn.click();
      } else {
        // Fallback: Dispatch Enter keydown on composer
        composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        const form = composer.closest("form");
        if (form) {
          try { form.requestSubmit(); } catch(e) {}
        }
      }

      const state = { ok: true, status: "sent", runId, serviceId };
      try {
        window.location.assign("melon-bridge://" + serviceId + "?data=" + encodeURIComponent(JSON.stringify(state)));
      } catch(e) {}
      document.title = "__melon_msg__:" + encodeURIComponent(JSON.stringify(state));
      return state;
    } catch(err) {
      const state = { ok: false, error: String(err), runId, serviceId };
      try {
        window.location.assign("melon-bridge://" + serviceId + "?data=" + encodeURIComponent(JSON.stringify(state)));
      } catch(e) {}
      document.title = "__melon_msg__:" + encodeURIComponent(JSON.stringify(state));
      return state;
    }
  })();`;
}

/**
 * Builds the response extraction script
 */
export function buildResponseExtractScript(runId, serviceId = "chatgpt") {
  return `(function() {
    try {
      const runId = ${JSON.stringify(runId)};
      const serviceId = ${JSON.stringify(serviceId)};
      const responseSelectors = [
        '[data-message-author-role="assistant"] .markdown',
        '[data-message-author-role="assistant"]',
        'div[data-is-streaming] .font-claude-message',
        '[data-testid="assistant-message"]',
        '.font-claude-message',
        'model-response message-content .markdown',
        'model-response message-content',
        'model-response',
        '.model-response-text',
        '.model-response-contents',
        'div[data-message-author-role="model"]'
      ];

      let el = null;
      for (const sel of responseSelectors) {
        const list = document.querySelectorAll(sel);
        if (list.length > 0) {
          el = list[list.length - 1];
          break;
        }
      }

      if (!el) {
        const state = { ok: false, status: "waiting", runId, serviceId };
        try {
          window.location.assign("melon-bridge://" + serviceId + "?data=" + encodeURIComponent(JSON.stringify(state)));
        } catch(e) {}
        document.title = "__melon_msg__:" + encodeURIComponent(JSON.stringify(state));
        return state;
      }

      const isStreaming = Boolean(document.querySelector(
        '[data-is-streaming="true"], button[aria-label*="Stop" i], [data-testid="stop-button"], button[aria-label="Stop generating"]'
      ));

      const rawInner = typeof el.innerText === "string" ? el.innerText.trim() : "";
      const text = rawInner.length > 0 ? el.innerText : (el.textContent || "");
      const state = { ok: true, status: "extracted", text, streaming: isStreaming, runId, serviceId };
      try {
        window.location.assign("melon-bridge://" + serviceId + "?data=" + encodeURIComponent(JSON.stringify(state)));
      } catch(e) {}
      document.title = "__melon_msg__:" + encodeURIComponent(JSON.stringify(state));
      return state;
    } catch(err) {
      const state = { ok: false, error: String(err), runId, serviceId };
      try {
        window.location.assign("melon-bridge://" + serviceId + "?data=" + encodeURIComponent(JSON.stringify(state)));
      } catch(e) {}
      document.title = "__melon_msg__:" + encodeURIComponent(JSON.stringify(state));
      return state;
    }
  })();`;
}
