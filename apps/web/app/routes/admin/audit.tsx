import { SITE } from "@topka/industry/site";
import { Form, Link, useSearchParams } from "react-router";
import type { Route } from "./+types/audit";
import { adminGet } from "../../lib/admin.server";
import { localeOf, messages, useLocale, useT, useUiPrefs } from "../../lib/i18n";
import { bj } from "../../features/admin/format";
import { AdminPage, Card, DataTable, Input, Json, Pager } from "../../features/admin/ui";

interface Row {
  id: number;
  created_at: string;
  actor: string;
  action: string;
  subject: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<{ page: number; rows: Row[] }>(request, `/api/admin/audit${new URL(request.url).search}`);
}

export const meta: Route.MetaFunction = ({ matches }) => {
  const t = messages(localeOf(matches));
  return [{ title: t.adminContent.audit.metaTitle(SITE.name) }];
};

function subjectLink(subject: string | null) {
  if (!subject) return null;
  const [kind, id] = [subject.slice(0, subject.indexOf(":")), subject.slice(subject.indexOf(":") + 1)];
  if (kind === "content") return <Link className="text-accent" to={`/admin/content/${id}`}>{subject}</Link>;
  if (kind === "source") return <Link className="text-accent" to={`/admin/sources/${encodeURIComponent(id)}`}>{subject}</Link>;
  return <span className="font-mono text-[12px]">{subject}</span>;
}

export default function Audit({ loaderData }: Route.ComponentProps) {
  const [sp] = useSearchParams();
  const t = useT();
  const locale = useLocale();
  const { timeZone } = useUiPrefs();
  const a = t.adminContent.audit;
  return (
    <AdminPage title={a.pageTitle} subtitle={a.subtitle}>
      <Form method="get" className="mb-4 flex max-w-xl gap-2">
        <Input name="action" defaultValue={sp.get("action") ?? ""} placeholder={a.actionPlaceholder} aria-label={a.actionAriaLabel} />
        <Input name="subject" defaultValue={sp.get("subject") ?? ""} placeholder={a.subjectPlaceholder} aria-label={a.subjectAriaLabel} />
      </Form>
      <Card pad={false}>
        <DataTable
          rows={loaderData.rows}
          rowKey={(r) => r.id}
          empty={a.empty}
          columns={[
            { key: "t", label: a.colTime, render: (r) => <span className="num whitespace-nowrap">{bj(r.created_at, true, locale, timeZone)}</span> },
            { key: "a", label: a.colAction, render: (r) => <span className="font-mono text-[12.5px] text-ink">{r.action}</span> },
            { key: "s", label: a.colSubject, render: (r) => subjectLink(r.subject) },
            { key: "who", label: a.colActor, render: (r) => r.actor },
            { key: "r", label: a.colReason, render: (r) => <span className="text-ink-2">{r.reason}</span> },
            { key: "d", label: a.colChange, render: (r) => (r.before || r.after ? <Json value={{ before: r.before, after: r.after }} label={a.jsonLabel} /> : null) },
          ]}
        />
      </Card>
      <Pager page={loaderData.page} hasMore={loaderData.rows.length === 100} />
    </AdminPage>
  );
}
