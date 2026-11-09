# Contributing

Thanks for helping improve Topka. The essentials first:

## Project overview

Read `README.md` and the matching document under `docs/` before starting:

- [tutorial](docs/tutorial.en.md) ([中文](docs/tutorial.md)) — get a running site with demo data first (`DEMO_SEED=true`, or
  `npm run demo:seed` against a fresh local database)
- [architecture](docs/architecture.md) — apps, packages, invariants (read before touching code)
- [self-hosting](docs/self-hosting.md) — running the stack locally and in Docker
- [customize](docs/customize.md) — everything industry-specific lives in `industry/`
- [sources](docs/sources.md), [selection & calibration](docs/selection.md),
  [leaderboard](docs/leaderboard.md), [configuration](docs/configuration.md),
  [plugins](docs/plugins.md)

Codex-class agents: follow `AGENTS.md`.

## Development setup

- **Node.js ≥ 24.11** (TypeScript runs directly; the backend has no build step).
- **PostgreSQL 17 from Docker** (recommended), or your own PostgreSQL 16/17 with the `pg_trgm`
  and `citext` extensions. `docker-compose.yml` publishes no database port; for host-side tests
  publish it on `127.0.0.1:5432` with a local override (git-ignored, picked up automatically):
  ```bash
  printf 'services:\n  db:\n    ports: ["127.0.0.1:5432:5432"]\n' > docker-compose.override.yml
  docker compose up -d db
  ```
- One checkout, npm workspaces (`apps/*`, `packages/*`, `industry`):
  ```bash
  npm ci
  node scripts/init-env.ts          # creates .env with development-safe defaults
  docker compose up -d db           # PostgreSQL only
  docker compose exec db createdb -U topka topka_test   # test DB name must end in _test or _ci, and be empty
  export DATABASE_URL=postgres://topka:$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)@127.0.0.1:5432/topka_test
  node scripts/migrate.ts && npm test
  ```

Running the stack locally (three processes, or Docker) is documented in
[docs/self-hosting.md](docs/self-hosting.md).

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript over all workspaces |
| `DATABASE_URL=…/_test npm test` | backend tests (`node --test`; empty DB ending `_test`/`_ci`) |
| `DATABASE_URL=…/_test npm run test:coverage` | the same with line coverage of `packages/backend/src`; fails under 85% |
| `npm run build -w @topka/web && node --test apps/web/tests/*.test.ts` | web build and web tests |
| `node scripts/smoke.ts --base http://localhost:3000` | whole-site smoke check against a running stack |
| `npm run db:migrate` | apply migrations (reads `.env` if present) |
| `npm run dev:api` / `dev:worker` / `dev:web` | hot-reload dev processes |

Rules the tests enforce: they must never access an external service (models and paid APIs are
served by local stubs), and the safety valves (`COLLECT_ENABLED`, `MODEL_CALLS_ENABLED`,
`FEISHU_*_ENABLED`, `INDEXNOW_SUBMIT_ENABLED`) stay off in dev/tests unless a test explicitly
flips them.

Tests run against a clean environment: `tests/hermetic-env.ts` keeps only `DATABASE_URL` and the
usual process plumbing, so a key, a switch or a model choice exported in your shell cannot change
what a test sees. To hand one variable through on a single run, name it:
`HERMETIC_ENV_PASSTHROUGH=ALLOW_PRIVATE_NETWORK_FETCH DATABASE_URL=…/_test npm test`.

## How to add a source

Regularly: admin UI → "Sources" → new (with test-fetch), or push items via the external
endpoint (see [docs/sources.md](docs/sources.md)). A source shipping with the project
(a demo source or a pack):

1. Add it to `industry/sources.json` (demo sources) or a pack under `database/seeds/packs/`
   (see `scripts/sources-seed.ts`).
2. Pick the right `kind`, `tier`, `participation_mode`, `first_party`; leave `site_fulltext` off
   unless the publisher clearly allows full text.
3. Filters: `includeIfMatches` / `dailyCap` keep broad feeds from flooding the model queue.
4. Migrations are **never** used for source data; use the seed files.

## How to adapt the industry pack

Follow [docs/customize.md](docs/customize.md). The eight-step summary: site copy (`site.ts`),
taxonomy (`taxonomy.ts`), topics (`topics.json`), demo sources (`sources.json`), prompts
(`industry/prompts/`, keep the rubric structure — see below), thresholds (`selection.ts`,
recalibrate on labelled samples per `docs/selection.md`), feature switches (`features.ts`),
brand and legal pages (`brand/`, `pages/` — the maintainer must approve the legal copy).

## Migrations policy

- `database/migrations/*.sql` are append-only: never edit an already-shipped file; add new
  numbered files at the end.
- Each migration must be a backward-compatible increment (old schema keeps working).
- Each runs in its own transaction, in name order; seed data goes in `database/seeds/`
  (inlined with `{{seed:name.json}}` placeholders).
- Verify with a fresh empty test database named `…_test` or `…_ci`.

## Coding rules

From `AGENTS.md`, in brief:

- Frontend reads the API only over HTTP; database access, model calls and secrets stay in the
  backend apps.
- Public content is anonymous; all public outlets read from the one publication read layer
  (`packages/backend/src/publication/`).
- Reader page views never trigger model calls; paid requests always go through the receipt
  ledger (`packages/backend/src/providers/receipts.ts`) and budget circuit breakers — never
  bypass them.
- Match surrounding code style and comment density; prefer the simple solution; define only
  abstractions currently in use. Verify behaviour you touched; no tests for cosmetic changes.
- Never commit `.env`, secrets, or `.data/`.
- Screenshots in `docs/assets/` are regenerated from the current build on demo data (an
  `@example.com` user, invented headlines); they must never show a retired brand or a real user's data.
- How we work (independent judgement, simplest full design, proof by running it, outcome-first
  reports) is in `AGENTS.md` → How to work; it applies to people and coding agents alike.

## Commits and pull requests

- Use Conventional Commits style (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Keep PRs reviewable: one concern per PR, mention the docs you updated.
- PR checklist (also enforced by the PR template): typecheck passes, relevant tests run,
  migrations are append-only, no secrets committed, docs updated.
- No CLA. Please sign off external pull requests under the
  [Developer Certificate of Origin](https://developercertificate.org/) (`git commit -s`, which adds
  `Signed-off-by: Your Name <you@example.com>`): it states you have the right to submit the change
  under the project's MIT license. It is a request, not a CI gate, while the project has no outside
  contributors; why is in [docs/decisions/0002-dco-without-gate.md](docs/decisions/0002-dco-without-gate.md).

## Releases

- Versions follow [Semantic Versioning](https://semver.org/); the first public release is `0.1.0`,
  and while the major version is 0 a minor bump may break configuration or APIs (the changelog says
  how to upgrade).
- Every user-visible change adds a line under `## [Unreleased]` in `CHANGELOG.md`. A release moves
  those lines under `## [x.y.z] - YYYY-MM-DD`, tags `vx.y.z` on `main`, and publishes a GitHub
  release with the same notes.
- Database migrations only ever append, so any release upgrades in place from an earlier one.
- The step-by-step checklist (version fields, SBOM and its checksum, changelog cut, tag, GitHub
  release, and the settings that only work once the repository is public) is
  [docs/release.md](docs/release.md).

One repo-wide note: paths listed in `scripts/oss-export.exclude` are maintainer-only and are not
published. Please don't reference or expand on them in public docs or issues.
