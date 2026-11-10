import { SITE } from "@topka/industry/site";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/content";
import { adminGet } from "../../lib/admin.server";
import { labels } from "../../features/admin/labels";
import { localeOf, messages, useLocale, useT } from "../../lib/i18n";
import { AdminPage, Badge, Button, Card, DataTable, Input, Time } from "../../features/admin/ui";

interface Row {
  id: string;
  title: string;
  url: string;
  source: string;
  discovered_at: string;
  processing_state: string;
  visibility: string | null;
  selected: boolean | null;
  score: number | null;
}

export async function loader({ request }: Route.LoaderArgs) {
  // No term: the newest items, so a fresh install can see what arrived without knowing a title.
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const { rows } = await adminGet<{ rows: Row[] }>(request, `/api/admin/content?q=${encodeURIComponent(q)}`);
  return { q, rows };
}

export const meta: Route.MetaFunction = ({ matches }) => {
  const t = messages(localeOf(matches));
  return [{ title: t.adminContent.content.metaTitle(SITE.name) }];
};

export default function Content({ loaderData }: Route.ComponentProps) {
  const { q, rows } = loaderData;
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const t = useT();
  const locale = useLocale();
  const lab = labels(locale);
  const c = t.adminContent.content;
  return (
    <AdminPage title={c.pageTitle} subtitle={c.subtitle}>
      <Form method="get" className="mb-5 flex max-w-2xl gap-2">
        <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder={c.searchPlaceholder} aria-label={c.searchAriaLabel} autoFocus />
        <Button type="submit" tone="primary">{c.find}</Button>
      </Form>
      <Card pad={false} title={q ? c.resultsTitle(q) : c.latestTitle} right={<span>{rows.length === 50 ? c.showingRecent : t.adminContent.common.items(rows.length)}</span>}>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/admin/content/${r.id}`)}
          empty={q ? c.emptySearch : c.emptyInitial}
          columns={[
            {
              key: "t",
              label: c.colTitle,
              render: (r) => (
                <div className="min-w-[320px]">
                  <Link to={`/admin/content/${r.id}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>{r.title}</Link>
                  <div className="font-mono text-[11.5px] text-ink-4">{r.id}</div>
                </div>
              ),
            },
            { key: "src", label: c.colSource, render: (r) => <span className="whitespace-nowrap">{r.source}</span> },
            {
              key: "st",
              label: c.colStatus,
              render: (r) => (
                <span className="flex flex-wrap gap-1">
                  {r.selected && <Badge tone="accent">{t.adminContent.common.selected}</Badge>}
                  {r.visibility && <Badge tone={r.visibility === "public" ? "muted" : "warn"}>{lab.visibility[r.visibility] ?? r.visibility}</Badge>}
                  {!r.visibility && <Badge>{r.processing_state}</Badge>}
                </span>
              ),
            },
            { key: "sc", label: c.colScore, align: "right", render: (r) => r.score ?? "—" },
            { key: "d", label: c.colDiscovered, render: (r) => <Time at={r.discovered_at} /> },
          ]}
        />
      </Card>
    </AdminPage>
  );
}
