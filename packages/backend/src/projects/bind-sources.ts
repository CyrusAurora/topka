// Source bindings (master design 3.2 project_sources): the wizard's picks become core sources of a
// project. Unknown sources are refused with a typed error before anything is written, so the API can
// answer with an honest 400 instead of a bare foreign-key failure.
import { sql, type Db, type Sql } from "../db.ts";

export interface ProjectSourceBinding {
  sourceId: string;
  /** Required sources are the ones the coverage certificate will insist on (step 8). */
  required: boolean;
}

export class UnknownSourcesError extends Error {
  readonly sourceIds: string[];
  constructor(sourceIds: string[]) {
    super(`unknown sources: ${sourceIds.join(", ")}`);
    this.sourceIds = sourceIds;
  }
}

/** Fails with the missing ids when any of the given sources does not exist. */
export async function assertSourcesExist(sourceIds: readonly string[], db: Db = sql): Promise<void> {
  const wanted = [...new Set(sourceIds)];
  if (wanted.length === 0) return;
  const known = await db<{ id: string }[]>`SELECT id FROM sources WHERE id IN ${sql(wanted)}`;
  const knownIds = new Set(known.map((row) => row.id));
  const missing = wanted.filter((id) => !knownIds.has(id));
  if (missing.length > 0) throw new UnknownSourcesError(missing);
}

/** Binds the sources as core; a repeated id binds once. Idempotent per (project, source). */
export async function bindProjectSources(projectId: string, sources: readonly ProjectSourceBinding[], db: Db = sql): Promise<void> {
  await assertSourcesExist(sources.map((source) => source.sourceId), db);
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.sourceId)) continue;
    seen.add(source.sourceId);
    await db`
      INSERT INTO project_sources (project_id, source_id, role, required)
      VALUES (${projectId}, ${source.sourceId}, 'core', ${source.required})
      ON CONFLICT (project_id, source_id) DO NOTHING`;
  }
}
