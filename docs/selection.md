# Selection and calibration

## How a raw item becomes a featured pick

1. **Ingest**: one copy per URL/content. An item with only a title or feed summary gets its page
   fetched before judging.
2. **Prefilter** (`prefilter.md`): is this the industry at all. Wide recall, only blocks clearly
   irrelevant items: `BLOCK` never appears on any public page; `PASS` and undecided `UNKNOWN`
   continue.
3. **Scoring** (`selection-score.md`): the same rubric scores independently twice (0–100 each).
   **Sum of the two ≥ 2 × threshold** selects the item; thresholds differ per source tier. The
   score displayed is the floor of the average.
4. **Write title + summary**: selected items, and near-misses (average above `understandFloor`),
   are written per `content-understanding.md` (headline, answer-first summary, why-it-matters,
   tags); the rest get a short headline-summary per `summarize-*.md` and appear in "all items".
5. **Structure** (`structure.md`): category, tags, main company, facts (who did what to what).
   Runs together with scoring; topic pages and event grouping rely on it.
6. **Grouping** (`group-*.md`): the same story reported by different outlets merges into one
   event with a digest (`story-digest.md`); "hot" ranks events. Selected items wait for grouping
   to finish (up to 3 minutes) so the same story does not surface twice in short order.
7. **Reports** (`report-*.md`): the daily report composes at 08:00 (covering 08:00 the previous
   day to 08:00 today), the weekly on Mondays 10:00, the monthly on the 1st 10:30. An item whose
   publication timing crosses a report cut-off after ingestion joins the next issue's candidate
   pool; if its publication transaction is still in flight at the cut-off, the report waits for it
   to commit before reading, so nothing slips between two issues. Final placement still obeys the
   same fact dedupe and layout limits.

Every step's prompts are in `industry/prompts/`; editing prompts needs no code change. A prompt's
version is the hash of its content: prompts changed later apply to new items only, already-judged
items are never recomputed.

## Thresholds: `industry/selection.ts`

```ts
export const SELECTION = {
  thresholds: { T1: 60, T1_5: 65, T2: 76 },   // average of the two scores must at least reach this
  understandFloor: 50,                        // unselected items above this are written like selected ones
  firstScoreFloor: 50,                        // first score below this: stop (one call, no listing)
  projectFirstScoreFloor: 40,                 // same, for sources followed by an active project
  secondScoreBand: 15,                        // second score only when the first is this close to the threshold
};
```

To save model calls the first score runs before anything else. An item whose first score is
below the floor stops there (kept as `skipped`, detail page only). A second score is asked only
when the first lands within `secondScoreBand` of the threshold, or for project sources (whose
project score is the mean of two); otherwise the single score counts twice. Replaying three days
of recorded scores, this kept every selected item and every project score ≥ 50.

First-party sources (T1) have a lower bar; media and individuals (T2) a higher one: for the same
story, the official original is the better first read. Tiers without a threshold
(`EXCLUDE_MP`) are excluded from selection.

These numbers are what Topka used in the AI domain — deliberately strict: rather fewer picks than
noise in the featured stream. When you change industry or rubric, recalibrate with the procedure
below.

## Calibration

### 1. Prepare a sample set

Pick 100–200 items from your sources and label each "select / reject", saved as
`.data/gold.jsonl` (`.data/` is not committed to git). One item per line:

```json
{"caseId":"law-001","material":{"title":"original title","originalTitle":null,"publishedAt":"2026-10-01T09:00:00+08:00","sourceName":"source name","bodyZh":null,"bodyOriginal":"body text…"},"sourceFacts":{"sourceKind":"rss","sourceTier":"T1","firstParty":true,"language":"zh"},"samplingContext":{"benchmarkSplit":"development","samplingStratum":"regulation"},"gold":{"decision":"select"}}
```

| Field | Meaning |
|---|---|
| `caseId` | unique id |
| `material` | title, original title, publish time, source name, body (Chinese body in `bodyZh`, original in `bodyOriginal`; one is enough) |
| `sourceFacts` | source kind, tier, first-party, language. The tier decides which threshold applies |
| `samplingContext` | optional. `benchmarkSplit` development vs holdout; `samplingStratum` your own grouping (e.g. "regulation", "rulings", "marketing") to see where errors cluster |
| `gold.decision` | `select`, `reject`, or `either` (excluded from accuracy) |

Two examples live in `industry/gold.example.jsonl`.

Tips:

- Favour **hard cases**: items that nearly should be selected and items that nearly should be
  rejected. Too many obvious ones inflate accuracy.
- Reserve part as a **holdout set** (`benchmarkSplit: "holdout"`): tune the rubric on the
  development set only, and run the holdout at the end so you don't fit the rubric to the sample.
- Whoever labels should be the intended reader of the site, or match their taste.

### 2. Run the evaluation

```bash
node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl --split development --label "rubric v1"
```

Runs prefilter and both scorings per item and outputs:

- accuracy, precision (how many selected are right), recall (how many should-select got selected);
- results for every threshold from 40 to 90 in steps of 2;
- misjudged items, full reports written to `.data/eval/`, imported into the admin SelectBench.

Useful flags: `--models default,deepseek-flash` to compare models on the same batch, `--n 200`
to cap sample count, `--split holdout` for the holdout only. Re-running with unchanged inputs
and prompts reuses receipts instead of calling models again — only the changed parts cost calls.

### 3. Read errors, revise the rubric, repeat

In the admin SelectBench, inspect each misjudged item and the model's reasoning:

- Should-select but rejected → the rubric doesn't say why such a thing matters: add this class of
  value under "must be scored fairly" in `selection-score.md`, with examples.
- Should-reject but selected → the noise isn't suppressed: add it under "must be suppressed".
- Systematically too loose or too strict with scores hugging the threshold → adjust the
  thresholds in `industry/selection.ts`.

Change the rubric first, thresholds second: thresholds only shift the line globally and cannot
fix a misjudged class. Re-run after each change; SelectBench shows the versions side by side.

## Changing the scoring model

The admin "Models & evaluation" page shows which model each step currently uses, recent success
rate, latency and token usage, and allows switching (affects future tasks only). Before changing
the scoring model, compare candidates on the same sample batch with `--models`.
