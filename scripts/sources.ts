// Lists sources and switches them on or off. Only switched-on sources are collected and processed
// by models; switched-off ones stay in the database untouched.
//   node --env-file=.env scripts/sources.ts list [--enabled | --disabled] [--q TEXT]
//   node --env-file=.env scripts/sources.ts toggle --on|--off --id ID [--id ID ...] [--reason TEXT]
//   node --env-file=.env scripts/sources.ts only --id ID [--id ID ...] [--reason TEXT]   (these on, all others off)
// --id takes a source id or its exact name.
import { parseArgs } from "node:util";
import { closeDb } from "@topka/backend/db";
import { stopBoss } from "@topka/backend/jobs/queue";
import { listSourceLines, onlySources, switchSources } from "@topka/backend/admin/source-switch";

const USAGE = `usage:
  sources.ts list [--enabled | --disabled] [--q TEXT]
  sources.ts toggle --on|--off --id ID [--id ID ...] [--reason TEXT]
  sources.ts only --id ID [--id ID ...] [--reason TEXT]`;
const ACTOR = "ops-script";

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
let values: { enabled?: boolean; disabled?: boolean; q?: string; on?: boolean; off?: boolean; id?: string[]; reason?: string };
try {
  ({ values } = parseArgs({
    args: rest,
    options: {
      enabled: { type: "boolean" }, disabled: { type: "boolean" }, q: { type: "string" },
      on: { type: "boolean" }, off: { type: "boolean" }, id: { type: "string", multiple: true }, reason: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (error) {
  fail((error as Error).message);
}

try {
  if (command === "list") {
    if (values.enabled && values.disabled) fail("--enabled 和 --disabled 只能选一个");
    const lines = await listSourceLines({ enabled: values.enabled ? true : values.disabled ? false : undefined, q: values.q });
    for (const s of lines) {
      console.log([s.enabled ? "on " : "off", s.id, s.kind, s.health, `${s.articles} 篇`, s.last_ok_at ? s.last_ok_at.toISOString() : "-", s.name].join("\t"));
    }
    console.log(`共 ${lines.length} 个（开 ${lines.filter((s) => s.enabled).length}）`);
  } else if (command === "toggle" || command === "only") {
    const ids = values.id ?? [];
    if (ids.length === 0) fail("至少给一个 --id");
    let missing: string[];
    if (command === "toggle") {
      if (!!values.on === !!values.off) fail("--on 和 --off 必须选一个");
      const r = await switchSources(ids, !!values.on, ACTOR, values.reason ?? null);
      console.log(`${values.on ? "已打开" : "已关闭"} ${r.changed.length} 个，原本就是该状态 ${r.unchanged.length} 个`);
      missing = r.missing;
    } else {
      const r = await onlySources(ids, ACTOR, values.reason ?? null);
      console.log(`保持打开 ${r.changed.length + r.unchanged.length} 个（新打开 ${r.changed.length}），关闭其余 ${r.offed.length} 个`);
      missing = r.missing;
    }
    if (missing.length) {
      console.error(`找不到：${missing.join(", ")}`);
      process.exitCode = 1;
    }
  } else {
    fail(command ? `不认识的命令 ${command}` : "缺少命令");
  }
} finally {
  await stopBoss();
  await closeDb();
}
