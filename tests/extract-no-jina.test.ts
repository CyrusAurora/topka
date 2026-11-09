// Body extraction on a free-only deployment: with no Jina key there is no paid fallback to try, so a
// page the direct fetch cannot read ends extraction at once (the article goes on with its excerpt)
// instead of failing three times on the missing key.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";

const saved = process.env.JINA_API_KEY;
delete process.env.JINA_API_KEY;
const { extractFromUrl } = await import("@topka/backend/content/extract");
const { closeDb } = await import("@topka/backend/db");

after(async () => {
  if (saved !== undefined) process.env.JINA_API_KEY = saved;
  await closeDb();
});

test("no Jina key: an unreadable page gives no body instead of a missing-key failure", async () => {
  assert.equal(await extractFromUrl("http://127.0.0.1:9/unreachable", { allowJina: true, subject: "no-jina" }), null);
});
