#!/usr/bin/env node
import process from "node:process";
import { buildResponse } from "../web/shared/simulator.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}");
const goal = input.vars?.goal || input.prompt || "the current proposal";
const mode = input.config?.mode || "moderator";
const output =
  mode === "single"
    ? buildResponse("claude", goal)
    : buildResponse(
        "moderator",
        `${goal}\n\nrev1\n${buildResponse("claude", goal)}\n\nrev2\n${buildResponse("gemini", goal)}`,
      );

process.stdout.write(JSON.stringify({ output }));
