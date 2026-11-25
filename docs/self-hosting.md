# Self-hosting

Run Topka on your own machine with your own model key (BYOK): install, models, HTTPS, backup, upgrade
and troubleshooting. Every variable is in [configuration.md](configuration.md).

## Requirements

- Docker with Compose (recommended). A 2-core / 4 GB machine is enough to build and run.
- Or without Docker: Node.js ≥ 24.11 and PostgreSQL 16/17 (migrations need the `pg_trgm` and
  `citext` extensions, both in PostgreSQL's contrib).
- A model: a key for any OpenAI-compatible endpoint, a free route (OpenRouter `:free` models or a
  local Ollama), or for a first look the built-in demo model, see
  [Model connection](#model-connection). Optional: an embedding key.

## First start (Docker)

Keep collection and model calls off during setup:

<!-- doc-test: run quickstart; timeout 1800 -->
```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:26-trixie-slim \
  node scripts/init-env.ts          # creates .env: random secrets + admin password (printed once)
# edit .env: model connection (next section); COLLECT_ENABLED / MODEL_CALLS_ENABLED default to false
docker compose up -d --build
```

The port lives in one place, `PORT` in `.env` (default `127.0.0.1:3000`). If 3000 is taken, change
that line, e.g. `PORT=127.0.0.1:3300`, or generate `.env` with `init-env.ts --port 127.0.0.1:3300`.
Every later `docker compose up` picks it up, and the site address used in links, the issue feed and
share images follows it (`http://localhost:3300`), so there is no second place to edit. Set `SITE_URL`
only when readers use another address (a domain, see [HTTPS](#https-caddy-profile)).

Notes:

- Working from a fork? Clone your fork's URL instead; everything below is the same.
- `init-env.ts` refuses to overwrite an existing `.env` (exit code 1; the existing passwords and
  secrets stay as they are). Flags: `--port <addr:port>`, `--demo` (`DEMO_SEED=true`),
  `--locale en` (`SITE_LOCALE=en`), and `--llm-key <key>`, which puts the key into shell
  history — editing `.env` directly is preferred. With Node ≥ 24 on the
  machine, `node scripts/init-env.ts` works without the container. Or copy `.env.example` to `.env` and fill in `ADMIN_PASSWORD` (≥ 12 characters),
  `SESSION_SECRET`, `IMG_PROXY_SIGN_SECRET`, `KEY_ENCRYPTION_SECRET` and `POSTGRES_PASSWORD`
  (each with `openssl rand -hex 32`). `docker compose` does not start without `POSTGRES_PASSWORD`.
- Opening the site for the first time starts `db` (PostgreSQL 17), `setup` (applies
  `database/migrations` and the seed once, then exits), `api`, `worker`, `web` and `rsshub`.
  It also imports the project packs (`database/seeds/packs/*.json`) that 新建项目 offers, switched
  off. Site: `http://localhost:3000` (or your `PORT`), admin: `/admin`, login with `ADMIN_PASSWORD`.
- On a fresh database every source is imported **switched off**. To start fetching and analysing,
  turn sources on and set `COLLECT_ENABLED=true`, `MODEL_CALLS_ENABLED=true`.
- Without a model connection configured, worker jobs wait (articles stay pending); see
  [Troubleshooting](#troubleshooting).

Check that it is up (the web server forwards `/api/*` to the API, so this tests web, API and database
in one go). `docker compose port web 3000` prints where this stack's web container is published, so
the check follows `PORT` and never reaches another service that happens to hold port 3000:

<!-- doc-test: run quickstart; retry 180; expect "ok":true -->
```bash
docker compose ps                                         # db healthy; api, worker, web running; setup exited (0)
curl -s "http://$(docker compose port web 3000)/api/health"   # {"app":"topka",…,"ok":true,"db":"ok",…}
```

Right after `up` returns, the first request can come back empty; wait a few seconds and repeat.

First time on this stack? The [tutorial](tutorial.en.md) runs the same start with demo data, shows the
output to expect at each step, and needs no key.

## Model connection

In plain words: the worker sends each article to an LLM (a large language model) to prefilter,
score, summarise and group it. Topka talks to any **OpenAI-compatible** endpoint, the request format
most providers offer. The simplest setup is three lines in `.env` with a key from the provider's
console (the key is the password for calling the model, and the provider bills you for its use):

<!-- doc-test: skip lines for .env with placeholder values, not commands -->
```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-flash
```

That is route 3 below. Routes 1 and 2 are for running on free models only. To try Topka with no key
and no cost, see [Without a paid key](#without-a-paid-key).

### Without a paid key

Three options, from no setup to real answers.

**Built-in demo model (offline, canned answers).** With `DEMO_SEED=true` and no real model
connected, 对话 (Chat) and card copy answer from a deterministic, rule-based model built into Topka:
the full flow (questions → summary → tracking card → 确认 creates the project) works offline. Every
answer says it comes from the demo model, and the chat page shows a "Demo model" banner. It never
analyses articles, so no invented analysis reaches real content. `LLM_DEMO=false` turns it off,
`LLM_DEMO=true` forces it on; it switches itself off once a real model is configured.

<!-- doc-test: skip the first line belongs in .env, not in a shell -->
```bash
DEMO_SEED=true            # in .env; `init-env.ts --demo` writes it
docker compose up -d
```

**Local model with Ollama (free, no account; works best with a GPU).** The compose file has an
`ollama` service behind a profile. In `.env`:

<!-- doc-test: skip lines for .env with placeholder values, not commands -->
```bash
COMPOSE_PROFILES=ollama
LLM_BASE_URL=http://ollama:11434/v1
LLM_API_KEY=ollama            # any non-empty value; Ollama ignores it
LLM_MODEL=qwen2.5:7b
LLM_EXTRA_JSON=
MODEL_CALLS_ENABLED=true
```

Then start it and download the model once (4.7 GB; it stays in the `ollama` volume):

<!-- doc-test: skip pulls a 4.7 GB local model and needs the memory to run it -->
```bash
docker compose up -d
docker compose exec ollama ollama pull qwen2.5:7b
```

The demo banner in 对话 goes away and requests go to the local model. What to expect: Topka asks the
model for strict JSON (the 对话 assistant's questions and cards, each article's analysis), and small
models often break the format. Measured on an 8-core CPU with no GPU, Ollama 0.40.16:

| Model | 对话 | Article analysis |
|---|---|---|
| `qwen2.5:1.5b` (1 GB) | every turn rejected (questions without answer options): 「这次没想明白」 | not tried |
| `qwen2.5:3b` (1.9 GB) | answers, but asks the same question again and never reaches a card | not tried |
| `qwen2.5:7b` (4.7 GB) | 10–30 s a turn; about half the turns rejected | filter and score pass; the full analysis step failed its format; minutes per article |

So on a CPU, Ollama shows that a local endpoint is wired up, not a working 对话 or daily issue. For
those at no cost, use the `:free` models below; for a tour, the demo model. A larger model on a GPU
(14B and up) should do better, but we have not measured it. Change `LLM_MODEL` to try one. Already running Ollama on the host instead?
Use `LLM_BASE_URL=http://host.docker.internal:11434/v1`, leave `COMPOSE_PROFILES` unset, and add
`extra_hosts: ["host.docker.internal:host-gateway"]` to the `api` and `worker` services in a
`docker-compose.override.yml`.

**OpenRouter `:free` models (free account, real hosted models).** Create an OpenRouter account
(no card needed) and a key, then in `.env`:

<!-- doc-test: skip lines for .env with placeholder values, not commands -->
```bash
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_FREE_MODELS=google/gemma-4-31b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free
LLM_EXTRA_JSON=
MODEL_CALLS_ENABLED=true
```

The free list changes over time: pick current ids at <https://openrouter.ai/models?max_price=0>
(ids ending in `:free`). Only candidates whose listed price is 0 are called (route 2 below); with none free right now, work
waits instead of falling back to a paid model. Free accounts have a small daily allowance
(OpenRouter's limits); `docker compose exec api npm run models:free` shows what is usable.

The model routing picks the first line that applies; step 4 is a per-step override:

1. `OPENCODE_API_KEY` or `AGNES_API_KEY` is set → the free-tier chain follows `LLM_PROVIDER_ORDER`
   (default `opencode,agnes,openrouter`; only configured providers join).
   - OpenCode Zen only uses models that satisfy **all three** checks: on its live model list,
     marked `-free` in the docs, and priced at zero on models.dev; never big-pickle / nemotron;
     order from `OPENCODE_FREE_ORDER` (default `deepseek,glm,mimo,minimax,beam,longcat`).
   - Agnes uses `AGNES_MODEL` (default `agnes-3.0-flash`); a billing/quota refusal benches it
     until 08:00 Taipei time.
   - If the whole chain has no usable model, the system pauses (`NO_FREE_MODEL`) — it does **not**
     fall back to `LLM_MODEL`. The chain's `openrouter` entry only joins when `LLM_FREE_MODELS`
     is also set.
2. No free-chain key, but `LLM_FREE_MODELS` is set → only OpenRouter `:free` models are used
   (`LLM_BASE_URL=https://openrouter.ai/api/v1`, `LLM_API_KEY` = OpenRouter key). Each candidate
   is verified against the OpenRouter `/models` pricing before use (every price field must be
   `"0"`; `openrouter/*`, `auto` and non-`:free` ids are never called; the verification result is
   cached 1 hour and re-checked when the worker starts). Daily headroom:
   `LLM_FREE_DAILY_RESERVE` (default 20).
3. Neither set → plain `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` (any OpenAI-compatible
   endpoint). This is a model you chose and may cost money at your provider's rates. Budget
   circuit breakers apply per service (`/admin` → Settings → Budget; defaults for the llm
   service: 300 / min, 6000 / hour, 40000 / day).
4. Per-step overrides: `PREFILTER_MODEL` `SCORE_MODEL` `UNDERSTAND_MODEL` `SUMMARIZE_MODEL`
   `STRUCTURE_MODEL` `GROUP_MODEL` `GROUP_REVIEW_MODEL` take preset names and need the matching provider keys
   (`DEEPSEEK_*`, `DASHSCOPE_*`, `ZHIPU_*`, `XIAOMI_MIMO_*`). These **bypass the free-model
   guard** (no max-price-0 check) and bill to their provider — don't set them if you want zero
   cost only.

Rules that hold in all cases:

- The system never switches to a paid model on its own: when a free route has no free model, it
  pauses (articles wait, nothing is counted as failure).
- Every call records the model that actually answered and `usage.cost`; a different model or a
  non-zero cost logs `FREE_MODEL_ALERT` and benches that model for 24 hours.
- `npm run models:free` (Docker: `docker compose exec api npm run models:free`) shows whether the OpenRouter/embedding candidates are currently free and
  whether the last 24 hours saw any billing (exit code 1 on problems; it does not check the
  OpenCode/Agnes chain).

Embeddings (optional, improves event grouping): `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`,
`EMBEDDING_MODEL`, or a free-only SiliconFlow embedding route via `EMBEDDING_FREE_MODELS`
(+ `EMBEDDING_FREE_DIMS`, default 1024, all candidates must share the dimension). Unset works
too — grouping just loses one signal.

## BYOK: instance key vs. user keys

Two kinds of keys coexist:

- **Instance key** — the model connection above. Runs all background work; its budget guards sit
  in the admin UI.
- **User keys (BYOK)** — registered users may store their own OpenAI-compatible key in
  Settings (`GET/PUT/DELETE /api/me/keys`). Interactive routes (the web `/chat`) prefer the
  user's key over the instance's, so a person who brought their own key does not spend the
  instance budget. A stored key is used only when it has a Base URL (and a model, its own or
  `LLM_MODEL`); the "llm" entry wins, else the most recently saved one.
- **Base URL guard (SSRF)** — this server fetches the reader's Base URL, so it must be a public
  `https://` endpoint without credentials in it; loopback, private, link-local and cloud-metadata
  addresses (by name or DNS answer) are refused on save (400 `bad_base_url`) and again on every
  call, and the request does not follow redirects. Local development may allow loopback with
  `BYOK_ALLOW_PRIVATE_BASE_URL=true` — never in production.
- **What the reader sees**: `GET /api/me/model-status` reports who would answer their chat —
  their key, the instance, or nobody (and why: `MODEL_CALLS_ENABLED=false`, or no route
  configured). 设置 shows it, and the chat page closes its input with a link to 设置 when nobody
  can answer; `POST /api/me/chat` then answers 409 `no_model` instead of starting a turn.

Key storage:

- Requires `KEY_ENCRYPTION_SECRET` (32+ random characters). `scripts/init-env.ts` generates it,
  so a `.env` made by init-env has BYOK working with no extra step; by hand use
  `openssl rand -hex 32`. Without it, the settings page keeps BYOK disabled (saving a key answers
  503) and users can only use the instance's key.
- Keys are encrypted with AES-256-GCM (a key is derived as SHA-256 of the secret) and never sent
  back in full — the API shows only the last 4 characters (implementation:
  `packages/backend/src/accounts/user-keys.ts`, migration `0052_user_provider_keys.sql`).
- **Rotation caveat**: the code does not re-encrypt stored keys when the secret changes. If you
  rotate `KEY_ENCRYPTION_SECRET`, previously stored keys cannot be decrypted — each user must
  re-enter their key in Settings. Plan rotation with users, or accept that entries lapse.

## Project packs

新建项目 (`/projects/new`) starts from a pack: a curated set of sources for one direction. Four ship
in `database/seeds/packs/`: AI models (`ai-models`), embodied AI & robotics (`embodied`),
open source & developers (`opensource-dev`) and semiconductors & compute (`semiconductor`). The
`setup` service imports all of them on every start, switched off and without touching sources that
already exist, so every pack is selectable on a fresh install. A pack shows as unavailable only
when none of its sources are in the database (an older install that has not restarted since
upgrading) or none match the region filter; the page then says which, with the command to fix it:

<!-- doc-test: run quickstart -->
```bash
docker compose exec api npm run sources:seed -- --pack embodied   # file name or pack id
```

`sources:seed` with no `--pack` lists the packs. On a pack's own run, missing sources are created
switched off and existing ones are merged by id (then exact name+kind match), with the pack's config
keys overriding and current switch states kept; re-running changes nothing. Variants: `--only` keeps
only the pack on, `--enable` turns the pack on and leaves the rest.

A project picks sources; it does not switch them on. Its page says how many of them are switched
on and whether collection is off.

## Switching sources on

Only switched-on sources are collected and only their content reaches the model. The admin page
`/admin/sources` (new source at `/admin/sources/new`, with a test-fetch) or the CLI.

Every `npm run …` command on this page runs inside the stack under Docker, with no Node on the
host: prefix it with `docker compose exec api`, e.g.
`docker compose exec api npm run sources:list -- --enabled`. (Without Docker, run it as written
in the repo directory.)

<!-- doc-test: skip host-side commands with placeholders in angle brackets, for a site run without Docker -->
```bash
npm run sources:list -- --enabled            # also --disabled, --q TEXT
npm run sources:toggle -- --off --id <source id or full name> [--id ...]
npm run sources:only -- --id <id>            # keep only these on, everything else off
```

To switch on a whole pack instead of picking sources by hand (here only the embodied pack stays on):

<!-- doc-test: run quickstart -->
```bash
docker compose exec api npm run sources:seed -- --pack embodied --only
```

Then set `COLLECT_ENABLED=true` (and `MODEL_CALLS_ENABLED=true` for analysis) in `.env` and run
`docker compose up -d` (containers read `.env` only when they are recreated).

How often: the worker looks every minute for sources that are due. Each source has its own
interval, from 15 minutes for the busiest to a few hours for the quietest, tuned daily from how
often it publishes. New items reach a project page once analysed, and the next morning's issue.

`includeIfMatches` (regex filters on title/summary) and `dailyCap` (per-24h item cap) let you
trim noisy sources — unmatched items fetch no full text and cost no model money. See
[docs/sources.md](sources.md).

## Users, projects and the daily issue

- **Registration** is set by `REGISTRATION_MODE`:
  - `open` (the default): anyone may sign up at `/register` with an email and a password (10+
    characters, not the email itself); no invite code. Readers then bring their own model key in
    设置 (BYOK, below) unless the instance offers a model. Abuse brakes ship with it: a hidden
    honeypot field, at most 5 attempts per client per hour (weak-password typos do not count),
    and at most `REGISTRATION_HOURLY_LIMIT` (default 30) new accounts per hour for the whole
    instance; over either limit the API answers 429 in plain words. Login keeps its own limiter
    (10 attempts per minute per IP). Behind a reverse proxy, forward the client address
    (`X-Forwarded-For`) so the per-client cap sees real clients.
  - `invite`: an invite code is required (any value other than `open` means invite, so a typo
    fails closed). The register page asks for the code only in this mode
    (`GET /api/auth/registration` tells it which). Create codes with:

  <!-- doc-test: run quickstart -->
  ```bash
  docker compose exec api npm run invite:create             # 1 use, 7 days, random code
  docker compose exec api npm run invite:create -- --uses 5 --days 30 --note "first round"
  ```

  The command prints the code and the registration URL (`SITE_URL` + `/register`).
- Create and manage tracking projects: `npm run project:create -- --owner <email> --target
  <subject> --purpose <why> --source <id> [<source> ...]`; focus and exclusions:
  `npm run project:brief -- --project <slug> --focus "…" --exclusions "…"`; rescore candidates
  that missed project scoring: `npm run project:rescore -- --project <slug> [--max N] [--dry-run]`.
- **Web reminder (no email, no push)**: in 设置 → 每日提醒, a reader generates a private Atom feed
  (`/feed/issue/<token>.xml`) and adds it to any feed reader; each morning's fixed issue shows up
  there (held back up to 2 hours while its card copy is written). The token is 256-bit random,
  stored only as its SHA-256 (`user_issue_feeds`, migration `0055`), shown once, and replaced by
  「换一个地址」; the feed carries only that reader's own issues, is `noindex`, and is cached
  `private, max-age=300`. Nothing to run or configure on the instance side.
- **Daily issue**: one fixed issue per user per day, at most 3 items across all their projects,
  cut off at 08:00 in that reader's own time zone and not changed for the rest of their day;
  articles and their events already shown never return. The time zone is an IANA name stored per
  account (`users.timezone`, default `Asia/Shanghai`, where 08:00 = 00:00 UTC), chosen in Settings
  or with `PATCH /api/auth/me {"timezone": "Europe/London"}`; the server's own timezone plays no
  part (`packages/backend/src/projects/issue-rules.ts`). There is no scheduled job for it on the
  web side: when a logged-in user opens `GET /api/me/today` for the first time after their 08:00,
  the day's issue is generated.
- **Language**: each reader picks 简体中文 or English in Settings (`users.locale`, `zh-CN` or
  `en`, also `PATCH /api/auth/me {"locale": "en"}`). The whole web UI follows it, admin included,
  and the copy on that reader's daily cards is written in it. Signed-out visitors and the admin
  get `SITE_LOCALE` (default: the industry pack's `SITE.locale`, `zh-CN` here). The Chat
  assistant answers in the reader's language. The public pool (titles, summaries) and the feeds
  stay in the site's language. UI: `/today` and `/archive`; API:
  `GET /api/me/issues`, `GET /api/me/issues/<date>`.
- Project pages: `/projects/<project slug>` (the old `/today/<project slug>` redirects there) with a fixed number of project-scored cards
  (`TODAY_CARD_COUNT`, 3–5, default 3); export a snapshot with
  `npm run today:export -- [--project <id or slug>] [--out DIR]`; without `--out` the files go to
  `$TOPKA_DATA_DIR/snapshots` (under Docker `/data/snapshots` in the `data` volume:
  `docker compose exec api npm run today:export`, then
  `docker compose cp api:/data/snapshots ./snapshots` to copy them out).

## What the worker schedules

All schedules follow `Asia/Shanghai` time (UTC+8), recorded in the `job_runs` table; missed cron
slots run once on catch-up (`apps/worker/src/schedules.ts`). Highlights:

- Every minute: sources that are due are fetched (`sources.schedule`). Each source has its own
  interval (15 minutes to a few hours, auto-tuned daily at 04:20); with collection disabled the
  whole collection set is not registered at all.
- Every 5 minutes: content sweep (anything collected but not yet analysed).
- Every 15 minutes: items a project's source also listed are scored for that project.
- Every 10 minutes: recovery (stale paid requests), alert checks, feedback forwarding.
- Hourly: discovery channels and their promotion gate (twice an hour).
- Daily: retention 03:30; database backup 04:10 (only when `DB_BACKUP_STORE_*` is configured);
  source interval auto-tuning 04:20; source icons 04:40; ops digest 09:00.
- Weekly: source-health report Mondays 09:00.
- A reader's daily issue is cut at 08:00 in their time zone, the first time it is read after that.
- OpenRouter's free daily allowance resets at 00:00 UTC (= 08:00 UTC+8). History backfill is only
  analysed 20:00–08:00 (`HISTORY_ANALYSIS=defer`) and only while more than
  `HISTORY_ANALYSIS_RESERVE` (default 150) calls remain for the day.

## HTTPS (Caddy profile)

Point the domain's DNS at the server, then set in `.env`:

<!-- doc-test: skip lines for .env with placeholder values, not commands -->
```bash
SITE_DOMAIN=example.com # the site address becomes https://example.com
TRUST_PROXY=true        # read visitor addresses from the reverse-proxy headers
```

<!-- doc-test: skip needs a public domain pointing at this machine for the TLS certificate -->
```bash
docker compose --profile https up -d --build
```

Caddy (`deploy/Caddyfile`) obtains and renews the certificate for `SITE_DOMAIN` automatically.
The web container itself stays published on `127.0.0.1:3000` only (the compose default), so the
plain-HTTP port is never reachable from outside; only Caddy's 80/443 are.

Reaching the site from another machine **without** HTTPS (a LAN test box, say) needs
`PORT=0.0.0.0:3000` in `.env` (and `SITE_URL=http://<that machine's address>:3000`): that publishes it on every interface, admin login included, over plain HTTP. Docker writes
its own firewall rules for published ports, so a host firewall such as `ufw` does not block it.
Already running Nginx? Skip the Caddy profile and reverse-proxy the site to
`http://127.0.0.1:3000` with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, and
set `TRUST_PROXY=true` in `.env`. The site address must be the URL readers actually use, since
generated links, the issue feed and share images all use it: it follows `PORT`, then `SITE_DOMAIN`;
set `SITE_URL` when neither gives the right one.

## Running without Docker

<!-- doc-test: skip the path without Docker needs a PostgreSQL server you administer; the Check job runs the same steps on its own database -->
```bash
npm ci
node scripts/init-env.ts
createdb topka
```

In `.env`, add:

<!-- doc-test: skip lines for .env with placeholder values, not commands -->
```bash
DATABASE_URL=postgres://<user>@127.0.0.1:5432/topka
API_BASE_URL=http://127.0.0.1:3001
```

<!-- doc-test: skip long-running servers for the path without Docker; the Check job starts the same three processes in its smoke step -->
```bash
npm run db:migrate                   # applies database/migrations/*.sql in order; safe to re-run
node --env-file=.env scripts/seed.ts # demo sources and packs (existing rows are not overwritten)
npm run build -w @topka/web
node --env-file=.env apps/api/src/main.ts          # API, port 3001
node --env-file=.env apps/worker/src/main.ts       # collection, model jobs, schedules
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts   # web, port 3000
```

Keep all three processes alive (systemd or pm2). Dev hot-reload: `npm run dev:api`,
`npm run dev:worker`, `npm run dev:web`. Development-only auto-login at `/admin`:
`DEV_AUTH_ROLE=admin` (production refuses to start with it set).

## Migrations

<!-- doc-test: skip the path without Docker needs a PostgreSQL server you administer; the Check job runs the same steps on its own database -->
```bash
npm run db:migrate
```

Each SQL file in `database/migrations/` runs in its own transaction, in name order, with applied
files tracked in `schema_migrations`; re-running is safe. Migrations are **append-only** (no edits
to already-applied files); a migration can inline seed data with `{{seed:<file>.json}}` from
`database/seeds/`. Under Docker, `docker compose up -d --build` applies pending migrations
automatically (the `setup` service). **Take a backup before upgrading.**

## Upgrade procedure

<!-- doc-test: skip git pull needs the remote of your own clone; the up --build after it runs in the quickstart blocks -->
```bash
git pull
docker compose up -d --build
```

- Migrations apply automatically during the rebuild; they are backward-compatible increments.
- Check `CHANGELOG.md` for any action items attached to a release (new variables, migrations).
- Without Docker: `git pull`, `npm ci`, `npm run db:migrate`, rebuild the web bundle, restart the
  three processes.

## Backup and restore

Three Docker volumes hold all state: `db` (database), `data` (uploaded images, image cache, local
backups, `/data` in the container), and `caddy` (certificates). `docker compose down` keeps them;
`docker compose down -v` deletes them.

- Scheduled: set `DB_BACKUP_STORE_*` in `.env` for any S3-compatible object store; a backup runs
  daily at 04:10 (needs `pg_dump`, present in the app image).
- Manual:

  <!-- doc-test: run quickstart -->
  ```bash
  docker compose exec -T db pg_dump -U topka topka | gzip > topka-$(date +%F).sql.gz
  ```

- Restore: load the dump into a **new, empty** database, then swap it in. Never load it into the
  live `topka` database — the dump re-creates every table and fails on the existing ones.

  <!-- doc-test: run quickstart -->
  ```bash
  # 1. a new empty database; createdb refuses if the name already exists
  docker compose exec -T db createdb -U topka topka_restore
  # 2. load; ON_ERROR_STOP aborts at the first error instead of half-loading
  gzip -dc topka-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U topka -d topka_restore -v ON_ERROR_STOP=1 -q -o /dev/null
  # 3. swap: stop the app, drop the old database, rename the restored one, start again
  docker compose stop api worker web
  docker compose exec -T db psql -U topka -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE topka' -c 'ALTER DATABASE topka_restore RENAME TO topka'
  docker compose up -d
  ```

  If step 2 fails, nothing live was touched: drop the half-loaded copy with
  `docker compose exec -T db dropdb -U topka topka_restore` and retry. Step 3 is the only
  destructive one; run it only after step 2 finished without errors. On a different machine,
  re-create `.env` from your copy first, and keep the `data` volume (or restore it) for uploaded
  images and image cache.
- Also keep a copy of `.env` — without `SESSION_SECRET` sessions break, without
  `KEY_ENCRYPTION_SECRET` stored BYOK keys cannot be read back.

## Monitoring

- `GET /api/health` answers JSON for uptime checks.
- Admin → "Runs" page shows the recent result of every scheduled job; the "Sources" page shows
  per-source fetch status.
- Whole-site smoke check of every main page and machine endpoint:

  <!-- doc-test: run quickstart; retry 120; expect all checks passed -->
  ```bash
  docker compose exec web node scripts/smoke.ts --base http://localhost:3000
  ```

  (`localhost:3000` here is inside the container, whatever `PORT` is.)

  (It runs inside the `web` container, so no Node is needed on the host; without Docker:
  `node scripts/smoke.ts --base http://localhost:3000`.)

- In the admin UI: per-step model call counts and token usage; budget usage under Settings →
  Budget; SelectBench for editorial calibration.
- Logs: `docker compose logs -f --tail 100 api worker web`.
- Alerts to a Feishu group (or any compatible webhook): set `ALERT_WEBHOOK_URL`, restart, run
  `npm run alerts:test`. See [alerts.md](alerts.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Exits at startup with `Refusing to start in production: …` | `SESSION_SECRET` / `IMG_PROXY_SIGN_SECRET` missing or a placeholder, `ADMIN_PASSWORD` shorter than 12 characters, or `DEV_AUTH_*` set | Fix `.env` (or regenerate it with `init-env`) |
| `required variable POSTGRES_PASSWORD is missing a value` | No `.env`, or it has no `POSTGRES_PASSWORD` | Run `init-env`, or set it with `openssl rand -hex 32` |
| `Bind for …:3000 failed: port is already allocated` | Another process holds the port | Set `PORT=127.0.0.1:3300` (or another free port) in `.env`, then `docker compose up -d`; links and the health check follow it |
| No content at all | `COLLECT_ENABLED` / `MODEL_CALLS_ENABLED` false; no enabled sources (`npm run sources:list -- --enabled`); fetch errors | Errors show at `/admin/sources`; servers in mainland-China networks need `EGRESS_PROXY_URL` for overseas sources |
| Log `Model … is not configured (LLM_BASE_URL, LLM_API_KEY, …)` | No model route | [Model connection](#model-connection) |
| Log `NO_FREE_MODEL` / `NO_FREE_EMBEDDING` | No candidate is *verifiably* free right now (rate limit, quota, or the price check failed) | Work waits and nothing counts as failure; check `npm run models:free`, add candidates, or wait for the 08:00 UTC+8 reset |
| Log `FREE_MODEL_ALERT` | An answer came from another model or was billed | That model is benched for 24 hours; check the provider configuration |
| History items never get analysed | By design (`HISTORY_ANALYSIS=defer`) | Nothing to fix |
| Weibo sources fail | They go through the `rsshub` container (`http://rsshub:1200`); without Docker there is none | Switch them off when running without Docker |
| `/api/me/today` empty after login | No project; or no analysed candidate in the window; or the issue was cut at 08:00 before any candidate was ready | An empty day is not refilled; the next cut is tomorrow 08:00 UTC+8 |
| Per-user BYOK cannot be entered or stops working | `KEY_ENCRYPTION_SECRET` unset, or changed after keys were stored | Rotation does not re-encrypt: users re-enter their keys |

## Note on deployment in mainland China

- Build and pull are faster with an npm mirror
  (`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`) and a Docker
  registry mirror; overseas sources need `EGRESS_PROXY_URL` (source fetches and images go through
  it, model calls do not).
- Serving a public site from mainland China additionally requires an ICP filing; the filing
  number goes in `industry/site.ts` (`icp`).
