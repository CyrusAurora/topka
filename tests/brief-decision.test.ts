// The checkpoint decision tables of master design 3.3, row by row (@topka/contracts/brief):
// 1. the top result: every combination of the five conditions gives the first row that holds, in
//    the documented priority (offline-or-auth → snapshot-failed → partial-coverage →
//    abstained-impact → updates-available → no-important-change), and the confirmation permission is
//    bound to the result (the first four may not be confirmed, the last two may);
// 2. the confirmation checks: each rule is reported when it and every later rule fail at once (so
//    the order is the documented one), the same snapshot is idempotent before the sequence check, and
//    the receipt is the documented base-31 hash;
// 3. the coverage certificate: satisfied exactly when every required source is checked with a time.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACK_REJECTIONS, BRIEF_RESULTS, acknowledgementAllowed, coverageSatisfied, decideAck, evaluateBrief, receiptIdFor,
  type AckCheckpoint, type AckRequest, type AckSnapshot, type BriefConditions, type BriefResult, type CoverageEntry,
} from "@topka/contracts/brief";
import { coverageStatus } from "@topka/backend/projects/today";

// ---- 1. top result -------------------------------------------------------------------------
/** The table as the design states it: a row holds → its result, first row wins. */
const RESULT_ROWS: Array<[BriefResult, (c: BriefConditions) => boolean]> = [
  ["offline-or-auth", (c) => c.offlineOrAuth],
  ["snapshot-failed", (c) => c.snapshotFailed],
  ["partial-coverage", (c) => !c.coverageSatisfied],
  ["abstained-impact", (c) => c.unassessed > 0],
  ["updates-available", (c) => c.updates > 0],
  ["no-important-change", () => true],
];

test("the result table has the documented rows in the documented priority", () => {
  assert.deepEqual(RESULT_ROWS.map(([r]) => r), [...BRIEF_RESULTS]);
});

test("every combination of the five conditions gives the first row that holds (32 cells)", () => {
  let cells = 0;
  for (let bits = 0; bits < 32; bits++) {
    const c: BriefConditions = {
      offlineOrAuth: !!(bits & 1), snapshotFailed: !!(bits & 2), coverageSatisfied: !(bits & 4), unassessed: bits & 8 ? 2 : 0, updates: bits & 16 ? 3 : 0,
    };
    const expected = RESULT_ROWS.find(([, holds]) => holds(c))![0];
    assert.equal(evaluateBrief(c), expected, JSON.stringify(c));
    cells += 1;
  }
  assert.equal(cells, 32);
});

test("each result is reached, and the permission is bound to it: the first four refuse, the last two allow", () => {
  const witness: Record<BriefResult, BriefConditions> = {
    "offline-or-auth": { offlineOrAuth: true, snapshotFailed: true, coverageSatisfied: false, unassessed: 1, updates: 1 },
    "snapshot-failed": { offlineOrAuth: false, snapshotFailed: true, coverageSatisfied: false, unassessed: 1, updates: 1 },
    "partial-coverage": { offlineOrAuth: false, snapshotFailed: false, coverageSatisfied: false, unassessed: 1, updates: 1 },
    "abstained-impact": { offlineOrAuth: false, snapshotFailed: false, coverageSatisfied: true, unassessed: 1, updates: 1 },
    "updates-available": { offlineOrAuth: false, snapshotFailed: false, coverageSatisfied: true, unassessed: 0, updates: 1 },
    "no-important-change": { offlineOrAuth: false, snapshotFailed: false, coverageSatisfied: true, unassessed: 0, updates: 0 },
  };
  const allowed: Record<BriefResult, boolean> = {
    "offline-or-auth": false, "snapshot-failed": false, "partial-coverage": false, "abstained-impact": false,
    "updates-available": true, "no-important-change": true,
  };
  for (const r of BRIEF_RESULTS) {
    assert.equal(evaluateBrief(witness[r]), r);
    assert.equal(acknowledgementAllowed(r), allowed[r], r);
  }
});

// ---- 2. confirmation checks ---------------------------------------------------------------
const SNAP: AckSnapshot = {
  snapshotId: "brief-snapshot-v1:" + "0".repeat(32), projectId: "project:x", revision: 2, ackSeq: 4,
  acknowledgementAllowed: true, until: "2026-11-10T12:00:00.000Z", itemIds: ["a1", "a2"],
};
const CP: AckCheckpoint = { ackSeq: 4, snapshotId: "brief-snapshot-v1:" + "f".repeat(32), readThrough: "2026-11-10T08:00:00.000Z", receiptId: "receipt-00000001" };
const REQ: AckRequest = { projectId: "project:x", currentRevision: 2, ackSeq: 4, shownIds: ["a1", "a2"], commandId: "cmd-1" };

/** For each rule, what makes it fail (applied cumulatively from that rule on). */
const BREAK: Record<(typeof ACK_REJECTIONS)[number], (s: AckSnapshot, cp: AckCheckpoint, r: AckRequest) => void> = {
  "project-mismatch": (s) => void (s.projectId = "project:other"),
  "revision-mismatch": (_s, _cp, r) => void (r.currentRevision = 3),
  "ack-seq-mismatch": (_s, _cp, r) => void (r.ackSeq = 3),
  "result-not-acknowledgeable": (s) => void (s.acknowledgementAllowed = false),
  "titles-not-shown": (_s, _cp, r) => void (r.shownIds = ["a1"]),
  "checkpoint-not-behind": (_s, cp) => void (cp.readThrough = "2026-11-10T12:00:00.000Z"),
  "command-required": (_s, _cp, r) => void (r.commandId = "  "),
};

test("each confirmation rule is reported when it and every later rule fail: the documented order", () => {
  assert.deepEqual([...ACK_REJECTIONS], [
    "project-mismatch", "revision-mismatch", "ack-seq-mismatch", "result-not-acknowledgeable", "titles-not-shown", "checkpoint-not-behind", "command-required",
  ]);
  ACK_REJECTIONS.forEach((rule, k) => {
    const s = structuredClone(SNAP); const cp = structuredClone(CP); const r = structuredClone(REQ);
    for (const later of ACK_REJECTIONS.slice(k)) BREAK[later](s, cp, r);
    assert.deepEqual(decideAck(s, cp, r), { kind: "reject", reason: rule }, rule);
    // And alone: the rule by itself is enough.
    const s1 = structuredClone(SNAP); const cp1 = structuredClone(CP); const r1 = structuredClone(REQ);
    BREAK[rule](s1, cp1, r1);
    assert.deepEqual(decideAck(s1, cp1, r1), { kind: "reject", reason: rule }, `${rule} alone`);
  });
});

test("the same snapshot again is idempotent (after the project checks, before the sequence check)", () => {
  const cp = { ...CP, snapshotId: SNAP.snapshotId, ackSeq: 5 };
  // Everything after rule 2 broken: still the stored receipt.
  const r = { ...REQ, ackSeq: 0, shownIds: [], commandId: "" };
  assert.deepEqual(decideAck(SNAP, cp, r), { kind: "idempotent", receiptId: CP.receiptId });
  assert.deepEqual(decideAck({ ...SNAP, projectId: "project:other" }, cp, r), { kind: "reject", reason: "project-mismatch" }, "a project mismatch comes first");
  assert.deepEqual(decideAck(SNAP, { ...cp, receiptId: null }, REQ), { kind: "reject", reason: "ack-seq-mismatch" }, "without a stored receipt there is nothing to repeat");
});

test("a confirmation that passes every rule is accepted with its receipt; the first checkpoint (none yet) is behind anything", () => {
  assert.deepEqual(decideAck(SNAP, CP, REQ), { kind: "accept", receiptId: receiptIdFor(SNAP.snapshotId, "cmd-1") });
  assert.equal(decideAck(SNAP, { ackSeq: 4, snapshotId: null, readThrough: null, receiptId: null }, REQ).kind, "accept");
  assert.equal(decideAck(SNAP, CP, { ...REQ, shownIds: ["a2", "a1", "extra"] }).kind, "accept", "showing more than the snapshot is fine");
});

test("the receipt: receipt- + 8 hex of the base-31 rolling hash of snapshotId NUL commandId, stable per command", () => {
  // Reference values computed independently (Python: h = (h*31 + ord(ch)) & 0xffffffff).
  assert.equal(receiptIdFor(SNAP.snapshotId, "cmd-1"), "receipt-b43f8da7");
  assert.equal(receiptIdFor("a", "b"), "receipt-00016c83");
  assert.equal(receiptIdFor(SNAP.snapshotId, "cmd-1"), receiptIdFor(SNAP.snapshotId, "cmd-1"));
  assert.notEqual(receiptIdFor(SNAP.snapshotId, "cmd-2"), receiptIdFor(SNAP.snapshotId, "cmd-1"));
});

// ---- 3. coverage certificate --------------------------------------------------------------
const entry = (required: boolean, status: CoverageEntry["status"], checkedAtUtc: string | null = "2026-11-10T11:00:00.000Z"): CoverageEntry =>
  ({ sourceId: "s", name: "S", required, status, checkedAtUtc });

test("coverage is satisfied exactly when every required source is checked with a time", () => {
  const rows: Array<[CoverageEntry[], boolean]> = [
    [[], true],
    [[entry(false, "failing"), entry(false, "never-checked", null)], true],
    [[entry(true, "checked")], true],
    [[entry(true, "checked", null)], false],
    [[entry(true, "stale")], false],
    [[entry(true, "failing")], false],
    [[entry(true, "never-checked", null)], false],
    [[entry(true, "paused")], false],
    [[entry(true, "checked"), entry(true, "stale")], false],
  ];
  for (const [entries, satisfied] of rows) assert.equal(coverageSatisfied(entries), satisfied, JSON.stringify(entries));
});

test("a source's coverage status: paused, never checked, failing, stale beyond two intervals (at least an hour), else checked", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const base = { paused: false, enabled: true, health: "ok", lastOkAt: ago(10), intervalMinutes: 30 };
  const rows: Array<[Partial<typeof base>, string]> = [
    [{ paused: true }, "paused"],
    [{ enabled: false }, "paused"],
    [{ lastOkAt: null as never }, "never-checked"],
    [{ health: "failing" }, "failing"],
    [{ lastOkAt: ago(61) }, "stale"],
    [{ lastOkAt: ago(59) }, "checked"],
    [{ intervalMinutes: 1440, lastOkAt: ago(47 * 60) }, "checked"],
    [{ intervalMinutes: 1440, lastOkAt: ago(49 * 60) }, "stale"],
    [{ health: "degraded" }, "checked"],
    [{}, "checked"],
  ];
  for (const [patch, status] of rows) assert.equal(coverageStatus({ ...base, ...patch }, now), status, JSON.stringify(patch));
});
