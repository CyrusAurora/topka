// The built-in demo model: a deterministic stand-in for a chat model, so a fresh install can walk the
// model-backed flows (对话 creating a project, phone-card copy) offline and at no cost. It never reads
// the network and never pretends to understand anything: questions are canned, the summary repeats the
// reader's words, sources are picked by word overlap, and every answer is labelled as demo output.
//
// On when LLM_DEMO=true, or when LLM_DEMO is unset, DEMO_SEED=true and no real model is configured
// (MODEL_CALLS_ENABLED with a key, a free chain or a plugin route). LLM_DEMO=false keeps it off.
// Only the purposes in DEMO_PURPOSES use it: collected articles are never scored or summarised by it,
// so no invented analysis reaches real content.
import { config, credential } from "../config.ts";
import { interactiveChatRoutes } from "./chat-routes.ts";
import { chainOn } from "./free-chain.ts";
import { freeGuardOn } from "./free-models.ts";
import type { ChatRouteCompleteInput, ChatRouteCompletion } from "./chat-routes.ts";

export const DEMO_MODEL_ID = "topka-demo";
/** 对话 (intake and the change/delete assistant) and the phone-card copy. */
export const DEMO_PURPOSES: ReadonlySet<string> = new Set(["project_assistant", "mobile_card"]);

const truthy = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";

/** A real model can answer on this instance (the order chatJson tries). */
export function realModelConfigured(): boolean {
  if (!config.modelCallsEnabled) return false;
  if (interactiveChatRoutes().some((r) => r.enabled() && !!r.model())) return true;
  if (chainOn()) return true;
  const base = credential("models", "LLM_BASE_URL");
  const key = credential("models", "LLM_API_KEY");
  if (freeGuardOn("llm") && base && key) return true;
  return !!(base && key && (process.env.LLM_MODEL ?? "").trim());
}

export function demoModelOn(): boolean {
  const flag = (process.env.LLM_DEMO ?? "").trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return truthy(process.env.DEMO_SEED) && !realModelConfigured();
}

// ---- helpers -------------------------------------------------------------------------------------

const CJK = /[\u3400-\u9fff]/;
/** The reader's language: the prompt's 【回答语言】 line when present, else the script of what they typed. */
const langFor = (user: string, said: string) => (/【回答语言】en/.test(user) ? EN : /【回答语言】zh/.test(user) ? ZH : CJK.test(said) ? ZH : EN);
const section = (text: string, label: string) => {
  const at = text.indexOf(`【${label}】`);
  if (at < 0) return "";
  const rest = text.slice(at + label.length + 2);
  const end = rest.search(/\n\n【/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
};
const plain = (s: string) => s.trim();
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Width on the card in Chinese characters (Latin and ASCII count half), as card-copy.ts measures. */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\x20-\x7e]/.test(ch) ? 0.5 : 1;
  return Math.ceil(w);
}
function fit(s: string, limit: number): string {
  if (width(s) <= limit) return s;
  let out = "";
  for (const ch of s) {
    if (width(`${out}${ch}…`) > limit) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** The thing to track, from a sentence like 「帮我跟踪人形机器人」 or "Track humanoid robots for me". */
export function demoTarget(ask: string): string {
  const t = plain(ask)
    .replace(/^(请|麻烦)?(帮我|替我|给我)?(跟踪|追踪|盯着?|关注|看看|监控)(一下)?/, "")
    .replace(/^(please\s+)?(help me\s+)?(track|follow|watch|monitor|keep an eye on)\s+/i, "")
    .replace(/\s+for me\b.*$/i, "")
    .replace(/[。.！!？?]+$/, "")
    .trim();
  return t || plain(ask);
}

interface CatalogEntry { id: string; name: string; on: boolean }
function catalogOf(text: string): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split("｜");
    if (parts.length !== 3 || !parts[0] || /\s/.test(parts[0])) continue;
    out.push({ id: parts[0].trim(), name: plain(parts[1]!), on: parts[2]!.includes("采集中") });
  }
  return out;
}
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]{3,}|[\u3400-\u9fff]{2}/g) ?? [];
// A few fixed cross-language hints, so 「人形机器人」 finds "Humanoid" sources: lookup, not understanding.
const HINTS: Array<[RegExp, string[]]> = [
  [/机器人|人形|具身|robot|humanoid|embodied/i, ["robot", "robotics", "humanoid", "embodied", "lerobot", "isaac", "unitree", "agibot", "genesis", "mujoco", "openpi"]],
  [/模型|大模型|llm|model/i, ["openai", "deepmind", "mistral", "qwen", "deepseek", "hugging", "transformers", "llama", "vllm", "sglang", "ollama"]],
  [/芯片|半导体|算力|gpu|chip|semiconductor|compute/i, ["nvidia", "amd", "rocm", "triton", "semiconductor", "semianalysis", "eetimes", "servethehome"]],
  [/开源|开发|编程|open source|developer|github/i, ["github", "node", "rust", "deno", "react", "kubernetes", "cloudflare", "infoq", "code"]],
];
/** Up to `max` catalog ids whose names share a word with the ask; switched-on sources first. */
function pickSources(catalog: CatalogEntry[], ask: string, max = 8): string[] {
  const want = new Set([...words(ask), ...HINTS.filter(([re]) => re.test(ask)).flatMap(([, w]) => w)]);
  const hit = catalog.filter((c) => words(c.name).some((w) => want.has(w)));
  return [...hit.filter((c) => c.on), ...hit.filter((c) => !c.on)].slice(0, max).map((c) => c.id);
}

// ---- answers -------------------------------------------------------------------------------------

const ZH = {
  label: "演示模型",
  q1: { update: "演示模型：问题是固定的，不代表真实模型的理解。", question: "你最想看它哪方面的变化？", options: ["技术进展", "产品发布", "融资与商业", "政策与监管"] },
  q2: { question: "有没有不想看的内容？", options: ["营销稿", "融资消息", "传闻", "都想看"] },
  everything: "都想看",
  question: (target: string) => `${target}接下来会有哪些重要变化？`,
  problem: (target: string, picks: string) => `想持续知道${target}的重要变化${picks ? `，重点是${picks}` : ""}。`,
  judgement: (target: string) => `演示模型的固定回答：先把${target}的官方发布和主要媒体报道放进一个项目，变化出现时再看。`,
  reasons: ["信源按名称和你的话里共同的词挑选，不是真实判断"],
  next: "接上真实模型后，这一步会给出真正的分析。",
  reply: "演示模型：我按固定规则整理了下面的提议，确认后才会生效。",
  replyHelp: "演示模型：我可以帮你新建、修改或删除跟踪项目，直接说就行。",
  why: "演示模型写的，不是真实分析",
};
const EN = {
  label: "Demo model",
  q1: { update: "Demo model: these questions are canned, not a real model's reading.", question: "Which kind of change matters most to you?", options: ["Technical progress", "Product launches", "Funding and business", "Policy and regulation"] },
  q2: { question: "Anything you would rather not see?", options: ["Marketing posts", "Funding news", "Rumours", "Show me everything"] },
  everything: "Show me everything",
  question: (target: string) => `What important changes will happen in ${target}?`,
  problem: (target: string, picks: string) => `Keep up with important changes in ${target}${picks ? `, mainly ${picks}` : ""}.`,
  judgement: (target: string) => `A canned demo answer: put the official releases and main coverage of ${target} into one project, and look again when something changes.`,
  reasons: ["Sources were picked by words shared with what you typed, not by judgement"],
  next: "With a real model connected, this step gives a real analysis.",
  reply: "Demo model: I put the proposal below together by fixed rules. Nothing changes until you confirm.",
  replyHelp: "Demo model: I can create, change or delete tracking projects. Just say which.",
  why: "Written by the demo model, not real analysis",
};

/** One intake turn (industry/prompts/socratic-intake.md's JSON) for the mode in the user message. */
function intakeAnswer(user: string): Record<string, unknown> {
  const mode = /【模式】(\w+)/.exec(user)?.[1] ?? "ask";
  const ask = plain(section(user, "用户最初的需求"));
  const L = langFor(user, ask);
  const target = clip(demoTarget(ask), 16);
  const asked = Number(/已问 (\d+)\//.exec(user)?.[1] ?? 0);
  const answers = [...section(user, "已问过的问题和回答").matchAll(/A\d+：(.+)/g)].map((m) => plain(m[1]!)).filter((a) => a && a !== "（未答）");
  const focus = answers.slice(0, 1);
  const exclusions = answers.slice(1, 2).filter((a) => a !== L.everything && a !== ZH.everything && a !== EN.everything);
  const picks = focus.join(L === ZH ? "、" : ", ");
  if (mode === "ask" && asked === 0) return { kind: "question", ...L.q1 };
  if (mode === "ask" && asked === 1) return { kind: "question", update: "", ...L.q2 };
  if (mode === "ask" || mode === "summarize") {
    return {
      kind: "summary", update: "",
      summary: { ask, problem: L.problem(target, picks), facts: [], assumptions: [], variables: focus, question: L.question(target) },
    };
  }
  const catalog = catalogOf(section(user, "信源目录（id｜名称｜状态）"));
  return {
    kind: "card",
    card: { target, purpose: L.question(target), focus, exclusions, sourceIds: pickSources(catalog, `${ask} ${target}`), variables: focus },
    judgement: L.judgement(target), reasons: L.reasons, next: L.next,
  };
}

/** The change/delete assistant (industry/prompts/project-assistant.md's JSON). */
function assistantAnswer(system: string, user: string): Record<string, unknown> {
  const said = plain(section(user, "用户这次说") || user);
  const L = langFor(user, said);
  const projects = [...system.matchAll(/^(#\d+) 对象：([^｜\n]+)/gm)].map((m) => ({ ref: m[1]!, target: plain(m[2]!) }));
  // Only a project the sentence names (or the only one there is): never a guess between several.
  const named = projects.find((p) => said.includes(p.target)) ?? (projects.length === 1 ? projects[0]! : null);
  if (/^(删除|删掉|删了|移除|delete|remove)/i.test(said) || /(删掉|删除|移除)(这个|那个|我的)?(项目|跟踪)/.test(said)) {
    return named ? { action: "propose_delete", projectRef: named.ref, reply: L.reply, proposal: null } : { action: "reply", reply: L.replyHelp };
  }
  if (/^(修改|改一下|改改|change|update|edit)/i.test(said) && named) {
    const focus = said.replace(/^(修改|改一下|改改|change|update|edit)/i, "").replace(/^[^：:]*[：:]/, "").trim();
    return { action: "propose_update", projectRef: named.ref, reply: L.reply, proposal: { target: named.target, purpose: "", focus: clip(focus, 120), exclusions: "", sourceIds: [] } };
  }
  const catalog = catalogOf(system);
  const target = clip(demoTarget(said), 40);
  if (!target) return { action: "reply", reply: L.replyHelp };
  return { action: "propose_create", projectRef: null, reply: L.reply, proposal: { target, purpose: L.question(target), focus: "", exclusions: "", sourceIds: pickSources(catalog, said) } };
}

/** Phone-card copy (card-copy.ts / issue-copy.ts JSON): the existing title and summary, cut to fit. */
function cardAnswer(system: string, user: string): Record<string, unknown> {
  const en = /## 输出语言\s*\n+\s*en\b/.test(system);
  const L = en ? EN : ZH;
  if (user.startsWith("【重写】")) {
    const fixes = [...user.matchAll(/id=([^｜\n]+)｜字段 (\w+)｜现在「([^」]*)」｜宽度 [\d.]+，(至少|上限) ([\d.]+)/g)].map((m) => ({
      id: m[1]!, field: m[2]!, text: m[4] === "上限" ? fit(m[3]!, Number(m[5])) : `${m[3]!} ${L.why}`,
    }));
    return { fixes };
  }
  const blocks = user.split(/\n\n(?=【内容 id=)/);
  const cards = blocks.map((b) => {
    const id = /【内容 id=([^】]+)】/.exec(b)?.[1] ?? "";
    const title = plain(/现有标题：([^｜\n]+)/.exec(b)?.[1] ?? "");
    const summary = plain(/现有摘要：(.+)/.exec(b)?.[1] ?? title);
    const source = plain(/来源：([^｜\n]+)/.exec(b)?.[1] ?? "");
    const lead = summary.split(/(?<=[。.!！?？])\s*/)[0] ?? summary;
    return {
      id,
      // card-copy.ts (title / lead / why within CARD_LIMITS)
      title: fit(title, 20), lead: fit(lead, 75), why: fit(L.why, 40),
      // issue-copy.ts (title_a / core_a / summary / tag / source; budgets are re-checked there)
      title_a: fit(title, 16), title_b: "", core_a: fit(lead, 30), core_b: "", summary: clip(summary, 160), tag: "demo", source: fit(source, 12),
    };
  }).filter((c) => c.id);
  return { cards };
}

/** The demo answer for one call, as the model's text. */
export function demoAnswer(input: { purpose: string; system: string; user: string }): string {
  if (input.purpose === "mobile_card") return JSON.stringify(cardAnswer(input.system, input.user));
  if (input.user.includes("【模式】")) return JSON.stringify(intakeAnswer(input.user));
  return JSON.stringify(assistantAnswer(input.system, input.user));
}

/** A chat-route style completion for chatJson's plugin transport. */
export function demoComplete(purpose: string) {
  return async (input: ChatRouteCompleteInput): Promise<ChatRouteCompletion> => {
    const system = input.messages.find((m) => m.role === "system")?.content ?? "";
    const user = input.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    return { text: demoAnswer({ purpose, system, user }), model: DEMO_MODEL_ID, provider: "demo", usage: { cost: 0 } };
  };
}
