// The project creation use case (master design 3.2/8.2 step 3): non-empty target and purpose, a
// derived id, then in one transaction the project, its revision 1 and the selected sources bound as
// core. Creation is idempotent per user: a repeat with the same goal returns the existing project
// untouched — no second revision, no rebinding.
import { sql, type Sql } from "../db.ts";
import { deriveProjectId, projectSlug } from "./derive-id.ts";
import { assertSourcesExist, bindProjectSources, type ProjectSourceBinding } from "./bind-sources.ts";

export type CreateProjectReason = "empty-target" | "empty-purpose";

export class ProjectRejected extends Error {
  readonly reason: CreateProjectReason;
  constructor(reason: CreateProjectReason) {
    super(reason);
    this.reason = reason;
  }
}

export interface ProjectRow {
  id: string;
  /** Short URL-safe handle for links and snapshots (derive-id.ts projectSlug). */
  slug: string;
  ownerId: string;
  target: string;
  purpose: string;
  currentRevision: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectInput {
  ownerId: string;
  target: string;
  purpose: string;
  sources: readonly ProjectSourceBinding[];
}

export interface CreateProjectResult {
  project: ProjectRow;
  /** false when the same user's derived id already existed: the existing project is the answer. */
  created: boolean;
}

interface ProjectDbRow extends Omit<ProjectRow, "createdAt" | "updatedAt"> {
  created_at: Date;
  updated_at: Date;
}

function toProject(row: ProjectDbRow): ProjectRow {
  return { ...row, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function loadProject(projectId: string, ownerId: string, db: Sql): Promise<ProjectRow | null> {
  const [row] = await db<ProjectDbRow[]>`
    SELECT id, slug, owner_id AS "ownerId", target, purpose, current_revision AS "currentRevision", status, created_at, updated_at
    FROM tracking_projects WHERE id = ${projectId} AND owner_id = ${ownerId}`;
  return row ? toProject(row) : null;
}

export async function createProject(input: CreateProjectInput, db: Sql = sql): Promise<CreateProjectResult> {
  const target = input.target.trim();
  const purpose = input.purpose.trim();
  if (!target) throw new ProjectRejected("empty-target");
  if (!purpose) throw new ProjectRejected("empty-purpose");
  const sourceIds = input.sources.map((source) => source.sourceId);
  await assertSourcesExist(sourceIds, db);

  const id = deriveProjectId(target, purpose, input.ownerId);
  const existing = await loadProject(id, input.ownerId, db);
  if (existing) return { project: existing, created: false };

  try {
    return await db.begin(async (tx) => {
      const [row] = await tx<ProjectDbRow[]>`
        INSERT INTO tracking_projects (id, slug, owner_id, target, purpose, current_revision, status)
        VALUES (${id}, ${projectSlug(id)}, ${input.ownerId}, ${target}, ${purpose}, 1, 'active')
        RETURNING id, slug, owner_id AS "ownerId", target, purpose, current_revision AS "currentRevision", status, created_at, updated_at`;
      await tx`
        INSERT INTO project_revisions (project_id, revision, target, purpose, previous_version_id, needs_rebaseline)
        VALUES (${id}, 1, ${target}, ${purpose}, NULL, true)`;
      await bindProjectSources(id, input.sources, tx);
      return { project: toProject(row!), created: true };
    });
  } catch (error) {
    // A racer created the same project between our check and the insert: the unique id wins and the
    // existing project is the answer, exactly as if it had been there all along.
    if ((error as { code?: string }).code === "23505") {
      const raced = await loadProject(id, input.ownerId, db);
      if (raced) return { project: raced, created: false };
    }
    throw error;
  }
}
