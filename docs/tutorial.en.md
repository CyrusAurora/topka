# Tutorial: from an empty machine to the first card on screen

**English** · [简体中文](tutorial.md)

By the end of this page you have a Topka site running on your own machine, showing a finished daily
issue. It needs **no API key and no GPU** and takes about 30 minutes, most of it the first image build.

- **Part 1** uses only the demo data that ships with the repository: every source, headline and number
  is invented. Nothing is fetched from the internet. Chat answers from a built-in demo model (fixed
  rules); no real model is called.
- **Part 2** switches on two real RSS sources so you can watch real articles arrive. Model calls stay
  off, so articles are collected but not analysed.
- **Part 3** creates your own tracking project with the New project wizard and with Chat, and
  (optionally) connects a real model at no cost.

A production deployment (HTTPS, backups, upgrades) is a separate step: read
[self-hosting.md](self-hosting.md) once this page works.

## What you need

- **Docker with Compose v2**: `docker compose version` prints a version. The database, backend and web
  server all run in containers; you do not install Node.js or PostgreSQL on the host.
- **`git`**.
- **About 3 GB of free disk** for the images. A 2-core / 4 GB machine is enough.
- **A free port**, 3000 by default. The port is set in one place, `PORT` in `.env`. If 3000 is taken,
  add `--port 127.0.0.1:3300` to step 1's `init-env.ts` command; every other command stays as written,
  and you open 3300 in the browser wherever this page says 3000. The site is published on `127.0.0.1`
  only, so it opens on this machine; to open it from another one see
  [self-hosting.md → HTTPS](self-hosting.md#https-caddy-profile).

The site and the demo content default to Chinese; this page translates every label you need. Add
`--locale en` to step 1's `init-env.ts` for an English site and English demo stories instead (the
screenshots here show the Chinese default).

## Part 1: the demo site

### 1. Get the code and generate `.env`

```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:24-trixie-slim node scripts/init-env.ts --demo
```

The second command runs `scripts/init-env.ts` in a throwaway Node container and writes `.env` with
random secrets (database password, session keys). `-u "$(id -u):$(id -g)"` makes the file yours rather
than root's. `--demo` writes `DEMO_SEED=true` into it. It prints, in Chinese (in English with
`--locale en`):

```text
已生成 .env。网站地址：http://localhost:3000（改端口就改 .env 里的 PORT）
管理员密码：<random>（也写在 .env 的 ADMIN_PASSWORD 里）
演示：DEMO_SEED=true，启动时写入演示数据；没接模型时「对话」由内置演示模型回答。
模型：LLM_API_KEY 还空着。接免费模型或本地 Ollama 见 docs/self-hosting.md#model-connection。
```

That is ".env generated, site address …", "admin password: … (also in `ADMIN_PASSWORD` in .env)",
"demo: startup loads the demo content, and the built-in demo model answers Chat", and a note that no
model key is set. **Ignore the last line for now.** Leave `COLLECT_ENABLED=false` (no collection) and
`MODEL_CALLS_ENABLED=false` (no model calls) as they are.

Run again while `.env` exists, it only says so and exits; the passwords and secrets in it stay as they
are. Rename or delete `.env` first to generate a new one. With Node.js ≥ 24 on the host,
`node scripts/init-env.ts --demo` does the same without the container.

### 2. Start with the demo content

```bash
docker compose up -d --build
```

The first build takes from half a minute to a quarter of an hour depending on the network; once the
image exists a start takes seconds. The command ends with lines like these (order may vary):

```text
 Container topka-api-1  Started
 Container topka-worker-1  Started
 Container topka-web-1  Started
```

On the way, the one-shot `setup` container applies the migrations, imports the topics, the source
list and the four project packs (all switched off), and then, because `DEMO_SEED=true`, runs
`scripts/demo.ts`, which creates:

- a reader account `demo@example.com`,
- one tracking project, "人形机器人量产（示例）" (humanoid robot mass production, example),
- three invented sources (`示例机器人通讯` and friends, `https://example.org/...` addresses; their items
  are imported directly and they are never fetched),
- nine invented stories: three in today's issue and three in each of the two previous days.

`DEMO_SEED=true` can stay in `.env`: later restarts only refresh the demo's own rows and touch
nothing else.

Check that the services answer. `docker compose port web 3000` prints where this stack's web
container is published, so the check follows `PORT` and never reaches another service holding 3000:

```bash
curl -s "http://$(docker compose port web 3000)/api/health"
```

```text
{"app":"topka","version":"0.2.0","ok":true,"db":"ok","ms":1,"release":"0.2.0"}
```

`"app":"topka"` tells you Topka answered, not some other service on this machine. Right after start the
first request can come back empty; wait a few seconds and repeat.

### 3. Read the demo password

It is random and printed once, when the account is created, in the setup log:

```bash
docker compose logs setup | grep demo:
```

```text
setup-1  | demo: ready. Log in at /login as demo@example.com
setup-1  | demo: password demo-1be4ef872d6d  (shown once; to reset it: add DEMO_PASSWORD=<10+ characters> to .env, run `docker compose up -d`, then `docker compose exec api npm run demo:seed`)
setup-1  | demo: project project:h7e5…, issues written for 2026-11-07, 2026-11-08 and 2026-11-09
```

Your password and dates differ. **Write the password down now**: when part 2 restarts the stack after
editing `.env`, the `setup` container is recreated and these log lines are gone.

To choose the password yourself, three steps (containers read `.env` only when they are recreated, so
the middle one matters):

```bash
echo 'DEMO_PASSWORD=at-least-10-chars' >> .env
docker compose up -d
docker compose exec api npm run demo:seed     # prints demo: password … (from DEMO_PASSWORD)
```

Or, for this one run without editing `.env`:
`docker compose exec -e DEMO_PASSWORD=at-least-10-chars api npm run demo:seed`. That lasts only until
the next restart if `.env` also has a `DEMO_PASSWORD`: the next `docker compose up -d` runs `setup`, which
sets the password back to the `.env` value. To keep a new password, put it in `.env` (the three steps
above). `demo:seed` also adds
the demo to a stack whose `.env` does not have `DEMO_SEED=true`.

### 4. Log in and look

Open <http://localhost:3000/login> (or the address init-env printed) and sign in as
`demo@example.com` with that password.

**You are done when you see:**

- **今日** (Today): issue **No. 003** with three numbered cards. Every title starts with `【示例】`
  ("example"): the demo says plainly that it is not real news.
- **Click a card's title**: it expands to the summary ("讲了什么 · AI 摘要", "what it says · AI
  summary"), the source domain (`example.org`) and a button to copy the original link (复制原文链接).
- **往期** (Past issues): the two earlier days, three titles each. Click one to open that day's issue.
- **The project page**: in 设置 (Settings), open "人形机器人量产（示例）": the same stories, with a line
  saying how many sources are linked and how many are switched on.

![Today with the demo data, first card expanded](assets/screenshot-demo-today.png)

To read the interface in English, open 设置 (Settings) and pick English; the demo's card titles stay
Chinese, since that is the language they were written in. The time zone picked there sets when your
issue is fixed: 08:00 in that zone, default Asia/Shanghai.

That is the whole product loop (sources, a tracking project, a daily issue of the top three stories)
on synthetic data. The admin UI is at <http://localhost:3000/admin> with the `ADMIN_PASSWORD` from
`.env`.

> Nothing on this screen changes by itself: with collection and model calls off, tomorrow's issue
> stays empty. Part 2, and then a model (part 3), make it move.

## Part 2: real articles, still no model key

Now let the site collect from two real RSS feeds. Model calls stay **off**, so you will see articles
arrive, but no scoring, no summaries and no new cards.

**1. Switch on two sources** (all others stay off):

```bash
docker compose exec api npm run sources:only -- --id rss-hugging-face --id rss-github-ai
```

The output is this line:

```text
保持打开 2 个（新打开 2），关闭其余 3 个
```

It reads "kept 2 on (2 newly on), switched 3 others off". The 3 are the demo's own invented sources
(on with `--demo`; without it the line ends in 0). The demo's Today and Past issues are unaffected; the
demo project's page now shows its sources as off.

The source list is also in the admin at <http://localhost:3000/admin/sources>; from a shell,
`docker compose exec api npm run sources:list` prints every id. The setup step loads the topic packs
and the bundled feed list, a few hundred sources in total (the exact number is on the `sources:` line of
the `setup` log), and all but the demo's 3 start switched off; `sources:only` turns the named ones on and
all the others off.

**2. Turn collection on in `.env` and restart:**

```bash
sed -i 's/^COLLECT_ENABLED=false/COLLECT_ENABLED=true/' .env
docker compose up -d
```

The port is in `.env` (`PORT`), so nothing goes in front of the command. This restart runs the demo
script again, which only refreshes the demo's own rows and does not switch the demo sources you just
turned off back on: `sources:list -- --enabled` shows the same 2 before and after.

**3. Watch it work, within a few minutes:**

- **`/admin/sources`** is the place to watch: the two sources move to the top, each showing its last
  successful fetch and its item count for the last 7 days. `/admin/runs` next to it lists the
  scheduled jobs (the sweep, translation, the hot ranking), not the per-source fetches.
- **`/admin/content`** opens on the newest articles; the search box looks one up by id, URL or title. An article's page has an
  "Observation ledger" card: its versions, refused reports, and buttons to record a withdrawal or
  reinstatement ([ledger.md](ledger.md)).
- **`docker compose logs -f worker`** prints one line per fetch that stored something new (or failed):

  ```text
  worker-1  | {"level":"info","msg":"source fetch","source":"rss-github-ai","found":10,"new":8,"revised":0}
  ```

  A fetch that found nothing new stays silent, so a quiet feed produces no log noise.

The first import of a feed keeps up to 8 recent items; later runs add only what is new.

Compose also starts an `rsshub` container (about 470 MB) that the bundled Weibo sources use. The two
feeds above do not need it; it can stay idle.

**What will not appear:** the articles are not analysed, so they get no title, summary or score, they
do not enter the public pool, and 今日 gets no new cards. That needs a model, see part 3.

`sources:list` prints the last success in the instance's schedule time (UTC+8, with `+08:00` written
out).

## Part 3: your own tracking project

**With the wizard.** Settings → New project (`/projects/new`) starts from a pack: AI models, embodied
AI & robotics, open source & developers, semiconductors & compute. All four are imported at startup
(their sources switched off), so all four can be picked. Then tick the sources to focus on (with a
region filter) → name it (empty means the pack's name) → preview → confirm.

The project page then says how many sources are linked and how many are switched on on this site.
Sources still off, collection off, or no model: the page says which and links the docs. A project picks
sources; it does not switch them on for the admin. To get items in, switch them on as in part 2.

**With Chat.** Open 对话 (Chat) and say what to track, for example "Track humanoid robots for me".
Without a model, a "Demo model" banner sits on top: it asks two fixed questions (which kind of change
matters most, what to leave out), turns your need into one question for you to confirm, then shows a
tracking card; Confirm creates the project. "Delete the humanoid robots project" brings a delete card
that also waits for your confirmation. Halfway through the questions you can still change course:
"Cancel" ends the interview with nothing created, a new "Track …" sentence starts over on the new topic,
and "Delete …" goes straight to the delete card. The demo model is only there to walk the flow; its
answers are fixed and it analyses no articles.

**A real model at no cost (optional).** Two ways; every line is in
[self-hosting.md → Without a paid key](self-hosting.md#without-a-paid-key):

- **Local Ollama**, no account:

  ```bash
  cat >> .env <<'EOF'
  COMPOSE_PROFILES=ollama
  LLM_BASE_URL=http://ollama:11434/v1
  LLM_API_KEY=ollama
  LLM_MODEL=qwen2.5:7b
  LLM_EXTRA_JSON=
  EOF
  sed -i 's/^MODEL_CALLS_ENABLED=false/MODEL_CALLS_ENABLED=true/' .env
  docker compose up -d
  docker compose exec ollama ollama pull qwen2.5:7b     # 4.7 GB, downloaded once
  ```

  When `.env` has a name twice, the later line wins. Open Chat again: no "Demo model" banner;
  requests go to the local model. Expect little on a CPU: with no GPU a 7B model takes 10–30 s a turn,
  about half its answers break the required format and are rejected, and article analysis often fails
  on format too; smaller models barely work (measurements in
  [self-hosting.md](self-hosting.md#without-a-paid-key)). On a CPU, Ollama proves the local endpoint is
  wired up; for Chat and a daily issue at no cost, use the `:free` models below.
- **OpenRouter `:free` models**: a free account's key and `LLM_FREE_MODELS` as in self-hosting.md.
  Only zero-priced models are called; with none free it waits and never switches to a paid one.

## Clean up

```bash
docker compose down -v   # stops everything and deletes the database volume
```

For an empty site with no demo rows, set `DEMO_SEED=false` in `.env` and `docker compose up -d --build`.
The demo seed refuses to run on a database that has other users or non-demo articles but no demo
account yet, unless you pass `--force` (`docker compose exec api npm run demo:seed -- --force`).

## Stuck?

| Symptom | Cause | Fix |
|---|---|---|
| `required variable POSTGRES_PASSWORD is missing a value` | No `.env` yet, or you are not in the `topka` directory | Run step 1's `init-env` |
| `Bind for …:3000 failed: port is already allocated` | Something else on the machine uses 3000 | Set `PORT=127.0.0.1:3300` in `.env`, `docker compose up -d`, open 3300 |
| The health `curl` says 200 but the browser shows something else | Another service holds that port | Use step 2's `curl -s "http://$(docker compose port web 3000)/api/health"` |
| `permission denied while trying to connect to the Docker daemon socket` | Your user may not talk to Docker | Add yourself to the `docker` group and log in again, or prefix the `docker` commands with `sudo` |
| No `demo:` lines in `logs setup` | `.env` does not have `DEMO_SEED=true` | `docker compose exec api npm run demo:seed` |
| The demo password is gone | It is printed only when the account is created | Reset it with `DEMO_PASSWORD`, see step 3 (do not skip `docker compose up -d`) |
| A pack in New project says unavailable | Its sources are not imported yet (an upgraded database that has not restarted), or none are in the chosen region | The page names the reason and the command |
| Chat input is greyed out | No model, and `.env` does not have `DEMO_SEED=true` | The page links the docs; see part 3 |
| Sources on for minutes, still 0 items at `/admin/sources` | `COLLECT_ENABLED` not `true`, or no restart after the edit; or the network cannot reach the feeds | Check `.env`, run `docker compose up -d`; behind the mainland-China firewall see [self-hosting.md](self-hosting.md#note-on-deployment-in-mainland-china) |

Anything else: [self-hosting.md#troubleshooting](self-hosting.md#troubleshooting).
