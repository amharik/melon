// Optional Kev / System One reranker client.
//
// Kev is a local decision model served by Ollama at /v1/systemone. It returns
// probabilities for a bounded choice, so Melon uses one `choice` question to
// rerank arbitrary candidate text. The hub owns this call; browser prompts and
// candidates never leave the machine except to the configured Kev endpoint.

const MAX_CANDIDATES = 32;
const MAX_QUERY = 8000;
const MAX_CANDIDATE_TEXT = 2400;
const MAX_TOTAL_CANDIDATE_TEXT = 48 * 1024;

function cleanText(value, max) {
  const text = String(value ?? "")
    .replace(/\u0000/g, "")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function normalizeCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    throw httpError(400, "candidates must be an array");
  }
  if (candidates.length > MAX_CANDIDATES) {
    throw httpError(400, `at most ${MAX_CANDIDATES} candidates are supported`);
  }
  const out = [];
  let total = 0;
  for (const [index, item] of candidates.entries()) {
    const remaining = MAX_TOTAL_CANDIDATE_TEXT - total;
    if (remaining <= 0) break;
    const text = cleanText(
      typeof item === "string" ? item : item?.text ?? item?.content ?? "",
      Math.min(MAX_CANDIDATE_TEXT, remaining)
    );
    if (!text) continue;
    const id =
      typeof item?.id === "string" && item.id.trim()
        ? cleanText(item.id, 120)
        : `candidate-${index + 1}`;
    out.push({ id, text, index: out.length });
    total += text.length;
  }
  if (out.length < 1) throw httpError(400, "at least one non-empty candidate is required");
  return out;
}

export function scoreChoiceAnswer(candidates, answer, topK = candidates.length) {
  const probabilities = answer?.probabilities;
  const choice = typeof answer?.choice === "string" ? answer.choice : "";
  if (!probabilities || typeof probabilities !== "object") {
    throw httpError(502, "Kev returned no choice probabilities");
  }

  const scores = candidates.map((candidate, index) => {
    const key = `c${index}`;
    const raw = Number(probabilities[key]);
    const probability = Number.isFinite(raw) ? raw : choice === key ? 1 : 0;
    return {
      id: candidate.id,
      index,
      probability: Math.max(0, Math.min(1, probability)),
    };
  });

  scores.sort((a, b) => b.probability - a.probability || a.index - b.index);
  scores.forEach((score, rank) => {
    score.rank = rank + 1;
  });

  const limit = Math.max(1, Math.min(candidates.length, Number(topK) || candidates.length));
  return {
    scores,
    ranked: scores.map((score) => score.id),
    selected: scores.slice(0, limit).map((score) => score.id),
  };
}

export function createKevClient({
  url = "",
  model = "kev",
  timeoutMs = 15000,
  fetchImpl = fetch,
} = {}) {
  const base = String(url || "").trim().replace(/\/+$/, "");
  const endpoint = base
    ? base.endsWith("/v1/systemone")
      ? base
      : `${base}/v1/systemone`
    : "";
  const enabled = !!endpoint;
  const selectedModel = String(model || "kev").trim() || "kev";

  async function rerank(query, candidates, options = {}) {
    if (!enabled) throw httpError(503, "Kev is not configured. Set KEV_URL on the hub.");
    const state = cleanText(query, MAX_QUERY);
    if (!state) throw httpError(400, "query is required");
    const list = normalizeCandidates(candidates);
    if (list.length === 1) {
      return {
        model: selectedModel,
        confidence: null,
        scores: [{ id: list[0].id, index: 0, probability: 1, rank: 1 }],
        ranked: [list[0].id],
        selected: [list[0].id],
        usage: null,
      };
    }

    const criteria = {};
    list.forEach((candidate, index) => {
      criteria[`c${index}`] = candidate.text;
    });
    const instructions =
      cleanText(options.instructions, 500) ||
      "Which candidate best satisfies the query? Choose the single most relevant option.";

    const body = {
      model: selectedModel,
      state,
      questions: {
        rank: {
          type: "choice",
          instructions,
          criteria,
        },
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 15000));
    let res;
    let text;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      if (err?.name === "AbortError") throw httpError(504, "Kev rerank timed out");
      throw httpError(502, `Kev request failed: ${String(err?.message || err).slice(0, 200)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw httpError(502, `Kev endpoint ${res.status}: ${String(text || "").slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw httpError(502, "Kev returned invalid JSON");
    }
    const answer = data?.answers?.rank;
    const result = scoreChoiceAnswer(list, answer, options.topK);
    return {
      model: selectedModel,
      confidence: Number.isFinite(Number(answer?.confidence)) ? Number(answer.confidence) : null,
      ...result,
      usage: data?.usage || null,
    };
  }

  return {
    enabled,
    endpoint,
    model: selectedModel,
    rerank,
  };
}
