// Collection jobs: per-source fetch runs and body extraction before analysis.
import type { PgBoss } from "pg-boss";
import { collectSource, collectXShard } from "../sources/collect.ts";
import { checkMpAccount } from "../sources/mp.ts";
import { fetchLogLine } from "../sources/fetch-log.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import { registerExtractionJobs } from "./content.ts";

export async function registerSourceJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.fetchSource);
  await boss.work<{ sourceId: string; force?: boolean }>(QUEUES.fetchSource, { localConcurrency: Number(process.env.FETCH_CONCURRENCY || 8), pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    const result = await collectSource(job.data.sourceId, { force: job.data.force });
    // A line here is what `docker compose logs -f worker` shows; see fetch-log.ts for what stays quiet.
    const log = fetchLogLine(result);
    if (log?.level === "warn") console.warn(log.line);
    else if (log) console.log(log.line);
    return result;
  });
  await ensureQueue(QUEUES.fetchXShard);
  // One search per shard of X accounts; the SocialData per-minute budget is shared with the reset monitor.
  await boss.work<{ key: string; sourceIds: string[] }>(QUEUES.fetchXShard, { localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    return collectXShard(job.data.key, job.data.sourceIds);
  });
  await ensureQueue(QUEUES.mpCheck);
  // Dajiala allows a few requests per second; two accounts at a time stays well under it.
  await boss.work<{ sourceId: string; reason?: "schedule" | "manual" }>(QUEUES.mpCheck, { localConcurrency: 2, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return;
    return checkMpAccount(job.data.sourceId, job.data.reason ?? "schedule");
  });
  await registerExtractionJobs(boss);
}
