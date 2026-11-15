// Artifact Harvester: Extracts code blocks, files, and artifact containers
// from agentic LLM outputs (ChatGPT Canvas, Claude Artifacts, Gemini Code).

const EXTENSION_MAP = {
  javascript: "js",
  js: "js",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  jsx: "jsx",
  python: "py",
  py: "py",
  rust: "rs",
  rs: "rs",
  go: "go",
  golang: "go",
  html: "html",
  css: "css",
  json: "json",
  yaml: "yaml",
  yml: "yml",
  markdown: "md",
  md: "md",
  sql: "sql",
  sh: "sh",
  bash: "sh",
  diff: "diff",
  patch: "patch",
  toml: "toml",
  xml: "xml",
  dockerfile: "Dockerfile",
};

/**
 * Extract artifacts (code files, diffs, documents) from markdown text.
 * @param {string} text 
 * @returns {Array<{ id: string, filename: string, language: string, content: string, size: number, type: string }>}
 */
export function extractArtifactsFromText(text) {
  if (!text || typeof text !== "string") return [];

  const artifacts = [];
  const seenFilenames = new Set();
  let index = 1;

  // 1. Claude Artifact tag extraction: <antArtifact identifier="..." type="..." title="...">
  const claudeArtifactRegex = /<antArtifact\s+[^>]*?title=["']([^"']+)["'][^>]*?(?:language=["']([^"']+)["'])?[^>]*?>([\s\S]*?)<\/antArtifact>/gi;
  let match;
  while ((match = claudeArtifactRegex.exec(text)) !== null) {
    const rawTitle = match[1].trim();
    const lang = (match[2] || "").trim().toLowerCase();
    const content = match[3].trim();
    let filename = rawTitle;
    if (!pathHasExtension(filename) && lang && EXTENSION_MAP[lang]) {
      filename = `${filename}.${EXTENSION_MAP[lang]}`;
    }
    const cleanName = sanitizeFilename(filename, `artifact-${index}`);
    if (!seenFilenames.has(cleanName)) {
      seenFilenames.add(cleanName);
      artifacts.push({
        id: `art-${index++}`,
        filename: cleanName,
        language: lang || inferLanguage(cleanName),
        content,
        size: content.length,
        type: "claude-artifact",
      });
    }
  }

  // 2. Code blocks extraction with filename indicators
  // Matches ```lang[:filename] or ```lang filename="foo"
  const codeBlockRegex = /(?:###?[ \t]+([^\n`]+)\r?\n[ \t]*)?```([a-zA-Z0-9_-]+)?(?:[ \t]+(?:filepath=|filename=|file:)?([^\r\n`]+))?\r?\n([\s\S]*?)```/g;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const precedingHeader = (match[1] || "").trim();
    const lang = (match[2] || "").trim().toLowerCase();
    const inlineMeta = (match[3] || "").trim().replace(/["']/g, "");
    let content = match[4];

    // Check for filepath/filename comment in first 3 lines of code
    let detectedName = "";
    if (inlineMeta && (inlineMeta.includes(".") || inlineMeta.includes("/"))) {
      detectedName = inlineMeta;
    } else if (precedingHeader && (precedingHeader.includes(".") || precedingHeader.includes("/"))) {
      detectedName = precedingHeader;
    }

    if (!detectedName) {
      const lines = content.split("\n").slice(0, 3);
      for (const line of lines) {
        const fileCommentMatch = line.match(/(?:(?:\/\/|#|--|\/\*))\s*(?:file(?:path)?:?|filename:?)\s*([a-zA-Z0-9_\-./\\]+)/i);
        if (fileCommentMatch) {
          detectedName = fileCommentMatch[1].trim();
          break;
        }
      }
    }

    // Determine filename
    let filename = detectedName;
    if (!filename) {
      const ext = EXTENSION_MAP[lang] || (lang ? lang : "txt");
      filename = `snippet-${index}.${ext}`;
    }

    const cleanName = sanitizeFilename(filename, `snippet-${index}.txt`);
    // Avoid duplicates of identical code
    if (!seenFilenames.has(cleanName)) {
      seenFilenames.add(cleanName);
      artifacts.push({
        id: `art-${index++}`,
        filename: cleanName,
        language: lang || inferLanguage(cleanName),
        content: content.replace(/\r\n/g, "\n"),
        size: content.length,
        type: "code-block",
      });
    }
  }

  return artifacts;
}

function pathHasExtension(p) {
  const base = p.split("/").pop() || "";
  return base.includes(".") && !base.startsWith(".");
}

function inferLanguage(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  for (const [lang, mapExt] of Object.entries(EXTENSION_MAP)) {
    if (mapExt === ext) return lang;
  }
  return ext || "plaintext";
}

function sanitizeFilename(name, fallback) {
  if (!name) return fallback;
  // Clean quotes and unsafe relative traversal
  let clean = name.replace(/["'<>|:*?]/g, "").trim();
  clean = clean.replace(/^(?:\.\.[\/\\])+/, "").replace(/^[\/\\]+/, "");
  return clean || fallback;
}
