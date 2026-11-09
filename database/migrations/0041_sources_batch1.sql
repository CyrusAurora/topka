-- 0041: 采集接入第一批（specs/018 设计书 3.6，施工顺序第 4 步）
-- 数据来源：database/seeds/sources-batch-1.json（旧采集管道 2026-09-30 提取的纯数据）。
-- rss 69 个核心源（editorial/T2）、directory 257 个订阅目录源（hot_signal，只作热度证据）、
-- weibo 11 个源（经 compose 内 RSSHub 容器的内网地址，editorial/T2）。
-- 按 config->>'feedUrl' 去重：不覆盖 0040 的策展包占位行，重复执行幂等。

WITH seed AS (SELECT {{seed:sources-batch-1.json}}::jsonb AS doc),
families AS (
  SELECT 'rss'::text AS family, value FROM seed, jsonb_array_elements(doc->'families'->'rss') AS value
  UNION ALL
  SELECT 'directory'::text AS family, value FROM seed, jsonb_array_elements(doc->'families'->'directory') AS value
  UNION ALL
  SELECT 'weibo'::text AS family, value FROM seed, jsonb_array_elements(doc->'families'->'weibo') AS value
),
candidate AS (
  SELECT
    family,
    value->>'name' AS name,
    'rss'::text AS kind,
    (value->'config') AS config,
    (value->'config')->>'feedUrl' AS feed_url,
    COALESCE(value->>'tier', 'T2') AS tier,
    CASE WHEN family = 'directory' THEN 'hot_signal' ELSE 'editorial' END AS participation_mode,
    CASE WHEN family = 'directory' THEN 60 ELSE 30 END AS interval_minutes,
    'rss:' || md5(value->>'name' || '|' || ((value->'config')->>'feedUrl')) AS id
  FROM families
)
INSERT INTO sources (id, name, kind, config, tags, tier, participation_mode, interval_minutes, enabled, imported_from)
SELECT
  c.id,
  c.name,
  c.kind,
  c.config,
  ARRAY['batch-1', c.family] || CASE WHEN c.family = 'weibo' THEN ARRAY['needs-rsshub'] ELSE ARRAY[]::text[] END,
  c.tier,
  c.participation_mode,
  c.interval_minutes,
  true,
  'batch-1'
FROM candidate c
WHERE NOT EXISTS (
  SELECT 1 FROM sources s
  WHERE s.kind = 'rss' AND s.config->>'feedUrl' = c.feed_url
)
ON CONFLICT (id) DO NOTHING;
