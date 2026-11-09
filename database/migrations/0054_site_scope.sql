-- The site's own scope (the industry rule of prompts/prefilter.md): an article a tracking project follows
-- may pass the prefilter only because of that project (battery, earnings, a fund…). Such an item stays in
-- the projects' own views but never reaches the public selection, the public lists or the daily issue.
-- analyses.in_scope NULL: judged before this column, by the industry rule alone, so in scope.
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS in_scope boolean;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS in_scope boolean NOT NULL DEFAULT true;
