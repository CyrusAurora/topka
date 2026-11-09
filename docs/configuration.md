# Configuration

Every setting is an environment variable read by the backend, the web server, a script or the
industry pack. `.env.example` has the same variables with safe defaults; `node scripts/init-env.ts`
copies it and fills the random secrets. Variables marked **required** must be set in production
(the server refuses to start without the critical ones). Secrets are never exposed to the browser.

`TOPKA_*` variables also accept the upstream `AIHOT_*` name (for example `TOPKA_DATA_DIR`) as a
deprecated fallback; the process logs a one-time warning when it uses one.

## Required

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `SITE_URL` | `http://localhost:3000` | Yes in production | Public site address used for links, RSS, share images and MCP. |
| `ADMIN_PASSWORD` | empty | Yes in production | Admin password for `/admin`, at least 12 characters. |
| `SESSION_SECRET` | empty | Yes | Secret that signs sessions (`openssl rand -hex 32`). |
| `IMG_PROXY_SIGN_SECRET` | empty | Yes | Secret that signs proxied image URLs (`openssl rand -hex 32`). |
| `POSTGRES_PASSWORD` | empty | With Docker Compose | Database password for the bundled PostgreSQL. |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | No | Base URL of any OpenAI-compatible chat API. |
| `LLM_API_KEY` | empty | Yes for model work | Key for that API. |
| `LLM_MODEL` | `deepseek-flash` | No | Model used by every step unless a preset is selected. |
| `LLM_EXTRA_JSON` | empty | No | Provider-specific request fields as a JSON object. |

## Site and network

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `SITE_DOMAIN` | `localhost` | No | HTTPS domain for the `https` compose profile. |
| `API_HOST` | `127.0.0.1` | No | API listen host; compose sets `0.0.0.0`. |
| `API_PORT` | `3001` | No | API listen port. |
| `WEB_HOST` | `127.0.0.1` | No | Web server listen host; compose sets `0.0.0.0`. |
| `WEB_PORT` | `3000` | No | Web server listen port. |
| `PORT` | `127.0.0.1:3000` (compose), `3000` (without Docker) | No | With docker compose: the host address the web container is published on; the default is this machine only, `PORT=3000` opens every interface. Without Docker: fallback web port when `WEB_PORT` is unset. |
| `API_BASE_URL` | `http://127.0.0.1:3001` | No | Where the web server reaches the API. |
| `LOCAL_ROUTER_URL` | `http://127.0.0.1:3000` | No | Where local image rendering reaches the web server. |
| `TRUST_PROXY` | `false` | No | Read the client address from `X-Forwarded-For` behind a reverse proxy. |
| `MCP_ALLOWED_HOSTS` | empty | No | Extra comma-separated Host values accepted by MCP. |
| `LOG_LEVEL` | `info` | No | Log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`). |
| `TOPKA_RELEASE` | `dev` | No | Release label shown in health output and heartbeats. |

## Database and storage

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | `postgres://127.0.0.1:5432/topka` | No | PostgreSQL connection string (`postgres://user:password@host:5432/db`). |
| `DATABASE_POOL_MAX` | `10` | No | Maximum pooled connections. |
| `TOPKA_DATA_DIR` | `.data` | No | Directory for assets and exported snapshots (`today:export` writes to `<dir>/snapshots` by default). Docker sets it to `/data`. |
| `TOPKA_CREDENTIALS_DIR` | empty | No | Optional directory of per-group dotenv files (`models.env`, `collectors.env`, `integrations.env`, `auth.env`). |

## Models

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `LLM_VISION` | `false` | No | Let selected-item prompts see the first image. |
| `LLM_JSON_MODE` | `true` | No | Send `response_format=json_object`; set `false` when unsupported. |
| `LLM_APP_URL` | `SITE_URL` | No | OpenRouter app-attribution URL. |
| `LLM_APP_TITLE` | `Topka` | No | OpenRouter app-attribution title. |
| `LLM_PROVIDER_ORDER` | `opencode,agnes,openrouter` | No | Free background chain order; each provider joins only when configured. |
| `LLM_FREE_MODELS` | empty | No | Comma-separated OpenRouter `:free` candidates checked for zero price before use. |
| `LLM_FREE_CATALOG_URL` | OpenRouter `/models` | No | Override the price catalog URL. |
| `LLM_FREE_QUOTA_URL` | OpenRouter `/key` | No | Override the free-quota endpoint. |
| `LLM_FREE_DAILY_RESERVE` | `20` | No | Calls kept back from background work each UTC day. |
| `LLM_INTERACTIVE_RESERVE` | `30` | No | Calls kept for interactive chat each UTC day. |
| `OPENCODE_API_KEY` | empty | No | OpenCode Zen key (free-list models only). |
| `OPENCODE_BASE_URL` | `https://opencode.ai/inference/openai/v1` | No | OpenCode base URL. |
| `OPENCODE_TRANSPORT` | empty | No | `cli`: each call runs the official `opencode run` (free models refuse the raw API and tool-less sessions); bash/edit/web/task tools are denied, the text goes on stdin. |
| `OPENCODE_BIN` | `opencode` | No | Path of the OpenCode CLI for `OPENCODE_TRANSPORT=cli`. |
| `OPENCODE_ALLOW` | empty | No | Exact model ids the opencode provider may use (narrows the free stock). |
| `OPENCODE_CLI_CONCURRENCY` / `OPENCODE_CLI_TIMEOUT_MS` | `2` / `45000` | No | Parallel CLI calls and the per-call kill timeout. |
| `OPENCODE_CLI_REST_SECONDS` | `600` | No | How long the CLI route sits out after a free-tier stop (429). |
| `OPENCODE_CLI_HOME` | `<DATA_DIR>/opencode` | No | Home directory the CLI runs with (its session store and logs live there). |
| `OPENCODE_CLI_PRUNE_HOURS` | `6` | No | How often the CLI's own session store and day-old logs under its home are removed (between calls). |
| `OPENCODE_EXTRA_JSON` | empty | No | Extra OpenCode request fields. |
| `OPENCODE_FREE_ORDER` | `deepseek,glm,mimo,minimax,beam,longcat` | No | Preference order within the free list. |
| `OPENCODE_MODELS_URL` | `https://opencode.ai/zen/v1/models` | No | Live free-model list. |
| `OPENCODE_DOCS_URL` | OpenCode console docs URL | No | Docs page that names free models. |
| `MODELS_DEV_URL` | `https://models.dev/api.json` | No | Price catalog used to verify zero cost. |
| `AGNES_API_KEY` | empty | No | Agnes key. |
| `AGNES_BASE_URL` | `https://apihub.agnes-ai.com/v1` | No | Agnes base URL. |
| `AGNES_MODEL` | `agnes-3.0-flash` | No | Agnes model. |
| `AGNES_EXTRA_JSON` | `{"chat_template_kwargs":{"enable_thinking":false}}` | No | Agnes request fields (reasoning off by default). |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | No | DeepSeek preset base URL. |
| `DEEPSEEK_API_KEY` | empty | No | DeepSeek preset key. |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | No | DashScope preset base URL. |
| `DASHSCOPE_API_KEY` | empty | No | DashScope preset key (also enables `text-embedding-v4`). |
| `ZHIPU_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | No | Zhipu preset base URL. |
| `ZHIPU_API_KEY` | empty | No | Zhipu preset key. |
| `XIAOMI_MIMO_BASE_URL` | `https://api.xiaomimimo.com/v1` | No | Xiaomi MiMo preset base URL. |
| `XIAOMI_MIMO_API_KEY` | empty | No | Xiaomi MiMo preset key. |
| `PREFILTER_MODEL` | `default` | No | Preset for the selection prefilter. |
| `SCORE_MODEL` | `default` | No | Preset for selection scoring. |
| `UNDERSTAND_MODEL` | `default` | No | Preset for content understanding. |
| `SUMMARIZE_MODEL` | `default` | No | Preset for non-selected title/summary. |
| `STRUCTURE_MODEL` | `default` | No | Preset for structure extraction. |
| `GROUP_MODEL` | `default` | No | Preset for event grouping. |
| `GROUP_REVIEW_MODEL` | `default` | No | Preset for grouping review. |
| `DIGEST_MODEL` | `default` | No | Preset for event digests. |
| `REPORT_MODEL` | `default` | No | Preset for daily/weekly/monthly reports. |
| `TRANSLATE_MODEL` | `default` | No | Preset for full-text translation. |
| `CARD_MODEL` | `default` | No | Preset for today-card copy. |
| `ASSISTANT_MODEL` | `default` | No | Preset for the project assistant. |
| `MONITOR_MODEL` | `default` | No | Preset for reset-announcement recognition. |

Named presets bypass the free guard and are billed by their provider.

## Embeddings

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | No | OpenAI-compatible `/embeddings` endpoint. |
| `EMBEDDING_API_KEY` | empty | No | Key for that endpoint. |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | No | Embedding model. |
| `EMBEDDING_DIMS` | `0` | No | Vector dimensions; `0` lets the provider decide. |
| `EMBEDDING_FREE_MODELS` | empty | No | Comma-separated free SiliconFlow candidates. |
| `EMBEDDING_FREE_DIMS` | `1024` | No | Shared dimension of the free candidates. |
| `EMBEDDING_FREE_PRICING_URL` | `https://siliconflow.cn/pricing` | No | Price page checked before using free candidates. |
| `EMBEDDINGS_ENABLED` | `true` | No | Set `false` to disable embeddings even with a key. |

## Collection and processing

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `COLLECT_ENABLED` | `false` | No | Safety valve for all source collection. |
| `MODEL_CALLS_ENABLED` | `false` | No | Safety valve for all model calls. |
| `DEMO_SEED` | `false` | No | Docker Compose only: `true` makes the `setup` service load the offline demo (`scripts/demo.ts`) after migrate and seed. See [the tutorial](tutorial.en.md). |
| `DEMO_PASSWORD` | random | No | Password for the demo reader `demo@example.com`; unset means a random one printed once. |
| `COLLECT_KINDS` | `rss,web_list,json_list,x_search` | No | Source kinds the scheduler fetches. |
| `COLLECT_SKIP_JINA` | `false` | No | Skip the Jina Reader fallback. |
| `JINA_BODY_FALLBACK` | `true` | No | Use Jina Reader when a page has no extractable body. |
| `FETCH_CONCURRENCY` | `8` | No | Concurrent source fetches. |
| `FETCH_SCHEDULE_BATCH` | `40` | No | Sources scheduled per tick. |
| `ANALYZE_CONCURRENCY` | `6` | No | Concurrent analysis jobs. |
| `SEARCH_MAX_CONCURRENCY` | `4` | No | Concurrent publication searches. |
| `SEARCH_MAX_QUEUE` | `8` | No | Queued publication searches. |
| `SELECTED_VISIBLE_AFTER_SECONDS` | `180` | No | Delay before a selected item becomes visible. |
| `ALERT_QUIET_MINUTES` | `360` | No | Alert when no new content arrived for this long. |

## History analysis

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `HISTORY_ANALYSIS` | `defer` | No | `defer`, `skip` or `on` for backfill older than 24 hours. |
| `HISTORY_ANALYSIS_WINDOW` | `20-8` | No | Evening window (hours) in `HISTORY_ANALYSIS_TZ`. |
| `HISTORY_ANALYSIS_TZ` | `Asia/Shanghai` | No | Time zone of that window (UTC+8). |
| `HISTORY_ANALYSIS_RESERVE` | `150` | No | Model calls kept for fresh items before history runs. |
| `STALE_ANALYSIS_HOURS` | `72` | No | Items published longer ago than this when their turn comes are skipped without a model call (`0` = off). |

## Today view

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `TODAY_CARD_COUNT` | `3` | No | Cards per project (3–5), one per event. |
| `ISSUE_HERO_LEAD` | `10` | No | Lead the first of three cards needs for the hero layout. |
| `ASSISTANT_DAILY_TURNS` | `40` | No | Chat turns per user per UTC day. |
| `CHAT_PER_MINUTE` | `8` | No | Chat messages per user per minute (429 beyond; `0` turns the burst guard off). |

## Paid collectors

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `SOCIALDATA_API_KEY` | empty | No | SocialData key for X/Twitter sources. |
| `SOCIALDATA_BASE_URL` | `https://api.socialdata.tools` | No | SocialData base URL. |
| `DAJIALA_KEY` | empty | No | Dajiala key for WeChat official-account sources. |
| `DAJIALA_BASE_URL` | `https://www.dajiala.com` | No | Dajiala base URL. |
| `JINA_API_KEY` | empty | No | Jina Reader key. |
| `JINA_BASE_URL` | `https://r.jina.ai` | No | Jina Reader base URL. |
| `GITHUB_TOKEN` | empty | No | Read-only token raising the GitHub API quota. |
| `ARTIFICIAL_ANALYSIS_API_KEY` | empty | No | Artificial Analysis leaderboard key. |
| `EGRESS_PROXY_URL` | empty | No | Proxy for fetching overseas sources. |

## Feishu notifications

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `FEISHU_CONTENT_PUSH_ENABLED` | `false` | No | Push selected content to configured group webhooks. |
| `FEISHU_PUSH_WEBHOOK_URL` | empty | No | Main content group webhook. |
| `FEISHU_PUSH_MIRROR_WEBHOOK_URL` | empty | No | Mirror content group webhook. |
| `FEISHU_INTERNAL_ENABLED` | `false` | No | Send alerts and forward feedback to Feishu. |
| `FEISHU_APP_ID` | empty | No | Feishu app id. |
| `FEISHU_APP_SECRET` | empty | No | Feishu app secret. |
| `FEISHU_INTERNAL_CHAT_ID` | empty | No | Internal chat for feedback. |
| `FEISHU_ALERT_CHAT_ID` | empty | No | Chat for operations alerts. |
| `FEISHU_LOGIN_APP_ID` | empty | No | Feishu app id for admin sign-in. |
| `FEISHU_LOGIN_APP_SECRET` | empty | No | Feishu app secret for admin sign-in. |
| `ADMIN_FEISHU_UNION_IDS` | empty | No | Comma-separated Feishu union ids that are admins. |
| `ADMIN_EMAILS` | empty | No | Comma-separated admin email addresses. |

## Security and operations

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `REGISTRATION_MODE` | `open` | No | `open`: anyone may register (no invite); `invite`: an invite code is required. Any other value counts as `invite`. |
| `REGISTRATION_HOURLY_LIMIT` | `30` | No | Successful registrations per hour for the whole instance; each client is also capped at 5 attempts per hour. |
| `BYOK_ALLOW_PRIVATE_BASE_URL` | `false` | No | Development only: lets a reader's model Base URL be `http://` or a loopback/private address (the SSRF guard otherwise refuses it). Production refuses to start with it set. |
| `KEY_ENCRYPTION_SECRET` | generated by `init-env` | Yes, for BYOK | Encrypts users' own model keys (AES-256-GCM); 32+ random characters. `scripts/init-env.ts` generates it; by hand: `openssl rand -hex 32`. Empty turns BYOK off (saving a key answers 503). Changing it makes stored keys unreadable. |
| `INGEST_TOKEN` | empty | No | Token for `POST /api/ingest/items` (16+ characters); empty closes the endpoint. |
| `IMG_PROXY_REQUIRE_SIG` | `true` | No | Require a signature on proxied images. |
| `INDEXNOW_SUBMIT_ENABLED` | `false` | No | Submit new pages to IndexNow daily. |
| `INDEXNOW_KEY` | empty | No | IndexNow key (32 hex characters). |
| `SESSION_COOKIE_NAME` | `topka_session` | No | Name of the reader session cookie; set it to keep an existing deployment's cookie when upgrading. |
| `DB_BACKUP_STORE_SECRET_ID` | empty | No | S3-compatible backup secret id. |
| `DB_BACKUP_STORE_SECRET_KEY` | empty | No | S3-compatible backup secret key. |
| `DB_BACKUP_STORE_BUCKET` | empty | No | Backup bucket. |
| `DB_BACKUP_STORE_REGION` | empty | No | Backup region. |
| `DB_BACKUP_STORE_DOMAIN` | empty | No | Custom S3 endpoint domain. |

## Plugins

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `TOPKA_PLUGINS` | empty | No | Comma-separated module paths (relative to the working directory or absolute) loaded at startup. See [plugins.md](plugins.md). |

## Development and tests only

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `DEV_AUTH_ROLE` | empty | No | `admin` bypasses login in development; production refuses to start with any `DEV_AUTH_*`. |
| `DEV_AUTH_DISPLAY_NAME` | `Dev Admin` | No | Display name for the development admin. |
| `ALLOW_PRIVATE_NETWORK_FETCH` | `false` | No | Allow fetches to private network addresses; tests only. |
| `NODE_ENV` | `development` | No | `production` enables production checks. |
| `TOPKA_ENVIRONMENT` | `production`/`development` | No | Deployment name used in alerts. |
| `TOPKA_CHANGELOG_FILE` | `industry/changelog.json` | No | Changelog JSON used by the about page. |
| `SHOW` | `12` | No | Rows compared by `scripts/lb-fetch-check.ts`. |
