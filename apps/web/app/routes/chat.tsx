// 对话: thin shell around features/chat/chat. Prefill comes from ?prefill=.
import { SITE } from "@topka/industry/site";
import { useSearchParams } from "react-router";
import type { Route } from "./+types/chat";
import { pageMeta } from "../lib/seo";
import { localeOf, messages } from "../lib/i18n";
import { ChatPage } from "../features/chat/chat";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.chat.metaTitle, description: t.chat.metaDescription(SITE.name), path: "/chat", noindex: true, locale });
};

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function ChatRoute() {
  const [params] = useSearchParams();
  const prefill = params.get("prefill")?.trim() || undefined;
  return <ChatPage initialText={prefill} />;
}
