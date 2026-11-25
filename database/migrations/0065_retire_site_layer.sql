-- Retire the inherited public site layer. The product publishes one way: each reader's daily issue
-- (user_issues, user_issue_items) built from publications. The public timeline, hot list, daily /
-- weekly / monthly reports, topics, the model leaderboard, the reset monitor, site translations, the
-- public API / MCP / RSS search index, the selected-item sync ledger and the content-group pushes are
-- gone from the code; this drops what only they wrote or read.
--
-- Kept: publications (the issue pool and its release gate), stories / facts / story_signals (grouping
-- and independence), stored_files, and every user_* and project_* table.

DROP TABLE IF EXISTS report_revisions;
DROP TABLE IF EXISTS reports;

DROP TABLE IF EXISTS hot_rankings;
DROP TABLE IF EXISTS story_heat_hourly;
DROP TABLE IF EXISTS story_digests;
DROP TABLE IF EXISTS story_links;
DROP TABLE IF EXISTS story_aliases;
DROP TABLE IF EXISTS topics;

DROP TABLE IF EXISTS pool_search;
DROP TABLE IF EXISTS selected_ledger;
DROP TABLE IF EXISTS selected_state;

DROP TABLE IF EXISTS delivery_leases;
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS notify_targets;

DROP TABLE IF EXISTS lb_scores;
DROP TABLE IF EXISTS lb_rankings;
DROP TABLE IF EXISTS lb_prices;
DROP TABLE IF EXISTS lb_aliases;
DROP TABLE IF EXISTS lb_snapshots;
DROP TABLE IF EXISTS lb_runs;
DROP TABLE IF EXISTS lb_models;
DROP TABLE IF EXISTS fx_rates;

DROP TABLE IF EXISTS monitor_event_posts;
DROP TABLE IF EXISTS monitor_events;
DROP TABLE IF EXISTS monitor_posts;
DROP TABLE IF EXISTS monitor_state;

DROP TABLE IF EXISTS quote_translations;
DROP TABLE IF EXISTS translation_attempts;
DROP TABLE IF EXISTS translations;

-- Search, sitemap and IndexNow bookkeeping on the pool, the public timeline's sort key, and the
-- full-text RSS whitelist.
ALTER TABLE publications
  DROP COLUMN IF EXISTS syndicate,
  DROP COLUMN IF EXISTS indexable,
  DROP COLUMN IF EXISTS seo_indexed_at,
  DROP COLUMN IF EXISTS seo_excluded_at,
  DROP COLUMN IF EXISTS search_text,
  DROP COLUMN IF EXISTS sort_at;

ALTER TABLE sources DROP COLUMN IF EXISTS syndicate_fulltext;

-- Story digests were written for the event pages.
ALTER TABLE stories
  DROP COLUMN IF EXISTS digest,
  DROP COLUMN IF EXISTS digest_updated_at;

-- Settings rows only the retired modules read.
DELETE FROM settings WHERE key IN ('leaderboard.fetch', 'leaderboard.last_check', 'indexnow.watermark', 'selected_ledger_epoch');
