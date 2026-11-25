// The free provider chain as the model layer sees it: OpenCode first (its free tier refusal takes the
// provider out), then Agnes; an interactive chat tries a registered plugin route first and falls back
// to the chain when its free quota is spent.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { z } from "zod";

const T = tag();
const savedEnv = { ...process.env };
const MANAGED = [
  "LLM_EXTRA_JSON", "AGNES_EXTRA_JSON",
  "OPENCODE_API_KEY", "OPENCODE_BASE_URL", "OPENCODE_MODELS_URL", "OPENCODE_DOCS_URL", "MODELS_DEV_URL", "OPENCODE_FREE_ORDER",
  "AGNES_API_KEY", "AGNES_BASE_URL", "AGNES_MODEL", "LLM_PROVIDER_ORDER", "LLM_FREE_MODELS", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL",
  "LLM_FREE_CATALOG_URL", "LLM_FREE_QUOTA_URL",
];

function setEnv(vars: Record<string, string | undefined>): void {
  for (const name of MANAGED) delete process.env[name];
  for (const [name, value] of Object.entries(vars)) if (value !== undefined) process.env[name] = value;
}

const realFetch = globalThis.fetch;
type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<Response>;
let fetchHandler: FetchHandler = async (url) => {
  throw new Error(`unexpected fetch ${url}`);
};
let fetchCalls: string[] = [];
globalThis.fetch = (async (input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  fetchCalls.push(url);
  return fetchHandler(url, init);
}) as typeof fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body: string, status = 200) => new Response(body, { status });

process.env.MODEL_CALLS_ENABLED = "true";
const { chatJson } = await import("../packages/backend/src/providers/llm.ts");
const { clearChatRoutes, registerInteractiveChatRoute, resetChatRoutes } = await import("../packages/backend/src/providers/chat-routes.ts");
const { NoFreeModelError, resetFreeGuard } = await import("../packages/backend/src/providers/free-models.ts");
const { BudgetExceededError, ProviderRejectedError } = await import("../packages/backend/src/providers/receipts.ts");
const { resetFreeChain } = await import("../packages/backend/src/providers/free-chain.ts");
const { closeDb, sql } = await import("../packages/backend/src/db.ts");

const digest = (n: string) => `${T}-${n}-${Math.random().toString(36).slice(2)}`;
const call = (n: string, purpose = "free_chain_test", schema = z.object({ ok: z.boolean() }), user?: string) =>
  chatJson({
    model: "default",
    purpose,
    subject: `fc:${digest(n)}`,
    promptVersion: "t1",
    system: "answer the question",
    user: user ?? `u ${digest(n)}`,
    schema,
  });

const opencodeInventory = (url: string): Response | null => {
  if (url === process.env.OPENCODE_MODELS_URL) return json({ data: [{ id: "deepseek-v4.1-flash-free" }] });
  if (url === process.env.OPENCODE_DOCS_URL) return text("Console models: deepseek-v4.1-flash-free");
  if (url === process.env.MODELS_DEV_URL) return json({ opencode: { models: { "deepseek-v4.1-flash-free": { cost: { input: 0, output: 0 } } } } });
  return null;
};

beforeEach(() => {
  resetFreeChain();
  resetFreeGuard();
  resetChatRoutes();
  clearChatRoutes();
  fetchCalls = [];
});

afterEach(() => {
  fetchHandler = async (url) => {
    throw new Error(`unexpected fetch ${url}`);
  };
  for (const name of MANAGED) delete process.env[name];
  for (const name of MANAGED) if (savedEnv[name] !== undefined) process.env[name] = savedEnv[name];
});

after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

test("an OpenCode free-tier refusal benches it; the same call is answered by Agnes and the next one skips OpenCode", async () => {
  setEnv({
    OPENCODE_API_KEY: "test-opencode-key",
    OPENCODE_BASE_URL: "https://opencode.test/v1",
    OPENCODE_MODELS_URL: "https://fake.test/opencode/models",
    OPENCODE_DOCS_URL: "https://fake.test/opencode/docs",
    MODELS_DEV_URL: "https://fake.test/models-dev",
    AGNES_API_KEY: "test-agnes-key",
    LLM_EXTRA_JSON: JSON.stringify({ reasoning: { effort: "low" } }),
  });
  const agnesBodies: Array<Record<string, unknown>> = [];
  let opencodeChats = 0;
  let agnesChats = 0;
  fetchHandler = async (url, init) => {
    const inventory = opencodeInventory(url);
    if (inventory) return inventory;
    if (url === "https://opencode.test/v1/chat/completions") {
      opencodeChats++;
      return json({ type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." } }, 403);
    }
    if (url === "https://apihub.agnes-ai.com/v1/chat/completions") {
      agnesChats++;
      agnesBodies.push(JSON.parse(String(init?.body)));
      return json({ id: `agnes-${agnesChats}`, model: "agnes-3.0-flash", choices: [{ message: { content: JSON.stringify({ ok: true }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const first = await call("first");
  assert.equal(first.data.ok, true);
  const second = await call("second");
  assert.equal(second.data.ok, true);
  assert.deepEqual([opencodeChats, agnesChats], [1, 2], "OpenCode was asked once, Agnes answered both calls");
  assert.equal(fetchCalls.filter((u) => u === "https://opencode.test/v1/chat/completions").length, 1, "no second OpenCode request");
  assert.deepEqual(agnesBodies[0]!.chat_template_kwargs, { enable_thinking: false }, "Agnes answers without reasoning");
  assert.equal(agnesBodies[0]!.reasoning, undefined, "OpenRouter's LLM_EXTRA_JSON is not sent to Agnes");
});

test("Agnes billing refusal with no OpenRouter fallback waits as NoFreeModelError", async () => {
  setEnv({ AGNES_API_KEY: "test-agnes-key" });
  fetchHandler = async (url) => {
    if (url === "https://apihub.agnes-ai.com/v1/chat/completions") {
      return json({ error: { message: "insufficient balance for this request" } }, 400);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await assert.rejects(
    call("billing"),
    (error: unknown) => error instanceof NoFreeModelError && error instanceof BudgetExceededError,
  );
});

test("interactive chat uses a registered route first, then falls back to the chain when its quota is spent", async () => {
  setEnv({ AGNES_API_KEY: "test-agnes-key" });
  const schema = z.object({ reply: z.string() });
  let routeHits = 0;
  let routeError: Error | null = null;
  registerInteractiveChatRoute({
    id: "test-free-chat",
    provider: "fake",
    service: "fake-chat",
    model: () => "fake-1",
    enabled: () => true,
    complete: async () => {
      routeHits++;
      if (routeError) throw routeError;
      return { text: JSON.stringify({ reply: "route" }), model: "fake-1", provider: "fake", usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  });
  let agnesChats = 0;
  fetchHandler = async (url) => {
    if (url === "https://apihub.agnes-ai.com/v1/chat/completions") {
      agnesChats++;
      return json({ id: `agnes-${agnesChats}`, model: "agnes-3.0-flash", choices: [{ message: { content: JSON.stringify({ reply: "agnes" }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const firstSubject = `fc:${digest("route")}`;
  const first = await chatJson({ model: "default", purpose: "project_assistant", subject: firstSubject, promptVersion: "t1", system: "s", user: `hello ${firstSubject}`, schema });
  assert.equal(first.data.reply, "route");
  const [firstReceipt] = await sql<{ service: string }[]>`SELECT service FROM receipts WHERE subject = ${firstSubject} ORDER BY id DESC LIMIT 1`;
  assert.equal(firstReceipt!.service, "fake-chat");

  routeError = new ProviderRejectedError("fake chat: quota", 402, false);
  const secondSubject = `fc:${digest("fallback")}`;
  const second = await chatJson({ model: "default", purpose: "project_assistant", subject: secondSubject, promptVersion: "t1", system: "s", user: `hello again ${secondSubject}`, schema });
  assert.equal(second.data.reply, "agnes");
  const [secondReceipt] = await sql<{ service: string }[]>`SELECT service FROM receipts WHERE subject = ${secondSubject} ORDER BY id DESC LIMIT 1`;
  assert.equal(secondReceipt!.service, "agnes");

  const hitsAfterFallback = routeHits;
  const third = await chatJson({ model: "default", purpose: "project_assistant", subject: `fc:${digest("again")}`, promptVersion: "t1", system: "s", user: `one more ${digest("again-u")}`, schema });
  assert.equal(third.data.reply, "agnes");
  assert.equal(routeHits, hitsAfterFallback, "the route stays benched for the next call");
});

test("a rate-limited Agnes makes the work wait seconds, not a day", async () => {
  setEnv({ AGNES_API_KEY: "test-agnes-key" });
  fetchHandler = async (url) => {
    if (url === "https://apihub.agnes-ai.com/v1/chat/completions") return new Response("rate limited", { status: 429, headers: { "retry-after": "7" } });
    throw new Error(`unexpected fetch ${url}`);
  };
  await assert.rejects(call("ratelimit"), (error: unknown) => error instanceof NoFreeModelError && error.retryAfterSeconds === 30);
  // While the route sits out, the next call waits the same short time without asking Agnes again.
  const before = fetchCalls.length;
  await assert.rejects(call("ratelimit-2"), (error: unknown) => error instanceof NoFreeModelError && error.retryAfterSeconds === 30);
  assert.equal(fetchCalls.length, before);
});
