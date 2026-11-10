// /api/health and the heartbeats report the running release: the package.json version (plus the
// short commit in a git checkout), or TOPKA_RELEASE when a deployment sets one. Never "dev".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, releaseName } from "@topka/backend/config";

const version = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version as string;

test("release is the package.json version, with the short commit when git is there", () => {
  delete process.env.TOPKA_RELEASE;
  delete process.env.TOPKA_RELEASE;
  const r = releaseName();
  assert.notEqual(r, "dev");
  assert.match(r, new RegExp(`^${version.replace(/\./g, "\\.")}(\\+[0-9a-f]{7,40})?$`));
  assert.equal(releaseName(), r, "stable across calls");
});

test("TOPKA_RELEASE wins when set", () => {
  process.env.TOPKA_RELEASE = "v9.9.9-test";
  try {
    assert.equal(releaseName(), "v9.9.9-test");
  } finally {
    delete process.env.TOPKA_RELEASE;
  }
  assert.match(releaseName(), new RegExp(`^${version.replace(/\./g, "\\.")}`));
});

test("/api/health reports that release", async () => {
  await import("./setup.ts");
  const { closeDb } = await import("@topka/backend/db");
  const { buildApp } = await import("../apps/api/src/app.ts");
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; release: string };
    assert.equal(body.ok, true);
    assert.equal(body.release, releaseName());
    assert.match(body.release, new RegExp(`^${version.replace(/\./g, "\\.")}`));
  } finally {
    await app.close();
    await closeDb();
  }
});
