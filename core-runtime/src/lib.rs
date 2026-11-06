//! Melon core runtime.
//!
//! A deterministic, transport-agnostic dataflow engine. It knows nothing about
//! browsers, tabs, or models: it schedules nodes, routes messages, applies
//! backpressure, and emits `run` commands for the JavaScript host to execute.
//!
//! The same code is compiled to `wasm32-unknown-unknown` for the browser and to
//! the host target for tests.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

const DEFAULT_MAX_QUEUE: usize = 2048;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub node: String,
    pub port: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeSpec {
    #[serde(default)]
    pub id: String,
    pub from: Endpoint,
    pub to: Endpoint,
}

fn default_kind() -> String {
    "task".into()
}
fn default_trigger() -> String {
    "any".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSpec {
    pub id: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_trigger")]
    pub trigger: String,
    #[serde(default)]
    pub concurrency: Option<u32>,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub outputs: Vec<String>,
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GraphSpec {
    #[serde(default)]
    pub nodes: Vec<NodeSpec>,
    #[serde(default)]
    pub edges: Vec<EdgeSpec>,
    #[serde(default)]
    pub options: Value,
}

#[derive(Debug, Clone)]
struct NodeState {
    spec: NodeSpec,
    inbox: HashMap<String, VecDeque<Value>>,
    last: HashMap<String, Value>,
    running: u32,
    dropped: u64,
    delivered: u64,
}

impl NodeState {
    fn new(spec: NodeSpec) -> Self {
        let mut inbox = HashMap::new();
        for port in &spec.inputs {
            inbox.insert(port.clone(), VecDeque::new());
        }
        Self {
            spec,
            inbox,
            last: HashMap::new(),
            running: 0,
            dropped: 0,
            delivered: 0,
        }
    }

    fn concurrency(&self) -> u32 {
        self.spec.concurrency.unwrap_or(1).max(1)
    }
}

#[derive(Debug, Clone)]
struct Job {
    node: String,
}

#[derive(Debug, Clone)]
struct RuntimeConfig {
    max_queue: usize,
    overflow: String,
    trace: bool,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            max_queue: DEFAULT_MAX_QUEUE,
            overflow: "drop-oldest".into(),
            trace: false,
        }
    }
}

#[derive(Debug, Default)]
struct Metrics {
    runs_started: u64,
    runs_finished: u64,
    messages_in: u64,
    messages_routed: u64,
    dropped: u64,
}

pub struct Runtime {
    graph: GraphSpec,
    nodes: Vec<NodeState>,
    index: HashMap<String, usize>,
    outgoing: HashMap<(String, String), Vec<usize>>,
    incoming_count: HashMap<(String, String), usize>,
    jobs: HashMap<String, Job>,
    commands: Vec<Value>,
    events: Vec<Value>,
    metrics: Metrics,
    config: RuntimeConfig,
    seq: u64,
    overflow_reported: HashMap<String, u64>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Runtime {
    pub fn new() -> Self {
        Self {
            graph: GraphSpec::default(),
            nodes: Vec::new(),
            index: HashMap::new(),
            outgoing: HashMap::new(),
            incoming_count: HashMap::new(),
            jobs: HashMap::new(),
            commands: Vec::new(),
            events: Vec::new(),
            metrics: Metrics::default(),
            config: RuntimeConfig::default(),
            seq: 0,
            overflow_reported: HashMap::new(),
        }
    }

    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    fn err(&self, msg: impl Into<String>) -> Value {
        json!({"ok": false, "error": msg.into(), "events": self.events})
    }

    fn finish_response(&self, extra: Value) -> Value {
        let mut out = json!({
            "ok": true,
            "events": self.events,
            "commands": self.commands,
            "metrics": self.metrics_json(),
        });
        if let (Some(obj), Some(add)) = (out.as_object_mut(), extra.as_object()) {
            for (k, v) in add {
                obj.insert(k.clone(), v.clone());
            }
        }
        out
    }

    fn metrics_json(&self) -> Value {
        let mut nodes = Map::new();
        for n in &self.nodes {
            let queued: usize = n.inbox.values().map(|q| q.len()).sum();
            nodes.insert(
                n.spec.id.clone(),
                json!({
                    "queued": queued,
                    "running": n.running,
                    "dropped": n.dropped,
                    "delivered": n.delivered,
                }),
            );
        }
        json!({
            "runsStarted": self.metrics.runs_started,
            "runsFinished": self.metrics.runs_finished,
            "messagesIn": self.metrics.messages_in,
            "messagesRouted": self.metrics.messages_routed,
            "dropped": self.metrics.dropped,
            "activeJobs": self.jobs.len(),
            "nodes": nodes,
            "seq": self.seq,
        })
    }

    fn set_graph(&mut self, graph: GraphSpec) -> Result<Vec<String>, String> {
        let mut warnings = Vec::new();
        let mut index = HashMap::new();

        for (i, node) in graph.nodes.iter().enumerate() {
            if node.id.trim().is_empty() {
                return Err("node id cannot be empty".into());
            }
            if index.insert(node.id.clone(), i).is_some() {
                return Err(format!("duplicate node id: {}", node.id));
            }
            if node.trigger != "any" && node.trigger != "all" {
                return Err(format!("node {}: trigger must be 'any' or 'all'", node.id));
            }
            let mut seen = HashSet::new();
            for p in &node.inputs {
                if !seen.insert(("in", p)) {
                    warnings.push(format!("node {}: duplicate input port {}", node.id, p));
                }
            }
            let mut seen = HashSet::new();
            for p in &node.outputs {
                if !seen.insert(("out", p)) {
                    warnings.push(format!("node {}: duplicate output port {}", node.id, p));
                }
            }
        }

        let mut outgoing: HashMap<(String, String), Vec<usize>> = HashMap::new();
        let mut incoming_count: HashMap<(String, String), usize> = HashMap::new();

        for (ei, edge) in graph.edges.iter().enumerate() {
            let from = index.get(&edge.from.node).ok_or_else(|| {
                format!("edge {}: unknown source node {}", edge.id, edge.from.node)
            })?;
            if !graph.nodes[*from]
                .outputs
                .iter()
                .any(|p| p == &edge.from.port)
            {
                return Err(format!(
                    "edge {}: node {} has no output port '{}'",
                    edge.id, edge.from.node, edge.from.port
                ));
            }
            let to = index
                .get(&edge.to.node)
                .ok_or_else(|| format!("edge {}: unknown target node {}", edge.id, edge.to.node))?;
            if !graph.nodes[*to].inputs.iter().any(|p| p == &edge.to.port) {
                return Err(format!(
                    "edge {}: node {} has no input port '{}'",
                    edge.id, edge.to.node, edge.to.port
                ));
            }
            outgoing
                .entry((edge.from.node.clone(), edge.from.port.clone()))
                .or_default()
                .push(ei);
            *incoming_count
                .entry((edge.to.node.clone(), edge.to.port.clone()))
                .or_default() += 1;
        }

        if let Some(cycle) = find_cycle(&graph, &index) {
            warnings.push(format!("feedback loop: {}", cycle.join(" -> ")));
        }

        // Read graph-level runtime options.
        if let Some(opts) = graph.options.as_object() {
            if let Some(v) = opts.get("maxQueue").and_then(Value::as_u64) {
                self.config.max_queue = (v as usize).max(1);
            }
            if let Some(v) = opts.get("overflow").and_then(Value::as_str) {
                if v == "drop-oldest" || v == "drop-newest" {
                    self.config.overflow = v.into();
                }
            }
        }

        self.nodes = graph.nodes.iter().cloned().map(NodeState::new).collect();
        for node in &mut self.nodes {
            if node.spec.label.is_empty() {
                node.spec.label = node.spec.id.clone();
            }
        }
        self.index = index;
        self.outgoing = outgoing;
        self.incoming_count = incoming_count;
        self.jobs.clear();
        self.commands.clear();
        self.events.clear();
        self.overflow_reported.clear();
        self.graph = graph;
        Ok(warnings)
    }

    fn required_ports(&self, node_idx: usize) -> Vec<String> {
        let node = &self.nodes[node_idx];
        node.spec
            .inputs
            .iter()
            .filter(|p| {
                self.incoming_count
                    .get(&(node.spec.id.clone(), (*p).clone()))
                    .copied()
                    .unwrap_or(0)
                    > 0
            })
            .cloned()
            .collect()
    }

    fn push(&mut self, node_idx: usize, port: &str, message: Value) {
        let max = self.config.max_queue;
        let overflow = self.config.overflow.clone();
        let (id, len) = {
            let n = &self.nodes[node_idx];
            (
                n.spec.id.clone(),
                n.inbox.get(port).map(|q| q.len()).unwrap_or(0),
            )
        };
        if len >= max {
            self.metrics.dropped += 1;
            self.nodes[node_idx].dropped += 1;
            let dropped = self.nodes[node_idx].dropped;
            let key = format!("{id}:{port}");
            let report = match self.overflow_reported.get(&key) {
                None => true,
                Some(prev) => dropped.saturating_sub(*prev) >= 256,
            };
            if report {
                self.overflow_reported.insert(key, dropped);
                self.events.push(json!({
                    "type": "backpressure",
                    "node": id,
                    "port": port,
                    "queue": len,
                    "dropped": dropped,
                    "policy": overflow,
                }));
            }
            if overflow == "drop-newest" {
                return;
            }
            if let Some(q) = self.nodes[node_idx].inbox.get_mut(port) {
                q.pop_front();
            }
        }
        if let Some(q) = self.nodes[node_idx].inbox.get_mut(port) {
            q.push_back(message);
        }
    }

    fn route(&mut self, node_id: &str, port: &str, message: Value) {
        let edges = match self.outgoing.get(&(node_id.to_string(), port.to_string())) {
            Some(e) => e.clone(),
            None => return,
        };
        for ei in edges {
            let edge = self.graph.edges[ei].clone();
            let target = match self.index.get(&edge.to.node) {
                Some(i) => *i,
                None => continue,
            };
            self.metrics.messages_routed += 1;
            self.nodes[target].delivered += 1;
            if self.config.trace {
                self.events.push(json!({
                    "type": "delivered",
                    "edge": edge.id,
                    "from": {"node": edge.from.node, "port": edge.from.port},
                    "to": {"node": edge.to.node, "port": edge.to.port},
                }));
            }
            self.push(target, &edge.to.port, message.clone());
            self.evaluate(target);
        }
    }

    fn fire(
        &mut self,
        node_idx: usize,
        trigger_port: Option<String>,
        inputs: Map<String, Value>,
        context: Map<String, Value>,
    ) {
        let (node_id, kind, mode, outputs, config) = {
            let node = &self.nodes[node_idx];
            (
                node.spec.id.clone(),
                node.spec.kind.clone(),
                node.spec.trigger.clone(),
                node.spec.outputs.clone(),
                node.spec.config.clone(),
            )
        };
        self.metrics.runs_started += 1;
        let seq = self.next_seq();
        let job_id = format!("job_{seq}");
        self.jobs.insert(
            job_id.clone(),
            Job {
                node: node_id.clone(),
            },
        );
        self.nodes[node_idx].running += 1;

        let command = json!({
            "type": "run",
            "job": job_id,
            "node": node_id,
            "kind": kind,
            "mode": mode,
            "triggerPort": trigger_port,
            "inputs": inputs,
            "context": context,
            "outputs": outputs,
            "config": config,
        });
        self.commands.push(command.clone());
        self.events.push(json!({
            "type": "job.started",
            "job": job_id,
            "node": node_id,
        }));
    }

    /// Attempt to start one job for a node if it is ready and under its
    /// concurrency limit. Streaming/queued work is retried after `finish`.
    fn evaluate(&mut self, node_idx: usize) {
        if self.nodes[node_idx].spec.disabled {
            return;
        }
        if self.nodes[node_idx].running >= self.nodes[node_idx].concurrency() {
            return;
        }

        let mode = self.nodes[node_idx].spec.trigger.clone();
        if mode == "all" {
            let required = self.required_ports(node_idx);
            if required.is_empty() {
                return;
            }
            if required.iter().any(|p| {
                self.nodes[node_idx]
                    .inbox
                    .get(p)
                    .map_or(true, |q| q.is_empty())
            }) {
                return;
            }
            let mut inputs = Map::new();
            let mut context = Map::new();
            for port in required {
                if let Some(q) = self.nodes[node_idx].inbox.get_mut(&port) {
                    if let Some(msg) = q.pop_front() {
                        self.nodes[node_idx].last.insert(port.clone(), msg.clone());
                        inputs.insert(port.clone(), json!([msg]));
                    }
                }
            }
            for (p, m) in &self.nodes[node_idx].last {
                context.insert(p.clone(), m.clone());
            }
            self.fire(node_idx, None, inputs, context);
        } else {
            let ports = self.nodes[node_idx].spec.inputs.clone();
            let mut trigger_port = None;
            for p in ports {
                if self.nodes[node_idx]
                    .inbox
                    .get(&p)
                    .map_or(false, |q| !q.is_empty())
                {
                    trigger_port = Some(p);
                    break;
                }
            }
            let port = match trigger_port {
                Some(p) => p,
                None => return,
            };
            let msg = self.nodes[node_idx]
                .inbox
                .get_mut(&port)
                .and_then(|q| q.pop_front());
            let msg = match msg {
                Some(m) => m,
                None => return,
            };
            let mut context = Map::new();
            for (p, m) in &self.nodes[node_idx].last {
                if p != &port {
                    context.insert(p.clone(), m.clone());
                }
            }
            self.nodes[node_idx].last.insert(port.clone(), msg.clone());
            let mut inputs = Map::new();
            inputs.insert(port.clone(), json!([msg]));
            self.fire(node_idx, Some(port), inputs, context);
        }
    }

    fn finish_job(&mut self, job_id: &str, error: Option<Value>) -> bool {
        let job = match self.jobs.remove(job_id) {
            Some(j) => j,
            None => {
                self.events.push(json!({
                    "type": "error",
                    "error": "unknown job",
                    "job": job_id,
                }));
                return false;
            }
        };
        if let Some(i) = self.index.get(&job.node).copied() {
            self.nodes[i].running = self.nodes[i].running.saturating_sub(1);
            self.metrics.runs_finished += 1;
            self.events.push(json!({
                "type": "job.finished",
                "job": job_id,
                "node": job.node,
                "error": error,
            }));
            self.evaluate(i);
        }
        true
    }

    pub fn handle(&mut self, command: Value) -> Value {
        // Each response carries only the effects produced by this call.
        self.events.clear();
        self.commands.clear();
        let op = command
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        match op.as_str() {
            "ping" => {
                self.finish_response(json!({"pong": true, "version": env!("CARGO_PKG_VERSION")}))
            }
            "set_graph" => {
                let graph: GraphSpec = match serde_json::from_value(
                    command.get("graph").cloned().unwrap_or(Value::Null),
                ) {
                    Ok(g) => g,
                    Err(e) => return self.err(format!("invalid graph: {e}")),
                };
                match self.set_graph(graph) {
                    Ok(warnings) => self.finish_response(json!({"warnings": warnings})),
                    Err(e) => self.err(e),
                }
            }
            "input" => {
                let node_id = command.get("node").and_then(Value::as_str).unwrap_or("");
                let port = command.get("port").and_then(Value::as_str).unwrap_or("in");
                let messages: Vec<Value> = match command.get("messages") {
                    Some(Value::Array(a)) => a.clone(),
                    _ => command
                        .get("message")
                        .cloned()
                        .map(|m| vec![m])
                        .unwrap_or_default(),
                };
                let idx = match self.index.get(node_id).copied() {
                    Some(i) => i,
                    None => return self.err(format!("unknown node: {node_id}")),
                };
                if !self.nodes[idx].inbox.contains_key(port) {
                    return self.err(format!("node {node_id} has no input port '{port}'"));
                }
                for msg in messages {
                    self.metrics.messages_in += 1;
                    self.push(idx, port, msg);
                }
                self.evaluate(idx);
                self.finish_response(json!({}))
            }
            "emit" => {
                let node_id = command.get("node").and_then(Value::as_str).unwrap_or("");
                let port = command.get("port").and_then(Value::as_str).unwrap_or("out");
                let messages: Vec<Value> = match command.get("messages") {
                    Some(Value::Array(a)) => a.clone(),
                    _ => command
                        .get("message")
                        .cloned()
                        .map(|m| vec![m])
                        .unwrap_or_default(),
                };
                let idx = match self.index.get(node_id).copied() {
                    Some(i) => i,
                    None => return self.err(format!("unknown node: {node_id}")),
                };
                if !self.nodes[idx].spec.outputs.iter().any(|p| p == port) {
                    return self.err(format!("node {node_id} has no output port '{port}'"));
                }
                for msg in messages {
                    self.metrics.messages_in += 1;
                    self.route(node_id, port, msg);
                }
                self.finish_response(json!({}))
            }
            "output" => {
                let job_id = command.get("job").and_then(Value::as_str).unwrap_or("");
                let port = command.get("port").and_then(Value::as_str).unwrap_or("out");
                let job = match self.jobs.get(job_id) {
                    Some(j) => j.clone(),
                    None => return self.err(format!("unknown job: {job_id}")),
                };
                let node_idx = match self.index.get(&job.node).copied() {
                    Some(i) => i,
                    None => return self.err("job node no longer exists"),
                };
                if !self.nodes[node_idx].spec.outputs.iter().any(|p| p == port) {
                    return self.err(format!("node {} has no output port '{port}'", job.node));
                }
                let messages: Vec<Value> = match command.get("messages") {
                    Some(Value::Array(a)) => a.clone(),
                    _ => command
                        .get("message")
                        .cloned()
                        .map(|m| vec![m])
                        .unwrap_or_default(),
                };
                for msg in messages {
                    self.route(&job.node, port, msg);
                }
                self.finish_response(json!({}))
            }
            "finish" | "cancel" => {
                let job_id = command.get("job").and_then(Value::as_str).unwrap_or("");
                let error = if op == "cancel" {
                    Some(json!({"message": "cancelled"}))
                } else {
                    command.get("error").cloned().filter(|v| !v.is_null())
                };
                let ok = self.finish_job(job_id, error);
                self.finish_response(json!({"finished": ok}))
            }
            "reset" => {
                for node in &mut self.nodes {
                    for q in node.inbox.values_mut() {
                        q.clear();
                    }
                    node.last.clear();
                    node.running = 0;
                    node.dropped = 0;
                    node.delivered = 0;
                }
                self.jobs.clear();
                self.metrics = Metrics::default();
                self.overflow_reported.clear();
                self.events.clear();
                self.commands.clear();
                self.finish_response(json!({}))
            }
            "snapshot" => {
                let nodes: Vec<Value> = self
                    .nodes
                    .iter()
                    .map(|n| {
                        json!({
                            "id": n.spec.id,
                            "queued": n.inbox.iter().map(|(p, q)| (p.clone(), json!(q.len()))).collect::<Map<_,_>>(),
                            "running": n.running,
                            "dropped": n.dropped,
                            "delivered": n.delivered,
                        })
                    })
                    .collect();
                self.finish_response(json!({
                    "graph": self.graph,
                    "state": {"nodes": nodes, "jobs": self.jobs.keys().cloned().collect::<Vec<_>>()},
                }))
            }
            "metrics" => self.finish_response(json!({})),
            _ => self.err(format!("unknown op: {op}")),
        }
    }
}

fn find_cycle(graph: &GraphSpec, index: &HashMap<String, usize>) -> Option<Vec<String>> {
    let mut adj: HashMap<usize, Vec<usize>> = HashMap::new();
    for e in &graph.edges {
        if let (Some(a), Some(b)) = (index.get(&e.from.node), index.get(&e.to.node)) {
            adj.entry(*a).or_default().push(*b);
        }
    }
    fn dfs(
        v: usize,
        adj: &HashMap<usize, Vec<usize>>,
        color: &mut Vec<u8>,
        stack: &mut Vec<usize>,
        graph: &GraphSpec,
    ) -> Option<Vec<String>> {
        color[v] = 1;
        stack.push(v);
        for &n in adj.get(&v).map(|x| x.as_slice()).unwrap_or(&[]) {
            if color[n] == 1 {
                let start = stack.iter().position(|&x| x == n).unwrap_or(0);
                let mut cyc: Vec<String> = stack[start..]
                    .iter()
                    .map(|&i| graph.nodes[i].id.clone())
                    .collect();
                cyc.push(graph.nodes[n].id.clone());
                return Some(cyc);
            }
            if color[n] == 0 {
                if let Some(c) = dfs(n, adj, color, stack, graph) {
                    return Some(c);
                }
            }
        }
        stack.pop();
        color[v] = 2;
        None
    }
    let mut color = vec![0u8; graph.nodes.len()];
    let mut stack = Vec::new();
    for i in 0..graph.nodes.len() {
        if color[i] == 0 {
            if let Some(c) = dfs(i, &adj, &mut color, &mut stack, graph) {
                return Some(c);
            }
        }
    }
    None
}

thread_local! {
    static RUNTIME: std::cell::RefCell<Runtime> = std::cell::RefCell::new(Runtime::new());
}

/// JSON-in/JSON-out entry point used by the WASM ABI and by native tests.
pub fn handle_json(input: &str) -> String {
    RUNTIME.with(|rt| {
        let value: Value = match serde_json::from_str(input) {
            Ok(v) => v,
            Err(e) => {
                return json!({"ok": false, "error": format!("invalid json: {e}")}).to_string()
            }
        };
        let out = rt.borrow_mut().handle(value);
        serde_json::to_string(&out).unwrap_or_else(|e| {
            json!({"ok": false, "error": format!("serialize error: {e}")}).to_string()
        })
    })
}

pub fn reset_for_tests() {
    RUNTIME.with(|rt| {
        *rt.borrow_mut() = Runtime::new();
    });
}

#[cfg(target_arch = "wasm32")]
mod abi {
    use super::*;
    use std::alloc::{alloc, dealloc, Layout};
    use std::cell::RefCell;

    thread_local! {
        static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }

    #[no_mangle]
    pub extern "C" fn melon_alloc(len: usize) -> *mut u8 {
        if len == 0 {
            return std::ptr::null_mut();
        }
        unsafe { alloc(Layout::from_size_align(len, 1).expect("valid layout")) }
    }

    /// Copies the input into a String, deallocates it, runs the command and
    /// returns a pointer to the response bytes. The caller must copy the bytes
    /// before invoking another command (the buffer is reused).
    #[no_mangle]
    pub unsafe extern "C" fn melon_call(ptr: *mut u8, len: usize) -> *const u8 {
        if ptr.is_null() || len == 0 {
            let msg = json!({"ok": false, "error": "empty input"}).to_string();
            return set_out(msg);
        }
        let input = std::slice::from_raw_parts(ptr, len).to_vec();
        dealloc(ptr, Layout::from_size_align(len, 1).expect("valid layout"));
        let text = String::from_utf8_lossy(&input);
        set_out(handle_json(&text))
    }

    fn set_out(text: String) -> *const u8 {
        OUT.with(|out| {
            let mut out = out.borrow_mut();
            *out = text.into_bytes();
            out.as_ptr()
        })
    }

    #[no_mangle]
    pub extern "C" fn melon_out_len() -> usize {
        OUT.with(|out| out.borrow().len())
    }

    #[no_mangle]
    pub extern "C" fn melon_version() -> u32 {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph(nodes: Value, edges: Value) -> Value {
        json!({"op": "set_graph", "graph": {"nodes": nodes, "edges": edges}})
    }

    fn run_ok(rt: &mut Runtime, cmd: Value) -> Value {
        let out = rt.handle(cmd);
        assert_eq!(out["ok"], true, "command failed: {out}");
        out
    }

    fn node(id: &str, kind: &str, trigger: &str, inputs: Value, outputs: Value) -> Value {
        json!({"id": id, "kind": kind, "trigger": trigger, "inputs": inputs, "outputs": outputs})
    }

    #[test]
    fn routes_source_through_transform_to_sink() {
        let mut rt = Runtime::new();
        run_ok(
            &mut rt,
            graph(
                json!([
                    node("src", "source", "all", json!([]), json!(["out"])),
                    node("agent", "agent", "any", json!(["in"]), json!(["out"])),
                    node("sink", "sink", "any", json!(["in"]), json!([])),
                ]),
                json!([
                    {"id":"e1","from":{"node":"src","port":"out"},"to":{"node":"agent","port":"in"}},
                    {"id":"e2","from":{"node":"agent","port":"out"},"to":{"node":"sink","port":"in"}},
                ]),
            ),
        );

        let out = run_ok(
            &mut rt,
            json!({"op":"emit","node":"src","port":"out","message":{"text":"hello"}}),
        );
        assert_eq!(out["commands"].as_array().unwrap().len(), 1);
        let cmd = &out["commands"][0];
        assert_eq!(cmd["node"], "agent");
        let job = cmd["job"].as_str().unwrap().to_string();

        let out = run_ok(
            &mut rt,
            json!({"op":"output","job":job,"port":"out","message":{"text":"hi back"}}),
        );
        assert_eq!(out["commands"][0]["node"], "sink");

        let sink_job = out["commands"][0]["job"].as_str().unwrap().to_string();
        run_ok(&mut rt, json!({"op":"finish","job":sink_job}));
        run_ok(&mut rt, json!({"op":"finish","job":job}));
        let snap = run_ok(&mut rt, json!({"op":"metrics"}));
        assert_eq!(snap["metrics"]["runsStarted"], 2);
        assert_eq!(snap["metrics"]["runsFinished"], 2);
        assert_eq!(snap["metrics"]["messagesRouted"], 2);
    }

    #[test]
    fn fan_out_broadcasts_to_every_edge() {
        let mut rt = Runtime::new();
        run_ok(
            &mut rt,
            graph(
                json!([
                    node("src", "source", "all", json!([]), json!(["out"])),
                    node("a", "agent", "any", json!(["in"]), json!(["out"])),
                    node("b", "agent", "any", json!(["in"]), json!(["out"])),
                ]),
                json!([
                    {"id":"e1","from":{"node":"src","port":"out"},"to":{"node":"a","port":"in"}},
                    {"id":"e2","from":{"node":"src","port":"out"},"to":{"node":"b","port":"in"}},
                ]),
            ),
        );
        let out = run_ok(
            &mut rt,
            json!({"op":"emit","node":"src","port":"out","message":{"text":"x"}}),
        );
        let nodes: Vec<&str> = out["commands"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["node"].as_str().unwrap())
            .collect();
        assert_eq!(nodes, vec!["a", "b"]);
    }

    #[test]
    fn join_waits_for_all_required_ports() {
        let mut rt = Runtime::new();
        run_ok(
            &mut rt,
            graph(
                json!([
                    node("a", "source", "all", json!([]), json!(["out"])),
                    node("b", "source", "all", json!([]), json!(["out"])),
                    node("join", "join", "all", json!(["in1", "in2"]), json!(["out"])),
                ]),
                json!([
                    {"id":"e1","from":{"node":"a","port":"out"},"to":{"node":"join","port":"in1"}},
                    {"id":"e2","from":{"node":"b","port":"out"},"to":{"node":"join","port":"in2"}},
                ]),
            ),
        );
        let out = run_ok(
            &mut rt,
            json!({"op":"emit","node":"a","port":"out","message":{"text":"a"}}),
        );
        assert_eq!(out["commands"].as_array().unwrap().len(), 0);
        let out = run_ok(
            &mut rt,
            json!({"op":"emit","node":"b","port":"out","message":{"text":"b"}}),
        );
        assert_eq!(out["commands"].as_array().unwrap().len(), 1);
        let cmd = &out["commands"][0];
        assert_eq!(cmd["node"], "join");
        assert_eq!(cmd["inputs"]["in1"][0]["text"], "a");
        assert_eq!(cmd["inputs"]["in2"][0]["text"], "b");
    }

    #[test]
    fn concurrency_queues_extra_jobs() {
        let mut rt = Runtime::new();
        run_ok(
            &mut rt,
            graph(
                json!([
                    node("src", "source", "all", json!([]), json!(["out"])),
                    node("agent", "agent", "any", json!(["in"]), json!(["out"])),
                ]),
                json!([
                    {"id":"e1","from":{"node":"src","port":"out"},"to":{"node":"agent","port":"in"}},
                ]),
            ),
        );
        let out = run_ok(
            &mut rt,
            json!({"op":"emit","node":"src","port":"out","messages":[{"n":1},{"n":2}]}),
        );
        assert_eq!(out["commands"].as_array().unwrap().len(), 1);
        let job = out["commands"][0]["job"].as_str().unwrap().to_string();
        let out = run_ok(&mut rt, json!({"op":"finish","job":job}));
        assert_eq!(out["commands"].as_array().unwrap().len(), 1);
        assert_eq!(out["commands"][0]["inputs"]["in"][0]["n"], 2);
    }

    #[test]
    fn backpressure_drops_oldest() {
        let mut rt = Runtime::new();
        run_ok(
            &mut rt,
            json!({"op":"set_graph","graph":{
                "options":{"maxQueue":2},
                "nodes":[
                    node("src", "source", "all", json!([]), json!(["out"])),
                    node("sink", "sink", "any", json!(["in"]), json!([])),
                ],
                "edges":[
                    {"id":"e1","from":{"node":"src","port":"out"},"to":{"node":"sink","port":"in"}},
                ]
            }}),
        );
        // First message starts a job; the next three fill the queue, then the
        // oldest queued message (n=2) is dropped when n=4 arrives.
        let out = run_ok(
            &mut rt,
            json!({"op":"emit","node":"src","port":"out","messages":[{"n":1},{"n":2},{"n":3},{"n":4}]}),
        );
        assert_eq!(out["commands"].as_array().unwrap().len(), 1);
        assert!(out["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "backpressure"));
        let job = out["commands"][0]["job"].as_str().unwrap().to_string();
        let out = run_ok(&mut rt, json!({"op":"finish","job":job}));
        assert_eq!(out["commands"][0]["inputs"]["in"][0]["n"], 3);
    }

    #[test]
    fn rejects_unknown_ports_and_nodes() {
        let mut rt = Runtime::new();
        let out = rt.handle(graph(
            json!([node("a", "task", "any", json!(["in"]), json!(["out"]))]),
            json!([{"id":"e1","from":{"node":"a","port":"nope"},"to":{"node":"a","port":"in"}}]),
        ));
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().contains("no output port"));

        run_ok(
            &mut rt,
            graph(
                json!([node("a", "task", "any", json!(["in"]), json!(["out"]))]),
                json!([]),
            ),
        );
        let out = rt.handle(json!({"op":"input","node":"a","port":"missing","message":{}}));
        assert_eq!(out["ok"], false);
    }

    #[test]
    fn detects_feedback_loop_as_warning() {
        let mut rt = Runtime::new();
        let out = run_ok(
            &mut rt,
            graph(
                json!([
                    node("a", "agent", "any", json!(["in"]), json!(["out"])),
                    node("b", "agent", "any", json!(["in"]), json!(["out"])),
                ]),
                json!([
                    {"id":"e1","from":{"node":"a","port":"out"},"to":{"node":"b","port":"in"}},
                    {"id":"e2","from":{"node":"b","port":"out"},"to":{"node":"a","port":"in"}},
                ]),
            ),
        );
        assert!(out["warnings"][0]
            .as_str()
            .unwrap()
            .contains("feedback loop"));
    }

    #[test]
    fn snapshot_is_json_serializable() {
        let mut rt = Runtime::new();
        run_ok(
            &mut rt,
            graph(
                json!([node("a", "task", "any", json!(["in"]), json!(["out"]))]),
                json!([]),
            ),
        );
        let out = run_ok(&mut rt, json!({"op":"snapshot"}));
        assert_eq!(out["graph"]["nodes"][0]["id"], "a");
    }

    #[test]
    fn json_entrypoint_roundtrips() {
        reset_for_tests();
        let out: Value = serde_json::from_str(&handle_json(r#"{"op":"ping"}"#)).unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["pong"], true);
    }
}
