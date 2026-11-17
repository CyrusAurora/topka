// The second newcomer trial (2026-11-17, Topka at d653e9e, README and tutorials followed verbatim): each
// finding it reported is reproduced here and must stay fixed. G1 an English delete sentence started a new
// interview; G2 the demo model clipped the topic into the project name ("open-source LLM…"); G3 a new
// intent halfway through the questions was swallowed as the answer; G4 a confirmed delete card lost its
// project name; G5 demo calls counted as paid requests; G6 /api/health did not say it is Topka; G7 the
// tutorial's example output and DEMO_PASSWORD advice did not match what really happens; G8 the demo seed
// switched the demo sources back on at every restart.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { stopBoss } from "@topka/backend/jobs/queue";
import { chatTurn, closeIntake } from "@topka/backend/assistant/intake";
import { confirmProposal, loadCard } from "@topka/backend/assistant/project-assistant";
import { demoName } from "@topka/contracts/demo-answers";
import { runsOverview } from "@topka/backend/admin/runs";
import core from "../packages/backend/src/assistant/intake-core.cjs";

const T = tag();
const ROOT = new URL("..", import.meta.url).pathname;
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const CJK = /[\u3400-\u9fff]/;

after(async () => {
  await sql`DELETE FROM receipts WHERE logical_key LIKE ${`trial2-${T}-%`}`;
  await stopBoss();
  await closeDb();
});

async function withDemo<R>(fn: () => Promise<R>): Promise<R> {
  const before = { seed: process.env.DEMO_SEED, demo: process.env.LLM_DEMO };
  process.env.DEMO_SEED = "true";
  delete process.env.LLM_DEMO;
  try {
    return await fn();
  } finally {
    before.seed === undefined ? delete process.env.DEMO_SEED : (process.env.DEMO_SEED = before.seed);
    if (before.demo !== undefined) process.env.LLM_DEMO = before.demo;
  }
}

async function reader(name: string, locale: "zh-CN" | "en"): Promise<string> {
  const id = `trial2-${name}-${T}`;
  await sql`INSERT INTO users (id, email, password_hash, locale) VALUES (${id}, ${`${id}@example.com`}, 'x', ${locale}) ON CONFLICT (id) DO NOTHING`;
  return id;
}

/** Walks the demo interview to a confirmed project; returns its name. */
async function createByChat(user: string, ask: string, answers: string[]): Promise<string> {
  type Card = { id: string; payload?: { target?: string } | null };
  let card = null as Card | null;
  for (const text of [ask, ...answers]) {
    const r = await chatTurn(user, text);
    assert.equal(r.status, "done", `${text}: ${r.reply}`);
    if (r.card) card = r.card as unknown as Card;
  }
  assert.ok(card, "the interview ends in a tracking card");
  const done = await confirmProposal(user, card!.id);
  assert.equal(done.ok, true, JSON.stringify(done));
  await closeIntake(user, card!.id); // as POST /api/me/chat/confirm does
  return card!.payload?.target ?? "";
}
const EN_ANSWERS = ["Technical progress", "Marketing posts", "Yes, go with this"];

// --- G1 ------------------------------------------------------------------------------------------------

test("G1 English delete sentences go to the delete card, as tutorial.en.md says", async () => {
  for (const t of ["Delete the humanoid robots project", "Remove humanoid robots", "Stop tracking humanoid robots", "please delete my chips tracker"]) {
    assert.equal(core.routeOf(t), "manage", t);
  }
  for (const t of ["Technical progress", "Show me everything", "Track humanoid robots for me", "Funding and business"]) {
    assert.equal(core.routeOf(t), "intake", t);
  }
  assert.match(read("docs/tutorial.en.md"), /"Delete the humanoid robots project" brings a delete card/);
  await withDemo(async () => {
    const user = await reader("g1", "en");
    const name = await createByChat(user, "Track humanoid robots for me", EN_ANSWERS);
    assert.equal(name, "humanoid robots");
    const r = await chatTurn(user, "Delete the humanoid robots project");
    assert.equal(r.card?.kind, "delete", r.reply);
    assert.equal(r.card?.before?.target, "humanoid robots");
  });
});

// --- G2 ------------------------------------------------------------------------------------------------

test("G2 the demo model names the project after the whole topic, never a clipped one with '…'", async () => {
  assert.equal(demoName("Help me track open-source LLM releases"), "open-source LLM releases");
  assert.equal(demoName("I want to follow humanoid robot news"), "humanoid robot");
  assert.equal(demoName("Track the latest developments in European semiconductor export controls and subsidies for me"), "European semiconductor export controls");
  assert.equal(demoName("帮我跟踪人形机器人"), "人形机器人");
  assert.equal(demoName("我想关注固态电池的最新进展"), "固态电池");
  for (const ask of ["Help me track open-source LLM releases", "Track the latest developments in European semiconductor export controls and subsidies for me"]) {
    const name = demoName(ask);
    assert.doesNotMatch(name, /…|\.\.\./, name);
    assert.ok(name.length <= 40, name);
  }
  await withDemo(async () => {
    const user = await reader("g2", "en");
    assert.equal(await createByChat(user, "Help me track open-source LLM releases", EN_ANSWERS), "open-source LLM releases");
  });
});

// --- G3 ------------------------------------------------------------------------------------------------

test("G3 halfway through the questions, a new intent is not swallowed as the answer", async () => {
  const now = Date.now();
  const first = core.planTurn(null, "Track humanoid robots for me", now, "en");
  const asked = { ...first.session!, asked: 1, turns: [{ q: "Which kind of change matters most to you?", options: ["Technical progress", "Track record"], a: null }] };
  // A chip is an answer, even one that starts like a request.
  assert.equal(core.planTurn(asked, "Technical progress", now, "en").session!.turns[0]!.a, "Technical progress");
  // A new topic starts a new interview about it.
  const fresh = core.planTurn(asked, "Track open-source LLM releases", now, "en");
  assert.equal(fresh.mode, "ask");
  assert.equal(fresh.session!.ask, "Track open-source LLM releases");
  assert.equal(fresh.session!.turns.length, 0);
  // Cancel ends it, nothing created.
  const cancel = core.planTurn(asked, "Cancel", now, "en");
  assert.equal(cancel.mode, "local");
  assert.equal(cancel.session, null);
  assert.doesNotMatch(cancel.reply!.text, CJK);
  assert.equal(core.planTurn({ ...asked, lang: undefined }, "算了", now, null).session, null);
  assert.equal(core.planTurn({ ...asked, lang: undefined }, "帮我跟踪固态电池", now, null).session!.ask, "帮我跟踪固态电池");

  await withDemo(async () => {
    const user = await reader("g3", "en");
    await createByChat(user, "Track humanoid robots for me", EN_ANSWERS);
    // Start another interview, then say "delete" in the middle of it.
    await chatTurn(user, "Track solid-state batteries for me");
    const del = await chatTurn(user, "Delete the humanoid robots project");
    assert.equal(del.card?.kind, "delete", del.reply);
    // And a cancel in the middle ends that interview; the next answer-like words start nothing old.
    await chatTurn(user, "Track solid-state batteries for me");
    const c = await chatTurn(user, "Never mind");
    assert.equal(c.session, null);
    assert.doesNotMatch(c.reply, CJK);
  });
});

// --- G4 ------------------------------------------------------------------------------------------------

test("G4 a confirmed delete card still names the project it deleted", async () => {
  await withDemo(async () => {
    const user = await reader("g4", "en");
    await createByChat(user, "Track humanoid robots for me", EN_ANSWERS);
    const del = await chatTurn(user, "Delete the humanoid robots project");
    assert.equal(del.card?.kind, "delete");
    const done = await confirmProposal(user, del.card!.id);
    assert.equal(done.ok, true, JSON.stringify(done));
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tracking_projects WHERE owner_id = ${user}`;
    assert.equal(n, 0, "the project is gone");
    const card = await loadCard(user, del.card!.id);
    assert.equal(card?.status, "applied");
    assert.equal(card?.before?.target, "humanoid robots", "the chat history keeps the name");
    assert.ok(card?.before?.purpose, "and what it was for");
  });
});

// --- G5 ------------------------------------------------------------------------------------------------

test("G5 the runs page counts demo and free-model calls apart from paid requests", async () => {
  const before = (await runsOverview()).receipts.kinds;
  const add = (k: string, service: string, cost: number | null) =>
    sql`INSERT INTO receipts (logical_key, service, model, purpose, status, cost) VALUES (${`trial2-${T}-${k}`}, ${service}, 'm', 'project_assistant', 'completed', ${cost})`;
  await add("d1", "demo", 0);
  await add("d2", "demo", null);
  await add("f1", "openrouter", 0);
  await add("p1", "openrouter", 0.0123);
  await add("p2", "openrouter", null); // cost not known yet: counted as paid, never hidden
  const after = (await runsOverview()).receipts.kinds;
  assert.deepEqual({ paid: after.paid - before.paid, free: after.free - before.free, demo: after.demo - before.demo }, { paid: 2, free: 1, demo: 2 });
});

// --- G6 ------------------------------------------------------------------------------------------------
// (tests/release-name.test.ts: /api/health carries "app": "topka" and the version.)

test("G6 the docs show the health answer as it really is, app name first", () => {
  for (const f of ["docs/tutorial.md", "docs/tutorial.en.md"]) assert.match(read(f), /\{"app":"topka","version":"\d+\.\d+\.\d+","ok":true,"db":"ok"/, f);
  for (const f of ["README.md", "README.en.md", "docs/self-hosting.md"]) assert.match(read(f), /"app":"topka"/, f);
});

// --- G7 ------------------------------------------------------------------------------------------------

test("G7 the tutorial's sources:only output is the real one, and no '.env not found' that never prints", () => {
  for (const f of ["docs/tutorial.md", "docs/tutorial.en.md", "README.md", "README.en.md", "docs/self-hosting.md"]) {
    assert.doesNotMatch(read(f), /\.env not found/, `${f}: the image ships an empty .env, so the line never appears`);
  }
  for (const f of ["docs/tutorial.md", "docs/tutorial.en.md"]) {
    assert.match(read(f), /保持打开 2 个（新打开 2），关闭其余 3 个/, f);
    assert.doesNotMatch(read(f), /关闭其余 0 个\n/, f);
  }
  assert.match(read("Dockerfile"), /: > \/app\/\.env/);
});

test("G7 the one-off DEMO_PASSWORD warns that a restart puts back the .env password", () => {
  assert.match(read("docs/tutorial.md"), /-e DEMO_PASSWORD=[^\n]*下次 `docker compose up -d` 时 `setup` 会按 `\.env` 里的值把密码改回去/);
  assert.match(read("docs/tutorial.en.md"), /-e DEMO_PASSWORD=[\s\S]{0,200}sets the password back to the `\.env` value/);
});

// --- G8 (scripts/demo.ts; the re-run itself is in tests/demo-seed.test.ts) -----------------------------

test("G8 the demo seed switches its sources on only when it first adds them", () => {
  const demo = read("scripts/demo.ts");
  const upsert = /ON CONFLICT \(id\) DO UPDATE SET ([^`]+)`/.exec(demo)?.[1] ?? "";
  assert.ok(upsert, "the sources upsert is there");
  assert.doesNotMatch(upsert, /enabled/, "a re-run must not touch the operator's switch");
});
