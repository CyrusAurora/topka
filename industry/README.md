# The industry pack

Everything in this project that depends on "the industry" lives here. Adapting the site to
another industry mainly means editing this folder; the steps are in
[Adapt it to a different industry](../docs/customize.md).

| File | Contents |
|---|---|
| `site.ts` | site name, industry word, homepage copy, about page, ICP filing number |
| `taxonomy.ts` | categories, tags, companies & organizations, lexicons that keep the model from writing wrong companies |
| `sources.json` | demo sources imported on first start |
| `prompts/` | the prompt for every step: prefilter, scoring, writing, structure, grouping, project scoring, issue cards |
| `selection.ts` | selection thresholds |
| `brand/` | icons and logo |
| `pages/` | terms of use, privacy statement (templates — rewrite before going live) |
| `gold.example.jsonl` | example format for selection-evaluation samples |

The prompts under `prompts/` are written for a Chinese-output site (they generate Chinese
headlines and summaries); see the note in `docs/customize.md` if your site outputs another
language.
