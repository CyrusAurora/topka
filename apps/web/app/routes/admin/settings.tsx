import { SITE } from "@topka/industry/site";
import { useRef, useState } from "react";
import type { Route } from "./+types/settings";
import { adminGet } from "../../lib/admin.server";
import { messages, localeOf, useT } from "../../lib/i18n";
import { useAdminAction } from "../../features/admin/action";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Input, ReasonDialog } from "../../features/admin/ui";
import { toast } from "../../features/admin/toast";

interface Settings {
  contact: { wechatQr: string; feishuQr: string };
  targets: Array<{ key: string; purpose: string; kind: string; enabled: boolean; enabled_at: string | null; config_ref: string | null; note: string | null; deliveries_7d: number; last_sent_at: string | null }>;
  budgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number; note: string | null; updated_at: string; used_day: number; used_hour: number }>;
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<Settings>(request, "/api/admin/settings");
}

export const meta: Route.MetaFunction = ({ matches }) => [{ title: messages(localeOf(matches)).adminConfig.settings.metaTitle(SITE.name) }];

function QrSlot({ slot, label, src }: { slot: "wechatQr" | "feishuQr"; label: string; src: string }) {
  const t = useT();
  const { run, pending } = useAdminAction();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-4">
      <img src={src} alt={label} className="size-28 rounded-card bg-white object-contain p-1.5 ring-1 ring-line" />
      <div>
        <div className="text-[14px] font-medium text-ink">{label}</div>
        <div className="mt-0.5 break-all font-mono text-[11.5px] text-ink-4">{src}</div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > 2 * 1024 * 1024) return toast(t.adminConfig.settings.imageTooLarge, "error");
            const image = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            await run("POST", "/api/admin/settings/contact-qr", { slot, image }, { label: `qr-${slot}`, success: t.adminConfig.settings.qrReplaced(label) });
          }}
        />
        <Button className="mt-2" size="sm" busy={pending === `qr-${slot}`} onClick={() => input.current?.click()}>{t.adminConfig.settings.replaceImage}</Button>
      </div>
    </div>
  );
}

function BudgetRow({ b }: { b: Settings["budgets"][number] }) {
  const t = useT();
  const { run, pending } = useAdminAction();
  const [v, setV] = useState({ perMinute: b.per_minute, perHour: b.per_hour, perDay: b.per_day });
  const [open, setOpen] = useState(false);
  const changed = v.perMinute !== b.per_minute || v.perHour !== b.per_hour || v.perDay !== b.per_day;
  return (
    <tr className="border-b border-line/70 last:border-0">
      <td className="px-3 py-2 font-mono text-[12.5px]">{b.service}</td>
      {(["perMinute", "perHour", "perDay"] as const).map((k) => (
        <td key={k} className="px-3 py-2">
          <Input type="number" min={0} className="!w-24 !py-1 text-right" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
        </td>
      ))}
      <td className="num px-3 py-2 text-right text-ink-3">{num(b.used_hour)} / {num(b.used_day)}</td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" tone="primary" disabled={!changed} onClick={() => setOpen(true)}>{t.adminConfig.settings.save}</Button>
        <ReasonDialog
          open={open}
          title={t.adminConfig.settings.budgetTitle(b.service)}
          description={t.adminConfig.settings.budgetDescription}
          confirmLabel={t.adminConfig.settings.save}
          busy={pending === "budget"}
          onClose={() => setOpen(false)}
          onSubmit={async (reason) => (await run("PUT", `/api/admin/budgets/${encodeURIComponent(b.service)}`, { ...v, reason }, { label: "budget", success: t.adminConfig.settings.budgetSaved })) !== null}
        />
      </td>
    </tr>
  );
}

function TargetToggle({ t: target }: { t: Settings["targets"][number] }) {
  const t = useT();
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" tone={target.enabled ? "danger" : "primary"} onClick={() => setOpen(true)}>{target.enabled ? t.adminConfig.settings.disable : t.adminConfig.settings.enable}</Button>
      <ReasonDialog
        open={open}
        title={t.adminConfig.settings.toggleTitle(target.enabled ? t.adminConfig.settings.disable : t.adminConfig.settings.enable, target.note ?? target.key)}
        description={target.enabled ? t.adminConfig.settings.disableDescription : t.adminConfig.settings.enableDescription}
        danger={target.enabled}
        confirmLabel={target.enabled ? t.adminConfig.settings.disable : t.adminConfig.settings.enable}
        busy={pending === "target"}
        onClose={() => setOpen(false)}
        onSubmit={async (reason) => (await run("POST", `/api/admin/notify-targets/${encodeURIComponent(target.key)}`, { enabled: !target.enabled, reason }, { label: "target", success: t.adminConfig.settings.updated })) !== null}
      />
    </>
  );
}

export default function SettingsAdmin({ loaderData: s }: Route.ComponentProps) {
  const t = useT();
  return (
    <AdminPage title={t.adminConfig.settings.title} subtitle={t.adminConfig.settings.subtitle}>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title={t.adminConfig.settings.contactCard}>
          <div className="space-y-5">
            <QrSlot slot="wechatQr" label={t.adminConfig.settings.wechatQr} src={s.contact.wechatQr} />
            <QrSlot slot="feishuQr" label={t.adminConfig.settings.feishuQr} src={s.contact.feishuQr} />
          </div>
        </Card>
        <Card title={t.adminConfig.settings.targetsCard} pad={false}>
          <DataTable
            rows={s.targets}
            rowKey={(target) => target.key}
            columns={[
              { key: "k", label: t.adminConfig.settings.colTarget, render: (target) => <div><div className="font-medium text-ink">{target.note ?? target.key}</div><div className="font-mono text-[11.5px] text-ink-4">{target.key} · {target.config_ref}</div></div> },
              { key: "e", label: t.adminConfig.settings.colStatus, render: (target) => (target.enabled ? <Badge tone="ok">{t.adminConfig.settings.enabledAt(bj(target.enabled_at))}</Badge> : <Badge>{t.adminConfig.settings.disabled}</Badge>) },
              { key: "d", label: t.adminConfig.settings.colDeliveries7d, align: "right", render: (target) => num(target.deliveries_7d) },
              { key: "a", label: "", align: "right", render: (target) => <TargetToggle t={target} /> },
            ]}
          />
        </Card>
      </div>
      <Card className="mt-5" title={t.adminConfig.settings.budgetsCard} right={<span>{t.adminConfig.settings.usedHint}</span>} pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-ink-3">
                <th className="px-3 py-2 font-medium">{t.adminConfig.settings.colService}</th>
                <th className="px-3 py-2 font-medium">{t.adminConfig.settings.colPerMinute}</th>
                <th className="px-3 py-2 font-medium">{t.adminConfig.settings.colPerHour}</th>
                <th className="px-3 py-2 font-medium">{t.adminConfig.settings.colPerDay}</th>
                <th className="px-3 py-2 text-right font-medium">{t.adminConfig.settings.colUsed}</th>
                <th />
              </tr>
            </thead>
            <tbody>{s.budgets.map((b) => <BudgetRow key={`${b.service}-${b.updated_at}`} b={b} />)}</tbody>
          </table>
        </div>
      </Card>
    </AdminPage>
  );
}
