// Loaded before every test file (--import in the test scripts). A test must behave the same on a
// laptop as on CI, so a variable a developer exported for the running app — a provider key, a switch
// like MODEL_CALLS_ENABLED=false, or one added tomorrow — may not reach it.
//
// The rule is therefore inverted: everything is dropped except the handful of names below, which the
// harness itself needs. Tests that need a setting pass it to the code under test directly. A one-off
// run can hand a variable through on purpose: HERMETIC_ENV_PASSTHROUGH=NAME,OTHER_NAME npm test.
const KEEP = new Set([
  "DATABASE_URL", // the throwaway database the suite writes to
  "PATH", "HOME", "TMPDIR", "SHELL", "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "DISPLAY",
  // node:test's own plumbing, and the browser the e2e flow launches. NODE_V8_COVERAGE travels with
  // every child process so `npm run test:coverage` sees the code the shutdown tests run in a child.
  "CI", "NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID", "NODE_USE_SYSTEM_CA", "NODE_V8_COVERAGE", "CHROME_PATH",
  // Ports the e2e flow listens on (defaults in e2e/flows.test.ts).
  "E2E_API_PORT", "E2E_WEB_PORT",
]);
const passthrough = process.env.HERMETIC_ENV_PASSTHROUGH ?? "";
for (const name of passthrough.split(",").map((s) => s.trim()).filter(Boolean)) KEEP.add(name);

for (const name of Object.keys(process.env)) if (!KEEP.has(name)) delete process.env[name];
