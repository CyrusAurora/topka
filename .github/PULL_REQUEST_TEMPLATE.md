# Suggested checklist — keep it honest and brief.
# Conventional Commits titles are preferred; one concern per PR.

## Checks

- [ ] `npm run typecheck` passes
- [ ] Relevant tests run against an empty `…_test`/`…_ci` database (`DATABASE_URL=… npm test`)
- [ ] Web changes: `npm run build -w @topka/web && node --test apps/web/tests/*.test.ts`
- [ ] Whole-site changes verified with the stack running (`node scripts/smoke.ts --base …`)

## Invariants

- [ ] No new database migration, or migrations are append-only (no edits to shipped files;
      new numbered file at the end of `database/migrations/`)
- [ ] No secrets: no `.env` contents, no tokens, no `.data/` files committed
- [ ] New/changed paid requests go through the receipt ledger and budget circuit breakers
- [ ] Public outlets read only via the publication read layer; reader page views trigger no model calls
- [ ] `docs/` updated when behaviour or configuration changed
