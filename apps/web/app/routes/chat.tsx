// 对话: thin shell around features/chat/chat. Prefill comes from ?prefill=.
import { SITE } from "@topka/industry/site";
import { useSearchParams } from "react-router";
import type { Route } from "./+types/chat";
import { pageMeta } from "../lib/seo";
import { ChatPage } from "../features/chat/chat";

export const meta: Route.MetaFunction = () =>
  pageMeta({ title: "对话", description: `用对话创建或改追踪项目：${SITE.name}。`, path: "/chat", noindex: true });

export function headers() {
  return { "Cache-Control": "no-store" };
}

export default function ChatRoute() {
  const [params] = useSearchParams();
  const prefill = params.get("prefill")?.trim() || undefined;
  return <ChatPage initialText={prefill} />;
}
