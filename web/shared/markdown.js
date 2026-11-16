import { Marked } from "../vendor/marked.esm.js";
import { createDiagramCardHtml, isBoxDiagram, isMermaidCode, isSvgCode } from "./diagrams.js";
import { sanitizer as defaultSanitizer } from "./sanitize.js";

let diagramSeq = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

function nextDiagramId(prefix) {
  diagramSeq += 1;
  return `${prefix}_${Date.now()}_${diagramSeq}`;
}

function decodeSvgDataUri(src) {
  const comma = src.indexOf(",");
  if (comma < 0) return "";
  const metadata = src.slice(0, comma).toLowerCase();
  const payload = src.slice(comma + 1);
  try {
    if (metadata.includes(";base64")) return atob(payload);
    return decodeURIComponent(payload);
  } catch {
    return "";
  }
}

function safeMediaSrc(src) {
  const value = String(src || "").trim();
  if (!value) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return /^(https?:|data:image\/|blob:)/i.test(value) ? value : "";
}

function linkRenderer({ href, title, text, tokens }) {
  const body = tokens?.length ? this.parser.parseInline(tokens) : escapeHtml(text);
  if (!href || /^(javascript|vbscript|data:text\/html|livescript|mocha):/i.test(href)) return body;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noopener noreferrer" class="slack-chat-link">${body}</a>`;
}

function tableRenderer({ header, rows }) {
  const cell = (item, tag) => {
    const align = item.align ? ` align="${escapeHtml(item.align)}"` : "";
    return `<${tag}${align}>${this.parser.parseInline(item.tokens)}</${tag}>`;
  };
  const head = header.map((item) => cell.call(this, item, "th")).join("");
  const body = rows
    .map((row) => `<tr>${row.map((item) => cell.call(this, item, "td")).join("")}</tr>`)
    .join("");
  return `<div class="slack-table-wrap"><table class="slack-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function imageBlockExtension(sanitize) {
  return {
    name: "imageBlock",
    level: "block",
    start(src) {
      const index = src.search(/^!\[/m);
      return index < 0 ? undefined : index;
    },
    tokenizer(src) {
      if (!src.startsWith("![")) return undefined;
      const lineEnd = src.indexOf("\n");
      const line = (lineEnd < 0 ? src : src.slice(0, lineEnd)).trimEnd();
      const tokens = this.lexer.inlineTokens(line);
      if (tokens.length !== 1 || tokens[0].type !== "image") return undefined;
      const image = tokens[0];
      return {
        type: "imageBlock",
        raw: line + (lineEnd < 0 ? "" : "\n"),
        href: image.href,
        title: image.title,
        text: image.text,
      };
    },
    renderer(token) {
      return renderMedia(
        { src: token.href || "", title: token.title || "", alt: token.text || "" },
        sanitize,
      );
    },
  };
}

function thinkBlockExtension() {
  return {
    name: "thinkBlock",
    level: "block",
    start(src) {
      const index = src.search(/<think(?:\s|>)/i);
      return index < 0 ? undefined : index;
    },
    tokenizer(src) {
      const match = /^<think(?:\s[^>]*)?>([\s\S]*?)<\/think>(?:\n+|$)/i.exec(src);
      if (!match) return undefined;
      return {
        type: "thinkBlock",
        raw: match[0],
        text: match[1],
        tokens: this.lexer.blockTokens(match[1]),
      };
    },
    renderer(token) {
      return `<details class="ai-thought-box" open>
        <summary class="ai-thought-summary">
          <span class="ai-thought-icon">🧠</span>
          <span class="ai-thought-label">Thinking Process</span>
        </summary>
        <div class="ai-thought-body">${this.parser.parse(token.tokens)}</div>
      </details>`;
    },
  };
}

function thinkInlineExtension() {
  return {
    name: "thinkInline",
    level: "inline",
    start(src) {
      const index = src.search(/<think(?:\s|>)/i);
      return index < 0 ? undefined : index;
    },
    tokenizer(src) {
      const match = /^<think(?:\s[^>]*)?>([\s\S]*?)<\/think>/i.exec(src);
      if (!match) return undefined;
      return {
        type: "thinkInline",
        raw: match[0],
        text: match[1],
        tokens: this.lexer.inlineTokens(match[1]),
      };
    },
    renderer(token) {
      return `<details class="ai-thought-box" open>
        <summary class="ai-thought-summary">
          <span class="ai-thought-icon">🧠</span>
          <span class="ai-thought-label">Thinking Process</span>
        </summary>
        <div class="ai-thought-body">${this.parser.parseInline(token.tokens)}</div>
      </details>`;
    },
  };
}

function mathBlockExtension() {
  return {
    name: "mathBlock",
    level: "block",
    start(src) {
      const index = src.indexOf("$$");
      return index < 0 ? undefined : index;
    },
    tokenizer(src) {
      const match = /^\$\$([\s\S]*?)\$\$(?:\n+|$)/.exec(src);
      if (!match) return undefined;
      return { type: "mathBlock", raw: match[0], text: match[1] };
    },
    renderer(token) {
      return `<div class="slack-math-block">${escapeHtml(token.text)}</div>`;
    },
  };
}

function mathInlineExtension() {
  return {
    name: "mathInline",
    level: "inline",
    start(src) {
      const index = src.indexOf("$");
      return index < 0 ? undefined : index;
    },
    tokenizer(src) {
      const match = /^\$([^$\n]+)\$/.exec(src);
      if (!match) return undefined;
      return { type: "mathInline", raw: match[0], text: match[1] };
    },
    renderer(token) {
      return `<span class="slack-math-inline">${escapeHtml(token.text)}</span>`;
    },
  };
}

function renderCodeBlock(block, sanitize) {
  const rawCode = block.code.trim();
  const lang = block.lang.toLowerCase();

  if (lang === "mermaid" || isMermaidCode(rawCode)) {
    return createDiagramCardHtml({
      id: nextDiagramId("m"),
      type: "mermaid",
      rawCode,
    });
  }

  if (lang === "svg" || isSvgCode(rawCode)) {
    const cleanSvg = sanitize.svg(rawCode);
    if (cleanSvg && isSvgCode(cleanSvg)) {
      return createDiagramCardHtml({
        id: nextDiagramId("svg"),
        type: "svg",
        rawCode,
        inlineSvg: cleanSvg,
      });
    }
  }

  if (isBoxDiagram(rawCode)) {
    return createDiagramCardHtml({
      id: nextDiagramId("box"),
      type: "box",
      rawCode,
    });
  }

  const code = escapeHtml(rawCode);
  return `<div class="md-code-block" style="margin:8px 0; border:1px solid var(--glass-border); border-radius:8px; overflow:hidden;">
    <div class="md-code-header">
      <span style="font-family:var(--font-mono); font-size:9.5px; text-transform:uppercase;">${escapeHtml(block.lang || "text")}</span>
      <button type="button" class="tiny ghost btn-copy-code" data-copy="${code}">Copy</button>
    </div>
    <pre style="margin:0; border:0; border-radius:0; max-height:260px; overflow:auto;"><code>${code}</code></pre>
  </div>`;
}

function renderMedia(media, sanitize) {
  const src = String(media.src || "").trim();
  const alt = media.alt || "Extracted Graphic";

  if (/^data:image\/svg\+xml/i.test(src)) {
    const rawSvg = decodeSvgDataUri(src);
    const cleanSvg = rawSvg ? sanitize.svg(rawSvg) : "";
    if (cleanSvg && isSvgCode(cleanSvg)) {
      return createDiagramCardHtml({
        id: nextDiagramId("svg_media"),
        type: "svg",
        title: alt !== "Architecture Diagram" && alt !== "Extracted Graphic" ? alt : "",
        rawCode: cleanSvg,
        inlineSvg: cleanSvg,
      });
    }
  }

  const safeSrc = safeMediaSrc(src);
  if (!safeSrc) return "";
  const safeAlt = escapeHtml(alt);
  return `<div class="slack-media-card">
    <img class="slack-media-img" src="${escapeHtml(safeSrc)}" alt="${safeAlt}" loading="lazy" data-modal-src="${escapeHtml(safeSrc)}" data-modal-cap="${safeAlt}" />
    <div class="slack-media-caption">📷 ${safeAlt}</div>
  </div>`;
}

function renderInlineImage(media, sanitize) {
  const src = String(media.src || "").trim();
  if (/^data:image\/svg\+xml/i.test(src)) {
    const rawSvg = decodeSvgDataUri(src);
    const cleanSvg = rawSvg ? sanitize.svg(rawSvg) : "";
    return cleanSvg && isSvgCode(cleanSvg) ? `<span class="slack-inline-svg">${cleanSvg}</span>` : "";
  }

  const safeSrc = safeMediaSrc(src);
  if (!safeSrc) return "";
  const safeAlt = escapeHtml(media.alt || "");
  const title = media.title ? ` title="${escapeHtml(media.title)}"` : "";
  return `<img class="slack-media-img" src="${escapeHtml(safeSrc)}" alt="${safeAlt}"${title} loading="lazy" data-modal-src="${escapeHtml(safeSrc)}" data-modal-cap="${safeAlt}" />`;
}

export function createMarkdownRenderer({ sanitizer = defaultSanitizer } = {}) {
  return function renderMarkdownHtml(raw) {
    if (!raw) return "";

    const parser = new Marked();
    parser.use({
      gfm: true,
      breaks: true,
      extensions: [
        imageBlockExtension(sanitizer),
        thinkBlockExtension(),
        thinkInlineExtension(),
        mathBlockExtension(),
        mathInlineExtension(),
      ],
      renderer: {
        code({ text, lang }) {
          return renderCodeBlock({ code: text || "", lang: lang || "" }, sanitizer);
        },
        image({ href, title, text }) {
          return renderInlineImage({ src: href || "", title: title || "", alt: text || "" }, sanitizer);
        },
        link: linkRenderer,
        table: tableRenderer,
      },
    });

    let parsed;
    try {
      parsed = parser.parse(raw);
    } catch {
      parsed = `<p>${escapeHtml(raw)}</p>`;
    }

    return `<div class="md-body">${sanitizer.html(parsed)}</div>`;
  };
}

export const renderMarkdownHtml = createMarkdownRenderer();
