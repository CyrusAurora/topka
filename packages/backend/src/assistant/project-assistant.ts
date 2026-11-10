// The project assistant (对话): a user's sentence becomes a proposal to create, change or
// delete a tracking project (industry/prompts/project-assistant.md). A proposal changes nothing; only
// confirmProposal applies it, and only for its owner. One model call per turn (a second only when the
// first answer is unusable), on the free-only guard and the daily model budget; a user has at most
// ASSISTANT_DAILY_TURNS model turns per UTC day. A turn that cannot run now is answered honestly and
// can be sent again later. Deleting from the project list needs no model at all (proposeDelete).
import { z } from "zod";
import { sql, type Db, type Sql } from "../db.ts";
import { chatJson, ModelOutputError } from "../providers/llm.ts";
import { BudgetExceededError, completeReceipt } from "../providers/receipts.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { createProject, ProjectRejected } from "../projects/create-project.ts";
import { listUserProjects } from "../projects/user-today.ts";
import type { IntakeBrief } from "./intake-core.cjs";
import { inert, inertLine } from "../lib/untrusted.ts";

export const ASSISTANT_PROMPT_VERSION = promptVersion("project-assistant");
export const MAX_TURN_CALLS = 2;
export const HISTORY_TURNS = 6;
const MAX_TEXT = 500;
const MAX_SOURCES = 20;

export const dailyTurnLimit = () => {
  const n = Number(process.env.ASSISTANT_DAILY_TURNS ?? 40);
  return Number.isInteger(n) && n >= 0 ? n : 40;
};

export interface ProposalPayload {
  target: string;
  purpose: string;
  focus: string;
  exclusions: string;
  sourceIds: string[];
  /** A card from the Socratic intake carries the brief behind it (shown collapsed on the card). */
  intake?: IntakeBrief;
}

export interface ProposalCard {
  id: string;
  kind: "create" | "update" | "delete";
  projectId: string | null;
  /** The project before the change (update/delete). */
  before: { target: string; purpose: string; focus: string; exclusions: string; sources: number } | null;
  payload: ProposalPayload | null;
  sources: { collecting: Array<{ id: string; name: string }>; pending: Array<{ id: string; name: string }> };
  /** delete: what goes with the project. */
  warning: string | null;
  createdAt: string | null;
  status: string;
}

export interface TurnResult {
  turnId: number;
  status: "done" | "deferred" | "failed";
  reply: string;
  card: ProposalCard | null;
  /** Intake turns: the message kind, its tappable options and the summary block (null for legacy turns). */
  meta?: TurnMeta | null;
}

export interface TurnMeta {
  kind: "question" | "confirm" | "card" | "note";
  chips?: string[];
  intake?: { ask: string; problem: string; facts: string[]; assumptions: string[]; variables: string[]; question: string };
  step?: number;
}

const AnswerSchema = z.object({
  action: z.enum(["propose_create", "propose_update", "propose_delete", "reply"]),
  projectRef: z.union([z.string(), z.number()]).nullable().optional(),
  reply: z.string().max(400).catch(""),
  proposal: z.object({
    target: z.string().max(60).catch(""),
    purpose: z.string().max(200).catch(""),
    focus: z.string().max(200).catch(""),
    exclusions: z.string().max(200).catch(""),
    sourceIds: z.array(z.string()).max(60).catch([]),
  }).nullable().optional(),
});

export const DELETE_WARNING = "删除后，这个项目的设置、关注的信源列表和项目评分会一起删掉，无法恢复。你标过的「看过了」「稍后看」和已采集的原文都会保留；今日卡片里只属于这个项目的内容不再出现。";

interface CatalogRow { id: string; name: string; enabled: boolean }

/** Sources the assistant may pick: collecting ones, then editorial feeds that exist but are switched off. */
export async function sourceCatalog(db: Db = sql): Promise<CatalogRow[]> {
  return db<CatalogRow[]>`
    SELECT id, name, enabled FROM sources
    WHERE kind <> 'external' AND participation_mode = 'editorial'
    ORDER BY enabled DESC, name, id LIMIT 200`;
}

const projectKey = (i: number) => `#${i + 1}`;

function renderProjects(projects: Awaited<ReturnType<typeof listUserProjects>>) {
  if (!projects.length) return "（还没有项目）";
  return projects.map((p, i) => `${projectKey(i)} 对象：${inertLine(p.target, 80)}｜目标：${inertLine(p.purpose, 240)}｜关注重点：${inertLine(p.focus, 240) || "无"}｜排除：${inertLine(p.exclusions, 240) || "无"}｜信源 ${p.sources} 个`).join("\n");
}

async function projectSources(projectId: string, db: Db = sql): Promise<string[]> {
  return (await db<{ source_id: string }[]>`SELECT source_id FROM project_sources WHERE project_id = ${projectId} ORDER BY created_at, source_id`).map((r) => r.source_id);
}

export async function cardOf(row: { id: string; kind: ProposalCard["kind"]; project_id: string | null; payload: ProposalPayload | Record<string, never>; status: string; created_at: Date }, db: Db = sql): Promise<ProposalCard> {
  const payload = row.kind === "delete" ? null : (row.payload as ProposalPayload);
  const ids = payload?.sourceIds ?? [];
  const named = ids.length ? await db<CatalogRow[]>`SELECT id, name, enabled FROM sources WHERE id IN ${db(ids)}` : [];
  const order = new Map(ids.map((id, i) => [id, i]));
  named.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  let before: ProposalCard["before"] = null;
  if (row.project_id) {
    const [p] = await db<{ target: string; purpose: string; focus: string; exclusions: string; created_at: Date; sources: number }[]>`
      SELECT target, purpose, focus, exclusions, created_at, (SELECT count(*)::int FROM project_sources WHERE project_id = id) AS sources
      FROM tracking_projects WHERE id = ${row.project_id}`;
    if (p) before = { target: p.target, purpose: p.purpose, focus: p.focus, exclusions: p.exclusions, sources: p.sources };
    if (p && row.kind === "delete") return {
      id: row.id, kind: row.kind, projectId: row.project_id, before, payload: null, sources: { collecting: [], pending: [] },
      warning: DELETE_WARNING, createdAt: p.created_at.toISOString(), status: row.status,
    };
  }
  return {
    id: row.id, kind: row.kind, projectId: row.project_id, before, payload,
    sources: { collecting: named.filter((s) => s.enabled).map(({ id, name }) => ({ id, name })), pending: named.filter((s) => !s.enabled).map(({ id, name }) => ({ id, name })) },
    warning: row.kind === "delete" ? DELETE_WARNING : null, createdAt: null, status: row.status,
  };
}

export async function newProposal(userId: string, kind: ProposalCard["kind"], projectId: string | null, payload: ProposalPayload | null, db: Db = sql) {
  // A new proposal replaces the user's open ones: only the latest card can be confirmed.
  await db`UPDATE project_proposals SET status = 'superseded', decided_at = now() WHERE user_id = ${userId} AND status = 'proposed'`;
  const [row] = await db<{ id: string; kind: ProposalCard["kind"]; project_id: string | null; payload: ProposalPayload; status: string; created_at: Date }[]>`
    INSERT INTO project_proposals (user_id, kind, project_id, payload) VALUES (${userId}, ${kind}, ${projectId}, ${db.json((payload ?? {}) as never)})
    RETURNING id, kind, project_id, payload, status, created_at`;
  return row!;
}

const clean = (s: string | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Handles one chat message. Never throws for model trouble: the user gets an honest reply. */
/** What the person reads when the free models cannot answer now: always a reply, never silence. */
export const QUOTA_DAY_REPLY = "今天的免费额度用完了，明早 8 点后再试。";
export function quotaReply(error: BudgetExceededError): string {
  if (/NO_FREE_MODEL/.test(error.message)) return "现在没有可用的免费模型，过一会儿再发一次。";
  // Daily windows reset at 00:00 UTC = 08:00 Beijing; short waits are the per-minute / per-hour limits.
  if (error.retryAfterSeconds > 3600) return QUOTA_DAY_REPLY;
  return error.retryAfterSeconds > 120 ? "模型这会儿太忙，十分钟后再发一次。" : "模型这会儿有点忙，等一分钟再发一次。";
}

export async function handleTurn(userId: string, text: string, opts: { clientId?: string; db?: Db } = {}): Promise<TurnResult> {
  const db = opts.db ?? sql;
  const userText = text.trim().slice(0, MAX_TEXT);
  if (opts.clientId) {
    const [prev] = await db<{ id: number; status: string; reply_text: string | null; proposal_id: string | null }[]>`
      SELECT id, status, reply_text, proposal_id FROM assistant_turns WHERE user_id = ${userId} AND client_id = ${opts.clientId}`;
    if (prev && prev.status === "done") {
      const card = prev.proposal_id ? await loadCard(userId, prev.proposal_id, db) : null;
      return { turnId: prev.id, status: "done", reply: prev.reply_text ?? "", card };
    }
  }
  const [turn] = await db<{ id: number }[]>`
    INSERT INTO assistant_turns (user_id, client_id, user_text) VALUES (${userId}, ${opts.clientId ?? null}, ${userText})
    ON CONFLICT (user_id, client_id) DO UPDATE SET user_text = EXCLUDED.user_text, status = 'pending' RETURNING id`;
  const turnId = turn!.id;
  const finish = async (status: TurnResult["status"], reply: string, action: string | null, card: ProposalCard | null, calls: number, receiptIds: number[]) => {
    await db`UPDATE assistant_turns SET status = ${status}, reply_text = ${reply}, action = ${action}, proposal_id = ${card?.id ?? null},
             calls = calls + ${calls}, receipt_ids = receipt_ids || ${receiptIds}::bigint[] WHERE id = ${turnId}`;
    return { turnId, status, reply, card };
  };
  if (!userText) return finish("done", "说说你想跟踪什么，或者想改、想删哪个项目。", "reply", null, 0, []);

  const [{ n }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM assistant_turns WHERE user_id = ${userId} AND calls > 0
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  if (n >= dailyTurnLimit()) return finish("deferred", "今天的对话次数用完了，明早 8 点后再试。", null, null, 0, []);

  const projects = await listUserProjects(userId, db);
  const catalog = await sourceCatalog(db);
  const history = (await db<{ user_text: string; reply_text: string | null }[]>`
    SELECT user_text, reply_text FROM assistant_turns WHERE user_id = ${userId} AND id <> ${turnId} AND status = 'done'
    ORDER BY id DESC LIMIT ${HISTORY_TURNS}`).reverse();
  const system = promptText("project-assistant", {
    projects: renderProjects(projects),
    // Source names come from feeds: one inert line each, so a name cannot add instructions here.
    catalog: catalog.map((s) => `${s.id}｜${inertLine(s.name, 120)}｜${s.enabled ? "采集中" : "可用"}`).join("\n"),
  });
  const user = [
    // What the reader typed cannot forge these section labels or end a fence.
    history.length ? `【最近对话】\n${history.map((h) => `用户：${inert(h.user_text)}\n助手：${inert(h.reply_text ?? "")}`).join("\n")}` : "",
    `【用户这次说】\n${inert(userText)}`,
  ].filter(Boolean).join("\n\n");

  let answer: z.infer<typeof AnswerSchema> | null = null;
  const receiptIds: number[] = [];
  let calls = 0;
  for (let i = 0; i < MAX_TURN_CALLS && !answer; i++) {
    calls++;
    try {
      const res = await chatJson({
        model: await modelFor("assistant"), purpose: "project_assistant", subject: `user:${userId}:turn:${turnId}`, promptVersion: ASSISTANT_PROMPT_VERSION,
        system, user, schema: AnswerSchema, temperature: 0.2, maxTokens: 2048, timeoutMs: 90_000, attemptTag: `turn-${turnId}${i ? `-retry-${i}` : ""}`,
        userId,
      });
      receiptIds.push(res.receiptId);
      await completeReceipt(db, res.receiptId);
      answer = res.data;
    } catch (error) {
      if (error instanceof ModelOutputError) continue;
      if (error instanceof BudgetExceededError) return finish("deferred", quotaReply(error), null, null, calls - 1, receiptIds);
      return finish("failed", "这次没想明白，换个说法再试一次？", null, null, calls, receiptIds);
    }
  }
  if (!answer) return finish("failed", "这次没想明白，换个说法再试一次？", null, null, calls, receiptIds);

  const ref = answer.projectRef === null || answer.projectRef === undefined ? null : String(answer.projectRef).replace(/^#?/, "#");
  const refProject = ref ? projects[projects.findIndex((_, i) => projectKey(i) === ref)] ?? null : null;
  const reply = clean(answer.reply, 160);

  if (answer.action === "propose_delete") {
    if (!refProject) return finish("done", reply || "要删除哪个项目？说一下它的对象。", "reply", null, calls, receiptIds);
    const row = await newProposal(userId, "delete", refProject.id, null, db);
    return finish("done", reply || `确认删除「${refProject.target}」吗？`, answer.action, await cardOf(row, db), calls, receiptIds);
  }
  if (answer.action === "propose_create" || answer.action === "propose_update") {
    const p = answer.proposal;
    if (answer.action === "propose_update" && !refProject) return finish("done", reply || "要改哪个项目？说一下它的对象。", "reply", null, calls, receiptIds);
    const base = refProject ? { target: refProject.target, purpose: refProject.purpose, focus: refProject.focus, exclusions: refProject.exclusions, sourceIds: await projectSources(refProject.id, db) } : null;
    const target = clean(p?.target, 40) || base?.target || "";
    if (!target) return finish("done", reply || "想跟踪的对象是什么？", "reply", null, calls, receiptIds);
    const asked = [...new Set((p?.sourceIds ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, 60);
    const valid = asked.length
      ? new Set((await db<{ id: string }[]>`SELECT id FROM sources WHERE id IN ${db(asked)} AND kind <> 'external' AND participation_mode = 'editorial'`).map((r) => r.id))
      : new Set<string>();
    const picked = asked.filter((id) => valid.has(id)).slice(0, MAX_SOURCES);
    const payload: ProposalPayload = {
      target,
      purpose: clean(p?.purpose, 120) || base?.purpose || `跟踪${target}的重要进展`,
      focus: clean(p?.focus, 120),
      exclusions: clean(p?.exclusions, 120),
      sourceIds: picked.length ? picked : base?.sourceIds ?? [],
    };
    const row = await newProposal(userId, answer.action === "propose_create" ? "create" : "update", refProject?.id ?? null, payload, db);
    return finish("done", reply || "我整理成了下面的提议，确认后才会生效。", answer.action, await cardOf(row, db), calls, receiptIds);
  }
  return finish("done", reply || "我可以帮你新建、修改或删除跟踪项目，直接说就行。", "reply", null, calls, receiptIds);
}

/** The red card for deleting a project picked from the list: no model call. */
export async function proposeDelete(userId: string, projectId: string, db: Db = sql): Promise<ProposalCard | null> {
  const [p] = await db<{ id: string }[]>`SELECT id FROM tracking_projects WHERE (id = ${projectId} OR slug = ${projectId}) AND owner_id = ${userId}`;
  if (!p) return null;
  return cardOf(await newProposal(userId, "delete", p.id, null, db), db);
}

export async function loadCard(userId: string, proposalId: string, db: Db = sql): Promise<ProposalCard | null> {
  if (!/^[0-9a-f-]{36}$/.test(proposalId)) return null;
  const [row] = await db<{ id: string; kind: ProposalCard["kind"]; project_id: string | null; payload: ProposalPayload; status: string; created_at: Date }[]>`
    SELECT id, kind, project_id, payload, status, created_at FROM project_proposals WHERE id = ${proposalId} AND user_id = ${userId}`;
  return row ? cardOf(row, db) : null;
}

export type ConfirmOutcome =
  | { ok: true; kind: ProposalCard["kind"]; projectId: string; message: string }
  | { ok: false; reason: "not-found" | "not-open" | "rejected" | "gone"; message: string; state?: CardState };

/** What a closed card says, and why its buttons are gone. Cards stay open for a day. */
export type CardState = "applied" | "superseded" | "cancelled" | "expired" | "failed" | "gone";
export const CARD_TTL_HOURS = 24;
const CLOSED_MESSAGE: Record<CardState, string> = {
  applied: "这张卡片已经确认过了。",
  superseded: "这张卡片已被后面的新卡片替换，请在最新那张上确认。",
  cancelled: "这张卡片已经放弃了。想改就直接说。",
  expired: `这张卡片已过期（超过 ${CARD_TTL_HOURS} 小时没确认），再说一次就会出新卡片。`,
  failed: "这张卡片没能生效，再说一次试试。",
  gone: "这个项目已经不在了。",
};
async function closedState(userId: string, proposalId: string, db: Db): Promise<CardState | null> {
  const [cur] = await db<{ status: string; expired: boolean }[]>`
    SELECT status, created_at <= now() - make_interval(hours => ${CARD_TTL_HOURS}) AS expired FROM project_proposals WHERE id = ${proposalId} AND user_id = ${userId}`;
  if (!cur) return null;
  if (cur.status === "proposed") return cur.expired ? "expired" : null;
  return cur.status as CardState;
}

/** 确认: applies the user's own open proposal, once (the claim is atomic; a second tap finds it applied). */
export async function confirmProposal(userId: string, proposalId: string, db: Sql = sql): Promise<ConfirmOutcome> {
  if (!/^[0-9a-f-]{36}$/.test(proposalId)) return { ok: false, reason: "not-found", message: "找不到这张卡片。" };
  const [row] = await db<{ kind: ProposalCard["kind"]; project_id: string | null; payload: ProposalPayload }[]>`
    UPDATE project_proposals SET status = 'applied', decided_at = now()
    WHERE id = ${proposalId} AND user_id = ${userId} AND status = 'proposed' AND created_at > now() - make_interval(hours => ${CARD_TTL_HOURS})
    RETURNING kind, project_id, payload`;
  if (!row) {
    const state = await closedState(userId, proposalId, db);
    if (!state) return { ok: false, reason: "not-found", message: "找不到这张卡片。" };
    return { ok: false, reason: "not-open", message: CLOSED_MESSAGE[state], state };
  }
  const settle = (projectId: string | null, failed = false) =>
    db`UPDATE project_proposals SET status = ${failed ? "failed" : "applied"}, result = ${db.json({ projectId } as never)} WHERE id = ${proposalId}`;
  try {
    if (row.kind === "delete") {
      const [p] = await db<{ target: string }[]>`DELETE FROM tracking_projects WHERE id = ${row.project_id} AND owner_id = ${userId} RETURNING target`;
      if (!p) {
        await settle(row.project_id, true);
        return { ok: false, reason: "gone", message: "这个项目已经不在了。" };
      }
      await settle(row.project_id);
      return { ok: true, kind: "delete", projectId: row.project_id!, message: `已删除「${p.target}」。` };
    }
    const p = row.payload;
    const existing = p.sourceIds.length ? await db<{ id: string }[]>`SELECT id FROM sources WHERE id IN ${db(p.sourceIds)}` : [];
    const sourceIds = p.sourceIds.filter((id) => existing.some((e) => e.id === id));
    if (row.kind === "create") {
      try {
        const { project, created } = await createProject({ ownerId: userId, target: p.target, purpose: p.purpose, sources: sourceIds.map((sourceId) => ({ sourceId, required: false })) }, db);
        await db`UPDATE tracking_projects SET focus = ${p.focus}, exclusions = ${p.exclusions}, updated_at = now() WHERE id = ${project.id}`;
        await settle(project.id);
        return { ok: true, kind: "create", projectId: project.id, message: created ? `已创建「${project.target}」，新内容分析后会出现在今日。` : `「${project.target}」已经存在，已按这张卡片更新关注重点和排除。` };
      } catch (error) {
        if (!(error instanceof ProjectRejected)) throw error;
        await settle(null, true);
        return { ok: false, reason: "rejected", message: "对象和目标都要有，再说一次？" };
      }
    }
    // update: the same project id; a changed target or purpose is a new revision.
    const outcome = await db.begin(async (tx) => {
      const [cur] = await tx<{ target: string; purpose: string; current_revision: number }[]>`
        SELECT target, purpose, current_revision FROM tracking_projects WHERE id = ${row.project_id} AND owner_id = ${userId} FOR UPDATE`;
      if (!cur) return false;
      let revision = cur.current_revision;
      if (cur.target !== p.target || cur.purpose !== p.purpose) {
        revision++;
        await tx`INSERT INTO project_revisions (project_id, revision, target, purpose, previous_version_id, needs_rebaseline)
                 VALUES (${row.project_id}, ${revision}, ${p.target}, ${p.purpose}, ${`${row.project_id}@${cur.current_revision}`}, true)`;
      }
      await tx`UPDATE tracking_projects SET target = ${p.target}, purpose = ${p.purpose}, focus = ${p.focus}, exclusions = ${p.exclusions},
               current_revision = ${revision}, updated_at = now() WHERE id = ${row.project_id}`;
      if (sourceIds.length) {
        await tx`DELETE FROM project_sources WHERE project_id = ${row.project_id} AND NOT (source_id IN ${tx(sourceIds)})`;
        for (const id of sourceIds) await tx`INSERT INTO project_sources (project_id, source_id) VALUES (${row.project_id}, ${id}) ON CONFLICT DO NOTHING`;
      }
      return true;
    });
    if (!outcome) {
      await settle(row.project_id, true);
      return { ok: false, reason: "gone", message: "这个项目已经不在了。" };
    }
    await settle(row.project_id);
    return { ok: true, kind: "update", projectId: row.project_id!, message: `已更新「${p.target}」。` };
  } catch (error) {
    await settle(row.project_id, true);
    throw error;
  }
}

/** 再改改 / 取消: the card is closed; nothing changes. */
/** 再改改 / 取消: closes the user's open card. A card that is already closed reports its state; an unknown one none. */
export async function cancelProposal(userId: string, proposalId: string, db: Db = sql): Promise<{ ok: boolean; state: CardState | null; message: string }> {
  if (!/^[0-9a-f-]{36}$/.test(proposalId)) return { ok: false, state: null, message: "" };
  const rows = await db`UPDATE project_proposals SET status = 'cancelled', decided_at = now()
    WHERE id = ${proposalId} AND user_id = ${userId} AND status = 'proposed' AND created_at > now() - make_interval(hours => ${CARD_TTL_HOURS}) RETURNING id`;
  if (rows.length) return { ok: true, state: "cancelled", message: "好的，说说要怎么改。" };
  const state = await closedState(userId, proposalId, db);
  return { ok: false, state, message: state ? CLOSED_MESSAGE[state] : "" };
}
