// Reader chrome catalog (ADR 0004 D): zh-CN matches current Chinese labels; en differs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeStrings, navStrings, normalizeUiLocale } from "../app/lib/i18n.ts";

test("zh-CN nav strings match current Chinese labels", () => {
  const s = navStrings("zh-CN");
  assert.deepEqual([s.today, s.archive, s.chat, s.settings, s.about, s.feedback], ["今日", "往期", "对话", "设置", "关于", "反馈"]);
});

test("en nav strings differ (Today etc.)", () => {
  const s = navStrings("en");
  assert.deepEqual([s.today, s.archive, s.chat, s.settings, s.about, s.feedback], ["Today", "Archive", "Chat", "Settings", "About", "Feedback"]);
});

test("theme + skip + error chrome: en differs, zh-CN is Chinese", () => {
  const zh = chromeStrings("zh-CN");
  const en = chromeStrings("en");
  assert.deepEqual([zh.dark, zh.light, zh.system], ["深色", "浅色", "跟随系统"]);
  assert.deepEqual([en.dark, en.light, en.system], ["Dark", "Light", "System"]);
  assert.equal(zh.backToToday, "回到今日");
  assert.equal(en.backToToday, "Back to Today");
  assert.equal(zh.skipToMain, "跳到正文");
  assert.equal(en.skipToMain, "Skip to content");
  assert.equal(zh.loginButton, "登录");
  assert.equal(en.loginTitle, "Sign in");
  assert.equal(zh.settingsTitle, "设置");
  assert.equal(en.settingsTitle, "Settings");
  assert.equal(normalizeUiLocale("en"), "en");
  assert.equal(normalizeUiLocale("junk"), "zh-CN");
});

// ---------------------------------------------------------------------------------------------
// The whole dictionary: same keys in every locale, no Chinese left in the English UI's source, and
// the Chinese copy itself unchanged by moving it into the dictionaries.
// ---------------------------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { messages } from "../app/lib/i18n.ts";
import { appFiles, CJK, piecesOf, scan } from "./cjk-scan.ts";

/** path → "string" | "function/<arity>" | "array/<length>" for every leaf. */
function shapeOf(value: unknown, path = "", out: Record<string, string> = {}): Record<string, string> {
  if (typeof value === "string") out[path] = "string";
  else if (typeof value === "function") out[path] = `function/${value.length}`;
  else if (Array.isArray(value)) {
    out[path] = `array/${value.length}`;
    value.forEach((v, i) => shapeOf(v, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) shapeOf(v, path ? `${path}.${k}` : k, out);
  else out[path] = typeof value;
  return out;
}

test("zh-CN and en dictionaries have exactly the same keys, and the same kind of value under each", () => {
  const zh = shapeOf(messages("zh-CN"));
  const en = shapeOf(messages("en"));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), "same key set");
  assert.deepEqual(en, zh, "a string where Chinese has a string, a function of the same arity where it has a function");
});

test("every English string is English (only the language switch names Chinese in Chinese)", () => {
  const leaks: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") { if (CJK.test(v) && !path.endsWith(".localeZh")) leaks.push(`${path}: ${v}`); }
    else if (typeof v === "function") {
      // Every argument kind a message takes (counts, names, lists, flags), so each branch is seen.
      let called = 0;
      for (const arg of [0, 1, 2, "x", ["a", "b"], true, false]) {
        let sample: unknown;
        try { sample = (v as (...a: unknown[]) => unknown)(...Array.from({ length: v.length }, () => arg)); } catch { continue; }
        called++;
        if (typeof sample === "string" && CJK.test(sample)) leaks.push(`${path}(${JSON.stringify(arg)}): ${sample}`);
      }
      if (!called) leaks.push(`${path}(): throws for every sample argument`);
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(messages("en"), "en");
  assert.deepEqual(leaks, []);
});

test("no Chinese text in the web app's source outside the zh dictionaries (comments and regexes aside)", () => {
  const hits = scan().map((h) => `${h.file}:${h.line} ${h.text}`);
  assert.deepEqual(hits, [], `move these into app/lib/locales/ (or mark data-derived literals i18n-data):\n${hits.join("\n")}`);
});

// Deliberate changes to the Chinese copy made together with the move (old piece → why).
const ZH_CHANGED: Record<string, string> = {};

test("the Chinese copy is unchanged: every Chinese piece the UI had is still in the source", () => {
  const before: string[] = JSON.parse(readFileSync(new URL("./fixtures/zh-CN-copy.json", import.meta.url), "utf8"));
  const now = new Set(appFiles().flatMap(piecesOf));
  const lost = before.filter((p) => !now.has(p) && !(p in ZH_CHANGED));
  assert.deepEqual(lost, [], "a Chinese string disappeared or changed; restore it, or list it in ZH_CHANGED with the reason");
});

test("pages never draw from the Chinese dictionary directly (only through the page's locale)", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(import.meta.dirname, "../app");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "locales") walk(p); }
      else if (/\.(ts|tsx)$/.test(name) && !p.endsWith(join("lib", "i18n.ts"))) files.push(p);
    }
  };
  walk(root);
  const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  // A Chinese constant may be exported for tests, but no app code may render it.
  const zhConsts: string[] = [];
  for (const src of sources.values()) for (const m of src.matchAll(/export const (\w+)(?::[^=]+)? = zh\b/g)) zhConsts.push(m[1]!);
  const leaks: string[] = [];
  for (const [file, src] of sources) {
    for (const name of zhConsts) {
      const uses = src.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
      const defs = src.match(new RegExp(`export const ${name}\\b`, "g"))?.length ?? 0;
      if (uses > defs) leaks.push(`${file.slice(root.length + 1)} uses ${name}`);
    }
    if (/\b(messages|chromeStrings|navStrings)\("zh-CN"\)/.test(src)) leaks.push(`${file.slice(root.length + 1)} asks for the Chinese strings by name`);
    if (file.includes(`${join("app", "routes")}`) && /import \{[^}]*\bzh\b[^}]*\} from "[^"]*locales\//.test(src)) leaks.push(`${file.slice(root.length + 1)} imports a zh dictionary`);
  }
  assert.deepEqual(leaks, []);
});

test("every model capability the admin lists has a name in both languages (the Chinese one is the backend's)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { zh, en } = await import("../app/lib/locales/adminConfig.ts");
  const src = readFileSync(join(import.meta.dirname, "../../../packages/backend/src/editorial/models.ts"), "utf8");
  const backend = Object.fromEntries([...src.matchAll(/^ {2}(\w+): \{ label: "([^"]+)"/gm)].map((m) => [m[1]!, m[2]!]));
  assert.ok(Object.keys(backend).length >= 10, "read the backend capability table");
  assert.deepEqual(zh.models.capabilities, backend);
  assert.deepEqual(Object.keys(en.models.capabilities).sort(), Object.keys(backend).sort());
});
