-- Project-aware scoring: what a tracking project's reader intends (target, purpose, and optional focus and
-- exclusions), the score of each article against each project that follows its source, the cards a project's
-- today view showed, and a monthly per-source view of the score distribution (for a source hit-rate report;
-- nothing reads it automatically and nothing changes a weight from it).
ALTER TABLE tracking_projects
  ADD COLUMN focus      text NOT NULL DEFAULT '',
  ADD COLUMN exclusions text NOT NULL DEFAULT '';

CREATE TABLE project_scores (
  project_id       text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  article_id       text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  source_id        text NOT NULL,
  input_revision   integer NOT NULL,
  project_revision integer NOT NULL,
  scores           integer[] NOT NULL,         -- the independent calls
  score            integer NOT NULL,           -- floor of their mean
  model            text,
  prompt_version   text NOT NULL,
  receipt_ids      bigint[] NOT NULL DEFAULT '{}',
  scored_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, article_id)
);
CREATE INDEX project_scores_source_idx ON project_scores (project_id, source_id, scored_at);

CREATE TABLE project_today_shown (
  project_id     text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  article_id     text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  source_id      text NOT NULL,
  score          integer,
  first_shown_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, article_id)
);

-- Month in Asia/Taipei. "shown" = how many of the month's scored items reached the project's today cards.
CREATE VIEW project_source_score_monthly AS
SELECT s.project_id, s.source_id,
       date_trunc('month', s.scored_at AT TIME ZONE 'Asia/Taipei')::date AS month,
       count(*)::int AS scored,
       round(avg(s.score), 1) AS mean,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY s.score) AS median,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY s.score) AS p90,
       count(*) FILTER (WHERE s.score < 30)::int AS below_30,
       count(*) FILTER (WHERE s.score >= 30 AND s.score < 50)::int AS from_30,
       count(*) FILTER (WHERE s.score >= 50 AND s.score < 70)::int AS from_50,
       count(*) FILTER (WHERE s.score >= 70)::int AS from_70,
       count(t.article_id)::int AS shown
FROM project_scores s
LEFT JOIN project_today_shown t ON t.project_id = s.project_id AND t.article_id = s.article_id
GROUP BY 1, 2, 3;
