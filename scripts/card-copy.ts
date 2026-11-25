// Writes the phone-card copy for a user's current top cards (free models only, within the background
// budget; chat's reserve is kept), then prints the cards as they will read.
//   node --env-file=.env scripts/card-copy.ts --email EMAIL [--dry]
import { parseArgs } from "node:util";
import { closeDb, sql } from "@topka/backend/db";
import { stopBoss } from "@topka/backend/jobs/queue";
import { cardWidth } from "@topka/backend/projects/card-copy";
import { loadPlugins } from "@topka/backend/plugins";
import { buildUserToday, writeUserCardCopy } from "@topka/backend/projects/user-today";

await loadPlugins();

const { values } = parseArgs({ options: { email: { type: "string" }, dry: { type: "boolean" } }, strict: true });
try {
  const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${values.email ?? ""}`;
  if (!u) throw new Error(`没有邮箱为 ${values.email} 的用户`);
  if (!values.dry) console.log(JSON.stringify(await writeUserCardCopy(u.id)));
  const today = await buildUserToday(u.id);
  for (const i of today.items) {
    const c = i.card;
    console.log(`\n[${i.score}] ${i.project.target} · ${i.source.name}`);
    if (!c) console.log(`  (no card copy) ${i.title}`);
    else console.log(`  ${c.title}  (${cardWidth(c.title)})\n  ${c.lead}  (${cardWidth(c.lead)})\n  → ${c.why}  (${cardWidth(c.why)})`);
  }
} finally {
  await stopBoss();
  await closeDb();
}
