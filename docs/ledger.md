# The observation ledger and the brief checkpoint

An observation is what one source exposed at one moment, captured with its provenance. It is never
edited or deleted in place: a later version is a new revision, a refused report is a record of its
own, and a source taking material down is a withdrawal record. The model's text (titles, summaries,
reasons) lives in `analyses`, never in the ledger. Migration `0063` (after `0059`, which made
`articles` and `article_revisions` immutable) adds the rest.

## Writing: four states

Every entrance (collectors, WeChat import, `POST /api/ingest/items`) goes through
`recordMaterial` in `packages/backend/src/content/materials.ts`, which answers one of:

| state | meaning | stored |
| --- | --- | --- |
| `created` | a new observation (`changed: false`) or a new version of one already held (`changed: true`, a new row in `article_revisions` with the source's version time in `version_marker`) | `articles` / `article_revisions` |
| `existing` | the same content again; nothing changes | nothing |
| `conflict` (`identity-conflict`) | same identity, different content, but the source's own version time is strictly older than the stored one: a replay of an old version, not a correction | the reported text in `observation_rejections`, next to the stored observation |
| `failed` (`missing-provenance`, `preservation-failed`) | no source, an unknown source or no http(s) URL; or what was written did not read back the same | the refused report in `observation_rejections`; the transaction rolls back |

A repeated refusal (a feed repeats an old item every fetch) is stored once. Each collection run
records its counts in `fetch_runs.detail.ledger` (`created`, `changed`, `existing`, `conflict`,
`failed`); the ingest endpoint returns them as `ledger`.

Equal version times with new content count as a correction, not a conflict: most feeds set
`updated` equal to `published` and still fix their text.

## Withdrawals

`article_withdrawals` holds `withdraw` and `reinstate` records with a basis (`source-retracted`,
`source-removed`, `editorial`), a required reason, an optional http(s) evidence link and who recorded
it. Each record must change the state; the latest one is the state (`article_withdrawal_state`). The
database refuses UPDATE and DELETE (only deleting the article itself removes them).

A withdrawn observation leaves the candidate pool: it enters no new daily issue, no project brief and
no "today" list, and its publication is no longer eligible for selection. Issues already fixed and
the detail page keep it, marked as retracted. Record one from the admin content page, or from a
push (`"withdrawn": true` on an item, below).

Presentation: `current`, `corrected` (an earlier revision had a different title, or a non-empty body
that differs; filling in a body that was missing is not a correction) or `retracted-material`.
Readers following the item can open its earlier versions: `GET /api/me/items/:articleId/history`
returns revision titles and refused conflicting reports (titles and excerpts only).

## The brief checkpoint

`GET /api/projects/:projectId/today` stores what it shows as an immutable snapshot
(`project_brief_snapshots`, id `brief-snapshot-v1:<32 hex>`) with one top result, highest first:

| result | when | confirmable |
| --- | --- | --- |
| `offline-or-auth` | the page itself is offline or signed out (client side only) | no |
| `snapshot-failed` | the snapshot could not be stored | no |
| `partial-coverage` | a source marked required has not been checked recently | no |
| `abstained-impact` | collected material in the window is not assessed yet ("unknown is not no") | no |
| `updates-available` | there are cards | yes |
| `no-important-change` | nothing qualifies | yes |

The table and the rules below are `packages/contracts/src/brief.ts`; the database binds
`acknowledgement_allowed` to the result, so a blocking snapshot cannot be confirmed by any path.

`POST /api/projects/:projectId/today/ack` with `{snapshotId, ackSeq, shownIds, commandId}`. Checked
in this order:

1. the snapshot belongs to another project or revision → `project_mismatch` / `revision_mismatch` (409)
2. this snapshot is already the confirmed one → the same receipt again (idempotent)
3. `ackSeq` is not the checkpoint's → `ack_seq_mismatch` (409; confirmed elsewhere)
4. the result is not confirmable → `result_not_acknowledgeable` (409)
5. not every card was shown → `titles_not_shown` (409)
6. the checkpoint is not behind the snapshot → `checkpoint_not_behind` (409)
7. no `commandId` → `command_required` (409)

Plus `snapshot_required` (400) and `unknown_snapshot` (404). A retry with the same `commandId`
returns the same receipt (`receipt-` + 8 hex). An accepted confirmation moves `ack_seq` by one and
`read_through` to the snapshot's end, in one transaction with its log row
(`project_checkpoint_acks`); a database trigger refuses any other move. Reading, opening, marking,
switching language, exporting or going offline never move it.

Mark a project source as required (or not) with
`PUT /api/projects/:projectId/sources/:sourceId {"required": true}` (owner only). No source is
required by default.

Retention: snapshots nobody confirmed and no checkpoint points at are deleted after 30 days, refused
reports with no article after 180 days (`ops.retention`).
