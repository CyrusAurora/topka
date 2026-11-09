// A source's on/off switch decides more than collection: content of a switched-off source is not sent
// to any model step either (analysis, body extraction, grouping, translation, digests, reports). It
// stays in the database as it is; switching the source back on lets the safety net pick it up again.
import { sql, type Db } from "../db.ts";

/** Whether the article's source is switched on; a missing article or source counts as off. */
export async function articleSourceEnabled(articleId: string, db: Db = sql): Promise<boolean> {
  const [row] = await db<{ enabled: boolean }[]>`
    SELECT s.enabled FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  return row?.enabled === true;
}
