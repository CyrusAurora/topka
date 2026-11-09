-- The web reminder (P0, zero infrastructure): each reader may turn on a private Atom feed of their own
-- daily issue (/feed/issue/<token>.xml) and subscribe in any feed reader. Only the SHA-256 of the token
-- is stored; the URL is shown once, and generating a new one retires the old one. One feed per user.
CREATE TABLE user_issue_feeds (
  user_id    text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz
);
