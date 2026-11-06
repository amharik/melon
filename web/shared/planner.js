export const PLAN_LIMITS = {
  maxNodes: 12,
  maxEdges: 24,
  maxGoal: 8000,
};

export const PLAN_ADAPTERS = [
  "demo:claude",
  "demo:gemini",
  "demo:mistral",
  "demo:chatgpt",
  "demo:moderator",
  "ext",
  "opencode",
  "llm",
];

const ADAPTER_ALIASES = {
  claude: "demo:claude",
  gemini: "demo:gemini",
  mistral: "demo:mistral",
  chatgpt: "demo:chatgpt",
  moderator: "demo:moderator",
  "demo:claude": "demo:claude",
  "demo:gemini": "demo:gemini",
  "demo:mistral": "demo:mistral",
  "demo:chatgpt": "demo:chatgpt",
  "demo:moderator": "demo:moderator",
  ext: "ext",
  extension: "ext",
  "bridged web tab": "ext",
  opencode: "opencode",
  "opencode serve": "opencode",
  llm: "llm",
  "hub llm": "llm",
};

const KIND_SPECS = {
  source: { inputs: [], outputs: ["out"], trigger: "all" },
  agent: { inputs: ["in"], outputs: ["stream", "result"], trigger: "any" },
  join: { inputs: ["in1", "in2"], outputs: ["result"], trigger: "all" },
  sink: { inputs: ["in"], outputs: [], trigger: "any" },
};

const AGENT_LABELS = {
  "demo:claude": "Claude",
  "demo:gemini": "Gemini",
  "demo:mistral": "Mistral",
  "demo:chatgpt": "ChatGPT",
  "demo:moderator": "Moderator",
  ext: "Bridged tab",
  opencode: "opencode",
  llm: "Hub LLM",
};

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function normalizeId(value) {
  const text = cleanText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!text) return "";
  return /^[0-9]/.test(text) ? `n-${text}` : text;
}

function normalizeKind(value) {
  const kind = cleanText(value, 20).toLowerCase();
  return Object.prototype.hasOwnProperty.call(KIND_SPECS, kind) ? kind : "";
}

function normalizeAdapter(value) {
  const key = cleanText(value, 40).toLowerCase();
  const adapter = ADAPTER_ALIASES[key] || key;
  return PLAN_ADAPTERS.includes(adapter) ? adapter : "";
}

function layoutNodes(nodes) {
  const byKind = { source: [], agent: [], join: [], sink: [] };
  for (const node of nodes) byKind[node.kind].push(node);

  byKind.source.forEach((node, index) => {
    node.x = 20;
    node.y = 220 + index * 150;
  });
  byKind.agent.forEach((node, index) => {
    node.x = 270;
    node.y = 30 + index * 170;
  });
  byKind.join.forEach((node, index) => {
    node.x = 520;
    node.y = 220 + index * 170;
  });
  byKind.sink.forEach((node, index) => {
    node.x = 770;
    node.y = 220 + index * 150;
  });
}

function edgeKey(edge) {
  return `${edge.from.node}:${edge.from.port}->${edge.to.node}:${edge.to.port}`;
}

export function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return a JSON object");
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new Error(`model returned invalid JSON: ${error.message}`);
  }
}

export function validatePlanGraph(input, options = {}) {
  const errors = [];
  const warnings = [];
  const raw = asObject(input);
  if (!raw) return { ok: false, errors: ["plan must be a JSON object"], warnings, graph: null };

  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  if (rawNodes.length < 2) errors.push("plan must contain at least a source and a sink");
  if (rawNodes.length > PLAN_LIMITS.maxNodes) {
    errors.push(`plan contains more than ${PLAN_LIMITS.maxNodes} nodes`);
  }
  if (rawEdges.length > PLAN_LIMITS.maxEdges) {
    errors.push(`plan contains more than ${PLAN_LIMITS.maxEdges} edges`);
  }

  const idMap = new Map();
  const nodes = [];
  const nodeById = new Map();
  rawNodes.forEach((rawNode, index) => {
    const source = asObject(rawNode);
    if (!source) {
      errors.push(`nodes[${index}] must be an object`);
      return;
    }
    const id = normalizeId(source.id);
    if (!id) {
      errors.push(`nodes[${index}].id is required`);
      return;
    }
    if (nodeById.has(id)) {
      errors.push(`duplicate node id ${id}`);
      return;
    }
    const kind = normalizeKind(source.kind);
    if (!kind) {
      errors.push(`nodes[${index}].kind must be one of ${Object.keys(KIND_SPECS).join(", ")}`);
      return;
    }
    const spec = KIND_SPECS[kind];
    const config = asObject(source.config) || {};
    let inputs = [...spec.inputs];
    if (kind === "agent" && Array.isArray(source.inputs)) {
      const custom = source.inputs
        .map((port) => cleanText(port, 24))
        .filter(Boolean)
        .slice(0, 4);
      if (custom.length) inputs = [...new Set(custom)];
    }
    const node = {
      id,
      kind,
      label: cleanText(source.label, 60) || (kind === "source" ? "Brief" : kind === "sink" ? "Decision" : kind === "join" ? "Join" : "Agent"),
      trigger: kind === "agent" && inputs.length > 1 ? "all" : spec.trigger,
      concurrency: 1,
      inputs,
      outputs: [...spec.outputs],
      config: {},
      x: 0,
      y: 0,
    };

    if (kind === "source") {
      node.label = cleanText(source.label, 60) || "Brief";
      node.config.topic = cleanText(config.topic, PLAN_LIMITS.maxGoal) || cleanText(options.goal, PLAN_LIMITS.maxGoal);
    } else if (kind === "agent") {
      const adapter = normalizeAdapter(config.adapter || source.adapter);
      if (!adapter) {
        errors.push(`nodes[${index}] (${id}) has an unsupported adapter`);
      } else {
        node.config.adapter = adapter;
        node.config.outputFormat = ["markdown", "text", "json"].includes(config.outputFormat)
          ? config.outputFormat
          : "markdown";
        if (typeof config.instructions === "string" && config.instructions.trim()) {
          node.config.instructions = config.instructions.trim().slice(0, 2000);
        }
        node.label = cleanText(source.label, 60) || AGENT_LABELS[adapter] || "Agent";
        if (adapter === "ext") warnings.push(`${node.label} needs a bridged tab binding before it can run.`);
      }
    } else if (kind === "join") {
      node.label = cleanText(source.label, 60) || "Join";
    } else if (kind === "sink") {
      node.label = cleanText(source.label, 60) || "Decision";
    }

    const originalId = cleanText(source.id, 80);
    if (originalId) idMap.set(originalId, id);
    idMap.set(id, id);
    nodes.push(node);
    nodeById.set(id, node);
  });

  const sources = nodes.filter((node) => node.kind === "source");
  const sinks = nodes.filter((node) => node.kind === "sink");
  const agents = nodes.filter((node) => node.kind === "agent");
  if (sources.length !== 1) errors.push(`plan must contain exactly one source, found ${sources.length}`);
  if (sinks.length !== 1) errors.push(`plan must contain exactly one sink, found ${sinks.length}`);
  if (!agents.length) errors.push("plan must contain at least one agent node");

  const edges = [];
  const edgeIds = new Set();
  const edgeKeys = new Set();
  rawEdges.forEach((rawEdge, index) => {
    const source = asObject(rawEdge);
    if (!source) {
      errors.push(`edges[${index}] must be an object`);
      return;
    }
    const from = asObject(source.from);
    const to = asObject(source.to);
    if (!from || !to) {
      errors.push(`edges[${index}] must have from and to objects`);
      return;
    }
    const fromId = idMap.get(cleanText(from.node, 80));
    const toId = idMap.get(cleanText(to.node, 80));
    const fromNode = nodeById.get(fromId);
    const toNode = nodeById.get(toId);
    if (!fromNode || !toNode) {
      errors.push(`edges[${index}] references an unknown node`);
      return;
    }
    const fromPort = cleanText(from.port, 24);
    const toPort = cleanText(to.port, 24);
    if (!fromNode.outputs.includes(fromPort)) {
      errors.push(`edges[${index}] uses invalid output ${fromId}:${fromPort}`);
      return;
    }
    if (!toNode.inputs.includes(toPort)) {
      errors.push(`edges[${index}] uses invalid input ${toId}:${toPort}`);
      return;
    }
    if (fromId === toId) {
      errors.push(`edges[${index}] cannot connect a node to itself`);
      return;
    }
    const id = normalizeId(source.id) && !edgeIds.has(normalizeId(source.id))
      ? normalizeId(source.id)
      : `e${index + 1}`;
    edgeIds.add(id);
    const edge = {
      id,
      from: { node: fromId, port: fromPort },
      to: { node: toId, port: toPort },
    };
    const key = edgeKey(edge);
    if (edgeKeys.has(key)) {
      warnings.push(`duplicate edge ${key} ignored`);
      return;
    }
    edgeKeys.add(key);
    edges.push(edge);
  });

  if (errors.length) return { ok: false, errors, warnings, graph: null };

  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    outgoing.get(edge.from.node).push(edge.to.node);
    indegree.set(edge.to.node, (indegree.get(edge.to.node) || 0) + 1);
    incoming.set(edge.to.node, (incoming.get(edge.to.node) || 0) + 1);
  }

  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited++;
    for (const next of outgoing.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== nodes.length) errors.push("plan contains a cycle");

  const reachable = new Set();
  const pending = [sources[0]?.id].filter(Boolean);
  while (pending.length) {
    const id = pending.shift();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    for (const next of outgoing.get(id) || []) pending.push(next);
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) errors.push(`node ${node.id} is not reachable from the source`);
  }
  if (sources[0] && incoming.get(sources[0].id)) errors.push("source cannot have incoming edges");
  if (sinks[0] && !incoming.get(sinks[0].id)) errors.push("sink needs an incoming edge");
  if (agents.some((node) => !incoming.get(node.id))) {
    errors.push("every agent needs an incoming edge");
  }

  if (errors.length) return { ok: false, errors, warnings, graph: null };

  layoutNodes(nodes);
  return {
    ok: true,
    errors: [],
    warnings: [...new Set(warnings)],
    graph: { nodes, edges },
  };
}
