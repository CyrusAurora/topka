# 教程：从一台空电脑到屏幕上的第一张卡片

[English](tutorial.en.md) · **简体中文**

走完这一页，你会在自己电脑上跑起一个 Topka 站点，看到已经定稿的一期「今日」。全程**不需要 API key，也不需要 GPU**，大约 30 分钟，大部分时间花在第一次构建镜像上。

- **第一部分**只用仓库自带的演示数据：信源、标题、数字全是虚构的，不抓任何网站。「对话」由内置演示模型按固定规则回答，不调用任何真实模型。
- **第二部分**打开两个真实的 RSS 信源，看真实文章进来。模型仍然是关的，所以只采集、不分析。
- **第三部分**用「新建项目」向导和「对话」建你自己的跟踪项目，最后（可选）接一个不花钱的真实模型。

正式部署（HTTPS、备份、升级）是另一回事，等这页走完再看 [self-hosting.md](self-hosting.md)。

## 需要什么

- **Docker 和 Compose v2**（Docker 把程序连同它依赖的一切装进「容器」里运行；Compose 一条命令拉起一组容器）。终端里跑 `docker compose version`，能打出版本号就行。Topka 的数据库、后端和网页都在容器里，你的电脑上不用装 Node.js 或 PostgreSQL。
- **`git`**。
- **大约 3 GB 磁盘**放镜像。2 核 4 GB 的机器就够。
- **一个空闲端口**，默认 3000。端口只在一处设置：`.env` 里的 `PORT`。3000 被占的话，第 1 步的 `init-env.ts` 后面加 `--port 127.0.0.1:3300`，之后所有命令照抄，下文的 3000 换成 3300 去打开浏览器就行。站点默认只在本机能打开（只监听 `127.0.0.1`）；要让别的机器访问，看 [self-hosting.md 的 HTTPS 一节](self-hosting.md#https-caddy-profile)。

## 第一部分：演示站点

### 1. 拿代码，生成 `.env`

```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:24-trixie-slim node scripts/init-env.ts --demo
```

第二条命令在一个用完就删的 Node 容器里运行 `scripts/init-env.ts`，生成配置文件 `.env`：数据库密码、会话密钥这些都是随机生成的。`-u "$(id -u):$(id -g)"` 让生成的文件归你自己，而不是归 root。`--demo` 在 `.env` 里写上 `DEMO_SEED=true`。它会打印：

```text
已生成 .env。网站地址：http://localhost:3000（改端口就改 .env 里的 PORT）
管理员密码：（一串随机字符）（也写在 .env 的 ADMIN_PASSWORD 里）
演示：DEMO_SEED=true，启动时写入演示数据；没接模型时「对话」由内置演示模型回答。
模型：LLM_API_KEY 还空着。接免费模型或本地 Ollama 见 docs/self-hosting.md#model-connection。
```

最后一行**这一部分先不用管**。`.env` 里的 `COLLECT_ENABLED=false`（不采集）和 `MODEL_CALLS_ENABLED=false`（不调用模型）也保持原样。

`.env` 已经存在时，再跑一次只会提示「.env 已经存在，没有覆盖」并退出，里面的密码和密钥不变；要重新生成就先把它改名或删掉。本机装了 Node.js 24 以上的话，直接 `node scripts/init-env.ts --demo` 效果一样。

### 2. 带着演示数据启动

```bash
docker compose up -d --build
```

第一次要构建镜像，按网速从半分钟到十几分钟；镜像有了以后，再启动只要几秒。命令结束时，最后几行类似这样（顺序可能不同）：

```text
 Container topka-api-1  Started
 Container topka-worker-1  Started
 Container topka-web-1  Started
```

启动过程中有一个只跑一次的 `setup` 容器：先做数据库迁移，再导入主题、信源列表和四个项目方向包（全部是关的），最后因为 `DEMO_SEED=true`，运行 `scripts/demo.ts` 写入：

- 一个读者账号 `demo@example.com`；
- 一个追踪项目「人形机器人量产（示例）」；
- 三个虚构信源（`示例机器人通讯` 等，地址都是 `https://example.org/...`，内容是直接导入的，永远不会去抓）；
- 九条虚构新闻：今天一期三条，前两天各三条。

`DEMO_SEED=true` 留在 `.env` 里没关系：以后每次重启只刷新演示自己的那几行，不碰别的数据。

确认服务起来了（`docker compose port web 3000` 打印的是这个 stack 自己发布的地址，改了 `PORT` 也对，不会问到占着 3000 的别的服务）：

```bash
curl -s "http://$(docker compose port web 3000)/api/health"
```

```text
{"app":"topka","version":"0.2.0","ok":true,"db":"ok","ms":1,"release":"0.2.0"}
```

`"app":"topka"` 说明答话的是 Topka，不是这台机器上别的服务。刚启动时可能先拿到空响应，等几秒再试。

### 3. 拿到演示密码

密码是随机的，只在第一次创建账号时打印一次，在 `setup` 的日志里：

```bash
docker compose logs setup | grep demo:
```

```text
setup-1  | demo: ready. Log in at /login as demo@example.com
setup-1  | demo: password demo-1be4ef872d6d  (shown once; to reset it: add DEMO_PASSWORD=<10+ characters> to .env, run `docker compose up -d`, then `docker compose exec api npm run demo:seed`)
setup-1  | demo: project project:h7e5…, issues written for 2026-11-07, 2026-11-08 and 2026-11-09
```

你的密码和日期会和这里不一样。**现在就把密码记下来**：第二部分改完 `.env` 重启时，`setup` 容器会重建，这几行日志就看不到了。

想自己定密码，三步（容器只在重建时读 `.env`，所以中间那步不能省）：

```bash
echo 'DEMO_PASSWORD=至少10个字符' >> .env
docker compose up -d
docker compose exec api npm run demo:seed     # 打印 demo: password …（from DEMO_PASSWORD）
```

或者不改 `.env`，只对这一次生效：`docker compose exec -e DEMO_PASSWORD=至少10个字符 api npm run demo:seed`。注意它只管这一次：如果 `.env` 里也写着 `DEMO_PASSWORD`，下次 `docker compose up -d` 时 `setup` 会按 `.env` 里的值把密码改回去。想一直用新密码，就写进 `.env`（上面三步）。`.env` 里不是 `DEMO_SEED=true` 的站点，也可以用 `demo:seed` 补上演示数据。

### 4. 登录，看一眼

打开 <http://localhost:3000/login>（换了端口就用 init-env 打印的地址），用 `demo@example.com` 和刚才的密码登录。

**看到这些就成了：**

- **今日**：第 **No. 003** 期，三张编号卡片，每个标题都以【示例】开头。演示数据自己说明了它不是真新闻。
- **点开卡片标题**：展开「讲了什么 · AI 摘要」、出处域名（`example.org`）和「复制原文链接」按钮。
- **往期**：前两天的两期，每期三个标题，点进去是那天完整的一期。
- **项目页**：「设置」里点「人形机器人量产（示例）」，看到同样的几条，顶上写着关联了几个信源、开着几个。

![今日页，演示数据，第一张卡片已展开](assets/screenshot-demo-today.png)

「设置」里可以把界面换成 English，也可以选时区：每天的一期在你所选时区的 08:00 定稿，默认 Asia/Shanghai。

信源、追踪项目、每天一期的前三条，整个产品的闭环就是这些，只是现在用的是假数据。后台在 <http://localhost:3000/admin>，用 `.env` 里的 `ADMIN_PASSWORD` 登录。

> 这个页面不会自己变：采集和模型都关着，第二天的那一期不会有内容。要它动起来，接着做第二部分，最后接上模型（第三部分）。

## 第二部分：接两个真实信源，仍然不用模型 Key

现在让站点从两个真实的 RSS 信源采集文章。模型调用还是**关的**，所以你会看到文章进来，但没有打分、没有摘要，也不会出新卡片。

**1. 只打开两个信源**（其余全部保持关闭）：

```bash
docker compose exec api npm run sources:only -- --id rss-hugging-face --id rss-github-ai
```

输出是这一行：

```text
保持打开 2 个（新打开 2），关闭其余 3 个
```

关掉的 3 个是演示自带的 3 个虚构信源（`--demo` 时它们是开着的）。没用 `--demo` 的话这里是「关闭其余 0 个」。演示的今日和往期不受影响，演示项目页会显示它的信源关着。

全部信源的列表在后台 <http://localhost:3000/admin/sources>，命令行里 `docker compose exec api npm run sources:list` 会打出每个 id。启动时导入了主题包和自带的信源列表，一共三百多个（确切数字在 `setup` 日志的 `sources:` 那一行），除了演示的 3 个都是关的；`sources:only` 打开指定的这几个，把其他的都关掉。

**2. 打开采集，重启：**

```bash
sed -i 's/^COLLECT_ENABLED=false/COLLECT_ENABLED=true/' .env
docker compose up -d
```

端口在 `.env` 的 `PORT` 里，这里什么都不用加。这次重启时 `setup` 会再跑一遍演示脚本，只刷新演示自己的数据，不会把你刚关掉的演示信源再打开：`sources:list -- --enabled` 前后都是这 2 个。

**3. 几分钟内看它干活：**

- **`/admin/sources`** 最值得看：这两个信源排到最上面，显示上次成功抓取的时间和最近 7 天的条数。旁边的 `/admin/runs` 列的是定时任务（巡检、翻译、热榜），不是每次抓取。
- **`/admin/content`** 打开就是最新的文章；搜索框可以按 id、网址或标题找。文章页有一张“观测账本”卡片：历次版本、被拒收的报告，以及记录撤回、恢复的按钮（见 [ledger.md](ledger.md)）。
- **`docker compose logs -f worker`**：每次抓到新东西（或抓取失败）打一行，比如：

  ```text
  worker-1  | {"level":"info","msg":"source fetch","source":"rss-github-ai","found":10,"new":8,"revised":0}
  ```

  什么新东西都没抓到的那次不打日志，所以安静的信源不会刷屏。

一个信源第一次导入时最多留 8 条最近的文章，之后只收新的。

Compose 还会起一个 `rsshub` 容器（约 470 MB），给自带的微博信源用。上面两个 RSS 用不到它，让它闲着就行。

**不会出现的东西**：文章没有经过分析，所以没有中文标题、摘要和分数，不进公开内容池，「今日」也不会多出卡片。这一步需要模型，见第三部分。

`sources:list` 里「上次成功」的时间按实例的调度时区写（UTC+8，带 `+08:00`）。

## 第三部分：建你自己的跟踪项目

**用向导。**「设置 → 新建项目」（`/projects/new`）先选一个方向包：AI 模型、具身智能与机器人、开源与开发者、半导体与算力。四个包在启动时都已导入（信源是关的），所以都能选。然后勾要重点看的信源（可按地区筛）→ 起名（留空就用包名）→ 预览 → 确认创建。

建好后项目页会写明：关联了几个信源、实例上开着几个；还关着的信源、没开的采集、没接的模型，页面上都会写出来，并链到对应文档。项目只挑信源，不会替管理员打开它们：要它进内容，按第二部分打开这些信源。

**用「对话」。** 打开「对话」，说一句想跟踪什么，比如「帮我跟踪人形机器人」。没接模型时，顶上写着「演示模型」：它按固定规则问两个问题（最关心哪类变化、不想看到什么），把需求整理成一个问题请你确认，再给出一张跟踪卡片；点确认就建好项目。说「删除人形机器人这个项目」会出一张删除卡片，同样要你确认。问到一半也可以改主意：说「取消」就结束这次问答、什么都不建；换一句「帮我跟踪……」就按新话题从头问；说「删除……」直接出删除卡片。演示模型只用来走通流程，回答是固定的，也不分析文章。

**接一个不花钱的真实模型（可选）。** 两条路，具体每一行见 [self-hosting.md 的 Without a paid key](self-hosting.md#without-a-paid-key)：

- **本地 Ollama**，不用注册：

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
  docker compose exec ollama ollama pull qwen2.5:7b     # 4.7 GB，只下一次
  ```

  `.env` 里同名的行以后面的为准。再开「对话」，顶上不再有「演示模型」，请求发给本地模型。先说清楚效果：没有 GPU 时，7B 模型每轮 10–30 秒，约一半的回答格式不合要求会被拒，文章分析也常卡在格式上；更小的模型基本用不起来（实测见 [self-hosting.md 的表](self-hosting.md#without-a-paid-key)）。CPU 上的 Ollama 只能证明本地模型接通了；要真正用对话和每日简报又不花钱，用下面的 `:free` 模型。
- **OpenRouter 的 `:free` 模型**：注册免费账号拿 Key，按 self-hosting.md 填 `LLM_FREE_MODELS`。只用报价为 0 的模型，没有免费的就等，不会换成收费模型。

## 收尾

```bash
docker compose down -v   # 停掉所有容器，并删除数据库卷
```

要一个没有演示数据的空站点：把 `.env` 里的 `DEMO_SEED` 改回 `false`，再 `docker compose up -d --build`。演示数据也不会往已经有别的用户或真实文章、但还没有演示账号的数据库里写，除非加 `--force`（`docker compose exec api npm run demo:seed -- --force`）。

## 卡住了

| 症状 | 原因 | 处理 |
|---|---|---|
| `required variable POSTGRES_PASSWORD is missing a value` | 还没生成 `.env`，或者不在 `topka` 目录里 | 回到第 1 步跑 `init-env` |
| `Bind for …:3000 failed: port is already allocated` | 本机别的程序在用 3000 | `.env` 里改成 `PORT=127.0.0.1:3300`，`docker compose up -d`，打开 3300 |
| `curl` 健康检查是 200，浏览器里却不是 Topka | 问到了占着那个端口的别的服务 | 用第 2 步的 `curl -s "http://$(docker compose port web 3000)/api/health"` |
| `permission denied while trying to connect to the Docker daemon socket` | 当前用户没有 Docker 权限 | 把用户加进 `docker` 组后重新登录，或者每条 `docker` 命令前加 `sudo` |
| `logs setup` 里没有 `demo:` 那几行 | `.env` 里不是 `DEMO_SEED=true` | `docker compose exec api npm run demo:seed` |
| 演示密码找不到了 | 密码只在第一次创建账号时打印 | 用 `DEMO_PASSWORD` 重设，见第 3 步（别漏了 `docker compose up -d`） |
| 「新建项目」里方向包写着「暂不可用」 | 包里的信源还没导入（旧库升级后没重启），或所选地区没有 | 页面上写了原因和命令 |
| 「对话」输入框是灰的 | 没接模型，`.env` 里也不是 `DEMO_SEED=true` | 页面上有文档链接；见第三部分 |
| 打开信源几分钟了，`/admin/sources` 里还是 0 条 | `COLLECT_ENABLED` 没改成 `true`，或者改完没重启；也可能是网络到不了海外 | 检查 `.env` 后再 `docker compose up -d`；国内网络见 [self-hosting.md](self-hosting.md#note-on-deployment-in-mainland-china) |

其他问题见 [self-hosting.md#troubleshooting](self-hosting.md#troubleshooting)。
