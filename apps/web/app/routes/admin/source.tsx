import { SITE } from "@topka/industry/site";
import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/source";
import { adminGet } from "../../lib/admin.server";
import { messages, localeOf, useLocale, useT } from "../../lib/i18n";
import { labels } from "../../features/admin/labels";
import { useAdminAction } from "../../features/admin/action";
import { bj, duration, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Dot, Empty, Field, healthTone, Input, Json, KV, ReasonDialog, Select, Stat, Textarea, Time } from "../../features/admin/ui";

interface Source {
  id: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  tags: string[];
  first_party: boolean;
  owner_entity_id: string | null;
  tier: string;
  participation_mode: string;
  signal_group_id: string | null;
  interval_minutes: number;
  site_fulltext: boolean;
  syndicate_fulltext: boolean;
  enabled: boolean;
  health: string;
  fail_count: number;
  last_fetch_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  cursor: Record<string, unknown> | null;
  next_fetch_at: string | null;
  created_at: string;
  updated_at: string;
}

/** X runs: pages read, and older stretches still to read (backlog) or given up (dropped). */
interface RunDetail {
  pages?: number;
  backlog?: number;
  dropped?: number;
}

interface Detail {
  source: Source;
  runs: Array<{ id: number; started_at: string; finished_at: string | null; status: string; found_count: number | null; new_count: number | null; error: string | null; detail: RunDetail | null }>;
  items: Array<{ id: string; title: string; url: string; discovered_at: string; published_at: string | null; processing_state: string; selected: boolean | null; visibility: string | null; title_zh: string | null }>;
  stats: { total: number; last7d: number; selected: number };
  history: Array<{ created_at: string; actor: string; action: string; reason: string | null; before: unknown; after: unknown }>;
}

interface Preview {
  ms: number;
  count: number;
  items: Array<{ title: string; url: string; publishedAt: string | null; excerpt: string }>;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  return adminGet<Detail>(request, `/api/admin/sources/${encodeURIComponent(params.id)}`);
}

export const meta: Route.MetaFunction = ({ matches, loaderData }) => [{ title: messages(localeOf(matches)).adminSources.source.metaTitle(loaderData?.source.name, SITE.name) }];

type Draft = Pick<Source, "name" | "interval_minutes" | "tier" | "participation_mode" | "signal_group_id" | "first_party" | "owner_entity_id" | "site_fulltext" | "syndicate_fulltext"> & { tags: string; config: string };

function draftOf(s: Source): Draft {
  return {
    name: s.name,
    interval_minutes: s.interval_minutes,
    tier: s.tier,
    participation_mode: s.participation_mode,
    signal_group_id: s.signal_group_id,
    first_party: s.first_party,
    owner_entity_id: s.owner_entity_id,
    site_fulltext: s.site_fulltext,
    syndicate_fulltext: s.syndicate_fulltext,
    tags: s.tags.join(", "),
    config: JSON.stringify(s.config, null, 2),
  };
}

export default function SourceDetail({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const lab = labels(useLocale());
  const { source: s, runs, items, stats, history } = loaderData;
  const { run, pending } = useAdminAction();
  const [draft, setDraft] = useState<Draft>(() => draftOf(s));
  const [draftFor, setDraftFor] = useState(s.updated_at);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dialog, setDialog] = useState<null | "save" | "toggle">(null);
  const [configError, setConfigError] = useState<string | null>(null);
  if (draftFor !== s.updated_at) {
    // The source changed (our own save or someone else's): start from the saved state.
    setDraft(draftOf(s));
    setDraftFor(s.updated_at);
  }
  const base = `/api/admin/sources/${encodeURIComponent(s.id)}`;

  const patch = (): Record<string, unknown> | null => {
    let config: unknown;
    try {
      config = JSON.parse(draft.config);
      setConfigError(null);
    } catch (e) {
      setConfigError(t.adminSources.shared.configInvalid((e as Error).message));
      return null;
    }
    const next: Record<string, unknown> = {
      ...draft,
      tags: draft.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      config,
      interval_minutes: Number(draft.interval_minutes),
      signal_group_id: draft.signal_group_id || null,
      owner_entity_id: draft.owner_entity_id || null,
    };
    const before = draftOf(s) as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      const was = k === "tags" ? s.tags : k === "config" ? s.config : before[k];
      if (JSON.stringify(v) !== JSON.stringify(was)) changed[k] = v;
    }
    return changed;
  };
  const changes = (() => {
    try {
      return Object.keys(patchPreview(draft, s)).length;
    } catch {
      return 1;
    }
  })();

  return (
    <AdminPage
      title={
        <span className="flex flex-wrap items-center gap-2">
          {s.name}
          <Badge>{lab.kind[s.kind] ?? s.kind}</Badge>
          <Badge tone={s.participation_mode === "editorial" ? "accent" : "muted"}>{lab.mode[s.participation_mode]}</Badge>
        </span>
      }
      subtitle={<span className="font-mono text-[12px]">{s.id}</span>}
      actions={
        <>
          <Button
            busy={pending === "preview"}
            onClick={async () => {
              const r = await run<Preview>("POST", `${base}/preview`, {}, { label: "preview", revalidate: false });
              if (r) setPreview(r);
            }}
          >
            {t.adminSources.shared.previewFetch}
          </Button>
          <Button busy={pending === "fetch"} onClick={() => run("POST", `${base}/fetch`, {}, { label: "fetch", success: t.adminSources.source.queued })}>
            {t.adminSources.source.fetchNow}
          </Button>
          <Button tone={s.enabled ? "danger" : "primary"} onClick={() => setDialog("toggle")}>
            {s.enabled ? t.adminSources.source.pause : t.adminSources.source.resume}
          </Button>
        </>
      }
    >
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label={t.adminSources.source.statHealth}
          value={
            <span className="inline-flex items-center gap-2 text-[18px]">
              <Dot tone={s.enabled ? healthTone(s.health) : "muted"} />
              {s.enabled ? lab.health[s.health] ?? s.health : t.adminSources.shared.pausedBadge}
            </span>
          }
          hint={s.fail_count ? t.adminSources.source.failStreak(s.fail_count) : t.adminSources.source.lastOk(s.last_ok_at ? bj(s.last_ok_at) : "—")}
        />
        <Stat label={t.adminSources.source.statTotal} value={num(stats.total)} />
        <Stat label={t.adminSources.source.statLast7d} value={num(stats.last7d)} />
        <Stat label={t.adminSources.source.statSelected} value={num(stats.selected)} />
      </div>
      {s.last_error && s.health !== "ok" && <div className="mb-5 rounded-card bg-hot-soft px-4 py-3 text-[13px] text-hot ring-1 ring-hot/20">{s.last_error}</div>}

      {preview && (
        <Card className="mb-5" title={t.adminSources.source.previewTitle(preview.count, preview.ms)} right={<button onClick={() => setPreview(null)}>{t.adminSources.source.collapse}</button>}>
          {preview.items.length ? (
            <ul className="space-y-2.5">
              {preview.items.map((i) => (
                <li key={i.url} className="text-[13px]">
                  <a href={i.url} target="_blank" rel="noreferrer" className="font-medium text-ink hover:text-accent">{i.title}</a>
                  <div className="text-[12px] text-ink-4">{i.publishedAt ? bj(i.publishedAt, true) : t.adminSources.shared.noPublishTime} · {i.url}</div>
                  {i.excerpt && <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{i.excerpt}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t.adminSources.source.previewEmpty}</Empty>
          )}
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card title={t.adminSources.source.settingsCard} right={<span>{t.adminSources.source.versionAt(bj(s.updated_at, true))}</span>}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.adminSources.source.fieldName}>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label={t.adminSources.source.fieldInterval}>
                <Input type="number" min={1} max={1440} value={draft.interval_minutes} onChange={(e) => setDraft({ ...draft, interval_minutes: Number(e.target.value) })} />
              </Field>
              <Field label={t.adminSources.source.fieldMode} hint={t.adminSources.source.modeHint}>
                <Select value={draft.participation_mode} onChange={(e) => setDraft({ ...draft, participation_mode: e.target.value })}>
                  {Object.entries(lab.mode).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label={t.adminSources.source.fieldTier}>
                <Select value={draft.tier} onChange={(e) => setDraft({ ...draft, tier: e.target.value })}>
                  {Object.entries(lab.tier).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              <Field label={t.adminSources.source.fieldSignalGroup} hint={t.adminSources.source.signalGroupHint}>
                <Input value={draft.signal_group_id ?? ""} onChange={(e) => setDraft({ ...draft, signal_group_id: e.target.value })} />
              </Field>
              <Field label={t.adminSources.source.fieldOwner}>
                <Input value={draft.owner_entity_id ?? ""} onChange={(e) => setDraft({ ...draft, owner_entity_id: e.target.value })} />
              </Field>
              <Field label={t.adminSources.source.fieldTags}>
                <Input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
              </Field>
              <div className="flex flex-col justify-end gap-2 text-[13px] text-ink-2">
                {([
                  ["first_party", t.adminSources.source.firstPartyFull],
                  ["site_fulltext", t.adminSources.shared.siteFulltext],
                  ["syndicate_fulltext", t.adminSources.shared.syndicateFulltext],
                ] as const).map(([k, label]) => (
                  <label key={k} className="inline-flex items-center gap-2">
                    <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-4">
              <Field label={t.adminSources.source.fieldConfig}>
                <Textarea className="font-mono !text-[12px]" rows={Math.min(18, draft.config.split("\n").length + 1)} value={draft.config} onChange={(e) => setDraft({ ...draft, config: e.target.value })} spellCheck={false} />
              </Field>
              {configError && <div className="mt-1 text-[12.5px] text-hot">{configError}</div>}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              {changes > 0 && <span className="text-[12.5px] text-ink-3">{t.adminSources.source.unsavedChanges(changes)}</span>}
              <Button tone="ghost" disabled={!changes} onClick={() => setDraft(draftOf(s))}>{t.adminSources.source.restore}</Button>
              <Button tone="primary" disabled={!changes} onClick={() => patch() && setDialog("save")}>{t.adminSources.source.save}</Button>
            </div>
          </Card>

          <Card title={t.adminSources.source.recentCard} pad={false}>
            <DataTable
              rows={items}
              rowKey={(r) => r.id}
              empty={t.adminSources.source.recentEmpty}
              columns={[
                {
                  key: "t",
                  label: t.adminSources.source.colTitle,
                  render: (r) => (
                    <Link to={`/admin/content/${r.id}`} className="line-clamp-2 min-w-[260px] text-ink hover:text-accent">{r.title_zh || r.title}</Link>
                  ),
                },
                { key: "s", label: t.adminSources.source.colStatus, render: (r) => <span className="flex gap-1">{r.selected && <Badge tone="accent">{t.adminSources.source.selected}</Badge>}{r.visibility && r.visibility !== "public" && <Badge tone="warn">{lab.visibility[r.visibility]}</Badge>}<Badge>{r.processing_state}</Badge></span> },
                { key: "d", label: t.adminSources.source.colDiscovered, render: (r) => <Time at={r.discovered_at} /> },
              ]}
            />
          </Card>
        </div>

        <div className="space-y-5">
          <Card title={t.adminSources.source.statusCard}>
            <KV
              items={[
                [t.adminSources.source.kvLastFetch, s.last_fetch_at ? bj(s.last_fetch_at, true) : null],
                [t.adminSources.source.kvLastOk, s.last_ok_at ? bj(s.last_ok_at, true) : null],
                [t.adminSources.source.kvNextFetch, s.next_fetch_at ? bj(s.next_fetch_at, true) : null],
                [t.adminSources.source.kvCreated, bj(s.created_at, true)],
              ]}
            />
            {s.cursor && <div className="mt-3"><Json value={s.cursor} label={t.adminSources.source.cursorLabel} /></div>}
          </Card>
          <Card title={t.adminSources.source.runsCard} pad={false}>
            <DataTable
              dense
              rows={runs}
              rowKey={(r) => r.id}
              empty={t.adminSources.source.runsEmpty}
              columns={[
                { key: "at", label: t.adminSources.source.colTime, render: (r) => <span className="num whitespace-nowrap">{bj(r.started_at)}</span> },
                {
                  key: "st",
                  label: t.adminSources.source.colResult,
                  render: (r) => (
                    <span className="inline-flex gap-1">
                      <Badge tone={r.status === "ok" ? "ok" : r.status === "failed" ? "bad" : "muted"} title={r.error ?? undefined}>{r.status}</Badge>
                      {!!r.detail?.dropped && <Badge tone="bad" title={t.adminSources.source.droppedTitle}>{t.adminSources.source.droppedBadge}</Badge>}
                      {!r.detail?.dropped && !!r.detail?.backlog && <Badge tone="warn" title={t.adminSources.source.backlogTitle}>{t.adminSources.source.backlogBadge(r.detail.backlog)}</Badge>}
                    </span>
                  ),
                },
                { key: "n", label: t.adminSources.source.colFoundNew, align: "right", render: (r) => `${r.found_count ?? "—"}/${r.new_count ?? "—"}` },
                { key: "ms", label: t.adminSources.source.colDuration, align: "right", render: (r) => duration(r.started_at, r.finished_at) },
              ]}
            />
          </Card>
          <Card title={t.adminSources.source.historyCard}>
            {history.length ? (
              <ul className="space-y-3 text-[12.5px]">
                {history.map((h, i) => (
                  <li key={i}>
                    <div className="text-ink-2"><span className="font-medium">{h.action}</span> · {h.actor} · {bj(h.created_at)}</div>
                    {h.reason && <div className="text-ink-3">{h.reason}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{t.adminSources.source.historyEmpty}</Empty>
            )}
          </Card>
        </div>
      </div>

      <ReasonDialog
        open={dialog === "save"}
        title={t.adminSources.source.saveDialogTitle}
        description={t.adminSources.source.saveDescription(Object.keys(patchPreview(draft, s)))}
        busy={pending === "save"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          const p = patch();
          if (!p) return false;
          const r = await run("PATCH", base, { patch: p, version: new Date(s.updated_at).toISOString(), reason }, { label: "save", success: t.adminSources.source.saved });
          return r !== null;
        }}
      />
      <ReasonDialog
        open={dialog === "toggle"}
        title={s.enabled ? t.adminSources.source.pauseDialogTitle : t.adminSources.source.resumeDialogTitle}
        description={s.enabled ? t.adminSources.source.pauseDescription : t.adminSources.source.resumeDescription}
        danger={s.enabled}
        confirmLabel={s.enabled ? t.adminSources.source.pause : t.adminSources.source.resume}
        busy={pending === "toggle"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          const r = await run("PATCH", base, { patch: { enabled: !s.enabled }, version: new Date(s.updated_at).toISOString(), reason }, { label: "toggle", success: s.enabled ? t.adminSources.source.paused : t.adminSources.source.resumed });
          return r !== null;
        }}
      />
    </AdminPage>
  );
}

/** Field names that differ from the saved source (for the confirmation text). */
function patchPreview(draft: Draft, s: Source): Record<string, true> {
  const out: Record<string, true> = {};
  const saved = draftOf(s);
  for (const k of Object.keys(draft) as Array<keyof Draft>) {
    if (k === "config") {
      try {
        if (JSON.stringify(JSON.parse(draft.config)) !== JSON.stringify(s.config)) out.config = true;
      } catch {
        out.config = true;
      }
    } else if (String(draft[k] ?? "") !== String(saved[k] ?? "")) out[k] = true;
  }
  return out;
}
