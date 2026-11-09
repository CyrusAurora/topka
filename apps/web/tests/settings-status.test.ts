// 设置 shows who really answers the reader's chat (/api/me/model-status), not whether keys can be stored.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, act } from "react";
import { SettingsPage, SETTINGS_COPY, chatModelLine, type SettingsModelStatus } from "../app/features/settings/settings.ts";
import { includes, mount, stubFetch } from "./harness.ts";

const st = (o: Partial<SettingsModelStatus>): SettingsModelStatus => ({
  chat: "none", reason: "not-configured", byokAvailable: true,
  userKey: { stored: false, usable: false, problem: null, last4: null }, ...o,
});

test("chatModelLine follows the real availability", () => {
  assert.equal(chatModelLine(null).text, SETTINGS_COPY.modelUnknown);
  assert.equal(chatModelLine(st({ chat: "instance", reason: null })).text, SETTINGS_COPY.modelInstance);
  assert.equal(chatModelLine(st({ chat: "user-key", reason: null, userKey: { stored: true, usable: true, problem: null, last4: "abcd" } })).text, `${SETTINGS_COPY.modelUser}（…abcd）`);
  assert.equal(chatModelLine(st({ reason: "model-calls-off" })).text, SETTINGS_COPY.modelOff);
  assert.equal(chatModelLine(st({})).text, SETTINGS_COPY.modelNoneByok);
  assert.equal(chatModelLine(st({ byokAvailable: false })).text, SETTINGS_COPY.modelNone);
});

async function renderWith(status: unknown, keysBody: unknown = { keys: [], encryptionConfigured: true }) {
  const stub = stubFetch((url) => {
    if (url === "/api/auth/me") return { body: { user: { email: "a@example.com" } } };
    if (url === "/api/me/keys") return { body: keysBody };
    if (url === "/api/me/model-status") return status === 500 ? { status: 500, body: {} } : { body: status };
    if (url === "/api/projects") return { body: { projects: [] } };
    return { status: 404, body: {} };
  });
  const page = await mount();
  await page.render(createElement(SettingsPage, { fetchImpl: stub.fetch }));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return page;
}

test("settings shows no usable model even though keys can be stored", async () => {
  const page = await renderWith(st({}));
  const line = page.container.querySelector("[data-testid=chat-model-status]");
  assert.equal(line?.textContent, SETTINGS_COPY.modelNoneByok);
  assert.ok(page.container.querySelector("#model-key"), "the 设置 anchor the chat links to");
  await page.teardown();
});

test("settings flags a stored key the chat cannot use (no base URL)", async () => {
  const page = await renderWith(st({ chat: "instance", reason: null, userKey: { stored: true, usable: false, problem: "missing-base-url", last4: "wxyz" } }),
    { keys: [{ provider: "openai", baseUrl: null, model: null, last4: "wxyz" }], encryptionConfigured: true });
  assert.ok(includes(page.container, SETTINGS_COPY.keyMissingBase));
  assert.equal(page.container.querySelector("[data-testid=chat-model-status]")?.textContent, SETTINGS_COPY.modelInstance);
  await page.teardown();
});

test("an unreadable status says so instead of claiming availability", async () => {
  const page = await renderWith(500);
  assert.equal(page.container.querySelector("[data-testid=chat-model-status]")?.textContent, SETTINGS_COPY.modelUnknown);
  await page.teardown();
});

test("the reminder feed: generate shows the URL once, rotate replaces it, disable turns it off", async () => {
  let n = 0;
  const { buttonByText, click } = await import("./harness.ts");
  const stub = stubFetch((url, init) => {
    if (url === "/api/auth/me") return { body: { user: { email: "a@example.com" } } };
    if (url === "/api/me/keys") return { body: { keys: [], encryptionConfigured: true } };
    if (url === "/api/me/model-status") return { body: st({ chat: "instance", reason: null }) };
    if (url === "/api/projects") return { body: { projects: [] } };
    if (url === "/api/me/issue-feed" && init?.method === "POST") return { body: { enabled: true, url: `https://example.test/feed/issue/tok${++n}.xml` } };
    if (url === "/api/me/issue-feed" && init?.method === "DELETE") return { body: { enabled: false } };
    if (url === "/api/me/issue-feed") return { body: { enabled: false } };
    return { status: 404, body: {} };
  });
  const page = await mount();
  await page.render(createElement(SettingsPage, { fetchImpl: stub.fetch }));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  assert.equal(page.container.querySelector("[data-testid=feed-state]")?.textContent, SETTINGS_COPY.feedOff);
  await click(buttonByText(page.container, SETTINGS_COPY.feedEnable));
  assert.equal((page.container.querySelector("[data-testid=feed-url]") as HTMLInputElement).value, "https://example.test/feed/issue/tok1.xml");
  assert.ok(includes(page.container, SETTINGS_COPY.feedOnce));
  await click(buttonByText(page.container, SETTINGS_COPY.feedRotate));
  assert.equal((page.container.querySelector("[data-testid=feed-url]") as HTMLInputElement).value, "https://example.test/feed/issue/tok2.xml");
  await click(buttonByText(page.container, SETTINGS_COPY.feedDisable));
  assert.equal(page.container.querySelector("[data-testid=feed-url]"), null);
  assert.equal(page.container.querySelector("[data-testid=feed-state]")?.textContent, SETTINGS_COPY.feedOff);
  await page.teardown();
});
