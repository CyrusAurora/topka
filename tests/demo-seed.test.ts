// The offline demo seed (scripts/demo.ts): it refuses a database with other content unless --force,
// fills the demo reader's 今日 with three complete cards plus two earlier days, and a re-run adds nothing.
import "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { buildUserIssue, listPastIssues } from "@topka/backend/projects/issues";

const run = promisify(execFile);
const script = new URL("../scripts/demo.ts", import.meta.url).pathname;
const env = { ...process.env, DEMO_PASSWORD: "demo-test-password-1", DEMO_SEED: "" };
after(async () => {
  await closeDb();
});

test("--if-enabled without DEMO_SEED=true does nothing and exits 0", async () => {
  const before = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE email = 'demo@example.com'`)[0]!.n;
  const r = await run(process.execPath, [script, "--if-enabled"], { env });
  assert.equal(r.stdout, "");
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE email = 'demo@example.com'`)[0]!.n, before);
});

test("a database with another user is refused without --force", async () => {
  await sql`INSERT INTO users (id, email, password_hash) VALUES ('demo-seed-test-other', 'demo-seed-other@example.com', 'x') ON CONFLICT DO NOTHING`;
  await assert.rejects(run(process.execPath, [script], { env }), (e: { code?: number; stderr?: string }) => e.code === 1 && /refusing/.test(e.stderr ?? ""));
});

test("--force seeds three complete cards today and two earlier days; a re-run duplicates nothing", async () => {
  const counts = async () => (await sql<{ a: number; i: number; u: number }[]>`
    SELECT (SELECT count(*)::int FROM articles WHERE source_id LIKE 'demo-%') AS a,
           (SELECT count(*)::int FROM user_issue_items ui JOIN users u ON u.id = ui.user_id WHERE u.email = 'demo@example.com') AS i,
           (SELECT count(*)::int FROM users WHERE email = 'demo@example.com') AS u`)[0]!;
  await run(process.execPath, [script, "--force"], { env });
  const first = await counts();
  await run(process.execPath, [script, "--force"], { env });
  assert.deepEqual(await counts(), first);
  assert.deepEqual(first, { a: 9, i: 9, u: 1 });
  const [{ id }] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = 'demo@example.com'`;
  const payload = await buildUserIssue(id);
  assert.equal(payload.issue?.items.length, 3);
  for (const item of payload.issue!.items) {
    assert.ok(item.title_a && item.core_a && item.summary.length > 40, item.title_a);
    assert.match(item.url, /^https:\/\/example\.org\//);
  }
  assert.equal((await listPastIssues(id)).length, 2);
});
