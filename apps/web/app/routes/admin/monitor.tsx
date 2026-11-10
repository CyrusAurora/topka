import { SITE } from "@topka/industry/site";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/monitor";
import { adminGet } from "../../lib/admin.server";
import { messages, localeOf, useT } from "../../lib/i18n";
import { useAdminAction } from "../../features/admin/action";
import { bj } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, Empty, Field, FilterChips, Input, Json, Pager, ReasonDialog, Select } from "../../features/admin/ui";

interface EventPost {
  postId: string;
  stage: string;
  action: string;
  text: string;
  originalText: string;
  publishedAt: string;
  url: string;
}
interface MonitorEvent {
  id: string;
  type: "direct_reset" | "reset_credit";
  status: "announced" | "confirmed";
  label: string;
  display_label: string;
  scope: string;
  schedule: { precision: string; from: string; through: string; label: string } | null;
  estimate: { label: string; basis: string } | null;
  presentation: Record<string, any> | null;
  confirmed_at: string | null;
  occurred_on: string | null;
  confirmation_basis: string | null;
  withdrawn: boolean;
  created_at: string;
  updated_at: string;
  posts: EventPost[];
}
interface Post {
  id: string;
  published_at: string;
  text: string;
  url: string;
  translation: string | null;
  processed_at: string | null;
  propositions: Array<Record<string, any>> | null;
  needs_review: boolean | null;
  relevant: boolean | null;
  held: Array<{ action: string; excerpt: string }> | null;
  reviewed: boolean | null;
  skipped: boolean | null;
  failures: { count: number; since: string; error?: string } | null;
  links: Array<{ eventId: string; stage: string }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") ?? "events";
  if (tab === "posts") {
    const posts = await adminGet<{ page: number; filter: string; rows: Post[] }>(request, `/api/admin/monitor/posts?filter=${url.searchParams.get("filter") ?? "relevant"}&page=${url.searchParams.get("page") ?? 1}`);
    return { tab, posts, events: null };
  }
  const events = await adminGet<{ events: MonitorEvent[] }>(request, `/api/admin/monitor/events${url.searchParams.get("withdrawn") ? "?withdrawn=1" : ""}`);
  return { tab, posts: null, events };
}

export const meta: Route.MetaFunction = ({ matches }) => {
  const t = messages(localeOf(matches));
  return [{ title: t.adminRuns.monitor.metaTitle(SITE.name) }];
};

const toLocal = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 16) : "");
const fromLocal = (v: string) => (v ? `${v}:00+08:00` : null);

function EventCard({ e, all }: { e: MonitorEvent; all: MonitorEvent[] }) {
  const t = useT();
  const kind: Record<string, string> = { direct_reset: t.adminRuns.monitor.kindDirectReset, reset_credit: t.adminRuns.monitor.kindResetCredit };
  const { run, pending } = useAdminAction();
  const [dialog, setDialog] = useState<null | "edit" | "review" | "withdraw" | "move">(null);
  const [form, setForm] = useState(() => formOf(e));
  const [reviewDay, setReviewDay] = useState(() => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10));
  const [move, setMove] = useState<{ postId: string; to: string } | null>(null);
  const version = new Date(e.updated_at).toISOString();
  const base = `/api/admin/monitor/events/${encodeURIComponent(e.id)}`;
  const p = e.presentation ?? {};
  return (
    <article className={`rounded-panel bg-surface p-4 ring-1 ${e.withdrawn ? "opacity-60 ring-line" : e.status === "confirmed" ? "ring-line" : "ring-accent/30"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={e.type === "reset_credit" ? "info" : "accent"}>{kind[e.type]}</Badge>
            <Badge tone={e.status === "confirmed" ? "ok" : "warn"}>{e.status === "confirmed" ? t.adminRuns.monitor.confirmed : p.inProgress ? t.adminRuns.monitor.inProgress : t.adminRuns.monitor.announced}</Badge>
            {e.confirmation_basis === "receipt_review" && <Badge tone="info" title={t.adminRuns.monitor.receiptReviewTitle}>{t.adminRuns.monitor.receiptReviewBadge}</Badge>}
            {e.withdrawn && <Badge tone="bad">{t.adminRuns.monitor.withdrawnBadge}</Badge>}
            {!p.kindExplicit && <Badge>{t.adminRuns.monitor.kindNotExplicit}</Badge>}
          </div>
          <div className="mt-2 text-[15px] font-semibold text-ink">{e.schedule?.label ?? (e.estimate ? t.adminRuns.monitor.estimated(SITE.name, e.estimate.label) : t.adminRuns.monitor.noTimeGiven)}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-3">
            {p.audienceZh ?? e.scope ?? t.adminRuns.monitor.audienceNotStated}
            {p.productsZh ? ` · ${p.productsZh}` : ""}
            {e.confirmed_at ? t.adminRuns.monitor.confirmedOn(bj(e.confirmed_at, true)) : e.occurred_on ? t.adminRuns.monitor.occurredOn(e.occurred_on) : ""}
          </div>
          <div className="mt-1 font-mono text-[11.5px] text-ink-4">{e.id}{t.adminRuns.monitor.updatedAt(bj(e.updated_at, true))}</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => { setForm(formOf(e)); setDialog("edit"); }}>{t.adminRuns.monitor.edit}</Button>
          {e.status !== "confirmed" && <Button size="sm" onClick={() => setDialog("review")}>{t.adminRuns.monitor.receiptReview}</Button>}
          <Button size="sm" tone="ghost" onClick={() => setDialog("withdraw")}>{e.withdrawn ? t.adminRuns.monitor.restore : t.adminRuns.monitor.withdraw}</Button>
        </div>
      </div>
      <ol className="mt-3 space-y-2 border-t border-line pt-3">
        {e.posts.map((post) => (
          <li key={post.postId} className="grid gap-1 text-[13px] sm:grid-cols-[92px_1fr_auto]">
            <div className="flex items-center gap-1.5 sm:block">
              <Badge tone={post.action === "confirm" ? "ok" : "muted"}>{post.stage}</Badge>
              <div className="num text-[11.5px] text-ink-4 sm:mt-1">{bj(post.publishedAt)}</div>
            </div>
            <div className="min-w-0">
              <div className="text-ink">{post.text}</div>
              <a className="text-[12px] text-ink-4 hover:text-accent" href={post.url} target="_blank" rel="noreferrer">{post.originalText}</a>
            </div>
            <Button size="sm" tone="ghost" onClick={() => { setMove({ postId: post.postId, to: "" }); setDialog("move"); }}>{t.adminRuns.monitor.move}</Button>
          </li>
        ))}
      </ol>

      <ReasonDialog
        open={dialog === "edit"}
        title={t.adminRuns.monitor.editEvent}
        description={t.adminRuns.monitor.editDescription}
        confirmLabel={t.adminRuns.monitor.save}
        busy={pending === "edit"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          const patch: Record<string, unknown> = {
            type: form.type,
            status: form.status,
            audienceZh: form.audienceZh || null,
            productsZh: form.productsZh || null,
            scopeLabel: form.scopeLabel || null,
            schedule: form.precision ? { precision: form.precision, from: fromLocal(form.from), through: fromLocal(form.through || form.from) } : null,
          };
          if (form.status === "confirmed") patch.confirmedAt = fromLocal(form.confirmedAt);
          return (await run("PATCH", base, { patch, reason, version }, { label: "edit", success: t.adminRuns.monitor.eventUpdated })) !== null;
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.adminRuns.monitor.fieldType}>
            <Select value={form.type} onChange={(ev) => setForm({ ...form, type: ev.target.value as MonitorEvent["type"] })}>
              <option value="direct_reset">{t.adminRuns.monitor.kindDirectReset}</option>
              <option value="reset_credit">{t.adminRuns.monitor.kindResetCredit}</option>
            </Select>
          </Field>
          <Field label={t.adminRuns.monitor.fieldStatus}>
            <Select value={form.status} onChange={(ev) => setForm({ ...form, status: ev.target.value as MonitorEvent["status"] })}>
              <option value="announced">{t.adminRuns.monitor.announced}</option>
              <option value="confirmed">{t.adminRuns.monitor.confirmed}</option>
            </Select>
          </Field>
          <Field label={t.adminRuns.monitor.fieldPrecision}>
            <Select value={form.precision} onChange={(ev) => setForm({ ...form, precision: ev.target.value })}>
              <option value="">{t.adminRuns.monitor.noTime}</option>
              <option value="window">{t.adminRuns.monitor.window}</option>
              <option value="deadline">{t.adminRuns.monitor.deadline}</option>
              <option value="approximate">{t.adminRuns.monitor.approximate}</option>
              <option value="date">{t.adminRuns.monitor.wholeDay}</option>
            </Select>
          </Field>
          {form.status === "confirmed" && (
            <Field label={t.adminRuns.monitor.fieldConfirmedAt}>
              <Input type="datetime-local" value={form.confirmedAt} onChange={(ev) => setForm({ ...form, confirmedAt: ev.target.value })} />
            </Field>
          )}
          {form.precision && (
            <>
              <Field label={t.adminRuns.monitor.fieldFrom}><Input type="datetime-local" value={form.from} onChange={(ev) => setForm({ ...form, from: ev.target.value })} /></Field>
              {(form.precision === "window" || form.precision === "date") && <Field label={t.adminRuns.monitor.fieldThrough}><Input type="datetime-local" value={form.through} onChange={(ev) => setForm({ ...form, through: ev.target.value })} /></Field>}
            </>
          )}
          <Field label={t.adminRuns.monitor.fieldAudience}><Input value={form.audienceZh} onChange={(ev) => setForm({ ...form, audienceZh: ev.target.value })} /></Field>
          <Field label={t.adminRuns.monitor.fieldProduct}><Input value={form.productsZh} onChange={(ev) => setForm({ ...form, productsZh: ev.target.value })} /></Field>
          <Field label={t.adminRuns.monitor.fieldScopeLabel}><Input value={form.scopeLabel} onChange={(ev) => setForm({ ...form, scopeLabel: ev.target.value })} /></Field>
        </div>
      </ReasonDialog>
      <ReasonDialog
        open={dialog === "review"}
        title={t.adminRuns.monitor.reviewTitle}
        description={t.adminRuns.monitor.reviewDescription}
        confirmLabel={t.adminRuns.monitor.confirm}
        busy={pending === "review"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/receipt-review`, { occurredOn: reviewDay || null, reason, version }, { label: "review", success: t.adminRuns.monitor.confirmedToast })) !== null}
      >
        <Field label={t.adminRuns.monitor.fieldReviewDay}><Input type="date" value={reviewDay} onChange={(ev) => setReviewDay(ev.target.value)} /></Field>
      </ReasonDialog>
      <ReasonDialog
        open={dialog === "withdraw"}
        title={e.withdrawn ? t.adminRuns.monitor.restoreEvent : t.adminRuns.monitor.withdrawEvent}
        description={e.withdrawn ? t.adminRuns.monitor.restoreDescription : t.adminRuns.monitor.withdrawDescription}
        danger={!e.withdrawn}
        confirmLabel={e.withdrawn ? t.adminRuns.monitor.restore : t.adminRuns.monitor.withdraw}
        busy={pending === "withdraw"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/withdrawn`, { withdrawn: !e.withdrawn, reason, version }, { label: "withdraw", success: e.withdrawn ? t.adminRuns.monitor.restoredToast : t.adminRuns.monitor.withdrawnToast })) !== null}
      />
      <ReasonDialog
        open={dialog === "move"}
        title={t.adminRuns.monitor.movePost}
        description={t.adminRuns.monitor.moveDescription}
        confirmLabel={t.adminRuns.monitor.move}
        busy={pending === "move"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) =>
          (await run("POST", "/api/admin/monitor/relink", { postId: move!.postId, fromEventId: e.id, toEventId: move!.to || null, reason }, { label: "move", success: t.adminRuns.monitor.postMoved })) !== null
        }
      >
        <Field label={t.adminRuns.monitor.fieldTargetEvent}>
          <Select value={move?.to ?? ""} onChange={(ev) => setMove({ ...move!, to: ev.target.value })}>
            <option value="">{t.adminRuns.monitor.moveOut}</option>
            {all.filter((x) => x.id !== e.id).slice(0, 60).map((x) => (
              <option key={x.id} value={x.id}>{bj(x.created_at)} · {kind[x.type]} · {x.schedule?.label ?? x.id}</option>
            ))}
          </Select>
        </Field>
      </ReasonDialog>
    </article>
  );
}

function formOf(e: MonitorEvent) {
  const p = e.presentation ?? {};
  return {
    type: e.type,
    status: e.status,
    precision: e.schedule?.precision === "exact" ? "window" : e.schedule?.precision ?? "",
    from: toLocal(e.schedule?.from),
    through: toLocal(e.schedule?.through),
    confirmedAt: toLocal(e.confirmed_at),
    audienceZh: String(p.audienceZh ?? ""),
    productsZh: String(p.productsZh ?? ""),
    scopeLabel: String(p.scopeLabel ?? ""),
  };
}

function PostRow({ post }: { post: Post }) {
  const t = useT();
  const kind: Record<string, string> = { direct_reset: t.adminRuns.monitor.kindDirectReset, reset_credit: t.adminRuns.monitor.kindResetCredit };
  const props = post.propositions ?? [];
  const { run, pending } = useAdminAction();
  const [dialog, setDialog] = useState<null | "skip" | "reviewed">(null);
  const resolve = async (action: "skip" | "reviewed", reason: string) =>
    (await run("POST", `/api/admin/monitor/posts/${post.id}/resolve`, { action, reason }, { label: action, success: action === "skip" ? t.adminRuns.monitor.skippedToast : t.adminRuns.monitor.markedReviewedToast })) !== null;
  return (
    <article className="rounded-panel bg-surface p-4 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
        <a href={post.url} target="_blank" rel="noreferrer" className="num hover:text-accent">{bj(post.published_at, true)}</a>
        {post.skipped ? <Badge>{t.adminRuns.monitor.skippedBadge}</Badge> : post.relevant ? <Badge tone="accent">{t.adminRuns.monitor.relevant}</Badge> : post.processed_at ? <Badge>{t.adminRuns.monitor.irrelevant}</Badge> : <Badge tone="warn">{t.adminRuns.monitor.pendingId}</Badge>}
        {post.needs_review && !post.reviewed && <Badge tone="bad">{t.adminRuns.monitor.needsReview}</Badge>}
        {post.reviewed && <Badge tone="ok">{t.adminRuns.monitor.reviewed}</Badge>}
        {post.failures && <Badge tone="bad" title={post.failures.error}>{t.adminRuns.monitor.recognitionFailed(post.failures.count)}</Badge>}
        {post.links.map((l) => <Badge key={l.eventId} tone="info" title={l.eventId}>{l.stage}</Badge>)}
        <span className="ml-auto flex gap-1.5">
          {!post.processed_at && <Button size="sm" onClick={() => setDialog("skip")}>{t.adminRuns.monitor.skip}</Button>}
          {post.needs_review && !post.reviewed && post.processed_at && <Button size="sm" onClick={() => setDialog("reviewed")}>{t.adminRuns.monitor.markReviewed}</Button>}
        </span>
      </div>
      {post.held && post.held.length > 0 && (
        <div className="mt-2 rounded-control bg-bg-sunk px-3 py-2 text-[12.5px] text-ink-3">
          <div className="font-medium text-ink-2">{t.adminRuns.monitor.heldNote}</div>
          {post.held.map((h, i) => <div key={i}>{h.action} · “{h.excerpt}”</div>)}
        </div>
      )}
      <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{post.translation ?? post.text}</p>
      {post.translation && <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-ink-4">{post.text}</p>}
      {props.length > 0 && (
        <div className="mt-2 space-y-1">
          {props.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <Badge tone={p.real ? "ok" : "muted"}>{p.real ? t.adminRuns.monitor.real : t.adminRuns.monitor.notCommitment}</Badge>
              <Badge>{kind[p.kind] ?? p.kind} · {p.action}</Badge>
              {p.relatesTo && <span className="font-mono text-ink-4">→ {p.relatesTo}</span>}
              <span className="text-ink-3">{p.excerptZh ?? p.excerpt}</span>
            </div>
          ))}
          <Json value={props} label={t.adminRuns.monitor.recognitionResult} />
        </div>
      )}
      <ReasonDialog
        open={dialog === "skip"}
        title={t.adminRuns.monitor.skipPost}
        description={t.adminRuns.monitor.skipDescription}
        danger
        confirmLabel={t.adminRuns.monitor.skip}
        busy={pending === "skip"}
        onClose={() => setDialog(null)}
        onSubmit={(reason) => resolve("skip", reason)}
      />
      <ReasonDialog
        open={dialog === "reviewed"}
        title={t.adminRuns.monitor.markReviewedTitle}
        description={t.adminRuns.monitor.reviewDoneDescription}
        confirmLabel={t.adminRuns.monitor.mark}
        busy={pending === "reviewed"}
        onClose={() => setDialog(null)}
        onSubmit={(reason) => resolve("reviewed", reason)}
      />
    </article>
  );
}

export default function MonitorAdmin({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const [sp] = useSearchParams();
  const tab = loaderData.tab;
  return (
    <AdminPage
      title={t.adminRuns.monitor.pageTitle}
      subtitle={t.adminRuns.monitor.pageSubtitle}
      actions={<a className="text-[13px] text-accent" href="/codex-reset" target="_blank" rel="noreferrer">{t.adminRuns.monitor.openPublicPage}</a>}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1.5">
          <Link to="?tab=events" className={`rounded-full px-3.5 py-1.5 text-[13px] ${tab === "events" ? "bg-ink text-bg" : "bg-surface text-ink-2 ring-1 ring-line"}`}>{t.adminRuns.monitor.tabEvents}</Link>
          <Link to="?tab=posts" className={`rounded-full px-3.5 py-1.5 text-[13px] ${tab === "posts" ? "bg-ink text-bg" : "bg-surface text-ink-2 ring-1 ring-line"}`}>{t.adminRuns.monitor.tabPosts}</Link>
        </div>
        {tab === "events" ? (
          <Link to={sp.get("withdrawn") ? "?tab=events" : "?tab=events&withdrawn=1"} className="text-[12.5px] text-ink-3 hover:text-ink">{sp.get("withdrawn") ? t.adminRuns.monitor.hideWithdrawn : t.adminRuns.monitor.includeWithdrawn}</Link>
        ) : (
          <FilterChips param="filter" options={[{ value: "relevant", label: t.adminRuns.monitor.filterRelevant }, { value: "review", label: t.adminRuns.monitor.filterReview }, { value: "pending", label: t.adminRuns.monitor.filterPending }, { value: "all", label: t.adminRuns.monitor.filterAll }]} />
        )}
      </div>
      {loaderData.events && (
        <div className="space-y-3">
          {loaderData.events.events.length ? loaderData.events.events.map((e) => <EventCard key={`${e.id}-${e.updated_at}`} e={e} all={loaderData.events!.events} />) : <Card><Empty>{t.adminRuns.monitor.noEvents}</Empty></Card>}
        </div>
      )}
      {loaderData.posts && (
        <>
          <div className="space-y-3">{loaderData.posts.rows.length ? loaderData.posts.rows.map((p) => <PostRow key={p.id} post={p} />) : <Card><Empty>{t.adminRuns.monitor.noMatchingPosts}</Empty></Card>}</div>
          <Pager page={loaderData.posts.page} hasMore={loaderData.posts.rows.length === 50} />
        </>
      )}
    </AdminPage>
  );
}
