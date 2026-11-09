// The Socratic intake (industry/prompts/socratic-intake.md) as a pure state machine, shared by the server
// (web API, and turns an external sync client hands over) and any edge function that runs a turn on its own
// model so a chat never waits for the server. No I/O here: callers load the prompt, call a model, and store
// the session.
//
// A session walks asking → confirm → card → done. Each turn: planTurn(session, text) says which mode the
// model runs in (or answers locally), buildUser renders the model's input, applyAnswer turns the model's
// JSON into the next session and the message the user sees. At most MAX_QUESTIONS questions; then the
// model must summarize. Nothing here creates anything: a card is a proposal the user confirms.
"use strict";

const VERSION = 1;
const MAX_QUESTIONS = 7;
const SESSION_TTL_MS = 6 * 3600_000;
const OTHER = "其他";
const CONFIRM_YES = "对，就按这个";
const CONFIRM_NO = "不太对，我来改";
const RESTART = "重新开始";

const clip = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const list = (v, n, max) => (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(/[、,，;；\n]/) : [])
  .map((s) => clip(s, max)).filter(Boolean).filter((s, i, a) => a.indexOf(s) === i).slice(0, n);

/** "manage" sends the sentence to the legacy create/update/delete assistant; everything else is intake. */
function routeOf(text) {
  const t = clip(text, 500);
  if (/^(修改|改一下|改改|删除|删掉|删了|移除|停掉|暂停|恢复)/.test(t)) return "manage";
  if (/(删掉|删除|移除)(这个|那个|我的)?(项目|跟踪)/.test(t)) return "manage";
  return "intake";
}

function fresh(ask, now) {
  return { v: VERSION, stage: "asking", ask: clip(ask, 500), turns: [], asked: 0, analysis: null, summary: null, corrections: [], card: null, startedAt: now, updatedAt: now };
}

function live(session, now) {
  return !!session && session.v === VERSION && session.stage !== "done" && now - (session.updatedAt || 0) < SESSION_TTL_MS;
}

const isYes = (t) => t === CONFIRM_YES || /^(对|是的?|没错|就是|确认|可以|好的?|行|嗯|ok|OK|yes)[。！!，,\s]*$/.test(t) || /^对[，,]?(就)?按(这个|这样)/.test(t);

/**
 * What this turn does. mode: "ask" (next question or an early summary), "summarize", "card", or "local"
 * (answered without a model: `reply`). `session` is the state after taking the user's text in.
 */
function planTurn(session, text, now) {
  const t = clip(text, 500);
  if (t === RESTART || /^(重新开始|重来|换个话题|从头来)$/.test(t)) {
    return { mode: "local", session: null, reply: { kind: "note", text: "好，重新开始。你想跟踪或弄清楚什么？" } };
  }
  if (!live(session, now)) return { mode: "ask", session: fresh(t, now) };
  const s = JSON.parse(JSON.stringify(session));
  s.updatedAt = now;
  if (s.stage === "asking") {
    const last = s.turns[s.turns.length - 1];
    if (last && last.a == null) last.a = t;
    else s.turns.push({ q: "（补充）", options: [], a: t });
    return { mode: s.asked >= MAX_QUESTIONS ? "summarize" : "ask", session: s };
  }
  if (s.stage === "confirm") {
    if (isYes(t)) return { mode: "card", session: s };
    if (t === CONFIRM_NO) return { mode: "local", session: s, reply: { kind: "note", text: "哪里不对？直接说要改的地方，比如对象、时间范围或你真正关心的结果。" } };
    s.corrections.push(t);
    return { mode: "summarize", session: s };
  }
  // stage card: anything said after the card is a change to it.
  s.corrections.push(t);
  return { mode: "card", session: s };
}

function renderTurns(s) {
  if (!s.turns.length) return "（还没问过）";
  return s.turns.map((x, i) => `Q${i + 1}：${x.q}${x.options && x.options.length ? `（选项：${x.options.join(" / ")}）` : ""}\nA${i + 1}：${x.a == null ? "（未答）" : x.a}`).join("\n");
}

/** The model's user message. ctx: { projects: string[], catalog?: Array<{id,name,enabled}> }. */
function buildUser(mode, s, ctx) {
  const c = ctx || {};
  const parts = [
    `【模式】${mode}（已问 ${s.asked}/${MAX_QUESTIONS} 问${mode === "ask" && s.asked >= MAX_QUESTIONS - 1 ? "，这是最后一次可以提问的机会，能整理就直接整理" : ""}）`,
    `【用户最初的需求】\n${s.ask}`,
    `【已问过的问题和回答】\n${renderTurns(s)}`,
  ];
  if (s.analysis) parts.push(`【你上一轮的内部笔记】\n${JSON.stringify(s.analysis)}`);
  if (s.summary) parts.push(`【已整理的问题】\n${JSON.stringify(s.summary)}`);
  if (s.corrections.length) parts.push(`【用户的修正，按顺序】\n${s.corrections.map((x) => `- ${x}`).join("\n")}`);
  parts.push(`【用户现有的跟踪项目】\n${c.projects && c.projects.length ? c.projects.slice(0, 20).map((p) => `- ${p}`).join("\n") : "（没有）"}`);
  if (mode === "card") {
    const cat = (c.catalog || []).slice(0, 200);
    parts.push(`【信源目录（id｜名称｜状态）】\n${cat.length ? cat.map((x) => `${x.id}｜${x.name}｜${x.enabled ? "采集中" : "可用"}`).join("\n") : "（目录暂时拿不到，sourceIds 给空数组）"}`);
  }
  const want = mode === "ask" ? "输出 question；信息已够就输出 summary。" : mode === "summarize" ? "输出 summary。" : "输出 card。";
  parts.push(`【这次要做的】${want}只返回 JSON。`);
  return parts.join("\n\n");
}

/** The first {...} in a model's text, parsed; null when there is none. */
function parseJson(text) {
  const raw = String(text || "").replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function analysisOf(a) {
  if (!a || typeof a !== "object") return null;
  const out = {};
  for (const k of ["facts", "interpretations", "values", "goals", "vague", "assumptions"]) out[k] = list(a[k], 3, 40);
  return out;
}

/** A sentence that asks something (vs. a topic like 「宁德时代固态电池」). */
const isQuestion = (t) => /[？?]$/.test(t) || /(能否|是否|会不会|能不能|有没有|可不可以|多少|几|何时|什么时候|哪|怎样|怎么|如何|为什么|吗|呢)/.test(t);
const asQuestion = (t) => (!t ? "" : /[？?]$/.test(t) ? t : `${t.replace(/[。.！!，,；;\s]+$/, "")}？`);

// Buying/selling/position advice. The judgement says what to watch and what can go wrong, never what to trade.
const ADVICE = /(买入|卖出|抛售|加仓|减仓|建仓|清仓|平仓|抄底|止损|止盈|仓位|小仓|轻仓|重仓|满仓|半仓|定投|入手|入场|离场|目标价|买点|卖点|值得买|可以买|能买|该买|别买|不要买|不买|该卖|可买|可卖|逢低|逢高|做多|做空|配置一些|上车)/;
const NO_ADVICE_JUDGEMENT = "这不是买卖建议：先盯住下面的关键变量和风险，变化出现时再判断。";
const NO_ADVICE_NEXT = "先把关键变量和主要风险列出来，跟踪一段时间再判断。";
// An update line that would restate the ask as 「值不值得买」: the system never frames a turn as a trade.
const NO_ADVICE_UPDATE = "明白，先把要观察的对象和标准问清楚。";
function dropAdvice(text, fallback) {
  if (!text || !ADVICE.test(text)) return text;
  const kept = text.split(/(?<=[，,；;。！!])/).filter((c) => !ADVICE.test(c)).join("").replace(/[，,；;]+$/, "。");
  return kept.replace(/[，,；;。\s]/g, "").length >= 6 ? kept : fallback;
}

function summaryOf(x) {
  if (!x || typeof x !== "object") return null;
  let question = clip(x.question, 120);
  const problem = clip(x.problem, 120);
  if (!question && !problem) return null;
  // The user confirms this sentence and it becomes the project's real question, so it must ask something.
  if (!isQuestion(question)) question = isQuestion(problem) ? asQuestion(problem) : "";
  if (!question || !problem) return null;
  question = asQuestion(question);
  return { ask: clip(x.ask, 200), problem, facts: list(x.facts, 4, 60), assumptions: list(x.assumptions, 3, 60).filter((a) => !ADVICE.test(a)), variables: list(x.variables, 4, 30), question };
}

/**
 * The model's JSON for `mode` → { session, message, proposal? } or null when the answer is unusable
 * (the caller may ask once more). message: { kind, text, chips?, intake?, step? }. proposal: the create
 * payload the caller turns into a card (target/purpose/focus/exclusions/sourceIds + intake).
 * ctx.validSource(id) filters sourceIds when given.
 */
function applyAnswer(mode, session, answer, ctx) {
  const c = ctx || {};
  if (!answer || typeof answer !== "object") return null;
  const s = JSON.parse(JSON.stringify(session));
  if (answer.kind === "manage") return mode === "ask" && s.asked === 0 && !s.turns.length ? { manage: true, session: null } : null;
  const update = dropAdvice(clip(answer.update, 60), NO_ADVICE_UPDATE);

  if (mode === "ask" && answer.kind === "question") {
    if (s.asked >= MAX_QUESTIONS) return null;
    const question = clip(answer.question, 60);
    const options = list(answer.options, 4, 16).filter((o) => !/^(其他|其它|都不是|以上都不是|不确定)$/.test(o));
    if (!question || options.length < 2) return null;
    s.asked += 1;
    s.analysis = analysisOf(answer.analysis) || s.analysis;
    s.turns.push({ q: question, options, a: null });
    s.stage = "asking";
    return { session: s, message: { kind: "question", text: update ? `${update}\n${question}` : question, update, question, chips: [...options, OTHER], step: s.asked } };
  }
  if ((mode === "ask" || mode === "summarize") && answer.kind === "summary") {
    const summary = summaryOf(answer.summary);
    if (!summary) return null;
    if (!summary.ask) summary.ask = clip(s.ask, 200);
    s.summary = summary;
    s.analysis = analysisOf(answer.analysis) || s.analysis;
    s.stage = "confirm";
    const lead = update ? `${update}\n` : "";
    return { session: s, message: { kind: "confirm", text: `${lead}我把你的需求整理成这个问题：\n「${summary.question}」\n这样问对吗？`, update, chips: [CONFIRM_YES, CONFIRM_NO], intake: summary } };
  }
  if (mode === "card" && answer.kind === "card") {
    const card = answer.card || {};
    const sum = s.summary || { ask: s.ask, problem: "", facts: [], assumptions: [], variables: [], question: "" };
    const target = clip(card.target, 16);
    if (!target) return null;
    const variables = list(card.variables, 4, 30).length ? list(card.variables, 4, 30) : sum.variables;
    const focus = list(card.focus, 6, 20);
    // The key variables are what the project watches when the model named few aspects of its own.
    if (focus.length < 2) for (const v of variables) if (!focus.includes(v) && focus.length < 4) focus.push(v);
    const ids = list(card.sourceIds, 30, 120).filter((id) => (c.validSource ? c.validSource(id) : true)).slice(0, 20);
    const judgement = dropAdvice(clip(answer.judgement, 160), NO_ADVICE_JUDGEMENT);
    const reasons = list(answer.reasons, 3, 60).filter((r) => !ADVICE.test(r));
    const next = dropAdvice(clip(answer.next, 80), NO_ADVICE_NEXT);
    if (!judgement) return null;
    // 真正的问题 is the sentence the user confirmed, never the model's rewording or a topic.
    const modelPurpose = clip(card.purpose, 120);
    const realQuestion = sum.question || (isQuestion(modelPurpose) ? asQuestion(modelPurpose) : "") || (sum.problem ? asQuestion(sum.problem) : "") || `${target}接下来会有什么关键变化？`;
    const proposal = {
      target,
      purpose: realQuestion,
      focus: clip(focus.join("、"), 120),
      exclusions: clip(Array.isArray(card.exclusions) ? card.exclusions.join("、") : card.exclusions, 120),
      sourceIds: ids,
      intake: { ask: sum.ask || s.ask, problem: sum.problem, question: realQuestion, facts: sum.facts, assumptions: sum.assumptions, variables, judgement, reasons, next },
    };
    s.stage = "card";
    s.card = { proposal };
    const text = [judgement, reasons.length ? reasons.map((r) => `· ${r}`).join("\n") : "", next ? `下一步：${next}` : "", "下面是跟踪卡片，确认后才会创建。"].filter(Boolean).join("\n");
    return { session: s, message: { kind: "card", text }, proposal };
  }
  return null;
}

/** After the card is confirmed: the session is finished; the next sentence starts a new one. */
function finish(session, now) {
  if (!session) return null;
  return { ...session, stage: "done", updatedAt: now };
}

/** The reply when no model could answer (the caller keeps the session as it was before the turn). */
const UNAVAILABLE = "这次没想明白，换个说法或再发一次试试。";

module.exports = { VERSION, MAX_QUESTIONS, SESSION_TTL_MS, OTHER, CONFIRM_YES, CONFIRM_NO, RESTART, UNAVAILABLE, routeOf, planTurn, buildUser, parseJson, applyAnswer, finish, live, isYes, isQuestion, dropAdvice };
