// The project id derivation (master design 3.2): project: + URL-encoded lowercase target + : +
// URL-encoded lowercase purpose + : + the first 8 hex chars of the user's identity hash. The hash
// keeps two users with the same goal apart (the old single-user rule collided across users); the
// lowercasing keeps the old meaning that a letter-case jitter is no change at all — within one user.
// Derived ids ride in route segments, whose charset is [A-Za-z0-9._~:%-] (1..256): percent-encoding
// satisfies it, so nothing here may emit characters outside it.
import { sha256 } from "../lib/ids.ts";

/** The user's short identity: 8 hex chars of the SHA-256 of the user id. */
export function userTag(userId: string): string {
  return sha256(userId).slice(0, 8);
}

function encodedPart(value: string): string {
  return encodeURIComponent(value.toLowerCase());
}

/** Route segments (and the API's projectIdSegment) accept at most this many characters. */
export const MAX_PROJECT_ID_LENGTH = 256;

/**
 * The readable form when it fits a route segment; a long goal (Chinese text grows ninefold when
 * percent-encoded) falls back to a stable hashed form, still per user and case-insensitive:
 * project:h<32 hex of SHA-256(lower target, NUL, lower purpose)>:<user tag>.
 */
export function deriveProjectId(target: string, purpose: string, userId: string): string {
  const readable = `project:${encodedPart(target)}:${encodedPart(purpose)}:${userTag(userId)}`;
  if (readable.length <= MAX_PROJECT_ID_LENGTH) return readable;
  return `project:h${sha256(`${target.toLowerCase()}\0${purpose.toLowerCase()}`).slice(0, 32)}:${userTag(userId)}`;
}

/** The short handle used in links and snapshot names: "p" + 12 hex of the id's SHA-256 (migration 0042 computes the same). */
export function projectSlug(projectId: string): string {
  return `p${sha256(projectId).slice(0, 12)}`;
}
