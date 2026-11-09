// Example plugin: answer interactive chat (the assistant) from any OpenAI-compatible endpoint before the
// configured provider chain, e.g. a local model server. Load it with
//   TOPKA_PLUGINS=examples/plugins/openai-compatible-chat-route.ts
// and set EXAMPLE_CHAT_URL (full /chat/completions URL), EXAMPLE_CHAT_MODEL and, if needed,
// EXAMPLE_CHAT_API_KEY. Unset EXAMPLE_CHAT_URL and the route steps aside. See docs/plugins.md.
import { registerInteractiveChatRoute } from "@topka/backend/providers/chat-routes";
import { ProviderRejectedError } from "@topka/backend/providers/receipts";

export default function register(): void {
  registerInteractiveChatRoute({
    id: "example-openai-compatible",
    provider: "example",
    service: "openai-compatible",
    model: () => process.env.EXAMPLE_CHAT_MODEL ?? "",
    enabled: () => !!process.env.EXAMPLE_CHAT_URL && !!process.env.EXAMPLE_CHAT_MODEL,
    async complete({ messages, temperature, maxTokens, timeoutMs }) {
      let res: Response;
      try {
        res = await fetch(process.env.EXAMPLE_CHAT_URL!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(process.env.EXAMPLE_CHAT_API_KEY ? { authorization: `Bearer ${process.env.EXAMPLE_CHAT_API_KEY}` } : {}),
          },
          body: JSON.stringify({ model: process.env.EXAMPLE_CHAT_MODEL, messages, temperature, max_tokens: maxTokens }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Connection refused, DNS failure or timeout: bench the route briefly and fall back.
        throw new ProviderRejectedError(`connect: ${(error as Error).message}`, 504, true);
      }
      if (res.status === 402) throw new ProviderRejectedError("quota used up", 402, false);
      if (res.status === 429) throw new ProviderRejectedError("busy", 429, true);
      if (!res.ok) throw new ProviderRejectedError(`HTTP ${res.status}`, 502, true);
      const body = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }>; usage?: Record<string, unknown> };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new ProviderRejectedError("no message content", 502, true);
      return { text, model: body.model, provider: "example", usage: body.usage ?? null };
    },
  });
}
