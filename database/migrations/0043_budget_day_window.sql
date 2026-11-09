-- A daily budget can follow the provider's own day: 'utc' counts calls since 00:00 UTC (OpenRouter's
-- free-model quota resets then) instead of the last 24 hours.
ALTER TABLE budgets ADD COLUMN day_window text NOT NULL DEFAULT 'rolling' CHECK (day_window IN ('rolling', 'utc'));
