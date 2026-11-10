-- Source content is append-only. An article row holds the current revision of one real-world
-- material; article_revisions holds every revision the source ever showed. The database itself
-- now refuses the two ways that history could be rewritten by mistake:
--
-- 1. articles: where the material came from (url, identity_key, source_id, id) never changes, and
--    its content (title, body_text, body_html) changes only together with revision + 1. A revision
--    may only move forward by one. Two fills are allowed in place, because they add and never
--    replace: an excerpt that was empty, and the content_hash of imported history that had none.
--    Every new revision, and every new article collected here, must have its row in
--    article_revisions with the same title, body_text and content_hash by the end of the transaction
--    (a deferred check, so the usual "update the article, then insert the revision" in one
--    transaction passes). Imported history (no content_hash yet) is the one exception on insert.
-- 2. article_revisions: rows are never updated, and are deleted only together with their article
--    (ON DELETE CASCADE, e.g. a takedown).
--
-- This guards the application against its own bugs. The table owner can still disable a trigger;
-- that is a deliberate act, not an accident.

CREATE OR REPLACE FUNCTION articles_provenance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.url IS DISTINCT FROM OLD.url
     OR NEW.identity_key IS DISTINCT FROM OLD.identity_key OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    RAISE EXCEPTION 'article provenance: id, url, identity_key and source_id of article % cannot change', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.revision <> OLD.revision AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'article provenance: revision of article % can only move from % to %', OLD.id, OLD.revision, OLD.revision + 1
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.revision = OLD.revision THEN
    IF NEW.title IS DISTINCT FROM OLD.title OR NEW.body_text IS DISTINCT FROM OLD.body_text
       OR NEW.body_html IS DISTINCT FROM OLD.body_html THEN
      RAISE EXCEPTION 'article provenance: content of article % changes only with a new revision (record it in article_revisions)', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.excerpt IS DISTINCT FROM OLD.excerpt AND OLD.excerpt IS NOT NULL THEN
      RAISE EXCEPTION 'article provenance: the excerpt of article % can be filled once, not replaced, without a new revision', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.content_hash IS DISTINCT FROM OLD.content_hash AND OLD.content_hash IS NOT NULL THEN
      RAISE EXCEPTION 'article provenance: the content_hash of article % changes only with a new revision', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS articles_provenance_guard ON articles;
CREATE TRIGGER articles_provenance_guard BEFORE UPDATE ON articles
  FOR EACH ROW EXECUTE FUNCTION articles_provenance_guard();

-- At commit: the article's current revision is recorded, with the same content.
CREATE OR REPLACE FUNCTION articles_revision_recorded() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE cur articles%ROWTYPE;
BEGIN
  -- The row as it stands at commit (a later statement in the transaction may have moved it on).
  SELECT * INTO cur FROM articles WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Imported history arrives without a hash or a history row; its first report here records the
  -- baseline (content/materials.ts). Everything collected here carries a hash from the start.
  IF TG_OP = 'INSERT' AND cur.content_hash IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM article_revisions r
    WHERE r.article_id = cur.id AND r.revision = cur.revision AND r.title = cur.title
      AND r.body_text IS NOT DISTINCT FROM cur.body_text AND r.content_hash IS NOT DISTINCT FROM cur.content_hash
  ) THEN
    RAISE EXCEPTION 'article provenance: revision % of article % is not recorded in article_revisions with the same content', cur.revision, cur.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS articles_revision_recorded ON articles;
CREATE CONSTRAINT TRIGGER articles_revision_recorded AFTER INSERT OR UPDATE OF revision ON articles
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION articles_revision_recorded();

CREATE OR REPLACE FUNCTION article_revisions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'article provenance: revision % of article % is history and cannot be updated', OLD.revision, OLD.article_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- DELETE: only as part of deleting the article itself (the cascade runs after the article is gone).
  IF EXISTS (SELECT 1 FROM articles WHERE id = OLD.article_id) THEN
    RAISE EXCEPTION 'article provenance: revisions of article % are deleted only with the article', OLD.article_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS article_revisions_append_only ON article_revisions;
CREATE TRIGGER article_revisions_append_only BEFORE UPDATE OR DELETE ON article_revisions
  FOR EACH ROW EXECUTE FUNCTION article_revisions_append_only();
