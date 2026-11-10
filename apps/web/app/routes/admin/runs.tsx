import { SITE } from "@topka/industry/site";
import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { useEffect } from "react";
import type { Route } from "./+types/runs";
import { adminGet } from "../../lib/admin.server";
import { messages, localeOf, useLocale, useT } from "../../lib/i18n";
import { useAdminAction } from "../../features/admin/action";
import { ago, bj, duration, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Dot, Empty, Field, Json, ReasonDialog, Select, Stat, Time } from "../../features/admin/ui";

type Row = Record<string, any>;
interface Runs {
  checkedAt: string;
  processes: Array<{ role: string; pid: number; host: string; release: string; startedAt: string; at: string; alive: boolean }>;
  jobs: Row[];
  timeline: Row[];
  queues: Array<{ name: string; state: string; n: number; oldest: string }>;
  failedJobs: Row[];
  lagging: Row[];
  receipts: { counts: Record<string, number>; issues: Row[] };
  deliveries: Row[];
  errors: Row[];
  retrying: { count: number; next: string | null };
  ingest: Row[];
  leaderboard: { at: string; sources: Array<{ key: string; ok: boolean; at: string; lastOkAt: string | null; changed?: boolean; rows?: number; error?: string }> } | null;
}


export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<Runs>(request, "/api/admin/runs");
}

export const meta: Route.MetaFunction = ({ matches }) => {
  const t = messages(localeOf(matches));
  return [{ title: t.adminRuns.runs.metaTitle(SITE.name) }];
};

export default function RunsAdmin({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const refresh = useFetcher<typeof loader>();
  const r = refresh.data ?? loaderData;
  const { run, pending } = useAdminAction();
  const [receipt, setReceipt] = useState<Row | null>(null);
  const [billed, setBilled] = useState("false");
  const [delivery, setDelivery] = useState<Row | null>(null);
  const [outcome, setOutcome] = useState<"sent" | "drop" | "resend">("sent");
  // Failure group to put back into processing ("" = every failure of the last 30 days).
  const [requeue, setRequeue] = useState<string | null>(null);
  const stateLabel: Record<string, string> = { created: t.adminRuns.runs.stateCreated, retry: t.adminRuns.runs.stateRetry, active: t.adminRuns.runs.stateActive };

  // Live view: refresh every 20 s while visible.
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && refresh.state === "idle" && refresh.load("/admin/runs"), 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const backlog = new Map<string, Record<string, { n: number; oldest: string }>>();
  for (const q of r.queues) backlog.set(q.name, { ...(backlog.get(q.name) ?? {}), [q.state]: { n: q.n, oldest: q.oldest } });
  const queued = r.queues.filter((q) => q.state !== "active").reduce((a, q) => a + q.n, 0);
  const worker = r.processes.find((p) => p.role === "worker");
  const failing = r.jobs.filter((j) => j.status === "failed");

  return (
    <AdminPage title={t.adminRuns.runs.title} subtitle={t.adminRuns.runs.subtitle(bj(r.checkedAt))}>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="worker"
          value={<span className="inline-flex items-center gap-2 text-[18px]"><Dot tone={worker?.alive ? "ok" : "bad"} />{worker ? (worker.alive ? t.adminRuns.runs.workerRunning : t.adminRuns.runs.workerHeartbeatLost) : t.adminRuns.runs.workerNoHeartbeat}</span>}
          hint={worker ? t.adminRuns.runs.heartbeatHint(worker.host, ago(worker.at, Date.now(), locale)) : t.adminRuns.runs.workerNoHeartbeatHint}
        />
        <Stat label={t.adminRuns.runs.backlogLabel} value={num(queued)} tone={queued > 500 ? "warn" : undefined} hint={t.adminRuns.runs.backlogHint} />
        <Stat label={t.adminRuns.runs.failingJobsLabel} value={num(failing.length)} tone={failing.length ? "bad" : "ok"} hint={t.adminRuns.runs.failingJobsHint} />
        <Stat label={t.adminRuns.runs.unknownReceiptsLabel} value={num(r.receipts.issues.filter((x) => x.status === "unknown").length)} tone={r.receipts.issues.some((x) => x.status === "unknown") ? "bad" : "ok"} hint={t.adminRuns.runs.paidRequests7d(num(Object.values(r.receipts.counts).reduce((a, b) => a + b, 0)))} />
        <Stat label={t.adminRuns.runs.unknownDeliveriesLabel} value={num(r.deliveries.filter((d) => d.status === "unknown").length)} tone={r.deliveries.some((d) => d.status === "unknown") ? "bad" : "ok"} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card title={t.adminRuns.runs.queueCard} pad={false}>
          <DataTable
            dense
            rows={[...backlog.entries()]}
            rowKey={([name]) => name}
            empty={t.adminRuns.runs.queueEmpty}
            columns={[
              { key: "n", label: t.adminRuns.runs.colQueue, render: ([name]) => <span className="font-mono text-[12.5px]">{name}</span> },
              ...(["created", "retry", "active"] as const).map((st) => ({
                key: st,
                label: stateLabel[st]!,
                align: "right" as const,
                render: ([, v]: [string, Record<string, { n: number; oldest: string }>]) => (v[st] ? <span title={t.adminRuns.runs.earliest(bj(v[st]!.oldest, true))}>{num(v[st]!.n)}</span> : <span className="text-ink-4">0</span>),
              })),
              { key: "old", label: t.adminRuns.runs.oldestQueued, render: ([, v]) => <Time at={v.created?.oldest ?? v.retry?.oldest ?? null} /> },
            ]}
          />
        </Card>
        <Card title={t.adminRuns.runs.jobsCard} pad={false}>
          <DataTable
            dense
            rows={r.jobs}
            rowKey={(j) => j.job}
            columns={[
              { key: "j", label: t.adminRuns.runs.colJob, render: (j) => <span className="font-mono text-[12.5px]">{j.job}</span> },
              { key: "s", label: t.adminRuns.runs.colLast, render: (j) => <Badge tone={j.status === "ok" ? "ok" : j.status === "failed" ? "bad" : "muted"} title={j.error ?? undefined}>{j.status ?? t.adminRuns.runs.running}</Badge> },
              { key: "at", label: t.adminRuns.runs.colTime, render: (j) => <Time at={j.started_at} /> },
              { key: "d", label: t.adminRuns.runs.colDuration, align: "right", render: (j) => duration(j.started_at, j.finished_at) },
              { key: "f", label: t.adminRuns.runs.colFailed24h, align: "right", render: (j) => (j.failed_24h ? <span className="text-hot">{j.failed_24h}/{j.runs_24h}</span> : `0/${j.runs_24h}`) },
            ]}
          />
        </Card>
      </div>

      {r.failedJobs.length > 0 && (
        <Card className="mt-5" title={t.adminRuns.runs.failedJobsCard} pad={false}>
          <DataTable
            dense
            rows={r.failedJobs}
            rowKey={(j) => j.name}
            columns={[
              { key: "n", label: t.adminRuns.runs.colQueue, render: (j) => <span className="font-mono text-[12.5px]">{j.name}</span> },
              { key: "c", label: t.adminRuns.runs.colFailed, align: "right", render: (j) => num(j.failed) },
              { key: "l", label: t.adminRuns.runs.colRecent, render: (j) => <Time at={j.last} /> },
              { key: "o", label: t.adminRuns.runs.colLastError, render: (j) => <span className="line-clamp-2 font-mono text-[11.5px] text-ink-3">{j.last_output}</span> },
            ]}
          />
        </Card>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title={t.adminRuns.runs.receiptsCard} right={<span>{Object.entries(r.receipts.counts).map(([k, v]) => `${k} ${v}`).join(" · ")}</span>} pad={false}>
          <DataTable
            dense
            rows={r.receipts.issues}
            rowKey={(x) => x.id}
            empty={t.adminRuns.runs.receiptsEmpty}
            columns={[
              { key: "id", label: t.adminRuns.runs.colReceipt, render: (x) => <span className="num">#{x.id}</span> },
              { key: "s", label: t.adminRuns.runs.colStatus, render: (x) => <Badge tone={x.status === "unknown" ? "bad" : "warn"}>{x.status}</Badge> },
              { key: "w", label: t.adminRuns.runs.colService, render: (x) => <span className="whitespace-nowrap">{x.service}{x.model ? ` · ${x.model}` : ""}</span> },
              { key: "p", label: t.adminRuns.runs.colPurpose, render: (x) => (x.subject && /^[\w-]{10,}$/.test(x.subject) && x.purpose.includes("analy") ? <Link className="text-accent" to={`/admin/content/${x.subject}`}>{x.purpose}</Link> : x.purpose) },
              { key: "e", label: t.adminRuns.runs.colError, render: (x) => <span className="line-clamp-2 text-[12px] text-ink-3" title={x.error ?? ""}>{x.error}</span> },
              { key: "a", label: "", render: (x) => (x.status === "unknown" ? <Button size="sm" onClick={() => setReceipt(x)}>{t.adminRuns.runs.checkButton}</Button> : null) },
            ]}
          />
        </Card>
        <Card title={t.adminRuns.runs.deliveriesCard} pad={false}>
          <DataTable
            dense
            rows={r.deliveries}
            rowKey={(d) => d.id}
            empty={t.adminRuns.runs.deliveriesEmpty}
            columns={[
              { key: "t", label: t.adminRuns.runs.colTarget, render: (d) => d.target_key },
              { key: "s", label: t.adminRuns.runs.colStatus, render: (d) => <Badge tone={d.status === "unknown" ? "bad" : "warn"}>{d.status}</Badge> },
              { key: "sub", label: t.adminRuns.runs.colContent, render: (d) => (d.subject_kind === "selected" ? <Link className="text-accent" to={`/admin/content/${d.subject_id}`}>{d.subject_id}</Link> : `${d.subject_kind} ${d.subject_id}`) },
              { key: "at", label: t.adminRuns.runs.colTime, render: (d) => <Time at={d.updated_at} /> },
              { key: "a", label: "", render: (d) => <Button size="sm" onClick={() => setDelivery(d)}>{t.adminRuns.runs.handleButton}</Button> },
            ]}
          />
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title={t.adminRuns.runs.laggingCard} right={<Link className="text-accent" to="/admin/sources?health=failing">{t.adminRuns.runs.allFailing}</Link>} pad={false}>
          <DataTable
            dense
            rows={r.lagging}
            rowKey={(s) => s.id}
            empty={t.adminRuns.runs.laggingEmpty}
            columns={[
              { key: "n", label: t.adminRuns.runs.colSource, render: (s) => <Link className="text-ink hover:text-accent" to={`/admin/sources/${encodeURIComponent(s.id)}`}>{s.name}</Link> },
              { key: "h", label: t.adminRuns.runs.colHealth, render: (s) => <Badge tone={s.health === "failing" ? "bad" : s.health === "degraded" ? "warn" : "muted"}>{s.health}</Badge> },
              { key: "ok", label: t.adminRuns.runs.colLastOk, render: (s) => <Time at={s.last_ok_at} /> },
              { key: "nx", label: t.adminRuns.runs.colNextFetch, render: (s) => <Time at={s.next_fetch_at} /> },
              { key: "e", label: t.adminRuns.runs.colError, render: (s) => <span className="line-clamp-1 text-[12px] text-ink-3" title={s.last_error ?? ""}>{s.last_error}</span> },
            ]}
          />
        </Card>
        <Card
          title={t.adminRuns.runs.errorsCard}
          right={
            <span className="flex items-center gap-3">
              {r.retrying.count > 0 && <span>{t.adminRuns.runs.retrying(num(r.retrying.count))} <Time at={r.retrying.next} /></span>}
              {r.errors.length > 0 && <Button size="sm" onClick={() => setRequeue("")}>{t.adminRuns.runs.requeueAll}</Button>}
            </span>
          }
          pad={false}
        >
          <DataTable
            dense
            rows={r.errors}
            rowKey={(e) => e.error}
            empty={t.adminRuns.runs.errorsEmpty}
            columns={[
              { key: "e", label: t.adminRuns.runs.colError, render: (e) => <span className="font-mono text-[11.5px] text-ink-2">{e.error}</span> },
              { key: "n", label: t.adminRuns.runs.colErrorCount, align: "right", render: (e) => num(e.n) },
              { key: "x", label: t.adminRuns.runs.colExample, render: (e) => <Link className="text-accent" to={`/admin/content/${e.example}`}>{t.adminRuns.runs.viewButton}</Link> },
              { key: "l", label: t.adminRuns.runs.colRecent, render: (e) => <Time at={e.last} /> },
              { key: "a", label: "", align: "right", render: (e) => <Button size="sm" onClick={() => setRequeue(e.error)}>{t.adminRuns.runs.requeueButton}</Button> },
            ]}
          />
        </Card>
      </div>

      {r.leaderboard && (
        <Card
          className="mt-5"
          title={t.adminRuns.runs.leaderboardCard}
          right={<span>{t.adminRuns.runs.leaderboardRight(bj(r.leaderboard.at), r.leaderboard.sources.filter((x) => x.ok).length, r.leaderboard.sources.length)}</span>}
          pad={false}
        >
          <div className="max-h-[360px] overflow-y-auto">
            <DataTable
              dense
              rows={r.leaderboard.sources}
              rowKey={(x) => x.key}
              columns={[
                { key: "k", label: t.adminRuns.runs.colOrigin, render: (x) => <span className="font-mono text-[12.5px]">{x.key}</span> },
                { key: "s", label: t.adminRuns.runs.colLastFetch, render: (x) => <Badge tone={x.ok ? "ok" : "bad"}>{x.ok ? (x.changed ? t.adminRuns.runs.updatedBadge : t.adminRuns.runs.noChangeBadge) : t.adminRuns.runs.failedBadge}</Badge> },
                { key: "ok", label: t.adminRuns.runs.colLastOk, render: (x) => <Time at={x.lastOkAt} /> },
                { key: "n", label: t.adminRuns.runs.colRows, align: "right", render: (x) => (x.rows == null ? "—" : num(x.rows)) },
                { key: "e", label: t.adminRuns.runs.colError, render: (x) => <span className="line-clamp-1 text-[12px] text-ink-3" title={x.error ?? ""}>{x.error}</span> },
              ]}
            />
          </div>
        </Card>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title={t.adminRuns.runs.timelineCard} pad={false}>
          <div className="max-h-[420px] overflow-y-auto">
            <DataTable
              dense
              rows={r.timeline}
              rowKey={(row) => row.id}
              columns={[
                { key: "at", label: t.adminRuns.runs.colStart, render: (row) => <span className="num whitespace-nowrap">{bj(row.started_at)}</span> },
                { key: "j", label: t.adminRuns.runs.colJob, render: (row) => <span className="font-mono text-[12px]">{row.job}</span> },
                { key: "s", label: t.adminRuns.runs.colResult, render: (row) => <Badge tone={row.status === "ok" ? "ok" : row.status === "failed" ? "bad" : "muted"} title={row.error ?? undefined}>{row.status ?? t.adminRuns.runs.running}</Badge> },
                { key: "d", label: t.adminRuns.runs.colDuration, align: "right", render: (row) => duration(row.started_at, row.finished_at) },
              ]}
            />
          </div>
        </Card>
        <Card title={t.adminRuns.runs.ingestCard} pad={false}>
          {r.ingest.length ? (
            <DataTable
              dense
              rows={r.ingest}
              rowKey={(e) => `${e.client}-${e.created_at}`}
              columns={[
                { key: "at", label: t.adminRuns.runs.colTime, render: (e) => <Time at={e.created_at} /> },
                { key: "c", label: t.adminRuns.runs.colClient, render: (e) => e.client },
                { key: "k", label: t.adminRuns.runs.colKind, render: (e) => e.kind },
                { key: "s", label: t.adminRuns.runs.colResult, render: (e) => <Badge tone={e.status === "ok" ? "ok" : e.status === "error" ? "bad" : "muted"} title={e.error ?? undefined}>{e.status}</Badge> },
                { key: "x", label: t.adminRuns.runs.colSummary, render: (e) => <Json value={e.summary} label={t.adminRuns.runs.colSummary} /> },
              ]}
            />
          ) : (
            <Empty>{t.adminRuns.runs.ingestEmpty}</Empty>
          )}
        </Card>
      </div>

      {r.processes.length > 0 && (
        <Card className="mt-5" title={t.adminRuns.runs.processesCard}>
          <ul className="grid gap-2 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
            {r.processes.map((p) => (
              <li key={p.role} className="flex items-center gap-2">
                <Dot tone={p.alive ? "ok" : "bad"} />
                <span className="font-medium">{p.role}</span>
                <span className="text-ink-3">{p.host} · pid {p.pid} · {p.release}{t.adminRuns.runs.startedAt(bj(p.startedAt))}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ReasonDialog
        open={!!receipt}
        title={t.adminRuns.runs.receiptTitle(String(receipt?.id ?? ""))}
        description={t.adminRuns.runs.receiptDescription}
        confirmLabel={t.adminRuns.runs.recordAndRelease}
        busy={pending === "release"}
        onClose={() => setReceipt(null)}
        onSubmit={async (note) => (await run("POST", `/api/admin/receipts/${receipt!.id}/release`, { billed: billed === "true", note }, { label: "release", success: t.adminRuns.runs.releasedToast })) !== null}
      >
        <Field label={t.adminRuns.runs.billedField}>
          <Select value={billed} onChange={(e) => setBilled(e.target.value)}>
            <option value="false">{t.adminRuns.runs.notBilled}</option>
            <option value="true">{t.adminRuns.runs.billed}</option>
          </Select>
        </Field>
      </ReasonDialog>
      <ReasonDialog
        open={requeue !== null}
        title={requeue ? t.adminRuns.runs.requeueGroup : t.adminRuns.runs.requeueAllTitle}
        description={t.adminRuns.runs.requeueDescription}
        confirmLabel={t.adminRuns.runs.requeue}
        busy={pending === "requeue"}
        onClose={() => setRequeue(null)}
        onSubmit={async (reason) => (await run("POST", "/api/admin/processing/requeue", { group: requeue || null, reason }, { label: "requeue", success: t.adminRuns.runs.requeuedToast })) !== null}
      />
      <ReasonDialog
        open={!!delivery}
        title={t.adminRuns.runs.resolveDelivery}
        description={t.adminRuns.runs.deliveryDescription}
        confirmLabel={t.adminRuns.runs.confirm}
        danger={outcome === "resend"}
        busy={pending === "delivery"}
        onClose={() => setDelivery(null)}
        onSubmit={async (note) => (await run("POST", `/api/admin/deliveries/${delivery!.id}/resolve`, { outcome, note }, { label: "delivery", success: t.adminRuns.runs.deliveredToast })) !== null}
      >
        <Field label={t.adminRuns.runs.resultField}>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
            <option value="sent">{t.adminRuns.runs.sentOption}</option>
            <option value="drop">{t.adminRuns.runs.dropOption}</option>
            <option value="resend">{t.adminRuns.runs.resendOption}</option>
          </Select>
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
