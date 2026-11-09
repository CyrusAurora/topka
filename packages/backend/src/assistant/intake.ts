// The Socratic intake on the server (web 对话, and outside clients whose own runtime could not run the
// turn itself): one question per turn with tappable options, then a summary the user confirms, then a
// judgement and a create card (industry/prompts/socratic-intake.md, state machine in intake-core.cjs).
// Sentences that change or delete an existing project still go to the one-shot assistant (handleTurn).
// The session lives in assistant_intakes, or — for an outside client's fallback — travels with the command
// and is handed back to that client. Same guards as handleTurn: free-only, daily turn cap.
import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { chatJson, ModelOutputError } from "../providers/llm.ts";
import { BudgetExceededError, completeReceipt } from "../providers/receipts.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { listUserProjects } from "../projects/user-today.ts";
import core, { type IntakeMessage, type IntakeSession } from "./intake-core.cjs";
export type { IntakeSession } from "./intake-core.cjs";
import { cardOf, dailyTurnLimit, handleTurn, loadCard, newProposal, quotaReply, sourceCatalog, type TurnMeta, type TurnResult } from "./project-assistant.ts";

export const INTAKE_PROMPT_VERSION = promptVersion("socratic-intake");
const MAX_TEXT = 500;
const MAX_CALLS = 2;
const AnySchema = z.record(z.string(), z.unknown());

export interface IntakeTurnResult extends TurnResult {
  meta: TurnMeta | null;
  /** The session after the turn (what the caller stores when it owns the session). */
  session: IntakeSession | null;
}

export async function loadIntake(userId: string, db: Db = sql): Promise<IntakeSession | null> {
  const [row] = await db<{ session: IntakeSession }[]>`SELECT session FROM assistant_intakes WHERE user_id = ${userId}`;
  return row?.session ?? null;
}

export async function saveIntake(userId: string, session: IntakeSession | null, db: Db = sql): Promise<void> {
  if (!session) {
    await db`DELETE FROM assistant_intakes WHERE user_id = ${userId}`;
    return;
  }
  await db`INSERT INTO assistant_intakes (user_id, session, updated_at) VALUES (${userId}, ${db.json(session as never)}, now())
           ON CONFLICT (user_id) DO UPDATE SET session = EXCLUDED.session, updated_at = now()`;
}

/** After a card is confirmed: the stored session for that card is finished. */
export async function closeIntake(userId: string, proposalId: string, db: Db = sql): Promise<void> {
  const s = await loadIntake(userId, db);
  if (s && s.card?.id === proposalId) await saveIntake(userId, core.finish(s, Date.now()), db);
}

const metaOf = (m: IntakeMessage): TurnMeta => ({
  kind: m.kind, ...(m.chips ? { chips: m.chips } : {}), ...(m.intake ? { intake: m.intake } : {}), ...(m.step ? { step: m.step } : {}),
});

/**
 * One intake turn. `opts.session` given (even null) means the caller owns the session (outside-client
 * fallback): it is read from there and returned, never stored here.
 */
export async function intakeTurn(userId: string, text: string, opts: { clientId?: string; db?: Db; session?: IntakeSession | null } = {}): Promise<IntakeTurnResult> {
  const db = opts.db ?? sql;
  const external = opts.session !== undefined;
  const userText = text.trim().slice(0, MAX_TEXT);
  if (opts.clientId) {
    const [prev] = await db<{ id: number; status: string; reply_text: string | null; proposal_id: string | null; meta: TurnMeta | null }[]>`
      SELECT id, status, reply_text, proposal_id, meta FROM assistant_turns WHERE user_id = ${userId} AND client_id = ${opts.clientId}`;
    if (prev && prev.status === "done") {
      const card = prev.proposal_id ? await loadCard(userId, prev.proposal_id, db) : null;
      return { turnId: prev.id, status: "done", reply: prev.reply_text ?? "", card, meta: prev.meta, session: external ? opts.session ?? null : await loadIntake(userId, db) };
    }
  }
  const before = external ? opts.session ?? null : await loadIntake(userId, db);
  const [turn] = await db<{ id: number }[]>`
    INSERT INTO assistant_turns (user_id, client_id, user_text) VALUES (${userId}, ${opts.clientId ?? null}, ${userText})
    ON CONFLICT (user_id, client_id) DO UPDATE SET user_text = EXCLUDED.user_text, status = 'pending' RETURNING id`;
  const turnId = turn!.id;
  const finish = async (status: TurnResult["status"], reply: string, action: string | null, card: TurnResult["card"], meta: TurnMeta | null, calls: number, receiptIds: number[], session: IntakeSession | null) => {
    await db`UPDATE assistant_turns SET status = ${status}, reply_text = ${reply}, action = ${action}, proposal_id = ${card?.id ?? null}, meta = ${meta ? db.json(meta as never) : null},
             calls = calls + ${calls}, receipt_ids = receipt_ids || ${receiptIds}::bigint[] WHERE id = ${turnId}`;
    if (!external && session !== before) await saveIntake(userId, session, db);
    return { turnId, status, reply, card, meta, session };
  };
  if (!userText) return finish("done", "说说你想跟踪或弄清楚什么。", "reply", null, null, 0, [], before);

  const plan = core.planTurn(before, userText, Date.now());
  if (plan.mode === "local") return finish("done", plan.reply.text, "intake_note", null, metaOf(plan.reply), 0, [], plan.session);

  const [{ n }] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM assistant_turns WHERE user_id = ${userId} AND calls > 0
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  if (n >= dailyTurnLimit()) return finish("deferred", "今天的对话次数用完了，明早 8 点后再试。", null, null, null, 0, [], before);

  const projects = (await listUserProjects(userId, db)).map((p) => `${p.target}（${p.purpose}）`);
  const catalog = plan.mode === "card" ? await sourceCatalog(db) : [];
  const valid = new Set(catalog.map((c) => c.id));
  const ctx = { projects, catalog, validSource: (id: string) => valid.has(id) };
  const system = promptText("socratic-intake");
  const user = core.buildUser(plan.mode, plan.session, ctx);

  const receiptIds: number[] = [];
  let calls = 0;
  // The receipt is keyed by the turn: a repeat of the same turn (same clientId) is never sent twice,
  // while the person's own 「再发一次」 (a new turn with the same words) is a new request — a timed-out
  // answer (receipt "unknown") would otherwise block that sentence for 30 minutes.
  for (let i = 0; i < MAX_CALLS; i++) {
    calls++;
    let data: unknown;
    try {
      const res = await chatJson({
        model: await modelFor("assistant"), purpose: "project_assistant", subject: `user:${userId}:intake:${turnId}`, promptVersion: INTAKE_PROMPT_VERSION,
        system, user, schema: AnySchema, temperature: 0.3, maxTokens: 1200, timeoutMs: 60_000, attemptTag: `turn-${turnId}${i ? `-retry-${i}` : ""}`, userId,
      });
      receiptIds.push(res.receiptId);
      await completeReceipt(db, res.receiptId);
      data = res.data;
    } catch (error) {
      if (error instanceof ModelOutputError) continue;
      if (error instanceof BudgetExceededError) return finish("deferred", quotaReply(error), null, null, null, calls - 1, receiptIds, before);
      return finish("failed", core.UNAVAILABLE, null, null, null, calls, receiptIds, before);
    }
    const applied = core.applyAnswer(plan.mode, plan.session, data, ctx);
    if (!applied) continue;
    if (applied.manage) {
      // Not an intake after all (change/delete/how-to): the one-shot assistant answers this turn.
      await db`DELETE FROM assistant_turns WHERE id = ${turnId}`;
      const legacy = await handleTurn(userId, userText, { clientId: opts.clientId, db });
      return { ...legacy, meta: null, session: before };
    }
    const { message, proposal } = applied;
    let session = applied.session;
    let card: TurnResult["card"] = null;
    if (proposal) {
      const row = await newProposal(userId, "create", null, proposal, db);
      card = await cardOf(row, db);
      session = { ...session, card: { proposal, id: row.id } };
    }
    return finish("done", message.text, `intake_${message.kind}`, card, metaOf(message), calls, receiptIds, session);
  }
  return finish("failed", core.UNAVAILABLE, null, null, null, calls, receiptIds, before);
}

/** The 对话 entry point: change/delete sentences go to the one-shot assistant, everything else to the intake. */
export async function chatTurn(userId: string, text: string, opts: { clientId?: string; db?: Db; session?: IntakeSession | null } = {}): Promise<IntakeTurnResult> {
  if (core.routeOf(text) === "manage") {
    const legacy = await handleTurn(userId, text, { clientId: opts.clientId, db: opts.db });
    return { ...legacy, meta: null, session: opts.session !== undefined ? opts.session ?? null : null };
  }
  return intakeTurn(userId, text, opts);
}
