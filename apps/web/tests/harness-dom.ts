// The DOM environment for the component tests. This module must be evaluated BEFORE react-dom is
// imported anywhere in the process: React captures `canUseDOM` at module load, and without a window
// it falls back to an old change-event polyfill that never fires onChange in jsdom.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
// Node ships its own read-only global navigator; components under test do not need it.
globals.Event = dom.window.Event;
globals.MouseEvent = dom.window.MouseEvent;
globals.KeyboardEvent = dom.window.KeyboardEvent;
globals.HTMLInputElement = dom.window.HTMLInputElement;

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// React tracks input values with a node-level wrapper around the native value property. The wrapper
// is installed when a controlled input mounts; keep the untouched native setter so tests can change
// the value without React mistaking it for no change.
export const nativeInputSetter =
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;

export { dom };
