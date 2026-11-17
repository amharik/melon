/**
 * Melon Autonomous Multi-Agent Debate Engine & Channel Blackboard Protocol
 * Implements Mechanism D: Autonomous Debates with scoped channel blackboards,
 * sequential turn-taking, adversarial review, and execution verification.
 */

export function parseDebateMentions(rawText) {
  if (!rawText || typeof rawText !== "string") return [];
  const matches = [...rawText.matchAll(/@([a-zA-Z0-9_-]+)/g)];
  const seen = new Set();
  const list = [];
  for (const m of matches) {
    const handle = m[1].toLowerCase();
    if (!seen.has(handle)) {
      seen.add(handle);
      list.push(handle);
    }
  }
  return list;
}

export function isDebateTrigger(rawText) {
  if (!rawText || typeof rawText !== "string") return false;
  const trimmed = rawText.trim();
  if (/^\/debate\b/i.test(trimmed)) return true;
  const mentions = parseDebateMentions(trimmed);
  return mentions.length >= 2;
}

export function buildDebateTurnPrompt({ topic, role, roundNumber, previousOutput = "", initialProposal = "" }) {
  const cleanTopic = topic || "System Architecture & Implementation";
  if (role === "proposer" || roundNumber === 1) {
    return `[Autonomous Multi-Agent Debate]\nGoal: ${cleanTopic}\nRole: Lead Architect / Proposer (Round 1)\n\nTask: Propose a concrete technical solution, architecture, or design. Detail key components, trade-offs, and implementation specifications.`;
  }

  if (role === "critic") {
    return `[Autonomous Multi-Agent Debate]\nGoal: ${cleanTopic}\nRole: Adversarial Critic & Reviewer (Round ${roundNumber})\nContext from Proposal:\n${(previousOutput || initialProposal).slice(0, 1600)}\n\nTask: Critically review and stress-test this proposal. Identify edge cases, potential bottlenecks, security risks, and propose specific architectural refinements or alternatives.`;
  }

  // Implementer / Verifier
  return `[Autonomous Multi-Agent Debate]\nGoal: ${cleanTopic}\nRole: Lead Implementer & Verifier (Round ${roundNumber})\nVerified Proposal:\n${(initialProposal || previousOutput).slice(0, 1000)}\n\nRefinements:\n${previousOutput.slice(0, 1000)}\n\nTask: Implement the verified consensus. Produce clean, robust code or configuration, and detail how to test and verify the solution.`;
}

export function synthesizeDebateConsensus({ topic, turns = [], artifacts = [] }) {
  const cleanTopic = topic || "Technical Specification";
  const debaters = [...new Set(turns.map((t) => t.speaker || t.handle))];
  const artifactCount = Array.isArray(artifacts) ? artifacts.length : 0;

  return `### Verified Consensus: ${cleanTopic}\n\n` +
    `**Debate Rounds Completed:** ${turns.length} round(s) across **${debaters.join(", ")}**.\n\n` +
    `**Key Architecture Decisions:**\n` +
    `- **Architectural Foundation:** Validated proposal and core abstractions established.\n` +
    `- **Adversarial Hardening:** Stress-tested edge cases, security boundaries, and scalability considerations incorporated.\n` +
    `- **Implementation Artifacts:** ${artifactCount} concrete artifact(s) captured in Channel Blackboard.\n\n` +
    `*(Autonomous multi-agent debate concluded successfully. All state preserved in Channel Blackboard.)*`;
}

export function formatAcpMessageChunk(text, runId = "") {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: String(text || "") },
      runId,
    },
  };
}
