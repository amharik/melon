import readline from "node:readline";

const sessionId = "test-session";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let pendingPrompt = null;
let permissionRequestId = null;

function finishPrompt() {
  if (!pendingPrompt) return;
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `echo: ${pendingPrompt.text}` },
      },
    },
  });
  send({ jsonrpc: "2.0", id: pendingPrompt.id, result: { stopReason: "end_turn" } });
  pendingPrompt = null;
  permissionRequestId = null;
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
        agentInfo: { name: "test-acp-agent", version: "0.0.1" },
      },
    });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    const prompt = (message.params?.prompt || [])
      .map((block) => (block?.type === "text" ? block.text : ""))
      .join("");
    pendingPrompt = { id: message.id, text: prompt };
    permissionRequestId = Number(message.id) * 1000 + 1;
    send({
      jsonrpc: "2.0",
      id: permissionRequestId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "permission-1" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    return;
  }
  if (pendingPrompt && message.id === permissionRequestId && message.method === undefined) {
    finishPrompt();
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
