// Operations alerts to a generic webhook. The body is a Feishu custom-bot text message
// ({"msg_type":"text","content":{"text":"…"}}), so ALERT_WEBHOOK_URL can be a Feishu (or Lark) group
// bot address, or any receiver that accepts that JSON (a relay to Slack, WeCom, a local mock).
// Changing the address is an .env change and a restart, never a code change.
//
// Off unless ALERT_WEBHOOK_URL is set (same rule as every outward valve: nothing is sent by default).
// ALERT_WEBHOOK_SECRET, when set, signs each message the way Feishu's "signature verification" expects.
//
// Two guards in front of the receiver, both kept in the database so they hold across restarts and
// across the api and worker processes:
//   dedupe     — the same text is not sent twice within ALERT_WEBHOOK_DEDUPE_MINUTES (default 30);
//   rate limit — at most ALERT_WEBHOOK_MAX_PER_HOUR messages in any rolling hour (default 20; a
//                Feishu bot allows 100 a minute, so this is about the reader, not the bot). Messages
//                over the limit are counted and the next message that goes out says how many.
// Recovery messages carry their own duration, so they are never mistaken for duplicates.
import { createHash, createHmac } from "node:crypto";
import { credential } from "../config.ts";
import { sql } from "../db.ts";

export type WebhookResult = "sent" | "deduped" | "limited" | "failed" | "disabled";

const STATE_KEY = "alerts.webhook";
const HOUR = 3600_000;

interface WebhookState {
  /** Messages sent in the last hour (or the dedupe window, whichever is longer). */
  sent: Array<{ at: string; hash: string }>;
  /** Messages held back by the rate limit since the last one that went out. */
  suppressed: number;
  lastError?: { at: string; error: string };
}

export const alertWebhookUrl = () => credential("integrations", "ALERT_WEBHOOK_URL");
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Feishu custom-bot signature: base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, message = "")). */
export function feishuSign(timestamp: number, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

export function webhookBody(text: string, secret: string | null, now = Date.now()): Record<string, unknown> {
  const body: Record<string, unknown> = { msg_type: "text", content: { text } };
  if (secret) {
    const timestamp = Math.floor(now / 1000);
    body.timestamp = String(timestamp);
    body.sign = feishuSign(timestamp, secret);
  }
  return body;
}

/** A Feishu bot answers HTTP 200 with {"code":0} (older bots {"StatusCode":0}); anything else is a refusal. */
function refused(status: number, text: string): string | null {
  if (status < 200 || status >= 300) return `HTTP ${status} ${text.slice(0, 200)}`;
  let json: { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    return null; // a plain receiver that answers 2xx without JSON accepted it
  }
  const code = json?.code ?? json?.StatusCode ?? 0;
  return code === 0 ? null : `code ${code} ${json?.msg ?? json?.StatusMessage ?? ""}`.trim();
}

/** Send one alert text; the guards above decide whether it goes out. Never throws. */
export async function sendWebhookAlert(text: string, now = Date.now()): Promise<WebhookResult> {
  const url = alertWebhookUrl();
  if (!url) return "disabled";
  const dedupeMs = num("ALERT_WEBHOOK_DEDUPE_MINUTES", 30) * 60_000;
  const maxPerHour = num("ALERT_WEBHOOK_MAX_PER_HOUR", 20);
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);

  // One sender at a time across processes: the decision and the send are serialised on the state row.
  return sql.begin(async (tx) => {
    await tx`INSERT INTO settings (key, value, updated_by) VALUES (${STATE_KEY}, ${tx.json({ sent: [], suppressed: 0 })}, 'alerts')
             ON CONFLICT (key) DO NOTHING`;
    const [row] = await tx<{ value: WebhookState }[]>`SELECT value FROM settings WHERE key = ${STATE_KEY} FOR UPDATE`;
    const state: WebhookState = { ...row?.value, sent: row?.value.sent ?? [], suppressed: row?.value.suppressed ?? 0 };
    const keep = Math.max(HOUR, dedupeMs);
    state.sent = state.sent.filter((s) => now - Date.parse(s.at) < keep);
    const save = () => tx`UPDATE settings SET value = ${tx.json(state as never)}, updated_at = now() WHERE key = ${STATE_KEY}`;

    if (state.sent.some((s) => s.hash === hash && now - Date.parse(s.at) < dedupeMs)) {
      await save();
      return "deduped" as const;
    }
    if (state.sent.filter((s) => now - Date.parse(s.at) < HOUR).length >= maxPerHour) {
      state.suppressed += 1;
      await save();
      console.log(JSON.stringify({ level: "warn", msg: "alert webhook rate limited", maxPerHour, suppressed: state.suppressed }));
      return "limited" as const;
    }

    const body = state.suppressed > 0 ? `${text}\n（另有 ${state.suppressed} 条告警因限流没有发出，见后台“运行”页）` : text;
    let error: string | null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(webhookBody(body, credential("integrations", "ALERT_WEBHOOK_SECRET"), now)),
        signal: AbortSignal.timeout(15_000),
      });
      error = refused(res.status, await res.text());
    } catch (e) {
      error = (e as Error).message;
    }
    if (error) {
      // The address itself is a secret (it carries the bot token): log only the host.
      let host = "?";
      try { host = new URL(url).host; } catch { /* unparsable */ }
      console.log(JSON.stringify({ level: "error", msg: "alert webhook failed", host, error }));
      state.lastError = { at: new Date(now).toISOString(), error: error.slice(0, 300) };
      await save();
      return "failed" as const;
    }
    state.sent.push({ at: new Date(now).toISOString(), hash });
    state.suppressed = 0;
    await save();
    return "sent" as const;
  });
}
