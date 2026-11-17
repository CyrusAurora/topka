-- Discovery channels and pending-evidence signals (master design 3.2 discovery_signals, 8.2 step 10;
-- implementation notes in docs/discovery.md). A signal is a candidate from a channel — a directory
-- feed, a project's pack, or a lead the reader gave — never a source, an observation or an update.
-- The promotion gate (@topka/contracts/discovery, pure) promotes it only when a saved observation has
-- the same URL identity, and records that observation's id as lineage.
--
-- The database refuses what the gate never does:
--   * a promoted signal without its observation id, or one whose URL has no identity (an invalid URL
--     stays visible but is never promoted);
--   * moving a promoted signal anywhere (promotion is final lineage), or editing what a channel
--     reported (url, identity, channel, discovery time);
--   * a reader's lead without its project.
-- Allowed moves: awaiting → promoted (the gate), awaiting → dismissed (owner or operator, with a
-- reason), dismissed → awaiting (restore).

CREATE TABLE IF NOT EXISTS discovery_signals (
  id                       text PRIMARY KEY,
  channel_kind             text NOT NULL CHECK (channel_kind IN ('directory', 'pack', 'user-lead')),
  channel_name             text NOT NULL CHECK (length(btrim(channel_name)) > 0),
  -- The directory or pack feed it came from (null for a reader's lead).
  channel_source_id        text REFERENCES sources (id) ON DELETE SET NULL,
  url                      text NOT NULL CHECK (length(url) <= 4096),
  -- urlIdentity() of url; null: no identity, never promoted.
  url_identity             text,
  title                    text CHECK (title IS NULL OR length(title) <= 1000),
  note                     text CHECK (note IS NULL OR length(note) <= 2000),
  -- When the channel first showed it (first sight here), and what the channel claimed as its date.
  discovered_at            timestamptz NOT NULL DEFAULT now(),
  published_at_claim       timestamptz,
  status                   text NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'promoted', 'dismissed')),
  promoted_observation_id  text,
  promoted_at              timestamptz,
  dismissed_at             timestamptz,
  dismissed_by             text,
  dismissed_reason         text,
  project_id               text REFERENCES tracking_projects (id) ON DELETE CASCADE,
  submitted_by             text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'promoted') = (promoted_observation_id IS NOT NULL)),
  CHECK ((status = 'promoted') = (promoted_at IS NOT NULL)),
  CHECK (status <> 'promoted' OR url_identity IS NOT NULL),
  CHECK ((status = 'dismissed') = (dismissed_at IS NOT NULL)),
  CHECK (channel_kind <> 'user-lead' OR project_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS discovery_signals_status_idx ON discovery_signals (status, discovered_at);
CREATE INDEX IF NOT EXISTS discovery_signals_identity_idx ON discovery_signals (url_identity) WHERE url_identity IS NOT NULL;
CREATE INDEX IF NOT EXISTS discovery_signals_project_idx ON discovery_signals (project_id, status) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS discovery_signals_observation_idx ON discovery_signals (promoted_observation_id) WHERE promoted_observation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION discovery_signals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.url IS DISTINCT FROM OLD.url OR NEW.url_identity IS DISTINCT FROM OLD.url_identity
     OR NEW.channel_kind IS DISTINCT FROM OLD.channel_kind OR NEW.channel_name IS DISTINCT FROM OLD.channel_name
     OR NEW.discovered_at IS DISTINCT FROM OLD.discovered_at OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'discovery signal %: what the channel reported cannot change', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'promoted' AND (NEW.status <> 'promoted' OR NEW.promoted_observation_id IS DISTINCT FROM OLD.promoted_observation_id
     OR NEW.promoted_at IS DISTINCT FROM OLD.promoted_at) THEN
    RAISE EXCEPTION 'discovery signal %: a promotion is final', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'dismissed' AND NEW.status = 'promoted' THEN
    RAISE EXCEPTION 'discovery signal %: restore a dismissed signal before it can be promoted', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS discovery_signals_guard ON discovery_signals;
CREATE TRIGGER discovery_signals_guard BEFORE UPDATE ON discovery_signals
  FOR EACH ROW EXECUTE FUNCTION discovery_signals_guard();
