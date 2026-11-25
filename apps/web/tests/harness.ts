// jsdom + React act harness for the component tests under node --test. Node cannot load .tsx (no JSX
// transform), so the components under test are createElement factories in plain .ts modules and the
// .tsx route files stay thin shells around them.
import "./harness-dom.ts"; // must come first: installs the DOM globals React captures at load time
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dom, nativeInputSetter } from "./harness-dom.ts";

export interface Mounted {
  container: HTMLElement;
  render(node: ReactElement): Promise<void>;
  teardown(): Promise<void>;
}

export async function mount(): Promise<Mounted> {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  let root: Root | null = null;
  return {
    container,
    async render(node: ReactElement) {
      await act(async () => {
        root ??= createRoot(container);
        root.render(node);
      });
    },
    async teardown() {
      await act(async () => root?.unmount());
      container.remove();
    },
  };
}

/** React's event system listens on the root container: dispatch a bubbling DOM event. */
export async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Sets an input's value through the native setter so React's onChange sees it. */
export async function type(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    nativeInputSetter?.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

export function buttonByText(scope: HTMLElement, text: string): HTMLButtonElement {
  const hit = [...scope.querySelectorAll("button, a")].find((el) => (el.textContent ?? "").trim() === text);
  if (!hit) throw new Error(`no button or link reading exactly "${text}"`);
  return hit as HTMLButtonElement;
}

export function includes(scope: HTMLElement, fragment: string): boolean {
  return (scope.textContent ?? "").includes(fragment);
}

export function checkboxes(scope: HTMLElement): HTMLInputElement[] {
  return [...scope.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
}

export interface StubAnswer {
  status?: number;
  body?: unknown;
}
export type StubHandler = (url: string, init: RequestInit | undefined) => StubAnswer | Promise<StubAnswer>;
export interface FetchStub {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  count(url: string, method?: string): number;
}

/** A fetch stand-in recording every call; answers come from the test's handler. */
export function stubFetch(handler: StubHandler): FetchStub {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const answer = await handler(url, init);
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer.body,
    } as Response;
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    calls,
    count(url: string, method?: string) {
      return calls.filter((c) => c.url === url && (method === undefined || c.init?.method === method)).length;
    },
  };
}
