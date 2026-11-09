<div align="center">

**简体中文** · [English](README.en.md)

# Topka

<img src="docs/assets/screenshot-today.png" alt="Topka 今日页：No. 003，三张【示例】卡片" width="100%">

> *「只告诉你变了什么。证据不够，就直说不够。」*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.1-blue)](CHANGELOG.md)
[![Self-hosted](https://img.shields.io/badge/self--hosted-Docker%20Compose-2496ED?logo=docker&logoColor=white)](#先跑起来不要-api-key)
[![BYOK](https://img.shields.io/badge/BYOK-%E8%87%AA%E5%B8%A6%E6%A8%A1%E5%9E%8B%20Key-6f42c1)](#接上真实信源和模型)

**自己部署的情报工作台：说清楚要盯什么，每天从你指定的信源里挑出最值得看的几条，每条能点回原文。**

```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:24-trixie-slim node scripts/init-env.ts
DEMO_SEED=true docker compose up -d --build
```

<sub>三条命令，登录后就是上面那张图。用自带的虚构演示数据，不需要 API key，不抓站，不调模型。</sub>

[看效果](#看效果) · [先跑起来](#先跑起来不要-api-key) · [接上真实信源和模型](#接上真实信源和模型) · [它怎么工作](#它怎么工作) · [诚实边界](#诚实边界) · [排错](#排错)

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

**需要：** Docker Compose v2（`docker compose version` 能出版本号）、`git`、约 3 GB 磁盘、本机 3000 端口空闲。2 核 4 GB 够。不需要 Node、PostgreSQL、API key、GPU。端口被占时，命令前加 `PORT=127.0.0.1:3300`。默认只在本机可访问；给外机用见 [HTTPS](docs/self-hosting.md#https-caddy-profile)。

**1. 克隆并生成 `.env`**

```bash
git clone https://github.com/CyrusAurora/topka.git && cd topka
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/app" -w /app node:24-trixie-slim node scripts/init-env.ts
```

会打印管理员密码，以及一句「还差一步：填 LLM_API_KEY」——演示先不用管。

**2. 带着演示数据启动**

```bash
DEMO_SEED=true docker compose up -d --build
```

首次构建大约 5–15 分钟。会起数据库、跑迁移、写入演示读者、项目「人形机器人量产（示例）」和三天虚构卡片。

**3. 取演示密码并登录**

```bash
docker compose logs setup | grep demo:
```

```text
setup-1  | demo: ready. Log in at /login as demo@example.com
setup-1  | demo: password demo-1be4ef872d6d  (shown once; set DEMO_PASSWORD and re-run to reset it)
```

密码只出现一次。打开 <http://localhost:3000/login>，用 `demo@example.com` 登录。

**看到这些就成了**

- 「今日」是 **No. 003**，三张【示例】卡片，和页顶截图一样
- 点标题展开摘要；「往期」有前两天
- 后台 <http://localhost:3000/admin>，密码是 `.env` 的 `ADMIN_PASSWORD`

不行就看[排错](#排错)。要抓真实文章但仍不调模型： [教程第二部分](docs/tutorial.md#第二部分接两个真实信源仍然不用模型-key)。

```bash
docker compose down -v   # 不玩了，连库一起清
```

---

## 接上真实信源和模型

演示数据不会自己变。每天出新一期需要：**打开信源** + **接上模型**。两者默认关着。

**信源。** 仓库约 400 个信源，启动时导入但全关。在 `/admin/sources` 打开，或：

```bash
docker compose exec api npm run sources:only -- --id rss-hugging-face --id rss-github-ai
```

**模型。** 任意 OpenAI 兼容接口。在 `.env` 填：

```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-flash
```

只要免费模型：接 OpenRouter，在 `LLM_FREE_MODELS` 列带 `:free` 的模型；报价非 0 的不用，全都不可用就停，不会偷偷换成收费模型。见 [model connection](docs/self-hosting.md#model-connection)。

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
按项目相关度挑选 → 每天 08:00 UTC+8 定稿一期（默认最多 3 张，同信源最多 2 张）
   │
   ▼
网站「今日 / 往期」· RSS · /api/v1 · MCP · llms.txt
```

- 六种信源进同一条流水线
- 预筛 / 打分 / 文风写在 `industry/` 的提示词里，可按行业改
- 多一个追踪项目不会让每篇文章多调一次模型
- 换行业只改 `industry/`（站名、分类、信源、提示词、门槛、品牌、条款），默认是 AI 行业 → [docs/customize.md](docs/customize.md)

架构图： [docs/architecture.md](docs/architecture.md)。

---

## 诚实边界

- 界面和生成内容以中文为主，还没做多语言
- 默认不转载全文，只放摘要和原文链接（个别源可开 `site_fulltext`）
- 单机 + PostgreSQL，没有多节点
- 卡片质量取决于你接的模型和信源；演示是手写的，真实摘要可能出错，所以页顶写着「AI 生成摘要，以原文为准」
- 定稿固定 08:00 UTC+8；当天不够格就空一期，过后不补
- 目前一位维护者，尽力而为，无 SLA → [SUPPORT.md](SUPPORT.md)；漏洞报告 → [SECURITY.md](SECURITY.md)

---

## 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| `required variable POSTGRES_PASSWORD is missing a value` | 还没生成 `.env` | 先跑第 1 步的 `init-env` |
| `Bind for …:3000 failed: port is already allocated` | 3000 被占 | 命令前加 `PORT=127.0.0.1:3300` |
| `logs setup` 里没有 `demo:` | 启动时没带 `DEMO_SEED=true` | `docker compose exec api npm run demo:seed` |
| 演示密码丢了 | 只打印一次；改 `.env` 再重启会清掉 setup 日志 | `.env` 加 `DEMO_PASSWORD=至少10个字符`，再跑 `demo:seed` |
| `demo:seed` 拒绝运行 | 库里已有别的用户或真实文章 | 确定要掺就加 `-- --force`，或 `docker compose down -v` 重来 |
| 容器里 `npm run` 先打出 `.env not found` | 容器读 Compose 环境，不读文件 | 正常，忽略 |
| 开了信源，几分钟还没新文章 | `COLLECT_ENABLED=false`，或改完没重启 | 改成 `true`，`docker compose up -d`；失败原因在 `/admin/sources` |
| 有文章但没有新卡片 | 模型没接上或 `MODEL_CALLS_ENABLED=false` | 见[接上真实信源和模型](#接上真实信源和模型)；日志搜 `is not configured` |

更多（`NO_FREE_MODEL`、国内连海外信源等）： [troubleshooting](docs/self-hosting.md#troubleshooting)。

---

## 文档与贡献

教程：[docs/tutorial.md](docs/tutorial.md)（[English](docs/tutorial.en.md)）。索引：[docs/README.md](docs/README.md)。常看：[自部署](docs/self-hosting.md) · [配置](docs/configuration.md) · [架构](docs/architecture.md) · [换行业](docs/customize.md) · [信源](docs/sources.md) · [精选](docs/selection.md) · [插件](docs/plugins.md)。除教程和本页外，文档目前是英文。

开发约定：[CONTRIBUTING.md](CONTRIBUTING.md)。行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。另有 [GOVERNANCE.md](GOVERNANCE.md)、[MAINTAINERS.md](MAINTAINERS.md)、[SUPPORT.md](SUPPORT.md)、[TRADEMARK.md](TRADEMARK.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。感谢 [AIHOT](https://github.com/KKKKhazix/AIHOT)。第三方声明见 [NOTICE](NOTICE)。
