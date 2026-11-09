// Issue card copy (v4.4 今日): every item of a fixed issue gets its own card text —
// a two-half title (the halves are laid out by the client), a two-half 意味着 line, a summary, a short
// tag and a short source name — written per project for the issue's items. Widths follow the card
// budget (COPY-BUDGET.md); a field over budget goes back to the model with its overshoot, at most
// MAX_REWRITES rounds; still over → stored with over_budget = true and the client lays it out with
// its fallback, never truncated. This is written once for the items of a fixed issue, so every item
// of the issue gets copy: the 10-22 bug was that copy only targeted a moving today list and dropped
// over-budget answers, leaving an issue 半有半没有.
import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { chatJson, ModelOutputError } from "../providers/llm.ts";
import { BudgetExceededError, completeReceipt } from "../providers/receipts.ts";
import { BUDGET, budgetProblems, type BudgetProblem, type CopyField, type CopyFields } from "./copy-budget.ts";
import { issueItemsWithoutCopy } from "./issues.ts";
import { outputLanguageFor } from "../accounts/locale.ts";

export const ISSUE_COPY_PROMPT_VERSION = promptVersion("issue-card");
export const MAX_REWRITES = 2;
const BODY_CHARS = 2400;

/** One space between a CJK char and an ASCII letter/digit, both directions; spaces and punctuation are left alone. */
export function pangu(s: string): string {
  const cjk = (ch: string) => /[\u3400-\u9fff]/.test(ch);
  const alnum = (ch: string) => /[A-Za-z0-9]/.test(ch);
  let out = "";
  let prev = "";
  for (const ch of s) {
    if (prev && ((cjk(prev) && alnum(ch)) || (alnum(prev) && cjk(ch)))) out += " ";
    out += ch;
    prev = ch;
  }
  return out;
}

/** Whitespace to one space, wrapping quotes off, trimmed — model fields are cleaned, never cut. */
export function cleanField(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").replace(/^[「“"]/, "").replace(/[」”"]$/, "").trim();
}

const PANGU_FIELDS: ReadonlySet<CopyField> = new Set(["title_a", "title_b", "core_a", "core_b", "summary"]);

const Schema = z.object({
  cards: z.array(z.object({
    id: z.string(),
    title_a: z.string(), title_b: z.string().default(""),
    core_a: z.string(), core_b: z.string().default(""),
    summary: z.string(), tag: z.string().default(""),
    source: z.string().default(""),
  })).max(10),
});

const FixSchema = z.object({
  fixes: z.array(z.object({
    id: z.string(),
    field: z.enum(["title_a", "title_b", "core_a", "core_b", "summary", "tag", "source"]),
    text: z.string(),
  })).max(20),
});

interface Item {
  articleId: string;
  projectId: string;
  position: number;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  source: string;
  url: string;
  publishedAt: Date | string | null;
  score: number | null;
}

function fieldsOf(card: z.infer<typeof Schema>["cards"][number]): CopyFields {
  return {
    title_a: pangu(cleanField(card.title_a)),
    title_b: pangu(cleanField(card.title_b)),
    core_a: pangu(cleanField(card.core_a)),
    core_b: pangu(cleanField(card.core_b)),
    summary: pangu(cleanField(card.summary)),
    tag: cleanField(card.tag),
    source: cleanField(card.source),
  };
}

const fixedField = (field: CopyField, text: string) => (PANGU_FIELDS.has(field) ? pangu(cleanField(text)) : cleanField(text));

async function bodies(ids: string[], db: Db) {
  const rows = ids.length ? await db<{ id: string; body: string | null }[]>`SELECT id, coalesce(body_text, excerpt) AS body FROM articles WHERE id IN ${db(ids)}` : [];
  return new Map(rows.map((r) => [r.id, (r.body ?? "").replace(/\s+/g, " ").slice(0, BODY_CHARS)]));
}

const day = (v: Date | string | null) => {
  if (!v) return "";
  return `${typeof v === "string" ? v : v.toISOString()}`.slice(0, 10);
};

function materialUser(list: Item[], body: Map<string, string>, heroFor: (i: Item) => boolean) {
  return list.map((i) => [
    `【内容 id=${i.articleId}】`,
    `来源：${i.source}${day(i.publishedAt) ? `｜发布：${day(i.publishedAt)}` : ""}`,
    `现有标题：${i.title}${i.originalTitle ? `｜原标题：${i.originalTitle}` : ""}`,
    i.summary ? `现有摘要：${i.summary}` : "",
    body.get(i.articleId) ? `正文节选：${body.get(i.articleId)}` : "",
    `预算：title_a ≤ ${BUDGET.titleA}｜标题合计 ≤ ${heroFor(i) ? BUDGET.heroTitle : BUDGET.itemTitle}｜core 每半 ≤ ${heroFor(i) ? BUDGET.heroCore : BUDGET.itemCore}｜summary ${BUDGET.summaryMin}–${BUDGET.summaryMax}｜tag ≤ ${BUDGET.tagChars} 字符｜source ≤ ${BUDGET.source}`,
  ].filter(Boolean).join("\n")).join("\n\n");
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function rewriteUser(blocks: Array<{ id: string; problems: BudgetProblem[]; fields: CopyFields }>) {
  return "【重写】\n" + blocks.map(({ id, problems, fields }) => problems.map((p) => (
    `id=${id}｜字段 ${p.field}｜现在「${fields[p.field]}」｜宽度 ${p.units}，${p.kind === "under" ? "至少" : "上限"} ${p.limit}${p.kind === "over" ? `，超出 ${round2(p.units - p.limit)}` : ""}${p.field === "title_b" ? "（title_a + title_b 的标题合计一起量）" : ""}` +
    `\n同卡：title_a「${fields.title_a}」 title_b「${fields.title_b}」 core_a「${fields.core_a}」 core_b「${fields.core_b}」`
  )).join("\n")).join("\n");
}

/**
 * Writes the card copy of one fixed issue (every item gets it). Returns how many were stored and how
 * many are still over budget; a spent budget stops quietly (the rest wait for the next try), while a
 * broken write call skips the project and a broken rewrite call stores the answers as over budget.
 */
export async function writeIssueCopy(userId: string, date: string, opts: { db?: Db; subject?: string } = {}): Promise<{ stored: number; overBudget: number; calls: number; skipped: string[] }> {
  const db = opts.db ?? sql;
  const items: Item[] = await issueItemsWithoutCopy(userId, date, db);
  if (!items.length) return { stored: 0, overBudget: 0, calls: 0, skipped: [] };
  const [head] = await db<{ hero: boolean }[]>`SELECT hero FROM user_issues WHERE user_id = ${userId} AND issue_date = ${date}`;
  const hero = head?.hero ?? false;
  const heroFor = (i: Item) => hero && i.position === 1;
  // Locale drives output language (ADR 0004 D): en user → en card copy, zh-CN → zh.
  // No *_en columns; per-user tables store generated text; historical rows stay.
  const [u] = await db<{ locale: string | null }[]>`SELECT locale FROM users WHERE id = ${userId}`;
  const outputLanguage = outputLanguageFor(u?.locale);

  let stored = 0;
  let overBudget = 0;
  let calls = 0;
  const skipped: string[] = [];
  const remaining = new Set(items.map((i) => i.articleId));
  const drop = (ids: string[]) => { skipped.push(...ids); for (const id of ids) remaining.delete(id); };

  const byProject = new Map<string, Item[]>();
  for (const i of items) byProject.set(i.projectId, [...(byProject.get(i.projectId) ?? []), i]);
  // One project after another: a byte budget or a broken write call stops the rest (their items land
  // in skipped and the caller retries them with a later call).
  for (const [projectId, list] of byProject) {
    try {
      const ok = await writeProject(projectId, list, { db, subject: opts.subject ?? `user:${userId}:issue:${date}` });
      if (!ok) drop(list.map((i) => i.articleId));
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        drop([...remaining]);
        return { stored, overBudget, calls: Math.max(calls - 1, 0), skipped };
      }
      throw error;
    }
  }
  return { stored, overBudget, calls, skipped };

  async function writeProject(projectId: string, list: Item[], ctx: { db: Db; subject: string }): Promise<boolean> {
    const db = ctx.db;
    const [p] = await db<{ target: string; purpose: string; focus: string | null; exclusions: string | null }[]>`
      SELECT target, purpose, focus, exclusions FROM tracking_projects WHERE id = ${projectId}`;
    if (!p) return false;
    const system = promptText("issue-card", {
      project: `对象：${p.target}\n目标：${p.purpose}\n关注重点：${p.focus || "无"}\n排除：${p.exclusions || "无"}`,
      // outputLanguage token: zh | en (see accounts/locale.ts)
      outputLanguage,
    });
    const body = await bodies(list.map((i) => i.articleId), db);
    const current = new Map<string, { fields: CopyFields; receiptId: number | null }>();
    calls++;
    try {
      const res = await chatJson({
        model: await modelFor("card"), purpose: "mobile_card", subject: ctx.subject, promptVersion: ISSUE_COPY_PROMPT_VERSION,
        system, user: materialUser(list, body, heroFor), schema: Schema, temperature: 0.3, maxTokens: 4096, timeoutMs: 120_000,
      });
      await completeReceipt(db, res.receiptId);
      const writeReceipt = res.receiptId;
      for (const card of res.data.cards) {
        if (!list.some((i) => i.articleId === card.id)) continue;
        current.set(card.id, { fields: fieldsOf(card), receiptId: writeReceipt });
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error; // the loop below stops and returns what was stored
      if (error instanceof ModelOutputError) return false; // the caller retries the project later
      throw error;
    }
    for (let round = 1; round <= MAX_REWRITES; round++) {
      const blocks: Array<{ id: string; problems: BudgetProblem[]; fields: CopyFields }> = [];
      for (const i of list) {
        const entry = current.get(i.articleId);
        if (!entry) continue;
        const problems = budgetProblems(entry.fields, heroFor(i));
        if (problems.length) blocks.push({ id: i.articleId, problems, fields: entry.fields });
      }
      if (!blocks.length) break;
      calls++;
      try {
        const res = await chatJson({
          model: await modelFor("card"), purpose: "mobile_card", subject: ctx.subject, promptVersion: ISSUE_COPY_PROMPT_VERSION,
          system, user: rewriteUser(blocks), schema: FixSchema, temperature: 0.3, maxTokens: 4096, timeoutMs: 120_000,
          attemptTag: `rewrite-${round}`,
        });
        await completeReceipt(db, res.receiptId);
        const listed = new Set(blocks.flatMap((b) => b.problems.map((pr) => `${b.id}:${pr.field}`)));
        for (const fix of res.data.fixes) {
          if (!listed.has(`${fix.id}:${fix.field}`)) continue;
          const entry = current.get(fix.id)!;
          entry.fields[fix.field] = fixedField(fix.field, fix.text);
          entry.receiptId = res.receiptId;
        }
      } catch (error) {
        // A spent budget or a broken answer stops rewriting; what came back is stored as over budget
        // (never thrown away), and the next project's write call meets the spent budget itself.
        if (error instanceof BudgetExceededError || error instanceof ModelOutputError) break;
        throw error;
      }
    }
    for (const i of list) {
      remaining.delete(i.articleId);
      const entry = current.get(i.articleId);
      if (!entry || !entry.fields.title_a || !entry.fields.core_a) { skipped.push(i.articleId); continue; }
      const over = budgetProblems(entry.fields, heroFor(i)).length > 0;
      await db`INSERT INTO issue_card_copy (project_id, article_id, prompt_version, title_a, title_b, core_a, core_b, summary, tag, source_short, over_budget, receipt_id)
        VALUES (${projectId}, ${i.articleId}, ${ISSUE_COPY_PROMPT_VERSION}, ${entry.fields.title_a}, ${entry.fields.title_b}, ${entry.fields.core_a}, ${entry.fields.core_b}, ${entry.fields.summary}, ${entry.fields.tag}, ${entry.fields.source}, ${over}, ${entry.receiptId})
        ON CONFLICT (project_id, article_id) DO UPDATE SET prompt_version = EXCLUDED.prompt_version, title_a = EXCLUDED.title_a, title_b = EXCLUDED.title_b,
          core_a = EXCLUDED.core_a, core_b = EXCLUDED.core_b, summary = EXCLUDED.summary, tag = EXCLUDED.tag, source_short = EXCLUDED.source_short,
          over_budget = EXCLUDED.over_budget, receipt_id = EXCLUDED.receipt_id, created_at = now()`;
      stored++;
      if (over) overBudget++;
    }
    return true;
  }
}
