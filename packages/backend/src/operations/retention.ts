// Daily housekeeping: old run history, files past their life and derived caches.
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { pruneAttempts } from "../accounts/lockout.ts";

/** Derived caches (proxied images and share cards) are rebuilt on demand; drop ones older than a month. */
async function pruneCache(dir: string, maxAgeMs: number, now: number): Promise<number> {
  let removed = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      const info = await stat(p).catch(() => null);
      if (info && now - info.mtimeMs > maxAgeMs) {
        await unlink(p).catch(() => {});
        removed += 1;
      }
    }
  };
  await walk(dir);
  return removed;
}

export async function dailyRetention(now = new Date()) {
  // Scheduled-task history: 30 days (failures 90) is enough for the runs view.
  const runs = await sql`DELETE FROM job_runs WHERE started_at < ${new Date(now.getTime() - 30 * 86400_000)} AND (status IS DISTINCT FROM 'failed' OR started_at < ${new Date(now.getTime() - 90 * 86400_000)})`;
  // Raw files with a bounded life.
  const files = await sql<{ key: string }[]>`DELETE FROM stored_files WHERE expires_at < ${now} RETURNING key`;
  for (const f of files) await unlink(path.join(config.dataDir, f.key)).catch(() => {});
  const monthMs = 30 * 86400_000;
  // Brief snapshots are written per view; one nobody confirmed and no checkpoint points at is history
  // only for 30 days (the append-only trigger allows exactly this delete, with the database's clock).
  const snapshots = await sql`DELETE FROM project_brief_snapshots s WHERE s.created_at < now() - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM project_checkpoint_acks a WHERE a.snapshot_id = s.snapshot_id)
    AND NOT EXISTS (SELECT 1 FROM project_read_checkpoints c WHERE c.snapshot_id = s.snapshot_id)`;
  // Refused reports with no article to explain (the article-bound ones go with their article): 180 days.
  const rejections = await sql`DELETE FROM observation_rejections WHERE article_id IS NULL AND reported_at < now() - interval '180 days'`;
  // Sign-in attempt records nobody touched for a day and that hold no lock.
  const loginThrottle = await pruneAttempts();
  const prunedCache = (await pruneCache(path.join(config.dataDir, "imgcache"), monthMs, now.getTime())) + (await pruneCache(path.join(config.dataDir, "ogcache"), monthMs, now.getTime()));
  return { deletedJobRuns: runs.count, deletedFiles: files.length, prunedCache, deletedLoginThrottle: loginThrottle, deletedBriefSnapshots: snapshots.count, deletedRejections: rejections.count };
}
