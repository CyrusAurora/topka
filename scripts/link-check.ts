// Fails on relative links in Markdown that point at nothing: every tracked *.md file is scanned and
// each relative target is resolved against that file's own directory. External schemes (http,
// https, mailto, tel), protocol-relative ("//"), root-absolute ("/…") and "#anchor"-only links are
// skipped, and "?query"/"#fragment" are stripped before resolving. Links inside code blocks are
// ignored. Prints one "path -> target" line per broken link, then a summary; exits 1 if any.
//   node scripts/link-check.ts [--root <dir>]     (--root: scan another tree, e.g. an OSS export)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".cache"]);
const LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|(?:[^()\s]|\([^()]*\))*)(?:\s+"[^"]*")?\)/g;
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;

/** The top level of the enclosing git repository, when root is inside one. */
export function gitTop(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Every Markdown file to check: git's index when root is a repository top level, else the dir tree. */
export function markdownFiles(root: string): string[] {
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (path.resolve(top) === path.resolve(root)) {
      return execFileSync("git", ["-C", root, "ls-files", "-z", "*.md"], { encoding: "utf8" }).split("\0").filter(Boolean);
    }
  } catch {
    // Not a git top level (an exported tree before its first commit, a fixture directory).
  }
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : walk(path.join(dir, e.name)))
        : e.name.endsWith(".md") ? [path.relative(root, path.join(dir, e.name))] : [],
    );
  return walk(root).sort();
}

/** The link targets a Markdown text carries, in file order, leaving out fenced code and inline code. */
export function linkTargets(text: string): string[] {
  const out: string[] = [];
  let fence = "";
  for (const line of text.split("\n")) {
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      if (!fence) fence = open[1]!;
      else if (open[1]!.startsWith(fence[0]!)) fence = "";
      continue;
    }
    if (fence) continue;
    const bare = line.replace(/`[^`]*`/g, "");
    for (const m of bare.matchAll(LINK)) out.push(m[1]!);
    const def = bare.match(DEFINITION);
    if (def) out.push(def[1]!);
  }
  return out;
}

/** The on-disk path a target names, or null when the target is not a relative link. */
export function localTarget(raw: string): string | null {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  if (!target || NOT_RELATIVE.test(target)) return null;
  target = target.split("#")[0]!.split("?")[0]!;
  if (!target) return null;
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

export interface BrokenLink {
  file: string;
  target: string;
}

/** Relative links under root that resolve to nothing, in file order. */
export function checkLinks(root: string, files = markdownFiles(root)): BrokenLink[] {
  const broken: BrokenLink[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const raw of linkTargets(text)) {
      const target = localTarget(raw);
      if (target === null) continue;
      if (!existsSync(path.resolve(root, path.dirname(file), target))) broken.push({ file, target });
    }
  }
  return broken;
}

if (import.meta.main) {
  const at = process.argv.indexOf("--root");
  const given = at > 0 ? process.argv[at + 1] : gitTop();
  if (!given) {
    console.error("link-check: not in a git repository; pass --root <dir>");
    process.exit(2);
  }
  const root = path.resolve(given);
  const files = markdownFiles(root);
  const broken = checkLinks(root, files);
  for (const b of broken) console.log(`${b.file} -> ${b.target}`);
  console.log(`checked ${files.length} files, ${broken.length} broken links`);
  process.exit(broken.length === 0 ? 0 : 1);
}
