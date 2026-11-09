// Daily IndexNow submission. Since the Topka public pages were retired there are no new indexable
// URLs, so the list is empty; INDEXNOW_SUBMIT_ENABLED and INDEXNOW_KEY still gate any send.
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { siteUrl } from "../publication/links.ts";

export async function submitIndexNow(now = new Date()) {
  // The old public item, report and story pages are retired (they redirect), so there is nothing new
  // to announce; the job keeps its watermark and reports "empty".
  const urls: string[] = [];
  let status: "sent" | "disabled" | "empty" | "failed" = urls.length ? "disabled" : "empty";
  let httpStatus: number | null = null;
  const key = config.indexNowKey;
  if (urls.length && config.indexNowSubmitEnabled && key) {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: new URL(config.siteUrl).host, key, keyLocation: siteUrl(`/${key}.txt`), urlList: urls }),
      signal: AbortSignal.timeout(30_000),
    });
    httpStatus = res.status;
    status = res.ok ? "sent" : "failed";
  }
  if (status !== "failed") {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES ('indexnow.watermark', ${sql.json({ since: now.toISOString() })}, 'worker')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }
  return { status, httpStatus, urls: urls.length, sample: urls.slice(0, 3) };
}
