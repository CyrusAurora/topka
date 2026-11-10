// Issue timing helpers and the hero rule: 08:00 local in the user's timezone fixes the issue (see
// ADR 0004); the Shanghai default coincides with the UTC date as before. ISSUE_HERO_LEAD accepts only
// an integer 0..100 and otherwise falls back to 10.
import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarDateInTz, capPerSource, currentIssueDate, currentIssueDateInTz, heroLead, isHero, isValidTimeZone, issueCutoff, issueCutoffInTz, MAX_PER_SOURCE, nextIssueAt, nextIssueAtInTz, taipeiDate } from "@topka/backend/projects/issue-rules";

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

test("the issue on display before 08:00 local is the previous date — 08:00 Shanghai flips it", () => {
  assert.equal(currentIssueDate(new Date("2026-10-22T23:59:59Z")), "2026-10-22");
  assert.equal(currentIssueDate(new Date("2026-10-23T00:00:00Z")), "2026-10-23");
});

test("Shanghai parity (ADR 0004 golden): 2020-01-02T00:00:00Z is that day's issue from 08:00 Shanghai", () => {
  assert.equal(currentIssueDateInTz(new Date("2020-01-02T00:00:00.000Z"), "Asia/Shanghai"), "2020-01-02");
  assert.equal(issueCutoffInTz("2020-01-02", "Asia/Shanghai").toISOString(), "2020-01-02T00:00:00.000Z");
  assert.equal(nextIssueAtInTz(new Date("2020-01-02T00:00:00.000Z"), "Asia/Shanghai").toISOString(), "2020-01-03T00:00:00.000Z");
});

test("New York (ADR 0004 golden): 08:00 EST is 13:00Z, before that the previous local date shows", () => {
  assert.equal(issueCutoffInTz("2020-01-02", "America/New_York").toISOString(), "2020-01-02T13:00:00.000Z");
  assert.equal(currentIssueDateInTz(new Date("2020-01-02T13:00:00.000Z"), "America/New_York"), "2020-01-02");
  assert.equal(currentIssueDateInTz(new Date("2020-01-02T12:59:00.000Z"), "America/New_York"), "2020-01-01");
  assert.equal(nextIssueAtInTz(new Date("2020-01-02T12:59:00.000Z"), "America/New_York").toISOString(), "2020-01-02T13:00:00.000Z");
  assert.equal(nextIssueAtInTz(new Date("2020-01-02T13:00:00.000Z"), "America/New_York").toISOString(), "2020-01-03T13:00:00.000Z");
  // EDT is UTC-4, so a July morning is 12:00Z.
  assert.equal(issueCutoffInTz("2020-07-02", "America/New_York").toISOString(), "2020-07-02T12:00:00.000Z");
});

test("London DST (ADR 0004 golden): cutoff is the Intl-resolved local 08:00, spring and fall", () => {
  // Spring-forward day (2020-03-29): 08:00 BST is 07:00Z, not the winter 08:00Z.
  assert.equal(issueCutoffInTz("2020-03-29", "Europe/London").toISOString(), "2020-03-29T07:00:00.000Z");
  assert.equal(currentIssueDateInTz(new Date("2020-03-29T07:00:00.000Z"), "Europe/London"), "2020-03-29");
  assert.equal(currentIssueDateInTz(new Date("2020-03-29T06:59:00.000Z"), "Europe/London"), "2020-03-28");
  assert.equal(nextIssueAtInTz(new Date("2020-03-29T07:00:00.000Z"), "Europe/London").toISOString(), "2020-03-30T07:00:00.000Z");
  // Fall-back day (2020-10-25): 08:00 GMT is 08:00Z again.
  assert.equal(issueCutoffInTz("2020-10-25", "Europe/London").toISOString(), "2020-10-25T08:00:00.000Z");
  assert.equal(currentIssueDateInTz(new Date("2020-10-25T07:59:00.000Z"), "Europe/London"), "2020-10-24");
  assert.equal(currentIssueDateInTz(new Date("2020-10-25T08:00:00.000Z"), "Europe/London"), "2020-10-25");
  assert.equal(nextIssueAtInTz(new Date("2020-10-25T07:59:00.000Z"), "Europe/London").toISOString(), "2020-10-25T08:00:00.000Z");
});

test("Tokyo (ADR 0004 golden): local 08:00 is 23:00Z the previous UTC day, not Shanghai's midnight", () => {
  assert.equal(issueCutoffInTz("2020-01-02", "Asia/Tokyo").toISOString(), "2020-01-01T23:00:00.000Z");
  assert.equal(calendarDateInTz(new Date("2020-01-01T23:00:00.000Z"), "Asia/Tokyo"), "2020-01-02");
  assert.equal(currentIssueDateInTz(new Date("2020-01-01T23:00:00.000Z"), "Asia/Tokyo"), "2020-01-02");
  assert.equal(currentIssueDateInTz(new Date("2020-01-01T22:59:00.000Z"), "Asia/Tokyo"), "2020-01-01");
  assert.notEqual(issueCutoffInTz("2020-01-02", "Asia/Tokyo").toISOString(), issueCutoffInTz("2020-01-02", "Asia/Shanghai").toISOString());
});

test("isValidTimeZone accepts IANA names and rejects junk", () => {
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("Europe/London"), true);
  assert.equal(isValidTimeZone("Asia/Tokyo"), true);
  assert.equal(isValidTimeZone("Foo/Bar"), false);
  assert.equal(isValidTimeZone("UTC+8"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone("America/New_York "), false);
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
  assert.deepEqual(ids(capPerSource(ranked, 3, (x) => x.src, [], (x) => x.id !== "a1")), ["a2", "a3", "b1"], "a rejected card takes no place under the cap");
});
