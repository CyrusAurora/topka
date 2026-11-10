// Browser end-to-end flows for the web product (今日 home, legacy redirects, open registration,
// chat gates, BYOK settings, the reminder feed). It starts its own fake OpenAI-compatible model,
// the API and the built web server on loopback ports, in a clean env against DATABASE_URL — run it
// on a throwaway database only (see e2e/README.md). Needs `npm run build -w @topka/web` first and a
// Chrome/Chromium binary (CHROME_PATH, default /usr/bin/google-chrome).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { closeDb, sql } from "@topka/backend/db";
import { upsertMaterial } from "@topka/backend/content/materials";
import { createProject } from "@topka/backend/projects/create-project";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { SESSION_COOKIE } from "@topka/backend/accounts/session";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const API_PORT = Number(process.env.E2E_API_PORT ?? 13001);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 13000);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const RUN = randomBytes(3).toString("hex");
const ADMIN_PASSWORD = `e2e-admin-${RUN}-password`;
/** Where the locale tests save their screenshots (evidence for a release); off when unset. */
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? "";

if (!process.env.DATABASE_URL) throw new Error("e2e needs DATABASE_URL pointing at a throwaway database");
// A throwaway database only: its name must say so.
const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
if (!(/_(test|ci)$/i.test(dbName) || /e2e|scratch/i.test(dbName))) throw new Error(`e2e refuses database "${dbName}": use a throwaway one (name ending _test or _ci, or containing e2e/scratch)`);

let model: Server;
let modelUrl = "";
let modelHits = 0;
const kids: ChildProcess[] = [];
let browser: Browser;

function say(o: unknown) {
  return JSON.stringify({ id: "e2e", model: "fake", choices: [{ message: { content: JSON.stringify(o) }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3 } });
}

function startModel(): Promise<void> {
  model = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      modelHits++;
      const body = JSON.parse(raw || "{}") as { messages?: Array<{ content: string }> };
      const user = String(body.messages?.at(-1)?.content ?? "");
      res.setHeader("content-type", "application/json");
      // The intake (the shared intake core): three option questions, the summary, then
      // the card on whichever catalog sources mention 具身.
      const m = /【模式】(\w+)（已问 (\d+)\/(\d+)/.exec(user);
      if (m) {
        const [, mode, askedText] = m;
        const asked = Number(askedText);
        const ask = user.split("【用户最初的需求】\n")[1]?.split("\n")[0] ?? "";
        if (mode === "ask" && asked < 3) {
          res.end(say({ kind: "question", analysis: { vague: ["跟踪"] }, update: "先理解为你想跟踪这个方向。", question: `你最关心哪方面？（第 ${asked + 1} 问）`, options: ["量产", "融资", "其他"] }));
        } else if (mode === "ask" || mode === "summarize") {
          res.end(say({ kind: "summary", update: "整理一下。", summary: { ask, problem: "人形机器人未来一年能否量产", facts: ["关注量产"], assumptions: ["订单会兑现"], variables: ["交付量"], question: "未来一年人形机器人能否实现千台级交付？" } }));
        } else {
          const ids = [...user.matchAll(/^(\S+)｜[^｜\n]*具身[^｜\n]*｜/gm)].map((x) => x[1]!);
          res.end(say({ kind: "card", judgement: "值得跟踪。", reasons: ["量产节奏在加快"], next: "先看头部公司的交付公告。", card: { target: "人形机器人量产", purpose: "未来一年能否千台交付", focus: "交付、成本", exclusions: "自动驾驶", variables: ["交付量"], sourceIds: ids } }));
        }
        return;
      }
      res.end(say({ action: "reply", projectRef: null, reply: "你好，我在。", proposal: null }));
    });
  });
  return new Promise((ok) => model.listen(0, "127.0.0.1", () => {
    const a = model.address();
    modelUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/v1`;
    ok();
  }));
}

/** A clean env: only what the servers need, never the shell's provider keys. */
function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    NODE_ENV: "production",
    DATABASE_URL: process.env.DATABASE_URL,
    SITE_URL: WEB,
    MODEL_CALLS_ENABLED: "true",
    COLLECT_ENABLED: "false",
    KEY_ENCRYPTION_SECRET: randomBytes(32).toString("base64"),
    BYOK_ALLOW_PRIVATE_BASE_URL: "true",
    REGISTRATION_MODE: "open",
    ADMIN_PASSWORD: ADMIN_PASSWORD,
    ...extra,
  };
}

async function waitFor(url: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 500) return;
    } catch {}
    if (Date.now() > until) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function launch(cwd: string, file: string, e: NodeJS.ProcessEnv, name: string): void {
  const p = spawn(process.execPath, [file], { cwd, env: e, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  p.stdout!.on("data", (d) => log.push(String(d)));
  p.stderr!.on("data", (d) => log.push(String(d)));
  p.on("exit", (code) => { if (code && code !== 0 && !stopping) process.stderr.write(`[${name}] exited ${code}\n${log.join("").slice(-4000)}\n`); });
  kids.push(p);
}
let stopping = false;

before(async () => {
  await startModel();
  const shared = env({});
  // The API runs outside production mode: it refuses BYOK_ALLOW_PRIVATE_BASE_URL (the fake model is
  // on loopback) in production, as it should.
  launch(`${ROOT}apps/api`, "src/main.ts", { ...shared, NODE_ENV: "test", API_PORT: String(API_PORT), API_HOST: "127.0.0.1" }, "api");
  await waitFor(`http://127.0.0.1:${API_PORT}/api/health`);
  launch(`${ROOT}apps/web`, "server.ts", { ...shared, WEB_PORT: String(WEB_PORT), WEB_HOST: "127.0.0.1", API_BASE_URL: `http://127.0.0.1:${API_PORT}` }, "web");
  await waitFor(`${WEB}/`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
});

after(async () => {
  stopping = true;
  await closeDb().catch(() => {});
  await browser?.close();
  for (const k of kids) k.kill("SIGTERM");
  model?.close();
});

async function fresh(): Promise<Page> {
  const ctx = await browser.newContext();
  return ctx.newPage();
}

async function register(page: Page, email: string): Promise<void> {
  await page.goto(`${WEB}/register`, { waitUntil: "load" });
  await page.fill("#email", email);
  await page.fill("#password", "e2e-password-123");
  await page.click("button[type=submit]");
  await page.waitForURL(`${WEB}/`, { timeout: 15_000 });
}

test("legacy Topka paths redirect 301 to the on-scope pages", async () => {
  const want: Record<string, string> = { "/all": "/", "/hot": "/", "/daily": "/archive", "/topics": "/", "/agent": "/", "/leaderboard": "/", "/changelog": "/" };
  for (const [from, to] of Object.entries(want)) {
    const r = await fetch(`${WEB}${from}`, { redirect: "manual" });
    assert.equal(r.status, 301, from);
    assert.equal(new URL(r.headers.get("location")!, WEB).pathname, to, from);
  }
});

test("home is 今日: signed out it offers login and register, no legacy nav", async () => {
  const page = await fresh();
  // The server renders 今日 in its loading state; the signed-out doors appear only once the page has
  // hydrated and /api/me/today has answered 401. "load" does not wait for that, so on a slow runner the
  // links were not there yet. Hold the 401 back a little so this test always takes the slow path, then
  // wait for the signed-out panel itself rather than reading the DOM straight after load.
  await page.route("**/api/me/today", async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });
  await page.goto(`${WEB}/`, { waitUntil: "load" });
  await settle(page);
  assert.match(await page.locator("nav").first().innerText(), /今日/);
  const signedOut = page.locator(".mag-empty", { hasText: "登录后就能看到你的今日" });
  await signedOut.waitFor({ timeout: 10_000 });
  assert.ok(await signedOut.locator('a[href^="/login"]').count(), "a login link");
  assert.ok(await signedOut.locator('a[href="/register"]').count(), "a register link");
  for (const gone of ["/leaderboard", "/hot", "/agent", "/topics"]) assert.equal(await page.locator(`a[href="${gone}"]`).count(), 0, `no ${gone} link`);
  await page.context().close();
});

test("at 390px the magazine paper runs edge to edge (no light side strips)", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  for (const path of ["/", "/archive"]) {
    await page.goto(`${WEB}${path}`, { waitUntil: "load" });
    await page.locator(".magazine").first().waitFor();
    const box = await page.locator(".magazine").first().boundingBox();
    assert.ok(box && Math.round(box.x) === 0 && Math.round(box.width) === 390, `${path}: paper at ${box?.x}+${box?.width}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, `${path}: no horizontal scroll`);
  }
  await ctx.close();
});

test("/chat signed out shows the login gate with the input closed", async () => {
  const page = await fresh();
  await page.goto(`${WEB}/chat`, { waitUntil: "load" });
  const gate = page.locator(".chat-gate");
  await gate.waitFor({ timeout: 10_000 });
  assert.match(await gate.innerText(), /登录/);
  assert.equal(await gate.locator('a[href="/login?next=%2Fchat"]').count(), 1);
  assert.equal(await page.locator(".chat-inputbar input").isDisabled(), true);
  assert.equal(await page.locator("text=正在想").count(), 0, "no endless thinking line");
  await page.context().close();
});

test("open registration → 今日; chat without a model points to 设置; a BYOK key makes the chat answer; a 503 gets a retry", async () => {
  const page = await fresh();
  await register(page, `e2e-${RUN}-a@example.com`);

  await page.goto(`${WEB}/chat`, { waitUntil: "load" });
  const gate = page.locator(".chat-gate");
  await gate.waitFor({ timeout: 10_000 });
  assert.match(await gate.innerText(), /设置|Key/);
  await gate.locator('a[href="/settings#model-key"]').click();
  await page.waitForURL(/\/settings/);
  const status = page.getByTestId("chat-model-status");
  await status.waitFor();
  await page.waitForFunction(() => !/正在|读取/.test(document.querySelector('[data-testid="chat-model-status"]')?.textContent ?? "正在"));
  const before = await status.innerText();
  assert.match(before, /没有可用的模型/, `before a key: ${before}`);

  await page.fill("#key-provider", "openai");
  await page.fill("#key-api", "sk-e2e-0000");
  await page.fill("#key-base", modelUrl);
  await page.fill("#key-model", "fake-model");
  await page.click("#model-key button.primary");
  await page.locator("#model-key .settings-msg.ok").waitFor({ timeout: 10_000 });
  await page.waitForFunction((b) => (document.querySelector('[data-testid="chat-model-status"]')?.textContent ?? "") !== b, before, { timeout: 10_000 });
  const afterText = await status.innerText();
  assert.match(afterText, /^你自己的 Key（…0000）$/, `after a key: ${afterText}`);

  await page.goto(`${WEB}/chat`, { waitUntil: "load" });
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".chat-gate").count(), 0, "no gate once a key works");
  const hits = modelHits;
  const input = page.locator(".chat-inputbar input");
  await input.fill("帮我跟踪人形机器人");
  await input.press("Enter");
  await page.locator(".chat-chips .chip").first().waitFor({ timeout: 20_000 });
  assert.ok(modelHits > hits, "the fake model (the reader's key) answered");
  assert.equal(await page.locator(".chat-chips .chip").count(), 3);

  // One failed send: the line says 没发出去 and a retry resends it.
  let failed = false;
  await page.route("**/api/me/chat", async (route) => {
    if (route.request().method() === "POST" && !failed) {
      failed = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", detail: "busy" }) });
    } else await route.continue();
  });
  await input.fill("换个问题");
  await input.press("Enter");
  const retry = page.locator(".chat-retry").last();
  await retry.waitFor({ timeout: 10_000 });
  assert.ok(await page.locator(".u.failed").count(), "the failed line is marked");
  await retry.click();
  await page.waitForFunction(() => document.querySelectorAll(".u.failed").length === 0, undefined, { timeout: 20_000 });
  assert.equal(await page.locator("text=正在想").count(), 0, "nothing left thinking");
  await page.context().close();
});

test("the reminder feed: generate in 设置, the URL answers Atom; disabling it 404s", async () => {
  const page = await fresh();
  await register(page, `e2e-${RUN}-b@example.com`);
  await page.goto(`${WEB}/settings#reminder`, { waitUntil: "load" });
  await page.locator("#reminder button.primary").click();
  const url = await page.getByTestId("feed-url").inputValue({ timeout: 10_000 });
  assert.match(url, new RegExp(`^${WEB}/feed/issue/[A-Za-z0-9_-]{43}\\.xml$`));
  const r = await fetch(url);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /atom\+xml/);
  assert.match(await r.text(), /<feed[\s>]/);
  await page.locator("#reminder button", { hasText: "关闭" }).click();
  await page.getByTestId("feed-state").filter({ hasNotText: "已开启" }).waitFor({ timeout: 10_000 });
  assert.equal((await fetch(url)).status, 404);

  // Logout, then login lands on 今日.
  await page.goto(`${WEB}/settings`, { waitUntil: "load" });
  await page.locator("button", { hasText: "退出" }).first().click();
  await page.locator(".settings-msg.ok").waitFor({ timeout: 10_000 });
  await page.goto(`${WEB}/login`, { waitUntil: "load" });
  await page.fill("input[name=email]", `e2e-${RUN}-b@example.com`);
  await page.fill("input[name=password]", "e2e-password-123");
  await page.click("button[type=submit]");
  await page.waitForURL(`${WEB}/`, { timeout: 15_000 });
  await page.context().close();
});

async function addKey(page: Page): Promise<void> {
  await page.goto(`${WEB}/settings#model-key`, { waitUntil: "load" });
  await page.fill("#key-provider", "openai");
  await page.fill("#key-api", "sk-e2e-0000");
  await page.fill("#key-base", modelUrl);
  await page.fill("#key-model", "fake-model");
  await page.click("#model-key button.primary");
  await page.locator("#model-key .settings-msg.ok").waitFor({ timeout: 10_000 });
}

/** A reader made on the database and signed in by cookie: the UI registration is covered above, and
 * its per-client limit (5 an hour) would refuse the rest of the run. */
async function signedIn(email: string): Promise<Page> {
  const { token } = await registerWithInvite({ code: "", email, password: "e2e-password-123" }, sql, "open");
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: SESSION_COOKIE, value: token, url: WEB }]);
  return ctx.newPage();
}

const userIdOf = async (email: string) => (await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`)[0]!.id;

/** Two sources and four publications on them (no source past the per-source cap of 2), plus an off-topic one elsewhere; a project for `ownerId`. */
async function seedIssue(ownerId: string, target: string): Promise<{ projectId: string; inScope: string[]; offTopic: string }> {
  const t = `${RUN}-${randomBytes(2).toString("hex")}`;
  const src = `e2e-src-${t}`;
  const src2 = `e2e-src2-${t}`;
  const car = `e2e-car-${t}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at) VALUES
    (${src}, ${`具身智能前沿 ${t}`}, 'rss', 'T1', 'editorial', true, '2100-01-01'), (${src2}, ${`机器人日报 ${t}`}, 'rss', 'T1', 'editorial', true, '2100-01-01'), (${car}, ${`汽车周刊 ${t}`}, 'rss', 'T1', 'editorial', true, '2100-01-01')`;
  const projectId = (await createProject({ ownerId, target, purpose: `跟踪${target}`, sources: [{ sourceId: src, required: false }, { sourceId: src2, required: false }] })).project.id;
  const pubs = [
    { src, title: `Figure 03 量产线投产 ${t}`, score: 95 },
    { src, title: `开源 VLA 模型刷新基准 ${t}`, score: 90 },
    { src: src2, title: `灵巧手成本降到千元级 ${t}`, score: 85 },
    { src: src2, title: `仿真数据集更新 ${t}`, score: 60 },
    { src: car, title: `新款电动轿车上市 ${t}`, score: 99 },
  ];
  const inScope: string[] = [];
  let offTopic = "";
  for (const [i, p] of pubs.entries()) {
    // A reader's first issue takes the last 24 hours up to now.
    const at = new Date(Date.now() - (10 + i) * 60_000);
    const url = `https://example.org/e2e-${t}-${i}`;
    const id = (await upsertMaterial({ sourceId: p.src, url, title: p.title, bodyText: p.title, bodyStatus: "ok", via: "fetch", publishedAt: at })).articleId;
    await sql`INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, score, visible_after, listed_at)
      VALUES (${id}, ${p.title}, ${p.title}, ${`摘要：${p.title}`}, ${p.src}, 'news', ${url}, ${at}, ${at}, ${at}, ${at}, true, ${p.score}, ${at}, ${at})`;
    await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${id}`;
    if (p.src === car) offTopic = p.title;
    else inScope.push(p.title);
  }
  return { projectId, inScope, offTopic };
}

test("an unknown path answers 404 with the way back to 今日", async () => {
  const page = await fresh();
  const r = await page.goto(`${WEB}/no-such-page-${RUN}`, { waitUntil: "load" });
  assert.equal(r?.status(), 404);
  assert.match(await page.locator("main").innerText(), /这里没有内容/);
  assert.equal(await page.locator('main a[href="/"]').count() > 0, true);
  await page.context().close();
});

test("signed out, 项目 / 设置 / a project's 今日 ask to log in; 往期 and one issue show the signed-out copy", async () => {
  const page = await fresh();
  for (const path of ["/projects", "/settings", "/today/some-project"]) {
    await page.goto(`${WEB}${path}`, { waitUntil: "load" });
    await page.locator("text=请先登录。").first().waitFor({ timeout: 10_000 });
    assert.ok(await page.locator('main a[href^="/login"]').count(), `${path}: a login link`);
  }
  for (const path of ["/archive", "/issue/2026-01-01"]) {
    await page.goto(`${WEB}${path}`, { waitUntil: "load" });
    await page.locator("text=登录后就能看到你的今日").first().waitFor({ timeout: 10_000 });
  }
  assert.equal((await fetch(`http://127.0.0.1:${API_PORT}/api/me/today`)).status, 401);
  await page.context().close();
});

test("a wrong password says so and stays on /login; registering a taken email is refused", async () => {
  const email = `e2e-${RUN}-c@example.com`;
  const page = await signedIn(email);
  await page.context().close();
  const p2 = await fresh();
  await p2.goto(`${WEB}/login`, { waitUntil: "load" });
  await p2.fill("input[name=email]", email);
  await p2.fill("input[name=password]", "not-the-password-1");
  await p2.click("button[type=submit]");
  await p2.locator('[role=alert]', { hasText: "邮箱或密码不对" }).waitFor({ timeout: 10_000 });
  assert.equal(new URL(p2.url()).pathname, "/login");
  await p2.goto(`${WEB}/register`, { waitUntil: "load" });
  await p2.fill("#email", email);
  await p2.fill("#password", "e2e-password-123");
  await p2.click("button[type=submit]");
  await p2.locator("text=这个邮箱已经注册过了").waitFor({ timeout: 10_000 });
  assert.equal(new URL(p2.url()).pathname, "/register");
  await p2.context().close();
});

test("login with ?next=/chat lands on the chat; an off-site next is ignored", async () => {
  const email = `e2e-${RUN}-d@example.com`;
  const page = await signedIn(email);
  await page.context().close();
  for (const [next, want] of [["%2Fchat", "/chat"], ["https%3A%2F%2Fevil.example%2F", "/"], ["%2F%2Fevil.example", "/"]] as const) {
    const p = await fresh();
    await p.goto(`${WEB}/login?next=${next}`, { waitUntil: "load" });
    await p.fill("input[name=email]", email);
    await p.fill("input[name=password]", "e2e-password-123");
    await p.click("button[type=submit]");
    await p.waitForURL((u) => u.pathname !== "/login", { timeout: 15_000 });
    assert.equal(new URL(p.url()).origin, WEB, `next=${next} stays on the site`);
    assert.equal(new URL(p.url()).pathname, want, `next=${next}`);
    await p.context().close();
  }
});

test("the admin area: signed out or as a reader it goes to /admin/login, and the admin API refuses a reader", async () => {
  const page = await fresh();
  await page.goto(`${WEB}/admin`, { waitUntil: "load" });
  await page.waitForURL(/\/admin\/login/);
  await page.context().close();
  const reader = await signedIn(`e2e-${RUN}-e@example.com`);
  await reader.goto(`${WEB}/admin/sources`, { waitUntil: "load" });
  await reader.waitForURL(/\/admin\/login/);
  const cookie = (await reader.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const r = await fetch(`http://127.0.0.1:${API_PORT}/api/admin/sources`, { headers: { cookie } });
  assert.ok(r.status === 401 || r.status === 403, `admin API with a reader's cookie: ${r.status}`);
  await reader.context().close();
});

test("今日 for a reader with a project: the Top 3 by score, the off-topic story out; a card opens its AI summary; 往期 lists the earlier day only and opens it; a bad date is 404", async () => {
  const email = `e2e-${RUN}-f@example.com`;
  const page = await signedIn(email);
  const seed = await seedIssue(await userIdOf(email), "具身智能");
  await page.goto(`${WEB}/`, { waitUntil: "load" });
  await page.locator(".m-t").nth(2).waitFor({ timeout: 15_000 });
  const titles = (await page.locator(".m-t").allInnerTexts()).map((t) => t.trim());
  assert.deepEqual(titles, seed.inScope.slice(0, 3));
  assert.ok(!titles.includes(seed.offTopic));
  await page.locator(".m-row-t").first().click();
  await page.locator(".m-sum").first().waitFor({ timeout: 5_000 });
  assert.match(await page.locator(".m-sum").first().innerText(), /摘要：Figure 03/);
  // 往期 is the past days only (as the API defines it): today's issue is on 今日. An earlier day with
  // the leftover 4th story is put in directly.
  const userId = await userIdOf(email);
  const past = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const [{ article_id: leftover }] = await sql<{ article_id: string }[]>`SELECT article_id FROM publications WHERE title = ${seed.inScope[3]!}`;
  await sql`INSERT INTO user_issues (user_id, issue_date, issue_no, cutoff, window_since) VALUES (${userId}, ${past}, 0, now(), now())`;
  await sql`INSERT INTO user_issue_items (user_id, issue_date, position, article_id, project_id, score, listed_at) VALUES (${userId}, ${past}, 1, ${leftover}, ${seed.projectId}, 60, now())`;
  await page.goto(`${WEB}/archive`, { waitUntil: "load" });
  await page.locator(".arch-item").first().waitFor({ timeout: 10_000 });
  assert.equal(await page.locator(".arch-item").count(), 1, "only the earlier day");
  await page.locator(".arch-item").first().click();
  await page.waitForURL(new RegExp(`/issue/${past}$`));
  await page.locator(".m-t").first().waitFor({ timeout: 10_000 });
  assert.deepEqual((await page.locator(".m-t").allInnerTexts()).map((t) => t.trim()), [seed.inScope[3]], "the earlier issue's story");
  // A date that is not a day is the 404 page, not an empty issue.
  for (const bad of ["2026-02-30", "not-a-date"]) {
    const r = await page.goto(`${WEB}/issue/${bad}`, { waitUntil: "load" });
    assert.equal(r?.status(), 404, bad);
    assert.match(await page.locator("main").innerText(), /这里没有内容/);
  }
  await page.context().close();
});

test("another reader's project: /today/<id> says 没有这个项目 and the issue API shows none of its stories", async () => {
  const a = `e2e-${RUN}-g@example.com`;
  const b = `e2e-${RUN}-h@example.com`;
  const pa = await signedIn(a);
  const seed = await seedIssue(await userIdOf(a), "A 的项目");
  await pa.context().close();
  const pb = await signedIn(b);
  await pb.goto(`${WEB}/today/${encodeURIComponent(seed.projectId)}`, { waitUntil: "load" });
  await pb.locator("text=没有这个项目").waitFor({ timeout: 10_000 });
  assert.equal(await pb.locator("text=A 的项目").count(), 0);
  const cookie = (await pb.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const today = await (await fetch(`http://127.0.0.1:${API_PORT}/api/me/today`, { headers: { cookie } })).text();
  for (const t of seed.inScope) assert.equal(today.includes(t), false, "B never sees A's stories");
  await pb.context().close();
});

test("对话问诊: option chips, the summary to confirm, a card; 再改改 creates nothing; 确认创建 adds the project", async () => {
  const email = `e2e-${RUN}-i@example.com`;
  const page = await signedIn(email);
  await seedIssue(await userIdOf(email), "具身智能");
  await addKey(page);
  await page.goto(`${WEB}/chat`, { waitUntil: "load" });
  const input = page.locator(".chat-inputbar input");
  await input.fill("帮我跟踪人形机器人量产");
  await input.press("Enter");
  for (let i = 1; i <= 3; i++) {
    const chips = page.locator(".chat-chips .chip");
    await page.locator(".chat-msg .a", { hasText: `第 ${i} 问` }).waitFor({ timeout: 20_000 });
    assert.deepEqual(await chips.allInnerTexts(), ["量产", "融资", "其他"]);
    await chips.first().click();
  }
  const yes = page.locator(".chat-chips .chip", { hasText: "对，就按这个" });
  await yes.waitFor({ timeout: 20_000 });
  const owner = await userIdOf(email);
  const count = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tracking_projects WHERE owner_id = ${owner}`)[0]!.n;
  assert.equal(await count(), 1, "nothing created before the card");
  await yes.click();
  const card = page.locator(".chat-card").last();
  await card.locator("button", { hasText: "确认创建" }).waitFor({ timeout: 20_000 });
  await card.locator("text=展开全部").click();
  await page.waitForFunction(() => /具身智能前沿/.test([...document.querySelectorAll(".chat-card")].at(-1)?.textContent ?? ""), undefined, { timeout: 5_000 });
  await card.locator("button", { hasText: "再改改" }).click();
  await page.waitForTimeout(800);
  assert.equal(await count(), 1, "再改改 creates nothing");
  await input.fill("就按刚才的");
  await input.press("Enter");
  const card2 = page.locator(".chat-card").last();
  await card2.locator("button", { hasText: "确认创建" }).waitFor({ timeout: 20_000 });
  await card2.locator("button", { hasText: "确认创建" }).click();
  await page.waitForFunction(() => /我的项目（2）/.test(document.querySelector(".chat-projbar")?.textContent ?? ""), undefined, { timeout: 20_000 });
  assert.equal(await count(), 2);
  await page.context().close();
});

test("a 429 on send says 发得太快了 and keeps a retry", async () => {
  const page = await signedIn(`e2e-${RUN}-j@example.com`);
  await addKey(page);
  await page.goto(`${WEB}/chat`, { waitUntil: "load" });
  await page.route("**/api/me/chat", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ code: "rate_limited" }) });
    else await route.continue();
  });
  const input = page.locator(".chat-inputbar input");
  await input.fill("你好");
  await input.press("Enter");
  await page.locator(".chat-note", { hasText: "发得太快了" }).waitFor({ timeout: 10_000 });
  assert.ok(await page.locator(".chat-retry").count());
  assert.equal(await page.locator("text=正在想").count(), 0);
  await page.context().close();
});

test("at 1280px every reader page fits the width and keeps the top nav", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  for (const path of ["/", "/archive", "/chat", "/settings", "/projects", "/about", "/feedback", "/login"]) {
    await page.goto(`${WEB}${path}`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1280, `${path}: no horizontal scroll`);
    if (path !== "/login") assert.ok(await page.locator('nav a[href="/archive"]').count(), `${path}: nav`);
  }
  await ctx.close();
});

test("about / feedback render without linking terms or privacy, and those two pages are off (404)", async () => {
  const page = await fresh();
  for (const path of ["/about", "/feedback"]) {
    const r = await page.goto(`${WEB}${path}`, { waitUntil: "load" });
    assert.equal(r?.status(), 200, path);
    assert.ok(await page.locator("h1").count(), `${path}: a heading`);
    assert.equal(await page.locator('a[href="/terms"], a[href="/privacy"]').count(), 0, `${path}: no terms/privacy link`);
  }
  for (const path of ["/terms", "/privacy"]) {
    const r = await page.goto(`${WEB}${path}`, { waitUntil: "load" });
    assert.equal(r?.status(), 404, `${path} is off`);
  }
  await page.context().close();
});

// --- The English UI (docs/decisions/0004 amendment) ------------------------------------------------

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** Text that comes from the database (seeded packs and sources, stories): it may be Chinese. */
async function dataStrings(): Promise<string[]> {
  const packs = await sql<{ label: string; sources: Array<{ name?: string; publisher?: string }> }[]>`SELECT label, sources FROM source_packs`;
  const names = (await sql<{ name: string }[]>`SELECT name FROM sources`).map((r) => r.name);
  const titles = (await sql<{ t: string }[]>`SELECT title AS t FROM articles UNION SELECT title FROM publications UNION SELECT summary FROM publications UNION SELECT title_zh FROM analyses UNION SELECT summary_zh FROM analyses UNION SELECT target FROM tracking_projects UNION SELECT purpose FROM tracking_projects`).map((r) => r.t);
  const all = [...packs.flatMap((p) => [p.label, ...p.sources.flatMap((x) => [x.name ?? "", x.publisher ?? ""])]), ...names, ...titles];
  return [...new Set(all.filter((x) => x && CJK.test(x)))].sort((a, b) => b.length - a.length);
}

/** Chinese on the page outside the allowed data and the language switch: its text and its labels. */
async function chineseOn(page: Page, allow: string[], scope = "body"): Promise<string[]> {
  const pieces = await page.evaluate((sel) => {
    const out: string[] = [];
    for (const root of document.querySelectorAll(sel)) {
      out.push((root as HTMLElement).innerText);
      for (const el of [root, ...root.querySelectorAll("*")]) {
        for (const a of ["aria-label", "placeholder", "title", "alt"]) {
          const v = el.getAttribute(a);
          if (v) out.push(v);
        }
      }
    }
    out.push(document.title);
    return out;
  }, scope);
  const hits: string[] = [];
  for (let text of pieces) {
    for (const a of [...allow, "简体中文"]) text = text.split(a).join("");
    for (const line of text.split("\n")) if (CJK.test(line)) hits.push(line.trim().slice(0, 120));
  }
  return [...new Set(hits)];
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test("a reader who picks English sees no Chinese on any page; back to 简体中文 the Chinese UI returns", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await register(page, `en-${RUN}@example.com`);
  const set = async (locale: string) => {
    const r = await page.request.patch(`${WEB}/api/auth/me`, { data: { locale, timezone: "America/New_York" } });
    assert.equal(r.status(), 200, `PATCH locale ${locale}`);
  };
  await set("en");
  const allow = await dataStrings();
  const pages: Array<[string, string]> = [
    ["today", "/"], ["archive", "/archive"], ["chat", "/chat"], ["settings", "/settings"], ["projects", "/projects"],
    ["projects-new", "/projects/new"], ["about", "/about"], ["feedback", "/feedback"], ["issue-404", "/issue/2001-01-01"], ["not-found", "/no-such-page"],
  ];
  for (const [name, path] of pages) {
    await page.goto(`${WEB}${path}`, { waitUntil: "load" });
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.lang), "en", `${path}: html lang`);
    assert.deepEqual(await chineseOn(page, allow), [], `${path}: no Chinese in the English UI`);
    await shot(page, `en-${name}`);
  }
  // The reader's own time zone shows in Settings (the issue is fixed at 08:00 there).
  await page.goto(`${WEB}/settings`, { waitUntil: "load" });
  await settle(page);
  assert.equal(await page.locator("[data-testid=timezone-select]").inputValue(), "America/New_York");
  // Click through the creation wizard: pick a pack, then the sources step and the naming step. A pack
  // is offered once one of its sources is a real editorial row, so make the first one real.
  const [pack] = await sql<{ label: string; sources: Array<{ id: string; name: string }> }[]>`SELECT label, sources FROM source_packs ORDER BY id LIMIT 1`;
  assert.ok(pack?.sources[0], "a seeded pack with a source");
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, next_fetch_at)
    VALUES (${pack.sources[0].id}, ${pack.sources[0].name}, 'rss', 'T1', 'editorial', false, '2100-01-01')
    ON CONFLICT (id) DO UPDATE SET participation_mode = 'editorial'`;
  const allowed = await dataStrings();
  await page.goto(`${WEB}/projects/new`, { waitUntil: "load" });
  await settle(page);
  await page.locator("main button", { hasText: pack.label }).first().click();
  await settle(page);
  assert.deepEqual(await chineseOn(page, allowed), [], "wizard sources step");
  await shot(page, "en-projects-new-sources");
  await page.getByRole("button", { name: "That's all, next" }).click();
  await settle(page);
  assert.deepEqual(await chineseOn(page, allowed), [], "wizard naming step");
  await shot(page, "en-projects-new-naming");
  await page.goto(`${WEB}/settings`, { waitUntil: "load" });
  await settle(page);
  await shot(page, "en-settings-full");

  await set("zh-CN");
  for (const [name, path] of [["today", "/"], ["settings", "/settings"], ["about", "/about"]] as const) {
    await page.goto(`${WEB}${path}`, { waitUntil: "load" });
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.lang), "zh-CN", `${path}: html lang`);
    await shot(page, `zh-${name}`);
  }
  await page.goto(`${WEB}/`, { waitUntil: "load" });
  await settle(page);
  assert.match(await page.locator("nav").first().innerText(), /今日/);
  await ctx.close();
});

test("SITE_LOCALE=en: visitors and the admin get English (the admin chrome scanned on every page)", async () => {
  const port = WEB_PORT + 7;
  const site = `http://127.0.0.1:${port}`;
  launch(`${ROOT}apps/web`, "server.ts", { ...env({}), SITE_URL: site, SITE_LOCALE: "en", WEB_PORT: String(port), WEB_HOST: "127.0.0.1", API_BASE_URL: `http://127.0.0.1:${API_PORT}` }, "web-en");
  await waitFor(`${site}/`);
  const allow = await dataStrings();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (const [name, path] of [["visitor-today", "/"], ["visitor-login", "/login"], ["visitor-register", "/register"], ["visitor-about", "/about"], ["admin-login", "/admin/login"]] as const) {
    await page.goto(`${site}${path}`, { waitUntil: "load" });
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.lang), "en", `${path}: html lang`);
    assert.deepEqual(await chineseOn(page, allow), [], `${path}: no Chinese for a visitor`);
    await shot(page, `site-en-${name}`);
  }
  // A wrong sign-in: the API's Chinese detail is not what the English page shows.
  await page.goto(`${site}/login`, { waitUntil: "load" });
  await page.fill("#email", `nobody-${RUN}@example.com`);
  await page.fill("#password", "not-the-password-123");
  await page.click("button[type=submit]");
  await page.getByText("Wrong email or password.").waitFor({ timeout: 10_000 });
  assert.deepEqual(await chineseOn(page, allow), [], "login error");
  await shot(page, "site-en-login-error");

  await page.goto(`${site}/admin/login`, { waitUntil: "load" });
  await page.fill("input[name=password]", ADMIN_PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL((u) => u.pathname.startsWith("/admin") && u.pathname !== "/admin/login", { timeout: 15_000 });
  const adminPages = ["/admin/content", "/admin/sources", "/admin/sources/new", "/admin/runs", "/admin/monitor", "/admin/models", "/admin/selectbench", "/admin/settings", "/admin/feedback", "/admin/audit"];
  const [firstSource] = await sql<{ id: string }[]>`SELECT id FROM sources ORDER BY id LIMIT 1`;
  if (firstSource) adminPages.push(`/admin/sources/${encodeURIComponent(firstSource.id)}`);
  const [firstArticle] = await sql<{ id: string }[]>`SELECT id FROM articles ORDER BY discovered_at DESC LIMIT 1`;
  if (firstArticle) adminPages.push(`/admin/content/${encodeURIComponent(firstArticle.id)}`);
  for (const path of adminPages) {
    await page.goto(`${site}${path}`, { waitUntil: "load" });
    await settle(page);
    assert.ok(!page.url().includes("/admin/login"), `${path}: signed in`);
    // Chrome only: navigation, headings, table headers, labels, buttons and the accessible names. Rows
    // are data (story titles, source names, model output) and may be in any language.
    assert.deepEqual(await chineseOn(page, allow, "aside, nav, h1, h2, h3, th, label, button, dt, [role=tab]"), [], `${path}: admin chrome in English`);
    await shot(page, `site-en-admin-${path.replace(/^\/admin\/?/, "").replace(/[^a-z0-9]+/gi, "-") || "home"}`);
  }
  await ctx.close();
});
