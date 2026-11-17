// Doc code blocks (scripts/doc-blocks.ts, docs/doc-blocks.md): the marker grammar, block extraction,
// the static check (unmarked blocks, bad JSON, excerpt drift, references to paths, npm scripts and
// compose services that do not exist), the run-time rewrites, suite order, and the repository's own
// docs passing the check.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { blocksOf, checkBlocks, missingReferences, parseMarker, rewrite, suiteBlocks, type Block } from "../scripts/doc-blocks.ts";

const FENCE = "```";

test("marker grammar", () => {
  const rows: Array<[string, unknown]> = [
    ["run quickstart", { mode: "run", suite: "quickstart", retry: 0, expect: null, exit: 0, defer: false, timeout: 900 }],
    ["run repo; retry 30; exit 2; defer; timeout 60", { mode: "run", suite: "repo", retry: 30, expect: null, exit: 2, defer: true, timeout: 60 }],
    ["skip needs a real domain; and TLS", { mode: "skip", reason: "needs a real domain; and TLS" }],
    ["excerpt industry/selection.ts", { mode: "excerpt", path: "industry/selection.ts" }],
    ["typecheck", { mode: "typecheck" }],
  ];
  for (const [text, want] of rows) assert.deepEqual(parseMarker(text), want, text);
  const expect = parseMarker('run quickstart; expect "ok":true');
  assert.ok(expect.mode === "run" && expect.expect?.test('{"ok":true}'));
  const bad: Array<[string, RegExp]> = [
    ["skip", /reason/],
    ["skip too short", /reason/],
    ["run nowhere", /unknown suite/],
    ["run repo; retry soon", /whole number/],
    ["run repo; colour red", /unknown option/],
    ["excerpt", /one path/],
    ["typecheck now", /no arguments/],
    ["execute repo", /unknown mode/],
  ];
  for (const [text, re] of bad) assert.throws(() => parseMarker(text), re, text);
});

test("blocks carry the marker on the line just above, indented fences included", () => {
  const md = [
    "# Doc", "", "<!-- doc-test: run repo -->", `${FENCE}bash`, "echo one", FENCE, "",
    "- item", "  <!-- doc-test: skip placeholder values only here -->", `  ${FENCE}sh`, "  echo two", `  ${FENCE}`, "",
    `${FENCE}json`, '{"a":1}', FENCE, "", "<!-- doc-test: run repo -->", "", `${FENCE}bash`, "echo three", FENCE,
  ].join("\n");
  const blocks = blocksOf("doc.md", md);
  assert.deepEqual(blocks.map((b) => [b.line, b.lang, b.code, b.marker?.mode ?? null]), [
    [4, "bash", "echo one", "run"],
    [10, "sh", "echo two", "skip"],
    [14, "json", '{"a":1}', null],
    [20, "bash", "echo three", null], // a blank line between marker and fence: no marker
  ]);
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "doc-blocks-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), text);
  }
  return root;
}

test("the static check finds unmarked blocks, bad JSON, excerpt drift and missing references", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { "db:migrate": "node scripts/migrate.ts" } }),
    "docker-compose.yml": "services:\n  db:\n    image: postgres\n  api:\n    image: x\n",
    "scripts/migrate.ts": "",
    "src/conf.ts": "export const C = {\n  a: 1, // one\n  b: 2,\n};\n",
  });
  try {
    const md = (lang: string, code: string, marker?: string) => [marker ? `<!-- doc-test: ${marker} -->` : "", `${FENCE}${lang}`, code, FENCE, ""].join("\n");
    const doc = [
      md("bash", "npm run db:migrate && node scripts/migrate.ts", "run repo"),
      md("bash", "echo unmarked"),
      md("ts", "const x = 1;", "run repo"),
      md("json", "{not json}"),
      md("json", "{ \"a\": 1, … }", "skip an elided example object"),
      md("ts", "  a: 1,   // the first\n  b: 3,", "excerpt src/conf.ts"),
      md("bash", "npm run nope\nnode scripts/gone.ts\ndocker compose exec web true\ndocker compose logs api db", "skip placeholder values only here"),
      md("text", "anything", "run repo"),
      md("bash", "true", "run quickstart; retry x"),
    ].join("\n");
    const problems = checkBlocks(root, blocksOf("doc.md", doc));
    assert.deepEqual(problems.map((p) => p.where), ["doc.md:7", "doc.md:12", "doc.md:17", "doc.md:27", "doc.md:33", "doc.md:33", "doc.md:33", "doc.md:41", "doc.md:46"], problems.map((p) => p.problem).join("\n"));
    assert.match(problems[0]!.problem, /without a doc-test marker/);
    assert.match(problems[1]!.problem, /only shell blocks can be run/);
    assert.match(problems[2]!.problem, /JSON does not parse/);
    assert.match(problems[3]!.problem, /excerpt line not in src\/conf\.ts: b: 3,/);
    assert.match(problems[4]!.problem, /npm script "nope"/);
    assert.match(problems[5]!.problem, /path scripts\/gone\.ts/);
    assert.match(problems[6]!.problem, /compose service "web"/);
    assert.match(problems[7]!.problem, /can only be skipped or an excerpt/);
    assert.match(problems[8]!.problem, /bad doc-test marker: retry needs a whole number/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("references: continuations, comments and workspace scripts", () => {
  const root = fixture({ "package.json": JSON.stringify({ scripts: { a: "x" } }), "scripts/x.sh": "" });
  try {
    assert.deepEqual(missingReferences("npm run a \\\n  -- --flag  # npm run b in a comment\nbash scripts/x.sh", root), []);
    assert.deepEqual(missingReferences("npm run build -w @topka/web", root), []); // a workspace's own script
    assert.deepEqual(missingReferences("cat scripts/y.sh", root), ["path scripts/y.sh"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rewrites: the public clone, init-env's port, the backup date", () => {
  const rows: Array<[string, number | null, string]> = [
    ["git clone https://github.com/CyrusAurora/topka.git && cd topka\nls", null, "true\nls"],
    ["node scripts/init-env.ts --demo", 3300, "node scripts/init-env.ts --port 127.0.0.1:3300 --demo"],
    ["node scripts/init-env.ts          # creates .env", 3300, "node scripts/init-env.ts --port 127.0.0.1:3300          # creates .env"],
    ["node scripts/init-env.ts", null, "node scripts/init-env.ts"],
    ["gzip -dc topka-YYYY-MM-DD.sql.gz", null, "gzip -dc topka-$(date +%F).sql.gz"],
  ];
  for (const [code, port, want] of rows) assert.equal(rewrite(code, port), want, code);
});

test("suite order: listed documents first, deferred blocks last in their document", () => {
  const b = (file: string, line: number, defer = false): Block => ({
    file, line, lang: "bash", code: "", markerError: null,
    marker: { mode: "run", suite: "quickstart", retry: 0, expect: null, exit: 0, defer, timeout: 1 },
  });
  const order = suiteBlocks([b("docs/zz.md", 1), b("CONTRIBUTING.md", 5), b("README.md", 30, true), b("README.md", 40), b("README.md", 10), b("docs/aa.md", 2)], "quickstart");
  assert.deepEqual(order.map((x) => `${x.file}:${x.line}`), ["README.md:10", "README.md:40", "README.md:30", "CONTRIBUTING.md:5", "docs/aa.md:2", "docs/zz.md:1"]);
  assert.deepEqual(suiteBlocks([b("README.md", 1)], "repo"), []);
});

test("the repository's own docs pass the static check", () => {
  const root = path.resolve(import.meta.dirname, "..");
  assert.deepEqual(checkBlocks(root), []);
});
