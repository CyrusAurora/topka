# Operations alerts

The worker checks the site every 10 minutes (`ops.alerts`) and tells the owner when readers are
affected, when money or an owner action is involved, and when it has healed. Messages are written for
the site owner, not an engineer: what readers see, whether it heals by itself, what to do, and a last
line of detail to forward to an engineer or AI. Code: `packages/backend/src/operations/alerts.ts`.

## Levels

| level | when | sent | repeated | recovery |
| --- | --- | --- | --- | --- |
| 🔴 now | readers affected and not healed | at once | hourly while it lasts | ✅ one message |
| 🟠 today | money at risk, or only the owner can act | at once | at most daily | ✅ one message |
| digest | follow-ups without reader impact | 09:00, one message a day | daily | — |

Among the checks: no new article for `ALERT_QUIET_MINUTES` (content.collect); **many sources failing
in a row** — 3 or more sources, or a quarter of the scheduled ones, with `ALERT_SOURCE_FAILS` (3)
failed fetches in a row (content.fetch: a proxy, DNS or network outage); new content stuck in
processing; the daily report missing after 10:00; a paid provider refusing us; **a daily budget used
up** (`budgets` table); content-group pushes refused; backups failing.

## Where alerts go

Two outlets, either or both; with neither, alerts are only logged (`alert (not sent: …)`).

1. **A webhook** — `ALERT_WEBHOOK_URL`. The body is a Feishu custom-bot text message:

   ```json
   {"msg_type": "text", "content": {"text": "🔴 很多信源连续抓取失败\n影响：…"}}
   ```

   so the address can be a Feishu (or Lark) group bot, or anything that accepts that JSON (a relay to
   another chat tool, a test receiver). With `ALERT_WEBHOOK_SECRET` set, each message carries
   `timestamp` and `sign` as Feishu's "signature verification" expects. A reply other than HTTP 2xx
   with `{"code":0}` (or a plain 2xx) counts as refused.
2. **The Feishu message app** — `FEISHU_INTERNAL_ENABLED=true` with `FEISHU_APP_ID`,
   `FEISHU_APP_SECRET` and `FEISHU_ALERT_CHAT_ID` (falls back to `FEISHU_INTERNAL_CHAT_ID`).

Outside production every message starts with the environment name (`【staging】…`, from
`TOPKA_ENVIRONMENT`), so a test site is never mistaken for the real one.

### Setting up a Feishu group bot (no code change)

1. In the Feishu group that should receive alerts: group settings → **Bots** → **Add bot** →
   **Custom bot**. Name it (for example "Topka alerts") and copy the **webhook address**
   (`https://open.feishu.cn/open-apis/bot/v2/hook/…`).
2. Optional but recommended: under **Security settings** choose **Signature verification** and copy
   the secret. (Keyword or IP allow-list settings also work; a keyword must appear in every message —
   "已恢复" does not, so prefer the signature.)
3. In `.env` on the server:

   <!-- doc-test: skip lines for .env with placeholder values, not commands -->
   ```bash
   ALERT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
   ALERT_WEBHOOK_SECRET=xxxxxxxx   # only if signature verification is on
   ```

4. Restart so the processes read it (`docker compose up -d`; without Docker restart api and worker),
   then send a test message:

   <!-- doc-test: run quickstart; exit 2; expect disabled: -->
   ```bash
   docker compose exec api npm run alerts:test   # without Docker: npm run alerts:test
   ```

   It prints `sent`, `failed: <reason>` (for example `code 19021 sign match fail…` for a wrong
   secret or a server clock more than an hour off) or `disabled`.

To move alerts somewhere else later, change `ALERT_WEBHOOK_URL` and restart; to stop them, remove it.
The address contains the bot's token: treat it as a secret (logs show only its host).

## Not too many, never lost silently

- **Per problem**: an open problem is repeated only at its level's interval (hourly / daily) and
  closed with one recovery message (`settings.alerts.state`).
- **Per text** (webhook): the same text is not sent twice within `ALERT_WEBHOOK_DEDUPE_MINUTES` (30).
- **Per hour** (webhook): at most `ALERT_WEBHOOK_MAX_PER_HOUR` (20) messages in any rolling hour; the
  next message that goes out adds "另有 N 条告警因限流没有发出". Both guards are kept in the database
  (`settings.alerts.webhook`), so they hold across restarts and processes.
- **Undelivered**: when a configured outlet refuses or cannot be reached, the alert (or the recovery)
  is not marked as sent; the next run, 10 minutes later, sends it again. The last refusal is kept in
  `settings.alerts.webhook.lastError`.

## Drill

Run a drill whenever the outlet changes, against a staging database, never production data:

1. A local receiver standing in for the bot (any HTTP server that logs POST bodies and answers
   `{"code":0}`), and `ALERT_WEBHOOK_URL` pointing at it for the drill process only.
2. **Collection failure**: one enabled RSS source whose feed answers 503 (staging needs
   `ALLOW_PRIVATE_NETWORK_FETCH=true` to reach a local feed); collect it three times, run
   `checkAlerts()` → 🔴 很多信源连续抓取失败 (and 🔴 网站停止收录新内容 on an empty database).
3. **Budget trip**: lower one service's `budgets.per_day` in staging (for example `jina` to 3) and
   make more calls than that through `paidRequest` with a local fake call (no provider is contacted,
   nothing is paid) → 🟠 …调用额度用完了.
4. Run `checkAlerts()` again at once → nothing (dedupe).
5. Heal both (the feed answers 200 and a collection succeeds; the budget is restored) → ✅ 已恢复 for each.

The record of the first drill (2026-11-17), with the scripts used, is kept with the operator's notes.
