import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extractArtifactsFromText } from "../web/shared/artifacts.js";

test("extractArtifactsFromText extracts code fences with inline filenames", () => {
  const text = `
Here is the implementation:

\`\`\`typescript filepath=src/core/scheduler.ts
export class TaskScheduler {
  run() { return true; }
}
\`\`\`

And the test file:

\`\`\`javascript filename="test/scheduler.test.js"
import { TaskScheduler } from "../src/core/scheduler.ts";
\`\`\`
`;

  const artifacts = extractArtifactsFromText(text);
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].filename, "src/core/scheduler.ts");
  assert.equal(artifacts[0].language, "typescript");
  assert.ok(artifacts[0].content.includes("class TaskScheduler"));
  assert.equal(artifacts[1].filename, "test/scheduler.test.js");
  assert.equal(artifacts[1].language, "javascript");
});

test("extractArtifactsFromText extracts filenames from leading comments or headers", () => {
  const text = `
### src/styles/theme.css
\`\`\`css
:root {
  --primary: #4ade80;
}
\`\`\`

Next script:
\`\`\`python
# filepath: scripts/deploy.py
import sys
print("deploying")
\`\`\`
`;

  const artifacts = extractArtifactsFromText(text);
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].filename, "src/styles/theme.css");
  assert.equal(artifacts[0].language, "css");
  assert.equal(artifacts[1].filename, "scripts/deploy.py");
  assert.equal(artifacts[1].language, "python");
});

test("extractArtifactsFromText parses Claude artifact containers", () => {
  const text = `
<antArtifact identifier="data-model" type="application/vnd.ant.code" language="typescript" title="models/User.ts">
export interface User {
  id: string;
  name: string;
}
</antArtifact>
`;

  const artifacts = extractArtifactsFromText(text);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].filename, "models/User.ts");
  assert.equal(artifacts[0].language, "typescript");
  assert.equal(artifacts[0].type, "claude-artifact");
  assert.ok(artifacts[0].content.includes("interface User"));
});

test("extractArtifactsFromText handles unlabelled code and sanitizes traversal", () => {
  const text = `
\`\`\`rust
// filepath: ../../../secret.rs
fn main() { println!("safe"); }
\`\`\`

\`\`\`json
{ "name": "melon" }
\`\`\`
`;

  const artifacts = extractArtifactsFromText(text);
  assert.equal(artifacts.length, 2);
  // Traversal removed
  assert.equal(artifacts[0].filename, "secret.rs");
  assert.equal(artifacts[0].language, "rust");
  // Default fallback for unlabelled json
  assert.equal(artifacts[1].filename, "snippet-2.json");
  assert.equal(artifacts[1].language, "json");
});

test("exporting harvested artifacts writes files safely to target directory", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "melon-art-test-"));
  const sampleFiles = [
    { filename: "src/utils.ts", content: "export const answer = 42;" },
    { filename: "docs/readme.md", content: "# Architecture" },
  ];

  for (const f of sampleFiles) {
    const dest = path.join(tmpDir, f.filename);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content, "utf8");
  }

  const writtenUtil = await fs.readFile(path.join(tmpDir, "src/utils.ts"), "utf8");
  const writtenDoc = await fs.readFile(path.join(tmpDir, "docs/readme.md"), "utf8");
  assert.equal(writtenUtil, "export const answer = 42;");
  assert.equal(writtenDoc, "# Architecture");

  await fs.rm(tmpDir, { recursive: true, force: true });
});
