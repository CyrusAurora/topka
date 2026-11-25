// The fixed sentences 对话 says itself (not the model's words), in the reader's language: users.locale
// "en" gets English, everything else Chinese. The model's own text follows the prompt's language rule.
import { sql, type Db } from "../db.ts";
import { outputLanguageFor, type OutputLanguage } from "../accounts/locale.ts";

export async function readerLang(userId: string, db: Db = sql): Promise<OutputLanguage> {
  const [row] = await db<{ locale: string | null }[]>`SELECT locale FROM users WHERE id = ${userId}`;
  return outputLanguageFor(row?.locale);
}

export { REPLIES } from "@topka/contracts/assistant-replies";
