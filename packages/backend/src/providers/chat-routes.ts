// An extension point for interactive chat: a deployment can register a route (typically from a plugin)
// that answers the `default` model's interactive purposes before the configured provider chain. The
// route owns its transport; the core still records every call through the same receipt and budget path.
//
// A route may throw ProviderRejectedError to say it cannot take calls right now: 402 means the free
// quota is spent, 429 means busy, 504 a timeout and 502 anything else the transport failed on. The core
// benches the route (402 -> 6h, 429 -> 20s, else 300s) and falls back. ModelOutputError and
// BudgetExceededError also fall back; any other error is rethrown.

export interface ChatRouteMessage {
  role: string;
  content: string;
}

export interface ChatRouteCompleteInput {
  messages: ChatRouteMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface ChatRouteCompletion {
  text: string;
  model?: string;
  provider?: string;
  usage?: Record<string, unknown> | null;
}

export interface InteractiveChatRoute {
  /** Stable id: registering again with the same id replaces the route. */
  id: string;
  provider: string;
  service: string;
  /** Read at call time, so an environment change applies without a restart. */
  model(): string;
  /** Read at call time; false keeps the route out of the way without unregistering it. */
  enabled(): boolean;
  complete(input: ChatRouteCompleteInput): Promise<ChatRouteCompletion>;
}

const routes: InteractiveChatRoute[] = [];
const benched = new Map<string, { until: number; reason: string }>();

export function registerInteractiveChatRoute(route: InteractiveChatRoute): void {
  const at = routes.findIndex((r) => r.id === route.id);
  if (at >= 0) routes[at] = route;
  else routes.push(route);
}

/** Registered routes in priority order (first enabled route wins). */
export function interactiveChatRoutes(): readonly InteractiveChatRoute[] {
  return routes;
}

export function chatRouteBenched(id: string): boolean {
  const entry = benched.get(id);
  return !!entry && entry.until > Date.now();
}

export function benchChatRoute(id: string, seconds: number, reason: string): void {
  benched.set(id, { until: Date.now() + seconds * 1000, reason });
}

/** Forgets every bench; registered routes stay. */
export function resetChatRoutes(): void {
  benched.clear();
}

/** Removes every registered route (tests use this; plugins register again when loaded). */
export function clearChatRoutes(): void {
  routes.length = 0;
  benched.clear();
}
