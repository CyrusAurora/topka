-- The observation ledger and the brief's checkpoint (master design 3.3; implementation notes in
-- docs/ledger.md). Everything here is append-only history, refused at the database like 0059:
--
-- 1. observation_rejections: reports the write path refused (content/materials.ts four states:
--    created / existing / conflict / failed). A conflict keeps the reported text next to the stored
--    observation, so the conflicting original can always be opened; nothing is ever overwritten.
-- 2. article_revisions.version_marker: the source's own version time for each revision (its feed's
--    `updated`), so a replay of an older version is recognised as a conflict, not a correction.
-- 3. article_withdrawals: a source retracting or removing material is a new record, never an edit
--    or a delete of the observation; reinstating is another record. The latest record is the state
--    (article_withdrawal_state).
-- 4. project_brief_snapshots: what a reader was shown (immutable, content-addressed id), and
--    project_checkpoint_acks: every confirmation. project_read_checkpoints gains the sequence,
--    snapshot and receipt of the last confirmation, and a guard: it only moves forward, one step
--    at a time, from a stored snapshot.

-- 1 ------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observation_rejections (
  id               bigserial PRIMARY KEY,
  state            text NOT NULL CHECK (state IN ('conflict', 'failed')),
  code             text NOT NULL CHECK (code IN ('identity-conflict', 'missing-provenance', 'preservation-failed')),
  CHECK ((state = 'conflict') = (code = 'identity-conflict')),
  source_id        text,
  -- The stored observation the report collided with (conflict); null when nothing was stored (failed).
  article_id       text REFERENCES articles (id) ON DELETE CASCADE,
  identity_key     text,
  url              text,
  title            text,
  excerpt          text,
  body_text        text,
  content_hash     text,
  version_marker   timestamptz,
  stored_revision  integer,
  stored_marker    timestamptz,
  via              text,
  detail           text NOT NULL DEFAULT '',
  reported_at      timestamptz NOT NULL DEFAULT now()
);
-- The same report refused again (a feed repeats it every fetch) is recorded once, at first sight.
CREATE UNIQUE INDEX IF NOT EXISTS observation_rejections_once
  ON observation_rejections (state, code, coalesce(source_id, ''), coalesce(identity_key, ''), coalesce(url, ''), coalesce(content_hash, ''));
CREATE INDEX IF NOT EXISTS observation_rejections_article_idx ON observation_rejections (article_id) WHERE article_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS observation_rejections_reported_idx ON observation_rejections (reported_at);

-- 2 ------------------------------------------------------------------------------------------
ALTER TABLE article_revisions ADD COLUMN IF NOT EXISTS version_marker timestamptz;

-- 3 ------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS article_withdrawals (
  id            bigserial PRIMARY KEY,
  article_id    text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  action        text NOT NULL CHECK (action IN ('withdraw', 'reinstate')),
  -- source-retracted: the publisher took it back (a retraction notice); source-removed: the page or
  -- post is gone at the source; editorial: an operator's decision, with its reason.
  basis         text NOT NULL CHECK (basis IN ('source-retracted', 'source-removed', 'editorial')),
  reason        text NOT NULL CHECK (length(btrim(reason)) > 0),
  evidence_url  text,
  recorded_by   text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS article_withdrawals_article_idx ON article_withdrawals (article_id, id DESC);

CREATE OR REPLACE VIEW article_withdrawal_state AS
  SELECT DISTINCT ON (article_id) article_id, action = 'withdraw' AS withdrawn, basis, reason, evidence_url, recorded_by, recorded_at
  FROM article_withdrawals ORDER BY article_id, id DESC;

-- A record must change the state: withdraw only what is current, reinstate only what is withdrawn.
CREATE OR REPLACE FUNCTION article_withdrawals_alternate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE last_action text;
BEGIN
  PERFORM 1 FROM articles WHERE id = NEW.article_id FOR UPDATE;
  SELECT action INTO last_action FROM article_withdrawals WHERE article_id = NEW.article_id ORDER BY id DESC LIMIT 1;
  IF NEW.action = 'withdraw' AND last_action = 'withdraw' THEN
    RAISE EXCEPTION 'observation ledger: article % is already withdrawn', NEW.article_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.action = 'reinstate' AND last_action IS DISTINCT FROM 'withdraw' THEN
    RAISE EXCEPTION 'observation ledger: article % is not withdrawn', NEW.article_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS article_withdrawals_alternate ON article_withdrawals;
CREATE TRIGGER article_withdrawals_alternate BEFORE INSERT ON article_withdrawals
  FOR EACH ROW EXECUTE FUNCTION article_withdrawals_alternate();

-- History tables owned by an article: never updated, deleted only together with the article.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'observation ledger: % rows are history and cannot be updated', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.article_id IS NOT NULL AND EXISTS (SELECT 1 FROM articles WHERE id = OLD.article_id) THEN
    RAISE EXCEPTION 'observation ledger: % rows of article % are deleted only with the article', TG_TABLE_NAME, OLD.article_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A refused report with no stored article (failed): kept 180 days, then the daily retention may drop it.
  IF OLD.article_id IS NULL AND OLD.reported_at > now() - interval '180 days' THEN
    RAISE EXCEPTION 'observation ledger: refused reports are kept 180 days' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS observation_rejections_append_only ON observation_rejections;
CREATE TRIGGER observation_rejections_append_only BEFORE UPDATE OR DELETE ON observation_rejections
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

CREATE OR REPLACE FUNCTION article_withdrawals_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'observation ledger: withdrawal records are history and cannot be updated' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM articles WHERE id = OLD.article_id) THEN
    RAISE EXCEPTION 'observation ledger: withdrawal records of article % are deleted only with the article', OLD.article_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS article_withdrawals_append_only ON article_withdrawals;
CREATE TRIGGER article_withdrawals_append_only BEFORE UPDATE OR DELETE ON article_withdrawals
  FOR EACH ROW EXECUTE FUNCTION article_withdrawals_append_only();

-- 4 ------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_brief_snapshots (
  snapshot_id              text PRIMARY KEY CHECK (snapshot_id ~ '^brief-snapshot-v1:[0-9a-f]{32}$'),
  user_id                  text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id               text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  revision                 integer NOT NULL,
  ack_seq                  bigint NOT NULL CHECK (ack_seq >= 0),
  window_since             timestamptz NOT NULL,
  window_until             timestamptz NOT NULL,
  basis                    text NOT NULL,
  coverage                 jsonb NOT NULL,
  item_ids                 text[] NOT NULL,
  unassessed               integer NOT NULL CHECK (unassessed >= 0),
  top_result               text NOT NULL CHECK (top_result IN ('snapshot-failed', 'partial-coverage', 'abstained-impact', 'updates-available', 'no-important-change')),
  acknowledgement_allowed  boolean NOT NULL,
  -- Bound, never chosen: the blocking states may not be confirmed, the last two may.
  CHECK (acknowledgement_allowed = (top_result IN ('updates-available', 'no-important-change'))),
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_brief_snapshots_project_idx ON project_brief_snapshots (project_id, created_at);

ALTER TABLE project_read_checkpoints ALTER COLUMN read_through DROP NOT NULL;
ALTER TABLE project_read_checkpoints
  ADD COLUMN IF NOT EXISTS ack_seq     bigint NOT NULL DEFAULT 0 CHECK (ack_seq >= 0),
  ADD COLUMN IF NOT EXISTS snapshot_id text,
  ADD COLUMN IF NOT EXISTS receipt_id  text,
  ADD COLUMN IF NOT EXISTS command_id  text,
  ADD COLUMN IF NOT EXISTS revision    integer;
-- Confirmations made before this migration count as the sequence so far.
UPDATE project_read_checkpoints SET ack_seq = acks WHERE ack_seq = 0 AND read_through IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_checkpoint_acks (
  id               bigserial PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id       text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  ack_seq          bigint NOT NULL CHECK (ack_seq >= 1),
  snapshot_id      text NOT NULL REFERENCES project_brief_snapshots (snapshot_id) ON DELETE CASCADE,
  command_id       text NOT NULL CHECK (length(btrim(command_id)) > 0),
  receipt_id       text NOT NULL CHECK (receipt_id ~ '^receipt-[0-9a-f]{8}$'),
  read_through     timestamptz NOT NULL,
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, project_id, ack_seq),
  UNIQUE (user_id, project_id, command_id)
);

-- Snapshots and confirmations: never updated; deleted with their project or user, and a snapshot
-- nobody confirmed may be dropped by the daily retention after 30 days.
CREATE OR REPLACE FUNCTION brief_history_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'brief checkpoint: % rows are history and cannot be updated', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tracking_projects WHERE id = OLD.project_id) OR NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'project_brief_snapshots' THEN
    IF OLD.created_at < now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM project_checkpoint_acks a WHERE a.snapshot_id = OLD.snapshot_id)
       AND NOT EXISTS (SELECT 1 FROM project_read_checkpoints c WHERE c.snapshot_id = OLD.snapshot_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'brief checkpoint: % rows are deleted only with their project', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;
DROP TRIGGER IF EXISTS project_brief_snapshots_append_only ON project_brief_snapshots;
CREATE TRIGGER project_brief_snapshots_append_only BEFORE UPDATE OR DELETE ON project_brief_snapshots
  FOR EACH ROW EXECUTE FUNCTION brief_history_append_only();
DROP TRIGGER IF EXISTS project_checkpoint_acks_append_only ON project_checkpoint_acks;
CREATE TRIGGER project_checkpoint_acks_append_only BEFORE UPDATE OR DELETE ON project_checkpoint_acks
  FOR EACH ROW EXECUTE FUNCTION brief_history_append_only();

-- The storage-level monotonic guard: a checkpoint moves only forward, one confirmation at a time,
-- to a stored snapshot of the same project, and each move is in the confirmation log.
CREATE OR REPLACE FUNCTION project_checkpoint_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'brief checkpoint: a checkpoint belongs to one user and project' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.ack_seq = OLD.ack_seq THEN
    IF NEW.read_through IS DISTINCT FROM OLD.read_through OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
       OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id THEN
      RAISE EXCEPTION 'brief checkpoint: the same ack_seq % cannot point elsewhere', OLD.ack_seq USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.ack_seq <> OLD.ack_seq + 1 THEN
    RAISE EXCEPTION 'brief checkpoint: ack_seq moves from % to % only', OLD.ack_seq, OLD.ack_seq + 1 USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.read_through IS NULL OR (OLD.read_through IS NOT NULL AND NEW.read_through <= OLD.read_through) THEN
    RAISE EXCEPTION 'brief checkpoint: read_through only moves forward' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM project_brief_snapshots s WHERE s.snapshot_id = NEW.snapshot_id AND s.project_id = NEW.project_id
                   AND s.user_id = NEW.user_id AND s.ack_seq = OLD.ack_seq AND s.acknowledgement_allowed AND s.window_until = NEW.read_through) THEN
    RAISE EXCEPTION 'brief checkpoint: confirmation % does not match a confirmable snapshot built on ack_seq %', NEW.ack_seq, OLD.ack_seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS project_checkpoint_guard ON project_read_checkpoints;
CREATE TRIGGER project_checkpoint_guard BEFORE UPDATE ON project_read_checkpoints
  FOR EACH ROW EXECUTE FUNCTION project_checkpoint_guard();

-- A new checkpoint row starts empty (ack_seq 0) or, for rows written before this migration, as is.
CREATE OR REPLACE FUNCTION project_checkpoint_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ack_seq <> 0 OR NEW.snapshot_id IS NOT NULL OR NEW.read_through IS NOT NULL THEN
    RAISE EXCEPTION 'brief checkpoint: a checkpoint starts empty and moves by confirmations' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS project_checkpoint_insert_guard ON project_read_checkpoints;
CREATE TRIGGER project_checkpoint_insert_guard BEFORE INSERT ON project_read_checkpoints
  FOR EACH ROW EXECUTE FUNCTION project_checkpoint_insert_guard();
