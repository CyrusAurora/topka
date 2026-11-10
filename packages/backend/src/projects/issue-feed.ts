// The web reminder (P0): a private Atom feed of one reader's daily issue. Zero infrastructure — no
// email, no push: the reader pastes /feed/issue/<token>.xml into any feed reader and it lights up each
// morning after 08:00 in the reader's time zone. The token is a 256-bit random capability; only its SHA-256 is kept
// (user_issue_feeds), so the URL is shown once and a new one retires the old. The feed carries only the
// reader's own fixed issues (user_issues), never anything else of theirs.
import { randomBytes } from "node:crypto";
import { sql, type Db } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { escapeXml } from "../lib/text.ts";
import { siteUrl } from "../publication/links.ts";
import { SITE } from "@topka/industry/site";
import { titleGap } from "./copy-budget.ts";
import { ensureIssue, readIssue, type Issue } from "./issues.ts";

/** How many recent issues the feed carries. */
export const ISSUE_FEED_SIZE = 14;
/** An issue whose card copy is still being written waits this long before it enters the feed anyway. */
export const ISSUE_FEED_COPY_GRACE_MS = 2 * 3600_000;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function issueFeedPath(token: string): string {
  return `/feed/issue/${token}.xml`;
}

/** Turns the feed on (or rotates it): returns the new token; the previous URL stops working at once. */
export async function rotateIssueFeed(userId: string, db: Db = sql): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db`
    INSERT INTO user_issue_feeds (user_id, token_hash) VALUES (${userId}, ${sha256(token)})
    ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), last_read_at = NULL`;
  return token;
}

export async function disableIssueFeed(userId: string, db: Db = sql): Promise<boolean> {
  const rows = await db`DELETE FROM user_issue_feeds WHERE user_id = ${userId} RETURNING user_id`;
  return rows.length > 0;
}

export interface IssueFeedState {
  enabled: boolean;
  createdAt: string | null;
  lastReadAt: string | null;
}

export async function issueFeedState(userId: string, db: Db = sql): Promise<IssueFeedState> {
  const [row] = await db<{ created_at: Date; last_read_at: Date | null }[]>`SELECT created_at, last_read_at FROM user_issue_feeds WHERE user_id = ${userId}`;
  return { enabled: !!row, createdAt: row ? row.created_at.toISOString() : null, lastReadAt: row?.last_read_at ? row.last_read_at.toISOString() : null };
}

/** The reader behind a feed token; null for a malformed, unknown or retired token. */
export async function userForIssueFeed(token: string, db: Db = sql): Promise<string | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db<{ user_id: string }[]>`
    UPDATE user_issue_feeds SET last_read_at = now() WHERE token_hash = ${sha256(token)} RETURNING user_id`;
  return row?.user_id ?? null;
}

const zhDate = (date: string) => {
  const [, m, d] = date.split("-");
  return `${Number(m)}月${Number(d)}日`;
};

/** The whole card title: the lead half (often a kicker such as「VicOne 测试：」) never stands alone. */
function wholeTitle(it: Issue["items"][number]): string {
  return it.title_b ? `${it.title_a}${titleGap(it.title_a) ? " " : ""}${it.title_b}` : it.title_a;
}

function entryHtml(issue: Issue): string {
  const items = issue.items.map((it) => {
    const title = wholeTitle(it);
    const core = `${it.core_a}${it.core_b ? ` ${it.core_b}` : ""}`;
    return `<li><p><strong>${escapeXml(title)}</strong></p>${core ? `<p>${escapeXml(core)}</p>` : ""}${it.summary ? `<p>${escapeXml(it.summary)}</p>` : ""}<p>${escapeXml(it.project.target)} · ${escapeXml(it.source)} · <a href="${escapeXml(it.url)}">原文</a></p></li>`;
  }).join("");
  const page = siteUrl(`/issue/${issue.date}`);
  return `<ol>${items}</ol><p><a href="${escapeXml(page)}">在 ${escapeXml(SITE.name)} 打开这一期</a> · AI 生成摘要，以原文为准</p>`;
}

/** The reader's feed: their recent non-empty issues, newest first (today's is fixed on read, as on 今日). */
export async function issueFeedXml(userId: string, token: string, opts: { now?: Date; db?: Db } = {}): Promise<string> {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  try {
    await ensureIssue(userId, { now, db });
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", msg: "issue feed: could not fix today's issue", error: String(error) }));
  }
  const dates = await db<{ date: string }[]>`
    SELECT to_char(issue_date, 'YYYY-MM-DD') AS date FROM user_issues
    WHERE user_id = ${userId} AND issue_no IS NOT NULL ORDER BY issue_date DESC LIMIT ${ISSUE_FEED_SIZE}`;
  const issues: Issue[] = [];
  for (const { date } of dates) {
    const issue = await readIssue(userId, date, db);
    if (!issue || !issue.items.length) continue;
    // Feed readers keep the first copy they see: wait for the card copy (or the grace period) first.
    if (!issue.ready && now.getTime() - Date.parse(issue.fixedAt) < ISSUE_FEED_COPY_GRACE_MS) continue;
    issues.push(issue);
  }
  const self = siteUrl(issueFeedPath(token));
  const feedId = `urn:topka:issue-feed:${sha256(userId).slice(0, 24)}`;
  const updated = issues[0]?.fixedAt ?? new Date(0).toISOString();
  const entries = issues.map((issue) => `
  <entry>
    <id>${escapeXml(`${feedId}:${issue.date}`)}</id>
    <title>${escapeXml(`${issue.no ? `第 ${issue.no} 期 · ` : ""}${zhDate(issue.date)} · 今天的 ${issue.items.length} 件`)}</title>
    <link rel="alternate" type="text/html" href="${escapeXml(siteUrl(`/issue/${issue.date}`))}" />
    <updated>${issue.fixedAt}</updated>
    <published>${issue.fixedAt}</published>
    <summary>${escapeXml(issue.items.map(wholeTitle).join(" / "))}</summary>
    <content type="html">${escapeXml(entryHtml(issue))}</content>
  </entry>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="zh-CN">
  <id>${escapeXml(feedId)}</id>
  <title>${escapeXml(`${SITE.name} · 我的今日`)}</title>
  <subtitle>每天 08:00（台北时间）固定的 3 件；只有你能看到这个地址，别分享。</subtitle>
  <link rel="self" type="application/atom+xml" href="${escapeXml(self)}" />
  <link rel="alternate" type="text/html" href="${escapeXml(siteUrl("/"))}" />
  <updated>${updated}</updated>
  <author><name>${escapeXml(SITE.name)}</name></author>${entries}
</feed>
`;
}
