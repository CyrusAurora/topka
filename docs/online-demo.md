# Online demo

<https://cyrusaurora.github.io/topka/> runs Topka's reader pages as a static site. Nothing to install
and no account.

- **Today and Archive** are the real daily issues of a running Topka: titles, summaries, sources and
  links to the originals. The bar at the top shows when the data was last updated.
- **Chat** runs the demo model in your browser: answer a few questions and it creates a project.
  Projects and settings stay in your browser.
- **Accounts, model keys, reminders and feedback** need a server: [self-host](self-hosting.md).

## What is published

The exporter (`scripts/pages-export.ts`) copies a whitelist of fields from one reader's issues: date,
number, card titles and summaries, tag, source name, the original link (http/https only), and any
correction or withdrawal. Project names go out under stand-in ids.

Never published: email, account and project ids, article ids, scores, read marks, keys, full text.
Before writing anything, a leak scan refuses the export if it finds an email address, a UUID, a key or
token, a private address, a local path, the reader's ids or a term from `--deny FILE`. The Pages
workflow runs the same scan (`scripts/pages-check.ts`) before deploying.

## How it updates

- `.github/workflows/pages.yml` builds `apps/web/demo` with
  `scripts/build-demo.ts --base /<repo>/ --data <pages-data>` and deploys it on every push to `main`.
- The data lives on the `pages-data` branch, one commit that each publish replaces.
- `scripts/pages-publish.sh` runs on the machine of the instance after its daily issue: it exports,
  and when the issues changed (or the published copy is older than `PAGES_REFRESH_HOURS`, 20 by
  default) it replaces the `pages-data` commit and starts the workflow. It prints counts only.

<!-- doc-test: skip needs push access to a Pages repository and a site with the demo reader; the Check job runs the same export and check -->
```bash
PAGES_REPO=you/topka PAGES_DEMO_READER=reader@example.com bash scripts/pages-publish.sh --dry-run
```

It costs nothing: GitHub Pages and Actions are free on a public repository, and the export calls no model.

## Publish your own

Fork the repository, enable Pages with "GitHub Actions" as the
source, and run `scripts/pages-publish.sh` with `PAGES_REPO` set to the fork and `PAGES_DEMO_READER` to
the reader whose issues you are willing to publish. Check the result with
`node scripts/check-demo.ts --url https://you.github.io/topka/`, which clicks through it in Chrome in both
languages.

Locally: `node scripts/build-demo.ts --base /topka/ --data DIR` and
`node scripts/check-demo.ts --serve apps/web/build-demo --base /topka/`.
