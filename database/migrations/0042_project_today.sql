-- The per-project today view (master design J4, 3.3 checkpoint semantics in their first, simple form).
--  * tracking_projects.slug: a short, URL-safe, stable handle ("p" + 12 hex of the id's SHA-256), so
--    links and snapshot files never carry the percent-encoded derived id.
--  * publications.listed_at: when the item entered the pool (first insert, or the moment it became
--    eligible); "new since last read" is measured on it, not on the source's own date, so an item
--    analysed after the reader's checkpoint still counts as new.
--  * project_read_checkpoints: per user and project, the instant the reader confirmed reading up
--    to. Only an explicit acknowledgement moves it, and only forward.
ALTER TABLE tracking_projects ADD COLUMN slug text;
UPDATE tracking_projects SET slug = 'p' || left(encode(sha256(convert_to(id, 'UTF8')), 'hex'), 12) WHERE slug IS NULL;
ALTER TABLE tracking_projects ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX tracking_projects_slug_idx ON tracking_projects (slug);

ALTER TABLE publications ADD COLUMN listed_at timestamptz;
UPDATE publications SET listed_at = timeline_at WHERE listed_at IS NULL;
ALTER TABLE publications ALTER COLUMN listed_at SET DEFAULT now();
ALTER TABLE publications ALTER COLUMN listed_at SET NOT NULL;
CREATE INDEX publications_source_listed_idx ON publications (source_id, listed_at DESC) WHERE visibility = 'public' AND eligible;

CREATE TABLE project_read_checkpoints (
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id   text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  read_through timestamptz NOT NULL,
  acks         integer NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);
