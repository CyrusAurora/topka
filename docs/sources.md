# Sources

Sources are managed in the admin "Sources" page: create, test-fetch a preview, change frequency,
switch on/off, view failures and recent items. On first start, the demo sources in
`industry/sources.json` are imported.

## The six source kinds

| Kind | For | Needs |
|---|---|---|
| `rss` | Blogs, media, Substack, WeChat accounts mirrored to RSS services | nothing |
| `web_list` | HTML lists without RSS (news pages, blog indexes, changelogs) | selectors; falls back to Jina Reader rendering (paid per request) |
| `json_list` | JSON APIs (GitHub Releases, …) | field paths |
| `x_search` | X (Twitter) accounts | SocialData key, paid per request |
| `mp_account` | WeChat official accounts | a third-party API key (Dajiala), paid per request |
| `external` | Content pushed in by your own scripts | `INGEST_TOKEN`, below |

The config keys accepted by each kind are listed in
`packages/backend/src/sources/config-keys.ts`. Unknown keys are rejected on save and fail the
fetch with the reason shown in the admin UI — no silent fallback to generic parsing.

### rss

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

Optional: `summaryIsBody` (the feed summary is already the whole article),
`allowCategories` / `denyCategories` (filter by the feed's own categories).

### web_list

```json
{
  "url": "https://example.com/news",
  "itemSelector": "article",
  "linkSelector": "a",
  "titleSelector": "h2",
  "publishedAtSelector": "time"
}
```

- `parseMode`: `html` (default, selectors), `markdown` (rendered by Jina, parsed as Markdown),
  `docusaurus_changelog`.
- `detail`: when the list lacks date, title or summary, fetch the detail page
  (`publishedAtSelector`, `titleSelector`, `summarySelector`, …).
- `allowUrlPrefixes` / `denyUrlPrefixes`: keep only articles under certain paths.

### Keyword filter and daily cap (rss, web_list, json_list)

```json
{
  "includeIfMatches": { "title": "vision-language-action|\\bVLAs?\\b|humanoid", "text": "Announce Type: new\\b" },
  "dailyCap": 12
}
```

- `includeIfMatches`: keep only matching items. `title` matches the title only, `text` matches
  title plus summary; when both are given both must match. Values are case-insensitive regexes.
  Useful when you subscribe to a broad outlet but only want one topic from it.
- `dailyCap`: at most this many new items per source per 24 hours, taken in list order. Items
  already known still get their updates. Backfill from a first import does not consume the cap.
- Both apply **before** ingest: unmatched or over-cap items get no full-text fetch and no model
  call, costing nothing. Counts of filtered (`excluded`) and capped (`capped`) items are recorded
  in each fetch run's detail.

### x_search

```json
{ "query": "from:SomeAccount -filter:replies" }
```

Plain accounts are automatically merged into one search (up to ~20 accounts per request) to save
requests.

### mp_account

```json
{ "ghid": "gh_xxxxxxxx", "nickname": "account name" }
```

Each WeChat official account is checked per its fetch interval (paid per list lookup); full text
of new articles is fetched along with them.

## Tiers, participation and full text

- **Tier** `tier`: `T1` first-party official (sites, official blogs, institutions), `T1_5`
  official accounts and quasi-official creators, `T2` media and individuals, `EXCLUDE_MP`
  excluded from selection. Selection thresholds differ per tier (`industry/selection.ts`).
- **Participation** `participation_mode`: `editorial` joins selection and the "all items"
  stream; `hot_signal` is not displayed alone, it only feeds "what everyone is talking about";
  `isolated` never appears on public pages.
- **First party** `first_party`: the source is the party itself. Event pages prefer
  first-party reports.
- **Full text**: `site_fulltext` decides whether the site may show full text, and
  `syndicate_fulltext` whether the full-text RSS carries bodies. Both **default off** — summaries
  and links only; enable per source when the publisher clearly allows it. Paywalled or
  opt-out material does not gain full display just because it is technically fetchable.

## Fetch frequency

Each source has its own interval. Daily at 04:20, intervals adapt to the last 7 days of output:
productive sources are fetched more often (minimum 15 minutes); free sources slow down to at most
60 minutes, paid per-request sources to 120–180 minutes.

A failed fetch does not advance the cursor; the next run continues where it left off. Sources
with consecutive failures are flagged red in the admin UI, and a weekly source-health report is
sent to the operator group when a Feishu group is configured.

## Rule: old material never floods the feed

Items already published more than 48 hours before discovery, stock items first imported with a
new source, and pushes marked backfill are archived by original publish time: they never enter
"today" and never trigger a push. One rule shared by all inlets, so a one-off historical import
cannot splash the reader views.

## External push endpoint

Content gathered by your own scripts can be pushed into the site and flows through the same
dedupe, selection and grouping as everything else.

```
POST /api/ingest/items
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "sourceId": "my-crawler",
  "sourceName": "My crawler",
  "items": [
    { "title": "required", "url": "required", "publishedAt": "2026-10-01T08:00:00+08:00", "author": "optional" }
  ]
}
```

- Set `INGEST_TOKEN` in `.env`, at least 16 characters; unset means the endpoint always returns
  401.
- Up to 50 items per call; at most 10 calls per minute per client.
- Returns `{"ok": true, "created": <new item count>}`. Items missing title or URL are skipped;
  duplicate URLs within one request keep only the first.
- An unknown `sourceId` creates an `external` source which never appears on public pages until you
  change its participation mode to `editorial` in the admin UI.
- An item with `raw._topka.backfill: true` is treated as backfill (never enters "today", never
  pushes).
