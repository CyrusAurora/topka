// Mobile card copy: mobile 今日 cards may not open the original, so each of the day's top
// cards gets its own copy written for the project: a title of at most 20 characters, what changed (≤75)
// and why it matters for the project's goal (≤40). One call writes every missing card of a user's day
// (a second only when an answer broke the budget); it is background work, so it stops before the
// chat's reserved calls (receipts.interactiveReserve). Copy outside the budget is not stored: the card
// keeps its regular title and summary rather than showing something cut off.
import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { chatJson, ModelOutputError } from "../providers/llm.ts";
import { BudgetExceededError, completeReceipt } from "../providers/receipts.ts";
import { outputLanguageFor } from "../accounts/locale.ts";
import { inert, inertLine } from "../lib/untrusted.ts";

export const CARD_PROMPT_VERSION = promptVersion("mobile-card");
export const CARD_LIMITS = { title: 20, lead: 75, why: 40 } as const;
const MAX_CALLS = 2;
const BODY_CHARS = 2400;

/** Width on the card in Chinese characters: Latin letters, digits and ASCII punctuation count half. */
export function cardWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\x20-\x7e]/.test(ch) ? 0.5 : 1;
  return Math.ceil(w);
}

export interface CardCopy {
  title: string;
  lead: string;
  why: string;
}

const Schema = z.object({
  cards: z.array(z.object({ id: z.string(), title: z.string(), lead: z.string(), why: z.string() })).max(10),
});

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^[「“"]|[」”"]$/g, "").trim();

/** Which limits a card breaks (empty when it fits). */
export function overBudget(c: CardCopy): string[] {
  return (Object.keys(CARD_LIMITS) as Array<keyof CardCopy>)
    .filter((k) => !c[k] || cardWidth(c[k]) > CARD_LIMITS[k])
    .map((k) => `${k} ${cardWidth(c[k] ?? "")}/${CARD_LIMITS[k]}`);
}

interface Material {
  id: string;
  projectId: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  source: string;
  publishedAt: string | null;
}

async function bodies(ids: string[], db: Db) {
  const rows = ids.length ? await db<{ id: string; body: string | null }[]>`SELECT id, coalesce(body_text, excerpt) AS body FROM articles WHERE id IN ${db(ids)}` : [];
  return new Map(rows.map((r) => [r.id, (r.body ?? "").replace(/\s+/g, " ").slice(0, BODY_CHARS)]));
}

/**
 * Writes copy for the cards that have none yet under the current prompt. Returns how many were stored;
 * a spent budget stops quietly (the cards keep their regular text until the next try).
 * outputLanguage is resolved from users.locale inside (ADR 0004 D); no *_en columns.
 */
export async function writeCardCopy(items: Material[], opts: { db?: Db; subject?: string } = {}): Promise<{ stored: number; calls: number; skipped: string[] }> {
  const db = opts.db ?? sql;
  if (!items.length) return { stored: 0, calls: 0, skipped: [] };
  const have = new Set((await db<{ k: string }[]>`
    SELECT project_id || ':' || article_id AS k FROM project_card_copy
    WHERE prompt_version = ${CARD_PROMPT_VERSION} AND article_id IN ${db(items.map((i) => i.id))}`).map((r) => r.k));
  const todo = items.filter((i) => !have.has(`${i.projectId}:${i.id}`));
  if (!todo.length) return { stored: 0, calls: 0, skipped: [] };
  const byProject = new Map<string, Material[]>();
  for (const i of todo) byProject.set(i.projectId, [...(byProject.get(i.projectId) ?? []), i]);

  let stored = 0;
  let calls = 0;
  const skipped: string[] = [];
  for (const [projectId, list] of byProject) {
    const [p] = await db<{ target: string; purpose: string; focus: string | null; exclusions: string | null; owner_id: string }[]>`
      SELECT target, purpose, focus, exclusions, owner_id FROM tracking_projects WHERE id = ${projectId}`;
    if (!p) continue;
    // Locale → outputLanguage (zh|en); only non-site language writes when copy missing (ADR 0004 D).
    const [u] = await db<{ locale: string | null }[]>`SELECT locale FROM users WHERE id = ${p.owner_id}`;
    const outputLanguage = outputLanguageFor(u?.locale);
    const system = promptText("mobile-card", {
      project: `对象：${p.target}\n目标：${p.purpose}\n关注重点：${p.focus || "无"}\n排除：${p.exclusions || "无"}`,
      outputLanguage,
    });
    const body = await bodies(list.map((i) => i.id), db);
    let pending = list;
    let feedback = "";
    for (let attempt = 0; attempt < MAX_CALLS && pending.length; attempt++) {
      const user = pending.map((i) => [
        `【内容 id=${i.id}】`,
        `来源：${inertLine(i.source, 120)}${i.publishedAt ? `｜发布：${i.publishedAt.slice(0, 10)}` : ""}`,
        `现有标题：${inert(i.title)}${i.originalTitle ? `｜原标题：${inert(i.originalTitle)}` : ""}`,
        i.summary ? `现有摘要：${inert(i.summary)}` : "",
        body.get(i.id) ? `正文节选：${inert(body.get(i.id)!)}` : "",
      ].filter(Boolean).join("\n")).join("\n\n") + feedback;
      calls++;
      let cards: z.infer<typeof Schema>["cards"];
      try {
        const res = await chatJson({
          model: await modelFor("card"), purpose: "mobile_card", subject: opts.subject ?? `project:${projectId}:cards`,
          promptVersion: CARD_PROMPT_VERSION, system, user, schema: Schema, temperature: 0.3, maxTokens: 4096, timeoutMs: 120_000,
          attemptTag: attempt ? `budget-${attempt}` : undefined,
        });
        await completeReceipt(db, res.receiptId);
        cards = res.data.cards;
        const over: string[] = [];
        for (const i of pending) {
          const c = cards.find((x) => x.id === i.id);
          if (!c) continue;
          const copy = { title: clean(c.title), lead: clean(c.lead), why: clean(c.why) };
          const broke = overBudget(copy);
          if (broke.length) {
            over.push(`${i.id}: ${broke.join("、")}`);
            continue;
          }
          await db`INSERT INTO project_card_copy (project_id, article_id, prompt_version, title, lead, why, receipt_id)
            VALUES (${projectId}, ${i.id}, ${CARD_PROMPT_VERSION}, ${copy.title}, ${copy.lead}, ${copy.why}, ${res.receiptId})
            ON CONFLICT (project_id, article_id) DO UPDATE SET prompt_version = EXCLUDED.prompt_version, title = EXCLUDED.title,
              lead = EXCLUDED.lead, why = EXCLUDED.why, receipt_id = EXCLUDED.receipt_id, created_at = now()`;
          stored++;
        }
        pending = pending.filter((i) => !cards.some((c) => c.id === i.id) || over.some((o) => o.startsWith(`${i.id}:`)));
        feedback = over.length ? `\n\n【上一版超出字数，请重写这几张，严格守住字数】\n${over.join("\n")}` : "";
      } catch (error) {
        if (error instanceof BudgetExceededError) return { stored, calls: calls - 1, skipped: [...skipped, ...pending.map((i) => i.id)] };
        if (error instanceof ModelOutputError) continue;
        throw error;
      }
    }
    skipped.push(...pending.map((i) => i.id));
  }
  return { stored, calls, skipped };
}

/** Stored copy for (project, article) pairs under the current prompt. */
export async function cardCopyFor(pairs: Array<{ projectId: string; articleId: string }>, db: Db = sql): Promise<Map<string, CardCopy>> {
  if (!pairs.length) return new Map();
  const rows = await db<{ project_id: string; article_id: string; title: string; lead: string; why: string }[]>`
    SELECT project_id, article_id, title, lead, why FROM project_card_copy
    WHERE prompt_version = ${CARD_PROMPT_VERSION} AND article_id IN ${db(pairs.map((p) => p.articleId))}`;
  const want = new Set(pairs.map((p) => `${p.projectId}:${p.articleId}`));
  return new Map(rows.filter((r) => want.has(`${r.project_id}:${r.article_id}`)).map((r) => [`${r.project_id}:${r.article_id}`, { title: r.title, lead: r.lead, why: r.why }]));
}
