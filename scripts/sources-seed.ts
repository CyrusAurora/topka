// Seeds sources from an embodied-AI (or other) source pack: creates new rows switched off and merges
// config/tags into existing rows without touching their enabled switch.
//   node --env-file=.env scripts/sources-seed.ts --pack NAME [--enable | --only] [--reason TEXT]
import { parseArgs } from "node:util";
import { closeDb } from "@topka/backend/db";
import { stopBoss } from "@topka/backend/jobs/queue";
import { loadPack, seedPack } from "@topka/backend/admin/source-pack-seed";
import { onlySources, switchSources } from "@topka/backend/admin/source-switch";

const USAGE = `usage:
  sources-seed.ts --pack NAME [--enable | --only] [--reason TEXT]`;

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

let values: { pack?: string; enable?: boolean; only?: boolean; reason?: string };
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pack: { type: "string" },
      enable: { type: "boolean" },
      only: { type: "boolean" },
      reason: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (error) {
  fail((error as Error).message);
}

if (!values.pack) fail("缺少 --pack");
if (values.enable && values.only) fail("--enable 和 --only 只能选一个");

const ACTOR = "ops-script";

try {
  const pack = loadPack(values.pack);
  const result = await seedPack(pack);
  console.log(`新建 ${result.inserted.length} 个，合并 ${result.merged.length} 个，原样 ${result.unchanged.length} 个`);
  if (result.packUpdated) console.log(`策展包 ${pack.packId ?? pack.id} 已更新`);
  if (values.enable) {
    const r = await switchSources(result.ids, true, ACTOR, values.reason ?? null);
    console.log(`已打开 ${r.changed.length} 个，原本就是该状态 ${r.unchanged.length} 个`);
    if (r.missing.length) {
      console.error(`找不到：${r.missing.join(", ")}`);
      process.exitCode = 1;
    }
  } else if (values.only) {
    const r = await onlySources(result.ids, ACTOR, values.reason ?? null);
    console.log(`保持打开 ${r.changed.length + r.unchanged.length} 个（新打开 ${r.changed.length}），关闭其余 ${r.offed.length} 个`);
    if (r.missing.length) {
      console.error(`找不到：${r.missing.join(", ")}`);
      process.exitCode = 1;
    }
  } else {
    console.log("都还关着：加 --enable 打开它们，或 --only 只留它们打开");
  }
} finally {
  await stopBoss();
  await closeDb();
}
