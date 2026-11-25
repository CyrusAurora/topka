// Scores a project's current today candidates against the project's intent when they have no project
// score yet (analysed before project scoring existed) or an outdated one (prompt or project changed).
// Two model calls per article (shared by every project that follows its source); an unchanged input
// reuses its receipts. Stops quietly when the model budget or the free quota is used up.
//   node --env-file=.env scripts/project-rescore.ts --project ID_OR_SLUG [--hours 24] [--max N] [--dry-run]
import { parseArgs } from "node:util";
import { closeDb, sql } from "@topka/backend/db";
import { config } from "@topka/backend/config";
import { scoreForProjects, SCORE_CALLS } from "@topka/backend/editorial/analyze";
import { PROJECT_SCORE_VERSION } from "@topka/backend/editorial/project-score";
import { BudgetExceededError } from "@topka/backend/providers/receipts";
import { stopBoss } from "@topka/backend/jobs/queue";
import { loadPlugins } from "@topka/backend/plugins";

await loadPlugins();

const USAGE = "usage: project-rescore.ts --project ID_OR_SLUG [--hours 24] [--max N] [--dry-run]";
let values;
try {
  ({ values } = parseArgs({ args: process.argv.slice(2), options: { project: { type: "string" }, hours: { type: "string" }, max: { type: "string" }, "dry-run": { type: "boolean" } }, strict: true, allowPositionals: false }));
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}
if (!values.project) {
  console.error(USAGE);
  process.exit(2);
}
const hours = Number(values.hours ?? 24);
const max = values.max === undefined ? Infinity : Number(values.max);

try {
  const [project] = await sql<{ id: string; target: string; revision: number }[]>`
    SELECT id, target, current_revision AS revision FROM tracking_projects WHERE id = ${values.project} OR slug = ${values.project}`;
  if (!project) {
    console.error(`没有这个项目：${values.project}`);
    process.exitCode = 1;
  } else {
    const rows = await sql<{ id: string; title: string }[]>`
      SELECT p.article_id AS id, p.title FROM publications p
      JOIN project_sources ps ON ps.source_id = p.source_id AND ps.project_id = ${project.id} AND NOT ps.paused
      JOIN sources s ON s.id = p.source_id AND s.enabled
      JOIN articles a ON a.id = p.article_id
      LEFT JOIN project_scores sc ON sc.project_id = ${project.id} AND sc.article_id = p.article_id
      WHERE p.visibility = 'public' AND p.eligible AND greatest(p.listed_at, coalesce(p.visible_after, p.listed_at)) > now() - make_interval(hours => ${hours})
        AND (NOT p.backfill OR (a.backfill_reason = 'first-import' AND p.published_at > now() - interval '24 hours'))
        AND (sc.article_id IS NULL OR sc.prompt_version <> ${PROJECT_SCORE_VERSION} OR sc.project_revision <> ${project.revision} OR sc.input_revision <> a.revision)
      ORDER BY p.score DESC NULLS LAST, p.article_id`;
    const todo = rows.slice(0, Number.isFinite(max) ? max : undefined);
    console.log(`${project.target}：${rows.length} 条待按项目打分，本次 ${todo.length} 条，约 ${todo.length * SCORE_CALLS} 次模型调用`);
    if (!values["dry-run"]) {
      if (!config.modelCallsEnabled) throw new Error("MODEL_CALLS_ENABLED is off");
      let done = 0;
      for (const r of todo) {
        try {
          const runs = await scoreForProjects(r.id);
          const mine = runs?.find((x) => x.project.id === project.id);
          done++;
          console.log(`${mine ? Math.floor(mine.values.reduce((t, v) => t + v, 0) / mine.values.length) : "-"}\t${r.title}`);
        } catch (error) {
          if (error instanceof BudgetExceededError) {
            console.log(`额度用完，停在第 ${done} 条：${error.message}`);
            break;
          }
          throw error;
        }
      }
    }
  }
} finally {
  await stopBoss();
  await closeDb();
}
