// The worker's per-fetch log line: what an operator watching `docker compose logs -f worker` sees.
// A quiet install runs over a thousand fetches a day, so a run with nothing new must stay silent.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchLogLine } from "@topka/backend/sources/fetch-log";

const base = { sourceId: `src-${tag()}`, found: 0, created: 0, revised: 0 };

test("a fetch that stored something is logged, as info", () => {
  const log = fetchLogLine({ ...base, status: "ok", found: 8, created: 8 });
  assert.equal(log?.level, "info");
  const parsed = JSON.parse(log!.line) as Record<string, unknown>;
  assert.equal(parsed.msg, "source fetch");
  assert.equal(parsed.new, 8);
  assert.equal(parsed.found, 8);
  assert.equal(parsed.source, base.sourceId);
  // A revised title is worth a line even with nothing new.
  assert.equal(fetchLogLine({ ...base, status: "ok", revised: 1 })?.level, "info");
});

test("a fetch with nothing new stays silent, and so does a skipped source", () => {
  assert.equal(fetchLogLine({ ...base, status: "ok", found: 0 }), null);
  assert.equal(fetchLogLine({ ...base, status: "skipped", error: "paused" }), null);
});

test("a failed fetch is logged as a warning with its error", () => {
  const log = fetchLogLine({ ...base, status: "failed", error: "HTTP 500" });
  assert.equal(log?.level, "warn");
  const parsed = JSON.parse(log!.line) as Record<string, unknown>;
  assert.equal(parsed.msg, "source fetch failed");
  assert.equal(parsed.error, "HTTP 500");
  // One line only: the message is a single JSON object, not a stack trace.
  assert.equal(log!.line.split("\n").length, 1);
});
