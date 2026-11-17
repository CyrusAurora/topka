// Operations alerts to a generic, Feishu-compatible webhook (ALERT_WEBHOOK_URL): the Feishu text
// body (signed when ALERT_WEBHOOK_SECRET is set), dedupe of the same text, an hourly rate limit that
// reports what it held back, refusals that keep the alert open so the next run retries it, the
// recovery message, and the "many sources keep failing" finding that a collection outage raises.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { getBoss, stopBoss } from "@topka/backend/jobs/queue";
import { checkAlerts, collectFindings } from "@topka/backend/operations/alerts";
import { feishuSign, sendWebhookAlert, webhookBody } from "@topka/backend/notify/webhook";

const T = tag();
const SOURCES = [0, 1, 2].map((i) => `test-alert-hook-${T}-${i}`);
type Body = { msg_type: string; content: { text: string }; timestamp?: string; sign?: string };
const received: Body[] = [];
let answer: () => unknown = () => ({ code: 0, msg: "success" });
const hook = await stub((_hit, req) => {
  received.push(JSON.parse(req.body) as Body);
  return answer();
});
let saved: { key: string; value: unknown }[] = [];

before(async () => {
  await getBoss();
  saved = await sql`SELECT key, value FROM settings WHERE key IN ('alerts.state', 'alerts.webhook', 'heartbeat.worker')`;
  await sql`DELETE FROM settings WHERE key IN ('alerts.state', 'alerts.webhook')`;
});
beforeEach(async () => {
  received.length = 0;
  answer = () => ({ code: 0, msg: "success" });
  await sql`DELETE FROM settings WHERE key = 'alerts.webhook'`;
  process.env.ALERT_WEBHOOK_URL = `${hook.url}/open-apis/bot/v2/hook/test-token`;
  delete process.env.ALERT_WEBHOOK_SECRET;
  delete process.env.ALERT_WEBHOOK_MAX_PER_HOUR;
  delete process.env.ALERT_WEBHOOK_DEDUPE_MINUTES;
});
after(async () => {
  delete process.env.ALERT_WEBHOOK_URL;
  await sql`DELETE FROM sources WHERE id IN ${sql(SOURCES)}`;
  await sql`DELETE FROM settings WHERE key IN ('alerts.state', 'alerts.webhook')`;
  for (const s of saved) await sql`INSERT INTO settings (key, value, updated_by) VALUES (${s.key}, ${sql.json(s.value as never)}, 'test') ON CONFLICT (key) DO NOTHING`;
  await hook.close();
  await stopBoss();
  await closeDb();
});

test("off without ALERT_WEBHOOK_URL: nothing is sent", async () => {
  delete process.env.ALERT_WEBHOOK_URL;
  assert.equal(await sendWebhookAlert("hello"), "disabled");
  assert.equal(received.length, 0);
});

test("the body is a Feishu custom-bot text message, signed when a secret is set", async () => {
  assert.equal(await sendWebhookAlert(`plain ${T}`), "sent");
  assert.deepEqual(received[0], { msg_type: "text", content: { text: `plain ${T}` } });

  process.env.ALERT_WEBHOOK_SECRET = "bot-secret";
  const now = Date.UTC(2026, 10, 17, 9, 0, 0);
  assert.equal(await sendWebhookAlert(`signed ${T}`, now), "sent");
  const b = received[1]!;
  assert.equal(b.timestamp, String(now / 1000));
  assert.equal(b.sign, feishuSign(now / 1000, "bot-secret"));
  // The algorithm of Feishu's docs (timestamp 1599360473 and secret "demo" from its example), the value
  // computed independently with Python's hmac: base64(HMAC-SHA256(key = "1599360473\ndemo", msg = "")).
  assert.equal(webhookBody("x", "demo", 1599360473_000).sign, "l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=");
});

test("the same text is sent once within the dedupe window, again after it", async () => {
  const t0 = Date.now();
  assert.equal(await sendWebhookAlert(`dup ${T}`, t0), "sent");
  assert.equal(await sendWebhookAlert(`dup ${T}`, t0 + 10 * 60_000), "deduped");
  assert.equal(await sendWebhookAlert(`other ${T}`, t0 + 11 * 60_000), "sent");
  assert.equal(await sendWebhookAlert(`dup ${T}`, t0 + 31 * 60_000), "sent");
  assert.equal(received.length, 3);
});

test("over the hourly limit messages are held back and the next one says how many", async () => {
  process.env.ALERT_WEBHOOK_MAX_PER_HOUR = "2";
  const t0 = Date.now();
  assert.equal(await sendWebhookAlert(`a ${T}`, t0), "sent");
  assert.equal(await sendWebhookAlert(`b ${T}`, t0 + 1000), "sent");
  assert.equal(await sendWebhookAlert(`c ${T}`, t0 + 2000), "limited");
  assert.equal(await sendWebhookAlert(`d ${T}`, t0 + 3000), "limited");
  assert.equal(received.length, 2);
  assert.equal(await sendWebhookAlert(`e ${T}`, t0 + 3600_000 + 1000), "sent");
  assert.match(received[2]!.content.text, /^e .*\n（另有 2 条告警因限流没有发出/);
  assert.equal(await sendWebhookAlert(`f ${T}`, t0 + 3600_000 + 2000), "sent");
  assert.doesNotMatch(received[3]!.content.text, /限流/, "the count is reported once");
});

test("a refusal (HTTP error, Feishu code ≠ 0, unreachable) is 'failed' and remembered", async () => {
  answer = () => ({ code: 19021, msg: "sign match fail or timestamp is not within one hour from current time" });
  assert.equal(await sendWebhookAlert(`refused ${T}`), "failed");
  answer = () => new Reply(500, { error: "boom" });
  assert.equal(await sendWebhookAlert(`refused ${T}`), "failed", "a failed send is not a duplicate of itself");
  const [s] = await sql<{ value: { lastError?: { error: string } } }[]>`SELECT value FROM settings WHERE key = 'alerts.webhook'`;
  assert.match(s!.value.lastError!.error, /HTTP 500/);
  process.env.ALERT_WEBHOOK_URL = "http://127.0.0.1:1/unreachable";
  assert.equal(await sendWebhookAlert(`refused ${T}`), "failed");
});

test("a collection outage raises 'many sources keep failing'; an alert nobody took is retried; recovery goes out", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "false";
  await sql`DELETE FROM settings WHERE key = 'alerts.state'`;
  for (const id of SOURCES) {
    await sql`INSERT INTO sources (id, name, kind, enabled, next_fetch_at, fail_count, last_error, last_ok_at)
              VALUES (${id}, 'Test alert hook', 'rss', true, '2100-01-01', 4, 'HTTP 503 Service Unavailable', now() - interval '2 hours')`;
  }
  const fetchKeys = (sent: string[]) => sent.filter((k) => k.startsWith("content.fetch"));
  const finding = (await collectFindings()).find((f) => f.key === "content.fetch");
  assert.ok(finding, "three sources failing in a row is an outage");
  assert.equal(finding.level, "now");
  assert.match(finding.detail ?? "", /HTTP 503/);

  const t0 = Date.now();
  // The receiver is down: the alert stays unsent and the next run tries again.
  answer = () => new Reply(502, { error: "bad gateway" });
  let r = await checkAlerts(t0);
  assert.deepEqual(fetchKeys(r.sent), []);
  assert.ok(!r.open.includes("content.fetch"));
  answer = () => ({ code: 0 });
  r = await checkAlerts(t0 + 10 * 60_000);
  assert.deepEqual(fetchKeys(r.sent), ["content.fetch"]);
  assert.ok(received.some((b) => b.content.text.includes("很多信源连续抓取失败")));
  r = await checkAlerts(t0 + 20 * 60_000);
  assert.deepEqual(fetchKeys(r.sent), [], "no repeat within the hour");

  // Fetches work again: one recovery message (kept open while the receiver refuses it).
  await sql`UPDATE sources SET fail_count = 0, last_error = NULL, last_ok_at = now() WHERE id IN ${sql(SOURCES)}`;
  answer = () => new Reply(503, {});
  r = await checkAlerts(t0 + 30 * 60_000);
  assert.deepEqual(fetchKeys(r.sent), []);
  assert.ok(r.open.includes("content.fetch"), "an undelivered recovery keeps the alert open");
  answer = () => ({ code: 0 });
  r = await checkAlerts(t0 + 40 * 60_000);
  assert.deepEqual(fetchKeys(r.sent), ["content.fetch:recovered"]);
  assert.ok(received.some((b) => b.content.text.includes("✅ 已恢复：很多信源连续抓取失败")));
  r = await checkAlerts(t0 + 50 * 60_000);
  assert.deepEqual(fetchKeys(r.sent), []);
});
