// Free-only embeddings: only a SiliconFlow model whose pricing page lists it at 0 (and that the key is
// offered) embeds; otherwise grouping waits. Vectors stay per model, of the one configured dimension.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

const T = tag();
let price = "0";
let dims = 4;
let embedCalls = 0;
const flight = () => [`1:{"modelName":"BAAI/bge-m3","price":"${price}","status":"normal","pricing":"$2"}`, `3:{"price":"${price}","specification":"prompt"}`, `2:["$3"]`].join("\n");
const provider = await stub((_hit, req) => {
  if (req.url.startsWith("/v1/models")) return { data: [{ id: "BAAI/bge-m3" }] };
  embedCalls += 1;
  const body = JSON.parse(req.body) as { model: string; input: string[] };
  return { model: body.model, data: body.input.map((_t, index) => ({ index, embedding: Array.from({ length: dims }, (_v, i) => (i === index % dims ? 1 : 0)) })) };
});
// The stub answers JSON; the pricing page is HTML, so it is served from a second tiny server.
const http = await import("node:http");
const page = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<script>self.__next_f.push([1,${JSON.stringify(flight())}])</script>`);
});
await new Promise<void>((r) => page.listen(0, "127.0.0.1", () => r()));
const pagePort = (page.address() as { port: number }).port;

Object.assign(process.env, {
  MODEL_CALLS_ENABLED: "true", EMBEDDING_BASE_URL: `${provider.url}/v1`, EMBEDDING_API_KEY: "test-key", EMBEDDING_MODEL: "BAAI/bge-m3",
  EMBEDDING_FREE_MODELS: "BAAI/bge-m3, Pro/BAAI/bge-m3", EMBEDDING_FREE_DIMS: "4", EMBEDDING_FREE_PRICING_URL: `http://127.0.0.1:${pagePort}/pricing`,
});
const { ensureEmbeddings } = await import("@topka/backend/providers/embeddings");
const guard = await import("@topka/backend/providers/free-models");
const { closeDb, sql } = await import("@topka/backend/db");

beforeEach(() => guard.resetFreeGuard());
after(async () => {
  await provider.close();
  await new Promise<void>((r) => page.close(() => r()));
  await closeDb();
});

test("a verified-free model embeds and stores under its own name", async () => {
  price = "0";
  dims = 4;
  const id = `free-emb-${T}`;
  const got = await ensureEmbeddings("article", [{ id, text: `text ${T}` }]);
  assert.equal(got.get(id)!.length, 4);
  const [row] = await sql<{ model: string }[]>`SELECT model FROM embeddings WHERE kind = 'article' AND ref_id = ${id}`;
  assert.equal(row!.model, "BAAI/bge-m3");
});

test("a priced model (and the Pro/ variant) never embeds: the work waits", async () => {
  price = "0.07";
  const before = embedCalls;
  await assert.rejects(ensureEmbeddings("article", [{ id: `paid-emb-${T}`, text: `other ${T}` }]), (e: unknown) => e instanceof guard.NoFreeModelError && /NO_FREE_EMBEDDING/.test((e as Error).message));
  assert.equal(embedCalls, before);
});

test("a vector of another dimension is refused, never stored", async () => {
  price = "0";
  dims = 8;
  const id = `dims-emb-${T}`;
  await assert.rejects(ensureEmbeddings("article", [{ id, text: `dims ${T}` }]), (e: unknown) => e instanceof guard.NoFreeModelError);
  const rows = await sql`SELECT 1 FROM embeddings WHERE kind = 'article' AND ref_id = ${id}`;
  assert.equal(rows.length, 0);
});
