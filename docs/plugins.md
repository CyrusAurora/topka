# Plugins

A plugin is a local ES module that runs when the API, the worker or a chat-capable script starts.
Plugins are optional: without `TOPKA_PLUGINS` the core is complete and makes no external calls
beyond the providers you configured.

Plugins are trusted code. They run in the same process as the server, can read every environment
variable and can register routes that spend model budget. Only load modules you control; there is no
sandbox, no signature check and no remote loader.

## Loading

```bash
TOPKA_PLUGINS=./plugins/example.ts,./plugins/audit.ts
```

- Comma-separated module paths, relative to the process working directory (or absolute).
- Each module is imported dynamically; a path may be `.ts` on Node.js 24 or a built `.js`.
- The loader calls the module's default export when it is a function, otherwise its `register`
  function, exactly once per process. Neither is present: a warning is logged and loading continues.
- A module that throws stops startup with that error, so a broken plugin cannot be ignored silently.
- The API, the worker and scripts are separate processes; each loads the list and registers its own
  routes. Nothing is shared across processes.

## Route contract

`registerInteractiveChatRoute` adds a route for **interactive** calls on the `default` model. The
first enabled route that is not benched answers the call. Background work (collection, scoring,
grouping, reports) never uses plugin routes.

```ts
import { registerInteractiveChatRoute } from "@topka/backend/providers/chat-routes";
import { ProviderRejectedError } from "@topka/backend/providers/receipts";

export default function register() {
  registerInteractiveChatRoute({
    id: "my-chat",
    provider: "my-provider",
    service: "my-service",
    model: () => process.env.MY_CHAT_MODEL ?? "my-model",
    enabled: () => !!process.env.MY_CHAT_URL,
    async complete({ messages, temperature, maxTokens, timeoutMs }) {
      const res = await fetch(process.env.MY_CHAT_URL!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.MY_CHAT_MODEL, messages, temperature, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 402) throw new ProviderRejectedError("quota used up", 402);
      if (res.status === 429) throw new ProviderRejectedError("busy", 429);
      if (res.status === 504) throw new ProviderRejectedError("timeout", 504);
      if (!res.ok) throw new ProviderRejectedError(`HTTP ${res.status}`, 502);
      const body = await res.json();
      return { text: body.choices[0].message.content, model: body.model };
    },
  });
}
```

Fields:

| Field | Description |
| --- | --- |
| `id` | Stable identifier. Registering the same id again replaces the route. |
| `provider` | Provider name written to the model receipt. |
| `service` | Service name written to the model receipt. |
| `model()` | Model name, read at call time so an environment change needs no restart. |
| `enabled()` | Read at call time; return `false` to keep the route registered but out of the way. |
| `complete(input)` | Performs one non-streaming completion and returns `{ text, model?, provider?, usage? }`. |

`input` contains `messages` (`role`/`content`), `temperature`, `maxTokens` and `timeoutMs`. Return
`text` even when the provider's response is JSON-wrapped; the core parses and validates it like any
other route.

## Failures and fallback

Throw `ProviderRejectedError(message, status)` when the route cannot take the call:

| Status | Meaning | Bench |
| --- | --- | --- |
| `402` | Free quota spent | 6 hours |
| `429` | Busy / rate limited | 20 seconds |
| `504` | Timeout | 5 minutes |
| `502` or any other | Transport failure | 5 minutes |

After a rejection the core benches the route and falls back to the next enabled route. Unusable model
output (`ModelOutputError`) and an exhausted budget (`BudgetExceededError`) also fall back. Any other
error is rethrown, which usually fails the request — do not wrap programming errors as rejections.

## Budgets and receipts

Every call through a plugin route goes through the same model receipt and budget circuit breaker as a
built-in route. A plugin cannot bypass `MODEL_CALLS_ENABLED`, the daily reserve or the per-user key
path:

- A signed-in user's own model key always wins over plugin routes.
- `MODEL_CALLS_ENABLED=false` disables plugin routes too.
- Receipts record the route's `provider` and `service`, so usage stays auditable.

Keep `complete()` side-effect free apart from the model call; retries are handled by the core's
fallback path, not by the plugin.

## Testing

Tests can register a fake route directly without a plugin file:

```ts
import { resetChatRoutes, clearChatRoutes } from "@topka/backend/providers/chat-routes";

resetChatRoutes();   // forget benches
clearChatRoutes();   // remove routes registered by earlier tests
```

Register the fake route in the test, then call the normal chat entry point. Reset the route
registry after the test so another test's plugin does not leak into it.
