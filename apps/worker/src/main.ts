// Worker process: queues and schedules for collection, processing, events, reports, monitors and ops.
import { assertProductionSecrets } from "@topka/backend/config";
import { FEATURES } from "@topka/industry/features";
import { closeDb, sql } from "@topka/backend/db";
import { getBoss, stopBoss } from "@topka/backend/jobs/queue";
import { registerContentJobs } from "@topka/backend/jobs/content";
import { registerSourceJobs } from "@topka/backend/jobs/sources";
import { registerEventJobs } from "@topka/backend/jobs/events";
import { registerNotifyJobs } from "@topka/backend/jobs/notify";
import { registerPublicationJobs } from "@topka/backend/jobs/publication";
import { registerSchedules } from "./schedules.ts";
import { ensureContentTargets } from "@topka/backend/notify/deliver";
import { startHeartbeat } from "@topka/backend/operations/heartbeat";
import { loadPlugins } from "@topka/backend/plugins";
import { freeGuardOn, freeStatus } from "@topka/backend/providers/free-models";

assertProductionSecrets([["auth", "IMG_PROXY_SIGN_SECRET"]]);

await loadPlugins();
await ensureContentTargets();
const boss = await getBoss();
await registerContentJobs(boss);
if (process.env.COLLECT_ENABLED !== "false") await registerSourceJobs(boss);
await registerEventJobs(boss);
await registerNotifyJobs(boss);
await registerPublicationJobs(boss);
await registerSchedules(boss);
// A new site has no leaderboard until the first scheduled round: compute one now.
if (FEATURES.leaderboard) {
  const [published] = await sql`SELECT 1 FROM lb_runs WHERE status = 'published' LIMIT 1`;
  if (!published) await boss.send("cron.leaderboard.round", {}, { singletonKey: "first-round" });
}
const heartbeat = startHeartbeat("worker");
// Free-only deployments re-verify their candidates at start (and then hourly, on use).
for (const kind of ["llm", "embedding"] as const) {
  if (!freeGuardOn(kind)) continue;
  void freeStatus(kind, { refresh: true }).then((s) => {
    console.log(JSON.stringify({ level: s.ok ? "info" : "warn", msg: s.ok ? "free models verified" : kind === "llm" ? "NO_FREE_MODEL" : "NO_FREE_EMBEDDING", kind, candidates: s.candidates, error: s.error }));
  });
}
console.log(JSON.stringify({ level: "info", msg: "worker started", pid: process.pid }));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "worker stopping" }));
  clearInterval(heartbeat);
  await stopBoss();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
