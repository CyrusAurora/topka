# Adapt it to a different industry

By default this repository is an "AI industry" demo site: the demo sources are a set of public AI
news feeds, and the selection taste is calibrated for AI.
Turning it into a "legal news", "HR news" or "gold markets" site means changing almost only one
folder — [`industry/`](../industry/) — and hardly any code.

If you work with a coding agent (Claude Code, Codex, OpenCode, …), send it the prompt below and
answer its questions:

```text
Please read AGENTS.md and docs/customize.md, and adapt this site to the "XX industry".
What I care about: … (what to watch, what counts as important, what is noise — be specific).
Then run npm run typecheck, npm test and node scripts/smoke.ts, and tell me what is left for me
to decide.
```

These decisions should stay with a human, not the agent: the site name; which sources to watch;
what is important and what is noise; the category scheme; the legal/privacy pages (`industry/pages/`
is a template that must be reviewed before going live).

Here is the work, in order.

## 1. Name and copy: `industry/site.ts`

- `name`: site name. Used by navigation, titles, share images, the issue feed and the admin UI.
- `subject`: the industry word, used on the about page ("AI 日报" becomes "法律日报").
- `homeTitle`, `description`, `tagline`: homepage title, one-sentence intro, sidebar line.
- `crawlerName`: the user-agent when fetching sources; do not impersonate other sites.
- `ABOUT`: the about-page headline, the four-stage explanation, an optional founder block,
  copyright note.
- `icp`: mainland-China ICP filing number, if any, shows in the footer.

The site address is not set here: deploy-time environment variable `SITE_URL` sets it.

## 2. Categories and tags: `industry/taxonomy.ts`

- `CATEGORIES`: the category each article gets. `key` is stored with every article — do not
  change it once live; `label` is the name the admin shows; `guide` instructs the model how to
  categorize.
- `CATEGORY_TAGS`, `TOPIC_TAGS`, `ENTITY_TAGS`: the only choices the model may tag with. The
  first tag must be a category tag.
- `ENTITIES`: the main companies / organizations of the industry. `IDENTITY_LEXICON` and
  `PUBLISHER_DOMAINS` stop the model from naming a company in a summary that the original never
  mentioned; empty them if your industry does not need this.
- `ITEM_TYPES`: content types; they correspond to the weight table in the scoring prompt — change
  them together.

## 3. Sources: `industry/sources.json`

These demo sources are imported on first start; existing rows are never overwritten. Once live,
the "Sources" admin page is the daily tool: create, test-fetch, tune frequency, view failures.

Key fields of a source:

| Field | Meaning |
|---|---|
| `kind` | `rss`, `web_list` (HTML list with selectors), `json_list` (JSON API), `x_search` (X account, needs SocialData), `mp_account` (WeChat official account, needs a third-party API key), `external` (pushed from your own scripts) |
| `config` | per-kind config, see [Sources](sources.md) |
| `tier` | source tier: `T1` first-party official, `T1_5` official accounts & quasi-official, `T2` media and individuals, `EXCLUDE_MP` excluded from selection. Thresholds differ per tier |
| `participation_mode` | `editorial` joins selection; `hot_signal` only counts as discussion evidence for a story; `isolated` never reaches an issue |
| `first_party` | published by the party itself (official site/blog/account) |
| `site_fulltext` | whether full text may be shown on this site. **Default off**: summary + link only. Turn on only when the source clearly allows it |
| `regions` | geography (not industry scope): `text[]` default `["global"]`; ISO 3166-1 alpha-2 lowercase plus `global`. Pack seeds may set `"regions": ["cn", "global"]`; omit to keep the default. The wizard's region chips filter on this; the unfiltered list shows everything. |

### Source regions (geography, optional)

Every source carries `regions` (default `["global"]`). Tag with the publisher's home geography plus
`global` when the source is worldwide, e.g. a CN publisher `"regions": ["cn", "global"]`, a US lab
`"regions": ["us", "global"]`. The project wizard offers `global|cn|us|eu|jp` chips (default: no chip =
show all); under a filter, a `global` source is always visible and others show only on overlap. More
tokens may be added later without a schema change — any lowercase token is stored. Region never
blocks an explicit pick: it is a discovery filter only, and `in_scope` stays industry scope, not
geography.

## 4. Selection criteria: `industry/prompts/`

This is where your industry know-how goes — spend your time here.

| File | Role |
|---|---|
| `prefilter.md` | Prefilter: is this material about the industry at all. Wide recall, only blocks clearly irrelevant items |
| `selection-score.md` | **The scoring rubric**: 0–100 with content types, five dimensions, weights per type, values that must be scored fairly, and noise that must be suppressed |
| `content-understanding.md` | How selected items are written: headline, answer-first summary, why-it-matters, tags |
| `rules-domain.md` | Terminology translation/retention rules (the demo holds AI terms: LLM stays in English, …) |
| `summarize-*.md` | Short headline-summary style for the rest |
| `structure.md` | Structured extraction: category, tags, main company, facts |
| `group-*.md` | Event grouping: are two reports the same story |
| `project-score.md`, `issue-card.md` | Per-project relevance and the card copy of a reader's issue |

Prompts reference the site name as `{{siteName}}` and include other prompts as
`{{> filename}}`. Editing prompts needs no code change.

**This repo's prompts are written for Chinese-output sites**: they instruct the model to write
Chinese headlines and summaries, so their examples are in Chinese. If your site outputs another
language, keep the structure and re-write the exemplars in that language.

**Recommended approach**: keep the structure (five-weighted-dimension rubric, noise-suppression
rules, safety boundaries) and swap the examples of "what counts as important" and "what counts as
noise" for your industry. In law, "a new regulation officially published, a landmark ruling, an
enforcement action" must be scored fairly, while "a law-firm marketing piece, a course ad" must be
suppressed.

## 5. Thresholds and calibration: `industry/selection.ts`

Selection needs the sum of two scores ≥ 2 × threshold (a first score far from the threshold counts twice; see [Selection & calibration](selection.md)). The defaults (T1 60, T1_5 65, T2 76) are
calibrated for AI. For a new industry and new prompts, recalibrate:

1. Pick 100–200 items from your sources and label each "should be selected / should not", saved
   as `.data/gold.jsonl` (format in [Selection & calibration](selection.md); two examples in
   `industry/gold.example.jsonl`).
2. Run `node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl` to see accuracy,
   precision, recall, and results at different thresholds.
3. Read the misjudged items in the admin SelectBench, revise the rubric or thresholds, repeat.

This step decides how *accurately* your site selects.

## 6. Brand: `industry/brand/`

- `logo.svg`, `icon.png` (512), `icon-192.png`, `apple-icon.png` (180), `favicon.ico`.
- The about-page QR code: upload in admin → Settings, or drop images into `industry/brand/contact/`.
- The wordmark in the top-left corner of the site renders the site name text by default
  (`apps/web/app/components/Logo.tsx`); swap in an image if you have a logo.

## 7. Page copy: `industry/pages/`

- `pages/terms.md`, `pages/privacy.md`: terms of use and privacy statement. **They are
  templates** — rewrite them for your site before launch, with professional review if needed.
  They are off by default (`legalPages: false` in `industry/site.ts`): `/terms` and `/privacy` return
  404 and neither the footer nor the feedback page links them. Set it to `true` once the copy
  names your site's operator and contact.

## 8. Model and deployment

- Model: `.env`'s `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` — any OpenAI-compatible endpoint,
  used by every step by default. For per-step overrides, see `.env.example`.
- Deployment: see [Self-hosting](self-hosting.md).

## Check after changing

<!-- doc-test: skip placeholder connection string; the Check job runs the same three commands -->
```bash
npm run typecheck
DATABASE_URL=postgres://…/topka_test npm test   # database name must end in _test or _ci
docker compose exec web node scripts/smoke.ts --base http://localhost:3000  # once the Docker stack is running
```

Some tests in `tests/` use demo-industry categories, tags and companies (e.g. `ai-models`,
"model release", Anthropic). After editing `industry/taxonomy.ts`, those tests fail — replace the
exemplars with your industry's equivalents; the rules under test themselves need no change.

Finally, sign in and look at today's issue, the archive and the about page, and check
the admin "Sources" page for a fetch success rate worth the name.
