// 对话: thin shell around features/chat/chat. Prefill comes from ?prefill=.
import { SITE } from "@topka/industry/site";
import { useSearchParams } from "react-router";
import { readerLoader } from "../lib/reader.server";
import { noStore, ReaderData } from "../components/shell/ReaderData";
import type { Route } from "./+types/chat";
import { pageMeta } from "../lib/seo";
import { localeOf, messages } from "../lib/i18n";
import { CHAT_PATHS, ChatPage } from "../features/chat/chat";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.chat.metaTitle, description: t.chat.metaDescription(SITE.name), path: "/chat", noindex: true, locale });
};

export const headers = noStore;

export const loader = readerLoader(() => CHAT_PATHS);

export default function ChatRoute() {
  const [params] = useSearchParams();
  const prefill = params.get("prefill")?.trim() || undefined;
  return (
    <ReaderData>
      <ChatPage initialText={prefill} />
    </ReaderData>
  );
}
