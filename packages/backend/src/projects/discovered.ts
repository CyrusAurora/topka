// A report a broad feed stored first and a project's own source listed afterwards (one URL is one
// article; the second listing is an article_discoveries row) was analysed before that project followed
// it, so it has no project score and its today card would rank on the generic one. This sweep scores
// such reports for their projects: recent, published, bounded per run (two score calls each).
import { sql } from "../db.ts";
import { config } from "../config.ts";
import { scoreForProjects } from "../editorial/analyze.ts";
import { BudgetExceededError } from "../providers/receipts.ts";

/** Reports listed by a followed source within this window are scored. */
export const DISCOVERED_WINDOW_HOURS = 48;
/** At most this many articles per run. */
export const DISCOVERED_MAX_PER_RUN = 10;

export async function scoreDiscoveredForProjects(opts: { max?: number } = {}): Promise<{ scored: number; failed: number }> {
  if (!config.modelCallsEnabled) return { scored: 0, failed: 0 };
  const rows = await sql<{ id: string }[]>`
    SELECT d.article_id AS id, max(d.discovered_at) AS seen
    FROM article_discoveries d
    JOIN articles a ON a.id = d.article_id AND a.source_id <> d.source_id
    JOIN publications pub ON pub.article_id = a.id AND pub.eligible
    JOIN project_sources ps ON ps.source_id = d.source_id AND NOT ps.paused
    JOIN tracking_projects p ON p.id = ps.project_id AND p.status = 'active'
    JOIN sources s ON s.id = d.source_id AND s.enabled
    WHERE d.discovered_at > now() - make_interval(hours => ${DISCOVERED_WINDOW_HOURS})
      AND NOT EXISTS (SELECT 1 FROM project_scores x WHERE x.project_id = p.id AND x.article_id = a.id)
    GROUP BY d.article_id
    ORDER BY seen DESC
    LIMIT ${opts.max ?? DISCOVERED_MAX_PER_RUN}`;
  let scored = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const runs = await scoreForProjects(r.id);
      if (runs?.length) scored += 1;
    } catch (error) {
      // Out of model budget: the next run picks the rest up.
      if (error instanceof BudgetExceededError) break;
      failed += 1;
    }
  }
  return { scored, failed };
}
