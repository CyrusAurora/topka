// Regression tests for the CodeQL triage (docs/security/codeql-triage.md): each alert that pointed at a
// real weakness has the attack it describes run here and refused.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { after, test } from "node:test";

const T = tag();
// config reads ADMIN_PASSWORD once, at its first import: set it before anything loads it.
process.env.ADMIN_PASSWORD = `hardening-admin-${T}-password`;
process.env.INGEST_TOKEN = `ingest-${T}-0123456789abcdef`;
process.env.REGISTRATION_MODE = "open";
const { config } = await import("@topka/backend/config");
const { closeDb } = await import("@topka/backend/db");
const { passwordLogin } = await import("@topka/backend/admin/auth");
const { registerWithInvite } = await import("@topka/backend/accounts/register");
const { SESSION_COOKIE } = await import("@topka/backend/accounts/session");
const { stripTags } = await import("@topka/backend/lib/text");
const { cleanArticleTextForLLM } = await import("@topka/backend/editorial/writing");
const { withOutline } = await import("@topka/backend/publication/detail");
const { fetchJsonList } = await import("@topka/backend/sources/json-list");
const { resolveRedirect } = await import("@topka/contracts/http-policy");
const { bearerToken } = await import("../apps/api/src/routes/ingest.ts");
const { within } = await import("../apps/api/src/routes/static.ts");
const { LIMITS } = await import("../apps/api/src/http/rate-limit.ts");
const { buildApp } = await import("../apps/api/src/app.ts");
const app = await buildApp();
after(async () => {
  await app.close();
  await closeDb();
});

// js/missing-rate-limiting ---------------------------------------------------------------------------

test("admin password guessing hits the per-address ceiling before any comparison", async () => {
  const guess = (ip: string) =>
    app.inject({ method: "POST", url: "/api/auth/password", remoteAddress: ip, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ password: `not-it-${T}` }).toString() });
  for (let i = 0; i < LIMITS.secret.max; i++) assert.equal((await guess("203.0.113.21")).statusCode, 303);
  const over = await guess("203.0.113.21");
  assert.equal(over.statusCode, 429, over.body);
  assert.equal(over.headers["content-type"], "application/problem+json");
  assert.equal(over.json().code, "rate_limited");
  assert.ok(Number(over.headers["retry-after"]) >= 1 && Number(over.headers["retry-after"]) <= 60, String(over.headers["retry-after"]));
  assert.notEqual((await guess("203.0.113.22")).statusCode, 429, "the ceiling is per address");
});

test("account deletion: wrong passwords run out per account, whatever address they come from", async () => {
  const r = await registerWithInvite({ code: "", email: `harden-${T}@example.com`, password: `${T}-long-enough`, userAgent: "test", ip: "203.0.113.30" });
  const cookie = `${SESSION_COOKIE}=${r.token}`;
  const attempt = (i: number) =>
    app.inject({ method: "POST", url: "/api/auth/delete-account", remoteAddress: `198.51.100.${40 + i}`, headers: { "content-type": "application/json", cookie }, payload: JSON.stringify({ password: `guess-${i}` }) });
  for (let i = 0; i < 10; i++) assert.equal((await attempt(i)).statusCode, 400);
  const over = await attempt(10);
  assert.equal(over.statusCode, 429, over.body);
  assert.equal(over.json().code, "rate_limited");
});

test("the ingest token cannot be guessed at full speed: wrong tokens spend the address's ceiling", async () => {
  const push = (token: string) =>
    app.inject({ method: "POST", url: "/api/ingest/items", remoteAddress: "198.51.100.90", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, payload: "{}" });
  for (let i = 0; i < LIMITS.secret.max; i++) assert.equal((await push(`wrong-token-${i}-0123456789`)).statusCode, 401);
  assert.equal((await push("wrong-token-again-0123456789")).statusCode, 429);
});

test("contact codes are files read per request: past the ceiling 429, not another disk read", async () => {
  const get = () => app.inject({ method: "GET", url: "/contact/nothing-here.png", remoteAddress: "198.51.100.99" });
  for (let i = 0; i < LIMITS.file.max; i++) assert.equal((await get()).statusCode, 404);
  assert.equal((await get()).statusCode, 429);
});

test("routes without a ceiling stay unlimited: the SSR reads all arrive from one loopback address", async () => {
  for (let i = 0; i < LIMITS.signIn.max + 20; i++) {
    const r = await app.inject({ method: "GET", url: "/api/auth/registration", remoteAddress: "127.0.0.1" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["x-ratelimit-limit"], undefined);
  }
});

test("the admin password still signs in, and a wrong one is still refused", async () => {
  const ok = await passwordLogin(process.env.ADMIN_PASSWORD!, "/admin", "test");
  assert.ok(ok.token.length > 20);
  await assert.rejects(passwordLogin(`${process.env.ADMIN_PASSWORD!}x`, "/admin", "test"), /密码不对/);
});

// js/polynomial-redos --------------------------------------------------------------------------------

test("a bearer header of endless whitespace is parsed in linear time", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer \t abc  "), "abc");
  assert.equal(bearerToken("Bearerabc"), "");
  assert.equal(bearerToken("Bearer "), "");
  assert.equal(bearerToken("Basic abc"), "");
  assert.equal(bearerToken(undefined), "");
  const hostile = `bearer${"\t".repeat(200_000)}\n`;
  const started = performance.now();
  assert.equal(bearerToken(hostile), "");
  assert.ok(performance.now() - started < 50, "the old /^Bearer\\s+(.+)$/ is quadratic here: ~130 ms at 16 KB, ~20 s at this length");
});

// js/path-injection ----------------------------------------------------------------------------------

test("a file name can only resolve inside its own directory", async () => {
  const dir = path.join(config.dataDir, "uploads");
  assert.equal(within(dir, "qr-0123abcd.png"), path.join(dir, "qr-0123abcd.png"));
  for (const evil of ["../.env", "../../package.json", "/etc/passwd", "..", ".", "a/../../b.png"]) assert.equal(within(dir, evil), null, evil);
  for (const url of ["/contact/..%2F..%2Fpackage.json", "/contact/%2e%2e%2f.env.png", "/contact/..png"]) {
    const r = await app.inject({ method: "GET", url, remoteAddress: "198.51.100.120" });
    assert.equal(r.statusCode, 404, url);
  }
});

// js/double-escaping, js/incomplete-multi-character-sanitization ------------------------------------

test("an escaped entity in the source text stays the text the page showed", () => {
  assert.equal(stripTags("<p>write &amp;lt;b&amp;gt; for bold</p>"), "write &lt;b&gt; for bold");
  assert.equal(cleanArticleTextForLLM("<p>write &amp;lt;b&amp;gt; for bold</p>").trim(), "write &lt;b&gt; for bold");
  assert.equal(stripTags("a &lt;tag&gt; &amp; more"), "a <tag> & more");
});

test("outline text never keeps a tag fragment that nested markup left behind", () => {
  const { outline } = withOutline('<h2>Intro <scr<script>ipt>alert(1)</scr</script>ipt></h2><h3>Plain</h3>');
  assert.equal(outline.length, 2);
  for (const o of outline) assert.doesNotMatch(o.text, /[<>]/, o.text);
  assert.equal(outline[1]!.text, "Plain");
});

// js/incomplete-sanitization, js/bad-tag-filter ------------------------------------------------------

const pages: Record<string, string> = {
  // The decoy comes first: a name read as a pattern ("." any character) would stop at it.
  "/window-var": '<script>window.__A$PxdatA = 1; window.__A$P_data = {"items":[{"title":"Decoy","url":"https://example.org/decoy"}]};</script>' +
    '<script>window.__A$P.data = {"items":[{"title":"Dotted","url":"https://example.org/dotted"}]};</script>',
  "/paren": '<script>window.feed = {"items":[{"title":"Plain","url":"https://example.org/plain"}]};</script>',
  "/json-key": '<script id="data" type="application/json">{"posts":[{"title":"Spaced end tag","url":"https://example.org/spaced"}]}</script >',
};
const server = http.createServer((req, res) => {
  const body = pages[req.url ?? ""];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(body ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
const list = (url: string, extra: Record<string, unknown>) =>
  fetchJsonList({ id: `harden-${T}`, config: { url: `${site}${url}`, titlePaths: ["title"], urlTemplate: "{raw:url}", ...extra } } as never);

test("a window variable name is matched literally, metacharacters and all", async () => {
  const got = await list("/window-var", { mode: "html_window_var", windowVar: "__A$P.data", itemsPath: "items" });
  assert.deepEqual(got.map((c) => c.title), ["Dotted"]);
  await assert.rejects(list("/paren", { mode: "html_window_var", windowVar: "feed(", itemsPath: "items" }), /not found/, "a stray parenthesis is a name that is absent, not a regex error");
});

test("a JSON script block whose end tag carries a space is still read", async () => {
  const got = await list("/json-key", { mode: "html_json_key", jsonKey: "posts" });
  assert.deepEqual(got.map((c) => c.title), ["Spaced end tag"]);
});

test("a prefix redirect fills the wildcard of its target with the rest of the path", () => {
  assert.equal(resolveRedirect("/sources/abc", "")?.location, "/admin/sources/abc");
  assert.equal(resolveRedirect("/sources", "")?.location, "/admin/sources");
});
