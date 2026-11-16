// Melon Architecture Diagram Engine
// Renders Mermaid, SVG, and Box-drawing architecture diagrams with high-fidelity vector styling,
// client-side Mermaid v11 integration, and pure zero-dependency SVG fallback.

export function isMermaidCode(text) {
  if (!text) return false;
  const trimmed = text.trim();
  return /^\s*(graph\s+[A-Z]{2}|flowchart\s+[A-Z]{2}|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|architecture|block-beta|C4Context|C4Container|C4Component)\b/i.test(
    trimmed,
  );
}

export function isBoxDiagram(text) {
  if (!text) return false;
  const boxChars = /[┌┐└┘─│├┤┬┴┼═║╔╗╚╝]/;
  const lines = text.split("\n");
  const count = lines.filter((l) => boxChars.test(l)).length;
  return count >= 2;
}

export function isSvgCode(text) {
  if (!text) return false;
  const trimmed = text.trim();
  return (trimmed.startsWith("<svg") || trimmed.startsWith("<?xml")) && trimmed.includes("</svg>");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function extractDiagramTitle(code, fallback = "Diagram") {
  if (!code) return fallback;
  const str = String(code).trim();

  // 1. Check for YAML frontmatter title: --- \n title: ... \n ---
  const frontmatterMatch = str.match(/^---\s*[\r\n]+[\s\S]*?title:\s*([^\r\n]+)[\s\S]*?---/i);
  if (frontmatterMatch) {
    return frontmatterMatch[1].replace(/["']/g, "").trim();
  }

  // 2. Check for Mermaid 'title ...' directive
  const titleDirective = str.match(/^\s*title\s*[:\s]\s*([^\r\n]+)/im);
  if (titleDirective) {
    return titleDirective[1].replace(/["']/g, "").trim();
  }

  // 3. Check for SVG <title>...</title>
  const svgTitleMatch = str.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (svgTitleMatch) {
    const t = svgTitleMatch[1].replace(/<[^>]+>/g, "").trim();
    if (t) return t;
  }

  // 4. Check for SVG aria-label
  const ariaMatch = str.match(/aria-label\s*=\s*["']([^"']+)["']/i);
  if (ariaMatch) {
    const a = ariaMatch[1].trim();
    if (a && a.length > 2) return a;
  }

  // 5. Check for subgraph Title
  const subgraphMatch = str.match(/subgraph\s+(?:["']([^"']+)["']|([a-zA-Z0-9_-]+))/i);
  if (subgraphMatch) {
    const sg = (subgraphMatch[1] || subgraphMatch[2]).trim();
    if (sg && !/^(root|main|g\d+)$/i.test(sg)) return sg;
  }

  // 6. Detect specific diagram type
  const firstLine = str.split("\n")[0].trim().toLowerCase();
  if (firstLine.startsWith("sequencediagram")) return "Sequence Diagram";
  if (firstLine.startsWith("classdiagram")) return "Class Diagram";
  if (firstLine.startsWith("erdiagram")) return "Entity Relationship Diagram";
  if (firstLine.startsWith("statediagram")) return "State Diagram";
  if (firstLine.startsWith("gitgraph")) return "Git Branch Graph";
  if (firstLine.startsWith("gantt")) return "Gantt Chart";
  if (firstLine.startsWith("pie")) return "Pie Chart";
  if (firstLine.startsWith("flowchart") || firstLine.startsWith("graph")) {
    return "Architecture Flowchart";
  }

  if (isSvgCode(str)) return "Vector Diagram";
  if (isBoxDiagram(str)) return "Monospace Architecture Diagram";

  return fallback;
}

function chooseNodeIcon(id, label) {
  const s = `${id} ${label}`.toLowerCase();
  if (
    s.includes("db") ||
    s.includes("database") ||
    s.includes("sql") ||
    s.includes("redis") ||
    s.includes("mongo") ||
    s.includes("store")
  )
    return "🗄️";
  if (s.includes("gateway") || s.includes("proxy") || s.includes("router") || s.includes("ingress"))
    return "⚡";
  if (
    s.includes("client") ||
    s.includes("browser") ||
    s.includes("frontend") ||
    s.includes("ui") ||
    s.includes("web") ||
    s.includes("app")
  )
    return "💻";
  if (s.includes("user") || s.includes("actor") || s.includes("human") || s.includes("customer")) return "👤";
  if (
    s.includes("auth") ||
    s.includes("security") ||
    s.includes("oauth") ||
    s.includes("jwt") ||
    s.includes("key")
  )
    return "🔒";
  if (
    s.includes("queue") ||
    s.includes("kafka") ||
    s.includes("mq") ||
    s.includes("rabbit") ||
    s.includes("pubsub") ||
    s.includes("event")
  )
    return "📨";
  if (
    s.includes("cloud") ||
    s.includes("aws") ||
    s.includes("gcp") ||
    s.includes("azure") ||
    s.includes("cluster")
  )
    return "☁️";
  if (
    s.includes("ai") ||
    s.includes("llm") ||
    s.includes("model") ||
    s.includes("claude") ||
    s.includes("gpt") ||
    s.includes("gemini")
  )
    return "🧠";
  return "⚙️";
}

/**
 * Built-in Zero-Dependency SVG Architecture Diagram Renderer.
 * Parses Mermaid flowchart, graph, and sequence code and generates
 * high-contrast, beautiful vector SVG diagrams with theme-matching styles.
 */
export function renderBuiltInSvgDiagram(code, { width = 800, isDarkMode = true } = {}) {
  const trimmed = String(code || "").trim();
  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("%%"));

  if (!lines.length)
    return `<svg viewBox="0 0 200 60"><text x="10" y="35" fill="#888">Empty diagram</text></svg>`;

  const header = lines[0].toLowerCase();

  // 1. Sequence Diagram
  if (header.startsWith("sequencediagram")) {
    return renderBuiltInSequenceDiagram(lines.slice(1), { width, isDarkMode });
  }

  // 2. Flowchart / Graph (TD, LR, TB, etc.)
  const isLR = header.includes("lr");
  const nodes = new Map(); // id -> { id, label, shape, icon }
  const edges = []; // { from, to, label, style }

  const nodeDeclRegex =
    /([a-zA-Z0-9_-]+)\s*(\[\(([\s\S]*?)\)\]|\(\(([\s\S]*?)\)\)|\[\[([\s\S]*?)\]\]|\[([\s\S]*?)\]|\(([\s\S]*?)\)|\{([\s\S]*?)\})/g;

  function ensureNode(id, label = id, shape = "box") {
    const cleanId = id.trim();
    if (!cleanId) return null;
    if (!nodes.has(cleanId)) {
      const cleanLabel = (label || cleanId).replace(/<br\s*\/?>/gi, " ").trim();
      nodes.set(cleanId, {
        id: cleanId,
        label: cleanLabel,
        shape,
        icon: chooseNodeIcon(cleanId, cleanLabel),
      });
    }
    return nodes.get(cleanId);
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Check for subgraph declaration or end
    if (
      line.startsWith("subgraph") ||
      line === "end" ||
      line.startsWith("classDef") ||
      line.startsWith("style")
    ) {
      continue;
    }

    // Extract explicit node declarations on this line
    let declMatch;
    while ((declMatch = nodeDeclRegex.exec(line)) !== null) {
      const id = declMatch[1];
      let shape = "box";
      let label = id;
      if (declMatch[3] !== undefined) {
        shape = "cylinder";
        label = declMatch[3];
      } else if (declMatch[4] !== undefined) {
        shape = "circle";
        label = declMatch[4];
      } else if (declMatch[5] !== undefined) {
        shape = "subroutine";
        label = declMatch[5];
      } else if (declMatch[6] !== undefined) {
        shape = "box";
        label = declMatch[6];
      } else if (declMatch[7] !== undefined) {
        shape = "rounded";
        label = declMatch[7];
      } else if (declMatch[8] !== undefined) {
        shape = "diamond";
        label = declMatch[8];
      }
      ensureNode(id, label, shape);
    }

    // Check for edges: A --> B, A -->|text| B, A -- text --> B, A ==> B, A -.-> B
    const edgeMatch = line.match(
      /([a-zA-Z0-9_-]+)\s*(?:(?:--|==|-\.)(?:([^->=]+?)(?:-->|==>|-\.->|--)|>|->|->>|==>|-\.->))\s*(?:\|([^|]+)\|)?\s*([a-zA-Z0-9_-]+)/,
    );
    if (edgeMatch) {
      const fromId = edgeMatch[1].trim();
      const edgeLabel = (edgeMatch[2] || edgeMatch[3] || "").trim();
      const toId = edgeMatch[4].trim();

      ensureNode(fromId);
      ensureNode(toId);

      const isThick = line.includes("==");
      const isDotted = line.includes("-.");

      edges.push({
        from: fromId,
        to: toId,
        label: edgeLabel,
        style: isThick ? "thick" : isDotted ? "dotted" : "normal",
      });
    }
  }

  // If no edges and no nodes found, fallback to graceful placeholder
  if (nodes.size === 0) {
    return `<svg viewBox="0 0 320 80" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;">
      <rect width="100%" height="100%" rx="8" fill="#1e293b"/>
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="13">📐 Custom Architecture Flow</text>
    </svg>`;
  }

  // Topological / Layer calculation
  const inDegree = new Map();
  const adj = new Map();
  for (const n of nodes.keys()) {
    inDegree.set(n, 0);
    adj.set(n, []);
  }
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    adj.get(e.from)?.push(e.to);
  }

  const layers = [];
  const nodeLayer = new Map();
  const queue = [];

  for (const [n, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push({ node: n, layer: 0 });
    }
  }
  // Handle circular dependencies by seeding unvisited nodes
  if (queue.length === 0 && nodes.size > 0) {
    queue.push({ node: Array.from(nodes.keys())[0], layer: 0 });
  }

  const visited = new Set();
  while (queue.length > 0) {
    const { node, layer } = queue.shift();
    if (visited.has(node)) continue;
    visited.add(node);

    nodeLayer.set(node, layer);
    while (layers.length <= layer) layers.push([]);
    layers[layer].push(node);

    for (const next of adj.get(node) || []) {
      if (!visited.has(next)) {
        queue.push({ node: next, layer: layer + 1 });
      }
    }
  }

  // Put any disconnected leftover nodes into the first layer
  for (const n of nodes.keys()) {
    if (!visited.has(n)) {
      if (!layers[0]) layers[0] = [];
      layers[0].push(n);
      nodeLayer.set(n, 0);
    }
  }

  // Layout calculation
  const NODE_W = 160;
  const NODE_H = 64;
  const GAP_X = isLR ? 100 : 40;
  const GAP_Y = isLR ? 36 : 80;

  const nodeCoords = new Map();

  let totalW = 0;
  let totalH = 0;

  if (isLR) {
    // Left-to-Right layout
    const maxNodesInCol = Math.max(...layers.map((l) => l.length), 1);
    totalW = layers.length * (NODE_W + GAP_X) + 60;
    totalH = maxNodesInCol * (NODE_H + GAP_Y) + 60;

    layers.forEach((layerNodes, colIdx) => {
      const colX = 40 + colIdx * (NODE_W + GAP_X);
      const colHeight = layerNodes.length * NODE_H + (layerNodes.length - 1) * GAP_Y;
      const startY = Math.max(30, (totalH - colHeight) / 2);

      layerNodes.forEach((nodeId, rowIdx) => {
        const rowY = startY + rowIdx * (NODE_H + GAP_Y);
        nodeCoords.set(nodeId, { x: colX, y: rowY });
      });
    });
  } else {
    // Top-to-Down layout
    const maxNodesInRow = Math.max(...layers.map((l) => l.length), 1);
    totalW = maxNodesInRow * (NODE_W + GAP_X) + 60;
    totalH = layers.length * (NODE_H + GAP_Y) + 60;

    layers.forEach((layerNodes, rowIdx) => {
      const rowY = 40 + rowIdx * (NODE_H + GAP_Y);
      const rowWidth = layerNodes.length * NODE_W + (layerNodes.length - 1) * GAP_X;
      const startX = Math.max(30, (totalW - rowWidth) / 2);

      layerNodes.forEach((nodeId, colIdx) => {
        const colX = startX + colIdx * (NODE_W + GAP_X);
        nodeCoords.set(nodeId, { x: colX, y: rowY });
      });
    });
  }

  // SVG Assembly
  let svg = `
  <svg viewBox="0 0 ${Math.max(totalW, 360)} ${Math.max(totalH, 200)}" xmlns="http://www.w3.org/2000/svg" style="width:100%; height:auto; display:block; max-height:560px;">
    <defs>
      <linearGradient id="grad-node" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#1e293b" />
        <stop offset="100%" stop-color="#0f172a" />
      </linearGradient>
      <linearGradient id="grad-db" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#312e81" />
        <stop offset="100%" stop-color="#1e1b4b" />
      </linearGradient>
      <filter id="shadow" x="-8%" y="-8%" width="120%" height="120%">
        <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#000" flood-opacity="0.35"/>
      </filter>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#818cf8"/>
      </marker>
    </defs>
  `;

  // Draw Edges
  for (const e of edges) {
    const from = nodeCoords.get(e.from);
    const to = nodeCoords.get(e.to);
    if (!from || !to) continue;

    let x1, y1, x2, y2, cx1, cy1, cx2, cy2;
    if (isLR) {
      x1 = from.x + NODE_W;
      y1 = from.y + NODE_H / 2;
      x2 = to.x;
      y2 = to.y + NODE_H / 2;
      const dx = (x2 - x1) * 0.5;
      cx1 = x1 + dx;
      cy1 = y1;
      cx2 = x2 - dx;
      cy2 = y2;
    } else {
      x1 = from.x + NODE_W / 2;
      y1 = from.y + NODE_H;
      x2 = to.x + NODE_W / 2;
      y2 = to.y;
      const dy = (y2 - y1) * 0.5;
      cx1 = x1;
      cy1 = y1 + dy;
      cx2 = x2;
      cy2 = y2 - dy;
    }

    const strokeDash = e.style === "dotted" ? 'stroke-dasharray="5 4"' : "";
    const strokeWidth = e.style === "thick" ? 3 : 2;

    svg += `<path d="M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}" fill="none" stroke="#818cf8" stroke-width="${strokeWidth}" ${strokeDash} marker-end="url(#arrow)" opacity="0.85" />`;

    // Edge label badge if present
    if (e.label) {
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const lblLen = Math.max(e.label.length * 7 + 14, 36);
      svg += `
        <rect x="${midX - lblLen / 2}" y="${midY - 10}" width="${lblLen}" height="20" rx="4" fill="#0f172a" stroke="#475569" stroke-width="1" opacity="0.95"/>
        <text x="${midX}" y="${midY + 4}" fill="#cbd5e1" font-family="system-ui, sans-serif" font-size="11" font-weight="500" text-anchor="middle">${escapeHtml(e.label)}</text>
      `;
    }
  }

  // Draw Nodes
  for (const [id, n] of nodes.entries()) {
    const pos = nodeCoords.get(id);
    if (!pos) continue;

    const x = pos.x;
    const y = pos.y;
    const isDb = n.shape === "cylinder";
    const bgFill = isDb ? "url(#grad-db)" : "url(#grad-node)";
    const borderColor = isDb ? "#a855f7" : "#6366f1";

    svg += `<g class="diag-node" filter="url(#shadow)" data-node-id="${escapeHtml(id)}">`;

    if (n.shape === "rounded") {
      svg += `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="20" fill="${bgFill}" stroke="${borderColor}" stroke-width="2"/>`;
    } else if (n.shape === "diamond") {
      const mx = x + NODE_W / 2;
      const my = y + NODE_H / 2;
      svg += `<polygon points="${mx},${y} ${x + NODE_W},${my} ${mx},${y + NODE_H} ${x},${my}" fill="${bgFill}" stroke="${borderColor}" stroke-width="2"/>`;
    } else if (n.shape === "circle") {
      const r = Math.min(NODE_W, NODE_H) / 2;
      const cx = x + NODE_W / 2;
      const cy = y + NODE_H / 2;
      svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${bgFill}" stroke="${borderColor}" stroke-width="2"/>`;
    } else {
      // Box or Cylinder
      svg += `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="8" fill="${bgFill}" stroke="${borderColor}" stroke-width="2"/>`;
      if (isDb) {
        svg += `<path d="M ${x + 6} ${y + 12} Q ${x + NODE_W / 2} ${y + 18} ${x + NODE_W - 6} ${y + 12}" fill="none" stroke="#c084fc" stroke-width="1.5" opacity="0.6"/>`;
      }
    }

    // Node Icon and Label
    const textLabel = n.label.length > 20 ? n.label.slice(0, 18) + "…" : n.label;
    svg += `
      <text x="${x + NODE_W / 2}" y="${y + NODE_H / 2 - 3}" dominant-baseline="middle" text-anchor="middle" font-size="14" fill="#f8fafc" font-family="system-ui, sans-serif">
        <tspan style="font-size:16px;">${n.icon}</tspan>
      </text>
      <text x="${x + NODE_W / 2}" y="${y + NODE_H / 2 + 15}" dominant-baseline="middle" text-anchor="middle" font-size="12" font-weight="600" fill="#f8fafc" font-family="system-ui, -apple-system, sans-serif">
        ${escapeHtml(textLabel)}
      </text>
    `;

    svg += `</g>`;
  }

  svg += `</svg>`;
  return svg;
}

function renderBuiltInSequenceDiagram(lines, { width = 800, isDarkMode = true } = {}) {
  const participants = [];
  const pMap = new Map();
  const messages = [];

  for (const line of lines) {
    const pMatch = line.match(/^participant\s+(?:([a-zA-Z0-9_-]+)\s+as\s+)?(.+)$/i);
    if (pMatch) {
      const id = pMatch[1] || pMatch[2].trim();
      const name = pMatch[2].trim();
      if (!pMap.has(id)) {
        pMap.set(id, { id, name });
        participants.push(id);
      }
      continue;
    }

    const msgMatch = line.match(/([a-zA-Z0-9_-]+)\s*(->>|-->>|->|-->)\s*([a-zA-Z0-9_-]+)\s*:\s*(.+)/);
    if (msgMatch) {
      const from = msgMatch[1].trim();
      const arrow = msgMatch[2];
      const to = msgMatch[3].trim();
      const text = msgMatch[4].trim();

      if (!pMap.has(from)) {
        pMap.set(from, { id: from, name: from });
        participants.push(from);
      }
      if (!pMap.has(to)) {
        pMap.set(to, { id: to, name: to });
        participants.push(to);
      }

      messages.push({ from, to, text, isDashed: arrow.includes("--") });
    }
  }

  const colW = Math.max(160, Math.floor((width - 80) / Math.max(participants.length, 1)));
  const totalW = Math.max(participants.length * colW + 80, 480);
  const totalH = Math.max(messages.length * 60 + 140, 240);

  let svg = `
  <svg viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg" style="width:100%; height:auto; display:block;">
    <defs>
      <marker id="seq-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#818cf8"/>
      </marker>
    </defs>
  `;

  // Draw vertical lifelines
  participants.forEach((pId, idx) => {
    const x = 50 + idx * colW + colW / 2;
    svg += `<line x1="${x}" y1="60" x2="${x}" y2="${totalH - 40}" stroke="#334155" stroke-width="2" stroke-dasharray="4 4" />`;
  });

  // Draw messages
  messages.forEach((msg, idx) => {
    const fIdx = participants.indexOf(msg.from);
    const tIdx = participants.indexOf(msg.to);
    if (fIdx === -1 || tIdx === -1) return;

    const x1 = 50 + fIdx * colW + colW / 2;
    const x2 = 50 + tIdx * colW + colW / 2;
    const y = 80 + idx * 56;
    const strokeDash = msg.isDashed ? 'stroke-dasharray="4 3"' : "";

    svg += `
      <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#818cf8" stroke-width="2" ${strokeDash} marker-end="url(#seq-arrow)"/>
      <rect x="${(x1 + x2) / 2 - (msg.text.length * 6 + 10) / 2}" y="${y - 18}" width="${msg.text.length * 6 + 10}" height="16" rx="3" fill="#0f172a" opacity="0.8"/>
      <text x="${(x1 + x2) / 2}" y="${y - 6}" fill="#f8fafc" font-size="11" font-family="system-ui, sans-serif" font-weight="500" text-anchor="middle">${escapeHtml(msg.text)}</text>
    `;
  });

  // Draw Participant Boxes (Top and Bottom)
  participants.forEach((pId, idx) => {
    const x = 50 + idx * colW + colW / 2 - 60;
    const name = pMap.get(pId)?.name || pId;
    svg += `
      <rect x="${x}" y="14" width="120" height="36" rx="6" fill="#1e293b" stroke="#6366f1" stroke-width="2"/>
      <text x="${x + 60}" y="36" fill="#f8fafc" font-size="12" font-family="system-ui, sans-serif" font-weight="600" text-anchor="middle">${escapeHtml(name)}</text>
      <rect x="${x}" y="${totalH - 44}" width="120" height="32" rx="6" fill="#1e293b" stroke="#6366f1" stroke-width="1.5"/>
      <text x="${x + 60}" y="${totalH - 24}" fill="#f8fafc" font-size="11" font-family="system-ui, sans-serif" text-anchor="middle">${escapeHtml(name)}</text>
    `;
  });

  svg += `</svg>`;
  return svg;
}

/**
 * Creates the HTML card for an interactive architecture diagram.
 */
export function createDiagramCardHtml({ id, type = "mermaid", title = "", rawCode = "", inlineSvg = "" }) {
  const dynamicTitle =
    title ||
    extractDiagramTitle(rawCode || inlineSvg, type === "svg" ? "Vector Diagram" : "Architecture Diagram");
  const cleanCode = escapeHtml(rawCode);
  const cleanTitle = escapeHtml(dynamicTitle);
  const badgeLabel = type === "svg" ? "SVG" : type === "box" ? "Monospace" : "Mermaid";
  const icon = type === "box" ? "📐" : type === "svg" ? "🖼️" : "🏛️";
  const metaAttr = escapeHtml(JSON.stringify({ id, type, title: dynamicTitle, rawCode }));

  return `
    <div class="arch-diagram-card ${type}-card" id="diagram-card-${id}" data-diagram-id="${id}" data-diagram-type="${type}" data-diagram-meta="${metaAttr}">
      <div class="arch-diagram-header">
        <div class="arch-diagram-title-group">
          <span class="arch-diagram-icon">${icon}</span>
          <span class="arch-diagram-title">${cleanTitle}</span>
          <span class="sheet-badge">${badgeLabel}</span>
        </div>
        <div class="arch-diagram-actions">
          ${rawCode ? `<button type="button" class="tiny ghost btn-diag-toggle" title="Toggle Diagram / Source View">👁️ Code</button>` : ""}
          <button type="button" class="tiny ghost btn-diag-zoom-in" title="Zoom In">🔍+</button>
          <button type="button" class="tiny ghost btn-diag-zoom-out" title="Zoom Out">🔍-</button>
          <button type="button" class="tiny ghost btn-diag-zoom-reset" title="Reset Zoom">100%</button>
          <button type="button" class="tiny ghost btn-diag-copy-svg" title="Copy Diagram SVG">📋 SVG</button>
          ${rawCode ? `<button type="button" class="tiny ghost btn-copy-code" data-copy="${cleanCode}" title="Copy Diagram Code">📋 Code</button>` : ""}
          <button type="button" class="tiny ghost btn-diag-expand" title="Fullscreen Diagram Preview">⛶ Expand</button>
        </div>
      </div>
      <div class="arch-diagram-body" id="diagram-body-${id}">
        ${inlineSvg || `<div class="arch-diagram-loading"><span class="typing-bubble"></span> Rendering ${cleanTitle}...</div>`}
      </div>
      ${
        rawCode
          ? `
      <div class="arch-diagram-source" id="diagram-source-${id}" hidden>
        <pre><code>${cleanCode}</code></pre>
      </div>`
          : ""
      }
    </div>
  `;
}
