// Project-aware scoring (industry/prompts/project-score.md): an article is scored against the intent of
// each tracking project that follows its source — the project's target, purpose and optional focus and
// exclusions — instead of a fixed reader. The same two independent calls the generic score makes score
// every such project at once (one JSON key per project), so following projects adds no model calls.
// Receipts key on the prompt and the input: an unchanged article and project are never scored twice.
import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { promptText, promptVersion } from "./prompts.ts";

/** At most this many projects are scored in one call; more are rare and would dilute the answer. */
export const MAX_PROJECTS_PER_SCORE = 5;
export const PROJECT_SCORE_VERSION = promptVersion("project-score");

export interface ProjectBrief {
  id: string;
  revision: number;
  target: string;
  purpose: string;
  focus: string;
  exclusions: string;
}

/**
 * Active projects that follow a source the article came from (binding not paused), oldest first: its
 * own source, or any source that also listed it (article_discoveries). One URL is one article, so a
 * report a broad feed stored first still belongs to the project whose narrower feed listed it too.
 */
export async function projectsForArticle(articleId: string, db: Db = sql): Promise<ProjectBrief[]> {
  return db<ProjectBrief[]>`
    SELECT p.id, p.current_revision AS revision, p.target, p.purpose, p.focus, p.exclusions
    FROM tracking_projects p, articles a
    WHERE a.id = ${articleId} AND p.status = 'active'
      AND EXISTS (
        SELECT 1 FROM project_sources ps WHERE ps.project_id = p.id AND NOT ps.paused
          AND (ps.source_id = a.source_id OR ps.source_id IN (SELECT d.source_id FROM article_discoveries d WHERE d.article_id = a.id)))
    ORDER BY p.created_at, p.id
    LIMIT ${MAX_PROJECTS_PER_SCORE}`;
}

const keyOf = (i: number) => `P${i + 1}`;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The projects as the prompts list them: P1, P2, … with target, purpose, focus and exclusions. */
export function projectBlock(projects: ProjectBrief[]): string {
  return projects
    .map((p, i) => {
      const lines = [`### ${keyOf(i)}`, `- 对象：${oneLine(p.target)}`, `- 目标：${oneLine(p.purpose)}`];
      if (p.focus.trim()) lines.push(`- 关注重点：${oneLine(p.focus)}`);
      if (p.exclusions.trim()) lines.push(`- 排除：${oneLine(p.exclusions)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * The prefilter for an article some project follows: the industry's AI rule, plus "relevant to one of
 * these projects passes" — a battery or fund project's sources carry news the AI rule alone blocks.
 */
export const PREFILTER_PROJECTS_VERSION = promptVersion("prefilter-projects");
export function prefilterProjectsSystem(projects: ProjectBrief[]): string {
  return promptText("prefilter-projects", { projects: projectBlock(projects) });
}

export function projectScoreSystem(projects: ProjectBrief[]): string {
  const block = projectBlock(projects);
  const keys = projects.map((_, i) => keyOf(i));
  return promptText("project-score", {
    projects: block,
    projectKeys: keys.join("、"),
    example: JSON.stringify({ projectScores: Object.fromEntries(keys.map((k) => [k, 0])) }),
  });
}

/** The answer must carry every project's key with an integer 0–100. */
export function projectScoreSchema(count: number) {
  const shape = Object.fromEntries(Array.from({ length: count }, (_, i) => [keyOf(i), z.coerce.number().int().min(0).max(100)]));
  return z.object({ projectScores: z.object(shape) }).transform((d) => Array.from({ length: count }, (_, i) => d.projectScores[keyOf(i)] as number));
}

/** A project's score for an article: the mean of the calls, floored (what the daily issue ranks by). */
export function projectScore(values: number[]): number | null {
  return values.length ? Math.floor(values.reduce((t, v) => t + v, 0) / values.length) : null;
}

export interface ProjectScoreRun {
  project: ProjectBrief;
  values: number[];
}

/** Stores the latest score per (project, article); an older input revision never overwrites a newer one. */
export async function storeProjectScores(
  db: Db,
  a: { id: string; sourceId: string; revision: number },
  runs: ProjectScoreRun[],
  meta: { model: string; receiptIds: number[] },
) {
  for (const r of runs) {
    if (!r.values.length) continue;
    const score = projectScore(r.values)!;
    await db`
      INSERT INTO project_scores (project_id, article_id, source_id, input_revision, project_revision, scores, score, model, prompt_version, receipt_ids)
      VALUES (${r.project.id}, ${a.id}, ${a.sourceId}, ${a.revision}, ${r.project.revision}, ${r.values}, ${score}, ${meta.model}, ${PROJECT_SCORE_VERSION}, ${meta.receiptIds})
      ON CONFLICT (project_id, article_id) DO UPDATE SET
        source_id = EXCLUDED.source_id, input_revision = EXCLUDED.input_revision, project_revision = EXCLUDED.project_revision,
        scores = EXCLUDED.scores, score = EXCLUDED.score, model = EXCLUDED.model, prompt_version = EXCLUDED.prompt_version,
        receipt_ids = EXCLUDED.receipt_ids, scored_at = now()
      WHERE project_scores.input_revision <= EXCLUDED.input_revision`;
  }
}
