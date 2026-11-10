import { SITE } from "@topka/industry/site";
import { Fragment, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CATEGORY_LABELS } from "@topka/contracts/taxonomy";
import type { Route } from "./+types/selectbench-run";
import { adminGet } from "../../lib/admin.server";
import { messages, localeOf, useLocale, useT, type UiLocale } from "../../lib/i18n";
import { bj, num, pct } from "../../features/admin/format";
import { AdminPage, Badge, Card, Empty, FilterChips, Select } from "../../features/admin/ui";

interface Decision {
  decision: "select" | "reject" | null;
  score: number | null;
  relevance: string | null;
  category: string | null;
  reason: string | null;
  error: string | null;
  receiptId: number | null;
}
interface Data {
  run: { id: string; label: string; split: string | null; sample_size: number; prompt_version: string | null; models: string[]; summary: Record<string, Record<string, number>>; created_at: string };
  rows: Array<{ case_id: string; title: string; stratum: string | null; gold: "select" | "reject" | "either"; by_model: Record<string, Decision> }>;
  strata: Array<{ stratum: string | null; n: number }>;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  return adminGet<Data>(request, `/api/admin/selectbench/${encodeURIComponent(params.runId)}${new URL(request.url).search}`);
}

export const meta: Route.MetaFunction = ({ loaderData, matches }) => {
  const t = messages(localeOf(matches));
  return [{ title: t.adminRuns.selectbenchRun.metaTitle(loaderData?.run.label ?? "SelectBench", SITE.name) }];
};

function verdict(d: Decision | undefined, gold: string, locale: UiLocale = "zh-CN") {
  const t = messages(locale).adminRuns.selectbenchRun;
  if (!d) return <span className="text-ink-4">—</span>;
  if (d.decision === null) return <Badge tone="bad" title={d.error ?? undefined}>{t.failed}</Badge>;
  const right = gold === "either" || d.decision === gold;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={right ? (d.decision === "select" ? "ok" : "muted") : "bad"}>{d.decision === "select" ? t.select : t.reject}</Badge>
      <span className="num text-[12px] text-ink-3">{d.score ?? "—"}</span>
    </span>
  );
}

export default function SelectBenchRun({ loaderData: d }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const model = sp.get("model") ?? d.run.models[0]!;
  const gold: Record<string, [string, "accent" | "muted" | "info"]> = {
    select: [t.adminRuns.selectbenchRun.goldSelect, "accent"],
    reject: [t.adminRuns.selectbenchRun.goldReject, "muted"],
    either: [t.adminRuns.selectbenchRun.goldEither, "info"],
  };
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v);
    else next.delete(k);
    navigate(`?${next}`, { preventScrollReset: true });
  };
  return (
    <AdminPage
      title={d.run.label}
      subtitle={<>{bj(d.run.created_at, true)} · {d.run.split ?? "—"} · {num(d.run.sample_size)}{t.adminRuns.selectbenchRun.casesPrompt(d.run.prompt_version ?? t.adminRuns.selectbenchRun.unrecorded)} · <Link className="text-accent" to="/admin/selectbench">{t.adminRuns.selectbenchRun.allRuns}</Link></>}
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {d.run.models.map((m) => {
          const s = d.run.summary[m] ?? {};
          return (
            <button key={m} onClick={() => set("model", m)} className={`rounded-panel p-4 text-left ring-1 transition-colors ${m === model ? "bg-accent-softer ring-accent/40" : "bg-surface ring-line hover:bg-bg-sunk/60"}`}>
              <div className="text-[13.5px] font-semibold text-ink">{m}</div>
              <div className="num mt-1.5 text-[22px] font-semibold tracking-tight text-ink">F1 {pct(s.f1)}</div>
              <div className="num mt-0.5 text-[12px] text-ink-3">{t.adminRuns.selectbenchRun.acc} {pct(s.accuracy)} {t.adminRuns.selectbenchRun.prec} {pct(s.precision)} {t.adminRuns.selectbenchRun.rec} {pct(s.recall)}</div>
              <div className="num mt-0.5 text-[12px] text-ink-4">{t.adminRuns.selectbenchRun.fp} {s.fp ?? "—"} {t.adminRuns.selectbenchRun.fn} {s.fn ?? "—"} {t.adminRuns.selectbenchRun.errFrac} {s.errors ?? 0}</div>
            </button>
          );
        })}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterChips
          param="outcome"
          options={[
            { value: "", label: t.adminRuns.selectbenchRun.filterAll },
            { value: "fp", label: t.adminRuns.selectbenchRun.fpLabel },
            { value: "fn", label: t.adminRuns.selectbenchRun.fnLabel },
            { value: "tp", label: t.adminRuns.selectbenchRun.tpLabel },
            { value: "tn", label: t.adminRuns.selectbenchRun.tnLabel },
            { value: "either", label: t.adminRuns.selectbenchRun.goldEither },
            { value: "error", label: t.adminRuns.selectbenchRun.errorLabel },
          ]}
        />
        <Select className="!w-auto" aria-label={t.adminRuns.selectbenchRun.sampleStratumAria} value={sp.get("stratum") ?? ""} onChange={(e) => set("stratum", e.target.value || null)}>
          <option value="">{t.adminRuns.selectbenchRun.allStrata}</option>
          {d.strata.map((s) => <option key={s.stratum ?? "none"} value={s.stratum ?? ""}>{t.adminRuns.selectbenchRun.stratumOption(s.stratum ?? t.adminRuns.selectbenchRun.unstratified, s.n)}</option>)}
        </Select>
        <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={sp.get("disagree") === "1"} onChange={(e) => set("disagree", e.target.checked ? "1" : null)} />
          {t.adminRuns.selectbenchRun.disagreeOnly}
        </label>
        <span className="text-[12.5px] text-ink-4">{t.adminRuns.selectbenchRun.rowsNote(d.rows.length)} {t.adminRuns.selectbenchRun.filterBy} {model}</span>
      </div>
      <Card pad={false}>
        {d.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  <th className="px-3 py-2 font-medium">{t.adminRuns.selectbenchRun.colSample}</th>
                  <th className="px-3 py-2 font-medium">{t.adminRuns.selectbenchRun.colGold}</th>
                  {d.run.models.map((m) => <th key={m} className="px-3 py-2 font-medium">{m}</th>)}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <Fragment key={r.case_id}>
                    <tr className="cursor-pointer border-b border-line/70 hover:bg-bg-sunk/50" onClick={() => setOpen(open === r.case_id ? null : r.case_id)}>
                      <td className="max-w-[420px] px-3 py-2.5">
                        <div className="line-clamp-2 text-ink">{r.title}</div>
                        <div className="mt-0.5 text-[11.5px] text-ink-4">{r.stratum ?? "—"} · {r.case_id}</div>
                      </td>
                      <td className="px-3 py-2.5"><Badge tone={gold[r.gold]?.[1] ?? "muted"}>{gold[r.gold]?.[0] ?? r.gold}</Badge></td>
                      {d.run.models.map((m) => <td key={m} className="px-3 py-2.5">{verdict(r.by_model[m], r.gold, locale)}</td>)}
                    </tr>
                    {open === r.case_id && (
                      <tr className="border-b border-line/70 bg-bg-sunk/40">
                        <td colSpan={2 + d.run.models.length} className="px-3 py-3">
                          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                            {d.run.models.map((m) => {
                              const x = r.by_model[m];
                              return (
                                <div key={m} className="rounded-control bg-surface p-3 ring-1 ring-line">
                                  <div className="mb-1 flex items-center justify-between text-[12px] text-ink-3"><span className="font-medium text-ink-2">{m}</span>{x?.category && <span>{CATEGORY_LABELS[x.category as keyof typeof CATEGORY_LABELS] ?? x.category}</span>}</div>
                                  <div className="text-[12.5px] leading-relaxed text-ink-2">{x?.error ?? x?.reason ?? t.adminRuns.selectbenchRun.noReason}</div>
                                  <div className="mt-1 text-[11.5px] text-ink-4">{t.adminRuns.selectbenchRun.relevance} {x?.relevance ?? "—"}{x?.receiptId ? t.adminRuns.selectbenchRun.receiptRef(x.receiptId) : ""}</div>
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{t.adminRuns.selectbenchRun.noMatching}</Empty>
        )}
      </Card>
    </AdminPage>
  );
}
