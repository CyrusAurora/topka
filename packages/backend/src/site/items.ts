// Old item links (/items/:id from an RSS reader or a shared card) lead to the original article.
import { sql } from "../db.ts";

/** The original article of a public item; null for an unknown, withdrawn or out-of-pool one. */
export async function itemOriginal(id: string): Promise<{ id: string; originalUrl: string } | null> {
  const [row] = await sql<{ url: string }[]>`
    SELECT url FROM publications WHERE article_id = ${id} AND visibility = 'public' AND eligible`;
  return row ? { id, originalUrl: row.url } : null;
}
