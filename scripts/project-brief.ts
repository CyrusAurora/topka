// Sets a tracking project's optional focus and exclusions, which project scoring reads as part of the
// reader's intent (industry/prompts/project-score.md). Changing them makes the next scores new requests.
//   node --env-file=.env scripts/project-brief.ts --project ID_OR_SLUG [--focus TEXT] [--exclusions TEXT]
import { parseArgs } from "node:util";
import { closeDb, sql } from "@topka/backend/db";

const USAGE = "usage: project-brief.ts --project ID_OR_SLUG [--focus TEXT] [--exclusions TEXT]";
let values;
try {
  ({ values } = parseArgs({ args: process.argv.slice(2), options: { project: { type: "string" }, focus: { type: "string" }, exclusions: { type: "string" } }, strict: true, allowPositionals: false }));
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}
if (!values.project) {
  console.error(USAGE);
  process.exit(2);
}
try {
  const [row] = await sql<{ target: string; purpose: string; focus: string; exclusions: string }[]>`
    UPDATE tracking_projects SET focus = coalesce(${values.focus?.trim() ?? null}, focus), exclusions = coalesce(${values.exclusions?.trim() ?? null}, exclusions), updated_at = now()
    WHERE id = ${values.project} OR slug = ${values.project}
    RETURNING target, purpose, focus, exclusions`;
  if (!row) {
    console.error(`没有这个项目：${values.project}`);
    process.exitCode = 1;
  } else {
    console.log(`对象：${row.target}\n目标：${row.purpose}\n关注重点：${row.focus || "（无）"}\n排除：${row.exclusions || "（无）"}`);
  }
} finally {
  await closeDb();
}
