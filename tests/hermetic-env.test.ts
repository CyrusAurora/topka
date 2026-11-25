// The isolation itself: a variable exported in the developer's shell — a provider key, a safety-valve
// switch, or one nobody has written yet — must not reach a test. Proven in a child process, because
// the current one loaded the module before this file ran.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const LOADER = "--import";
const LOADER_FILE = new URL("./hermetic-env.ts", import.meta.url).href;
/** Prints the value of the names it is given, so the assertion reads like the rule. */
const PROBE = `console.log(JSON.stringify(Object.fromEntries(process.argv.slice(1).map((n) => [n, process.env[n] ?? "unset"]))))`;

async function probe(names: string[], extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const { stdout } = await run(process.execPath, [LOADER, LOADER_FILE, "--input-type=module", "-e", PROBE, ...names], {
    env: { ...process.env, ...extra },
  });
  return JSON.parse(stdout.trim()) as Record<string, string>;
}

test("a provider key, a valve switch and an unknown setting from the shell never reach a test", async () => {
  const env = await probe(["LLM_API_KEY", "MODEL_CALLS_ENABLED", "COLLECT_ENABLED", "SOME_FUTURE_SETTING"], {
    LLM_API_KEY: "sk-from-the-shell",
    MODEL_CALLS_ENABLED: "false",
    COLLECT_ENABLED: "false",
    SOME_FUTURE_SETTING: "on",
  });
  assert.deepEqual(env, { LLM_API_KEY: "unset", MODEL_CALLS_ENABLED: "unset", COLLECT_ENABLED: "unset", SOME_FUTURE_SETTING: "unset" });
});

test("the database URL and the process plumbing survive", async () => {
  const env = await probe(["DATABASE_URL", "PATH", "HOME"], { DATABASE_URL: "postgres://x@127.0.0.1:5432/probe_test" });
  assert.equal(env.DATABASE_URL, "postgres://x@127.0.0.1:5432/probe_test");
  assert.notEqual(env.PATH, "unset");
  assert.notEqual(env.HOME, "unset");
});

test("node's own coverage plumbing reaches the child processes", async () => {
  // `npm run test:coverage` measures the code the shutdown tests run in a spawned worker through
  // NODE_V8_COVERAGE. Dropping it did not just lose detail: coverage fell from 85.3% to 84.9% and
  // the gate, at 85%, failed on CI.
  const env = await probe(["NODE_V8_COVERAGE"], { NODE_V8_COVERAGE: "/tmp/node-coverage-probe" });
  assert.equal(env.NODE_V8_COVERAGE, "/tmp/node-coverage-probe");
});

test("a one-off run can name a variable to hand through", async () => {
  const env = await probe(["MODEL_CALLS_ENABLED"], { MODEL_CALLS_ENABLED: "false", HERMETIC_ENV_PASSTHROUGH: "MODEL_CALLS_ENABLED" });
  assert.equal(env.MODEL_CALLS_ENABLED, "false");
});
