<div align="center">

**简体中文** · [English](README.en.md)

# Topka

<img src="docs/assets/screenshot-today.png" alt="Topka 今日页：No. 003，三张【示例】卡片" width="100%">

> *「只告诉你变了什么。不够格就少发或空一期，宁少不凑。」*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-blue)](CHANGELOG.md)
[![Self-hosted](https://img.shields.io/badge/self--hosted-Docker%20Compose-2496ED?logo=docker&logoColor=white)](#先跑起来不要-api-key)
[![BYOK](https://img.shields.io/badge/BYOK-%E8%87%AA%E5%B8%A6%E6%A8%A1%E5%9E%8B%20Key-6f42c1)](#接上真实信源和模型)

**自己部署的情报工作台：说清楚要盯什么，每天从你指定的信源里挑出最值得看的几条，每条能点回原文。**

**[在线体验 →](https://cyrusaurora.github.io/topka/)** 不用安装：看一个真实运行的 Topka 每天定稿的 3 条和往期；对话和建项目由浏览器里的演示模型回答。（[怎么做的](docs/online-demo.md)）

<!-- doc-test: run quickstart; timeout 1800 -->
```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:26-trixie-slim node scripts/init-env.ts --demo
docker compose up -d --build
```

<sub>三条命令装好，再用 `docker compose logs setup | grep demo:` 取演示密码，登录后就是上面那张图。用自带的虚构演示数据和内置演示模型，不需要 API key，不抓站，不花钱。</sub>

[在线体验](https://cyrusaurora.github.io/topka/) · [看效果](#看效果) · [先跑起来](#先跑起来不要-api-key) · [接上真实信源和模型](#接上真实信源和模型) · [它怎么工作](#它怎么工作) · [诚实边界](#诚实边界) · [排错](#排错)

</div>

---

## 看效果

点开一张卡片：AI 摘要、出处、复制原文链接。

<img src="docs/assets/screenshot-demo-today.png" alt="卡片展开：摘要、出处、复制原文链接" width="100%">

「往期」按天保留每一期：

<img src="docs/assets/screenshot-archive.png" alt="往期：No.002 与 No.001" width="100%">

<sub>截图来自当前版本 + 仓库自带演示数据（标题都以【示例】开头）。照着 [教程](docs/tutorial.md) 跑，你会看到同样的三张图，日期换成你运行的那天。</sub>

---

## 先跑起来（不要 API key）

**需要：** Docker Compose v2（`docker compose version` 能出版本号）、`git`、约 3 GB 磁盘。2 核 4 GB 够。不需要 Node、PostgreSQL、API key、GPU。默认用本机 3000 端口，只在本机可访问；给外机用见 [HTTPS](docs/self-hosting.md#https-caddy-profile)。

**端口只在一处设置：** `.env` 里的 `PORT`。3000 被占，就在第 1 步的 `init-env.ts` 后面加 `--port 127.0.0.1:3300`（已经生成过 `.env` 就直接改 `PORT=` 那一行）。之后每次 `docker compose up` 都用它，站内链接、RSS、订阅地址也跟着走，不用再改别处。

**1. 克隆并生成 `.env`**

<!-- doc-test: skip the quick start block above runs these same commands -->
```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:26-trixie-slim node scripts/init-env.ts --demo
```

会打印网站地址和管理员密码。`--demo` 在 `.env` 里写上 `DEMO_SEED=true`：启动时写入演示数据，没接模型时「对话」由内置演示模型回答。提示 `LLM_API_KEY 还空着` 演示先不用管。再跑一次不会覆盖已有的 `.env`（密码和密钥不变）。

**2. 启动**

<!-- doc-test: skip the quick start block above runs these same commands -->
```bash
docker compose up -d --build
```

首次构建视网速从半分钟到十几分钟。会起数据库、跑迁移、导入信源和四个项目方向包（都关着）、写入演示读者、项目「人形机器人量产（示例）」和三天虚构卡片。

确认起来了（问的是这个 stack 自己的端口，换了 `PORT` 也对；刚启动可能要等几秒）：

<!-- doc-test: run quickstart; retry 180; expect "ok":true -->
```bash
curl -s "http://$(docker compose port web 3000)/api/health"   # {"app":"topka",…,"ok":true,"db":"ok",…}
```

**3. 取演示密码并登录**

<!-- doc-test: run quickstart; retry 180; expect demo: ready -->
```bash
docker compose logs setup | grep demo:
```

```text
setup-1  | demo: ready. Log in at /login as demo@example.com
setup-1  | demo: password demo-1be4ef872d6d  (shown once; to reset it: add DEMO_PASSWORD=<10+ characters> to .env, run `docker compose up -d`, then `docker compose exec api npm run demo:seed`)
```

密码只出现一次。打开 <http://localhost:3000/login>（换了端口就用 init-env 打印的地址），用 `demo@example.com` 登录。

**看到这些就成了**

- 「今日」是 **No. 003**，三张【示例】卡片，和页顶截图一样
- 点标题展开摘要；「往期」有前两天
- 「对话」能聊：顶部写着「演示模型」，按固定规则问两三个问题，出一张跟踪卡片，确认后建好项目
- 「设置 → 新建项目」四个方向包都能选
- 后台 `/admin`，密码是 `.env` 的 `ADMIN_PASSWORD`

不行就看[排错](#排错)。要抓真实文章但仍不调模型： [教程第二部分](docs/tutorial.md#第二部分接两个真实信源仍然不用模型-key)。

<!-- doc-test: run quickstart; defer -->
```bash
docker compose down -v   # 不玩了，连库一起清
```

---

## 接上真实信源和模型

演示数据不会自己变。每天出新一期需要：**打开信源** + **接上模型**。两者默认关着。

**信源。** 仓库自带三百多个信源（确切数字是 setup 日志里 `in the database` 前的那个数；后台的总数还会多出 `--demo` 的 3 个演示信源），装好时都在库里但全关（大部分来自迁移，所以日志里「added」的数目远小于总数）。在 `/admin/sources` 打开，或：

<!-- doc-test: run quickstart; expect 2 -->
```bash
docker compose exec api npm run sources:only -- --id rss-hugging-face --id rss-github-ai
```

**模型。** 任意 OpenAI 兼容接口。在 `.env` 填：

<!-- doc-test: skip lines for .env with placeholder values, not commands -->
```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-flash
```

不花钱的两条路（具体几行见 [Without a paid key](docs/self-hosting.md#without-a-paid-key)）：

- **本地 Ollama**：不用注册。`.env` 里 `COMPOSE_PROFILES=ollama`、`LLM_BASE_URL=http://ollama:11434/v1`、`LLM_API_KEY=ollama`、`LLM_MODEL=qwen2.5:7b`，再 `docker compose exec ollama ollama pull qwen2.5:7b`。要有 GPU 才好用：纯 CPU 时 7B 模型约一半回答格式不合要求，更小的基本用不起来（实测见链接）。
- **OpenRouter `:free` 模型**：免费账号的 Key，`LLM_FREE_MODELS` 列带 `:free` 的模型；报价非 0 的不用，全都不可用就停，不会偷偷换成收费模型。

<!-- doc-test: skip turns on collection and model calls, which reach outside services; CI makes no outside calls -->
```bash
sed -i 's/^COLLECT_ENABLED=false/COLLECT_ENABLED=true/; s/^MODEL_CALLS_ENABLED=false/MODEL_CALLS_ENABLED=true/' .env
docker compose up -d
```

上面是**实例 Key**（后台任务，费用在部署方）。注册读者可在「设置」填自己的 Key（BYOK），「对话」走他们的额度。付费调用有回执，并有每分钟 / 每小时 / 每天预算熔断。

完整部署： [docs/self-hosting.md](docs/self-hosting.md)。配置项： [docs/configuration.md](docs/configuration.md)。

---

## 它怎么工作

```
信源（RSS / 网页列表 / JSON / X / 公众号 / 推送）
   │  worker 定时采集、判重
   ▼
预筛 → 独立打两次分 → 写标题摘要 → 结构化抽取 → 合并成事件
   │                    （都在 worker 里；打开页面不触发模型）
   ▼
按项目相关度挑选 → 每天在读者时区的 08:00 定稿一期（默认最多 3 张，同信源最多 2 张）
   │
   ▼
网站「今日 / 往期」· RSS · /api/v1 · MCP · llms.txt
```

- 六种信源进同一条流水线
- 预筛 / 打分 / 文风写在 `industry/` 的提示词里，可按行业改
- 多一个追踪项目不会让每篇文章多调一次模型
- 信源带地区标签（`global` / `cn` / `us` / `eu` / `jp`），建项目时可以按地区筛
- 每位读者在「设置」里选界面语言（简体中文 / English）和时区（默认 Asia/Shanghai）；访客和后台的语言由 `SITE_LOCALE` 决定
- 换行业只改 `industry/`（站名、分类、信源、提示词、门槛、品牌、条款），默认是 AI 行业 → [docs/customize.md](docs/customize.md)

架构图： [docs/architecture.md](docs/architecture.md)。

---

## 诚实边界

- 界面有简体中文和英文；「对话」按读者的语言回答，读者自己今日卡片的文案也按读者语言写。公共内容池里的标题、摘要跟站点语言（`SITE_LOCALE`）走；信源名是原名（多为英文）
- 内置演示模型只是固定规则，不是真模型：用来走通「对话 → 卡片 → 建项目」，不分析文章
- 默认不转载全文，只放摘要和原文链接（个别源可开 `site_fulltext`）
- 单机 + PostgreSQL，没有多节点
- 卡片质量取决于你接的模型和信源；演示是手写的，真实摘要可能出错，所以页顶写着「AI 生成摘要，以原文为准」
- 每天在读者自己时区的 08:00 定稿；当天不够格就空一期，过后不补。worker 的采集和日报等定时任务统一按 Asia/Shanghai 跑
- 目前一位维护者，尽力而为，无 SLA → [SUPPORT.md](SUPPORT.md)；漏洞报告 → [SECURITY.md](SECURITY.md)

---

## 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| `required variable POSTGRES_PASSWORD is missing a value` | 还没生成 `.env` | 先跑第 1 步的 `init-env` |
| `Bind for …:3000 failed: port is already allocated` | 3000 被占 | `.env` 里改成 `PORT=127.0.0.1:3300`，再 `docker compose up -d` |
| `curl …/api/health` 有 200，页面却不是 Topka | 问到了占着那个端口的别的服务 | 用 `curl -s "http://$(docker compose port web 3000)/api/health"` |
| `logs setup` 里没有 `demo:` | `.env` 里不是 `DEMO_SEED=true` | 改成 `true` 再 `docker compose up -d`，或直接 `docker compose exec api npm run demo:seed` |
| 演示密码丢了 | 只打印一次；改 `.env` 再重启会清掉 setup 日志 | `.env` 加 `DEMO_PASSWORD=至少10个字符` → `docker compose up -d`（容器只在重建时读 `.env`）→ `docker compose exec api npm run demo:seed` |
| 「新建项目」里某个方向包「暂不可用」 | 旧库升级后还没重启，包里的信源没导入 | 页面上写了原因和命令：`docker compose exec api npm run sources:seed -- --pack <名字>` |
| 「对话」输入框是灰的 | 没接模型，也没开演示模型 | 页面上有文档链接；`.env` 设 `DEMO_SEED=true` 先体验，或接 Ollama / 免费模型 |
| `demo:seed` 拒绝运行 | 库里已有别的用户或真实文章 | 确定要掺就加 `-- --force`，或 `docker compose down -v` 重来 |
| 开了信源，几分钟还没新文章 | `COLLECT_ENABLED=false`，或改完没重启 | 改成 `true`，`docker compose up -d`；失败原因在 `/admin/sources` |
| `docker compose logs` 每行前面有 `ESC[2K` | Docker Compose 自己在非终端输出里留的清行控制符，不是 Topka 打的 | 不影响 grep。Compose 2.26 上 `--ansi never`、`--no-log-prefix` 都去不掉；要干净的文本直接读容器日志：`docker logs $(docker compose ps -aq setup)` |
| 有文章但没有新卡片 | 模型没接上或 `MODEL_CALLS_ENABLED=false` | 见[接上真实信源和模型](#接上真实信源和模型)；日志搜 `is not configured` |

更多（`NO_FREE_MODEL`、国内连海外信源等）： [troubleshooting](docs/self-hosting.md#troubleshooting)。

---

## 文档与贡献

教程：[docs/tutorial.md](docs/tutorial.md)（[English](docs/tutorial.en.md)）。索引：[docs/README.md](docs/README.md)。常看：[自部署](docs/self-hosting.md) · [配置](docs/configuration.md) · [架构](docs/architecture.md) · [换行业](docs/customize.md) · [信源](docs/sources.md) · [精选](docs/selection.md) · [插件](docs/plugins.md)。除教程和本页外，文档目前是英文。

开发约定：[CONTRIBUTING.md](CONTRIBUTING.md)。行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。另有 [GOVERNANCE.md](GOVERNANCE.md)、[MAINTAINERS.md](MAINTAINERS.md)、[SUPPORT.md](SUPPORT.md)、[TRADEMARK.md](TRADEMARK.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。感谢 [AIHOT](https://github.com/KKKKhazix/AIHOT)。第三方声明见 [NOTICE](NOTICE)。
