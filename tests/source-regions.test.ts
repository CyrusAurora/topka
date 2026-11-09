// Source regions (ADR 0004 item E, acceptance test 7): `global` is always visible, an empty filter
// shows everything, and region is a discovery filter only — binding is never rejected by region.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SOURCE_REGION_TOKENS,
  isValidRegionToken,
  normalizeRegions,
  parseRegionFilter,
  sourceMatchesRegionFilter,
} from "@topka/contracts/regions";

test("region tokens are the short recommended set", () => {
  assert.deepEqual([...SOURCE_REGION_TOKENS], ["global", "cn", "us", "eu", "jp"]);
  assert.equal(isValidRegionToken("global"), true);
  assert.equal(isValidRegionToken("cn"), true);
  assert.equal(isValidRegionToken("us"), true);
  // Pragmatic: any lowercase token is stored (e.g. a future "kr"), so seeds aren't blocked; the
  // list above is what the UI offers.
  assert.equal(isValidRegionToken("kr"), true);
  assert.equal(isValidRegionToken("zh-cn"), true);
  assert.equal(isValidRegionToken(""), false);
  assert.equal(isValidRegionToken("CN"), false, "tokens are stored lowercase");
  assert.equal(isValidRegionToken("c n"), false);
  assert.equal(isValidRegionToken("cn!"), false);
  assert.equal(isValidRegionToken("-cn"), false);
});

test("normalizeRegions lowercases, dedupes and defaults to global", () => {
  assert.deepEqual(normalizeRegions(["CN", " cn ", "US"]), ["cn", "us"]);
  assert.deepEqual(normalizeRegions(["global", "cn", "cn"]), ["global", "cn"]);
  assert.deepEqual(normalizeRegions([]), ["global"]);
  assert.deepEqual(normalizeRegions(null), ["global"]);
  assert.deepEqual(normalizeRegions("cn"), ["global"], "non-array input falls back");
  assert.deepEqual(normalizeRegions(["", "  ", 42, null]), ["global"]);
  assert.deepEqual(normalizeRegions(["cn", "", "!!"]), ["cn"]);
});

test("parseRegionFilter accepts comma- or space-separated values", () => {
  assert.deepEqual(parseRegionFilter(null), []);
  assert.deepEqual(parseRegionFilter(undefined), []);
  assert.deepEqual(parseRegionFilter(""), []);
  assert.deepEqual(parseRegionFilter("cn"), ["cn"]);
  assert.deepEqual(parseRegionFilter("cn,us"), ["cn", "us"]);
  assert.deepEqual(parseRegionFilter("CN, US"), ["cn", "us"]);
  assert.deepEqual(parseRegionFilter("cn us eu"), ["cn", "us", "eu"]);
  assert.deepEqual(parseRegionFilter("cn,, us"), ["cn", "us"]);
  assert.deepEqual(parseRegionFilter("cn,cn"), ["cn"]);
  assert.deepEqual(parseRegionFilter("!!,cn"), ["cn"]);
});

test("empty filter shows every source, including a US-only one", () => {
  assert.equal(sourceMatchesRegionFilter(["us"], []), true);
  assert.equal(sourceMatchesRegionFilter(["cn"], []), true);
  assert.equal(sourceMatchesRegionFilter(["global"], []), true);
  assert.equal(sourceMatchesRegionFilter([], []), true);
});

test("filter cn hides {us} but shows {global}, {cn,global} and {cn}", () => {
  const filter = ["cn"];
  assert.equal(sourceMatchesRegionFilter(["us"], filter), false);
  assert.equal(sourceMatchesRegionFilter(["eu"], filter), false);
  assert.equal(sourceMatchesRegionFilter(["global"], filter), true, "global is always visible");
  assert.equal(sourceMatchesRegionFilter(["cn", "global"], filter), true);
  assert.equal(sourceMatchesRegionFilter(["cn"], filter), true);
  assert.equal(sourceMatchesRegionFilter(["cn", "us"], filter), true, "any overlap matches");
});

test("filter matching is case-insensitive on both sides", () => {
  assert.equal(sourceMatchesRegionFilter(["CN"], ["cn"]), true);
  assert.equal(sourceMatchesRegionFilter(["cn"], ["CN"]), true);
  assert.equal(sourceMatchesRegionFilter(["Us"], ["CN"]), false);
  assert.equal(sourceMatchesRegionFilter(["GLOBAL"], ["cn"]), true);
});

test("multi-region filter is an overlap (any-match) rule", () => {
  assert.equal(sourceMatchesRegionFilter(["us"], ["cn", "us"]), true);
  assert.equal(sourceMatchesRegionFilter(["jp"], ["cn", "us"]), false);
  assert.equal(sourceMatchesRegionFilter(["eu"], ["cn", "us"]), false);
  assert.equal(sourceMatchesRegionFilter(["global"], ["cn", "us"]), true);
});
