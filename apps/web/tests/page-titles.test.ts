// Every page title carries the brand exactly once: pageMeta adds it, so routes pass the bare page name.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { pageMeta } from "../app/lib/seo.ts";
import { SITE } from "@topka/industry/site";

test("pageMeta appends the brand once", () => {
  const title = pageMeta({ title: "今日", path: "/" }).find((t) => "title" in t) as { title: string };
  assert.equal(title.title, `今日 · ${SITE.name}`);
});

test("no route passes a title that already ends with the brand", () => {
  const dir = new URL("../app/routes/", import.meta.url);
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .filter((f) => /pageMeta\(\{\s*title:\s*`[^`]*· \$\{SITE\.name\}`/.test(readFileSync(new URL(f, dir), "utf8")));
  assert.deepEqual(offenders, []);
});
