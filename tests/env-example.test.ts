// Every environment variable the apps and the backend read by name is listed in .env.example (set or
// commented out), so a self-hoster sees the whole surface in one file. Static: reads source text only.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
/** Process plumbing, not configuration. */
const NOT_CONFIG = new Set(["PATH", "HOME", "TMPDIR", "CI"]);

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx|cjs|mjs)$/.test(f) && !/(^|\/)(node_modules|tests|build)\//.test(f) && !f.endsWith(".test.ts"))
    .map((f) => join(root, dir, f));
}

test(".env.example lists every variable apps/ and packages/ read by name", () => {
  const read = new Set<string>();
  for (const file of [...sources("apps"), ...sources("packages")]) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) read.add(m[1]);
    for (const m of text.matchAll(/projectEnv\(\s*"([A-Z][A-Z0-9_]+)"/g)) read.add(`TOPKA_${m[1]}`);
  }
  const example = readFileSync(join(root, ".env.example"), "utf8");
  const listed = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const missing = [...read].filter((v) => !NOT_CONFIG.has(v) && !listed.has(v)).sort();
  assert.deepEqual(missing, [], `add these to .env.example (and docs/configuration.md): ${missing.join(", ")}`);
});
