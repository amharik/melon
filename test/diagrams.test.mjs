import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isMermaidCode,
  isBoxDiagram,
  isSvgCode,
  renderBuiltInSvgDiagram,
  createDiagramCardHtml,
} from "../web/shared/diagrams.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("isMermaidCode identifies all standard Mermaid diagram types", () => {
  assert.equal(isMermaidCode("graph TD\n  A --> B"), true);
  assert.equal(isMermaidCode("flowchart LR\n  Frontend --> Gateway --> Service"), true);
  assert.equal(isMermaidCode("sequenceDiagram\n  Alice->>Bob: Hello"), true);
  assert.equal(isMermaidCode("classDiagram\n  Class01 <|-- Avery"), true);
  assert.equal(isMermaidCode("stateDiagram\n  [*] --> Still"), true);
  assert.equal(isMermaidCode("erDiagram\n  CUSTOMER ||--o{ ORDER : places"), true);
  assert.equal(isMermaidCode("architecture\n  service db(database)[Database]"), true);
  assert.equal(isMermaidCode("block-beta\n  columns 3"), true);

  // Rejects normal code and text
  assert.equal(isMermaidCode("const a = 10;\nconst b = 20;"), false);
  assert.equal(isMermaidCode("## System Architecture\nThis is a review."), false);
  assert.equal(isMermaidCode(""), false);
});

test("isBoxDiagram identifies Unicode and ASCII box-drawing architecture diagrams", () => {
  const boxArch = `
┌─────────────┐       ┌──────────────┐
│  Web Client │ ────> │ API Gateway  │
└─────────────┘       └──────────────┘
  `;
  assert.equal(isBoxDiagram(boxArch), true);

  const doubleBox = `
╔═════════════╗       ╔══════════════╗
║ Auth Server ║ ════> ║ User Service ║
╚═════════════╝       ╚══════════════╝
  `;
  assert.equal(isBoxDiagram(doubleBox), true);

  // Normal text without multiple box lines
  assert.equal(isBoxDiagram("Here is a single character ┌ not a diagram"), false);
  assert.equal(isBoxDiagram("Just plain text with no boxes"), false);
});

test("isSvgCode identifies inline SVG blocks", () => {
  assert.equal(isSvgCode('<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>'), true);
  assert.equal(isSvgCode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), true);
  assert.equal(isSvgCode("<div>Not an svg</div>"), false);
});

test("renderBuiltInSvgDiagram renders hierarchical graph flowchart with icons and markers", () => {
  const code = `
flowchart TD
  Client[Web Browser] --> Gateway[API Gateway]
  Gateway --> Auth[Auth Service]
  Gateway --> Orders[(Order Database)]
  Orders -.-> Kafka[Event Bus]
  `;

  const svg = renderBuiltInSvgDiagram(code);
  assert.match(svg, /<svg\b/);
  assert.match(svg, /viewBox=/);
  assert.match(svg, /marker id="arrow"/);
  assert.match(svg, /Web Browser/);
  assert.match(svg, /API Gateway/);
  assert.match(svg, /Auth Service/);
  assert.match(svg, /Order Database/);
  assert.match(svg, /Event Bus/);

  // Icons for db and client
  assert.match(svg, /🗄️/); // Database cylinder icon
  assert.match(svg, /💻/); // Web Browser icon
  assert.match(svg, /⚡/); // Gateway icon
});

test("renderBuiltInSvgDiagram renders sequence diagrams with lifelines and participant boxes", () => {
  const code = `
sequenceDiagram
  participant User as 👤 Human
  participant Gateway as API Gateway
  participant DB as Database
  User->>Gateway: POST /checkout
  Gateway->>DB: INSERT order
  DB-->>Gateway: OK 201 Created
  Gateway-->>User: Order Confirmation
  `;

  const svg = renderBuiltInSvgDiagram(code);
  assert.match(svg, /<svg\b/);
  assert.match(svg, /marker id="seq-arrow"/);
  assert.match(svg, /POST \/checkout/);
  assert.match(svg, /INSERT order/);
  assert.match(svg, /OK 201 Created/);
  assert.match(svg, /API Gateway/);
});

test("createDiagramCardHtml generates interactive card with controls", () => {
  const html = createDiagramCardHtml({
    id: "diag_123",
    type: "mermaid",
    title: "Microservices Architecture",
    rawCode: "graph LR\n  A --> B",
  });

  assert.match(html, /class="arch-diagram-card mermaid-card"/);
  assert.match(html, /id="diagram-card-diag_123"/);
  assert.match(html, /Microservices Architecture/);
  assert.match(html, /btn-diag-toggle/);
  assert.match(html, /btn-diag-zoom-in/);
  assert.match(html, /btn-diag-zoom-out/);
  assert.match(html, /btn-diag-zoom-reset/);
  assert.match(html, /btn-diag-copy-svg/);
  assert.match(html, /btn-diag-expand/);
  assert.match(html, /id="diagram-body-diag_123"/);
  assert.match(html, /id="diagram-source-diag_123"/);
});

test("createDiagramCardHtml neutralizes data-attribute breakouts", () => {
  const html = createDiagramCardHtml({
    id: "diag_xss",
    type: "mermaid",
    rawCode: 'graph TD\n  A --> B\n</script><img src=x onerror="alert(1)">',
  });
  assert.doesNotMatch(html, /<\/script><img/i);
  assert.match(html, /data-diagram-meta="/);
  assert.match(html, /&lt;\/script&gt;/);
});

test("extension domToRichMarkdown extracts unlabelled Mermaid blocks and SVG diagrams", async () => {
  const adaptersCode = await fs.readFile(path.join(ROOT, "extension/adapters.js"), "utf8");
  const fn = new Function("exports", adaptersCode + "; return this.MelonAdapters;");
  const A = fn({});

  // 1. Code block with no class but starting with "graph TD"
  const preEl = {
    tagName: "PRE",
    childNodes: [],
    querySelector(sel) {
      if (sel === "code") {
        return {
          tagName: "CODE",
          classList: [],
          textContent: "graph TD\n  Client --> Server",
          getAttribute: () => null,
        };
      }
      return null;
    },
    getAttribute: () => null,
  };

  const extracted = A.domToRichMarkdown(preEl);
  assert.match(extracted, /```mermaid/);
  assert.match(extracted, /Client --> Server/);

  // 2. SVG architecture diagram with text labels
  const svgEl = {
    tagName: "SVG",
    clientWidth: 600,
    clientHeight: 400,
    childNodes: [],
    getAttribute(name) {
      if (name === "viewBox") return "0 0 600 400";
      return null;
    },
    hasAttribute(name) {
      return name === "viewBox";
    },
    querySelectorAll(sel) {
      if (sel.includes("text")) return [{ tagName: "TEXT", textContent: "Database" }];
      if (sel.includes("path")) return [{}, {}, {}, {}];
      return [];
    },
    cloneNode() {
      return {
        getAttribute: () => "0 0 600 400",
        setAttribute: () => {},
      };
    },
    closest(sel) {
      return null;
    },
  };

  // Mock global XMLSerializer for node test environment
  globalThis.XMLSerializer = class {
    serializeToString() {
      return '<svg viewBox="0 0 600 400"><text>Database</text></svg>';
    }
  };

  const extractedSvg = A.domToRichMarkdown(svgEl);
  assert.match(extractedSvg, /!\[Vector Diagram\]\(data:image\/svg\+xml;utf8,/);

  // 3. SVG with explicit title tag
  const svgWithTitle = {
    ...svgEl,
    querySelector(sel) {
      if (sel === "title") return { textContent: "Cloud Deployment Flow" };
      return null;
    },
  };
  const extractedWithTitle = A.domToRichMarkdown(svgWithTitle);
  assert.match(extractedWithTitle, /!\[Cloud Deployment Flow\]\(data:image\/svg\+xml;utf8,/);
});

test("web/app.js, markdown.js, index.html, and styles.css wire Mermaid and architecture diagram cards", async () => {
  const app = await fs.readFile(path.join(ROOT, "web/app.js"), "utf8");
  const markdown = await fs.readFile(path.join(ROOT, "web/shared/markdown.js"), "utf8");
  const html = await fs.readFile(path.join(ROOT, "web/index.html"), "utf8");
  const css = await fs.readFile(path.join(ROOT, "web/styles.css"), "utf8");

  assert.match(app, /renderMarkdownHtml/);
  assert.match(app, /renderAllPendingDiagrams/);
  assert.match(app, /setupDiagramInteractions/);
  assert.match(app, /renderBuiltInSvgDiagram/);
  assert.match(markdown, /isMermaidCode/);
  assert.match(markdown, /isBoxDiagram/);
  assert.match(markdown, /isSvgCode/);
  assert.match(markdown, /createDiagramCardHtml/);
  assert.match(markdown, /from "\.\/sanitize\.js"/);

  // HTML wiring — Mermaid is vendored locally and guarded by a CSP.
  assert.match(html, /<script src="vendor\/mermaid\.min\.js"><\/script>/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(html, /id="lightbox-svg-container"/);

  // CSS wiring
  assert.match(css, /\.arch-diagram-card/);
  assert.match(css, /\.arch-diagram-header/);
  assert.match(css, /\.arch-diagram-body/);
  assert.match(css, /\.lightbox-svg-wrap/);
});
