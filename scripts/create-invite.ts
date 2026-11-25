// Creates a registration invite (master design D6: sign-up is by invite only) and prints the code
// and the page to register on.
//   node --env-file=.env scripts/create-invite.ts [--uses 1] [--days 7] [--code CODE] [--note TEXT] [--by NAME]
// Defaults: one use, valid for 7 days, a random code.
import { config } from "@topka/backend/config";
import { closeDb } from "@topka/backend/db";
import { createInvite } from "@topka/backend/accounts/invite";
import { InviteArgsError, parseInviteArgs } from "@topka/backend/accounts/invite-args";

let input;
try {
  input = parseInviteArgs(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof InviteArgsError)) throw error;
  console.error(error.message);
  process.exit(2);
}

try {
  const invite = await createInvite(input);
  console.log(`邀请码：${invite.code}`);
  console.log(`注册页：${config.siteUrl}/register`);
  console.log(`可用次数：${invite.maxUses}，有效期至：${invite.expiresAt.toISOString()}（UTC）`);
  if (invite.note) console.log(`备注：${invite.note}`);
} catch (error) {
  if ((error as { code?: string }).code !== "23505") throw error;
  console.error(`邀请码 ${input.code} 已经存在，换一个或不传 --code`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
