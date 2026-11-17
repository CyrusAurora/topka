# Online demo

<https://cyrusaurora.github.io/topka/> is Topka's reader pages as a static site on GitHub Pages: no
server, no account, nothing to install. It is a demo, and it says so on every page.

## What is real and what is the demo

| Part | Where it comes from |
|---|---|
| Today, Past issues, each issue | **Real.** The daily issues one running Topka instance fixed: titles, the cards' copy and summaries (AI-written, from that instance's model), source names and links to the originals. Nothing else of the articles. |
| "Data updated …", "Latest issue …" | **Real.** When the data was last exported and the date of the newest issue. When the machine that feeds the demo is off, the data simply stops updating; after two days the bar says how many days old it is and that it is not today's issue. The masthead always shows the issue's own date. |
| Chat, creating a project, deleting one | **Demo model**, in your browser: the same fixed rules as a self-hosted instance with `DEMO_SEED=true` (a couple of questions, a summary to confirm, a tracking card). Projects you create live only in your browser (`localStorage`). |
| A project you created | Its page says honestly that nothing is collected or analysed here. |
| Settings: language and time zone | Kept in your browser. |
| Accounts, sign-in, model keys, reminders, feedback, the admin | **Not in the demo.** They need a server; the page says so and links [self-hosting](self-hosting.md). |

The card copy is in the language the instance writes in (Chinese). On the English page it is marked
`lang="zh-CN"`; the page's own text is English.

## What is published, and what never is

The exporter (`scripts/pages-export.ts`) reads one reader's fixed issues, read-only, and copies each field
by name (a whitelist):

- per issue: date, number, the three cards' titles, one-line summaries, summary, tag, source name, the
  original link (http/https only), dates, and the observation-ledger state (a correction or withdrawal);
- per project: its name only, under a stand-in id (`demo-1`).

Never: the reader's email, account or project ids and slugs, article ids, scores, read marks, keys,
full article text. Before anything is written, a leak scan refuses the export if the files carry an
email address, a UUID, an API key or token, a private key, a local or private address, a path of the
machine, any of the reader's own ids, or a term from the operator's deny list (`--deny FILE`). The Pages
workflow runs the same scan again (`scripts/pages-check.ts`) before deploying.

## How it is built and updated

- `.github/workflows/pages.yml` (public repository only) builds `apps/web/demo` with
  `scripts/build-demo.ts --base /<repo>/ --data <pages-data>` and deploys it with GitHub's own Pages
  actions, on every push to `main` and on request.
- The data lives on the `pages-data` branch, one commit that each publish replaces.
- `scripts/pages-publish.sh` runs on the machine of the instance after its daily issue: it exports,
  and when the issues changed (or the published copy is older than `PAGES_REFRESH_HOURS`, 20 by
  default) it replaces the `pages-data` commit and starts the workflow. It prints counts only.

<!-- doc-test: skip needs push access to a Pages repository and a site with the demo reader; the Check job runs the same export and check -->
```bash
PAGES_REPO=you/topka PAGES_DEMO_READER=reader@example.com bash scripts/pages-publish.sh --dry-run
```

It costs nothing: GitHub Pages and Actions on a public repository, and no model call (the export reads
issues already written).

## Your own

To run a demo of your own instance, fork the repository, enable Pages with "GitHub Actions" as the
source, and run `scripts/pages-publish.sh` with `PAGES_REPO` set to the fork and `PAGES_DEMO_READER` to
the reader whose issues you are willing to publish. Check the result with
`node scripts/check-demo.ts --url https://you.github.io/topka/`, which clicks through it in Chrome in both
languages.

Locally: `node scripts/build-demo.ts --base /topka/ --data DIR` and
`node scripts/check-demo.ts --serve apps/web/build-demo --base /topka/`.
