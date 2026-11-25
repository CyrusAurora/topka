import { SITE } from "@topka/industry/site";
import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/models";
import { adminGet } from "../../lib/admin.server";
import { messages, localeOf, useT } from "../../lib/i18n";
import { useAdminAction } from "../../features/admin/action";
import { bj, money, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, FilterChips, ReasonDialog, Select } from "../../features/admin/ui";

interface Usage {
  purpose: string;
  model: string | null;
  promptVersion: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokensIn: number;
  tokensOut: number;
  actualCost: number | null;
  currency: string | null;
  estimate: { amount: number; currency: string } | null;
}

interface Models {
  days: number;
  capabilities: Array<{ key: string; label: string; env: string; defaultModel: string; vision: boolean; current: { model: string; source: "admin" | "env" | "default" }; usage: Usage[] }>;
  choices: Array<{ key: string; service: string; vision: boolean }>;
  history: Array<{ at: string; actor: string; subject: string; reason: string | null; before: { model: string; source: string } | null; after: { model: string; source: string } | null }>;
  benches: Array<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; created_at: string }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  const days = new URL(request.url).searchParams.get("days") ?? "7";
  return adminGet<Models>(request, `/api/admin/models?days=${encodeURIComponent(days)}`);
}

export const meta: Route.MetaFunction = ({ matches }) => [{ title: messages(localeOf(matches)).adminConfig.models.metaTitle(SITE.name) }];

const secs = (ms: number | null) => (ms == null ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export default function ModelsAdmin({ loaderData: m }: Route.ComponentProps) {
  const t = useT();
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<Models["capabilities"][number] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const capLabel = (c: { key: string; label: string }) => t.adminConfig.models.capabilities[c.key] ?? c.label;
  const labelOf = (key: string) => { const c = m.capabilities.find((x) => `capability:${x.key}` === key); return c ? capLabel(c) : key; };

  return (
    <AdminPage
      title={t.adminConfig.models.title}
      subtitle={t.adminConfig.models.subtitle}
      actions={<FilterChips param="days" options={[{ value: "1", label: t.adminConfig.models.range24h }, { value: "", label: t.adminConfig.models.range7d }, { value: "30", label: t.adminConfig.models.range30d }]} />}
    >
      <div className="grid gap-5">
        {m.capabilities.map((c) => {
          const total = c.usage.reduce((a, u) => a + u.calls, 0);
          return (
            <Card
              key={c.key}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {capLabel(c)}
                  <span className="font-mono text-[12px] font-normal text-ink-3">{c.current.model}</span>
                  <Badge tone={c.current.source === "admin" ? "accent" : "muted"}>{t.adminConfig.models.sourceLabel[c.current.source]}</Badge>
                </span>
              }
              right={
                <Button
                  size="sm"
                  onClick={() => {
                    setTarget(c);
                    setChoice(c.current.model);
                  }}
                >
                  {t.adminConfig.models.switchAction}
                </Button>
              }
              pad={false}
            >
              {c.usage.length ? (
                <DataTable
                  dense
                  rows={c.usage}
                  rowKey={(u) => `${u.purpose}|${u.model}|${u.promptVersion}`}
                  columns={[
                    { key: "m", label: t.adminConfig.models.colModel, render: (u) => <span className="whitespace-nowrap font-mono text-[12px]">{u.model}</span> },
                    { key: "v", label: t.adminConfig.models.colPromptVersion, render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.promptVersion ?? "—"}</span> },
                    { key: "p", label: t.adminConfig.models.colPurpose, render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.purpose}</span> },
                    { key: "c", label: t.adminConfig.models.colCalls, align: "right", render: (u) => num(u.calls) },
                    {
                      key: "ok",
                      label: t.adminConfig.models.colSuccessRate,
                      align: "right",
                      render: (u) => {
                        const rate = u.calls ? u.ok / u.calls : 0;
                        return <span className={rate < 0.95 ? "text-hot" : ""} title={t.adminConfig.models.failedTitle(u.failed, u.unknown)}>{`${Math.round(rate * 1000) / 10}%`}</span>;
                      },
                    },
                    { key: "l", label: t.adminConfig.models.colLatency, align: "right", render: (u) => <span className="whitespace-nowrap">{`${secs(u.p50)} / ${secs(u.p95)}`}</span> },
                    { key: "t", label: t.adminConfig.models.colTokens, align: "right", render: (u) => <span className="whitespace-nowrap">{`${num(u.tokensIn)} / ${num(u.tokensOut)}`}</span> },
                    {
                      key: "$",
                      label: t.adminConfig.models.colCost,
                      align: "right",
                      render: (u) =>
                        u.actualCost !== null ? (
                          `${money(u.actualCost)}${u.currency && u.currency !== "CNY" ? ` ${u.currency}` : ""}`
                        ) : u.estimate ? (
                          <span title={t.adminConfig.models.estimateTitle}>≈ {money(u.estimate.amount)}{u.estimate.currency !== "CNY" ? ` ${u.estimate.currency}` : ""}</span>
                        ) : (
                          <span className="whitespace-nowrap text-ink-4" title={t.adminConfig.models.unpricedTitle}>{t.adminConfig.models.unpriced}</span>
                        ),
                    },
                  ]}
                />
              ) : (
                <Empty>{t.adminConfig.models.noCalls(m.days)}{total === 0 && c.vision ? t.adminConfig.models.visionOnly : ""}</Empty>
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title={t.adminConfig.models.historyCard} pad={false}>
          {m.history.length ? (
            <DataTable
              dense
              rows={m.history}
              rowKey={(h) => `${h.at}|${h.subject}`}
              columns={[
                { key: "at", label: t.adminConfig.models.colTime, render: (h) => <span className="num whitespace-nowrap">{bj(h.at)}</span> },
                { key: "c", label: t.adminConfig.models.colCapability, render: (h) => labelOf(h.subject) },
                { key: "m", label: t.adminConfig.models.colChange, render: (h) => <span className="font-mono text-[12px]">{h.before?.model ?? "—"} → {h.after?.model ?? "—"}</span> },
                { key: "r", label: t.adminConfig.models.colReason, render: (h) => <span className="text-ink-3">{h.reason}</span> },
                { key: "a", label: t.adminConfig.models.colActor, render: (h) => h.actor },
              ]}
            />
          ) : (
            <Empty>{t.adminConfig.models.historyEmpty}</Empty>
          )}
        </Card>
        <Card title={t.adminConfig.models.benchesCard} right={<Link to="/admin/selectbench" className="text-accent">{t.adminConfig.models.seeAllRuns}</Link>} pad={false}>
          {m.benches.length ? (
            <DataTable
              dense
              rows={m.benches}
              rowKey={(b) => b.id}
              columns={[
                { key: "l", label: t.adminConfig.models.colRun, render: (b) => <Link to={`/admin/selectbench/${b.id}`} className="text-ink hover:text-accent">{b.label}</Link> },
                { key: "m", label: t.adminConfig.models.colModel, render: (b) => <span className="font-mono text-[11.5px] text-ink-3">{b.models.join(t.adminConfig.models.listSeparator)}</span> },
                { key: "n", label: t.adminConfig.models.colSample, align: "right", render: (b) => num(b.sample_size) },
                { key: "at", label: t.adminConfig.models.colTime, render: (b) => <span className="num whitespace-nowrap">{bj(b.created_at)}</span> },
              ]}
            />
          ) : (
            <Empty>{t.adminConfig.models.benchesEmpty}</Empty>
          )}
        </Card>
      </div>

      <ReasonDialog
        open={!!target}
        title={t.adminConfig.models.switchDialogTitle(target ? capLabel(target) : "")}
        description={t.adminConfig.models.switchDescription}
        confirmLabel={t.adminConfig.models.switchAction}
        busy={pending === "switch"}
        onClose={() => setTarget(null)}
        onSubmit={async (reason) =>
          (await run("POST", `/api/admin/models/${target!.key}`, { model: choice === "__default" ? null : choice, reason }, { label: "switch", success: t.adminConfig.models.switched })) !== null
        }
      >
        <Field label={t.adminConfig.models.modelField}>
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {m.choices
              .filter((x) => x.vision === !!target?.vision)
              .map((x) => (
                <option key={x.key} value={x.key}>
                  {t.adminConfig.models.modelOption(x.key, x.service)}
                </option>
              ))}
            <option value="__default">{t.adminConfig.models.restoreDefault(target?.env ?? "", target?.defaultModel ?? "")}</option>
          </Select>
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
