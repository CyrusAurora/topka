// Creates a tracking project for a registered user and binds sources to it (the same use case as the
// wizard's POST /api/projects). Idempotent: run again with the same goal and it reports the existing
// project and binds any source not yet bound.
//   node --env-file=.env scripts/create-project.ts --owner EMAIL --target TEXT --purpose TEXT --source ID [--source ID ...]
import { parseArgs } from "node:util";
import { closeDb, sql } from "@topka/backend/db";
import { createProject } from "@topka/backend/projects/create-project";
import { bindProjectSources, UnknownSourcesError } from "@topka/backend/projects/bind-sources";

const USAGE = "usage: create-project.ts --owner EMAIL --target TEXT --purpose TEXT --source ID [--source ID ...]";

let values;
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: { owner: { type: "string" }, target: { type: "string" }, purpose: { type: "string" }, source: { type: "string", multiple: true } },
    strict: true,
    allowPositionals: false,
  }));
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}
if (!values.owner || !values.target?.trim() || !values.purpose?.trim() || !values.source?.length) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const [owner] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${values.owner}`;
  if (!owner) {
    console.error(`没有邮箱为 ${values.owner} 的用户：先用邀请码注册`);
    process.exitCode = 1;
  } else {
    const sources = values.source.map((sourceId) => ({ sourceId, required: false }));
    const { project, created } = await createProject({ ownerId: owner.id, target: values.target, purpose: values.purpose, sources });
    if (!created) await bindProjectSources(project.id, sources);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM project_sources WHERE project_id = ${project.id}`;
    console.log(`${created ? "已创建" : "已存在"}项目：${project.id}`);
    console.log(`绑定信源：${n} 个`);
  }
} catch (error) {
  if (!(error instanceof UnknownSourcesError)) throw error;
  console.error(`这些信源不存在：${error.sourceIds.join("、")}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
