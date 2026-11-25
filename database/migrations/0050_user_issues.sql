-- v4.4 issues: every day at 08:00 Asia/Taipei (00:00 UTC) each user's 今日 is fixed as one issue of up
-- to 3 items; an article (or event) that was in any of the user's issues never comes back. Replaces the
-- mark-based 翻篇 of 0048 (user_item_marks / user_read_checkpoints stay, unused by the new client).
CREATE TABLE user_issues (
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  issue_date   date NOT NULL,
  -- The user's running number of non-empty issues; NULL for a day without items.
  issue_no     integer,
  cutoff       timestamptz NOT NULL,
  window_since timestamptz NOT NULL,
  hero         boolean NOT NULL DEFAULT false,
  fixed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, issue_date)
);

CREATE TABLE user_issue_items (
  user_id    text NOT NULL,
  issue_date date NOT NULL,
  position   smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  article_id text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  story_id   text,
  score      numeric(5, 2),
  listed_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, issue_date, position),
  UNIQUE (user_id, article_id),
  FOREIGN KEY (user_id, issue_date) REFERENCES user_issues (user_id, issue_date) ON DELETE CASCADE
);
CREATE INDEX user_issue_items_story_idx ON user_issue_items (user_id, story_id) WHERE story_id IS NOT NULL;

-- Read state: the items the user opened (expanded).
CREATE TABLE user_issue_reads (
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  article_id text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  opened_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

-- Issue card copy (v4.4 budget, COPY-BUDGET.md): two-half title and core line, summary, tag, short source.
-- over_budget: still over after the rewrites; stored anyway (never truncated), the client falls back.
CREATE TABLE issue_card_copy (
  project_id     text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  article_id     text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  prompt_version text NOT NULL,
  title_a        text NOT NULL,
  title_b        text NOT NULL DEFAULT '',
  core_a         text NOT NULL,
  core_b         text NOT NULL DEFAULT '',
  summary        text NOT NULL,
  tag            text NOT NULL DEFAULT '',
  source_short   text NOT NULL DEFAULT '',
  over_budget    boolean NOT NULL DEFAULT false,
  receipt_id     bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, article_id)
);

-- One-shot companion-app reminders: the id is the hash of the app identity (as mp_signups),
-- the identity itself stays in the app's own backend, which sends the message.
CREATE TABLE mp_reminders (
  reminder_id text NOT NULL,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  for_date    date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reminder_id, for_date)
);
