// Feeds and the API link only to pages that answer 200: the retired Topka pages (/daily/…, /all, /story/…)
// answer 301, so no link may point at them.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@topka/backend/config";
import { closeDb, sql } from "@topka/backend/db";
import { stopBoss } from "@topka/backend/jobs/queue";
import { dailyUrl, storyUrl } from "@topka/backend/publication/links";
import { buildApp } from "../apps/api/src/app.ts";

const KEY = `2099-11-${String(10 + Math.floor(Math.random() * 19))}`;
const RETIRED = /\/(daily|weekly|monthly|all|hot|story|topics)(\/|<|"|$)/;
const app = await buildApp();
after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${KEY}`;
  await app.close();
  await stopBoss();
  await closeDb();
});

test("report and story links land where the old pages redirect", () => {
  assert.match(dailyUrl("2026-10-30"), /\/archive$/);
  assert.doesNotMatch(storyUrl("abc"), /\/story\//);
});

test("/feed/daily.xml and the selected feed point at live pages only", async () => {
  const content = { sections: [{ label: "模型", items: [] }], flashes: [], lead: { leadParagraph: "LEAD" } };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('daily', ${KEY}, now() - interval '1 day', now(), ${sql.json(content as never)}, now(), 'manual')
            ON CONFLICT (kind, key) DO NOTHING`;
  for (const path of ["/feed/daily.xml", "/feed/all.xml"]) {
    const res = await app.inject({ method: "GET", url: path });
    assert.equal(res.statusCode, 200, path);
    const links = [...res.body.matchAll(/<link>([^<]*)<\/link>|href="([^"]*)"/g)].map((m) => m[1] ?? m[2]!);
    assert.ok(links.length > 0, path);
    const site = links.filter((l) => l.startsWith(config.siteUrl));
    assert.ok(site.length > 0, `${path} links the site`);
    assert.deepEqual(site.filter((l) => RETIRED.test(new URL(l).pathname + "<")), [], `${path} links a retired page`);
  }
  const daily = (await app.inject({ method: "GET", url: "/feed/daily.xml" })).body;
  assert.ok(daily.includes(`daily-${KEY}`), "the report is in the feed");
});
