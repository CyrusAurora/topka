// Sends one test message through the operations alert outlets (ALERT_WEBHOOK_URL and/or the Feishu
// alert chat) and says what happened, so a new address can be checked right after it is set.
//   node --env-file=.env scripts/alert-test.ts        (npm run alerts:test)
// Exit code 0 when an outlet took it, 1 when one refused it, 2 when no outlet is configured.
import { closeDb, sql } from "@topka/backend/db";
import { beijingStamp, sendAlert } from "@topka/backend/notify/feishu";

const now = Date.now();
const result = await sendAlert("🧪 告警通道测试", [
  `这是一条测试消息（${beijingStamp(now)}），收到说明告警能送到这里。`,
  "不用处理。以后网站出问题、恢复时都会发到这里。",
], now);
const [state] = await sql<{ value: { lastError?: { at: string; error: string } } }[]>`SELECT value FROM settings WHERE key = 'alerts.webhook'`;
await closeDb();
const lines: Record<typeof result, string> = {
  sent: "sent: an outlet accepted the test message",
  skipped: "skipped: the same text or the hourly limit held it back (ALERT_WEBHOOK_DEDUPE_MINUTES / ALERT_WEBHOOK_MAX_PER_HOUR)",
  disabled: "disabled: set ALERT_WEBHOOK_URL (or FEISHU_INTERNAL_ENABLED=true with the Feishu app) and restart",
  failed: `failed: ${state?.value.lastError?.error ?? "see the log line above"}`,
};
console.log(lines[result]);
process.exit(result === "sent" || result === "skipped" ? 0 : result === "failed" ? 1 : 2);
