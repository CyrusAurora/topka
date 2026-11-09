// Applies database/migrations/*.sql in order, each in its own transaction. Safe to re-run.
// A migration may inline a seed file with {{seed:<name>.json}}: the placeholder is replaced by the
// JSON from database/seeds/<name> (dollar-quoted), so the JSON stays the single source of truth.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@topka/backend/config";
import { closeDb, sql } from "@topka/backend/db";

const dir = path.join(REPO_ROOT, "database/migrations");
const seedDir = path.join(REPO_ROOT, "database/seeds");

/** Replaces every {{seed:<file>}} placeholder with the file's JSON as a dollar-quoted SQL literal. */
function inlineSeeds(text: string): string {
  return text.replace(/\{\{seed:([^}]+)\}\}/g, (_match, file: string) => {
    const name = file.trim();
    if (!/^[\w.-]+$/.test(name)) throw new Error(`bad seed reference: ${file}`);
    const json = JSON.stringify(JSON.parse(readFileSync(path.join(seedDir, name), "utf8")));
    if (json.includes("$seed$")) throw new Error(`${name} contains the SQL quoting tag itself`);
    return `$seed$${json}$seed$`;
  });
}

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));

let count = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  const text = inlineSeeds(readFileSync(path.join(dir, file), "utf8"));
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
  });
  console.log(`applied ${file}`);
  count += 1;
}
console.log(count === 0 ? "database is up to date" : `${count} migration(s) applied`);
await closeDb();
