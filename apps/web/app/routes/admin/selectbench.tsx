import { SITE } from "@topka/industry/site";
import { useRef } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/selectbench";
import { adminGet } from "../../lib/admin.server";
import { messages, localeOf, useT } from "../../lib/i18n";
import { useAdminAction } from "../../features/admin/action";
import { bj, num, pct } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, Empty } from "../../features/admin/ui";
import { toast } from "../../features/admin/toast";

interface RunRow {
  id: string;
  label: string;
  split: string | null;
  sample_size: number;
  prompt_version: string | null;
  models: string[];
  summary: Record<string, Record<string, number>>;
  created_at: string;
  imported_by: string | null;
  cases: number;
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<{ runs: RunRow[] }>(request, "/api/admin/selectbench");
}

export const meta: Route.MetaFunction = ({ matches }) => {
  const t = messages(localeOf(matches));
  return [{ title: t.adminRuns.selectbench.metaTitle(SITE.name) }];
};

export default function SelectBench({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const { run, pending } = useAdminAction();
  const file = useRef<HTMLInputElement>(null);
  return (
    <AdminPage
      title="SelectBench"
      subtitle={t.adminRuns.selectbench.subtitle}
      actions={
        <>
          <input
            ref={file}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              try {
                const report = JSON.parse(await f.text());
                await run("POST", "/api/admin/selectbench/import", { label: f.name.replace(/\.json$/, ""), report }, { label: "import", success: t.adminRuns.selectbench.importedToast });
              } catch {
                toast(t.adminRuns.selectbench.invalidReport, "error");
              }
            }}
          />
          <Button busy={pending === "import"} onClick={() => file.current?.click()}>{t.adminRuns.selectbench.importReport}</Button>
        </>
      }
    >
      {loaderData.runs.length ? (
        <div className="space-y-4">
          {loaderData.runs.map((r) => {
            const best = [...r.models].sort((a, b) => (r.summary[b]?.f1 ?? 0) - (r.summary[a]?.f1 ?? 0))[0];
            return (
              <Card
                key={r.id}
                title={<Link to={`/admin/selectbench/${r.id}`} className="hover:text-accent">{r.label}</Link>}
                right={<span>{bj(r.created_at, true)} · {r.split ?? "—"} · {t.adminRuns.selectbench.runSample(num(r.sample_size), r.prompt_version ?? t.adminRuns.selectbench.promptUnrecorded)}</span>}
                pad={false}
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-left text-[12px] text-ink-3">
                        {t.adminRuns.selectbench.columns.map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {r.models.map((m) => {
                        const s = r.summary[m] ?? {};
                        return (
                          <tr key={m} className="border-b border-line/70 last:border-0">
                            <td className="px-3 py-2 font-medium text-ink">{m} {m === best && r.models.length > 1 && <Badge tone="accent">{t.adminRuns.selectbench.bestF1}</Badge>}</td>
                            <td className="num px-3 py-2">{pct(s.accuracy)}</td>
                            <td className="num px-3 py-2">{pct(s.precision)}</td>
                            <td className="num px-3 py-2">{pct(s.recall)}</td>
                            <td className="num px-3 py-2 font-semibold text-ink">{pct(s.f1)}</td>
                            <td className="num px-3 py-2">{pct(s.selectedRate)}</td>
                            <td className="num px-3 py-2">{pct(s.goldSelectRate)}</td>
                            <td className="num px-3 py-2">{s.errors ? <span className="text-hot">{s.errors}</span> : 0}</td>
                            <td className="num px-3 py-2">{s.avgLatencyMs ? `${(s.avgLatencyMs / 1000).toFixed(1)}s` : "—"}</td>
                            <td className="num px-3 py-2 text-ink-3">{num(s.tokensIn)} / {num(s.tokensOut)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12.5px] text-ink-3">
                  <span>{r.cases ? t.adminRuns.selectbench.caseResults(num(r.cases)) : t.adminRuns.selectbench.summaryOnly}</span>
                  {r.cases > 0 && <Link className="text-accent" to={`/admin/selectbench/${r.id}`}>{t.adminRuns.selectbench.browseCases}</Link>}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card><Empty>{t.adminRuns.selectbench.emptyRuns}</Empty></Card>
      )}
    </AdminPage>
  );
}
