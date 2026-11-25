import { SITE } from "@topka/industry/site";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CATEGORY_KEYS, CATEGORY_LABELS } from "@topka/contracts/taxonomy";
import type { Route } from "./+types/content-item";
import { adminGet } from "../../lib/admin.server";
import { localeOf, messages, useLocale, useT, useUiPrefs } from "../../lib/i18n";
import { useAdminAction } from "../../features/admin/action";
import { bj, money } from "../../features/admin/format";
import { labels } from "../../features/admin/labels";
import { AdminPage, Badge, Button, Card, Empty, Field, Input, Json, KV, ReasonDialog, Select, Textarea } from "../../features/admin/ui";

type Row = Record<string, any>;
interface Chain {
  article: Row;
  discoveries: Row[];
  revisions: Row[];
  analyses: Row[];
  publication: Row | null;
  override: { fields: Record<string, unknown>; visibility: string | null; reason: string | null; version: number; updated_by: string; updated_at: string } | null;
  membership: Row[];
  decisions: Row[];
  history: Row[];
  observation: { state: "current" | "corrected" | "retracted-material"; revision: number; withdrawal: Row | null } | null;
  withdrawals: Row[];
  rejections: Row[];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  return adminGet<Chain>(request, `/api/admin/content/${encodeURIComponent(params.id)}`);
}

export const meta: Route.MetaFunction = ({ matches, loaderData }) => {
  const t = messages(localeOf(matches));
  const title = loaderData?.publication?.title ?? loaderData?.article.title ?? t.adminContent.contentItem.fallbackTitle;
  return [{ title: t.adminContent.contentItem.metaTitle(title, SITE.name) }];
};

function Step({ title, meta, children, tone = "accent", last }: { title: ReactNode; meta?: ReactNode; children: ReactNode; tone?: "accent" | "muted" | "bad"; last?: boolean }) {
  const dot = tone === "bad" ? "bg-hot" : tone === "muted" ? "bg-ink-4" : "bg-accent";
  return (
    <li className="relative pl-7">
      {!last && <span className="absolute left-[7px] top-4 h-full w-px bg-line-strong" aria-hidden />}
      <span className={`absolute left-[3px] top-[7px] size-[9px] rounded-full ring-4 ring-bg ${dot}`} aria-hidden />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
        {meta && <div className="text-[12px] text-ink-4">{meta}</div>}
      </div>
      <div className="mt-2 pb-6 text-[13px] text-ink-2">{children}</div>
    </li>
  );
}

type Dialog = null | "withdrawal" | "visibility" | "override" | "analyze" | "extract" | "group" | "detach" | "merge";

export default function ContentItem({ loaderData }: Route.ComponentProps) {
  const c = loaderData;
  const a = c.article;
  const p = c.publication;
  const { run, pending } = useAdminAction();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [visibility, setVisibility] = useState<string>(p?.visibility ?? "public");
  const [fields, setFields] = useState({ title: "", summary: "", reason: "", category: "", tags: "", selected: "", silent: "" });
  const [mergeInto, setMergeInto] = useState("");
  const [basis, setBasis] = useState("source-retracted");
  const [evidence, setEvidence] = useState("");
  const t = useT();
  const locale = useLocale();
  const { timeZone } = useUiPrefs();
  const lab = labels(locale);
  const ci = t.adminContent.contentItem;
  const version = c.override?.version ?? 0;
  const base = `/api/admin/content/${encodeURIComponent(a.id)}`;
  const story = c.membership[0];
  const title = p?.title ?? a.title;
  const time = (v: string | null | undefined, withYear = true) => bj(v, withYear, locale, timeZone);

  const openOverride = () => {
    const f = (c.override?.fields ?? {}) as Record<string, unknown>;
    setFields({
      title: String(f.title ?? ""),
      summary: String(f.summary ?? ""),
      reason: String(f.reason ?? ""),
      category: String(f.category ?? ""),
      tags: Array.isArray(f.tags) ? (f.tags as string[]).join(", ") : "",
      selected: f.selected === undefined ? "" : String(f.selected),
      silent: f.silent === undefined ? "" : String(f.silent),
    });
    setDialog("override");
  };

  return (
    <AdminPage
      title={<span className="line-clamp-2">{title}</span>}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[12px]">{a.id}</span>
          <span>·</span>
          <Link className="hover:text-accent" to={`/admin/sources/${encodeURIComponent(a.source_id)}`}>{a.source_name}</Link>
          <span>·</span>
          <a className="max-w-[420px] truncate hover:text-accent" href={a.url} target="_blank" rel="noreferrer">{a.url}</a>
        </span>
      }
      actions={
        <>
          <Button onClick={() => setDialog("visibility")}>{ci.visibilityRange}</Button>
          <Button onClick={openOverride}>{ci.override}</Button>
          <Button onClick={() => setDialog("analyze")}>{ci.reanalyze}</Button>
        </>
      }
    >
      <div className="mb-5 flex flex-wrap gap-1.5">
        {p ? <Badge tone={p.visibility === "public" ? "ok" : "warn"}>{lab.visibility[p.visibility] ?? p.visibility}</Badge> : <Badge>{ci.notPublished}</Badge>}
        {p?.selected && <Badge tone="accent">{t.adminContent.common.selected}</Badge>}
        {p?.eligible === false && <Badge>{ci.notEligible}</Badge>}
        {a.backfill && <Badge tone="warn">{ci.backfill}</Badge>}
        <Badge>{ci.processingBadge(a.processing_state)}</Badge>
        {c.override && <Badge tone="info" title={c.override.reason ?? undefined}>{ci.manualSetVersion(c.override.version)}</Badge>}
      </div>
      {a.processing_error && <div className="mb-5 rounded-card bg-hot-soft px-4 py-3 text-[13px] text-hot ring-1 ring-hot/20">{a.processing_error}</div>}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <Card title={ci.cardPipeline}>
          <ol className="pt-1">
            <Step title={ci.stepSource} meta={`${lab.kind[a.source_kind] ?? a.source_kind} · ${String(a.tier).replace("_", ".")} · ${lab.mode[a.participation_mode] ?? a.participation_mode}`}>
              <Link className="text-ink hover:text-accent" to={`/admin/sources/${encodeURIComponent(a.source_id)}`}>{a.source_name}</Link>
              <span className="text-ink-4">{ci.fulltextSite(a.site_fulltext)}</span>
            </Step>
            <Step title={ci.stepDiscovery} meta={t.adminContent.common.times(c.discoveries.length)}>
              <ul className="space-y-1">
                {c.discoveries.map((d, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="num text-ink-4">{time(d.discovered_at)}</span>
                    <span>{d.via}</span>
                    {d.source_id !== a.source_id && <span className="text-ink-3">{ci.viaSource(d.source_id)}</span>}
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 text-[12px] text-ink-4">
                {ci.originalTime} {a.published_at ? time(a.published_at) : ci.unknown}{a.published_at_claim && !a.published_at ? ci.claimUnverified(a.published_at_claim) : ""}{ci.timeline} {time(a.timeline_at)}
              </div>
            </Step>
            <Step title={ci.stepBody} meta={ci.revisionMeta(a.revision, a.body_status, a.body_chars ?? 0)}>
              {c.revisions.length ? (
                <ul className="space-y-1">
                  {c.revisions.map((r) => (
                    <li key={r.revision} className="flex gap-2">
                      <span className="num text-ink-4">v{r.revision}</span>
                      <span className="min-w-0 flex-1 truncate">{r.title}</span>
                      <span className="num shrink-0 text-ink-4">{time(r.created_at, false)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-ink-4">{ci.onlyInitialVersion}</span>
              )}
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => setDialog("extract")}>{ci.extractBody}</Button>
              </div>
            </Step>
            <Step title={ci.stepModel} meta={t.adminContent.common.times(c.analyses.length)} tone={c.analyses.length ? "accent" : "muted"}>
              {c.analyses.length ? (
                <div className="space-y-3">
                  {c.analyses.map((an) => (
                    <div key={an.id} className="rounded-control bg-bg-sunk/60 p-3 ring-1 ring-line">
                      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                        <Badge tone={an.relevance === "pass" ? "ok" : "muted"}>{an.relevance}</Badge>
                        {an.selected && <Badge tone="accent">{ci.modelSelected}</Badge>}
                        <Badge tone="info">{ci.scoreBadge(an.score)}</Badge>
                        {an.category && <Badge>{CATEGORY_LABELS[an.category as keyof typeof CATEGORY_LABELS] ?? an.category}</Badge>}
                        <span className="text-ink-4">{an.model} · {an.prompt_version}{ci.inputRevision(an.input_revision)} · {an.origin} · {time(an.created_at, false)}</span>
                      </div>
                      {an.title_zh && <div className="mt-2 font-medium text-ink">{an.title_zh}</div>}
                      {an.reason_zh && <div className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{an.reason_zh}</div>}
                      {(an.receipts as Row[]).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[11.5px]">
                          {(an.receipts as Row[]).map((r) => (
                            <span key={r.id} className="num rounded bg-surface px-1.5 py-0.5 text-ink-3 ring-1 ring-line">
                              {ci.receipt(r.id)} · {r.status} · {r.model ?? r.service}{r.cost !== null ? ` · ${money(r.cost, "CNY", locale)}` : ""}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-ink-4">{a.participation_mode === "editorial" ? ci.noJudgmentEditorial : ci.noJudgmentHotSignal}</span>
              )}
            </Step>
            <Step title={ci.stepPublic} tone={p ? (p.visibility === "withdrawn" ? "bad" : "accent") : "muted"} meta={p ? ci.updatedAt(time(p.updated_at)) : undefined}>
              {p ? (
                <KV
                  items={[
                    [ci.kvRange, lab.visibility[p.visibility] ?? p.visibility],
                    [t.adminContent.common.selected, p.selected ? ci.selectedYes(p.visible_after ? time(p.visible_after) : ci.immediate) : ci.no],
                    [ci.kvCategory, p.category ? CATEGORY_LABELS[p.category as keyof typeof CATEGORY_LABELS] ?? p.category : null],
                    [ci.kvTags, (p.tags as string[] | null)?.join(ci.tagSeparator)],
                    [ci.kvSummary, p.summary],
                    [ci.kvReason, p.reason],
                    [
                      ci.kvBodyDisplay,
                      p.body_mode,
                    ],
                  ]}
                />
              ) : (
                <span className="text-ink-4">{ci.noProjection}</span>
              )}
              {c.override && (
                <div className="mt-3 rounded-control bg-accent-softer p-3 ring-1 ring-accent/15">
                  <div className="text-[12px] text-ink-3">{ci.manualSettings(c.override.version)} · {c.override.updated_by} · {time(c.override.updated_at)}{c.override.reason ? ` · ${c.override.reason}` : ""}</div>
                  <Json value={{ visibility: c.override.visibility, ...c.override.fields }} label={ci.overrideFields} collapsed={false} />
                </div>
              )}
            </Step>
            <Step title={ci.stepGroup} last tone={story ? "accent" : "muted"} meta={a.grouped_at ? ci.groupedAt(time(a.grouped_at)) : ci.notGrouped}>
              {c.membership.map((m) => (
                <div key={m.fact_id} className="mb-2">
                  <div>
                    {ci.factLabel} <span className="font-mono text-[12px]">#{m.fact_id}</span> {m.fact_title} <Badge>{m.role}</Badge> {m.manual && <Badge tone="info">{ci.manual}</Badge>}
                  </div>
                  {m.story_public_id && (
                    <div className="mt-0.5">
                      {ci.eventLabel} {m.story_title} <span className="font-mono text-[12px] text-ink-4">#{m.story_id}</span>
                    </div>
                  )}
                </div>
              ))}
              {c.decisions.length > 0 && (
                <ul className="mt-2 space-y-1 text-[12.5px]">
                  {c.decisions.map((d, i) => (
                    <li key={i} className="flex flex-wrap gap-2">
                      <span className="num text-ink-4">{time(d.created_at, false)}</span>
                      <Badge>{d.verdict}</Badge>
                      {d.fact_id && <span>{ci.fact(d.fact_id)}</span>}
                      {d.receipt_id && <span className="text-ink-4">{ci.receipt(d.receipt_id)}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setDialog("group")}>{ci.regroup}</Button>
                {c.membership.length > 0 && <Button size="sm" onClick={() => setDialog("detach")}>{ci.detach}</Button>}
                {story?.story_id && <Button size="sm" onClick={() => setDialog("merge")}>{ci.mergeButton}</Button>}
              </div>
            </Step>
          </ol>
        </Card>

        <div className="space-y-5">
          <Card title={ci.cardRaw}>
            <KV
              items={[
                [ci.kvOriginalTitle, a.title],
                [ci.kvAuthor, a.author],
                [ci.kvLanguage, a.language],
                [ci.kvIdentityKey, <span className="break-all font-mono text-[11.5px]">{a.identity_key}</span>],
              ]}
            />
          </Card>
          <Card title={ci.cardObservation}>
            {(() => {
              const obs = c.observation;
              const withdrawn = obs?.state === "retracted-material";
              return (
                <div className="space-y-3 text-[12.5px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {obs && <Badge tone={withdrawn ? "warn" : obs.state === "corrected" ? "info" : "ok"}>{ci.observationState[obs.state]}</Badge>}
                    {obs && <span className="text-ink-4">{ci.observationRevision(obs.revision)}</span>}
                    <span className="ml-auto"><Button onClick={() => { setBasis(withdrawn ? "editorial" : "source-retracted"); setEvidence(""); setDialog("withdrawal"); }}>{withdrawn ? ci.reinstateBtn : ci.withdrawBtn}</Button></span>
                  </div>
                  {(c.withdrawals ?? []).length ? (
                    <ul className="space-y-2">
                      {c.withdrawals.map((w, i) => (
                        <li key={i}>
                          <div className="text-ink-2"><span className="font-medium">{ci.withdrawalAction[w.action as "withdraw"] ?? w.action}</span> · {ci.basis[w.basis as "editorial"] ?? w.basis} · {w.recorded_by} · {time(w.recorded_at, false)}</div>
                          <div className="text-ink-3">{w.reason}</div>
                          {w.evidence_url && <a className="break-all text-accent" href={w.evidence_url} target="_blank" rel="noreferrer">{w.evidence_url}</a>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty>{ci.withdrawalsEmpty}</Empty>
                  )}
                  {(c.rejections ?? []).length > 0 && (
                    <div>
                      <div className="font-medium text-ink-2">{ci.rejectionsTitle}</div>
                      <ul className="mt-1 space-y-1">
                        {c.rejections.map((r, i) => (
                          <li key={i} className="text-ink-3">{ci.rejectionCode[r.code as "identity-conflict"] ?? r.code} · {time(r.reported_at, false)} · {r.title ?? ""}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })()}
          </Card>
          <Card title={ci.cardHistory}>
            {c.history.length ? (
              <ul className="space-y-3 text-[12.5px]">
                {c.history.map((h, i) => (
                  <li key={i}>
                    <div className="text-ink-2"><span className="font-medium">{h.action}</span> · {h.actor} · {time(h.created_at, false)}</div>
                    {h.reason && <div className="text-ink-3">{h.reason}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{ci.noManualActions}</Empty>
            )}
          </Card>
        </div>
      </div>

      <ReasonDialog
        open={dialog === "withdrawal"}
        title={c.observation?.state === "retracted-material" ? ci.reinstateTitle : ci.withdrawTitle}
        description={c.observation?.state === "retracted-material" ? ci.reinstateDesc : ci.withdrawDesc}
        danger={c.observation?.state !== "retracted-material"}
        confirmLabel={c.observation?.state === "retracted-material" ? ci.reinstateBtn : ci.withdrawBtn}
        busy={pending === "withdrawal"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          const reinstate = c.observation?.state === "retracted-material";
          const payload = { action: reinstate ? "reinstate" : "withdraw", basis, reason, evidenceUrl: evidence.trim() || null };
          return (await run("POST", `${base}/withdrawal`, payload, { label: "withdrawal", success: reinstate ? ci.reinstateSuccess : ci.withdrawSuccess })) !== null;
        }}
      >
        <Field label={ci.basisLabel}>
          <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
            {(["source-retracted", "source-removed", "editorial"] as const).map((b) => <option key={b} value={b}>{ci.basis[b]}</option>)}
          </Select>
        </Field>
        <Field label={ci.evidenceLabel}>
          <Input inputMode="url" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="https://" />
        </Field>
      </ReasonDialog>

      <ReasonDialog
        open={dialog === "visibility"}
        title={ci.visibilityRange}
        description={ci.visibilityDesc}
        danger={visibility === "withdrawn"}
        confirmLabel={ci.apply}
        busy={pending === "visibility"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/visibility`, { visibility, reason, version }, { label: "visibility", success: ci.visibilitySuccess })) !== null}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            ["public", ci.visPublic, ci.visPublicHint],
            ["summary-only", ci.visSummaryOnly, ci.visSummaryOnlyHint],
            ["withdrawn", ci.visWithdrawn, ci.visWithdrawnHint],
          ] as const).map(([v, label, hint]) => (
            <label key={v} className={`cursor-pointer rounded-card p-3 ring-1 transition-colors ${visibility === v ? "bg-accent-soft ring-accent" : "ring-line-strong hover:bg-bg-sunk"}`}>
              <input type="radio" name="visibility" className="sr-only" checked={visibility === v} onChange={() => setVisibility(v)} />
              <div className="text-[13.5px] font-medium text-ink">{label}</div>
              <div className="mt-0.5 text-[12px] text-ink-3">{hint}</div>
            </label>
          ))}
        </div>
      </ReasonDialog>

      <ReasonDialog
        open={dialog === "override"}
        title={ci.override}
        description={ci.overrideDesc}
        confirmLabel={ci.overrideSave}
        busy={pending === "override"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          const next: Record<string, unknown> = {};
          const clear: string[] = [];
          for (const k of ["title", "summary", "reason"] as const) {
            if (fields[k].trim()) next[k] = fields[k].trim();
            else if (c.override?.fields[k] !== undefined) clear.push(k);
          }
          if (fields.category) next.category = fields.category;
          else if (c.override?.fields.category !== undefined) clear.push("category");
          if (fields.tags.trim()) next.tags = fields.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean); // i18n-data: splits the tags field on ASCII or Chinese commas
          else if (c.override?.fields.tags !== undefined) clear.push("tags");
          for (const k of ["selected", "silent"] as const) {
            if (fields[k] === "true" || fields[k] === "false") next[k] = fields[k] === "true";
            else if (c.override?.fields[k] !== undefined) clear.push(k);
          }
          return (await run("POST", `${base}/override`, { fields: next, clear, reason, version }, { label: "override", success: ci.overrideSuccess })) !== null;
        }}
      >
        <Field label={ci.fieldTitle}><Input value={fields.title} placeholder={p?.title ?? ""} onChange={(e) => setFields({ ...fields, title: e.target.value })} /></Field>
        <Field label={ci.fieldSummary}><Textarea rows={3} value={fields.summary} placeholder={p?.summary ?? ""} onChange={(e) => setFields({ ...fields, summary: e.target.value })} /></Field>
        <Field label={ci.fieldReason}><Textarea rows={2} value={fields.reason} placeholder={p?.reason ?? ""} onChange={(e) => setFields({ ...fields, reason: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={ci.fieldCategory}>
            <Select value={fields.category} onChange={(e) => setFields({ ...fields, category: e.target.value })}>
              <option value="">{ci.keepNone}</option>
              {CATEGORY_KEYS.map((k) => <option key={k} value={k}>{CATEGORY_LABELS[k]}</option>)}
            </Select>
          </Field>
          <Field label={ci.fieldTags}><Input value={fields.tags} onChange={(e) => setFields({ ...fields, tags: e.target.value })} /></Field>
          <Field label={ci.fieldSelected}>
            <Select value={fields.selected} onChange={(e) => setFields({ ...fields, selected: e.target.value })}>
              <option value="">{ci.modelDefault}</option>
              <option value="true">{ci.forceSelected}</option>
              <option value="false">{ci.forceNotSelected}</option>
            </Select>
          </Field>
          <Field label={ci.fieldSilent}>
            <Select value={fields.silent} onChange={(e) => setFields({ ...fields, silent: e.target.value })}>
              <option value="">{ci.normal}</option>
              <option value="true">{ci.silent}</option>
              <option value="false">{ci.unsilent}</option>
            </Select>
          </Field>
        </div>
      </ReasonDialog>

      <ReasonDialog
        open={dialog === "analyze"}
        title={ci.analyzeTitle}
        description={ci.analyzeDesc}
        requireReason={false}
        confirmLabel={ci.reanalyze}
        busy={pending === "analyze"}
        onClose={() => setDialog(null)}
        onSubmit={async () => (await run("POST", `${base}/rerun`, { step: "analyze" }, { label: "analyze", success: ci.analyzeSuccess })) !== null}
      />
      <ReasonDialog
        open={dialog === "extract"}
        title={ci.extractBody}
        requireReason={false}
        confirmLabel={ci.extractConfirm}
        busy={pending === "extract"}
        onClose={() => setDialog(null)}
        onSubmit={async () => (await run("POST", `${base}/rerun`, { step: "extract" }, { label: "extract", success: ci.extractSuccess })) !== null}
      />
      <ReasonDialog
        open={dialog === "group"}
        title={ci.regroup}
        description={ci.groupDesc}
        requireReason={false}
        confirmLabel={ci.regroup}
        busy={pending === "group"}
        onClose={() => setDialog(null)}
        onSubmit={async () => (await run("POST", `${base}/rerun`, { step: "group" }, { label: "group", success: ci.groupSuccess })) !== null}
      />
      <ReasonDialog
        open={dialog === "detach"}
        title={ci.detach}
        description={ci.detachDesc}
        danger
        confirmLabel={ci.detachConfirm}
        busy={pending === "detach"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/detach`, { reason }, { label: "detach", success: ci.detachSuccess })) !== null}
      />
      <ReasonDialog
        open={dialog === "merge"}
        title={ci.mergeTitle}
        description={ci.mergeDesc(story?.story_id, story?.story_title ?? "")}
        danger
        confirmLabel={ci.mergeConfirm}
        busy={pending === "merge"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          if (!/^\d+$/.test(mergeInto.trim())) return false;
          return (await run("POST", "/api/admin/stories/merge", { from: story!.story_id, into: Number(mergeInto), reason }, { label: "merge", success: ci.mergeSuccess })) !== null;
        }}
      >
        <Field label={ci.mergeIntoLabel} hint={ci.mergeIntoHint}>
          <Input inputMode="numeric" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} placeholder={ci.mergeIntoPlaceholder} />
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
