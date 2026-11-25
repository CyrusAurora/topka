// The worker's one-line report of a source fetch. A run that brought nothing new and did not fail says
// nothing: a quiet install makes over a thousand runs a day, and a log nobody can read is not a log.
import type { CollectResult } from "./collect.ts";

export interface FetchLogLine {
  level: "info" | "warn";
  line: string;
}

export function fetchLogLine(result: CollectResult): FetchLogLine | null {
  if (result.status === "failed") {
    return { level: "warn", line: JSON.stringify({ level: "warn", msg: "source fetch failed", source: result.sourceId, error: result.error ?? "unknown" }) };
  }
  if (result.status === "ok" && (result.created > 0 || result.revised > 0)) {
    return { level: "info", line: JSON.stringify({ level: "info", msg: "source fetch", source: result.sourceId, found: result.found, new: result.created, revised: result.revised }) };
  }
  return null;
}
