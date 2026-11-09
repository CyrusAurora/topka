// The project overview (master design 2.2, construction step 3): the empty state invites the first
// project, the list shows name and summary per project, and a signed-out visitor is told to sign in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { ProjectsOverview, OVERVIEW_EMPTY, CREATE_FIRST } from "../app/features/projects/overview.ts";
import { includes, mount, stubFetch } from "./harness.ts";

async function renderOverview(handler: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(handler);
  const page = await mount();
  await page.render(createElement(ProjectsOverview, { fetchImpl: stub.fetch }));
  return { stub, page };
}

test("the empty overview invites the first project", async () => {
  const { page } = await renderOverview((url) => (url === "/api/projects" ? { body: { projects: [] } } : { body: {} }));
  assert.ok(includes(page.container, OVERVIEW_EMPTY), page.container.textContent);
  const create = [...page.container.querySelectorAll("a")].find((a) => (a.textContent ?? "").trim() === CREATE_FIRST);
  assert.ok(create, "the create-first call to action exists");
  assert.equal(create!.getAttribute("href"), "/projects/new");
  await page.teardown();
});

test("the overview lists the caller's projects as name plus summary", async () => {
  const projects = [
    { id: "project:aa:bb:cccccccc", target: "AI 模型跟踪", purpose: "跟踪发布和价格", status: "active", currentRevision: 1 },
    { id: "project:cc:dd:dddddddd", target: "开源与开发者", purpose: "盯 release", status: "active", currentRevision: 3 },
  ];
  const { page } = await renderOverview((url) => (url === "/api/projects" ? { body: { projects } } : { body: {} }));
  for (const p of projects) {
    assert.ok(includes(page.container, p.target), `the name shows: ${p.target}`);
    assert.ok(includes(page.container, p.purpose), `the summary shows: ${p.purpose}`);
  }
  await page.teardown();
});

test("a signed-out visitor is asked to sign in, and a failure says so honestly", async () => {
  const { page } = await renderOverview((url) => (url === "/api/projects" ? { status: 401, body: {} } : { body: {} }));
  assert.ok(includes(page.container, "请先登录"), page.container.textContent);
  const signIn = [...page.container.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/login");
  assert.ok(signIn, "the sign-in way out exists");
  await page.teardown();

  const failed = await renderOverview(() => ({ status: 503, body: {} }));
  assert.ok(includes(failed.page.container, "暂时打不开项目列表"), failed.page.container.textContent);
  await failed.page.teardown();
});
