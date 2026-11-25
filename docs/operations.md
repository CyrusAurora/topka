# Operations: staging, drills and recovery

A staging copy of the site, and drills for a bad release (rollback), a restore from backup (RTO/RPO)
and an alert reaching the owner. The latest numbers are at the end.
Alerts themselves are described in [alerts.md](alerts.md), backups in
[self-hosting.md](self-hosting.md#backup-and-restore).

## Staging

A second copy of the site on the same machine, built from production's newest backup:

| | production | staging |
| --- | --- | --- |
| database | `topka` | `topka_staging`, its own role, restored from the newest backup |
| people | real readers | anonymized before any process starts (below) |
| ports | 3000 / 3001 | their own (for example 3100 / 3101) |
| processes | the production process manager | a separate one (own pm2 home or compose project) |
| collection, model calls, pushes | on | off: `COLLECT_ENABLED`, `MODEL_CALLS_ENABLED`, `DISCOVERY_ENABLED`, `FEISHU_*_ENABLED` all `false` |
| alerts | the owner's webhook | a local mock (`scripts/mock-webhook.ts`); `TOPKA_ENVIRONMENT=staging` puts 【staging】 in front of every message |
| secrets | production's | fresh random ones; staging never holds a production secret |

The staging `.env` differs from production only in those lines:

<!-- doc-test: skip lines for a staging .env file -->
```bash
TOPKA_ENVIRONMENT=staging
DATABASE_URL=postgres://topka_staging:CHANGE_ME@127.0.0.1:5432/topka_staging
PORT=3100
API_PORT=3101
SESSION_SECRET=CHANGE_ME_RANDOM
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
DISCOVERY_ENABLED=false
ALERT_WEBHOOK_URL=http://127.0.0.1:3199/hook
```

Bringing it up is one ordered sequence; keep it in one script so nobody runs half of it:

<!-- doc-test: skip needs a production backup file -->
```bash
createdb -O topka_staging topka_staging
pg_restore --no-owner --no-privileges --no-comments --role=topka_staging --exit-on-error \
  -d topka_staging backups/newest.dump
node --env-file=staging.env scripts/migrate.ts
STAGING_PASSWORD=… node --env-file=staging.env scripts/anonymize.ts   # before anything serves
# then start api, worker and web with staging.env, and the mock webhook on 3199
```

### Anonymization

`scripts/anonymize.ts` (code: `packages/backend/src/operations/anonymize.ts`) refuses to touch a
database whose name does not say `staging`, `restore`, `drill`, `scratch`, `_ci` or `_test`, so it
cannot be pointed at production by mistake. It:

- renames every reader to `user-N@example.com` / `User N` and every admin to `admin-N@example.com`,
  with one shared staging password (`--password-env`, default `STAGING_PASSWORD`, at least 10
  characters) so testers can sign in as any of them;
- deletes sessions, verification codes, login throttles, app bind codes and every reader's own model
  keys; replaces feed tokens, invitation codes and app identities with random values;
- redacts feedback text and the assistant's conversation turns, empties delivery payloads, disables
  push targets, removes the alert webhook settings;
- rewrites e-mail addresses in the audit log and in every `…_by` / `actor` column;
- then searches again (`personalDataLeft`) and exits 1 if anything personal is left.

It prints counts only. Articles, sources, projects, issues and settings stay as they are: staging is
there to show the product with real content.

## Releases and rollback

Each deploy is a release: one directory per commit (dependencies installed, web built), and a
`current` pointer to the live one. A deploy builds the new release, switches the pointer, restarts,
and then waits for the health gate:

- `GET /api/health` answers `"ok":true` **for the new release** (`"release":"1.0.0+<sha>"`; a
  process left over from the previous release does not count), and
- the web answers on its port,

within a fixed time (60 s by default). If the gate fails, the deploy exits non-zero and the rollback
switches the pointer back to the previous release and restarts. With Docker the release is the image
tag: deploy `:<new>`, and on a failed gate `docker compose up -d` the previous tag. A rollback never
touches the database, which is why every migration must be a backward-compatible increment: the
previous release keeps working on the new schema ([CONTRIBUTING](../CONTRIBUTING.md#migrations-policy)).

**Drill**: build a release whose API throws at start-up, deploy it, let the gate catch it, roll back,
and record how long detection, rollback and the whole outage took, and that reader data did not
change (row counts before and after).

## Backup and restore

**Drill**: take a backup, restore it into a fresh database, prove the copy is the same, time it.

1. Dump inside one `REPEATABLE READ READ ONLY` transaction (`pg_export_snapshot()` handed to
   `pg_dump --snapshot`) and fingerprint the source **in the same transaction**, so both describe the
   same instant on a live database.
2. `createdb restore_drill_<time>` and `pg_restore` into it.
3. Fingerprint the restored copy and compare. `scripts/db-fingerprint.ts` gives each table's row count
   and a checksum (`md5` of every row in key order):

<!-- doc-test: skip needs two databases to compare -->
```bash
node --env-file=.env scripts/db-fingerprint.ts --out source.json
DATABASE_URL=postgres://…/restore_drill_x node scripts/db-fingerprint.ts --out restored.json
node scripts/db-fingerprint.ts --compare source.json restored.json   # exit 0 equal, 1 different
```

4. Run the migrations on the copy (nothing should be pending) and spot-check a few articles.
5. Drop the drill database.

- **RTO** (recovery time objective): from the start of the restore to verified data, plus the time
  to start the site on it.
- **RPO** (recovery point objective): how much writing can be lost, which is the time since the last
  backup that left the machine: at worst the backup interval, longer if the machine was down when a
  backup was due. Shorten it by running backups more often.

## Alert drill

The alert outlet is rehearsed against `scripts/mock-webhook.ts`, never the owner's real chat:

<!-- doc-test: skip starts a server that keeps running -->
```bash
node scripts/mock-webhook.ts --port 3199 --out alert-hook.jsonl --fail 1   # refuses the first message
```

Two faults, as in [alerts.md](alerts.md#drill): enabled sources marked as failing several times in a
row (`content.fetch`), and one paid service's daily cap lowered under the calls it already made
(`budget.day.<service>`; no call is made, nothing is paid). Run the alert check after each step: the
refused first message is sent again on the next run, an unchanged finding is not sent twice, and
putting the rows back gives one ✅ recovery message each. Every value changed is saved first and put
back at the end.

## Devices, languages, time zones

`scripts/check-devices.ts` opens the site on a 360 px Android phone, a 390 px iPhone, an 820 px
tablet and a 1440 px desktop, in English and Chinese, with the browser in Asia/Taipei,
America/Los_Angeles, Europe/Berlin and UTC. It fails on a page that does not load, scrolls sideways,
logs a console error (a server/browser time-zone mismatch shows up there as a hydration error), has
the wrong `lang`, shows Chinese chrome on an English page (Chinese content must carry
`lang="zh-CN"`), or uses another time zone than the reader's. Signed in, it sets the account's
language and zone for each run (and puts them back), and checks that a card opened on the phone shows
as read on the desktop. Screenshots of every page go to `--shots`.

<!-- doc-test: skip needs a running site and Chrome -->
```bash
node scripts/check-devices.ts --url https://cyrusaurora.github.io/topka/ --demo --shots shots/demo
node scripts/check-devices.ts --url http://127.0.0.1:3100/ --email user-1@example.com --password-env STAGING_PASSWORD --shots shots/staging
```

Point the signed-in run at staging or a test account: it changes the account's settings while it
runs. A real-device check (a phone in hand, its own fonts and keyboard) still belongs before a
release that changes layout.

## Cadence and records

Run all three drills every quarter, and again after changing the deploy procedure, the backup job or
the alert outlet. Keep each record (date, what was done, the numbers, what was put back) next to the
operator's notes, and update the table below.

## Latest drill (2026-11-17, staging on the production machine)

| drill | result |
| --- | --- |
| rollback | bad release detected by the health gate after 28.5 s (including building it); rolled back and healthy 3.6 s later; outage 32.2 s; reader data unchanged |
| restore | 97 tables, 67,764 rows, 38 MB dump: backup 5.7 s, restore 3.8 s, verification 1.3 s, every table equal; **RTO 5.4 s** to verified data (about 12 s more to serve it); **RPO** at most the 3-hour backup interval (newest backup was 70 min old) |
| alert | collection failure and budget trip each alerted on the first check; the refused message went through on the retry; no duplicate; one recovery message each |
| devices | demo, production visitor pages and a signed-in staging reader: 4 screens × 2 languages × 4 time zones, no problem left (two layout fixes and missing `lang` marks were found and fixed on the way) |
