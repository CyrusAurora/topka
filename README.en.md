<div align="center">

[简体中文](README.md) · **English**

# Topka

<img src="docs/assets/screenshot-today.png" alt="Topka Today page: No. 003, three 【示例】 cards" width="100%">

> *"Only what changed. When the evidence is thin, it says so."*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.1-blue)](CHANGELOG.md)
[![Self-hosted](https://img.shields.io/badge/self--hosted-Docker%20Compose-2496ED?logo=docker&logoColor=white)](#quick-start-no-api-key)
[![BYOK](https://img.shields.io/badge/BYOK-bring%20your%20own%20key-6f42c1)](#real-sources-and-a-model)

**A self-hosted intelligence brief: say what to watch, and each day it picks a few items from your sources that are worth reading, each linking back to the original.**

```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:24-trixie-slim node scripts/init-env.ts
DEMO_SEED=true docker compose up -d --build
```

<sub>Three commands. After login you get the screenshot above — invented demo data, no API key, no crawling, no model calls.</sub>

[See it](#see-it) · [Quick start](#quick-start-no-api-key) · [Real sources and a model](#real-sources-and-a-model) · [How it works](#how-it-works) · [Honest limits](#honest-limits) · [Troubleshooting](#troubleshooting)

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

**Need:** Docker Compose v2 (`docker compose version` prints a version), `git`, ~3 GB disk, port 3000 free. 2 cores / 4 GB is enough. No Node, PostgreSQL, API key, or GPU. If 3000 is taken, prefix commands with `PORT=127.0.0.1:3300`. Loopback-only by default; for other machines see [HTTPS](docs/self-hosting.md#https-caddy-profile).

**1. Clone and generate `.env`**

```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:24-trixie-slim node scripts/init-env.ts
```

It prints the admin password, and a line about filling `LLM_API_KEY` — ignore that for the demo.

**2. Start with demo data**

```bash
DEMO_SEED=true docker compose up -d --build
```

First build takes about 5–15 minutes. It brings up the database, runs migrations, and seeds a demo reader, the project “人形机器人量产（示例）”, and three days of invented cards.

**3. Get the demo password and sign in**

```bash
docker compose logs setup | grep demo:
```

```text
setup-1  | demo: ready. Log in at /login as demo@example.com
setup-1  | demo: password demo-1be4ef872d6d  (shown once; set DEMO_PASSWORD and re-run to reset it)
```

The password is shown once. Open <http://localhost:3000/login> as `demo@example.com`.

**You are done when**

- Today shows **No. 003** with three 【示例】 cards, matching the hero screenshot
- Expanding a card shows a summary; Archive has the two earlier days
- Admin is at <http://localhost:3000/admin> with `ADMIN_PASSWORD` from `.env`

Stuck? [Troubleshooting](#troubleshooting). Real articles without a model: [tutorial part 2](docs/tutorial.en.md#part-2-two-real-sources-still-no-model-key).

```bash
docker compose down -v   # wipe including the database
```

---

## Real sources and a model

Demo data does not refresh. A new daily issue needs **sources on** and **a model**. Both are off by default.

**Sources.** ~400 ship with the repo, imported but disabled. Enable them in `/admin/sources`, or:

```bash
docker compose exec api npm run sources:only -- --id rss-hugging-face --id rss-github-ai
```

**Model.** Any OpenAI-compatible endpoint. In `.env`:

```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-flash
```

Free-only: point at OpenRouter and list `:free` models in `LLM_FREE_MODELS`. Non-zero prices are refused; if none are free it waits — it never silently upgrades to a paid model. See [model connection](docs/self-hosting.md#model-connection).

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
Pick by project relevance → freeze one issue at 08:00 UTC+8 (≤3 cards, ≤2 per source)
   │
   ▼
Site (Today / Archive) · RSS · /api/v1 · MCP · llms.txt
```

- Six source kinds, one pipeline
- Pre-filter / scoring / tone live in `industry/` prompts and can be retargeted
- Adding a project does not multiply model calls per article
- Retarget an industry by editing only `industry/` → [docs/customize.md](docs/customize.md)

Diagrams: [docs/architecture.md](docs/architecture.md).

---

## Honest limits

- UI and generated copy are Chinese-first; no i18n yet
- No full-text republication by default — summary + original link (`site_fulltext` is opt-in per source)
- Single-node PostgreSQL; no horizontal scale-out
- Card quality follows your model and sources; the demo is hand-written, live summaries can be wrong — the page says so
- Freeze time is fixed at 08:00 UTC+8; a thin day stays empty, no backfill after the cutoff
- One maintainer, best-effort, no SLA → [SUPPORT.md](SUPPORT.md); vulnerability reports → [SECURITY.md](SECURITY.md)

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `required variable POSTGRES_PASSWORD is missing a value` | No `.env` yet | Run `init-env` (step 1) |
| `Bind for …:3000 failed: port is already allocated` | Port 3000 in use | Prefix with `PORT=127.0.0.1:3300` |
| No `demo:` lines in `logs setup` | Started without `DEMO_SEED=true` | `docker compose exec api npm run demo:seed` |
| Lost the demo password | Printed once; restarting after editing `.env` clears setup logs | Set `DEMO_PASSWORD=at-least-10-chars` in `.env`, re-run `demo:seed` |
| `demo:seed` refuses | Other users or real articles already in the DB | Add `-- --force`, or `docker compose down -v` and start over |
| `.env not found. Continuing without it.` inside a container | Containers take env from Compose, not the file | Harmless |
| Sources on, still no new articles after a few minutes | `COLLECT_ENABLED=false`, or no restart after the change | Set `true`, `docker compose up -d`; failures show in `/admin/sources` |
| Articles exist, no new cards | No model, or `MODEL_CALLS_ENABLED=false` | See [Real sources and a model](#real-sources-and-a-model); search logs for `is not configured` |

More (`NO_FREE_MODEL`, reaching overseas sources from China): [troubleshooting](docs/self-hosting.md#troubleshooting).

---

## Docs and contributing

Tutorial: [docs/tutorial.en.md](docs/tutorial.en.md) ([中文](docs/tutorial.md)). Index: [docs/README.md](docs/README.md). Often used: [self-hosting](docs/self-hosting.md) · [configuration](docs/configuration.md) · [architecture](docs/architecture.md) · [customize](docs/customize.md) · [sources](docs/sources.md) · [selection](docs/selection.md) · [plugins](docs/plugins.md). Apart from the tutorial and this page, docs are English for now.

Dev setup: [CONTRIBUTING.md](CONTRIBUTING.md). Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Also [GOVERNANCE.md](GOVERNANCE.md), [MAINTAINERS.md](MAINTAINERS.md), [SUPPORT.md](SUPPORT.md), [TRADEMARK.md](TRADEMARK.md).

## License

MIT — [LICENSE](LICENSE). Thanks to [AIHOT](https://github.com/KKKKhazix/AIHOT). Third-party notices: [NOTICE](NOTICE).
