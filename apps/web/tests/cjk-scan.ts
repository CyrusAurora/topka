// Finds Chinese (CJK) text in the web app's source that a reader could see in the English UI: string
// and template literals and JSX text, outside comments. Allowed: regular expressions (they read data,
// they do not display), the `zh` dictionary of every app/lib/locales/*.ts file, the language switch's
// own name ("简体中文" under `localeZh` in `en`), and any literal on a line marked `i18n-data` (text that
// comes from or matches data, e.g. a Chinese source suffix being stripped). Run directly to list hits:
//   node apps/web/tests/cjk-scan.ts [file ...]
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";

export const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const APP = join(import.meta.dirname, "..", "app");
/** Keys in an `en` dictionary whose value is deliberately not English. */
const EN_KEYS_ALLOWED = new Set(["localeZh"]);

export interface Hit { file: string; line: number; text: string }

export function appFiles(dir = APP): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"))
    .map((f) => join(dir, f));
}

interface Node { type: string; loc?: { start: { line: number } }; [k: string]: unknown }

/** Every CJK literal piece in the file, allowed or not (for the zh-CN copy lock). */
export function piecesOf(file: string): string[] {
  return scanFile(file, true).map((h) => h.text);
}

export function scanFile(file: string, all = false): Hit[] {
  const text = readFileSync(file, "utf8");
  const ast = parse(text, { sourceType: "module", plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"], errorRecovery: false });
  const lines = text.split("\n");
  const isLocale = /[\\/]app[\\/]lib[\\/]locales[\\/]/.test(file);
  const hits: Hit[] = [];
  // owner: the top-level `const` the node sits in; prop: the nearest object property name.
  const visit = (node: Node, owner: string | null, prop: string | null, depth: number) => {
    let value: string | null = null;
    if (node.type === "StringLiteral" || node.type === "JSXText") value = String(node.value);
    else if (node.type === "TemplateElement") value = String((node.value as { cooked?: string; raw: string }).cooked ?? (node.value as { raw: string }).raw);
    if (value !== null && CJK.test(value) && node.loc) {
      const line = node.loc.start.line;
      const marked = /i18n-data/.test(lines[line - 1] ?? "") || /i18n-data/.test(lines[line - 2] ?? "");
      const allowed = marked || (isLocale && owner === "zh") || (isLocale && owner === "en" && EN_KEYS_ALLOWED.has(prop ?? ""));
      if (all) hits.push({ file: relative(join(APP, "..", "..", ".."), file), line, text: value.replace(/\s+/g, " ").trim() });
      else if (!allowed) hits.push({ file: relative(join(APP, "..", "..", ".."), file), line, text: value.trim().slice(0, 80) });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments" || key === "extra") continue;
      const kids = Array.isArray(child) ? child : [child];
      for (const k of kids) {
        if (!k || typeof k !== "object" || typeof (k as Node).type !== "string") continue;
        const kid = k as Node;
        let o = owner;
        if (depth <= 3 && kid.type === "VariableDeclarator" && (kid.id as Node)?.type === "Identifier") o = String((kid.id as Node).name);
        let p = prop;
        if (kid.type === "ObjectProperty") {
          const k2 = kid.key as Node;
          p = k2.type === "Identifier" ? String(k2.name) : k2.type === "StringLiteral" ? String(k2.value) : null;
        }
        visit(kid, o, p, depth + 1);
      }
    }
  };
  visit(ast.program as unknown as Node, null, null, 0);
  return hits;
}

export function scan(files = appFiles()): Hit[] {
  return files.flatMap((f) => scanFile(f));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => (f.startsWith("/") ? f : join(process.cwd(), f))) : appFiles();
  const hits = scan(files);
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.text}`);
  console.log(`${hits.length} hit(s) in ${new Set(hits.map((h) => h.file)).size} file(s)`);
  process.exitCode = hits.length ? 1 : 0;
}
