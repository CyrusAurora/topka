# Model leaderboard and Codex reset monitor

These two modules only make sense for an AI-industry site. Any other industry switches them off
in `industry/features.ts` (see [Adapt it to a different industry](customize.md#6-the-two-ai-only-modules-industryfeaturests)).

## Model leaderboard (`/leaderboard`)

Combines scores from public evaluations (Artificial Analysis, LMArena, LiveBench, Epoch,
EQ-Bench, Vals, …) into one consistent ranking that avoids conflicting with the known standings,
plus category boards (coding, reasoning, knowledge, …). The method is public to readers:

- `/leaderboard/rules`: how the ranking is computed (consensus method v15, weighted incomplete
  Kemeny ordering).
- `/leaderboard/sources`: what each evaluation source measures, its status, and whether it
  participates.

**Updates**: all upstreams are checked four times a day (02:05, 08:05, 14:05, 20:05, Asia/Shanghai).
A failed source keeps its previous snapshot; a new round is published only when the evidence
actually changed. A freshly installed site computes its first round as soon as the worker starts.

**Required keys**:

- `ARTIFICIAL_ANALYSIS_API_KEY`: only the Artificial Analysis feed needs its own key. Without it
  that source sits out, its share is not redistributed, and the ranking differs from Topka's.
- `GITHUB_TOKEN` (optional): read-only token to raise GitHub API quotas.

**Model roster**: display names, vendors, release dates, and every evaluator's aliases for the
same model are in the roster under `database/seeds/`, imported on first start
(`scripts/seed.ts`) so scores land on the same models as Topka's board. New models absent from
the roster are created automatically with the evaluator's name — naming/vendoring may be rough.

**Prices**: official API prices in the table come from the price files under `database/seeds/`;
each refresh backfills models that are missing a price. When vendors change prices or release
models, edit the file and run:

```bash
node --env-file=.env scripts/import-leaderboard-prices.ts
```

**Code**:

| Location | Contents |
|---|---|
| `packages/backend/src/leaderboard/source-registry.json` | evaluation-source registry: groups, status, share, notes |
| `packages/backend/src/leaderboard/fetch/sources/` | one reader per upstream |
| `packages/backend/src/leaderboard/method/` | the v15 computation (`v15.ts`, `kemeny.ts`) |
| `apps/web/app/features/leaderboard/`, `apps/web/app/routes/leaderboard*.tsx` | pages |

**Tools**:

```bash
node --env-file=.env scripts/lb-round.ts --fetch      # fetch and compute a round now
node --env-file=.env scripts/lb-fetch-check.ts        # fetch without writing, diff line-by-line vs stored snapshots
```

**Changing the method**: every constant in `v15.ts` is part of the method — changes alter what
readers see. When changing it, update the copy on the `/leaderboard/rules` page and bump the
method version: the page must match the actual algorithm.

## Codex reset monitor (`/codex-reset`)

Watches Codex usage-reset announcements from Tibo of OpenAI's Codex team (X account
@thsottiaux): previews, progress, completion confirmations, retractions — with estimated
effective times and links to the original posts. Machine-readable endpoint:
`/api/v1/codex-resets`.

- Needs `SOCIALDATA_API_KEY` to read X. Without it the monitor does not run and the page shows
  "no reset records" — recommended to switch the module off in that case.
- Normally checked every 5 minutes, every 3 minutes while a preview or incident is active; a
  48-hour lookback repairs gaps daily at 04:40.
- Posts are interpreted by a model (`MONITOR_MODEL`, default: the default model), but state
  transitions are decided in code: a model's wording can never confirm anything on its own.
- Uncertain interpretations park on the admin "Codex reset" page for a human to confirm, amend,
  or file as unrelated.
- With Feishu content-push configured, previews and confirmations are also pushed to the group.
