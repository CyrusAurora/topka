# Doc code blocks

The commands in the README, the tutorial and the other docs are run by CI, so a page cannot quietly
drift away from the code. `scripts/doc-blocks.ts` reads every Markdown file in the tree (except the
maintainer-only `private/` and `ops/`), and every shell or TypeScript fence must say what CI does with
it, in an HTML comment on the line just above the fence (GitHub does not render it):

| Marker | Meaning |
| --- | --- |
| `<!-- doc-test: run <suite> -->` | Run it, in that suite (below). Options after `;`: `retry <s>` (re-run until it passes, up to that many seconds: a reader waiting for a container), `expect <regex>` (the output must match), `exit <code>` (the exit code it must end with, default 0), `defer` (run after the page's other blocks: a teardown placed mid-page), `timeout <s>` (default 900). |
| `<!-- doc-test: skip <reason> -->` | Not runnable. The reason, at least three words, says why: placeholder values, lines for `.env`, a real domain, an outside call, a 4.7 GB model. |
| `<!-- doc-test: excerpt <path> -->` | A copy of code: every line (comments and spacing aside) must appear in that file. |
| `<!-- doc-test: typecheck -->` | TypeScript, compiled against the repository (as `examples/` is). |

A `json` fence must parse unless it is marked skip. Other fences (`text`, `mermaid`, `sql`, plain) are
prose and need no marker.

## The check (every push)

<!-- doc-test: run repo -->
```bash
node scripts/doc-blocks.ts --check       # markers, JSON, excerpts, referenced paths
node scripts/doc-blocks.ts --typecheck   # the typecheck blocks
node scripts/doc-blocks.ts --list        # every fence and what happens to it
```

`--check` fails on a shell or TypeScript block without a marker, a marker it cannot parse, JSON that
does not parse, an excerpt line missing from its file, and, in every shell block, run or skipped, a
reference to something the tree does not have: an `npm run` script missing from `package.json`, a
`scripts/…`, `apps/…`, `packages/…` (and similar) path that does not exist, a `docker compose`
service missing from `docker-compose.yml`. It runs in the check job, and again on the exported tree in
the publication gate (`scripts/oss-check.sh`).

## The suites

| Suite | Where it runs | What is in it |
| --- | --- | --- |
| `quickstart` | the `docker` job of `check.yml`, on the exported public tree, with Docker compose | README (both languages), tutorial (both), self-hosting, alerts, contributing |
| `repo` | the `check` job, on the checkout with its CI database, after every other step | the quality evals, the SBOM |
| `scratch` | the `check` job, in a fresh `git clone` per block, thrown away afterwards | the version bump, the pre-push hook |

<!-- doc-test: skip runs the suites themselves, which CI runs as their own steps -->
```bash
node scripts/doc-blocks.ts --run quickstart --root /path/to/export --port 3300
node scripts/doc-blocks.ts --run repo
node scripts/doc-blocks.ts --run scratch
```

Blocks run one by one, in page order, each in its own `bash -euo pipefail`; the first failure stops
the suite and is reported as `file:line`. In `quickstart`, a page a reader starts from a fresh clone
(the READMEs, the tutorials, self-hosting, contributing) starts from one: the stack and its volumes are
removed and the tree is reset to its committed state. `docs/alerts.md` continues on the site
self-hosting left running.

What a suite runs is the page's text with three rewrites, printed at the start of every run:

- `git clone https://github.com/CyrusAurora/topka.git && cd topka` becomes nothing: the tree under
  test is the checkout (cloning would test the last published commit instead);
- `scripts/init-env.ts` gets `--port 127.0.0.1:<port>` (`--port 3300` in CI), so every page is proven
  to work on a port other than 3000;
- the backup file name placeholder `YYYY-MM-DD` becomes today's date, as the backup block wrote it.

## Adding or changing a block

Put the marker right above the fence. Prefer `run`; when a block cannot run, say why in the skip
reason, and say where the same thing is covered if it is. A page meant to be followed from a fresh
clone in the quickstart suite goes in the `FRESH` list in `scripts/doc-blocks.ts`, and its run order in
`ORDER`. Locally, the quickstart suite needs Docker; the others need only Node.js (and, for `repo`, a
throwaway database in `DATABASE_URL`, name ending `_test` or `_ci`).
