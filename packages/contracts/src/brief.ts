// The checkpoint decision tables of the per-project brief (master design 3.3, decision D12): one pure
// module shared by the API (which stores snapshots and checkpoints) and the web page (which adds the
// one state only the client can see: offline or signed out). Every row of both tables is covered by
// tests/brief-decision.test.ts.

/** The brief's top result, highest priority first: the first condition that holds wins. */
export const BRIEF_RESULTS = [
  "offline-or-auth",
  "snapshot-failed",
  "partial-coverage",
  "abstained-impact",
  "updates-available",
  "no-important-change",
] as const;
export type BriefResult = (typeof BRIEF_RESULTS)[number];

export interface BriefConditions {
  /** The client cannot reach the API, or its session is gone (only the client knows this). */
  offlineOrAuth: boolean;
  /** The server could not build or store the snapshot. */
  snapshotFailed: boolean;
  /** Every required source of the project was checked recently (the coverage certificate). */
  coverageSatisfied: boolean;
  /** Material in the window whose importance is not assessed yet. */
  unassessed: number;
  /** Cards in the snapshot. */
  updates: number;
}

/** The top result for these conditions (the table of 3.3, first hit wins). */
export function evaluateBrief(c: BriefConditions): BriefResult {
  if (c.offlineOrAuth) return "offline-or-auth";
  if (c.snapshotFailed) return "snapshot-failed";
  if (!c.coverageSatisfied) return "partial-coverage";
  if (c.unassessed > 0) return "abstained-impact";
  if (c.updates > 0) return "updates-available";
  return "no-important-change";
}

/**
 * Bound to the result, never chosen separately: the first four states may not be confirmed (an
 * unreachable server, a missing snapshot, a required source not checked, or material not assessed
 * yet would turn "unknown" into "nothing important"); the last two may.
 */
export function acknowledgementAllowed(result: BriefResult): boolean {
  return result === "updates-available" || result === "no-important-change";
}

/** Why a confirmation is refused, in the order the checks run (the first failing one is reported). */
export const ACK_REJECTIONS = [
  "project-mismatch",
  "revision-mismatch",
  "ack-seq-mismatch",
  "result-not-acknowledgeable",
  "titles-not-shown",
  "checkpoint-not-behind",
  "command-required",
] as const;
export type AckRejection = (typeof ACK_REJECTIONS)[number];

export interface AckSnapshot {
  snapshotId: string;
  projectId: string;
  revision: number;
  /** The checkpoint's sequence the snapshot was built on. */
  ackSeq: number;
  acknowledgementAllowed: boolean;
  /** Right end of the window (ISO): what the checkpoint moves to. */
  until: string;
  itemIds: string[];
}

export interface AckCheckpoint {
  ackSeq: number;
  snapshotId: string | null;
  readThrough: string | null;
  receiptId: string | null;
}

export interface AckRequest {
  projectId: string;
  /** The project's current revision. */
  currentRevision: number;
  ackSeq: number;
  /** Cards the reader was shown (all of the snapshot's must be among them). */
  shownIds: string[];
  commandId: string;
}

export type AckDecision =
  | { kind: "accept"; receiptId: string }
  | { kind: "idempotent"; receiptId: string }
  | { kind: "reject"; reason: AckRejection };

/**
 * The confirmation checks in the order of 3.3: project or revision mismatch → the same snapshot
 * again (idempotent, the stored receipt) → ackSeq mismatch → a result that may not be confirmed →
 * cards not shown → nothing to move (the checkpoint is not behind) → no commandId.
 */
export function decideAck(s: AckSnapshot, cp: AckCheckpoint, r: AckRequest): AckDecision {
  if (s.projectId !== r.projectId) return { kind: "reject", reason: "project-mismatch" };
  if (s.revision !== r.currentRevision) return { kind: "reject", reason: "revision-mismatch" };
  if (cp.snapshotId !== null && cp.snapshotId === s.snapshotId && cp.receiptId) return { kind: "idempotent", receiptId: cp.receiptId };
  if (r.ackSeq !== s.ackSeq || s.ackSeq !== cp.ackSeq) return { kind: "reject", reason: "ack-seq-mismatch" };
  if (!s.acknowledgementAllowed) return { kind: "reject", reason: "result-not-acknowledgeable" };
  const shown = new Set(r.shownIds);
  if (!s.itemIds.every((id) => shown.has(id))) return { kind: "reject", reason: "titles-not-shown" };
  if (cp.readThrough !== null && Date.parse(s.until) <= Date.parse(cp.readThrough)) return { kind: "reject", reason: "checkpoint-not-behind" };
  if (!r.commandId.trim()) return { kind: "reject", reason: "command-required" };
  return { kind: "accept", receiptId: receiptIdFor(s.snapshotId, r.commandId) };
}

/**
 * `receipt-` + 8 hex digits of a base-31 rolling hash (32-bit, as Java's String.hashCode) over
 * snapshotId, NUL, commandId: the same command always gets the same receipt.
 */
export function receiptIdFor(snapshotId: string, commandId: string): string {
  let h = 0;
  for (const ch of `${snapshotId}\0${commandId}`) h = (Math.imul(h, 31) + ch.codePointAt(0)!) >>> 0;
  return `receipt-${h.toString(16).padStart(8, "0")}`;
}

/** Per source of the coverage certificate. */
export type CoverageStatus = "checked" | "stale" | "failing" | "never-checked" | "paused";

export interface CoverageEntry {
  sourceId: string;
  name: string;
  required: boolean;
  status: CoverageStatus;
  /** Last successful check (a parsed answer; a bare HTTP 200 is not one). */
  checkedAtUtc: string | null;
}

/** Satisfied when every required source is `checked` with a time (a project with none required is satisfied). */
export function coverageSatisfied(entries: CoverageEntry[]): boolean {
  return entries.every((e) => !e.required || (e.status === "checked" && e.checkedAtUtc !== null));
}
