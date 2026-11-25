-- English pack names for the project wizard (trial finding: an English reader saw 「具身智能与机器人」).
-- The seed files (database/seeds/packs/*.json, `labelEn`) keep it current; this fills the four shipped
-- packs on databases that are not re-seeded.
ALTER TABLE source_packs ADD COLUMN IF NOT EXISTS label_en text;

UPDATE source_packs SET label_en = v.label_en
FROM (VALUES ('ai-models', 'AI models'), ('semiconductor', 'Semiconductors & compute'),
             ('embodied-ai', 'Embodied AI & robotics'), ('opensource-dev', 'Open source & developers')) AS v (id, label_en)
WHERE source_packs.id = v.id AND source_packs.label_en IS NULL;
