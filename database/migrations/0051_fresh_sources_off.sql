-- A fresh install starts with every source off: the operator picks sources (npm run sources:seed, the
-- admin page, npm run sources:only) and switches collection on deliberately. Only a database that has
-- never stored an article is touched (that is a fresh install: 0041 just switched its batch-1 rows on);
-- an existing deployment keeps every switch exactly as it is.
UPDATE sources SET enabled = false, updated_at = now()
WHERE enabled AND NOT EXISTS (SELECT 1 FROM articles);
