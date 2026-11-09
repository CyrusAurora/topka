// Command-line options of scripts/create-invite.ts, parsed apart from the database so they can be
// tested on their own. A bad option is refused with a message; nothing is half-applied.
import { parseArgs } from "node:util";
import type { CreateInviteInput } from "./invite.ts";

export const INVITE_USAGE =
  "usage: create-invite.ts [--uses N] [--days N] [--code CODE] [--note TEXT] [--by NAME]";

/** Readable codes an admin may pick: letters, digits, dash and underscore, 6 to 64 of them. */
const CODE_SHAPE = /^[A-Za-z0-9_-]{6,64}$/;

export class InviteArgsError extends Error {}

function positiveInt(name: string, raw: string | undefined, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new InviteArgsError(`--${name} 要一个正整数（收到 "${raw}"）`);
  const n = Number(raw);
  if (n < 1 || n > max) throw new InviteArgsError(`--${name} 要在 1 到 ${max} 之间（收到 ${n}）`);
  return n;
}

export function parseInviteArgs(argv: readonly string[]): CreateInviteInput {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        uses: { type: "string" },
        days: { type: "string" },
        code: { type: "string" },
        note: { type: "string" },
        by: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new InviteArgsError(`${(error as Error).message}\n${INVITE_USAGE}`);
  }
  if (values.code !== undefined && !CODE_SHAPE.test(values.code)) {
    throw new InviteArgsError("--code 只能用字母、数字、- 和 _，长度 6 到 64");
  }
  const input: CreateInviteInput = { createdBy: values.by ?? "ops-script" };
  const maxUses = positiveInt("uses", values.uses, 10_000);
  const expiresInDays = positiveInt("days", values.days, 365);
  if (maxUses !== undefined) input.maxUses = maxUses;
  if (expiresInDays !== undefined) input.expiresInDays = expiresInDays;
  if (values.code !== undefined) input.code = values.code;
  if (values.note !== undefined) input.note = values.note;
  return input;
}
