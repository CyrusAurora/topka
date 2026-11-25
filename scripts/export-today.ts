// Writes each project's today payload (GET /api/projects/:id/today, as its owner sees it) to
// <out>/<slug>.json, for external sync clients (e.g. a mobile client). Exporting never moves a checkpoint.
//   node --env-file=.env scripts/export-today.ts [--project ID_OR_SLUG ...] [--user EMAIL ...] [--out DIR]
// Default: every active project, into <TOPKA_DATA_DIR>/snapshots (/data/snapshots under Docker). --user writes the user's own today across all their
// projects (今日) to <out>/user-<user id>.json.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { config } from "@topka/backend/config";
import { closeDb, sql } from "@topka/backend/db";
import { requireProjectOwner } from "@topka/backend/publication/project-owner";
import { buildToday } from "@topka/backend/projects/today";
import { buildUserToday } from "@topka/backend/projects/user-today";

const USAGE = "usage: export-today.ts [--project ID_OR_SLUG ...] [--user EMAIL ...] [--out DIR]";
let values;
try {
  ({ values } = parseArgs({ args: process.argv.slice(2), options: { project: { type: "string", multiple: true }, user: { type: "string", multiple: true }, out: { type: "string" } }, strict: true, allowPositionals: false }));
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}
const out = resolve(values.out ?? join(config.dataDir, "snapshots"));

try {
  if (values.user?.length) {
    mkdirSync(out, { recursive: true });
    for (const email of values.user) {
      const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
      if (!u) {
        console.error(`没有邮箱为 ${email} 的用户`);
        process.exitCode = 1;
        continue;
      }
      const payload = await buildUserToday(u.id, { record: true });
      const file = join(out, `user-${u.id}.json`);
      writeFileSync(`${file}.tmp`, `${JSON.stringify(payload, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
      console.log(`${file}\t${payload.result}\t${payload.items.length}/${payload.cardCount} 张卡${payload.quietDay ? "（平淡日）" : ""}\t${payload.projects.length} 个项目`);
    }
    if (!values.project?.length) process.exit();
  }
  const wanted = values.project ?? [];
  const rows = await sql<{ id: string; owner_id: string; slug: string }[]>`
    SELECT id, owner_id, slug FROM tracking_projects
    WHERE ${wanted.length ? sql`(id IN ${sql(wanted)} OR slug IN ${sql(wanted)})` : sql`status = 'active'`} ORDER BY created_at, id`;
  const missing = wanted.filter((w) => !rows.some((r) => r.id === w || r.slug === w));
  if (missing.length) {
    console.error(`没有这些项目：${missing.join("、")}`);
    process.exitCode = 1;
  }
  mkdirSync(out, { recursive: true });
  for (const r of rows) {
    const access = await requireProjectOwner(r.owner_id, r.id);
    if (access.kind !== "ok") continue;
    const payload = await buildToday(access.project, r.owner_id, { record: true });
    const file = join(out, `${r.slug}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    console.log(`${file}\t${payload.result}\t${payload.items.length}/${payload.cardCount} 张卡${payload.quietDay ? "（平淡日）" : ""}\t${access.project.target}`);
  }
} finally {
  await closeDb();
}
