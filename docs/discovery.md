# Discovery channels and pending-evidence signals

Fixed sources are what a project subscribes to. Discovery channels are wider nets — a directory of
feeds, a project's pack, a link a reader pastes — that turn up **leads**. A lead (a
`DiscoverySignal`) is never evidence: it is not a source, an observation, an event or an update. It
waits in its own block, below the evidence, until a fixed source saves the original at the same
address; then the **promotion gate** promotes it and records which observation confirmed it.

Code: `packages/contracts/src/discovery.ts` (pure rules: URL identity, gate, folding, order, cap),
`packages/backend/src/discovery/signals.ts` (channels, storage, the gate run), `database/migrations/0064_discovery_signals.sql`,
`apps/api/src/routes/discovery.ts`, the pages `/discover`, the lower block of `/today/:project`, and
`/admin/discovery`. Tests: `tests/discovery-identity.test.ts` (table-driven rules),
`tests/discovery-signals.test.ts` (database and HTTP), `apps/web/tests/discover-view.test.ts`.

## What a signal may and may not do

- It never enters a brief or an issue, never supports "no important change", never blocks a
  confirmation, and never becomes an event, an update or a source by itself.
- Once promoted, the **observation** that confirmed it is what issues and briefs read (it was already
  in the ledger); the signal is lineage: the reader's card says "Channel signal confirmed: {channel}",
  the lower block lists "{channel} ({URL}) → {observation id}".
- A lead whose URL has no identity (relative, not http(s), with user:password@ …) stays visible,
  marked, and is **never** promoted.

## Channels (all free)

| Channel | What is read | Scope |
| --- | --- | --- |
| `directory` | The first *N* directory feeds of the catalog (hot_signal RSS sources tagged `directory`, in catalog order), *N* = admin setting, default **3**, 0–20. Also the recent items of any hot_signal source the collector already reads for heat (no second fetch). | Site-wide |
| `pack` | hot_signal RSS sources a live project follows (bound through its pack). | That project |
| `user-lead` | A link (and an optional note) the owner pastes on the project page. Never fetched. | That project |

Reading a channel stores signals only: no observation, no model call, no change to the feed's own
source row (cursor, health, failure count). At most 20 entries per feed per run, and entries dated
more than 14 days back are skipped. A failing feed is counted in the catalog ("last read failed") and
read again on the next hourly run. Plain RSS needs no key; `DISCOVERY_ENABLED=false` (or
`COLLECT_ENABLED=false`) stops all reading while the gate keeps running.

Schedules (worker): `discovery.channels` hourly at :26 (with collection on), `discovery.gate` at :09
and :39. A new lead is checked by the gate at once.

## URL identity

Two addresses are the same when their identities are equal. The nine v0 rules:

1. only an absolute URL; 2. only `http:` and `https:`; 3. a URL with userinfo is refused;
4. identity = origin + pathname; 5. the query is ignored; 6. the fragment is ignored;
7. the path is case-sensitive; 8. a non-root path drops its trailing slash(es), the root stays `/`;
9. `http` and `https` are different identities.

On top of v0 (decisions recorded in the design):

- **A. Origin** is the WHATWG origin: host lower-cased, IDN to punycode, a trailing dot dropped, the
  default port dropped; any other port counts. No generic `www.` folding. Percent escapes are
  upper-cased (`%e4` = `%E4`).
- **B. Identity-bearing queries.** Where the query *is* the address, the named parameters stay
  (sorted): WeChat articles (`mp.weixin.qq.com/s`: `__biz`, `mid`, `idx`, `sn`), Hacker News items
  (`/item`: `id`), YouTube videos (`/watch`: `v`). Every other parameter, tracking parameters
  (`utm_*`, `fbclid`, `spm` …) included, is dropped by rule 5.
- **C. Redirect wrappers** that carry the target in the query are unwrapped, at most three levels:
  `google.com/url?q=`, `l.facebook.com/l.php?u=`, `link.zhihu.com/?target=`, `out.reddit.com`,
  `douban.com/link2`, `link.juejin.cn`, `weibo.cn/sinaurl`. A wrapper whose target is not a valid URL
  has no identity. Redirects only visible by fetching (`t.co`, feed proxies) are not followed — the
  gate never fetches; instead every address an observation recorded (its URL and its feed guid)
  counts on the observation side.
- **D. Mirrors.** A closed table: `twitter.com`/`mobile.twitter.com`/`www.x.com` → `x.com`;
  `reddit.com`/`old.`/`new.`/`np.`/`m.reddit.com` → `www.reddit.com`; `export.arxiv.org` → `arxiv.org`;
  `youtube.com`/`m.youtube.com` → `www.youtube.com`; plus `youtu.be/ID` → `www.youtube.com/watch?v=ID`
  and arXiv `/pdf/ID[.pdf]` → `/abs/ID`. The scheme is kept.
- **E. Query-only addresses** (found on production data: rule 5 alone merged unrelated Sogou search
  links into one identity and promoted them to the wrong observation). Search and click-tracking pages
  (`weixin.sogou.com/weixin` and `/link`, Google/Bing/Baidu/DuckDuckGo search) have **no identity** and
  are never promoted. A dynamic script (`.asp .aspx .php .jsp .cgi .do .cfm`) or the site root with a
  query keeps its query minus tracking parameters, sorted (`more.asp?id=1` ≠ `more.asp?id=2`,
  `/?p=12` ≠ `/?p=13`). Any other path still ignores its query.

## The promotion gate

Pure (`promotionGate`): a candidate is promoted only when a saved observation has the same identity,
and carries that observation's id. Several matching observations: the earliest captured wins, ties to
the smallest id, an invalid time after any valid one — independent of input order. Every candidate
with that identity is promoted to the same observation.

"Saved observation" (chosen by the backend before the pure call): an article of an **editorial**
source that is **not withdrawn**. A directory or pack item cannot confirm itself; an isolated source is
not evidence. The run looks at awaiting signals of the last 90 days and observations from 30 days
before the oldest of them, pre-filtered by host (and mirror hosts).

The database refuses what the gate never does: a promoted signal without its observation id or
without an identity, un-promoting or re-pointing a promotion, editing what a channel reported, and a
dismissed signal promoted without being restored first. Allowed: awaiting → promoted (gate),
awaiting → dismissed (owner or operator), dismissed → awaiting (operator restore, re-checked by the
gate at once).

## The pending list and its cap

Awaiting signals only. Duplicates (same identity) fold into one representative — the earliest
discovered, ties to the smallest id, invalid times after valid ones — showing how many were folded; a
signal without an identity is its own entry. Ordered newest discovery first (ties: smallest id;
invalid times last), then cut to **20**. A cap that is not an integer in 1..20 fails closed to 20. The
page says how many were not listed.

## Surfaces

- **Project page** (`/today/:project`): evidence above; below, "Unconfirmed signals" (zh 「待证实的风声」)
  with the intro, chip, title or link, provenance (Directory / Pack / Your lead: channel), note, the
  honest empty state, the lead form, "Hide" per signal, and the last five promotions.
- **`/discover`** (signed in): the directory catalog (which feeds are read, last read), the pending
  list of the directory plus the reader's own projects, promotions, and links to each project's block.
- **`/admin/discovery`**: every signal by status and channel, lineage links to `/admin/content/:id`,
  dismiss (reason required) and restore, the feed count, "Read channels now" and "Run the gate only".
  Every operator action is in the audit log.

API: `GET /api/discover`; `GET|POST /api/projects/:id/signals` (owner only; 404 otherwise; 30 leads a
minute; at most 200 awaiting leads per project); `POST /api/projects/:id/signals/:signalId/dismiss`;
`GET /api/admin/discovery`, `POST /api/admin/discovery/:id/dismiss|restore`,
`POST /api/admin/discovery/run` (`{"gateOnly":true}` for the gate), `PUT /api/admin/discovery/settings`.

## Turning it off

The module is independent: `DISCOVERY_ENABLED=false` stops reading channels; setting the feed count
to 0 stops the directory only. Nothing in collection, analysis, briefs or issues depends on it.
