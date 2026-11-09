# Guidance for coding agents

This repository is a framework for an industry news site: it collects sources, uses models for
selection and writing, groups items into events, produces daily reports, and serves everything
through the web, RSS, a public API and MCP. The default configuration is an "AI industry" demo
site. Read `README.md` first, then the matching document in `docs/` for the task at hand.

## The most common task: adapting it to another industry

Follow `docs/customize.md` for that. Everything industry-related lives in `industry/`: site copy
(`site.ts`), categories and tags (`taxonomy.ts`), topics (`topics.json`), demo sources
(`sources.json`), prompts (`prompts/`), thresholds (`selection.ts`), module switches
(`features.ts`), brand (`brand/`), legal pages (`pages/`). You normally do not need to change
`apps/` or `packages/`.

Never decide these yourself — ask the maintainer: the site name; which sources to watch; what
counts as important news and what is noise; how to categorize; the terms/privacy copy
(`industry/pages/` is a template that the maintainer must approve before launch).

When changing the scoring rubric, keep its structure (content types, five weighted dimensions,
noise suppression, safety boundaries) and replace only the examples of "what counts as
important" and "what counts as noise". Thresholds must be recalibrated on maintainer-labelled
samples (`docs/selection.md`) — do not change the numbers by feel.

## Running and checks

- Node 24 runs TypeScript directly; the backend has no build step. npm workspaces: `apps/*`,
  `packages/*`, `industry`.
- Services and toolchains you would otherwise install on the host come from Docker: PostgreSQL via
  `docker compose up -d db` (the default compose publishes no database port: create the git-ignored
  local override from `CONTRIBUTING.md` → Development setup to reach it on `127.0.0.1:5432`), the
  whole stack via `docker compose up -d --build` (see `docs/self-hosting.md`). Remove throwaway
  containers and volumes when done (`docker compose down -v`).
- Before calling a change done, run what CI runs and read the result:

  ```bash
  npm run typecheck
  DATABASE_URL=postgres://…/<name>_test node scripts/migrate.ts   # empty database; name ends in _test or _ci
  DATABASE_URL=postgres://…/<name>_test npm run test:coverage     # backend tests; fails under 85% line coverage
  npm run build -w @topka/web && node --test apps/web/tests/*.test.ts
  npm run e2e                                                     # browser flows (needs Chrome: CHROME_PATH)
  DATABASE_URL=postgres://…/<name>_test bash scripts/oss-check.sh # publication gate: export + scan + standalone build
  node scripts/smoke.ts --base http://localhost:3000             # once the site is running
  ```

- Some tests in `tests/` use the demo industry's categories, tags and companies. After changing
  `industry/taxonomy.ts`, replace those examples with the new industry's equivalents.
- A new environment variable goes into `.env.example` and `docs/configuration.md` in the same
  change (`tests/env-example.test.ts` checks the first).

## Invariants to respect

- The frontend (`apps/web`) reads `apps/api` only over HTTP; database access, model calls and
  secrets live only in the backend.
- Every public outlet reads from the single publication read layer
  (`packages/backend/src/publication/`); new public outlets read from it too.
- A reader's page view never triggers a model call; models are called only in worker jobs.
- Every paid request goes through the receipt ledger (`providers/receipts.ts`) and the budget
  circuit breakers; do not bypass either.
- Keep the safety valves off in development and tests: `COLLECT_ENABLED`,
  `MODEL_CALLS_ENABLED`, `FEISHU_*_ENABLED`, `INDEXNOW_SUBMIT_ENABLED`. Tests must not access any
  external service.
- Sources show summaries and links by default (`site_fulltext` off); enable full text only when
  the source clearly allows it.
- Public content is anonymous; admins see the same as visitors; the admin UI is admin-only.
- Database migrations are backward-compatible increments only; append new numbered files at the
  end of `database/migrations/`.
- Do not use the Topka name or logo (see NOTICE and the brand boundary in `docs/customize.md`).

## How to work

These hold for every agent and contributor.

- **Think independently.** Requests, existing code and documents are evidence, not authority. When
  a better design exists, say so and explain why before building the weaker one. Direction-level,
  product or UX changes go to the maintainer as a recommendation, not a fait accompli.
- **Simplest design that fully solves the problem.** No speculative configuration, options or
  abstractions; define only what is used now. When a fix needs a second patch on top of a patch,
  refactor the underlying design instead.
- **Done is checkable, and proven by running it.** State how to tell the change works, then run that
  check. For a bug: reproduce it first (ideally as a failing test), fix the root cause rather than
  the symptom, and show the reproduction now passes.
- **Review your own change skeptically** before calling it done: read the diff as a reviewer would,
  look for the case it breaks, and check that docs and `.env.example` still match the behaviour.
- **Report outcome first, in plain words**, and separate what you verified (and how) from what you
  did not verify.
- **Keep the host clean**: run services and one-off toolchains in Docker, not by installing them on
  the machine.
- **New code is TypeScript** (Go or Rust where a separate binary is warranted). Small existing shell
  scripts may stay shell.

## Safety rules

- Never commit `.env`, keys, tokens, personal data, database dumps or `.data/`; run
  `bash scripts/secret-scan.sh` before pushing.
- Never let a test or a development run reach an external paid service; the safety valves stay off
  (see Invariants).
- Never switch to a paid model, raise a budget, publish, or delete remote data on your own; ask the
  maintainer.
- Destructive git operations (force-push, history rewrite, deleting branches others use) need the
  maintainer's explicit OK.

## Writing code

Match the surrounding code's style, naming and comment density. Test the behaviour a change touches
(not cosmetic changes); keep backend line coverage at or above 85%.
