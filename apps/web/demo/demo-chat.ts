// 对话 in the online demo: the server's intake turn (packages/backend/src/assistant/intake.ts) run in
// the browser against the built-in demo model. Same state machine (intake-core.cjs), same canned
// answers (demo-answers.ts), same fixed replies; the state lives in the visitor's localStorage.
import core from "../../../packages/backend/src/assistant/intake-core.cjs";
import type { IntakeSession } from "../../../packages/backend/src/assistant/intake-core.cjs";
import { demoAnswer } from "@topka/contracts/demo-answers";
import { REPLIES } from "@topka/contracts/assistant-replies";
import type { ChatMsg, ProposalCard } from "../app/features/chat/chat.ts";

export interface DemoSource { id: string; name: string }
export interface DemoProject { id: string; slug: string; target: string; purpose: string; focus: string; exclusions: string; sourceIds: string[]; createdAt: string; local: boolean }

export interface ChatState {
  session: IntakeSession | null;
  messages: ChatMsg[];
  cards: Record<string, ProposalCard>;
  seq: number;
}

export const emptyChat = (): ChatState => ({ session: null, messages: [], cards: {}, seq: 0 });

export interface TurnAnswer {
  reply: string;
  status: "done" | "failed";
  card: ProposalCard | null;
  turnId: number;
  kind?: ChatMsg["kind"];
  chips?: string[];
  intake?: ChatMsg["intake"];
  step?: number;
}

const MAX_TEXT = 500;

function cardFor(id: string, kind: ProposalCard["kind"], payload: ProposalCard["payload"], catalog: DemoSource[], before: DemoProject | null, now: number): ProposalCard {
  const names = new Map(catalog.map((s) => [s.id, s.name]));
  const ids = payload?.sourceIds ?? [];
  return {
    id, kind, projectId: before?.id ?? null,
    before: before ? { target: before.target, purpose: before.purpose, focus: before.focus, exclusions: before.exclusions, sources: before.sourceIds.length } : null,
    payload,
    // Nothing is collected in the online demo: every source stays "to be switched on".
    sources: { collecting: [], pending: ids.filter((s) => names.has(s)).map((s) => ({ id: s, name: names.get(s)! })) },
    // The page shows its own warning in its own language for any delete card.
    warning: kind === "delete" ? "delete" : null,
    createdAt: new Date(now).toISOString(),
    status: "proposed",
  };
}

/** One turn: the reader's words in, the assistant's answer out (and the new state). */
export function chatTurn(state: ChatState, text: string, ctx: { lang: "zh" | "en"; projects: DemoProject[]; catalog: DemoSource[]; now: number; clientId?: string }): { state: ChatState; answer: TurnAnswer } {
  const say = REPLIES[ctx.lang];
  const userText = text.trim().slice(0, MAX_TEXT);
  const s: ChatState = { ...state, messages: [...state.messages], cards: { ...state.cards }, seq: state.seq + 1 };
  const turnId = s.seq;
  s.messages.push({ role: "user", text: userText, clientId: ctx.clientId, createdAt: ctx.now });
  const done = (answer: Omit<TurnAnswer, "turnId">, session: IntakeSession | null): { state: ChatState; answer: TurnAnswer } => {
    s.session = session;
    if (answer.card) s.cards[answer.card.id] = answer.card;
    s.messages.push({
      role: "assistant", text: answer.reply, turnStatus: answer.status, replyTo: ctx.clientId, createdAt: ctx.now + 1, card: answer.card,
      ...(answer.kind ? { kind: answer.kind } : {}), ...(answer.chips ? { chips: answer.chips } : {}), ...(answer.intake ? { intake: answer.intake } : {}), ...(answer.step ? { step: answer.step } : {}),
    });
    return { state: s, answer: { ...answer, turnId } };
  };
  if (!userText) return done({ reply: say.emptyIntake, status: "done", card: null }, state.session);

  // "删除…" / "修改…": the change/delete assistant, on the visitor's own (local) projects only.
  if (core.routeOf(userText) === "manage") {
    const projects = ctx.projects.filter((p) => p.local);
    const system = projects.map((p, i) => `#${i + 1} 对象：${p.target}｜目的：${p.purpose}`).join("\n");
    const raw = core.parseJson(demoAnswer({ purpose: "project_assistant", system, user: `【用户这次说】\n${userText}${ctx.lang === "en" ? "\n\n【回答语言】en" : ""}` })) as { action?: string; projectRef?: string; reply?: string } | null;
    const ref = Number(String(raw?.projectRef ?? "").replace("#", "")) - 1;
    const project = projects[ref] ?? null;
    if (raw?.action === "propose_delete" && project) {
      const card = cardFor(`demo-card-${turnId}`, "delete", null, ctx.catalog, project, ctx.now);
      return done({ reply: raw.reply ?? "", status: "done", card }, state.session);
    }
    return done({ reply: raw?.reply || say.whichDelete, status: "done", card: null }, state.session);
  }

  const plan = core.planTurn(state.session, userText, ctx.now, ctx.lang === "en" ? "en" : null);
  if (plan.mode === "local") {
    const m = plan.reply;
    return done({ reply: m.text, status: "done", card: null, kind: m.kind, ...(m.chips ? { chips: m.chips } : {}) }, plan.session);
  }
  const catalog = plan.mode === "card" ? ctx.catalog.map((c) => ({ id: c.id, name: c.name, enabled: false })) : [];
  const valid = new Set(catalog.map((c) => c.id));
  const coreCtx = { projects: ctx.projects.map((p) => `${p.target}（${p.purpose}）`), catalog, validSource: (id: string) => valid.has(id) };
  const user = core.buildUser(plan.mode, plan.session, coreCtx);
  const applied = core.applyAnswer(plan.mode, plan.session, core.parseJson(demoAnswer({ purpose: "project_assistant", system: "", user })), coreCtx);
  if (!applied || applied.manage) return done({ reply: core.unavailableIn(ctx.lang === "en" ? "en" : null), status: "failed", card: null }, state.session);
  const { message, proposal } = applied;
  let session = applied.session;
  let card: ProposalCard | null = null;
  if (proposal) {
    card = cardFor(`demo-card-${turnId}`, "create", { target: proposal.target, purpose: proposal.purpose, focus: proposal.focus, exclusions: proposal.exclusions, sourceIds: proposal.sourceIds, intake: proposal.intake }, ctx.catalog, null, ctx.now);
    session = { ...session, card: { proposal, id: card.id } };
  }
  return done({
    reply: message.text, status: "done", card,
    kind: message.kind, ...(message.chips ? { chips: message.chips } : {}), ...(message.intake ? { intake: message.intake } : {}), ...(message.step ? { step: message.step } : {}),
  }, session);
}

/** 确认 / 取消 on a card. A confirmed create adds a local project; a confirmed delete removes one. */
export function decideCard(state: ChatState, cardId: string, act: "confirm" | "cancel", projects: DemoProject[], now: number): { state: ChatState; projects: DemoProject[]; body: { ok: boolean; state?: string } } {
  const card = state.cards[cardId];
  const latest = Object.values(state.cards).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id)).at(-1);
  if (!card || card.status !== "proposed") return { state, projects, body: { ok: false, state: card?.status ?? "not-found" } };
  if (latest && latest.id !== cardId) return { state, projects, body: { ok: false, state: "superseded" } };
  const status = act === "confirm" ? "applied" : "cancelled";
  const next: ChatState = { ...state, cards: { ...state.cards, [cardId]: { ...card, status } } };
  next.messages = state.messages.map((m) => (m.card?.id === cardId ? { ...m, card: { ...m.card, status } } : m));
  if (act === "cancel") return { state: next, projects, body: { ok: false, state: "cancelled" } };
  let list = projects;
  if (card.kind === "create" && card.payload) {
    const n = projects.filter((p) => p.local).length + 1;
    const p = card.payload;
    list = [...projects, { id: `local-${n}-${now}`, slug: `local-${n}-${now}`, target: p.target, purpose: p.purpose, focus: p.focus, exclusions: p.exclusions, sourceIds: p.sourceIds, createdAt: new Date(now).toISOString(), local: true }];
  } else if (card.kind === "delete" && card.projectId) {
    list = projects.filter((p) => p.id !== card.projectId);
  }
  if (next.session?.card?.id === cardId) next.session = core.finish(next.session, now);
  return { state: next, projects: list, body: { ok: true } };
}
