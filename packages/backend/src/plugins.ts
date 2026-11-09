// Loads optional plugins listed in TOPKA_PLUGINS (comma-separated module paths, relative to the
// process working directory or absolute). Each module must export a default function or `register`;
// it is called once, when the process starts. Unset or empty means no plugins, no work.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Register = () => void | Promise<void>;
interface PluginModule {
  default?: unknown;
  register?: unknown;
}

function registerOf(mod: PluginModule): Register | null {
  const fn = typeof mod.default === "function" ? mod.default : mod.register;
  return typeof fn === "function" ? (fn as Register) : null;
}

export async function loadPlugins(): Promise<void> {
  const raw = process.env.TOPKA_PLUGINS?.trim();
  if (!raw) return;
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const path = entry.startsWith("/") ? entry : resolve(process.cwd(), entry);
    try {
      const mod = (await import(pathToFileURL(path).href)) as PluginModule;
      const register = registerOf(mod);
      if (!register) {
        console.log(JSON.stringify({ level: "warn", msg: "plugin has no default export or register()", plugin: entry }));
        continue;
      }
      await register();
      console.log(JSON.stringify({ level: "info", msg: "plugin loaded", plugin: entry }));
    } catch (error) {
      console.log(JSON.stringify({ level: "error", msg: "plugin failed to load", plugin: entry, error: (error as Error).message }));
      throw error;
    }
  }
}
