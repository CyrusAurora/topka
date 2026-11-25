// Citation completeness (引用完整性): every card a reader sees must trace back to its evidence —
// card → publication → article → the original's http(s) link → its source → its publication time →
// the analysis (and, for an issue card, the copy receipt) the text was written from. The check is
// mechanical; whether each sentence is supported by the original is the manual sample in
// eval/gold/gold-citation.jsonl.
import { sql, type Db } from "../db.ts";
import { ratio } from "./metrics.ts";

export type CitationProblem = "no-publication" | "not-public" | "no-link" | "no-source" | "no-time" | "no-analysis" | "no-copy-receipt";

export interface CitationResult {
  cards: number;
  complete: number;
  completeRate: number | null;
  problems: Partial<Record<CitationProblem, number>>;
  broken: Array<{ kind: "issue" | "selected"; articleId: string; problems: CitationProblem[] }>;
}

interface Row {
  kind: "issue" | "selected";
  article_id: string;
  has_pub: boolean;
  public: boolean;
  url: string | null;
  source_name: string | null;
  published_at: Date | null;
  analysis_ok: boolean;
  copy_ok: boolean | null;
}

export function problemsOf(r: Row): CitationProblem[] {
  if (!r.has_pub) return ["no-publication"];
  const out: CitationProblem[] = [];
  if (!r.public) out.push("not-public");
  if (!r.url || !/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(r.url)) out.push("no-link");
  if (!r.source_name?.trim()) out.push("no-source");
  if (!r.published_at) out.push("no-time");
  if (!r.analysis_ok) out.push("no-analysis");
  if (r.copy_ok === false) out.push("no-copy-receipt");
  return out;
}

/** Checks every issue card and every selected publication (optionally only those since `since`). */
export async function checkCitations(opts: { since?: Date; db?: Db } = {}): Promise<CitationResult> {
  const db = opts.db ?? sql;
  const since = opts.since ?? new Date(0);
  const rows = await db<Row[]>`
    WITH cards AS (
      SELECT 'issue' AS kind, ui.article_id, ui.project_id, ui.listed_at AS at FROM user_issue_items ui
      UNION ALL
      SELECT 'selected', p.article_id, NULL, p.listed_at FROM publications p WHERE p.selected
    )
    SELECT c.kind, c.article_id, p.article_id IS NOT NULL AS has_pub, coalesce(p.visibility = 'public', false) AS public,
           coalesce(p.url, a.url) AS url, s.name AS source_name, p.published_at,
           EXISTS (SELECT 1 FROM analyses an WHERE an.id = p.analysis_id AND an.article_id = c.article_id) AS analysis_ok,
           CASE WHEN c.kind = 'issue' THEN EXISTS (
             SELECT 1 FROM issue_card_copy cc JOIN receipts r ON r.id = cc.receipt_id
             WHERE cc.article_id = c.article_id AND cc.project_id = c.project_id) END AS copy_ok
    FROM cards c
    LEFT JOIN publications p ON p.article_id = c.article_id
    LEFT JOIN articles a ON a.id = c.article_id
    LEFT JOIN sources s ON s.id = coalesce(p.source_id, a.source_id)
    WHERE c.at >= ${since}
    ORDER BY c.kind, c.article_id`;
  const problems: CitationResult["problems"] = {};
  const broken: CitationResult["broken"] = [];
  for (const r of rows) {
    const ps = problemsOf(r);
    for (const p of ps) problems[p] = (problems[p] ?? 0) + 1;
    if (ps.length) broken.push({ kind: r.kind, articleId: r.article_id, problems: ps });
  }
  return { cards: rows.length, complete: rows.length - broken.length, completeRate: ratio(rows.length - broken.length, rows.length), problems, broken };
}

export interface CitationSampleCase {
  caseId: string;
  card: { title: string; core: string; summary: string };
  /** evidenceSpan: a short quote of the original that carries the card's main statement ("" when none could be found). */
  gold: { chain: "complete" | "broken"; support: "supported" | "partial" | "unsupported"; unsupported: string[]; evidenceSpan: string };
}

/** The manual sample: share of cards whose every statement the original supports. */
export function evalCitationSample(cases: CitationSampleCase[]) {
  const by = (s: string) => cases.filter((c) => c.gold.support === s).length;
  return {
    cards: cases.length,
    chainComplete: ratio(cases.filter((c) => c.gold.chain === "complete").length, cases.length),
    /** 抽检引文可定位率: the card's main statement could be found in the original. */
    located: ratio(cases.filter((c) => c.gold.evidenceSpan.trim()).length, cases.length),
    fullySupported: ratio(by("supported"), cases.length),
    partlySupported: by("partial"),
    unsupported: by("unsupported"),
    unsupportedStatements: cases.flatMap((c) => c.gold.unsupported.map((u) => ({ caseId: c.caseId, statement: u }))),
  };
}
