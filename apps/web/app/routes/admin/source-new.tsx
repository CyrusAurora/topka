import { SITE } from "@topka/industry/site";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/source-new";
import { messages, localeOf, useLocale, useT } from "../../lib/i18n";
import { labels } from "../../features/admin/labels";
import { useAdminAction } from "../../features/admin/action";
import { bj } from "../../features/admin/format";
import { AdminPage, Button, Card, Empty, Field, Input, Select, Textarea } from "../../features/admin/ui";

export const meta: Route.MetaFunction = ({ matches }) => [{ title: messages(localeOf(matches)).adminSources.sourceNew.metaTitle(SITE.name) }];

const TEMPLATES: Record<string, Record<string, unknown>> = {
  rss: { feedUrl: "https://example.com/feed.xml" },
  web_list: { url: "https://example.com/blog", baseUrl: "https://example.com", itemSelector: "article", linkSelector: "a", titleSelector: "h2", allowUrlPrefixes: ["https://example.com/blog/"] },
  json_list: { url: "https://example.com/api/posts", mode: "json_api", method: "GET", itemsPath: "data.items", titlePaths: ["title"], urlTemplate: "{raw:url}", summaryPaths: ["summary"] },
  x_search: { query: "from:handle -filter:replies", searchType: "Latest" },
  mp_account: { biz: "", name: "" },
  external: {},
};

interface Preview {
  ms: number;
  count: number;
  items: Array<{ title: string; url: string; publishedAt: string | null; excerpt: string }>;
}

export default function NewSource() {
  const t = useT();
  const lab = labels(useLocale());
  const navigate = useNavigate();
  const { run, pending } = useAdminAction();
  const [form, setForm] = useState({ id: "", name: "", kind: "rss", tier: "T2", participation_mode: "editorial", interval_minutes: 30, first_party: false, site_fulltext: true, syndicate_fulltext: false, tags: "" });
  const [config, setConfig] = useState(JSON.stringify(TEMPLATES.rss, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null);

  const parsed = () => {
    try {
      setError(null);
      return JSON.parse(config) as Record<string, unknown>;
    } catch (e) {
      setError(t.adminSources.shared.configInvalid((e as Error).message));
      return null;
    }
  };

  return (
    <AdminPage title={t.adminSources.sourceNew.title} subtitle={t.adminSources.sourceNew.subtitle}>
      <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
        <Card title={t.adminSources.sourceNew.definitionCard}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.adminSources.sourceNew.fieldId} hint={t.adminSources.sourceNew.idHint}>
              <Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} placeholder="openai-blog" />
            </Field>
            <Field label={t.adminSources.sourceNew.fieldName}>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t.adminSources.sourceNew.namePlaceholder} />
            </Field>
            <Field label={t.adminSources.sourceNew.fieldKind}>
              <Select
                value={form.kind}
                onChange={(e) => {
                  setForm({ ...form, kind: e.target.value });
                  setConfig(JSON.stringify(TEMPLATES[e.target.value] ?? {}, null, 2));
                  setPreview(null);
                }}
              >
                {Object.entries(lab.kind).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label={t.adminSources.sourceNew.fieldInterval}>
              <Input type="number" min={1} max={1440} value={form.interval_minutes} onChange={(e) => setForm({ ...form, interval_minutes: Number(e.target.value) })} />
            </Field>
            <Field label={t.adminSources.sourceNew.fieldMode}>
              <Select value={form.participation_mode} onChange={(e) => setForm({ ...form, participation_mode: e.target.value })}>
                {Object.entries(lab.mode).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label={t.adminSources.sourceNew.fieldTier}>
              <Select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
                {Object.entries(lab.tier).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label={t.adminSources.sourceNew.fieldTags}>
              <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
            </Field>
            <div className="flex flex-col justify-end gap-2 text-[13px] text-ink-2">
              {([
                ["first_party", t.adminSources.sourceNew.firstParty],
                ["site_fulltext", t.adminSources.shared.siteFulltext],
                ["syndicate_fulltext", t.adminSources.shared.syndicateFulltext],
              ] as const).map(([k, label]) => (
                <label key={k} className="inline-flex items-center gap-2">
                  <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <Field label={t.adminSources.sourceNew.fieldConfig}>
              <Textarea className="font-mono !text-[12px]" rows={10} value={config} onChange={(e) => setConfig(e.target.value)} spellCheck={false} />
            </Field>
            {error && <div className="mt-1 text-[12.5px] text-hot">{error}</div>}
          </div>
          {duplicate && (
            <div className="mt-4 rounded-card bg-amber/10 px-4 py-3 text-[13px] text-ink-2 ring-1 ring-amber/25">
              {t.adminSources.sourceNew.dupPrefix}<Link className="font-medium text-accent" to={`/admin/sources/${encodeURIComponent(duplicate.id)}`}>{duplicate.name}</Link>{t.adminSources.sourceNew.dupSuffix(duplicate.id)}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              busy={pending === "preview"}
              onClick={async () => {
                const c = parsed();
                if (!c) return;
                const r = await run<Preview>("POST", "/api/admin/sources/preview", { id: form.id || "draft", kind: form.kind, config: c }, { label: "preview", revalidate: false });
                if (r) setPreview(r);
              }}
            >
              {t.adminSources.shared.previewFetch}
            </Button>
            <Button
              tone="primary"
              busy={pending === "create"}
              disabled={!form.id || !form.name}
              onClick={async () => {
                const c = parsed();
                if (!c) return;
                const r = await run<{ created: boolean; duplicate?: { id: string; name: string }; source?: { id: string } }>(
                  "POST",
                  "/api/admin/sources",
                  { ...form, tags: form.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean), config: c },
                  { label: "create", revalidate: false },
                );
                if (!r) return;
                if (!r.created && r.duplicate) setDuplicate(r.duplicate);
                else if (r.source) navigate(`/admin/sources/${encodeURIComponent(r.source.id)}`);
              }}
            >
              {t.adminSources.sourceNew.create}
            </Button>
          </div>
        </Card>
        <Card title={preview ? t.adminSources.sourceNew.previewTitle(preview.count, preview.ms) : t.adminSources.sourceNew.previewCard}>
          {!preview ? (
            <Empty>{t.adminSources.sourceNew.previewHint}</Empty>
          ) : preview.items.length ? (
            <ul className="space-y-3">
              {preview.items.map((i) => (
                <li key={i.url} className="text-[13px]">
                  <a href={i.url} target="_blank" rel="noreferrer" className="font-medium text-ink hover:text-accent">{i.title}</a>
                  <div className="text-[12px] text-ink-4">{i.publishedAt ? bj(i.publishedAt, true) : t.adminSources.shared.noPublishTime}</div>
                  {i.excerpt && <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{i.excerpt}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t.adminSources.sourceNew.empty}</Empty>
          )}
        </Card>
      </div>
    </AdminPage>
  );
}
