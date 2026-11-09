// Issue timing helpers and the hero rule: 08:00 Taipei is 00:00 UTC, so the issue on display is
// the UTC date; ISSUE_HERO_LEAD accepts only an integer 0..100 and otherwise falls back to 10.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capPerSource, currentIssueDate, heroLead, isHero, issueCutoff, MAX_PER_SOURCE, nextIssueAt, taipeiDate } from "@topka/backend/projects/issue-rules";

test("heroLead keeps only an integer 0..100, everything else becomes 10", () => {
  assert.equal(heroLead(""), 10);
  assert.equal(heroLead("15"), 15);
  assert.equal(heroLead("-1"), 10);
  assert.equal(heroLead("abc"), 10);
  assert.equal(heroLead("0"), 0);
  assert.equal(heroLead("12.5"), 10);
  assert.equal(heroLead("101"), 10);
  assert.equal(heroLead(undefined), 10);
});

test("isHero needs exactly three scored items and a lead of at least the configured points", () => {
  assert.equal(isHero([91, 76, 74], 10), true);
  assert.equal(isHero([82, 80, 77], 10), false);
  assert.equal(isHero([91, 76], 10), false);
  assert.equal(isHero([null, 10, 5], 10), false);
  assert.equal(isHero([90, 80, 1], 10), true);
});

test("the issue on display is the UTC date — 08:00 Taipei flips it", () => {
  assert.equal(currentIssueDate(new Date("2026-10-22T23:59:59Z")), "2026-10-22");
  assert.equal(currentIssueDate(new Date("2026-10-23T00:00:00Z")), "2026-10-23");
});

test("the cutoff is 08:00 Taipei and the next issue is the next 00:00 UTC strictly after now", () => {
  assert.equal(issueCutoff("2026-10-23").toISOString(), "2026-10-23T00:00:00.000Z");
  assert.equal(nextIssueAt(new Date("2026-10-23T00:00:00Z")).toISOString(), "2026-10-24T00:00:00.000Z");
  assert.equal(nextIssueAt(new Date("2026-10-22T23:59:59Z")).toISOString(), "2026-10-23T00:00:00.000Z");
});

test("the Taipei date is UTC+8", () => {
  assert.equal(taipeiDate(new Date("2026-10-22T16:00:00Z")), "2026-10-23");
  assert.equal(taipeiDate(new Date("2026-10-22T15:59:59Z")), "2026-10-22");
});

test("capPerSource: at most MAX_PER_SOURCE per source, order kept, taken counted, fewer rather than filler", () => {
  const c = (id: string, src: string) => ({ id, src });
  const ranked = [c("a1", "A"), c("a2", "A"), c("a3", "A"), c("b1", "B"), c("a4", "A"), c("c1", "C")];
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);
  assert.equal(MAX_PER_SOURCE, 2);
  assert.deepEqual(ids(capPerSource(ranked, 3, (x) => x.src)), ["a1", "a2", "b1"]);
  assert.deepEqual(ids(capPerSource(ranked, 5, (x) => x.src)), ["a1", "a2", "b1", "c1"], "only four fit under the cap");
  assert.deepEqual(ids(capPerSource([c("a1", "A"), c("a2", "A"), c("a3", "A")], 3, (x) => x.src)), ["a1", "a2"], "one source: two cards");
  assert.deepEqual(ids(capPerSource(ranked, 3, (x) => x.src, [c("x", "A")])), ["a1", "b1"], "taken cards count toward the cap and the size");
  assert.deepEqual(capPerSource([], 3, (x: { src: string }) => x.src), []);
});
