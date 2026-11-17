// The online demo's data export (scripts/pages-export.ts, packages/backend/src/site/pages-export.ts):
// a reader's fixed issues become static JSON with every field whitelisted, ids replaced, and a leak
// scan that refuses to write anything carrying an email, id, key, local address or deny-listed term.
import "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { leakScan, pagesFiles, projectAliases, publicIssue, PAGES_SCHEMA_VERSION } from "@topka/backend/site/pages-export";
import type { Issue } from "@topka/backend/projects/issues";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const exporter = path.join(ROOT, "scripts/pages-export.ts");
const READER = "demo@example.com";
const tmp = mkdtempSync(path.join(tmpdir(), "pages-export-"));
const env = { ...process.env, PAGES_DEMO_READER: "", OSS_DENYLIST: "" };
let readerId = "";

before(async () => {
  // The offline demo seed gives a reader with three fixed issues on three days.
  await run(process.execPath, [path.join(ROOT, "scripts/demo.ts"), "--force"], { env: { ...env, DEMO_PASSWORD: "demo-test-password-1", DEMO_SEED: "" } });
  readerId = (await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${READER}`)[0]!.id;
});
after(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

const readAll = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(d, f.name), `${prefix}${f.name}/`);
      else out[`${prefix}${f.name}`] = readFileSync(path.join(d, f.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
};

test("the export writes meta, today, the archive and one file per issue, newest first", async () => {
  const out = path.join(tmp, "data");
  const r = await run(process.execPath, [exporter, "--out", out, "--reader", READER], { env });
  assert.match(r.stdout, /3 issues, latest \d{4}-\d{2}-\d{2}, \d+ files, leak scan clean/);
  assert.doesNotMatch(r.stdout + r.stderr, /demo@example\.com/, "the reader's email is never printed");
  const files = readAll(out);
  const dates = Object.keys(files).filter((f) => f.startsWith("issues/")).map((f) => f.slice(7, 17)).sort();
  assert.equal(dates.length, 3);
  const meta = JSON.parse(files["meta.json"]!);
  assert.equal(meta.schemaVersion, PAGES_SCHEMA_VERSION);
  assert.equal(meta.latestIssueDate, dates.at(-1));
  assert.equal(meta.issueCount, 3);
  assert.ok(Date.now() - Date.parse(meta.updatedAt) < 60_000, "updatedAt is when the export ran");
  const today = JSON.parse(files["today.json"]!);
  assert.equal(today.issue.date, dates.at(-1), "today.json is the latest fixed issue, not a new one");
  assert.equal(today.issue.items.length, 3);
  assert.equal(today.nextAt, null, "the demo never promises the next issue");
  assert.deepEqual(JSON.parse(files["issues.json"]!).archive.map((a: { date: string }) => a.date), dates.slice(0, 2).reverse());
  // Real copy, real links.
  for (const it of today.issue.items) {
    assert.ok(it.title_a && it.summary, "title and summary are there");
    assert.match(it.url, /^https:\/\/example\.org\//);
  }
});

test("nothing private survives: no ids, emails, scores or read marks; projects are aliased", async () => {
  const files = readAll(path.join(tmp, "data"));
  const all = Object.values(files).join("\n");
  const [{ email }] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${readerId}`;
  const projects = await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM tracking_projects WHERE owner_id = ${readerId}`;
  const articles = await sql<{ article_id: string }[]>`SELECT article_id FROM user_issue_items WHERE user_id = ${readerId}`;
  for (const secret of [email, readerId, ...projects.flatMap((p) => [p.id, p.slug]), ...articles.map((a) => a.article_id)]) {
    assert.ok(!all.includes(secret), `leaked: ${secret.slice(0, 6)}…`);
  }
  const today = JSON.parse(files["today.json"]!);
  assert.deepEqual(today.user, { id: "demo" });
  assert.deepEqual(today.opened, []);
  for (const it of today.issue.items) {
    assert.equal(it.score, null);
    assert.match(it.id, /^\d{4}-\d{2}-\d{2}-\d+$/);
    assert.match(it.project.id, /^demo-\d+$/);
    assert.deepEqual(Object.keys(it).sort(), ["core_a", "core_b", "hasCopy", "id", "ledger", "listedAt", "overBudget", "position", "project", "publishedAt", "score", "source", "summary", "tag", "title_a", "title_b", "url", "withdrawal"]);
  }
  assert.deepEqual(leakScan(files), [], "the written files pass the scan on their own");
});

test("a deny-listed term in the content refuses the export and leaves the old data in place", async () => {
  const out = path.join(tmp, "data");
  const before = readAll(out);
  const deny = path.join(tmp, "deny.txt");
  const today = JSON.parse(before["today.json"]!);
  writeFileSync(deny, `# operator's private names\n${today.issue.items[0].source}\n`);
  await assert.rejects(run(process.execPath, [exporter, "--out", out, "--reader", READER, "--deny", deny], { env }), (e: { code?: number; stderr?: string; stdout?: string }) => {
    assert.equal(e.code, 1);
    assert.match(e.stderr ?? "", /deny-list term/);
    assert.ok(!(e.stderr ?? "").includes(today.issue.items[0].source), "the refusal names no content");
    return true;
  });
  assert.deepEqual(readAll(out), before, "nothing was overwritten");
});

test("usage errors exit 2, an unknown reader exits 1", async () => {
  await assert.rejects(run(process.execPath, [exporter, "--out", path.join(tmp, "x")], { env }), (e: { code?: number }) => e.code === 2);
  await assert.rejects(run(process.execPath, [exporter, "--out", path.join(tmp, "x"), "--reader", READER, "--limit", "0"], { env }), (e: { code?: number }) => e.code === 2);
  await assert.rejects(run(process.execPath, [exporter, "--bogus"], { env }), (e: { code?: number }) => e.code === 2);
  await assert.rejects(run(process.execPath, [exporter, "--out", path.join(tmp, "x"), "--reader", "nobody@example.com"], { env }), (e: { code?: number; stderr?: string }) => {
    assert.equal(e.code, 1);
    assert.doesNotMatch(e.stderr ?? "", /nobody@/);
    return true;
  });
  assert.equal(existsSync(path.join(tmp, "x")), false);
});

test("leakScan catches each kind of private value", () => {
  const clean = { "meta.json": "{}" };
  assert.deepEqual(leakScan(clean), []);
  const cases: Array<[string, string]> = [
    ["someone@example.com", "email address"],
    ["43462d0a-1111-4222-8333-444455556666", "uuid"],
    ["sk-or-v1-0123456789abcdef0123456789abcdef", "api key"],
    ["ghp_0123456789abcdefghijABCDEFGHIJ", "api key"],
    ["Authorization: Bearer abcdefghijklmnop", "bearer token"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----", "private key"],
    ["http://127.0.0.1:3000/x", "local address"],
    ["/srv/topka/.env", "machine path"],
  ];
  for (const [text, kind] of cases) assert.ok(leakScan({ "today.json": JSON.stringify({ text }) }).some((p) => p.includes(kind)), kind);
  assert.deepEqual(leakScan({ "today.json": JSON.stringify({ url: "https://example.com/srv/news/1" }) }), [], "a path inside a link is not a machine path");
  assert.deepEqual(leakScan({ "today.json": "the codename Bluebird" }, ["bluebird"]), ["today.json: private value #1"]);
  assert.deepEqual(leakScan({ "today.json": "the codename Bluebird" }, [], ["BLUEBIRD"]), ["today.json: deny-list term #1"]);
  assert.deepEqual(leakScan({ "today.json": "abc" }, ["abc"]), [], "terms under 4 characters are ignored (too many false hits)");
  assert.deepEqual(leakScan({ "secrets.json": "{}" }), ["secrets.json: unexpected file name"]);
});

test("pagesFiles: a project only an older issue names still gets an alias; empty issues are skipped; non-web links are dropped", () => {
  const item = (projectId: string, position: number, url: string) => ({
    position, title_a: "T", title_b: "", core_a: "C", core_b: "", summary: "S", tag: "", source: "Src", url, score: 0.9,
    project: { id: projectId, slug: `slug-${projectId}`, target: `target ${projectId}` }, publishedAt: null, listedAt: "2026-11-01T00:00:00Z",
    hasCopy: true, overBudget: false, ledger: "current", withdrawal: null, articleId: "secret-article",
  });
  const issues = [
    { date: "2026-11-02", no: 2, fixedAt: "2026-11-02T00:00:00Z", hero: false, ready: true, items: [item("p-now", 1, "https://a.example/1")] },
    { date: "2026-11-01", no: 1, fixedAt: "2026-11-01T00:00:00Z", hero: false, ready: true, items: [item("p-gone", 1, "javascript:alert(1)")] },
    { date: "2026-10-31", no: 0, fixedAt: null, hero: false, ready: true, items: [] },
  ] as unknown as Issue[];
  const files = pagesFiles({ projects: [{ id: "p-now", slug: "s", target: "now" }], issues, archive: issues.map((i) => ({ date: i.date, no: i.no, titles: ["T"] })) as never, issueCount: 3, timeZone: "Asia/Taipei", locale: "en" }, new Date("2026-11-02T12:00:00Z"));
  assert.deepEqual(Object.keys(files).sort(), ["issues.json", "issues/2026-11-01.json", "issues/2026-11-02.json", "meta.json", "today.json"]);
  const older = (files["issues/2026-11-01.json"] as { issue: { items: Array<{ project: { id: string }; url: string }> } }).issue.items[0]!;
  assert.equal(older.project.id, "demo-2");
  assert.equal(older.url, "", "only http(s) links are published");
  assert.equal((files["meta.json"] as { contentLang: string; issueTimeZone: string }).contentLang, "en");
  assert.equal((files["meta.json"] as { issueTimeZone: string }).issueTimeZone, "Asia/Taipei");
  assert.ok(!JSON.stringify(files).includes("secret-article"));
  assert.deepEqual(projectAliases([{ id: "x", slug: "y", target: "z" }]).get("x"), { id: "demo-1", slug: "demo-1", target: "z" });
  assert.equal(publicIssue(issues[0]!, projectAliases([{ id: "p-now", slug: "s", target: "now" }])).items[0]!.score, null);
});
