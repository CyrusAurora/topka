# Architecture

## Data flow

```mermaid
flowchart LR
  SRC["Sources<br/>RSS · HTML lists · JSON · X<br/>WeChat official accounts · external push"] --> COL["Collect<br/>fetch · dedupe · full-text extraction"]
  COL --> ED["Editorial (LLM)<br/>prefilter · 2x scoring · summary<br/>structure · translate"]
  ED --> GRP["Events<br/>grouping · heat · story digests"]
  ED --> POOL["Content pool +<br/>daily / weekly / monthly reports"]
  GRP --> POOL
  POOL --> READ["Publication read layer<br/>packages/backend/src/publication/"]
  READ --> API["API (Fastify)<br/>public API · MCP · admin · auth"]
  READ --> FEEDS["RSS · sitemap · llms.txt · OG images"]
  API --> WEB["Web (React Router SSR)<br/>reads the API over HTTP only"]
  USERS["Users<br/>accounts + BYOK model keys"] --> API
  API --> WORKER["Worker<br/>pg-boss jobs + schedules<br/>only place that calls models"]
  ED -.-> WORKER
  WORKER --> DB[("PostgreSQL<br/>+ pg-boss queue")]
  COL --> DB
  DB --> READ
  DB --> API
```

Money-touching path: every request to a paid service (models, X, WeChat official accounts, Jina)
is checked against per-minute / per-hour / per-day budgets first, then recorded as a receipt, and
the response is stored before use — a retried job reuses the paid result instead of paying twice
(`packages/backend/src/providers/receipts.ts`).

## Process layout

Everything talks to the same database; each role runs in its own container in the default
`docker compose` deployment:

```mermaid
flowchart TB
  subgraph compose["docker compose services"]
    CADDY["caddy (profile https)<br/>TLS for SITE_DOMAIN"]
    WEB["web :3000<br/>SSR site"]
    API["api :3001<br/>Fastify"]
    WORKER["worker<br/>queues + schedules"]
    SETUP["setup<br/>migrate + seed, exits"]
    RSSHUB["rsshub<br/>routes for sources that need it"]
    DB[("db<br/>PostgreSQL 17")]
  end
  VIS["Visitors"] --> CADDY --> WEB
  WEB -- "HTTP only" --> API
  API --> DB
  WORKER --> DB
  WORKER --> RSSHUB
  WORKER -- receipts/budgets --> EXT["Model / paid APIs"]
  SETUP --> DB
```

Production without Docker runs three long-lived processes from one checkout: `apps/api/src/main.ts`
(3001), `apps/worker/src/main.ts`, and `apps/web/server.ts` (3000) — see
[docs/self-hosting.md](self-hosting.md).

## The three processes

| Process | Code | What it does |
|---|---|---|
| api | `apps/api/` | Fastify. Site-facing endpoints (`/api/site/`-based, auth, MY endpoints such as `/api/me/keys`), public API (`/api/v1/`), RSS, MCP, admin endpoints, image proxy, OG images |
| worker | `apps/worker/` | pg-boss job queues and cron schedules: collect sources, run model jobs, group events, heat, reports, alerts, backups, cleanup |
| web | `apps/web/` | React Router, server-side rendered. Reads the api **only over HTTP**; never touches the database |

Domain logic lives in `packages/backend/` (sources, ingest, editorial/LLM, events, reports,
projects, the publication read layer, accounts, providers); shared types and constants in
`packages/contracts/`; everything industry-specific in `industry/`.

## Invariants worth keeping

These rules are what makes the system safe to extend (they are the same rules given to coding
agents in [AGENTS.md](../AGENTS.md)):

- **One publication read layer.** Web pages, RSS, the public API, MCP, sitemap, `llms.txt`, OG
  images all read from `packages/backend/src/publication/`, so every outlet shows the same
  content. New public outlets read from this layer too.
- **Page views never call models.** A reader's page load reads database state only. Model calls
  happen exclusively in worker jobs (`apps/worker/`, pg-boss). This is a deliberate property: the
  public site is anonymous, cacheable, and cost-free per view.
- **Paid requests go through receipts and budgets.** No direct provider calls outside the
  providers layer; receipts record cost and reused results; budgets are circuit breakers per
  service (`/admin` → Settings → Budget).
- **Safety valves default off.** `COLLECT_ENABLED`, `MODEL_CALLS_ENABLED`, `FEISHU_*_ENABLED`,
  `INDEXNOW_SUBMIT_ENABLED` control whether anything is *sent out*, not which code path runs.
  Development and tests keep them off; tests never hit external services (local stubs serve every
  provider).
- **BYOK keys stay encrypted at rest.** Per-user model keys (`/api/me/keys`, migration 0052) are
  AES-256-GCM encrypted with `KEY_ENCRYPTION_SECRET`; the API returns only the last 4 characters.
- **Frontend is HTTP-only.** `apps/web` reads `apps/api` over HTTP; database access, model calls
  and secrets exist only in the backend apps.
- **Public content is anonymous.** Admins see what visitors see; bookmarks/read state live in the
  browser; the admin UI is admin-only.
- **Migrations are append-only.** `database/migrations/*.sql` run in name order in their own
  transactions; edits only append new files. See `scripts/migrate.ts`.
- **Old material never floods "Today".** Items published more than 48 hours before discovery,
  fresh-import backfills, and batch pushes are archived by original publish time: they never
  enter "Today" and never push a notification.
- **Source traceability.** Every selected item links to the original; full-text display is
  per-source (`site_fulltext`), default off.

## Directory map

| Location | Contents |
|---|---|
| `industry/` | Industry pack: site copy, taxonomy, topics, demo sources, prompts, thresholds, brand, legal pages |
| `packages/backend/src/sources/` | Readers for the six source kinds; collect scheduling (`collect.ts`) |
| `packages/backend/src/content/` | Ingest, dedupe, full-text extraction and cleaning |
| `packages/backend/src/editorial/` | Judging and writing: `analyze.ts` (flow), `prompts.ts` (loads prompts), `models.ts` (per-step model routing) |
| `packages/backend/src/events/` | Event grouping, heat, story digests |
| `packages/backend/src/projects/` | Tracking projects: baselines, per-project scoring, checkpoint revisit, today views, per-user issues |
| `packages/backend/src/accounts/` | Invites, sessions, per-user keys (BYOK) |
| `packages/backend/src/jobs/` | pg-boss queue, job registrations |
| `packages/backend/src/publication/` | The publication read layer |
| `packages/backend/src/reports/` | Daily / weekly / monthly reports and per-user issues |
| `packages/backend/src/leaderboard/`, `monitor/` | Model leaderboard, Codex reset monitor ([leaderboard.md](leaderboard.md)) |
| `packages/backend/src/notify/` | Feishu push |
| `packages/backend/src/operations/` | Alerts, backups, retention, IndexNow |
| `packages/backend/src/admin/` | Admin endpoints |
| `packages/backend/src/providers/` | Model, embedding, X, WeChat official accounts (via third-party API), Jina clients; receipts and budgets |
| `apps/web/app/routes/` | One file per page; `routes.ts` is the route table |
| `database/migrations/` | Append-only SQL migrations |
| `scripts/` | Init, migration, seed, evaluation, checks |
| `tests/` | Backend tests (need an empty database named `…_test` or `…_ci`) |
| `database/seeds/` | Seed data the migrations and `scripts/seed.ts` load |
| `deploy/` | Reverse-proxy example (Caddy); `docker-compose.yml` at the root is the supported stack |
| `examples/` | Example plugin ([plugins.md](plugins.md)) |
| `reference/` | OpenAPI description of the public API |
| `packages/backend/src/plugins.ts`, `providers/chat-routes.ts` | Plugin loader (`TOPKA_PLUGINS`) and the interactive chat route API |

## Public outlets

| Route | Contents |
|---|---|
| `/` `/all` `/hot` `/topics` `/daily` `/weekly` `/monthly` | Selected, all items, hot events, topics, reports |
| `/today` `/archive` `/chat` `/settings` | Logged-in user: today's issue, past issues, chat, BYOK keys |
| `/feed.xml` `/feed/all.xml` `/feed/full.xml` `/feed/daily.xml` | RSS: selected, all, full-text, daily |
| `/api/v1/` | Public API (OpenAPI at `/openapi-v1.json`, explainers at `/agent`) |
| `/api/mcp` | MCP endpoint; tool-name prefix from `industry/site.ts` |
| `/llms.txt` `/sitemap.xml` `/robots.txt` | For LLMs and crawlers |
| `/api/health` | Health check for monitoring |
| `/admin` | Admin UI |
| `/leaderboard` `/codex-reset` | Optional AI-industry modules, off in `industry/features.ts` |

## Verification

```bash
npm run typecheck
createdb topka_test
DATABASE_URL=postgres://127.0.0.1:5432/topka_test node scripts/migrate.ts
DATABASE_URL=postgres://127.0.0.1:5432/topka_test npm test
npm run build -w @topka/web && node --test apps/web/tests/*.test.ts
docker compose exec web node scripts/smoke.ts --base http://localhost:3000   # with the Docker stack running
```
