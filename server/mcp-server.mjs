#!/usr/bin/env node
// stdio MCP server exposing read/write access to a local Melon hub.
// Run: MELON_HUB_URL=http://127.0.0.1:8787 node server/mcp-server.mjs

import { createMcpServer, serveMcpStdio } from "./mcp.mjs";

const hubUrl = process.env.MELON_HUB_URL || "http://127.0.0.1:8787";
const server = createMcpServer({ hubUrl });
serveMcpStdio(server);
process.stderr.write(`[melon-mcp] serving hub ${hubUrl}\n`);
