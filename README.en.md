<div align="center">

[简体中文](README.md) · **English**

# Topka

<img src="docs/assets/screenshot-today.png" alt="Topka Today page: No. 003, three 【示例】 cards" width="100%">

> *"Only what changed. If nothing clears the bar, that day's issue is shorter, or empty — never padded."*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-blue)](CHANGELOG.md)
[![Self-hosted](https://img.shields.io/badge/self--hosted-Docker%20Compose-2496ED?logo=docker&logoColor=white)](#quick-start-no-api-key)
[![BYOK](https://img.shields.io/badge/BYOK-bring%20your%20own%20key-6f42c1)](#real-sources-and-a-model)

**A self-hosted intelligence brief: say what to watch, and each day it picks a few items from your sources that are worth reading, each linking back to the original.**

**[Try it online →](https://cyrusaurora.github.io/topka/)** Nothing to install: the real daily picks and past issues of a running Topka; Chat and project creation are answered by the demo model in your browser. ([How it works](docs/online-demo.md))

<!-- doc-test: run quickstart; timeout 1800 -->
```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:26-trixie-slim node scripts/init-env.ts --demo
docker compose up -d --build
```

<sub>Three commands to install, then `docker compose logs setup | grep demo:` for the demo password; after login you get the screenshot above. Invented demo data and a built-in demo model: no API key, no crawling, no cost.</sub>

[Try it online](https://cyrusaurora.github.io/topka/) · [See it](#see-it) · [Quick start](#quick-start-no-api-key) · [Real sources and a model](#real-sources-and-a-model) · [How it works](#how-it-works) · [Honest limits](#honest-limits) · [Troubleshooting](#troubleshooting)

</div>

---

## See it

Open a card: AI summary, source, copy-link.

<img src="docs/assets/screenshot-demo-today.png" alt="Card expanded: summary, source, copy link" width="100%">

Past issues stay under Archive:

<img src="docs/assets/screenshot-archive.png" alt="Archive: No.002 and No.001" width="100%">

<sub>Screenshots from the current build with the shipped demo data (titles start with 【示例】). Follow the [tutorial](docs/tutorial.en.md) and you get the same three images, with your run date.</sub>

---

## Quick start (no API key)

**Need:** Docker Compose v2 (`docker compose version` prints a version), `git`, ~3 GB disk. 2 cores / 4 GB is enough. No Node, PostgreSQL, API key, or GPU. It uses port 3000 on this machine only by default; for other machines see [HTTPS](docs/self-hosting.md#https-caddy-profile).

**The port is set in one place:** `PORT` in `.env`. If 3000 is taken, add `--port 127.0.0.1:3300` to the `init-env.ts` command in step 1 (already have a `.env`? edit its `PORT=` line). Every later `docker compose up` uses it, and the site's links, RSS and feed addresses follow it; nothing else to change.

**1. Clone and generate `.env`**

<!-- doc-test: skip the quick start block above runs these same commands -->
```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:26-trixie-slim node scripts/init-env.ts --demo
```

It prints the site address and the admin password. `--demo` writes `DEMO_SEED=true` to `.env`: startup loads the demo content, and until a model is connected the built-in demo model answers in Chat. The `LLM_API_KEY is empty` line can wait. Running it again never overwrites an existing `.env` (passwords and secrets stay). Add `--locale en` for an English site with English demo stories (the screenshots show the default Chinese demo).

**2. Start**

<!-- doc-test: skip the quick start block above runs these same commands -->
```bash
docker compose up -d --build
```

The first build takes from half a minute to a quarter of an hour, depending on the network. It brings up the database, runs migrations, imports the sources and the four project packs (all switched off), and seeds a demo reader, the project “人形机器人量产（示例）”, and three days of invented cards.

Check it is up (this asks this stack's own port, so it stays right after a `PORT` change; give it a few seconds after start):

<!-- doc-test: run quickstart; retry 180; expect "ok":true -->
```bash
curl -s "http://$(docker compose port web 3000)/api/health"   # {"app":"topka",…,"ok":true,"db":"ok",…}
```

**3. Get the demo password and sign in**

<!-- doc-test: run quickstart; retry 180; expect demo: ready -->
```bash
docker compose logs setup | grep demo:
```

```text
setup-1  | demo: ready. Log in at /login as demo@example.com
setup-1  | demo: password demo-1be4ef872d6d  (shown once; to reset it: add DEMO_PASSWORD=<10+ characters> to .env, run `docker compose up -d`, then `docker compose exec api npm run demo:seed`)
```

The password is shown once. Open <http://localhost:3000/login> (or the address init-env printed) as `demo@example.com`.

**You are done when**

- Today shows **No. 003** with three 【示例】 cards, matching the hero screenshot
- Expanding a card shows a summary; Archive has the two earlier days
- Chat answers, with a "Demo model" banner: a few canned questions, a tracking card, and Confirm creates the project
- Settings → New project offers all four packs
- Admin is at `/admin` with `ADMIN_PASSWORD` from `.env`

Stuck? [Troubleshooting](#troubleshooting). Real articles without a model: [tutorial part 2](docs/tutorial.en.md#part-2-real-articles-still-no-model-key).

<!-- doc-test: run quickstart; defer -->
```bash
docker compose down -v   # wipe including the database
```

---

## Real sources and a model

Demo data does not refresh. A new daily issue needs **sources on** and **a model**. Both are off by default.

**Sources.** A few hundred ship with the repo (the exact number is the one before `in the database` in the setup log; the admin total also counts the 3 demo sources with `--demo`), all in the database but switched off (most come from migrations, so the log's "added" count is far below the total). Enable them in `/admin/sources`, or:

<!-- doc-test: run quickstart; expect 2 -->
```bash
docker compose exec api npm run sources:only -- --id rss-hugging-face --id rss-github-ai
```

**Model.** Any OpenAI-compatible endpoint. In `.env`:

<!-- doc-test: skip lines for .env with placeholder values, not commands -->
```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-flash
```

Two ways at no cost (exact lines in [Without a paid key](docs/self-hosting.md#without-a-paid-key)):

- **Local Ollama**, no account: in `.env` `COMPOSE_PROFILES=ollama`, `LLM_BASE_URL=http://ollama:11434/v1`, `LLM_API_KEY=ollama`, `LLM_MODEL=qwen2.5:7b`, then `docker compose exec ollama ollama pull qwen2.5:7b`. Needs a GPU to be useful: on a CPU a 7B model breaks the required format in about half its answers, smaller ones barely work (measurements behind the link).
- **OpenRouter `:free` models** with a free account's key, listed in `LLM_FREE_MODELS`. Non-zero prices are refused; if none are free it waits and never switches to a paid model.

<!-- doc-test: skip turns on collection and model calls, which reach outside services; CI makes no outside calls -->
```bash
sed -i 's/^COLLECT_ENABLED=false/COLLECT_ENABLED=true/; s/^MODEL_CALLS_ENABLED=false/MODEL_CALLS_ENABLED=true/' .env
docker compose up -d
```

That is the **instance key** (background work, billed to whoever deploys). Registered readers can put their own key in Settings (BYOK); Chat uses their quota. Paid calls leave a receipt and hit per-minute / per-hour / per-day budget breakers.

Full deploy: [docs/self-hosting.md](docs/self-hosting.md). Every setting: [docs/configuration.md](docs/configuration.md).

---

## How it works

```
Sources (RSS / web list / JSON / X / WeChat / push)
   │  worker fetches on a schedule, dedupes
   ▼
Pre-filter → score twice → title & summary → extract → merge into events
   │                    (all in the worker; opening a page never calls a model)
   ▼
Pick by project relevance → freeze one issue at 08:00 in the reader's time zone (≤3 cards, ≤2 per source)
   │
   ▼
Site (Today / Archive) · RSS · /api/v1 · MCP · llms.txt
```

- Six source kinds, one pipeline
- Pre-filter / scoring / tone live in `industry/` prompts and can be retargeted
- Adding a project does not multiply model calls per article
- Sources carry region tags (`global` / `cn` / `us` / `eu` / `jp`); the project wizard can filter by region
- Each reader picks the UI language (简体中文 / English) and time zone (default Asia/Shanghai) in Settings; visitors and the admin get `SITE_LOCALE`
- Retarget an industry by editing only `industry/` → [docs/customize.md](docs/customize.md)

Diagrams: [docs/architecture.md](docs/architecture.md).

---

## Honest limits

- The UI is in Chinese and English; Chat answers in the reader's language, and so does the copy on a reader's own daily cards. Titles and summaries in the public pool follow the site language (`SITE_LOCALE`); source names are the sources' own (mostly English)
- The built-in demo model is fixed rules, not a model: it walks Chat → card → project end to end and never analyses articles
- No full-text republication by default — summary + original link (`site_fulltext` is opt-in per source)
- Single-node PostgreSQL; no horizontal scale-out
- Card quality follows your model and sources; the demo is hand-written, live summaries can be wrong — the page says so
- Each issue is fixed at 08:00 in the reader's own time zone; a thin day stays empty, no backfill after the cutoff. Worker schedules (fetching, reports) all run on Asia/Shanghai time
- One maintainer, best-effort, no SLA → [SUPPORT.md](SUPPORT.md); vulnerability reports → [SECURITY.md](SECURITY.md)

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `required variable POSTGRES_PASSWORD is missing a value` | No `.env` yet | Run `init-env` (step 1) |
| `Bind for …:3000 failed: port is already allocated` | Port 3000 in use | Set `PORT=127.0.0.1:3300` in `.env`, then `docker compose up -d` |
| `curl …/api/health` gives 200 but the page is not Topka | Another service holds that port | Use `curl -s "http://$(docker compose port web 3000)/api/health"` |
| No `demo:` lines in `logs setup` | `.env` does not have `DEMO_SEED=true` | Set it and `docker compose up -d`, or run `docker compose exec api npm run demo:seed` |
| Lost the demo password | Printed once; restarting after editing `.env` clears setup logs | Add `DEMO_PASSWORD=at-least-10-chars` to `.env` → `docker compose up -d` (containers read `.env` only when recreated) → `docker compose exec api npm run demo:seed` |
| A pack shows "unavailable" in New project | An upgraded database has not restarted yet, so the pack's sources are not imported | The page names the reason and the command: `docker compose exec api npm run sources:seed -- --pack <name>` |
| Chat input is greyed out | No model and no demo model | The page links the docs; set `DEMO_SEED=true` to try it, or connect Ollama / a free model |
| `demo:seed` refuses | Other users or real articles already in the DB | Add `-- --force`, or `docker compose down -v` and start over |
| Sources on, still no new articles after a few minutes | `COLLECT_ENABLED=false`, or no restart after the change | Set `true`, `docker compose up -d`; failures show in `/admin/sources` |
| `docker compose logs` lines start with `ESC[2K` | Docker Compose's own line-clear code in non-terminal output, not printed by Topka | Harmless for grep. On Compose 2.26 neither `--ansi never` nor `--no-log-prefix` removes it; for clean text read the container log directly: `docker logs $(docker compose ps -aq setup)` |
| Articles exist, no new cards | No model, or `MODEL_CALLS_ENABLED=false` | See [Real sources and a model](#real-sources-and-a-model); search logs for `is not configured` |

More (`NO_FREE_MODEL`, reaching overseas sources from China): [troubleshooting](docs/self-hosting.md#troubleshooting).

---

## Docs and contributing

Tutorial: [docs/tutorial.en.md](docs/tutorial.en.md) ([中文](docs/tutorial.md)). Index: [docs/README.md](docs/README.md). Often used: [self-hosting](docs/self-hosting.md) · [configuration](docs/configuration.md) · [architecture](docs/architecture.md) · [customize](docs/customize.md) · [sources](docs/sources.md) · [selection](docs/selection.md) · [plugins](docs/plugins.md). Apart from the tutorial and this page, docs are English for now.

Dev setup: [CONTRIBUTING.md](CONTRIBUTING.md). Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Also [GOVERNANCE.md](GOVERNANCE.md), [MAINTAINERS.md](MAINTAINERS.md), [SUPPORT.md](SUPPORT.md), [TRADEMARK.md](TRADEMARK.md).

## License

MIT — [LICENSE](LICENSE). Thanks to [AIHOT](https://github.com/KKKKhazix/AIHOT). Third-party notices: [NOTICE](NOTICE).
