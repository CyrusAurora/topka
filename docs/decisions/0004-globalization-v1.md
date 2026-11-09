# 0004 — Globalization v1: per-user timezone, reading language, source regions

Status: **accepted** (implementing PR 1: per-user timezone; PR 2 (this change): locale wiring + prompt {{outputLanguage}} + reader chrome; regions follow in PR 3).

Column strategy (step 2): no new `*_en` columns; per-user card tables (`issue_card_copy`, `project_card_copy`) store generated text; historical Chinese copy rows stay; new generations follow locale. Do not rewrite old rows.

Date: 2026-11-09 (Asia/Taipei).

## Decision

Ship a **thin** globalization v1 that makes Topka usable for a reader outside UTC+8 / Chinese, without dual-running the whole editorial pipeline or rewriting the public content pool.

v1 does three things and nothing else:

1. **Per-user timezone for 今日 issue cutoffs.** Each user has an IANA timezone. Their daily issue is fixed at **08:00 local** in that zone. `issue_date` is the calendar date in that zone.
2. **Per-user reading language for card copy and UI shell.** `users.locale` (already `zh-CN` by default) drives (a) reader-facing UI strings for 今日 / 往期 / 登录 / 设置 / 对话 / 项目, and (b) the language of *that user's* `issue_card_copy` / mobile card prompts. Site-wide publications (`title_zh` / `summary_zh` / `translations.lang='zh'`) stay Chinese for this deployment.
3. **Source region tags + pack filter.** Sources gain `regions text[]` (ISO 3166-1 alpha-2 codes, plus `global`). Curated packs and the project wizard can filter by region. `in_scope` stays **industry-topic** scope; it is not geography.

Public daily/weekly/monthly reports, worker cron (`tz: Asia/Shanghai`), monitor API (`timezone: "Asia/Shanghai"`), and the Beijing helpers in `packages/contracts/src/time.ts` stay site-level UTC+8 in v1. They are a different product surface from per-user 今日.

## Why this shape

- **The coincidence that made 08:00 UTC+8 cheap is the trap.** Today `currentIssueDate` is the UTC date and `issueCutoff` is `${date}T00:00:00Z` because 08:00 Asia/Shanghai = 00:00 UTC (`issue-rules.ts`). That does not generalize. A New York or London reader must not share Cyrus's morning.
- **`users.locale` already exists and does nothing.** Wiring it is cheaper than inventing a parallel preference. Full UI i18n frameworks and dual `title_en` columns are gold-plating until a second language has real readers.
- **`in_scope` is not country.** It means "passes the industry prefilter" (migration `0054_site_scope.sql`). Geography belongs on sources, not on that flag.
- **Card copy is the only generated text the signed-in reader must read every day.** Regenerating the whole analyses/publications pool in English doubles model spend and storage. v1 writes English (or other) only into per-user / per-project card tables when `locale` asks for it; publication titles remain the Chinese fallback.
- **Cyrus production must not move.** Defaults stay `Asia/Shanghai` + `zh-CN` + existing Chinese packs. Existing `user_issues` rows are historical and immutable.

## What we give up (v1)

- No English (or other) rows in `analyses.title_zh` / `publications.title` / `translations` for the public pool.
- No admin UI translation; admin stays Chinese.
- No per-user cutoff *hour* (always 08:00 local).
- No geo-IP; the user picks timezone and regions explicitly.
- No region-weighted scoring; region only filters which sources enter a project.
- Site cron and public 日报 remain Asia/Shanghai.

## When to revisit

- A second language has enough readers that public publications must exist in that language (then add `translations.lang` / parallel title fields and a site `contentLanguages` list).
- Operators want the public 日报 itself in another zone (then split site timezone from user timezone cleanly end-to-end).
- Cutoff hour becomes a product setting (then store `users.issue_hour`, default 8).

## Current hardcoding inventory (evidence)

Checked on private-repo main @ `30af0fe` (2026-11-09).

### Issue timing (must change for multi-TZ)

| Location | What is hardcoded |
|---|---|
| `packages/backend/src/projects/issue-rules.ts:1-36` | Issue = 08:00 UTC+8 = 00:00 UTC; `currentIssueDate` = UTC date; `issueCutoff` = `T00:00:00.000Z`; `taipeiDate` = +8h offset |
| `packages/backend/src/projects/issues.ts:1-8,142-152` | `ensureIssue` uses `currentIssueDate` / `issueCutoff` with no user TZ |
| `database/migrations/0050_user_issues.sql:1-14` | Schema comment: fixed at 08:00 Asia/Taipei; `issue_date date` with no TZ column on the row |
| `tests/issues.test.ts:1-2`, `tests/user-today.test.ts:104`, `tests/report-candidates.test.ts:68` | Assert 00:00 UTC = 08:00 Beijing |
| `packages/backend/src/projects/issue-feed.ts:3,116` | Feed subtitle: 每天 08:00（台北时间） |
| `apps/web/app/features/today/today-view.ts:45` | `Intl… timeZone: "Asia/Shanghai"`, `zh-CN` |
| `README.md` / `README.en.md` | Product copy: fixed 08:00 UTC+8, not configurable |

### Site calendar / cron (out of v1 user path; stay UTC+8)

| Location | What is hardcoded |
|---|---|
| `packages/contracts/src/time.ts:1-73` | Beijing +8 helpers (`beijingDate`, `beijingMidnight`, `toBeijingIso`, Chinese weekdays) |
| `apps/worker/src/schedules.ts:1,49,106` | Comment "Asia/Shanghai"; `reports.daily` cron `0 8 * * *`; `boss.schedule(..., { tz: "Asia/Shanghai" })` |
| `packages/backend/src/reports/compose.ts:136-139` | Daily report window `[D-1 08:00, D 08:00)` Beijing |
| `packages/backend/src/editorial/history-gate.ts:7-8,56` | Default `HISTORY_ANALYSIS_TZ=Asia/Shanghai` |
| `packages/backend/src/editorial/analyze.ts:97-103` | Score timestamps formatted Asia/Shanghai / `+08:00` |
| `packages/backend/src/editorial/writing.ts:281` | Date format Asia/Shanghai |
| `packages/backend/src/monitor/read.ts:19-24,256` | `+08:00` ISO; `timezone: "Asia/Shanghai"` |
| `packages/contracts/src/monitor.ts:91` | Type literal `timezone: "Asia/Shanghai"` |
| `packages/backend/src/publication/feeds.ts:29`, `llms.ts:36,55` | Copy: 每天 08:00 北京时间 |
| `industry/site.ts:55,61` | About copy: 每天早上 8 点 / 08:00 |

### Language / UI (partial hooks exist)

| Location | What is hardcoded |
|---|---|
| `industry/site.ts:20` | `SITE.locale = "zh-CN"` (HTML lang, og:locale) |
| `database/migrations/0039_accounts.sql:11` | `users.locale text NOT NULL DEFAULT 'zh-CN'` — **stored, not used to drive UI or copy** |
| `apps/web/app/root.tsx:43`, `apps/web/app/lib/seo.ts:66` | `lang={SITE.locale}`, `og:locale` from SITE |
| Reader / admin route strings | Chinese literals throughout `apps/web/app/routes/**` and features |
| `industry/prompts/*.md` | Instruct 中文标题 / 摘要 / 简体中文 (e.g. `content-understanding.md`, `issue-card.md`, `mobile-card.md`, `translate-*.md`, `summarize-*.md`) |
| `packages/backend/src/editorial/translate.ts` | Target language fixed `zh`; skip when "already Chinese" |
| `packages/backend/src/editorial/input.ts:62`, `publication/feeds.ts:50,134` | Joins `tr.lang = 'zh'`; RSS `<language>zh-CN</language>` |
| DB columns | `title_zh`, `summary_zh`, `reason_zh` on analyses; no `*_en` |
| `packages/backend/src/projects/issues.ts:21` | `AI_NOTICE = "AI 生成摘要，以原文为准"` |
| `docs/customize.md:92-94` | Documents Chinese-output prompts as the default |

### Sources / scope (geography missing)

| Location | What is hardcoded / missing |
|---|---|
| `database/migrations/0001_core.sql:10-38` | `sources` has `tags text[]`, no `regions` / `country` |
| `database/migrations/0054_site_scope.sql` | `in_scope` = industry rule, not geography |
| `packages/backend/src/projects/issues.ts:100-102` | Issue candidates require `p.in_scope` (industry) |
| `packages/backend/src/projects/packs.ts` | Packs list id/label/sources; no region filter |
| `database/seeds/source-packs.json`, `database/seeds/packs/*` | Topic packs; no country/region dimension |
| `industry/sources.json` | Demo sources; no region field |

## Recommended v1 scope

### Ship first (this decision)

| # | Change | Done when |
|---|---|---|
| A | `users.timezone text NOT NULL DEFAULT 'Asia/Shanghai'` + settings PATCH + validation (IANA via `Intl` / known list) | Migration + API + settings UI; existing users remain Shanghai |
| B | Replace UTC-coincidence helpers with TZ-aware `issueDateInTz` / `issueCutoffInTz(date, tz)` (local 08:00) used by `ensureIssue`, `nextIssueAt`, feed, today view | Unit tests for `America/New_York`, `Europe/London`, `Asia/Tokyo`, `Asia/Shanghai` (DST cases for NY/London) |
| C | `ensureIssue` loads the user's timezone; historical `user_issues` untouched | Regression: Shanghai user still gets same date/cutoff as today for a fixed `now` |
| D | Wire `users.locale` ∈ {`zh-CN`,`en`} (v1 enum) to reader shell string catalog + `{{outputLanguage}}` in `issue-card` / `mobile-card` prompts only | en user sees English chrome + English card copy; zh-CN user unchanged |
| E | `sources.regions text[] NOT NULL DEFAULT '{global}'` + seed/tag existing packs + wizard filter | Pack list can show "US / CN / global"; binding still explicit |

### Later (explicitly not v1)

- Dual-language publications / `translations.lang='en'` pipeline
- Admin i18n; full route catalog beyond reader shell
- Site-level timezone for public 日报 / worker cron
- Configurable cutoff hour; geo-IP defaults
- Region-aware scoring or separate per-region public pools
- Locales beyond `zh-CN` / `en`

## Data model / config changes

```sql
-- 0057_globalization_v1.sql (name illustrative)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Shanghai';

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS regions text[] NOT NULL DEFAULT ARRAY['global']::text[];

-- Optional check: reject empty regions array.
ALTER TABLE sources
  ADD CONSTRAINT sources_regions_nonempty CHECK (cardinality(regions) >= 1);
```

- **No change** to `user_issues` primary key `(user_id, issue_date)`. `issue_date` becomes "calendar date in the user's timezone at fix time". Document that changing timezone mid-day does not rewrite today's row; the next `ensureIssue` after the new local 08:00 uses the new zone.
- **`users.locale`**: keep column; constrain writes to `zh-CN` | `en` in the accounts API for v1 (DB check optional).
- **`industry/site.ts`**: add `contentLanguage: "zh"` (site pool language) separate from `locale` (default UI). Do not flip Cyrus prod.
- **Prompts**: add `{{outputLanguage}}` to `issue-card.md` / `mobile-card.md` only; Chinese exemplars stay; English instructions are a short branch in the same file ("If outputLanguage is en, write … Keep industry terms untranslated: BYOK, SLA, VLA, …").
- **Env**: none required for v1. Do not add paid geo services.

## Migration risk (Cyrus production + existing Chinese users)

| Risk | Mitigation |
|---|---|
| Shanghai users' issue dates / cutoffs drift | Default timezone `Asia/Shanghai`; golden test: for `now = 2020-01-02T00:00:00Z`, Shanghai user still gets date `2020-01-02` and cutoff `2020-01-02T00:00:00.000Z` |
| Existing `user_issues` reinterpreted | Never backfill or rewrite historical rows; only new `ensureIssue` calls use TZ helpers |
| User changes TZ and "loses" today | Document: today's fixed row stays; next local 08:00 opens the next date. Settings copy warns once |
| English card copy burns model budget | Only write when locale ≠ site content language and copy missing; receipts still gated by existing budgets |
| Source `regions` default wrong | Default `{global}` → every existing source remains bindable; CN-heavy seeds get `regions = {CN,global}` in a follow-up seed PR, not a silent filter |
| Public RSS / 日报 language surprise | Unchanged in v1 |
| DST bugs | Tests around US spring-forward / fall-back for cutoff instant |
| Prod deploy without clean PR | This doc only; implementation lands as normal PRs, one concern per PR (TZ → locale/copy → regions) |

## Acceptance tests (checkable done)

1. **Shanghai parity.** Fixed clock `2020-01-02T00:00:00.000Z`: user `Asia/Shanghai` → `issue_date=2020-01-02`, cutoff ISO `2020-01-02T00:00:00.000Z`. Existing `tests/issues.test.ts` scenarios still pass under Shanghai.
2. **New York morning.** Fixed clock `2020-01-02T13:00:00.000Z` (08:00 America/New_York EST): user `America/New_York` → `issue_date=2020-01-02`, cutoff `2020-01-02T13:00:00.000Z`. At `12:59Z` the previous local date is still showing.
3. **London DST.** One spring-forward and one fall-back case: cutoff is the local 08:00 instant Intl resolves, never a fixed `+00:00` / `+01:00` constant in code.
4. **Tokyo.** `Asia/Tokyo` user at local 08:00 gets that calendar date; does not share Shanghai's UTC midnight.
5. **Locale UI.** `locale=en` session: 今日 / Archive / Login / Settings chrome strings are English; `locale=zh-CN` unchanged Chinese.
6. **Card language.** After fix, `en` user's new `issue_card_copy` fields are English (assert via stubbed model returning English, and prompt includes `outputLanguage=en`); `zh-CN` still Chinese; industry terms BYOK/VLA remain Latin in both.
7. **Regions filter.** Source with `regions={US}` hidden when wizard filter=`CN` only; `global` always visible; default unfiltered list still shows all (no silent drop for Cyrus).
8. **Prod smoke.** After migrate on a `_ci` DB: `npm run test:coverage` green; Shanghai user path byte-identical cutoff for the parity fixture; no rewrite of pre-existing `user_issues` row count/contents in a migrate+read check.

## Implementation order (when accepted)

1. PR: timezone column + TZ helpers + `ensureIssue` + tests (A–C).
2. PR: locale wiring + prompt `{{outputLanguage}}` + reader string catalog (D).
3. PR: `sources.regions` + seed annotations + wizard filter (E).
4. Docs: README honesty line updates ("定稿时间随用户时区；界面与卡片语言可切 en").

Do not combine with unrelated refactors. Do not open the public `topka` mirror until these PRs exist on the private repo and the export gate is re-run (separate from this decision).

## Alternatives considered

- **Site-wide `SITE_TIMEZONE` only.** Rejected: does not solve multi-user globalization; only moves the single knob.
- **Full i18n framework + dual publication columns now.** Rejected: doubles editorial cost before there are English readers of the public pool.
- **Reuse `in_scope` for geography.** Rejected: overloads industry scope; breaks 今日 candidate gate semantics.
- **Store cutoff hour per user.** Deferred: 08:00 local is enough for v1; hour adds product and test surface.
