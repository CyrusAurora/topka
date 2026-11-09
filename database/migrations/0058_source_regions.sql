-- Source geography (0004-globalization-v1, item E): `sources.regions` holds the ISO 3166-1 alpha-2
-- codes a source covers (lowercase, e.g. cn, us, eu, jp) plus `global`. The DEFAULT keeps every
-- existing source bindable — Cyrus packs seeded before this column must not silently disappear.
-- Geography only: do not confuse with `in_scope` (0054), which is industry-topic scope.
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS regions text[] NOT NULL DEFAULT ARRAY['global']::text[];

ALTER TABLE sources
  ADD CONSTRAINT sources_regions_nonempty CHECK (cardinality(regions) >= 1);

CREATE INDEX IF NOT EXISTS sources_regions_gin ON sources USING gin (regions);
