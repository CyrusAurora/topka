// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { BudgetExceededError, ReceiptBusyError } from "../providers/receipts.ts";
import { settleNonEditorial } from "./content.ts";
import { articleSourceEnabled } from "../sources/enabled.ts";
import { ensureQueue, enqueue, QUEUES } from "./queue.ts";

export async function registerEventJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.group);
  // Serial on purpose: two reports of the same new fact must not both create it.
  await boss.work<{ articleId: string; signalOnly?: boolean; force?: boolean }>(QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => {
    if (!job) return;
    // A switched-off source's posts are not grouped (grouping asks models); an admin's explicit regroup is.
    if (!job.data.force && !(await articleSourceEnabled(job.data.articleId))) return { verdict: "source-off" };
    try {
      // A discussion post comes here straight from collection: record it first (settleNonEditorial).
      if (job.data.signalOnly && !job.data.force && !(await settleNonEditorial(job.data.articleId)).group) return { verdict: "skipped" };
      const result = await groupArticle(job.data.articleId, { signalOnly: job.data.signalOnly, force: job.data.force });
      if (result.storyId && !result.verdict.startsWith("signal")) {
        await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
      }
      return result;
    } catch (error) {
      // A full budget or no free model is not the article's fault: it waits (a fresh job after the
      // window) instead of spending the job's retries and dropping out of grouping.
      if (error instanceof BudgetExceededError) {
        await enqueue(QUEUES.group, job.data, { singletonKey: job.data.force ? `${job.id}:wait` : job.data.articleId, startAfter: error.retryAfterSeconds });
        return { verdict: "waiting", retryAfterSeconds: error.retryAfterSeconds, reason: error.message };
      }
      if (error instanceof ReceiptBusyError) throw error;
      throw error;
    }
  });
  await ensureQueue(QUEUES.digest);
  await boss.work<{ storyId: number; afterCorrection?: boolean }>(QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    try {
      return await composeStoryDigest(job.data.storyId, { afterCorrection: job.data.afterCorrection });
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      await enqueue(QUEUES.digest, job.data, { singletonKey: `story:${job.data.storyId}`, startAfter: error.retryAfterSeconds });
      return { waiting: true, retryAfterSeconds: error.retryAfterSeconds };
    }
  });
}
