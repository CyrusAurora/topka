// The read layer's row-isolation gate (master design 3.4): every project query must pass through
// here, so an owner check lives in one place and outsiders always get the same answer as for a
// project that does not exist — existence is never leaked, not even to a signed-in non-owner.
import { sql, type Db } from "../db.ts";

export interface OwnedProject {
  id: string;
  slug: string;
  ownerId: string;
  target: string;
  purpose: string;
  currentRevision: number;
  status: string;
}

export type ProjectAccess = { kind: "ok"; project: OwnedProject } | { kind: "not-found" };

/** `projectId` is the derived id or the short slug; either way only the owner gets an answer. */
export async function requireProjectOwner(userId: string, projectId: string, db: Db = sql): Promise<ProjectAccess> {
  const [row] = await db<OwnedProject[]>`
    SELECT id, slug, owner_id AS "ownerId", target, purpose, current_revision AS "currentRevision", status
    FROM tracking_projects WHERE (id = ${projectId} OR slug = ${projectId}) AND owner_id = ${userId}`;
  return row ? { kind: "ok", project: row } : { kind: "not-found" };
}

/** The caller's own projects, newest first — the same owner filter the gate enforces, one place. */
export async function listOwnedProjects(ownerId: string, db: Db = sql): Promise<OwnedProject[]> {
  return db<OwnedProject[]>`
    SELECT id, slug, owner_id AS "ownerId", target, purpose, current_revision AS "currentRevision", status
    FROM tracking_projects WHERE owner_id = ${ownerId} ORDER BY created_at DESC, id`;
}
