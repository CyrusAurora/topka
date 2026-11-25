-- Per-user IANA timezone for the daily issue (0004-globalization-v1, items A-C): each user's 今日
-- is fixed at 08:00 local in their own zone. `user_issues.issue_date` is the calendar date in that
-- user's timezone at fix time; historical rows are never rewritten when the timezone changes.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Shanghai';
