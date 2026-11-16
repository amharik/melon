import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "web", "vendor");

const files = [
  ["node_modules/marked/lib/marked.esm.js", "marked.esm.js"],
  ["node_modules/marked/LICENSE", "marked.LICENSE"],
  ["node_modules/dompurify/dist/purify.es.mjs", "purify.es.mjs"],
  ["node_modules/dompurify/LICENSE", "dompurify.LICENSE"],
];

await fs.mkdir(VENDOR, { recursive: true });
for (const [source, target] of files) {
  await fs.copyFile(path.join(ROOT, source), path.join(VENDOR, target));
}

console.log(`vendored markup parser files into ${path.relative(ROOT, VENDOR)}`);
