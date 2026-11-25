// Page watch (web_list parseMode "page_watch"): a page with no feed, watched for links that appear on it.
// The first run records the page; later runs store only links not seen before, at most watchMaxNew,
// and links over that cap wait for the next run instead of being lost.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@topka/backend/config";
import { closeDb, sql } from "@topka/backend/db";
import { stopBoss } from "@topka/backend/jobs/queue";
import { collectSource, pageWatchNew } from "@topka/backend/sources/collect";
import { fromPageWatch } from "@topka/backend/sources/web-list";
import { unsupportedConfig } from "@topka/backend/sources/config-keys";
import type { Candidate, SourceRow } from "@topka/backend/sources/types";

const T = tag();
const post = (slug: string) => `<a href="/blog/${slug}-${T}">A headline long enough for ${slug}</a>`;
let links = ["one", "two"];
let seenHeaders: http.IncomingHttpHeaders = {};
const server = http.createServer((req, res) => {
  seenHeaders = req.headers;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<html><body><nav><a href="/about">About us and our long story</a></nav>${links.map(post).join("")}</body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
const ID = `test-watch-${T}`;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at)
            VALUES (${ID}, ${`watch ${T}`}, 'web_list', ${sql.json({ url: `${base}/blog`, parseMode: "page_watch", watchMaxNew: 2 })}, 'T2', 'editorial', '2100-01-01')`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

const source = (cfg: Record<string, unknown> = {}) => ({ id: "s", kind: "web_list", config: cfg }) as unknown as SourceRow;
const urls = (cs: Candidate[]) => cs.map((c) => c.url);

test("the page's headline links are kept: same host, 12–140 characters, no site chrome, assets or anchors", () => {
  const page = `<a href="/a">Short</a><a href="#top">Back to the top of this page</a><a href="/about">About the company and team</a>
    <a href="https://other.example/x">An offsite headline that is long enough</a><a href="/img/cover.png">A cover image with a long caption</a>
    <a href="/posts/1">  A real   headline   about a release </a><a href="/posts/1">A real headline about a release (dup)</a>
    <a href="mailto:x@y.z">Write to the editors of the site</a><a href="/posts/2"><span>Another</span> <b>headline worth reading</b></a>`;
  const got = fromPageWatch(page, "https://site.example/blog", source());
  assert.deepEqual(got.map((c) => [c.url, c.title]), [
    ["https://site.example/posts/1", "A real headline about a release"],
    ["https://site.example/posts/2", "Another headline worth reading"],
  ]);
  const many = Array.from({ length: 50 }, (_, i) => `<a href="/p/${i}">Headline number ${i} of the page</a>`).join("");
  assert.equal(fromPageWatch(many, "https://site.example/", source()).length, 40, "at most 40 links by default");
  assert.equal(fromPageWatch(many, "https://site.example/", source({ watchMaxLinks: 10 })).length, 10);
  assert.deepEqual(urls(fromPageWatch(many, "https://site.example/", source({ denyUrlPrefixes: ["https://site.example/p/1"] }))).filter((u) => u.includes("/p/1")), [],
    "the source's URL rules still apply");
});

test("new links are those not seen before; over the cap they wait for the next run", () => {
  const c = (n: number) => ({ url: `u${n}`, title: `t${n}` }) as Candidate;
  const first = pageWatchNew([c(1), c(2)], undefined, 5);
  assert.deepEqual([first.baseline, first.fresh, first.seen], [true, [], ["u1", "u2"]], "no seen list: baseline only");
  const second = pageWatchNew([c(5), c(4), c(3), c(1)], first.seen, 2);
  assert.deepEqual(urls(second.fresh), ["u5", "u4"]);
  assert.deepEqual(second.seen, ["u5", "u4", "u1", "u2"], "u3 is left unseen; u2 dropped off the page but is remembered");
  const third = pageWatchNew([c(5), c(4), c(3), c(1)], second.seen, 2);
  assert.deepEqual(urls(third.fresh), ["u3"]);
  assert.equal(pageWatchNew(Array.from({ length: 600 }, (_, i) => c(i)), [], 600).seen.length, 500, "the seen list is bounded");
});

test("watch settings are validated", () => {
  assert.deepEqual(unsupportedConfig("web_list", { parseMode: "page_watch", watchMaxNew: 3, watchMaxLinks: 40 }), []);
  assert.deepEqual(unsupportedConfig("web_list", { watchMaxNew: 0 }), ["watchMaxNew=0"]);
  assert.deepEqual(unsupportedConfig("rss", { watchMaxNew: 2 }), ["watchMaxNew"]);
});

test("a watched page stores nothing on its first run, then only links that appeared, capped per run", async () => {
  const stored = async () => (await sql<{ url: string }[]>`SELECT url FROM articles WHERE source_id = ${ID} ORDER BY url`).map((r) => r.url.replace(`${base}/blog/`, "").replace(`-${T}`, ""));
  assert.equal((await collectSource(ID, { force: true })).status, "ok");
  assert.deepEqual(await stored(), [], "baseline");
  links = ["five", "four", "three", "one", "two"];
  assert.equal((await collectSource(ID, { force: true })).status, "ok");
  assert.deepEqual(await stored(), ["five", "four"]);
  assert.equal((await collectSource(ID, { force: true })).status, "ok");
  assert.deepEqual(await stored(), ["five", "four", "three"], "the link over the cap is taken on the next run");
  assert.match(seenHeaders["user-agent"] ?? "", /^\S+ page watch\/1\.0 \(\+[^ )]+\/about\)$/, "named, no browser disguise, no \"bot\" or URL scheme");
  assert.doesNotMatch(seenHeaders["user-agent"] ?? "", /bot|https?:/i);
  assert.equal(seenHeaders["accept-language"], "*", "no language preference (fetch's own \"*\"): the site's default rendering");
  const [row] = await sql<{ cursor: { watchSeen: string[] } }[]>`SELECT cursor FROM sources WHERE id = ${ID}`;
  assert.equal(row!.cursor.watchSeen.length, 5);
});
