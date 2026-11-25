import assert from "node:assert/strict";
import { test } from "node:test";
import { issueDayIn } from "../app/lib/issue-day.ts";
import { currentIssueDateInTz } from "../../../packages/backend/src/projects/issue-rules.ts";

test("the masthead's issue day is the reader's: 08:00 in their own time zone", () => {
  // 19:40 in Taipei is 06:40 in New York: the New York reader is still on yesterday's issue.
  assert.equal(issueDayIn(new Date("2026-11-10T11:40:00Z"), "America/New_York"), "2026-11-09");
  assert.equal(issueDayIn(new Date("2026-11-10T11:40:00Z"), "Asia/Shanghai"), "2026-11-10");
  assert.equal(issueDayIn(new Date("2026-11-09T23:59:59Z"), "Asia/Shanghai"), "2026-11-09");
  assert.equal(issueDayIn(new Date("2026-11-10T00:00:00Z"), "Asia/Shanghai"), "2026-11-10");
});

test("the web's issue day equals the backend's for every hour of a year across zones (DST included)", () => {
  const zones = ["Asia/Shanghai", "America/New_York", "Europe/London", "Australia/Sydney", "Pacific/Chatham", "America/St_Johns", "UTC"];
  for (const tz of zones) {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3 * 3_600_000 + 17 * 60_000) {
      const now = new Date(t);
      assert.equal(issueDayIn(now, tz), currentIssueDateInTz(now, tz), `${tz} at ${now.toISOString()}`);
    }
  }
});
