import { SITE } from "@topka/industry/site";
import { useState } from "react";
import { Form, useSearchParams } from "react-router";
import type { Route } from "./+types/feedback";
import { adminGet } from "../../lib/admin.server";
import { messages, localeOf, useLocale, useT } from "../../lib/i18n";
import { labels } from "../../features/admin/labels";
import { useAdminAction } from "../../features/admin/action";
import { bj } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, Empty, FilterChips, Input, Pager, ReasonDialog, Select, Textarea, Time } from "../../features/admin/ui";

interface Feedback {
  id: number;
  content: string;
  email: string | null;
  page_url: string | null;
  /** local (viewable here until forwarded), feishu (in the internal chat), gone (could not be forwarded), or null. */
  screenshot: "local" | "feishu" | "gone" | null;
  source_hash: string;
  status: string;
  note: string | null;
  forwarded_at: string | null;
  forward_error: string | null;
  created_at: string;
  updated_at: string;
  banned: boolean;
  from_source: number;
}

interface Data {
  page: number;
  rows: Feedback[];
  counts: Record<string, number>;
  bans: Array<{ source_hash: string; reason: string | null; created_by: string | null; created_at: string }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<Data>(request, `/api/admin/feedback${new URL(request.url).search}`);
}

export const meta: Route.MetaFunction = ({ matches }) => [{ title: messages(localeOf(matches)).adminConfig.feedback.metaTitle(SITE.name) }];

const TONE: Record<string, "accent" | "warn" | "ok" | "muted"> = { new: "accent", triaged: "warn", replied: "ok", resolved: "ok", spam: "muted" };

function FeedbackCard({ f }: { f: Feedback }) {
  const t = useT();
  const lab = labels(useLocale());
  const { run, pending } = useAdminAction();
  const [note, setNote] = useState(f.note ?? "");
  const [dialog, setDialog] = useState<null | "ban" | "erase">(null);
  const base = `/api/admin/feedback/${f.id}`;
  const version = new Date(f.updated_at).toISOString();
  return (
    <article className="rounded-panel bg-surface p-4 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <span className="num font-medium text-ink-2">#{f.id}</span>
        <Badge tone={TONE[f.status] ?? "muted"}>{lab.feedbackStatus[f.status] ?? f.status}</Badge>
        <Time at={f.created_at} />
        {f.email && <a className="text-accent" href={`mailto:${f.email}`}>{f.email}</a>}
        {f.page_url && <a className="max-w-[320px] truncate hover:text-accent" href={f.page_url} target="_blank" rel="noreferrer">{f.page_url}</a>}
        {f.from_source > 1 && <Badge tone="info" title={t.adminConfig.feedback.sameSourceHint}>{t.adminConfig.feedback.sameSource(f.from_source)}</Badge>}
        {f.banned && <Badge tone="bad">{t.adminConfig.feedback.banned}</Badge>}
        {!f.forwarded_at && f.status === "new" && (
          <Badge tone="warn" title={f.forward_error && f.forward_error !== "pending" ? t.adminConfig.feedback.notForwardedWithError(f.forward_error) : t.adminConfig.feedback.notForwarded}>{t.adminConfig.feedback.notForwardedBadge}</Badge>
        )}
      </div>
      <p className="mt-2.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{f.content}</p>
      {f.screenshot === "local" && (
        <a href={`${base}/screenshot`} target="_blank" rel="noreferrer" className="mt-2 inline-block">
          <img src={`${base}/screenshot`} alt={t.adminConfig.feedback.screenshotAlt} loading="lazy" className="max-h-48 rounded-control ring-1 ring-line" />
        </a>
      )}
      {f.screenshot === "feishu" && <p className="mt-2 text-[12.5px] text-ink-4">{t.adminConfig.feedback.screenshotSent}</p>}
      {f.screenshot === "gone" && <p className="mt-2 text-[12.5px] text-ink-4">{t.adminConfig.feedback.screenshotGone}</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-[180px_1fr_auto] sm:items-start">
        <Select
          aria-label={t.adminConfig.feedback.statusLabel}
          value={f.status}
          disabled={!!pending}
          onChange={(e) => run("PATCH", base, { status: e.target.value, version }, { label: "status", success: t.adminConfig.feedback.statusUpdated })}
        >
          {Object.entries(lab.feedbackStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Textarea rows={1} className="!min-h-[38px]" placeholder={t.adminConfig.feedback.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex gap-1.5">
          <Button size="md" disabled={note === (f.note ?? "")} busy={pending === "note"} onClick={() => run("PATCH", base, { note: note || null, version }, { label: "note", success: t.adminConfig.feedback.noteSaved })}>
            {t.adminConfig.feedback.saveNote}
          </Button>
          <Button tone="ghost" onClick={() => setDialog(f.banned ? null : "ban")} disabled={f.banned} title={t.adminConfig.feedback.banSourceHint}>{t.adminConfig.feedback.banSource}</Button>
          <Button tone="ghost" onClick={() => setDialog("erase")} title={t.adminConfig.feedback.eraseDataHint}>{t.adminConfig.feedback.eraseData}</Button>
        </div>
      </div>
      <ReasonDialog
        open={dialog === "ban"}
        title={t.adminConfig.feedback.banDialogTitle}
        description={t.adminConfig.feedback.banDescription}
        danger
        confirmLabel={t.adminConfig.feedback.ban}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", "/api/admin/feedback-bans", { sourceHash: f.source_hash, reason }, { label: "ban", success: t.adminConfig.feedback.bannedToast })) !== null}
      />
      <ReasonDialog
        open={dialog === "erase"}
        title={t.adminConfig.feedback.eraseDialogTitle}
        description={t.adminConfig.feedback.eraseDescription}
        danger
        confirmLabel={t.adminConfig.feedback.erase}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/erase`, { reason }, { label: "erase", success: t.adminConfig.feedback.erased })) !== null}
      />
    </article>
  );
}

export default function FeedbackAdmin({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const lab = labels(useLocale());
  const { rows, counts, bans, page } = loaderData;
  const [sp] = useSearchParams();
  const { run } = useAdminAction();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <AdminPage title={t.adminConfig.feedback.title} subtitle={t.adminConfig.feedback.subtitle}>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <FilterChips
          param="status"
          options={[{ value: "", label: t.adminConfig.feedback.chipAll, count: total }, ...Object.entries(lab.feedbackStatus).map(([k, v]) => ({ value: k, label: v, count: counts[k] ?? 0 }))]}
        />
        <Form method="get" className="w-full max-w-xs">
          {sp.get("status") && <input type="hidden" name="status" value={sp.get("status")!} />}
          <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder={t.adminConfig.feedback.searchPlaceholder} aria-label={t.adminConfig.feedback.searchLabel} />
        </Form>
      </div>
      <div className="space-y-3">
        {rows.length ? rows.map((f) => <FeedbackCard key={`${f.id}-${f.updated_at}`} f={f} />) : <Card><Empty>{t.adminConfig.feedback.empty}</Empty></Card>}
      </div>
      <Pager page={page} hasMore={rows.length === 50} />
      {bans.length > 0 && (
        <Card className="mt-8" title={t.adminConfig.feedback.bansCard}>
          <ul className="space-y-2 text-[13px]">
            {bans.map((b) => (
              <li key={b.source_hash} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-mono text-[12px] text-ink-3">{b.source_hash}</span> · {b.reason} · {b.created_by} · {bj(b.created_at, true)}
                </span>
                <Button size="sm" tone="ghost" onClick={() => run("DELETE", `/api/admin/feedback-bans/${encodeURIComponent(b.source_hash)}`, undefined, { label: `unban-${b.source_hash}`, success: t.adminConfig.feedback.unbanned })}>
                  {t.adminConfig.feedback.unban}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </AdminPage>
  );
}
