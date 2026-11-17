# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

The daily issue now leaves out candidates without enough evidence, and the quality of each part of the
product is measured on its own (docs/quality.md). A fresh install works end to end with no paid key:
every project pack is there, a labelled demo model answers 对话, and the port is set once in `.env`.
The observation ledger is complete: every write has one of four states, withdrawals are append-only
records, and a project brief is confirmed only through the checkpoint decision table (docs/ledger.md).
Upgrading runs migrations `0061`, `0062` and `0063`.

### Added

- Release provenance at SLSA Build Level 3 (docs/release.md): slsa-github-generator's isolated
  generic and container generators sign provenance for the release files and the image, which
  `slsa-verifier` checks; the build job holds no signing identity. Pre-release tags (`vX.Y.Z-<label>`)
  rehearse the whole pipeline, and `release-cleanup.yml` removes one afterwards.
- The docs' code blocks run in CI (docs/doc-blocks.md): each shell or TypeScript block is marked run,
  skip (with a reason), excerpt or typecheck; the README, tutorial, self-hosting and contributing pages
  are followed block by block on port 3300 against the exported tree.
- Operations alerts to a webhook: `ALERT_WEBHOOK_URL` takes a Feishu custom-bot address (or any
  receiver of that JSON; `ALERT_WEBHOOK_SECRET` signs), with dedupe of the same text, an hourly cap
  that reports what it held back, and retry of an alert or recovery no outlet took.
  `npm run alerts:test` sends a test message. New alert when many sources fail in a row
  (`ALERT_SOURCE_FAILS`). See docs/alerts.md.
- Online demo on GitHub Pages (docs/online-demo.md): the reader pages as a static site with a real
  instance's fixed issues (whitelisted export, leak-scanned twice) and the demo model in the browser
  for Chat; "last updated" and the age of the data shown honestly. `scripts/pages-export.ts`,
  `scripts/pages-publish.sh`, `scripts/build-demo.ts`, `scripts/check-demo.ts`, `.github/workflows/pages.yml`.
- `/api/health` names the app and its version (`"app":"topka","version":"0.2.0"`), so a check against a
  port can tell Topka from another service.
- Observation ledger (migration `0063`): every report is `created` (new or a new version),
  `existing`, `conflict` (an older version replayed; kept next to the stored one) or `failed`
  (`missing-provenance`, `preservation-failed`); refusals are kept in `observation_rejections`, run
  counts in `fetch_runs.detail.ledger`. Withdrawals (`article_withdrawals`) are append-only records,
  refused at the database like `0059`; withdrawn items leave new issues and briefs and are marked
  where they stay. Admin: `POST /api/admin/content/:id/withdrawal`; ingest: `"withdrawn": true`.
- Project brief checkpoint: each view is a stored snapshot with a top result (`offline-or-auth`,
  `snapshot-failed`, `partial-coverage`, `abstained-impact`, `updates-available`,
  `no-important-change`); confirming names the snapshot, `ackSeq`, the cards shown and a `commandId`,
  returns a receipt, and is guarded in the database. `PUT /api/projects/:projectId/sources/:sourceId`
  marks a source as required; `GET /api/me/items/:articleId/history` lists earlier versions.
- Built-in demo model (`DEMO_SEED=true`, or `LLM_DEMO=true`): answers 对话 and writes card copy offline
  with fixed rules, labelled 「演示模型」 / "Demo model" in the UI; it never analyses articles and steps
  aside once a real model is configured. `init-env.ts --demo` turns it on.
- `init-env.ts --port <host:port>` and `--locale en`; `PORT` in `.env` is the one place for the address:
  the site URL, the web server, the smoke check and the docs' health check follow it (`SITE_URL` /
  `SITE_DOMAIN` still override).
- Setup imports every shipped project pack (insert-only; English names in migration `0062`). An
  unavailable pack says why and gives the command; the wizard and project pages say when collection or a
  model is off and link the docs. `sources:seed` without `--pack` lists the packs.
- Docs: 「Without a paid key」 (demo model, Ollama with measured results, OpenRouter `:free`),
  「Project packs」, 「Switching sources on」, and a tutorial part on building your own project.
- `docs:links` checks `#anchors` as well as files.
- Quality evals: `npm run eval` measures coverage, relevance, dedup/grouping, citation completeness,
  source independence, freshness, abstention and time saved, each against its own labelled set or
  snapshot in `eval/` and its own thresholds (`eval/thresholds.json`); no combined score. CI runs
  `npm run eval -- --check`. Report: `docs/quality/report.md`. `--import` stores the results as
  SelectBench runs; `--live --model <id>:free` re-scores the relevance set with a free model.
- Evidence check for the daily issue (`projects/evidence.ts`): a candidate with no source, only a title,
  too little text, an unsourced rumour in its lead, or a denial from another report is left out (宁少不凑,
  no weaker filler), and the reason is stored in `issue_abstentions` (migration `0061`).
- `scripts/eval-candidates.ts` exports candidate cases and the runtime snapshot read-only;
  `scripts/eval-selection.ts --purpose` picks the cases of one purpose from a mixed gold set (default `site`).

### Changed

- The Docker image and the quickstart's one-off container use Node.js 26 (LTS), `node:26-trixie-slim`;
  running from source still needs Node.js 24.11 or later. Dependencies: postgres 4 (the server types
  every parameter; the suite passes unchanged in a UTC+8 time zone), @babel/parser 8 (tests only), and
  patch and minor updates of vite, pg-boss, motion, jsdom, isbot, sanitize-html, fast-xml-parser,
  hyparquet and playwright-core.
- Dependabot opens at most one PR per ecosystem a month, each grouping all updates (majors included);
  `.github/CODEOWNERS` is gone while there is one maintainer (`MAINTAINERS.md` is the record).
- `POST /api/projects/:projectId/today/ack` takes `{snapshotId, ackSeq, shownIds, commandId}` instead
  of `{through}`; refusals carry a `code`.
- `POST /api/ingest/items` no longer skips items without a usable URL silently (they are refused as
  `failed`) and uses the URL when the title is missing.
- 对话 replies, quota and error lines follow the reader's language; English readers get English
  questions and cards.
- Project page: 「关联 N 个信源 · 开着 M 个」 and which time window it shows (last 24 hours, since your last
  visit, or up to 7 days back); the reminder names the reader's own time zone; one collection-frequency
  description everywhere.
- `sources list` prints times with their zone (`+08:00`); the setup log says where the source count comes
  from; a pack feed already in the catalogue is kept once.
- Demo seed never blocks setup when `DEMO_SEED` stays in `.env`; the password reset is
  `DEMO_PASSWORD` in `.env` → `docker compose up -d` → `demo:seed`.
- The image sets `NPM_CONFIG_UPDATE_NOTIFIER=false` and ships an empty `.env`, so `docker compose exec api
  npm run …` prints neither the npm update notice nor ".env not found".
- Source independence: a trailing attribution ("…, Wired reported", "彭博社记者…爆料") counts as a relay;
  a background mention ("此前据…报道") does not; links on shared hosts (e.g. sogou) keep their query so
  different articles are not merged; reports from one signal group count as one voice.
- `/api/health` reports `release` as the package version plus the git commit.

### Fixed

- Docs that had drifted from the code, found by running their blocks: the plugin example's
  `ProviderRejectedError` takes a third argument, `retryable` (docs/plugins.md), and the thresholds
  excerpt in docs/selection.md matches `industry/selection.ts` again, and CONTRIBUTING.md no longer
  starts the database before `.env` exists (it waits for it to be ready, too).
- Demo model: English requests to delete, remove, rename or pause a project go to that project (they
  started a new interview before); a cancel, a new topic or a delete said in the middle of an interview
  is taken first; a new project's name is a cleaned phrase cut at a word boundary, not 15 characters
  and "…".
- A confirmed delete card still names the deleted project and its focus (it showed `Delete ''` and
  `Target —`); its warning follows the page language.
- Admin › Runs counts demo-model and free-model calls apart from paid ones.
- `scripts/demo.ts` no longer turns the demo sources back on at every restart after
  `sources:only` turned them off.
- Settings › Projects: one row per project with a divider; a space after the 「分析」/"Analysis" badge.
- Docs: tutorial outputs match what the commands print; `-e DEMO_PASSWORD=…` on a one-off is undone
  by `.env` at the next restart; one source-count wording throughout.

## [0.2.0] - 2026-11-10

Each reader gets their own time zone and language, the whole UI (admin included) is available in
English, and sources carry regions. Upgrading runs migrations `0057`–`0060` at start-up; with the
defaults nothing a reader sees moves (Asia/Shanghai, `zh-CN`).

### Added

- Per-reader time zone: `users.timezone` (IANA name, default `Asia/Shanghai`; migration `0057`).
  Each reader's daily issue is fixed at 08:00 in their own zone; set it in Settings or with
  `PATCH /api/auth/me {"timezone": …}`. With the default zone nothing moves: 08:00 Asia/Shanghai is
  the old 00:00 UTC cutoff.
- Per-reader language: `users.locale` (`zh-CN` or `en`), set in Settings or with
  `PATCH /api/auth/me {"locale": …}`. The copy on that reader's daily cards is written in it.
- English UI: every page, the admin included, draws its text from per-locale dictionaries
  (`apps/web/app/lib/locales/`); API errors are shown by their `code` in the page's language;
  English terms and privacy pages (`industry/pages/*.en.md`). `SITE_LOCALE` sets the language for
  signed-out visitors and the admin (default: the industry pack's `SITE.locale`). Tests hold both
  dictionaries to the same keys, scan the English render for Chinese, and lock the Chinese copy.
  The public pool, the Chat assistant's replies and the feeds stay in the site's language.
- Sources have `regions` (`text[]`, default `["global"]`; migration `0058`); the project wizard can
  filter by region (`global|cn|us|eu|jp`, default unchanged — unfiltered shows all, `global` always
  visible).
- Sign-in lockout per email address (migration `0060`), on top of the per-client limit: after
  `LOGIN_LOCK_THRESHOLD` attempts within `LOGIN_LOCK_WINDOW_SECONDS` the address is locked for
  `LOGIN_LOCK_BASE_SECONDS`, doubling up to `LOGIN_LOCK_MAX_SECONDS`; the answer is `429` with
  `Retry-After`, the same whether or not the address has an account.
- Prompt-injection sample set (`tests/fixtures/prompt-injection.json`) run against a stub model that
  obeys it: untrusted text sent to a model loses fences, section labels and hidden characters
  (`packages/backend/src/lib/untrusted.ts`); out-of-range scores are rejected and nothing is
  stored; no request offers a tool or carries a secret.

### Changed

- An article's source content is append-only (migration `0059`): database triggers refuse a change to
  where it came from (`url`, `identity_key`, `source_id`), a change to its `title` / `body_text` /
  `body_html` without a new revision recorded in `article_revisions`, and any update to a stored
  revision.
- A disabled account is reported only after the right password (it used to answer `403` before the
  password was checked, which told an attacker the address existed).
- Slogan: 「只告诉你变了什么。不够格就少发或空一期，宁少不凑。」 replaces the unmet “evidence is thin,
  we say so” claim in the README (zh / en) and the `industry/site.ts` description; the issue is
  shorter or empty when nothing clears the bar, never padded.
- README (zh / en): cut the tutoring asides and the long upstream paragraph; credit to AIHOT is one
  short line. README, self-hosting guide and tutorials describe the per-reader cutoff, language and
  regions.
- Dependencies: minor and patch updates (fastify, vite, pg-boss, undici, …) and jsdom 31 in the web
  test harness.
- `docker-compose.yml`: RSSHub pinned to `2026-11-10` (by digest).

### Fixed

- Release workflow: the arm64 image build hung while building the web bundle under emulation and
  was cancelled at the job limit. The bundle is now built once on the native platform and copied
  into each architecture's image; the image step has a 30-minute limit.
- An unknown path is a 404 drawn in the reader's language, not the site's.
- A signed-in reader's page (drawn in their language and time zone) is no longer marked cacheable:
  requests carrying the reader session get `private, no-store`, and public pages send
  `Vary: Cookie`, so neither a browser nor a shared cache serves one reader's page to another or a
  visitor's page to a reader.
- Settings has the time zone picker (the API accepted a time zone since `0057`, the page had no
  control for it), and changing language or time zone redraws the page in it.

## [0.1.1] - 2026-11-09

A security-only patch release: dependency updates, no change in behaviour or configuration.

### Security

- Dependencies with published advisories, flagged by Dependabot on the public repository the day 0.1.0
  went out: `undici` 7.30.0 → 7.30.2 (via `cheerio`; 4 high, 4 moderate, among them unbounded memory
  in the EventSource parser), `fast-uri` 3.1.8 → 3.1.9 and 4.2.1 → 4.2.3 (via `fastify` / `ajv`; URI
  scheme and host confusion), and `fflate` 0.7.3 → 0.7.5 (via `satori`, which pins it exactly, so
  through an npm `overrides` entry; an infinite loop on malformed ZIP64). `npm audit` reports 0.

## [0.1.0] - 2026-11-09

Everything in this first release: the product described in `README.md` and the work of preparing it
for publication under the "Topka" name. `0.1.0` is the first public version, so there is no earlier
release to compare against.

### Added

- Web interface layers for registered users: Today (`/today`, one fixed daily issue per user of
  at most 3 items across their projects — `TODAY_CARD_COUNT` — fixed when the day starts at
  08:00 UTC+8 = 00:00 UTC), Archive (`/archive` plus per-issue pages), Chat (`/chat`, manage
  projects in natural language), and Settings (`/settings`, BYOK).
- Bring-your-own-key (BYOK): users registered on the instance can store their own
  OpenAI-compatible model key. New migration `0052_user_provider_keys.sql` (table
  `user_provider_keys`); new optional environment variable `KEY_ENCRYPTION_SECRET` (AES-256-GCM
  at rest, only the last 4 characters shown in the UI). Without it, users can only use the
  instance's own key. See `docs/self-hosting.md`.
- Per-project scoring: articles are scored against every tracking project that follows their
  source (one batched call, no extra call count); the best project score replaces the generic
  score; fixed "Today" card count per project (`TODAY_CARD_COUNT`).
- Source packs for seeding demo sources: `npm run sources:seed -- --pack embodied [--enable | --only]`.
- New deployments start with all sources switched off (migration `0051_fresh_sources_off.sql`,
  applied only to databases that have no articles yet; existing instances keep their switches).
- Daily issues are topped up from unshown candidates of the last 72 hours when fewer than 3 items
  qualify (same floor: `issueFloor`, 50 — a short day shows fewer items rather than filler); `dailyCap` is counted per UTC day and truncated backfill items no longer leave a 304
  validator behind.
- Project-prefixed environment variables `TOPKA_RELEASE`, `TOPKA_DATA_DIR`, `TOPKA_CREDENTIALS_DIR`,
  `TOPKA_ENVIRONMENT`, `TOPKA_CHANGELOG_FILE`; the upstream `AIHOT_*` names still work as deprecated
  fallbacks. `SESSION_COOKIE_NAME` sets the reader session cookie name (default `topka_session`).
- Plugin hook: `TOPKA_PLUGINS` (comma-separated module paths loaded at startup by api/worker;
  a plugin can register an extra interactive chat route). See `docs/plugins.md`.
- `docs/configuration.md`: consolidated configuration reference.
- An offline demo for a first run with no key: `DEMO_SEED=true docker compose up -d --build` (or
  `npm run demo:seed`) creates a demo reader, one tracking project and three days of invented
  cards; `docs/tutorial.md` goes from an empty machine to a card on screen in under 30 minutes.
- Project documents: `GOVERNANCE.md`, `MAINTAINERS.md`, `.github/CODEOWNERS`, `SUPPORT.md`,
  `TRADEMARK.md`, `docs/threat-model.md`, `docs/release.md` (release checklist with a CycloneDX
  SBOM and checksums) and `docs/decisions/` (why MIT, DCO as a request, one maintainer).
- `npm run docs:links` checks every relative Markdown link.
- CI: `docs:links` and an `npm sbom` check in `check.yml`; GitHub code scanning (`codeql.yml`, CodeQL
  `security-extended`); `release.yml` builds the CycloneDX and SPDX SBOMs, a source archive, the
  `linux/amd64` + `linux/arm64` image on ghcr.io and `SHA256SUMS` for every tag, signs the image
  with keyless cosign and attests SLSA build provenance and the SBOM with `actions/attest` (how to
  verify: `docs/release.md`).
- Per-address request ceilings (`@fastify/rate-limit`, per route) on sign-in, account deletion, the
  ingest token, the image proxy and file-serving routes; CodeQL triage in
  `docs/security/codeql-triage.md`.
- Fewer model calls per article: a first score below the floor stops the analysis, a second score is
  asked only within `secondScoreBand` (15) of the threshold or for project sources, and items published
  more than `STALE_ANALYSIS_HOURS` (72) ago are skipped without a call; a sweep marks such backlog as
  skipped every 5 minutes. `HISTORY_ANALYSIS=skip` turns history backfill off entirely.
- Free-model resilience: a model whose output is unusable is benched for 30 minutes and the next one is
  tried; a rate-limited (429) candidate sits out 60 s, doubling on each further 429 up to 30 minutes;
  with no usable free model, work waits without spending an article's attempts. Upstream 429s are no
  longer counted against the local OpenRouter day budget (they are not counted upstream either).
- `CHAT_PER_MINUTE` (default 8) caps chat messages per user per minute; `OPENCODE_CLI_PRUNE_HOURS`
  prunes the OpenCode CLI's session store and logs.
- `industry/site.ts` `legalPages` (default `false`): `/terms` and `/privacy` return 404 and nothing
  links to them until the operator fills in their details and turns them on.
- Tests: backend line coverage gate at 85% (`npm run test:coverage`, enforced in CI); browser E2E of the
  web flows (`npm run e2e`); `.env.example` is checked against every variable the code reads; the tests run in a
  clean environment (`tests/hermetic-env.ts` keeps only `DATABASE_URL` and the process plumbing), so a provider
  key, a model choice or a switch such as `MODEL_CALLS_ENABLED=false` exported in a developer's shell cannot
  change what they see.

### Changed

- Documentation rewritten in English as the primary language; Simplified Chinese README retained
  alongside (`README.zh-CN.md`).
- Self-hosting documentation merged into a single `docs/self-hosting.md` (replaces the previous
  `docs/self-host.md` and `docs/deploy.md`).
- Neutral project identity: public-facing copy no longer carries the AIHOT demo branding;
  AIHOT is credited as the upstream project in `NOTICE` and `README.md`.
- Licensing metadata: copyright holder for this fork's changes is "The Topka Authors";
  upstream attribution kept; third-party asset notices documented in `NOTICE`.
- Repository meta for open collaboration: `CONTRIBUTING.md`, `SECURITY.md`, code of conduct,
  issue/PR templates, and Dependabot configuration.
- `docker compose` publishes the web container on `127.0.0.1:3000` by default (this machine only);
  `PORT=3000` opens it on every interface, and the `https` profile fronts it with Caddy.
- `POSTGRES_PASSWORD` is required by `docker-compose.yml` (no built-in default); `init-env` generates it.
- The hero-lead setting is now read from `ISSUE_HERO_LEAD` (it was renamed; deployments that set the old name must set the new one).
- The README is Chinese-first (`README.md`), with the English version in `README.en.md`: the UI and
  the generated content are Chinese-first, so the first page a visitor reads matches what they see
  after running it. Both open with the three commands and
  the screenshot they produce, then what to expect, honest limits and a symptom/cause/fix table.
- The tutorial exists in Chinese (`docs/tutorial.md`) and English (`docs/tutorial.en.md`), with the
  real output of every step; README and tutorial screenshots are recaptured from the demo seed.

### Fixed

- Security hardening from a CodeQL review: a wrong ingest token or password now spends a per-address
  window (it did not); account deletion limits password attempts per account; the ingest
  `Authorization` header is parsed without a backtracking pattern; static files resolve only inside
  their directory and are read through one handle; the admin password check uses scrypt; the
  timing-only dummy hash uses a CSPRNG; `scripts/init-env.ts` creates `.env` atomically; the opencode
  CLI home defaults to `DATA_DIR/opencode` (mode 0700) instead of the shared temp directory.
- `&amp;lt;` in source text now reads `&lt;`, not `<`; heading outlines strip nested tag fragments;
  `html_window_var` names are matched literally and `</script >` end tags are recognised.
- Backfilled older items now show their real publish date.
- Hugging Face blog title whitelist extended with new robotics topics.

### Removed

- A private overlay (maintainer-only integrations and their build/config files) was unplugged from
  the public tree. Paths listed in `scripts/oss-export.exclude` are maintainer-only and are not
  published.

## Earlier history

There is no public release before `0.1.0`: everything above is the first public version,
developed during a private trial. This repository starts from a single commit; the history of the
AIHOT framework this fork is based on lives in the upstream repository
(https://github.com/KKKKhazix/AIHOT); see `NOTICE` for attribution.

[Unreleased]: https://github.com/CyrusAurora/topka/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/CyrusAurora/topka/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/CyrusAurora/topka/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/CyrusAurora/topka/releases/tag/v0.1.0
