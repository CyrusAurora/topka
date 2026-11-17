// Scrubs a copy of the database of personal data (operations/anonymize.ts) and checks the result.
//   STAGING_PASSWORD=… node --env-file=staging.env scripts/anonymize.ts [--password-env NAME]
// Refuses a database whose name does not say staging, restore, drill, scratch, _ci or _test.
// Prints counts only. Exit 0 clean, 1 refused or something left, 2 usage.
import { parseArgs } from "node:util";
import { closeDb, sql } from "@topka/backend/db";
import { anonymize, personalDataLeft } from "@topka/backend/operations/anonymize";

const { values } = parseArgs({ args: process.argv.slice(2), options: { "password-env": { type: "string" } }, strict: true });
const name = values["password-env"] ?? "STAGING_PASSWORD";
const password = process.env[name] ?? "";
if (!password) {
  console.error(`anonymize: set ${name} (the one password every account on the copy gets)`);
  process.exit(2);
}
try {
  const report = await sql.begin((tx) => anonymize(tx, { password }));
  console.log(`anonymize: ${Object.entries(report).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const left = await personalDataLeft(sql);
  if (left.length) {
    console.error(`anonymize: NOT clean:\n  ${left.join("\n  ")}`);
    process.exitCode = 1;
  } else console.log("anonymize: clean (no personal data left in the checked tables)");
} catch (e) {
  console.error(String((e as Error).message ?? e));
  process.exitCode = 1;
} finally {
  await closeDb();
}
