-- Two leftovers from the batch-1 seed (0041), which a first run shows in the admin as a nameless source:
--   * three rows were inserted with an empty name; the feeds say what they are, so fill the blank only —
--     a name an operator has edited (0041's ids are keyed on the empty name, and one row has been
--     renamed by hand since) is never overwritten;
--   * plink.anyfeeder.com answered 500 on http and only serves https, so the two feeds that still had an
--     http address are pointed at https. Skipped when another source already holds the https address.
-- Idempotent, and a no-op on a database where the operator has since tidied these rows.
-- The seed file itself is left as it was: 0041 derives each id from the name and the feed address, so
-- editing it would give a new install different ids from an existing one for the same feed.
UPDATE sources SET name = CASE config->>'feedUrl'
    WHEN 'https://draveness.me/feed.xml' THEN '面向信仰编程'
    WHEN 'http://plink.anyfeeder.com/weixin/almosthuman2014' THEN '机器之心'
    WHEN 'https://plink.anyfeeder.com/weixin/almosthuman2014' THEN '机器之心'
    WHEN 'http://plink.anyfeeder.com/weixin/The-Intellectual' THEN '知识分子'
    WHEN 'https://plink.anyfeeder.com/weixin/The-Intellectual' THEN '知识分子'
  END,
  updated_at = now()
WHERE trim(coalesce(name, '')) = ''
  AND config->>'feedUrl' IN (
    'https://draveness.me/feed.xml',
    'http://plink.anyfeeder.com/weixin/almosthuman2014',
    'https://plink.anyfeeder.com/weixin/almosthuman2014',
    'http://plink.anyfeeder.com/weixin/The-Intellectual',
    'https://plink.anyfeeder.com/weixin/The-Intellectual'
  );

UPDATE sources s
SET config = jsonb_set(s.config, '{feedUrl}', to_jsonb(replace(s.config->>'feedUrl', 'http://plink.anyfeeder.com/', 'https://plink.anyfeeder.com/'))),
    updated_at = now()
WHERE s.config->>'feedUrl' LIKE 'http://plink.anyfeeder.com/%'
  AND NOT EXISTS (
    SELECT 1 FROM sources o
    WHERE o.id <> s.id AND o.config->>'feedUrl' = replace(s.config->>'feedUrl', 'http://', 'https://')
  );
