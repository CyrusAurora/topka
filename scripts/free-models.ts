// Free-only guard status: which candidates (LLM_FREE_MODELS, EMBEDDING_FREE_MODELS) are verifiably free
// right now, and whether any call in the last 24 hours was billed or answered by another model.
//   npm run models:free            human-readable, exit 1 when a configured guard has no free model
//   npm run models:free -- --json
import { sql, closeDb } from "@topka/backend/db";
import { freeGuardOn, freeStatus, type FreeKind } from "@topka/backend/providers/free-models";

const json = process.argv.includes("--json");
const out: Record<string, unknown> = {};
let bad = false;
for (const kind of ["llm", "embedding"] as FreeKind[]) {
  if (!freeGuardOn(kind)) {
    out[kind] = { guard: "off" };
    continue;
  }
  const s = await freeStatus(kind, { refresh: true });
  const active = s.candidates.find((c) => c.free)?.id ?? null;
  out[kind] = { guard: "on", ok: s.ok, active, candidates: s.candidates, error: s.error };
  if (!s.ok) bad = true;
}
// Billed or substituted answers: usage.cost above zero, or a response naming another model.
const [audit] = await sql<{ calls: number; billed: number; substituted: number }[]>`
  SELECT count(*)::int AS calls,
         count(*) FILTER (WHERE coalesce((response->'usage'->>'cost')::numeric, 0) > 0 OR coalesce(cost, 0) > 0)::int AS billed,
         count(*) FILTER (WHERE response ? 'model' AND response->>'model' <> model)::int AS substituted
  FROM receipts WHERE service IN ('llm', 'embedding') AND origin = 'live' AND created_at > now() - interval '1 day' AND response IS NOT NULL`;
out.last24h = audit;
if (audit!.billed > 0 || audit!.substituted > 0) bad = true;
await closeDb();
if (json) console.log(JSON.stringify(out));
else {
  for (const kind of ["llm", "embedding"] as const) {
    const k = out[kind] as { guard: string; ok?: boolean; active?: string | null; candidates?: Array<{ id: string; free: boolean; reason: string }>; error?: string };
    if (k.guard === "off") { console.log(`${kind}: guard off`); continue; }
    console.log(`${kind}: ${k.ok ? `using ${k.active}` : kind === "llm" ? "NO_FREE_MODEL" : "NO_FREE_EMBEDDING"}${k.error ? ` (${k.error})` : ""}`);
    for (const c of k.candidates ?? []) console.log(`  ${c.free ? "free" : "skip"}  ${c.id}  ${c.reason}`);
  }
  console.log(`last 24h: ${audit!.calls} calls, ${audit!.billed} billed, ${audit!.substituted} answered by another model`);
}
process.exit(bad ? 1 : 0);
