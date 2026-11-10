-- Evidence discipline (docs/quality.md, 弃答): candidates that ranked high enough for a daily issue but
-- were left out because their evidence was too thin (projects/evidence.ts). One row per user, issue and
-- article; the issue itself simply has fewer items. Kept for the abstention eval and for review.
CREATE TABLE IF NOT EXISTS issue_abstentions (
  user_id    text NOT NULL,
  issue_date date NOT NULL,
  article_id text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  reason     text NOT NULL CHECK (reason IN ('no-source', 'title-only', 'thin', 'unsourced-claim', 'source-conflict')),
  detail     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, issue_date, article_id),
  FOREIGN KEY (user_id, issue_date) REFERENCES user_issues (user_id, issue_date) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS issue_abstentions_created_idx ON issue_abstentions (created_at);
