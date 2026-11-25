// The invite script (master design D6): its options are parsed and checked before anything is written,
// and a run creates a consumable invite and prints its code.
import "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { closeDb, sql } from "@topka/backend/db";
import { inviteConsumable } from "@topka/backend/accounts/invite";
import { InviteArgsError, parseInviteArgs } from "@topka/backend/accounts/invite-args";

const run = promisify(execFile);
after(async () => {
  await closeDb();
});

test("no options: one use, a week, a random code, made by the ops script", () => {
  assert.deepEqual(parseInviteArgs([]), { createdBy: "ops-script" });
});

test("every option is passed on", () => {
  assert.deepEqual(parseInviteArgs(["--uses", "5", "--days", "30", "--code", "first-batch", "--note", "首批", "--by", "ops"]), {
    createdBy: "ops", maxUses: 5, expiresInDays: 30, code: "first-batch", note: "首批",
  });
});

test("bad options are refused before anything is written", () => {
  for (const argv of [["--uses", "0"], ["--uses", "1.5"], ["--days", "-3"], ["--days", "366"], ["--code", "a b"], ["--code", "short"], ["--bogus"], ["extra"]]) {
    assert.throws(() => parseInviteArgs(argv), InviteArgsError, argv.join(" "));
  }
});

test("a run creates a consumable invite and prints its code and the register page", async () => {
  const code = `cli-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const { stdout } = await run(process.execPath, ["scripts/create-invite.ts", "--uses", "3", "--days", "2", "--code", code, "--note", "cli test"]);
  assert.match(stdout, new RegExp(`邀请码：${code}`));
  assert.match(stdout, /注册页：.+\/register/);
  assert.match(stdout, /可用次数：3/);
  assert.equal(await inviteConsumable(code), true);
  const [row] = await sql<{ max_uses: number; created_by: string; days: number }[]>`
    SELECT max_uses, created_by, round(extract(epoch FROM expires_at - now()) / 86400)::int AS days FROM invitations WHERE code = ${code}`;
  assert.deepEqual(row, { max_uses: 3, created_by: "ops-script", days: 2 });

  await assert.rejects(run(process.execPath, ["scripts/create-invite.ts", "--code", code]), (error: { code?: number; stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr ?? "", /已经存在/);
    return true;
  });
});
