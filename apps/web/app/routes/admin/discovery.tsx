// Operator view of the discovery channels (master design 3.2, 8.2 step 10; docs/discovery.md): every
// signal with its channel and status, the promotion lineage, dismiss (with a reason) and restore,
// the directory feed count, and "read now" / "gate only". A signal never becomes a source: adding a
// source stays the operator's own decision on the sources page.
import { SITE } from "@topka/industry/site";
import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/discovery";
import { adminGet } from "../../lib/admin.server";
import { localeOf, messages, useLocale, useT, useUiPrefs } from "../../lib/i18n";
import { useAdminAction } from "../../features/admin/action";
import { bj } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, FilterChips, Input, Pager, ReasonDialog } from "../../features/admin/ui";

interface Row {
  id: string;
  kind: "directory" | "pack" | "user-lead";
  channelName: string;
  url: string;
  title: string | null;
  note: string | null;
  discoveredAt: string;
  status: "awaiting" | "promoted" | "dismissed";
  projectId: string | null;
  invalidUrl: boolean;
  promotedObservationId: string | null;
  promotedAt: string | null;
  dismissedReason: string | null;
  dismissedBy: string | null;
}

interface Data {
  page: number;
  counts: Record<string, number>;
  rows: Row[];
  catalog: { feedCount: number; enabled: boolean; lastRunAt: string | null; total: number };
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<Data>(request, `/api/admin/discovery${new URL(request.url).search}`);
}

export const meta: Route.MetaFunction = ({ matches }) => [{ title: messages(localeOf(matches)).discover.adminMetaTitle(SITE.name) }];

const TONE = { awaiting: "warn", promoted: "ok", dismissed: "muted" } as const;

export default function AdminDiscovery({ loaderData }: Route.ComponentProps) {
  const t = useT().discover;
  const locale = useLocale();
  const { timeZone } = useUiPrefs();
  const { run, pending } = useAdminAction();
  const [feedCount, setFeedCount] = useState(String(loaderData.catalog.feedCount));
  const [dismissing, setDismissing] = useState<Row | null>(null);
  const status = { awaiting: t.statusAwaiting, promoted: t.statusPromoted, dismissed: t.statusDismissed };
  const channel = { directory: t.channelDirectory, pack: t.channelPack, "user-lead": t.channelLead };
  return (
    <AdminPage
      title={t.adminTitle}
      subtitle={t.adminSubtitle}
      actions={
        <div className="flex gap-2">
          <Button busy={pending === "gate"} onClick={() => run("POST", "/api/admin/discovery/run", { gateOnly: true }, { label: "gate", success: t.adminRan })}>{t.adminGate}</Button>
          <Button tone="primary" busy={pending === "run"} onClick={() => run("POST", "/api/admin/discovery/run", {}, { label: "run", success: t.adminRan })}>{t.adminRun}</Button>
        </div>
      }
    >
      <Card className="mb-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run("PUT", "/api/admin/discovery/settings", { feedCount: Number(feedCount) }, { label: "settings", success: t.adminSaved });
          }}
        >
          <label className="text-[12.5px] text-ink-3">
            {t.adminFeedCount}
            <Input type="number" min={0} max={20} value={feedCount} onChange={(e) => setFeedCount(e.target.value)} className="mt-1 w-28" />
          </label>
          <Button type="submit" busy={pending === "settings"}>{t.adminSave}</Button>
          <span className="text-[12.5px] text-ink-4">
            {loaderData.catalog.enabled ? t.catalogLine(loaderData.catalog.feedCount, loaderData.catalog.total) : t.catalogOff}
            {" · "}
            {loaderData.catalog.lastRunAt ? t.catalogLastRun(bj(loaderData.catalog.lastRunAt, true, locale, timeZone)) : t.catalogNever}
          </span>
        </form>
      </Card>
      <div className="mb-3 flex flex-wrap gap-3">
        <FilterChips
          param="status"
          options={[
            { value: "", label: t.adminStatusAll },
            { value: "awaiting", label: t.statusAwaiting, count: loaderData.counts.awaiting ?? 0 },
            { value: "promoted", label: t.statusPromoted, count: loaderData.counts.promoted ?? 0 },
            { value: "dismissed", label: t.statusDismissed, count: loaderData.counts.dismissed ?? 0 },
          ]}
        />
        <FilterChips
          param="kind"
          options={[
            { value: "", label: t.adminKindAll },
            { value: "directory", label: t.channelDirectory },
            { value: "pack", label: t.channelPack },
            { value: "user-lead", label: t.channelLead },
          ]}
        />
      </div>
      <Card pad={false}>
        <DataTable
          rows={loaderData.rows}
          rowKey={(r) => r.id}
          empty={t.adminEmpty}
          columns={[
            { key: "t", label: t.adminColTime, render: (r) => <span className="num whitespace-nowrap">{bj(r.discoveredAt, true, locale, timeZone)}</span> },
            { key: "c", label: t.adminColChannel, render: (r) => <span>{t.provenance(channel[r.kind], r.channelName)}</span> },
            {
              key: "s",
              label: t.adminColSignal,
              render: (r) => (
                <div className="max-w-[420px]">
                  {r.invalidUrl ? <span className="break-words text-ink-2">{r.title || r.url}</span> : <a className="break-words text-accent" href={r.url} target="_blank" rel="noreferrer nofollow">{r.title || r.url}</a>}
                  {r.invalidUrl && <div className="text-[12px] text-hot">{t.invalidUrl}</div>}
                  {r.note && <div className="text-[12px] text-ink-3">{r.note}</div>}
                </div>
              ),
            },
            { key: "st", label: t.adminColStatus, render: (r) => <Badge tone={TONE[r.status]} title={r.dismissedReason ?? undefined}>{status[r.status]}</Badge> },
            {
              key: "l",
              label: t.adminColLineage,
              render: (r) => (r.promotedObservationId ? <Link className="font-mono text-[12px] text-accent" to={`/admin/content/${encodeURIComponent(r.promotedObservationId)}`}>{r.promotedObservationId}</Link> : r.dismissedReason ? <span className="text-[12px] text-ink-4">{r.dismissedReason}</span> : null),
            },
            {
              key: "a",
              label: "",
              render: (r) => (
                <div className="flex flex-wrap gap-1.5">
                  {r.status === "awaiting" && <Button size="sm" onClick={() => setDismissing(r)}>{t.adminDismiss}</Button>}
                  {r.status === "dismissed" && <Button size="sm" busy={pending === `restore-${r.id}`} onClick={() => run("POST", `/api/admin/discovery/${encodeURIComponent(r.id)}/restore`, {}, { label: `restore-${r.id}`, success: t.adminRan })}>{t.adminRestore}</Button>}
                </div>
              ),
            },
          ]}
        />
      </Card>
      <Pager page={loaderData.page} hasMore={loaderData.rows.length === 100} />
      <ReasonDialog
        open={!!dismissing}
        title={t.adminDismiss}
        description={dismissing ? dismissing.title || dismissing.url : undefined}
        confirmLabel={t.adminDismiss}
        onClose={() => setDismissing(null)}
        busy={!!pending}
        onSubmit={async (reason) => {
          if (!dismissing) return false;
          const ok = await run("POST", `/api/admin/discovery/${encodeURIComponent(dismissing.id)}/dismiss`, { reason }, { label: "dismiss", success: t.adminRan });
          if (ok !== null) setDismissing(null);
          return ok !== null;
        }}
      />
    </AdminPage>
  );
}
