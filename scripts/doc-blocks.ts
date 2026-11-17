// Code blocks in the Markdown docs, checked and run so the docs cannot drift from the code
// (docs/doc-blocks.md). Every shell or TypeScript fence carries a marker on the line just above it,
// an HTML comment GitHub does not render:
//   <!-- doc-test: run <suite>[; retry <s>][; expect <regex>][; exit <code>][; defer][; timeout <s>] -->
//   <!-- doc-test: skip <reason> -->          (not runnable; the reason says why, in words)
//   <!-- doc-test: excerpt <path> -->         (every code line must appear in that file)
//   <!-- doc-test: typecheck -->              (TypeScript, compiled against the repository)
// A JSON fence must parse unless it is marked skip. Other fences (text, mermaid, sql…) are prose.
//   node scripts/doc-blocks.ts --check [--root <dir>]        markers, JSON, excerpts, referenced paths
//   node scripts/doc-blocks.ts --list [--root <dir>]
//   node scripts/doc-blocks.ts --run <suite> [--root <dir>] [--port <n>]
//   node scripts/doc-blocks.ts --typecheck [--root <dir>]
// Exit 1 on any failure, naming file:line.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { markdownFiles } from "./link-check.ts";

export const EXEC_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "ts", "typescript", "js", "javascript", "mjs"]);
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console"]);
const TS_LANGS = new Set(["ts", "typescript"]);
/** Where each suite runs (docs/doc-blocks.md): the CI job and the tree it is given. */
export const SUITES = {
  quickstart: "the exported public tree, with Docker compose (the Check workflow's docker job)",
  repo: "the checked-out repository with its CI database (the Check workflow's check job)",
  scratch: "a fresh git clone of the repository per block, thrown away afterwards (check job)",
} as const;
export type Suite = keyof typeof SUITES;
/** Run order of the documents in a suite; documents not listed follow in path order. */
const ORDER = ["README.md", "README.en.md", "docs/tutorial.md", "docs/tutorial.en.md", "docs/self-hosting.md", "docs/alerts.md", "CONTRIBUTING.md"];
/**
 * Quickstart documents a reader follows from a fresh clone: before the first block of each, the tree is
 * reset to its committed state and the compose stack (with its volumes) is removed. The others continue
 * on the site the previous document left running.
 */
const FRESH = new Set(["README.md", "README.en.md", "docs/tutorial.md", "docs/tutorial.en.md", "docs/self-hosting.md", "CONTRIBUTING.md"]);
/** Not documentation of the public tree: maintainer-only directories. */
const IGNORED_DIRS = /^(private|ops|node_modules)\//;

export type Marker =
  | { mode: "run"; suite: Suite; retry: number; expect: RegExp | null; exit: number; defer: boolean; timeout: number }
  | { mode: "skip"; reason: string }
  | { mode: "excerpt"; path: string }
  | { mode: "typecheck" };

export type Block = { file: string; line: number; lang: string; code: string; marker: Marker | null; markerError: string | null };

const MARKER = /^\s*<!--\s*doc-test:\s*(.*?)\s*-->\s*$/;

/** Parses the text inside a doc-test marker. Throws with a reason on anything it does not know. */
export function parseMarker(text: string): Marker {
  const skip = text.match(/^skip(?:\s+(.*))?$/s);
  if (skip) {
    const reason = (skip[1] ?? "").trim();
    if (reason.split(/\s+/).filter(Boolean).length < 3) throw new Error("skip needs a reason of at least three words");
    return { mode: "skip", reason };
  }
  const [head = "", ...opts] = text.split(";").map((s) => s.trim());
  const [mode = "", ...rest] = head.split(/\s+/);
  const arg = rest.join(" ");
  if (mode === "excerpt") {
    if (!arg || opts.length) throw new Error("excerpt takes one path and no options");
    return { mode: "excerpt", path: arg };
  }
  if (mode === "typecheck") {
    if (arg || opts.length) throw new Error("typecheck takes no arguments");
    return { mode: "typecheck" };
  }
  if (mode === "run") {
    if (!(arg in SUITES)) throw new Error(`unknown suite "${arg}" (known: ${Object.keys(SUITES).join(", ")})`);
    const m: Marker = { mode: "run", suite: arg as Suite, retry: 0, expect: null, exit: 0, defer: false, timeout: 900 };
    for (const o of opts) {
      const [k = "", ...v] = o.split(/\s+/);
      const val = v.join(" ");
      const num = () => {
        if (!/^\d+$/.test(val)) throw new Error(`${k} needs a whole number, got "${val}"`);
        return Number(val);
      };
      if (k === "retry") m.retry = num();
      else if (k === "timeout") m.timeout = num();
      else if (k === "exit") m.exit = num();
      else if (k === "defer" && !val) m.defer = true;
      else if (k === "expect" && val) m.expect = new RegExp(val);
      else throw new Error(`unknown option "${o}"`);
    }
    return m;
  }
  throw new Error(`unknown mode "${mode}" (run, skip, excerpt, typecheck)`);
}

/** The fenced blocks of a Markdown text, each with the marker on the line just above it. */
export function blocksOf(file: string, text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(/^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/);
    if (!open) continue;
    const [, indent = "", fence = "", lang = ""] = open;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = lines[j]!.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) break;
      body.push(lines[j]!.startsWith(indent) ? lines[j]!.slice(indent.length) : lines[j]!.trimStart());
    }
    const above = lines[i - 1]?.match(MARKER);
    let marker: Marker | null = null;
    let markerError: string | null = null;
    if (above) {
      try {
        marker = parseMarker(above[1]!);
      } catch (e) {
        markerError = (e as Error).message;
      }
    }
    out.push({ file, line: i + 1, lang: lang.toLowerCase(), code: body.join("\n"), marker, markerError });
    i = j;
  }
  return out;
}

export function docFiles(root: string): string[] {
  return markdownFiles(root).filter((f) => !IGNORED_DIRS.test(f));
}

export function allBlocks(root: string): Block[] {
  return docFiles(root).flatMap((f) => blocksOf(f, readFileSync(path.join(root, f), "utf8")));
}

const stripComment = (line: string) => line.replace(/\s+\/\/.*$/, "").replace(/^\s*\/\/.*$/, "").replace(/\s+/g, " ").trim();

/** Paths, npm scripts and compose services a shell block names that the tree does not have. */
export function missingReferences(code: string, root: string): string[] {
  const out: string[] = [];
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const compose = existsSync(path.join(root, "docker-compose.yml")) ? readFileSync(path.join(root, "docker-compose.yml"), "utf8") : "";
  const services = new Set([...compose.matchAll(/^  ([a-z][\w-]*):\s*$/gm)].map((m) => m[1]!));
  // Lines joined across "\" continuations, comments dropped.
  const text = code.replace(/\\\n/g, " ").split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
  for (const m of text.matchAll(/\bnpm run ([\w:.-]+)/g)) {
    if (!/\s-w\s/.test(text.slice(m.index, text.indexOf("\n", m.index) >>> 0)) && !pkg.scripts?.[m[1]!]) out.push(`npm script "${m[1]}"`);
  }
  for (const m of text.matchAll(/(?:^|[\s"'=])((?:\.\/)?(?:scripts|apps|packages|tests|e2e|industry|database|examples|docs)\/[\w./-]+\.(?:ts|sh|mjs|js|json|md))\b/gm)) {
    if (!existsSync(path.join(root, m[1]!))) out.push(`path ${m[1]}`);
  }
  for (const m of text.matchAll(/\bdocker compose(?: --profile \S+)? (exec|logs|stop|start|restart|port)((?: -[\w-]+)*)((?: [a-z][\w-]*)+)/g)) {
    const words = m[3]!.trim().split(/\s+/);
    // exec and port name one service then a command; logs/stop/start/restart name only services.
    for (const w of m[1] === "exec" || m[1] === "port" ? words.slice(0, 1) : words) {
      if (!services.has(w)) out.push(`compose service "${w}"`);
    }
  }
  return out;
}

export type Problem = { where: string; problem: string };

/** Everything --check reports, without running anything. */
export function checkBlocks(root: string, blocks: Block[] = allBlocks(root)): Problem[] {
  const problems: Problem[] = [];
  for (const b of blocks) {
    const where = `${b.file}:${b.line}`;
    const add = (problem: string) => problems.push({ where, problem });
    if (b.markerError) { add(`bad doc-test marker: ${b.markerError}`); continue; }
    const m = b.marker;
    if (EXEC_LANGS.has(b.lang)) {
      if (!m) { add(`\`\`\`${b.lang} block without a doc-test marker (run, skip, excerpt or typecheck)`); continue; }
      if (m.mode === "run" && !SHELL_LANGS.has(b.lang)) add("only shell blocks can be run");
      if (m.mode === "typecheck" && !TS_LANGS.has(b.lang)) add("only TypeScript blocks can be typechecked");
    } else if (m && !(m.mode === "skip" || m.mode === "excerpt")) {
      add(`a \`\`\`${b.lang || "plain"} block can only be skipped or an excerpt`);
    }
    if (b.lang === "json" && m?.mode !== "skip") {
      try { JSON.parse(b.code); } catch (e) { add(`JSON does not parse: ${(e as Error).message}`); }
    }
    if (m?.mode === "excerpt") {
      const target = path.join(root, m.path);
      if (!existsSync(target)) { add(`excerpt source ${m.path} does not exist`); continue; }
      const have = new Set(readFileSync(target, "utf8").split("\n").map(stripComment).filter(Boolean));
      for (const line of b.code.split("\n").map(stripComment).filter(Boolean)) {
        if (!have.has(line)) add(`excerpt line not in ${m.path}: ${line}`);
      }
    }
    if (SHELL_LANGS.has(b.lang)) for (const miss of missingReferences(b.code, root)) add(`names a ${miss} that does not exist`);
  }
  return problems;
}

/**
 * The text a suite actually runs. A short, fixed list, printed with every run:
 * - cloning the public repository becomes "stay here" (the tree under test is the checkout);
 * - init-env gets --port, so the docs are proven not to depend on port 3000;
 * - the backup file name placeholder YYYY-MM-DD becomes today's date, as the backup block wrote it.
 */
export function rewrite(code: string, port: number | null): string {
  let out = code.replace(/git clone https:\/\/github\.com\/[\w.-]+\/topka\.git && cd topka/g, "true");
  if (port) out = out.replace(/scripts\/init-env\.ts(?![\w.])/g, `scripts/init-env.ts --port 127.0.0.1:${port}`);
  return out.replace(/YYYY-MM-DD/g, "$(date +%F)");
}

/** The blocks of a suite in run order: documents by ORDER then path, deferred blocks last per document. */
export function suiteBlocks(blocks: Block[], suite: Suite): Block[] {
  const rank = (f: string) => (ORDER.includes(f) ? ORDER.indexOf(f) : ORDER.length);
  const mine = blocks.filter((b) => b.marker?.mode === "run" && b.marker.suite === suite);
  const deferred = (b: Block) => (b.marker?.mode === "run" && b.marker.defer ? 1 : 0);
  return [...mine].sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file) || deferred(a) - deferred(b) || a.line - b.line);
}

function runBlock(b: Block, cwd: string, port: number | null): boolean {
  const m = b.marker as Extract<Marker, { mode: "run" }>;
  const script = rewrite(b.code, port);
  const deadline = Date.now() + m.retry * 1000;
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: m.timeout * 1000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(port ? { DOC_PORT: String(port) } : {}) },
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const exitOk = r.status === m.exit;
    const expectOk = !m.expect || m.expect.test(output);
    if (exitOk && expectOk) {
      const shown = output.length > 4000 ? `${output.slice(0, 1500)}\n…\n${output.slice(-2000)}` : output;
      process.stdout.write(shown && !shown.endsWith("\n") ? `${shown}\n` : shown);
      console.log(`ok ${b.file}:${b.line}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      return true;
    }
    if (Date.now() < deadline) { spawnSync("sleep", ["3"]); continue; }
    const tail = output.slice(-6000);
    process.stdout.write(tail && !tail.endsWith("\n") ? `${tail}\n` : tail);
    const why = !exitOk ? `exit ${r.status ?? r.signal} (want ${m.exit})` : `output does not match /${m.expect!.source}/`;
    console.log(`FAIL ${b.file}:${b.line}: ${why}${attempt > 1 ? ` after ${attempt} attempts` : ""}`);
    return false;
  }
}

/** Runs one suite's blocks in order; stops at the first failure. */
export function runSuite(root: string, suite: Suite, port: number | null): boolean {
  const blocks = suiteBlocks(allBlocks(root), suite);
  console.log(`suite ${suite}: ${blocks.length} blocks in ${SUITES[suite]}`);
  console.log("rewrites: clone of the public repo -> the tree under test; init-env.ts -> init-env.ts --port 127.0.0.1:<port>; YYYY-MM-DD -> $(date +%F)");
  let lastFile = "";
  for (const b of blocks) {
    const gh = !!process.env.GITHUB_ACTIONS;
    if (suite === "quickstart" && b.file !== lastFile && FRESH.has(b.file)) {
      console.log(`fresh clone for ${b.file}: docker compose down -v, git clean -fdx, git checkout .`);
      spawnSync("docker", ["compose", "down", "-v", "--remove-orphans"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["clean", "-fdxq"], { cwd: root });
      execFileSync("git", ["checkout", "-q", "--", "."], { cwd: root });
    }
    lastFile = b.file;
    console.log(`${gh ? "::group::" : "== "}${b.file}:${b.line}`);
    let cwd = root;
    let scratch: string | null = null;
    if (suite === "scratch") {
      scratch = mkdtempSync(path.join(tmpdir(), "doc-scratch-"));
      execFileSync("git", ["clone", "-q", "--no-hardlinks", root, path.join(scratch, "topka")]);
      cwd = path.join(scratch, "topka");
    }
    const ok = runBlock(b, cwd, port);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (gh) console.log("::endgroup::");
    if (!ok) {
      if (gh) console.log(`::error file=${b.file},line=${b.line}::doc block failed (suite ${suite})`);
      return false;
    }
  }
  console.log(`suite ${suite}: all ${blocks.length} blocks passed`);
  return true;
}

/** Compiles every typecheck block against the repository (examples/tsconfig.json). */
export function typecheckBlocks(root: string): boolean {
  const blocks = allBlocks(root).filter((b) => b.marker?.mode === "typecheck");
  const dir = path.join(root, "examples", "doc-blocks");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const b of blocks) {
    const name = `${b.file.replace(/[^\w]+/g, "-")}-${b.line}.ts`;
    writeFileSync(path.join(dir, name), `// ${b.file}:${b.line}\nexport {};\n${b.code}\n`);
  }
  const r = spawnSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", path.join(root, "examples")], { cwd: root, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`${r.stdout}${r.stderr}`);
  console.log(r.status === 0 ? `typecheck: ${blocks.length} blocks compile` : "typecheck: FAILED");
  return r.status === 0;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean" }, list: { type: "boolean" }, typecheck: { type: "boolean" },
      run: { type: "string" }, root: { type: "string" }, port: { type: "string" },
    },
  });
  const root = path.resolve(values.root ?? process.cwd());
  if (values.list) {
    for (const b of allBlocks(root)) {
      const m = b.marker;
      const what = !m ? (EXEC_LANGS.has(b.lang) ? "UNMARKED" : "prose") : m.mode === "run" ? `run ${m.suite}` : m.mode === "skip" ? `skip: ${m.reason}` : m.mode === "excerpt" ? `excerpt ${m.path}` : m.mode;
      console.log(`${b.file}:${b.line}\t${b.lang || "-"}\t${what}`);
    }
  } else if (values.check) {
    const blocks = allBlocks(root);
    const problems = checkBlocks(root, blocks);
    for (const p of problems) console.log(`${p.where}: ${p.problem}`);
    const count = (f: (b: Block) => boolean) => blocks.filter(f).length;
    console.log(`doc blocks: ${blocks.length} fences in ${docFiles(root).length} files; run ${count((b) => b.marker?.mode === "run")}, skip ${count((b) => b.marker?.mode === "skip")}, excerpt ${count((b) => b.marker?.mode === "excerpt")}, typecheck ${count((b) => b.marker?.mode === "typecheck")}; ${problems.length} problem(s)`);
    process.exit(problems.length ? 1 : 0);
  } else if (values.run) {
    if (!(values.run in SUITES)) { console.error(`unknown suite ${values.run}`); process.exit(2); }
    const port = values.port ? Number(values.port) : null;
    process.exit(runSuite(root, values.run as Suite, port) ? 0 : 1);
  } else if (values.typecheck) {
    process.exit(typecheckBlocks(root) ? 0 : 1);
  } else {
    console.error("usage: doc-blocks.ts --check | --list | --typecheck | --run <suite> [--root <dir>] [--port <n>]");
    process.exit(2);
  }
}
