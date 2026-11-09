-- Mobile card copy for the mobile 今日 cards: a self-contained title, what changed and why it matters
-- for the project, written for the day's top cards only (one model call covers a day's cards).
CREATE TABLE project_card_copy (
  project_id     text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  article_id     text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  prompt_version text NOT NULL,
  title          text NOT NULL,
  lead           text NOT NULL,
  why            text NOT NULL,
  receipt_id     bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, article_id)
);
