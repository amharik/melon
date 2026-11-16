import readline from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
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
        protocolVersion: message.params?.protocolVersion || "2026-07-28",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "test-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo text",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const text = message.params?.arguments?.text || "";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: `echo: ${text}` }] },
    });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
