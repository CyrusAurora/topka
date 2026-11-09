-- The project layer (master design 3.2, construction step 3): tracking projects with their revisions,
-- core source bindings, the curated source packs (seeded from database/seeds/source-packs.json), the
-- per-user pack preferences and the baseline view. Times are UTC timestamptz.
CREATE TABLE tracking_projects (
  id               text PRIMARY KEY, -- derived: project:<encoded target>:<encoded purpose>:<user tag> (derive-id.ts)
  owner_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target           text NOT NULL,
  purpose          text NOT NULL,
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tracking_projects_owner_idx ON tracking_projects (owner_id);

CREATE TABLE project_revisions (
  project_id          text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  revision            integer NOT NULL CHECK (revision >= 1),
  target              text NOT NULL,
  purpose             text NOT NULL,
  previous_version_id text,
  needs_rebaseline    boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, revision)
);

CREATE TABLE project_sources (
  project_id text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  source_id  text NOT NULL REFERENCES sources (id),
  role       text NOT NULL DEFAULT 'core' CHECK (role IN ('core', 'optional')),
  required   boolean NOT NULL DEFAULT false,
  paused     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, source_id)
);

CREATE INDEX project_sources_source_idx ON project_sources (source_id);

CREATE TABLE source_packs (
  id         text PRIMARY KEY,
  label      text NOT NULL,
  sources    jsonb NOT NULL DEFAULT '[]', -- [{id, name, publisher}]: the wizard's static list
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_pack_prefs (
  user_id text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  pack_id text NOT NULL,
  picks   jsonb NOT NULL DEFAULT '[]', -- the picked source ids, in pick order
  at      timestamptz NOT NULL DEFAULT now()
);

-- A view over the first collection window, materialised and recomputable; nothing writes it yet.
CREATE TABLE baselines (
  project_id      text NOT NULL REFERENCES tracking_projects (id) ON DELETE CASCADE,
  revision        integer NOT NULL CHECK (revision >= 1),
  window_start    timestamptz,
  window_end      timestamptz,
  observation_ids text[] NOT NULL DEFAULT '{}',
  built_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, revision)
);

-- The curated packs and their sources, from one seed file (the seed placeholder below is inlined by
-- scripts/migrate.ts, so the JSON stays the single source of truth). Idempotent: re-running a seed
-- or re-applying to a database that already has the rows changes nothing.
WITH seed AS (SELECT {{seed:source-packs.json}}::jsonb AS doc)
INSERT INTO source_packs (id, label, sources, updated_at)
SELECT p->>'id', p->>'label', p->'sources', now()
FROM seed, jsonb_array_elements(doc->'packs') AS p
ON CONFLICT (id) DO NOTHING;

-- Every pack source is also a sources row, so project bindings keep their foreign key. Collection
-- wiring arrives with construction step 4: until then the rows are external (nothing scheduled),
-- disabled, isolated, and tagged with their pack for the import to find and turn native.
WITH seed AS (SELECT {{seed:source-packs.json}}::jsonb AS doc)
INSERT INTO sources (id, name, kind, config, tags, participation_mode, enabled)
SELECT s->>'id', s->>'name', 'external', '{}'::jsonb,
       ARRAY['curated-pack', 'pack:' || (p->>'id')], 'isolated', false
FROM seed, jsonb_array_elements(doc->'packs') AS p, jsonb_array_elements(p->'sources') AS s
ON CONFLICT (id) DO NOTHING;
