import { SITE } from "@topka/industry/site";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/sources";
import { adminGet } from "../../lib/admin.server";
import { messages, localeOf, useLocale, useT } from "../../lib/i18n";
import { labels } from "../../features/admin/labels";
import { num } from "../../features/admin/format";
import { AdminPage, Badge, ButtonLink, Card, DataTable, Dot, FilterChips, healthTone, Input, Pager, Select, Stat, Time } from "../../features/admin/ui";

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  tier: string;
  participation_mode: string;
  enabled: boolean;
  health: string;
  fail_count: number;
  interval_minutes: number;
  last_ok_at: string | null;
  last_fetch_at: string | null;
  last_error: string | null;
  first_party: boolean;
  next_fetch_at: string | null;
  items_7d: number;
  selected_30d: number;
}

interface SourcesData {
  page: number;
  rows: SourceRow[];
  totals: { total: number; enabled: number; failing: number; degraded: number };
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return adminGet<SourcesData>(request, `/api/admin/sources${url.search}`);
}

export const meta: Route.MetaFunction = ({ matches }) => {
  const t = messages(localeOf(matches));
  return [{ title: t.adminSources.sources.metaTitle(SITE.name) }];
};

export default function Sources({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const lab = labels(useLocale());
  const { rows, totals, page } = loaderData;
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  return (
    <AdminPage
      title={t.adminSources.sources.title}
      subtitle={t.adminSources.sources.subtitle}
      actions={<ButtonLink to="/admin/sources/new" tone="primary">{t.adminSources.sources.newSource}</ButtonLink>}
    >
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t.adminSources.sources.statAll} value={num(totals.total)} />
        <Stat label={t.adminSources.sources.statEnabled} value={num(totals.enabled)} />
        <Stat label={t.adminSources.sources.statFailing} value={num(totals.failing)} tone={totals.failing ? "bad" : "ok"} />
        <Stat label={t.adminSources.sources.statDegraded} value={num(totals.degraded)} tone={totals.degraded ? "warn" : undefined} />
      </div>
      <Card pad={false}>
        <div className="flex flex-col gap-3 border-b border-line p-3 lg:flex-row lg:items-center lg:justify-between">
          <Form method="get" className="flex w-full max-w-md gap-2" preventScrollReset>
            {["kind", "health", "mode"].map((k) => sp.get(k) && <input key={k} type="hidden" name={k} value={sp.get(k)!} />)}
            <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder={t.adminSources.sources.searchPlaceholder} aria-label={t.adminSources.sources.searchLabel} />
          </Form>
          <div className="flex flex-wrap items-center gap-3">
            <FilterChips param="health" options={[{ value: "", label: t.adminSources.sources.chipAll }, { value: "failing", label: t.adminSources.sources.chipFailing }, { value: "degraded", label: t.adminSources.sources.chipDegraded }, { value: "paused", label: t.adminSources.sources.chipPaused }]} />
            <Select
              aria-label={t.adminSources.sources.kindLabel}
              className="!w-auto"
              value={sp.get("kind") ?? ""}
              onChange={(e) => {
                const next = new URLSearchParams(sp);
                if (e.target.value) next.set("kind", e.target.value);
                else next.delete("kind");
                next.delete("page");
                navigate(`?${next}`, { preventScrollReset: true });
              }}
            >
              <option value="">{t.adminSources.sources.kindAll}</option>
              {Object.entries(lab.kind).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </div>
        </div>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/admin/sources/${encodeURIComponent(r.id)}`)}
          columns={[
            {
              key: "name",
              label: t.adminSources.sources.colSource,
              render: (r) => (
                <div className="min-w-[220px]">
                  <Link to={`/admin/sources/${encodeURIComponent(r.id)}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>
                    {r.name}
                  </Link>
                  <div className="font-mono text-[11.5px] text-ink-4">{r.id}</div>
                  {r.health === "failing" && r.last_error && <div className="mt-1 line-clamp-1 text-[12px] text-hot">{r.last_error}</div>}
                </div>
              ),
            },
            { key: "kind", label: t.adminSources.sources.colKind, render: (r) => <Badge>{lab.kind[r.kind] ?? r.kind}</Badge> },
            {
              key: "mode",
              label: t.adminSources.sources.colMode,
              render: (r) => (
                <div className="flex gap-1">
                  <Badge tone={r.participation_mode === "editorial" ? "accent" : "muted"}>{lab.mode[r.participation_mode] ?? r.participation_mode}</Badge>
                  <Badge tone="info">{r.tier.replace("_", ".")}</Badge>
                  {r.first_party && <Badge tone="ok">{t.adminSources.sources.firstParty}</Badge>}
                </div>
              ),
            },
            {
              key: "health",
              label: t.adminSources.sources.colHealth,
              render: (r) => (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <Dot tone={r.enabled ? healthTone(r.health) : "muted"} />
                  {r.enabled ? lab.health[r.health] ?? r.health : t.adminSources.shared.pausedBadge}
                  {r.fail_count > 0 && <span className="num text-[11.5px] text-ink-4">×{r.fail_count}</span>}
                </span>
              ),
            },
            { key: "ok", label: t.adminSources.sources.colLastOk, render: (r) => <Time at={r.last_ok_at} /> },
            { key: "interval", label: t.adminSources.sources.colInterval, align: "right", render: (r) => t.adminSources.sources.minutes(r.interval_minutes) },
            { key: "items", label: t.adminSources.sources.colItems7d, align: "right", render: (r) => num(r.items_7d) },
            { key: "sel", label: t.adminSources.sources.colSelected30d, align: "right", render: (r) => num(r.selected_30d) },
          ]}
        />
      </Card>
      <Pager page={page} hasMore={rows.length === 100} />
    </AdminPage>
  );
}
