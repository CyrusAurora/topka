// The project layer (master design 3.2/3.4/8.2 step 3): derived project ids, the creation use case
// with revision 1 and core source bindings, pack preferences, the curated pack catalog and the read
// layer's owner gate — plus the /api endpoints with row-level isolation. User-facing copy is locked.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { createInvite } from "@topka/backend/accounts/invite";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { createSession, SESSION_COOKIE } from "@topka/backend/accounts/session";
import { userTag, deriveProjectId } from "@topka/backend/projects/derive-id";
import { createProject, ProjectRejected } from "@topka/backend/projects/create-project";
import { bindProjectSources, UnknownSourcesError } from "@topka/backend/projects/bind-sources";
import { loadPackPrefs, savePackPrefs } from "@topka/backend/projects/pack-prefs";
import { listSourcePacks } from "@topka/backend/projects/packs";
import { requireProjectOwner } from "@topka/backend/publication/project-owner";
import { buildApp } from "../apps/api/src/app.ts";

const T = `proj-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `${T}-long-enough`;
const app = await buildApp();
after(async () => {
  await app.close();
  await closeDb();
});

let n = 0;
const email = () => `user${++n}-${T}@example.com`;
async function newUser() {
  const code = (await createInvite({ createdBy: `tester-${T}`, maxUses: 1, expiresInDays: 7, note: `test ${T}` })).code;
  return registerWithInvite({ code, email: email(), password: PASSWORD, userAgent: "test", ip: "203.0.113.40" });
}
function cookieOf(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

// --- domain: derived ids ----------------------------------------------------

test("project id derivation is stable, lowercases its parts and separates users", async () => {
  const userA = (await newUser()).user.id;
  const userB = (await newUser()).user.id;
  const id = deriveProjectId("AI 模型跟踪", "跟踪发布和价格", userA);
  assert.equal(id, deriveProjectId("AI 模型跟踪", "跟踪发布和价格", userA), "the same inputs derive the same id");
  assert.equal(id, deriveProjectId("ai 模型跟踪", "跟踪发布和价格".toUpperCase(), userA), "letter case is folded before encoding: jitter means no change");
  assert.ok(id.startsWith("project:"), id);
  assert.match(id.slice(-8), /^[0-9a-f]{8}$/, "the user part is the first 8 hex chars of the user's identity hash");
  assert.equal(id.slice(-8), userTag(userA));
  assert.notEqual(deriveProjectId("AI 模型跟踪", "跟踪发布和价格", userB), id, "the same goal under another user derives another id");
  assert.ok(id.includes("%20") || !id.includes(" "), "spaces ride through URL encoding");
});

// --- domain: creation -------------------------------------------------------

async function packSourceIds(count: number): Promise<string[]> {
  const packs = await listSourcePacks();
  return packs[0]!.sources.slice(0, count).map((s) => s.id);
}

test("createProject refuses an empty target or purpose and writes nothing", async () => {
  const user = (await newUser()).user;
  const sources = await packSourceIds(1);
  await assert.rejects(
    () => createProject({ ownerId: user.id, target: "   ", purpose: "目的", sources: sources.map((id) => ({ sourceId: id, required: false })) }),
    (error: unknown) => error instanceof ProjectRejected && error.reason === "empty-target",
  );
  await assert.rejects(
    () => createProject({ ownerId: user.id, target: "目标", purpose: "", sources: [] }),
    (error: unknown) => error instanceof ProjectRejected && error.reason === "empty-purpose",
  );
  assert.equal((await sql`SELECT count(*)::int AS n FROM tracking_projects WHERE owner_id = ${user.id}`)[0]!.n, 0);
});

test("createProject writes the project, revision 1 and core bindings, and is idempotent per user", async () => {
  const user = (await newUser()).user;
  const sources = await packSourceIds(2);
  const first = await createProject({
    ownerId: user.id,
    target: "AI 模型跟踪",
    purpose: "跟踪发布和价格",
    sources: sources.map((id, i) => ({ sourceId: id, required: i === 0 })),
  });
  assert.equal(first.created, true);
  const id = first.project.id;
  assert.ok(id.startsWith(`project:`), id);
  assert.equal(first.project.currentRevision, 1);
  assert.equal(first.project.status, "active");
  assert.equal(first.project.ownerId, user.id);

  const [revision] = await sql<{ revision: number; target: string; purpose: string; previous_version_id: string | null; needs_rebaseline: boolean }[]>`
    SELECT revision, target, purpose, previous_version_id, needs_rebaseline FROM project_revisions WHERE project_id = ${id}`;
  assert.deepEqual([revision!.revision, revision!.target, revision!.purpose, revision!.previous_version_id, revision!.needs_rebaseline],
    [1, "AI 模型跟踪", "跟踪发布和价格", null, true], "revision 1 carries the founding target/purpose and asks for a baseline");

  const bound = await sql<{ source_id: string; role: string; required: boolean }[]>`
    SELECT source_id, role, required FROM project_sources WHERE project_id = ${id} ORDER BY source_id`;
  assert.equal(bound.length, 2);
  for (const row of bound) assert.equal(row.role, "core", "wizard picks bind as core sources");

  // Same goal, letter case jittered: the derived id is unchanged, so the existing project returns
  // as-is — no second revision, no rebinding.
  const again = await createProject({
    ownerId: user.id,
    target: "ai 模型跟踪",
    purpose: "跟踪发布和价格",
    sources: sources.map((id) => ({ sourceId: id, required: false })),
  });
  assert.equal(again.created, false);
  assert.equal(again.project.id, id);
  assert.equal((await sql`SELECT count(*)::int AS n FROM project_revisions WHERE project_id = ${id}`)[0]!.n, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM project_sources WHERE project_id = ${id}`)[0]!.n, 2);
});

test("the same goal under a different user becomes a different project", async () => {
  const userA = (await newUser()).user;
  const userB = (await newUser()).user;
  const target = `开源与开发者 ${T}`;
  const a = await createProject({ ownerId: userA.id, target, purpose: "盯 release", sources: [] });
  const b = await createProject({ ownerId: userB.id, target, purpose: "盯 release", sources: [] });
  assert.notEqual(a.project.id, b.project.id);
  assert.equal((await sql`SELECT count(*)::int AS n FROM tracking_projects WHERE target = ${target} AND purpose = '盯 release'`)[0]!.n, 2);
});

test("bindProjectSources deduplicates its input and refuses unknown sources", async () => {
  const user = (await newUser()).user;
  const sources = await packSourceIds(2);
  const { project } = await createProject({ ownerId: user.id, target: "绑定去重", purpose: "目的", sources: [] });
  await bindProjectSources(project.id, sources.flatMap((id) => [{ sourceId: id, required: true }, { sourceId: id, required: false }]));
  assert.equal((await sql`SELECT count(*)::int AS n FROM project_sources WHERE project_id = ${project.id}`)[0]!.n, 2, "a repeated id binds once");
  const [row] = await sql<{ required: boolean }[]>`SELECT required FROM project_sources WHERE project_id = ${project.id} AND source_id = ${sources[0]}`;
  assert.equal(row!.required, true, "the first binding's required flag stands");

  await assert.rejects(
    () => bindProjectSources(project.id, [{ sourceId: `ghost-${T}`, required: false }]),
    (error: unknown) => error instanceof UnknownSourcesError && error.sourceIds.length === 1,
  );
  assert.equal((await sql`SELECT count(*)::int AS n FROM project_sources WHERE project_id = ${project.id}`)[0]!.n, 2, "a refused binding writes nothing");
});

// --- domain: pack preferences and the catalog -------------------------------

test("pack preferences round-trip and the latest write wins", async () => {
  const user = (await newUser()).user;
  assert.equal(await loadPackPrefs(user.id), null, "a user without prefs loads none");
  const first = await savePackPrefs(user.id, { packId: "ai-models", picks: ["s2", "s1", "s2"] });
  assert.deepEqual([first.packId, first.picks], ["ai-models", ["s2", "s1"]], "picks keep their order and lose duplicates");
  await savePackPrefs(user.id, { packId: "opensource-dev", picks: ["s9"] });
  const loaded = await loadPackPrefs(user.id);
  assert.deepEqual([loaded!.packId, loaded!.picks], ["opensource-dev", ["s9"]], "one preference row per user, upserted");
});

test("the pack catalog lists the four curated packs with their sources and availability", async () => {
  const packs = await listSourcePacks();
  assert.deepEqual(packs.map((p) => p.id), ["ai-models", "embodied-ai", "opensource-dev", "semiconductor"]);
  const counts = new Map(packs.map((p) => [p.id, p.sources.length]));
  assert.deepEqual([...counts.entries()], [["ai-models", 14], ["embodied-ai", 8], ["opensource-dev", 9], ["semiconductor", 6]]);
  for (const pack of packs) {
    for (const source of pack.sources) {
      assert.ok(source.id && source.name, `a pack source carries its id and name (${pack.id})`);
      assert.equal(typeof source.publisher === "string" || source.publisher === null, true);
    }
    // Availability: at least one of the pack's source ids exists in `sources` as an editorial source.
    const [check] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sources WHERE id IN ${sql(pack.sources.map((s) => s.id))} AND participation_mode = 'editorial'`;
    assert.equal(pack.available, check!.n > 0, `pack ${pack.id} availability follows its source rows`);
  }
});

// --- the read layer's owner gate -------------------------------------------

test("requireProjectOwner resolves the owner and answers not-found to everyone else", async () => {
  const owner = (await newUser()).user;
  const outsider = (await newUser()).user;
  const { project } = await createProject({ ownerId: owner.id, target: "隔离对象", purpose: "目的", sources: [] });

  const forOwner = await requireProjectOwner(owner.id, project.id);
  assert.equal(forOwner.kind, "ok");
  assert.equal(forOwner.kind === "ok" ? forOwner.project.id : "", project.id);

  assert.deepEqual(await requireProjectOwner(outsider.id, project.id), { kind: "not-found" }, "an outsider is told not-found: existence is never leaked");
  assert.deepEqual(await requireProjectOwner(owner.id, `project:ghost:ghost:00000000`), { kind: "not-found" });
});

// --- the api endpoints ------------------------------------------------------

async function post(url: string, body: unknown, cookie?: string) {
  return app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(body) });
}

test("the pack endpoint serves the catalog behind sign-in, with availability", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/api/packs" });
  assert.equal(anonymous.statusCode, 401, anonymous.body);

  const { token } = await newUser();
  const res = await app.inject({ method: "GET", url: "/api/packs", headers: { cookie: cookieOf(token) } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { packs: Array<{ id: string; label: string; available: boolean; sources: unknown[] }> };
  assert.deepEqual(body.packs.map((p) => p.id), ["ai-models", "embodied-ai", "opensource-dev", "semiconductor"]);
  assert.equal(body.packs[0]!.sources.length, 14, "the wizard renders each pack's static source list from this answer");
  for (const pack of body.packs) assert.equal(typeof pack.available, "boolean", "each pack carries its availability");

  // An unavailable pack is refused by the guided-creation validation (PUT /api/pack-prefs).
  // Pick a pack whose source ids are all placeholders, or temporarily make one unavailable:
  const packs = await listSourcePacks();
  const unavailablePack = packs.find((p) => !p.available);
  if (unavailablePack) {
    const refused = await app.inject({ method: "PUT", url: "/api/pack-prefs", headers: { "content-type": "application/json", cookie: cookieOf(token) }, payload: JSON.stringify({ packId: unavailablePack.id, picks: [] }) });
    assert.deepEqual([refused.statusCode, refused.json().code], [400, "pack_unavailable"], refused.body);
    assert.match(refused.json().detail as string, /还没接上可采集的信源/);
  }
});

test("creating a project requires sign-in, honest input and repeats idempotently", async () => {
  const anonymous = await post("/api/projects", { target: "目标", purpose: "目的", sourceIds: [] });
  assert.equal(anonymous.statusCode, 401, anonymous.body);

  const { token, user } = await newUser();
  const empty = await post("/api/projects", { target: " ", purpose: "目的", sourceIds: [] }, cookieOf(token));
  assert.equal(empty.statusCode, 400);
  assert.ok((empty.json().detail as string).includes("目标和方向都要有"), empty.body);

  const packs = await listSourcePacks();
  const payload = { target: "半导体与算力", purpose: "盯算力供给", sourceIds: packs.find((p) => p.id === "semiconductor")!.sources.slice(0, 3).map((s) => s.id) };
  const created = await post("/api/projects", payload, cookieOf(token));
  assert.equal(created.statusCode, 201, created.body);
  const id = (created.json() as { project: { id: string } }).project.id;
  assert.ok(id.startsWith("project:"), id);

  const again = await post("/api/projects", { ...payload, target: "半导体与算力".toUpperCase() }, cookieOf(token));
  assert.equal(again.statusCode, 200, "a repeat creation answers with the existing project, created once");
  assert.equal((again.json() as { project: { id: string } }).project.id, id);
  assert.equal((await sql`SELECT count(*)::int AS n FROM tracking_projects WHERE owner_id = ${user.id}`)[0]!.n, 1);

  const ghost = await post("/api/projects", { target: "目标", purpose: "目的", sourceIds: [`ghost-${T}`] }, cookieOf(token));
  assert.equal(ghost.statusCode, 400, ghost.body, "unknown source ids are refused before any write");
});

test("the project list and detail answer only to the owner", async () => {
  const { token: tokenA, user: userA } = await newUser();
  const { token: tokenB, user: userB } = await newUser();
  const a1 = await createProject({ ownerId: userA.id, target: "甲的项目一", purpose: "目的甲一", sources: [] });
  const a2 = await createProject({ ownerId: userA.id, target: "甲的项目二", purpose: "目的甲二", sources: [] });
  const b1 = await createProject({ ownerId: userB.id, target: "乙的项目", purpose: "目的乙", sources: [] });

  const listA = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: cookieOf(tokenA) } });
  assert.equal(listA.statusCode, 200);
  const idsA = (listA.json() as { projects: Array<{ id: string }> }).projects.map((p) => p.id).sort();
  assert.deepEqual(idsA, [a1.project.id, a2.project.id].sort(), "the list holds the caller's own projects only");
  const item = (listA.json() as { projects: Array<{ id: string; target: string; purpose: string }> }).projects.find((p) => p.id === a1.project.id)!;
  assert.deepEqual([item.target, item.purpose], ["甲的项目一", "目的甲一"]);

  const anonymousList = await app.inject({ method: "GET", url: "/api/projects" });
  assert.equal(anonymousList.statusCode, 401);

  const mine = await app.inject({ method: "GET", url: `/api/projects/${encodeURIComponent(a1.project.id)}`, headers: { cookie: cookieOf(tokenA) } });
  assert.equal(mine.statusCode, 200, mine.body);
  assert.equal((mine.json() as { project: { id: string } }).project.id, a1.project.id);

  const other = await app.inject({ method: "GET", url: `/api/projects/${encodeURIComponent(b1.project.id)}`, headers: { cookie: cookieOf(tokenA) } });
  assert.equal(other.statusCode, 404, "another user's project reads as not-found: existence is never leaked");
  const anonymous = await app.inject({ method: "GET", url: `/api/projects/${encodeURIComponent(a1.project.id)}` });
  assert.equal(anonymous.statusCode, 404, "an anonymous request reads as not-found, not as unauthorized");
  assert.equal((await app.inject({ method: "GET", url: "/api/projects/no-such-project" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/projects/bad%20space" })).statusCode, 404, "a segment outside the id charset is refused");
  assert.equal((await app.inject({ method: "GET", url: "/api/projects/bad%1escape" })).statusCode, 404, "a malformed % escape is refused");
});

test("pack preferences persist per user behind sign-in", async () => {
  const anonymousPut = await app.inject({ method: "PUT", url: "/api/pack-prefs", headers: { "content-type": "application/json" }, payload: JSON.stringify({ packId: "ai-models", picks: [] }) });
  assert.equal(anonymousPut.statusCode, 401);
  const anonymousGet = await app.inject({ method: "GET", url: "/api/pack-prefs" });
  assert.equal(anonymousGet.statusCode, 401);

  // Availability gate: prefs only stick for a pack that has at least one real editorial source.
  // Flip the curated-pack placeholder briefly; restore it so later suites (0051 fresh-install)
  // still see every curated/batch-1 source off.
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at)
    VALUES ('rss:qwen-blog', ${`Qwen ${T}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')
    ON CONFLICT (id) DO UPDATE SET participation_mode = 'editorial', enabled = true`;
  try {
    const { token } = await newUser();
    const saved = await app.inject({ method: "PUT", url: "/api/pack-prefs", headers: { "content-type": "application/json", cookie: cookieOf(token) }, payload: JSON.stringify({ packId: "ai-models", picks: ["a", "b"] }) });
    assert.equal(saved.statusCode, 200, saved.body);
    const read = await app.inject({ method: "GET", url: "/api/pack-prefs", headers: { cookie: cookieOf(token) } });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), { packId: "ai-models", picks: ["a", "b"] });

    const unknown = await app.inject({ method: "PUT", url: "/api/pack-prefs", headers: { "content-type": "application/json", cookie: cookieOf(token) }, payload: JSON.stringify({ packId: `ghost-${T}`, picks: [] }) });
    assert.equal(unknown.statusCode, 400, "an unknown pack id is refused");
  } finally {
    await sql`UPDATE sources SET participation_mode = 'isolated', enabled = false, updated_at = now() WHERE id = 'rss:qwen-blog'`;
  }
});
