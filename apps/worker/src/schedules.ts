// Cron-style schedules (Asia/Shanghai). Each run is recorded in job_runs; missed slots run once.
import type { PgBoss } from "pg-boss";
import { dropQueues, ensureQueue, recordRun } from "@topka/backend/jobs/queue";
import { sweepUnprocessed } from "@topka/backend/jobs/content";
import { scoreDiscoveredForProjects } from "@topka/backend/projects/discovered";
import { collectDiscoveryChannels, runPromotionGate } from "@topka/backend/discovery/signals";
import { adaptIntervals, scheduleDueSources } from "@topka/backend/sources/collect";
import { scheduleMpReconcile } from "@topka/backend/sources/mp";
import { refreshSourceIcons } from "@topka/backend/sources/icons";
import { dailyRetention } from "@topka/backend/operations/retention";
import { checkAlerts, sendDigest } from "@topka/backend/operations/alerts";
import { autoReleaseUnknownReceipts } from "@topka/backend/admin/runs";
import { forwardPendingFeedback } from "@topka/backend/operations/feedback";
import { backupConfigured, runBackup } from "@topka/backend/operations/backup";
import { sourceHealthWeekly } from "@topka/backend/operations/reports";
import { markStalePendingReceipts } from "@topka/backend/providers/receipts";

interface Scheduled {
  name: string;
  cron: string;
  run: () => Promise<unknown>;
  missed?: "skip" | "once";
}

const collecting = process.env.COLLECT_ENABLED !== "false";

export const SCHEDULES: Scheduled[] = [
  { name: "content.sweep", cron: "*/5 * * * *", run: sweepUnprocessed },
  // Reports a broad feed stored first and a project's source listed too: scored for that project.
  { name: "projects.discovered", cron: "3,18,33,48 * * * *", run: () => scoreDiscoveredForProjects() },
  // Discovery channels (free RSS; docs/discovery.md): read hourly into pending signals; the promotion
  // gate also runs on its own, so a signal is promoted soon after the observation that confirms it.
  { name: "discovery.gate", cron: "9,39 * * * *", run: () => runPromotionGate() },
  { name: "ops.retention", cron: "30 3 * * *", missed: "once", run: () => dailyRetention() },
  { name: "sources.icons", cron: "40 4 * * *", missed: "once", run: () => refreshSourceIcons() },
  // Work a stopped process left half way becomes visible, and unknown paid requests get their one
  // automatic release, before the alerts look.
  {
    name: "ops.recover",
    cron: "*/10 * * * *",
    run: async () => ({ receipts: await markStalePendingReceipts(), released: await autoReleaseUnknownReceipts() }),
  },
  { name: "ops.alerts", cron: "*/10 * * * *", run: () => checkAlerts() },
  // One message with the follow-ups that do not touch readers (nothing when there are none).
  { name: "ops.digest", cron: "0 9 * * *", missed: "once", run: () => sendDigest() },
  // Feedback that did not reach the internal Feishu chat when it was sent (off with FEISHU_INTERNAL_ENABLED).
  { name: "feedback.forward", cron: "*/10 * * * *", run: () => forwardPendingFeedback() },
  ...(backupConfigured() ? [{ name: "ops.backup", cron: "10 4 * * *", missed: "once" as const, run: () => runBackup() }] : []),
  { name: "reports.source-health", cron: "0 9 * * 1", missed: "once", run: () => sourceHealthWeekly() },
  ...(collecting
    ? [
        { name: "sources.schedule", cron: "* * * * *", run: () => scheduleDueSources() },
        { name: "sources.adapt-intervals", cron: "20 4 * * *", run: adaptIntervals },
        { name: "discovery.channels", cron: "26 * * * *", run: () => collectDiscoveryChannels() },
        // WeChat official accounts (paid), each once per its interval.
        { name: "sources.mp-reconcile", cron: "*/15 * * * *", run: () => scheduleMpReconcile() },
      ]
    : []),
];

export async function registerSchedules(boss: PgBoss) {
  for (const s of SCHEDULES) {
    const queue = `cron.${s.name}`;
    await ensureQueue(queue, { policy: "singleton", retryLimit: 1, expireInSeconds: 3600 });
    await boss.schedule(queue, s.cron, {}, { tz: "Asia/Shanghai", missed: s.missed ?? "skip" });
    // Schedules fire at minute boundaries; a 15 s pickup keeps them on time with a third of the polling.
    await boss.work(queue, { pollingIntervalSeconds: 15 }, async () => recordRun(s.name, s.run));
  }
  // A schedule removed from the table (a module switched off) must not keep firing from an earlier run.
  const names = new Set(SCHEDULES.map((s) => `cron.${s.name}`));
  for (const existing of await boss.getSchedules()) {
    if (!existing.name.startsWith("cron.") || names.has(existing.name)) continue;
    await boss.unschedule(existing.name);
    await dropQueues([existing.name]);
  }
}
