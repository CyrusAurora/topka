// The example plugin in examples/plugins registers an interactive chat route that talks to an
// OpenAI-compatible endpoint and maps refusals to ProviderRejectedError.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { clearChatRoutes, interactiveChatRoutes } from "@topka/backend/providers/chat-routes";
import { ProviderRejectedError } from "@topka/backend/providers/receipts";
import register from "../examples/plugins/openai-compatible-chat-route.ts";

let status = 200;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body) as { model: string };
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: parsed.model, choices: [{ message: { content: "{\"ok\":true}" } }] }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
after(() => {
  server.close();
  clearChatRoutes();
});

test("the example route steps aside until configured, then answers and maps refusals", async () => {
  clearChatRoutes();
  delete process.env.EXAMPLE_CHAT_URL;
  register();
  const [route] = interactiveChatRoutes();
  assert.equal(route.id, "example-openai-compatible");
  assert.equal(route.enabled(), false);

  process.env.EXAMPLE_CHAT_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.EXAMPLE_CHAT_MODEL = "local-model";
  assert.equal(route.enabled(), true);
  const input = { messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 16, timeoutMs: 5000 };
  const out = await route.complete(input);
  assert.equal(out.text, "{\"ok\":true}");
  assert.equal(out.model, "local-model");

  status = 429;
  await assert.rejects(route.complete(input), (e: unknown) => e instanceof ProviderRejectedError && e.status === 429);
  delete process.env.EXAMPLE_CHAT_URL;
  delete process.env.EXAMPLE_CHAT_MODEL;
});
