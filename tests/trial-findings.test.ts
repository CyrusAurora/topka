// The newcomer trial of 2026-11-10 (Topka 0.2.0, README and tutorial followed verbatim): each finding
// it reported is reproduced here and must stay fixed. F1 packs unavailable on a fresh install; F2 no
// way to see Chat or card copy without paying; F3 the port set in several places; F4 the DEMO_PASSWORD
// reset missing a restart; F5 Chinese left in the English UI; F6 the smaller ones.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { stopBoss } from "@topka/backend/jobs/queue";
import { loadPack, packFileNames, seedAllPacks } from "@topka/backend/admin/source-pack-seed";
import { listSourcePacks } from "@topka/backend/projects/packs";
import { chatTurn } from "@topka/backend/assistant/intake";
import { confirmProposal, handleTurn } from "@topka/backend/assistant/project-assistant";
import { modelStatus, instanceModelStatus } from "@topka/backend/providers/availability";
import { DEMO_PURPOSES, demoAnswer, demoModelOn } from "@topka/backend/providers/demo-model";
import { chatJson } from "@topka/backend/providers/llm";
import { cardWidth, CARD_LIMITS } from "@topka/backend/projects/card-copy";
import { instanceSetup } from "@topka/backend/projects/instance-setup";
import { noChangeDetail } from "@topka/backend/projects/today";
import { REPLIES } from "@topka/backend/assistant/replies";
import { publishedPort, siteAddress } from "@topka/contracts/address";
import { z } from "zod";

const T = tag();
const ROOT = new URL("..", import.meta.url).pathname;
const run = promisify(execFile);
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

after(async () => {
  await sql`DELETE FROM source_packs WHERE id = ${`trial-${T}`}`;
  await stopBoss();
  await closeDb();
});

/** Runs `fn` with these environment variables set, restoring them after. */
async function withEnv<R>(vars: Record<string, string | undefined>, fn: () => Promise<R> | R): Promise<R> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

async function reader(locale: "zh-CN" | "en"): Promise<string> {
  const id = `trial-${locale}-${T}`;
  await sql`INSERT INTO users (id, email, password_hash, locale) VALUES (${id}, ${`${id}@example.com`}, 'x', ${locale}) ON CONFLICT (id) DO NOTHING`;
  return id;
}

// --- F1: every pack on the wizard works on a fresh install -------------------------------------------

test("F1 setup imports every shipped pack, so all four are selectable on a fresh install", async () => {
  assert.deepEqual(packFileNames(), ["ai-models", "embodied", "opensource-dev", "semiconductor"]);
  const r = await seedAllPacks(sql);
  assert.equal(r.packs.length, 4);
  const packs = await listSourcePacks(sql);
  for (const file of packFileNames()) {
    const id = loadPack(file).packId ?? loadPack(file).id;
    const pack = packs.find((p) => p.id === id);
    assert.ok(pack, `pack ${id} is in the catalog`);
    assert.equal(pack!.available, true, `pack ${id} is available`);
    assert.equal(pack!.reason, null);
    assert.equal(pack!.sources.length, loadPack(file).sources.length, `pack ${id} lists the file's sources`);
  }
  const again = await seedAllPacks(sql);
  assert.ok(again.packs.every((p) => p.inserted === 0), "a second setup run adds nothing");
});

test("F1 a fresh install holds each feed once: setup takes over the untouched catalogue twin", async () => {
  await seedAllPacks(sql);
  const urls = packFileNames().flatMap((f) => loadPack(f).sources)
    .filter((s) => typeof s.config.feedUrl === "string" && s.config.includeIfMatches === undefined)
    .map((s) => String(s.config.feedUrl));
  const dupes = await sql<{ url: string; n: number }[]>`
    SELECT config->>'feedUrl' AS url, count(*)::int AS n FROM sources
    WHERE config->>'feedUrl' IN ${sql(urls)} AND config->'includeIfMatches' IS NULL
    GROUP BY 1 HAVING count(*) > 1`;
  assert.deepEqual([...dupes], [], "no unfiltered feed is stored twice");
});

test("F1 a pack whose sources are not imported says so instead of a bare 'unavailable'", async () => {
  await sql`INSERT INTO source_packs (id, label, sources) VALUES (${`trial-${T}`}, '测试包', ${sql.json([{ id: `missing-${T}`, name: "Missing" }] as never)})`;
  const pack = (await listSourcePacks(sql)).find((p) => p.id === `trial-${T}`)!;
  assert.equal(pack.available, false);
  assert.equal(pack.reason, "not-imported");
  const regionless = (await listSourcePacks(sql, { regions: ["jp"] })).find((p) => p.id === "semiconductor" || p.id === loadPack("semiconductor").packId)!;
  if (!regionless.available) assert.equal(regionless.reason, "region-empty");
});

// --- F2: a zero-cost AI path ----------------------------------------------------------------------

test("F2 with DEMO_SEED and no model, the built-in demo model answers Chat and says it is the demo", async () => {
  await withEnv({ DEMO_SEED: "true", LLM_DEMO: undefined }, async () => {
    assert.equal(demoModelOn(), true);
    const instance = instanceModelStatus();
    assert.equal(instance.available, true);
    assert.equal(instance.via, "demo");
    const status = await modelStatus(await reader("zh-CN"));
    assert.equal(status.chat, "instance");
  });
  await withEnv({ DEMO_SEED: "true", LLM_DEMO: "false" }, () => assert.equal(demoModelOn(), false, "LLM_DEMO=false turns it off"));
  await withEnv({ DEMO_SEED: undefined, LLM_DEMO: undefined }, () => assert.equal(demoModelOn(), false, "off without DEMO_SEED"));
});

for (const locale of ["zh-CN", "en"] as const) {
  test(`F2 demo Chat end to end offline (${locale}): questions → summary → card → confirm creates the project`, async () => {
    await withEnv({ DEMO_SEED: "true", LLM_DEMO: undefined }, async () => {
      const user = await reader(locale);
      const en = locale === "en";
      const say = en ? ["Track humanoid robots for me", "Product launches", "Funding news", "Yes, go with this"] : ["帮我跟踪人形机器人", "产品发布", "融资新闻", "对，就按这个"];
      let card: { id: string } | null = null;
      const replies: string[] = [];
      for (const text of say) {
        const r = await chatTurn(user, text);
        assert.equal(r.status, "done", `${text}: ${r.reply}`);
        replies.push(r.reply);
        if (r.card) card = r.card as { id: string };
      }
      assert.match(replies[0]!, en ? /Demo model/ : /演示模型/, "the first answer says it is the demo model");
      assert.ok(card, "the last turn shows a tracking card");
      if (en) for (const r of replies) assert.doesNotMatch(r, CJK, `English reader gets English: ${r}`);
      const done = await confirmProposal(user, card!.id);
      assert.equal(done.ok, true, JSON.stringify(done));
      if (en) assert.doesNotMatch(done.message, CJK);
      const [p] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tracking_projects WHERE owner_id = ${user}`;
      assert.ok(p!.n >= 1);
    });
  });
}

test("F2 demo Chat deletes only a named project and asks for confirmation", async () => {
  await withEnv({ DEMO_SEED: "true" }, async () => {
    const user = await reader("zh-CN"); // owns 「人形机器人」 from the zh-CN end-to-end test above
    const r = await handleTurn(user, "删除人形机器人这个项目");
    assert.equal(r.status, "done");
    assert.equal(r.card?.kind, "delete", r.reply);
    const nobody = `trial-none-${T}`;
    await sql`INSERT INTO users (id, email, password_hash) VALUES (${nobody}, ${`${nobody}@example.com`}, 'x')`;
    const none = await handleTurn(nobody, "删除人形机器人这个项目");
    assert.equal(none.card, null, "no project named: no guess");
  });
});

test("F2 the demo model writes card copy within the width limits, in the reader's language", async () => {
  await withEnv({ DEMO_SEED: "true" }, async () => {
    const user = "【内容 id=a1】\n来源：Example\n现有标题：Humanoid maker ships 1,000 units to a car plant this quarter, ahead of plan\n现有摘要：A long summary.";
    for (const lang of ["zh", "en"] as const) {
      const res = await chatJson({
        model: "default", purpose: "mobile_card", subject: `trial-${T}`, promptVersion: "test",
        system: `## 输出语言\n\n${lang}\n`, user, maxTokens: 512, timeoutMs: 5000,
        schema: z.object({ cards: z.array(z.object({ id: z.string(), title: z.string(), lead: z.string(), why: z.string() })) }),
      });
      const c = res.data.cards[0]!;
      assert.equal(c.id, "a1");
      assert.ok(cardWidth(c.title) <= CARD_LIMITS.title && cardWidth(c.lead) <= CARD_LIMITS.lead && cardWidth(c.why) <= CARD_LIMITS.why, JSON.stringify(c));
      if (lang === "en") assert.doesNotMatch(`${c.title}${c.lead}${c.why}`, CJK);
    }
  });
});

test("F2 the demo model never analyses articles: other purposes still need a real model", async () => {
  await withEnv({ DEMO_SEED: "true" }, async () => {
    assert.deepEqual([...DEMO_PURPOSES].sort(), ["mobile_card", "project_assistant"]);
    await assert.rejects(chatJson({
      model: "default", purpose: "summarize", subject: `trial-${T}`, promptVersion: "test", system: "s", user: "u",
      maxTokens: 64, timeoutMs: 2000, schema: z.object({ x: z.string() }),
    }), (e: Error) => !/demo/i.test(e.message), "analysis is not answered by the demo model");
  });
  assert.equal(typeof demoAnswer, "function");
  assert.equal(instanceSetup().analysisOn, false, "the project page and wizard are told analysis is off");
});

test("F2 docs give the free options with exact lines, and the UI links resolve to real headings", () => {
  const doc = read("docs/self-hosting.md");
  for (const line of ["COMPOSE_PROFILES=ollama", "LLM_BASE_URL=http://ollama:11434/v1", "LLM_API_KEY=ollama", "ollama pull qwen2.5:7b", "LLM_FREE_MODELS=", "DEMO_SEED=true"]) {
    assert.ok(doc.includes(line), `self-hosting.md has ${line}`);
  }
  const compose = read("docker-compose.yml");
  assert.match(compose, /ollama:\n\s+image: ollama\/ollama:\d/);
  assert.match(compose, /profiles: \["ollama"\]/);
  const links = read("apps/web/app/lib/docs-links.ts");
  for (const m of links.matchAll(/docs\/([\w.-]+\.md)#([\w-]+)/g)) {
    const headings = [...read(`docs/${m[1]}`).matchAll(/^#{1,6}\s+(.+)$/gm)].map((h) => h[1]!.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-"));
    assert.ok(headings.includes(m[2]!), `docs/${m[1]} has #${m[2]}`);
  }
});

// --- F3: the port in one place --------------------------------------------------------------------

test("F3 the site address follows PORT unless SITE_URL or SITE_DOMAIN says otherwise", () => {
  assert.equal(publishedPort("127.0.0.1:3300"), 3300);
  assert.equal(publishedPort("3300"), 3300);
  assert.equal(publishedPort("[::1]:3300"), 3300);
  assert.equal(publishedPort("abc"), null);
  assert.equal(siteAddress({ PORT: "127.0.0.1:3300" }, "http://localhost:3000"), "http://localhost:3300");
  assert.equal(siteAddress({ PORT: "0.0.0.0:3000" }, "x"), "http://localhost:3000");
  assert.equal(siteAddress({ PORT: "203.0.113.5:8080" }, "x"), "http://203.0.113.5:8080");
  assert.equal(siteAddress({ PORT: "80" }, "x"), "http://localhost");
  assert.equal(siteAddress({ PORT: "3300", SITE_DOMAIN: "example.com" }, "x"), "https://example.com");
  assert.equal(siteAddress({ PORT: "3300", SITE_URL: "https://news.example.com/" }, "x"), "https://news.example.com");
  assert.equal(siteAddress({}, "http://localhost:3000/"), "http://localhost:3000");
});

test("F3 the backend's site URL and the web server's port come from PORT in .env", async () => {
  const env = { PATH: process.env.PATH!, DATABASE_URL: process.env.DATABASE_URL!, PORT: "127.0.0.1:3300", SESSION_SECRET: "x".repeat(32), IMG_PROXY_SIGN_SECRET: "y".repeat(32) };
  const r = await run(process.execPath, ["--input-type=module", "-e", "const { config } = await import('@topka/backend/config'); console.log(config.siteUrl);"], { env, cwd: ROOT });
  assert.equal(r.stdout.trim(), "http://localhost:3300");
  assert.match(read("apps/web/server.ts"), /publishedPort\(process\.env\.PORT\)/);
});

test("F3 init-env runs in a fresh clone before npm ci, writes PORT once and prints the address", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trial-init-"));
  try {
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "packages/contracts/src"), { recursive: true });
    cpSync(path.join(ROOT, "scripts/init-env.ts"), path.join(dir, "scripts/init-env.ts"));
    cpSync(path.join(ROOT, "packages/contracts/src/address.ts"), path.join(dir, "packages/contracts/src/address.ts"));
    cpSync(path.join(ROOT, ".env.example"), path.join(dir, ".env.example"));
    assert.ok(!existsSync(path.join(dir, "node_modules")));
    const env = { PATH: process.env.PATH! };
    const r = await run(process.execPath, ["scripts/init-env.ts", "--demo", "--port", "127.0.0.1:3300"], { cwd: dir, env });
    assert.match(r.stdout, /网站地址：http:\/\/localhost:3300/);
    const text = readFileSync(path.join(dir, ".env"), "utf8");
    assert.deepEqual(text.match(/^PORT=.*$/gm), ["PORT=127.0.0.1:3300"]);
    assert.match(text, /^DEMO_SEED=true$/m);
    assert.doesNotMatch(text, /^SITE_URL=/m, "no second place that could disagree with PORT");
    const again = await run(process.execPath, ["scripts/init-env.ts"], { cwd: dir, env }).catch((e: { code: number; stderr: string }) => e);
    assert.equal((again as { code: number }).code, 1);
    assert.match((again as { stderr: string }).stderr, /密码和密钥保持不变/);
    rmSync(path.join(dir, ".env"));
    const en = await run(process.execPath, ["scripts/init-env.ts", "--locale", "en"], { cwd: dir, env });
    assert.match(en.stdout, /Site address: http:\/\/localhost:3000/);
    assert.match(readFileSync(path.join(dir, ".env"), "utf8"), /^SITE_LOCALE=en$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F3 README and tutorials set the port in .env and check health on this stack's own port", () => {
  for (const f of ["README.md", "README.en.md", "docs/tutorial.md", "docs/tutorial.en.md", "docs/self-hosting.md"]) {
    const text = read(f);
    assert.doesNotMatch(text, /curl[^\n]*localhost:3000\/api\/health/, `${f}: no health check pinned to 3000`);
    assert.doesNotMatch(text, /PORT=127\.0\.0\.1:3300 (DEMO_SEED=true )?docker compose/, `${f}: no per-command port prefix`);
    if (f !== "docs/self-hosting.md") assert.match(text, /docker compose port web 3000/, `${f}: health check follows the port`);
  }
  assert.match(read(".env.example"), /^PORT=127\.0\.0\.1:3000$/m);
  assert.doesNotMatch(read(".env.example"), /^SITE_URL=/m);
});

// --- F4: the DEMO_PASSWORD reset ------------------------------------------------------------------

test("F4 every DEMO_PASSWORD reset instruction recreates the containers before demo:seed", () => {
  const script = read("scripts/demo.ts");
  assert.match(script, /add DEMO_PASSWORD=<10\+ characters> to \.env, run `docker compose up -d`, then `docker compose exec api npm run demo:seed`/);
  for (const f of ["README.md", "README.en.md", "docs/tutorial.md", "docs/tutorial.en.md"]) {
    const text = read(f);
    let checked = 0;
    for (const m of text.matchAll(/DEMO_PASSWORD=/g)) {
      if (text.slice(Math.max(0, m.index - 3), m.index) === "-e ") continue; // passed to that one run
      const rest = text.slice(m.index, m.index + 400);
      const seedAt = rest.indexOf("demo:seed");
      if (seedAt < 0) continue;
      checked++;
      assert.ok(rest.slice(0, seedAt).includes("docker compose up -d"), `${f}: ${rest.slice(0, seedAt + 9)}`);
    }
    assert.ok(checked > 0, `${f} explains the reset`);
  }
});

test("F4 with DEMO_SEED=true left in .env, a restart after real content arrives never blocks the stack", async () => {
  const script = path.join(ROOT, "scripts/demo.ts");
  const env = { ...process.env, DEMO_SEED: "true", DEMO_PASSWORD: "" };
  await sql`INSERT INTO users (id, email, password_hash) VALUES (${`trial-other-${T}`}, ${`trial-other-${T}@example.com`}, 'x') ON CONFLICT DO NOTHING`;
  const r = await run(process.execPath, [script, "--if-enabled"], { env }).catch((e: { code: number; stdout: string; stderr: string }) => e);
  assert.equal((r as { code?: number }).code ?? 0, 0, "setup goes on");
});

// --- F5 / F6: English UI and the smaller findings ------------------------------------------------

test("F5 pack names and source names read in English for English readers", async () => {
  for (const file of packFileNames()) {
    const pack = loadPack(file);
    assert.ok(pack.labelEn && !CJK.test(pack.labelEn), `${file}: labelEn`);
    for (const s of pack.sources) {
      assert.doesNotMatch(s.name, CJK, `${file}: ${s.name}`);
      if (s.publisher) assert.doesNotMatch(s.publisher, CJK, `${file}: ${s.publisher}`);
    }
  }
  const packs = await listSourcePacks(sql);
  for (const p of packs.filter((x) => !x.id.startsWith("trial-"))) assert.ok(p.labelEn, `${p.id} carries labelEn from the database`);
});

test("F5 one collection-frequency story everywhere (no 'twice a day', no 'every 15 minutes' for all)", () => {
  const texts = ["apps/web/app/lib/locales/projects.ts", "industry/site.ts", "docs/self-hosting.md", "README.md", "README.en.md"].map((f) => [f, read(f)] as const);
  for (const [f, text] of texts) {
    assert.doesNotMatch(text, /twice a day|morning and evening|早晚各|每天两次/i, f);
    assert.doesNotMatch(text, /active sources are checked every 15 minutes/i, f);
  }
  assert.match(read("apps/web/app/lib/locales/projects.ts"), /15 分钟/);
  assert.match(read("apps/web/app/lib/locales/projects.ts"), /every 15 minutes for the busiest/);
});

test("F5 Chat's fixed replies are English for English readers", () => {
  for (const [key, value] of Object.entries(REPLIES.en)) {
    const sample = typeof value === "function" ? (value as (x: string) => string)("X") : typeof value === "object" ? JSON.stringify(value) : value;
    assert.doesNotMatch(sample, CJK, key);
  }
  const expired = REPLIES.en.closed.expired(24);
  assert.match(expired, /24 hours/);
});

test("F6 sources:list prints times with their zone; sources:seed without --pack lists the packs", async () => {
  const env = { ...process.env };
  const list = await run(process.execPath, [path.join(ROOT, "scripts/sources-seed.ts")], { env });
  for (const name of packFileNames()) assert.match(list.stdout, new RegExp(`^${name}\\s`, "m"));
  assert.match(read("scripts/sources.ts"), /toBeijingIso\(s\.last_ok_at\)/);
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, last_ok_at)
            VALUES (${`trial-src-${T}`}, ${`Trial source ${T}`}, 'rss', 'T1', 'editorial', '2100-01-01', '2026-11-10T13:17:00Z')
            ON CONFLICT (id) DO NOTHING`;
  const out = await run(process.execPath, [path.join(ROOT, "scripts/sources.ts"), "list", "--q", `trial-src-${T}`], { env });
  assert.match(out.stdout, /2026-11-10T21:17:00\+08:00/, "the zone is written out");
  assert.doesNotMatch(out.stdout, /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/, "no bare UTC timestamps");
});

test("F6 the setup log explains '18 added' next to ~400 sources", () => {
  const seed = read("scripts/seed.ts");
  assert.match(seed, /in the database/);
  assert.match(read("README.md"), /大部分来自迁移/);
});

test("F6 the ESC[2K advice works on the Compose we ship against; container commands print no false '.env not found'", () => {
  for (const file of ["README.md", "README.en.md"]) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    const row = text.split("\n").find((l) => l.includes("ESC[2K"));
    assert.ok(row, `${file} has the ESC[2K row`);
    assert.match(row!, /docker logs \$\(docker compose ps -aq setup\)/);
  }
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /NPM_CONFIG_UPDATE_NOTIFIER=false/);
  assert.match(dockerfile, /: > \/app\/\.env/);
});

test("F6 the project page's empty state names the same window as its source line", () => {
  assert.match(noChangeDetail("default"), /^最近 24 小时里/);
  assert.match(noChangeDetail("capped"), /^最近 7 天里/);
  assert.match(noChangeDetail("checkpoint"), /^自上次阅读以来/);
});
