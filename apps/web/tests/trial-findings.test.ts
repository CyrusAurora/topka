// The newcomer trial of 2026-11-10, web side: each UI finding reproduced with the shipped data (the
// real pack files from database/seeds/packs). F1 an unavailable pack says why and how to fix it; F2
// the Chat gate links the model docs, the demo model is labelled; F5 the English UI shows no Chinese
// on these pages (a quoted data keyword aside) and the project page's numbers agree; F6 the reminder
// names the reader's own time zone; a project that cannot fill says which switch is off.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { act, createElement, type ReactElement } from "react";
import { LocaleProvider, messages, type UiLocale } from "../app/lib/i18n.ts";
import { CJK } from "./cjk-scan.ts";
import { GuidedCreation } from "../app/features/projects/guided-creation.ts";
import { TodayPage, sourcesNotice } from "../app/features/today/today-view.ts";
import { ChatPage } from "../app/features/chat/chat.ts";
import { SettingsPage } from "../app/features/settings/settings.ts";
import { MagazineToday } from "../app/features/magazine/today.ts";
import { MODEL_DOC_URL, SOURCES_DOC_URL } from "../app/lib/docs-links.ts";
import { buttonByText, click, mount, stubFetch, type StubHandler } from "./harness.ts";

const PACK_DIR = join(import.meta.dirname, "../../../database/seeds/packs");
interface PackFile { id: string; packId?: string; label?: string; labelEn?: string; sources: Array<{ id: string; name: string; publisher?: string; regions?: string[] }> }
const PACKS = readdirSync(PACK_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => {
  const p = JSON.parse(readFileSync(join(PACK_DIR, f), "utf8")) as PackFile;
  return {
    id: p.packId ?? p.id, label: p.label ?? p.id, labelEn: p.labelEn ?? null, available: true, reason: null,
    sources: p.sources.map((s) => ({ id: s.id, name: s.name, publisher: s.publisher ?? null, regions: s.regions ?? ["global"] })),
  };
});

async function render(node: ReactElement, locale: UiLocale = "en", timeZone = "America/New_York") {
  const page = await mount();
  await page.render(createElement(LocaleProvider, { locale, timeZone }, node));
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return page;
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
/** Chinese on the page, leaving out a quoted data keyword ("量产") and the language switch's own name. */
function chinese(root: HTMLElement): string[] {
  const text = (root.textContent ?? "").replaceAll(messages("en").settings.localeZh, "").replace(/"[^"]*"/g, '""');
  const hits: string[] = [];
  if (CJK.test(text)) hits.push(text.slice(Math.max(0, text.search(CJK) - 40), text.search(CJK) + 40));
  for (const el of root.querySelectorAll("[placeholder],[aria-label],[title],input[value]")) {
    for (const a of ["placeholder", "aria-label", "title", "value"]) {
      const v = el.getAttribute(a);
      if (v && CJK.test(v)) hits.push(`${el.tagName.toLowerCase()}[${a}]: ${v}`);
    }
  }
  return hits;
}

function wizardHandler(packs: unknown[], instance?: unknown): StubHandler {
  return (url, init) => {
    if (url.startsWith("/api/packs")) return { body: { packs, ...(instance ? { instance } : {}) } };
    if (url === "/api/pack-prefs" && init?.method === "PUT") return { body: {} };
    if (url === "/api/pack-prefs") return { body: { packId: null, picks: [] } };
    if (url === "/api/projects" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { target: string; purpose: string };
      return { status: 201, body: { project: { id: "p-new", target: body.target, purpose: body.purpose }, created: true } };
    }
    return { status: 404, body: {} };
  };
}

test("F5 the wizard with the shipped packs is English end to end: pack names, sources, name, purpose", async () => {
  assert.equal(PACKS.length, 4);
  const posts: string[] = [];
  const handler = wizardHandler(PACKS, { collectionOn: true, analysisOn: true });
  const page = await render(createElement(GuidedCreation, { fetchImpl: stubFetch((url, init) => { if (init?.method === "POST") posts.push(String(init.body)); return handler(url, init); }).fetch }));
  try {
    const root = page.container;
    assert.deepEqual(chinese(root), [], "pack list");
    for (const p of PACKS) assert.ok((root.textContent ?? "").includes(p.labelEn!), `shows ${p.labelEn}`);
    await click(buttonByText(root, `${PACKS.find((p) => p.id === "embodied-ai")!.labelEn} (18 sources)`));
    assert.deepEqual(chinese(root), [], "sources step");
    await click(buttonByText(root, "That's all, next"));
    assert.deepEqual(chinese(root), [], "naming step");
    await click(buttonByText(root, "Preview"));
    assert.deepEqual(chinese(root), [], "confirm step");
    await click(buttonByText(root, "Confirm creation"));
    await settle();
    assert.deepEqual(chinese(root), [], "done step");
    const sent = JSON.parse(posts.at(-1)!) as { target: string; purpose: string };
    assert.doesNotMatch(`${sent.target} ${sent.purpose}`, CJK, "the stored project description is English too");
    assert.match(root.textContent ?? "", /every 15 minutes for the busiest/);
  } finally {
    await page.teardown();
  }
});

test("F1 an unavailable pack says why and gives the command; region-empty says to widen the filter", async () => {
  const packs = [
    { ...PACKS[0]!, available: false, reason: "not-imported" },
    { ...PACKS[1]!, available: false, reason: "region-empty" },
    PACKS[2],
  ];
  for (const locale of ["en", "zh-CN"] as const) {
    const page = await render(createElement(GuidedCreation, { fetchImpl: stubFetch(wizardHandler(packs)).fetch }), locale);
    try {
      const t = messages(locale).projects.wizard;
      const boxes = [...page.container.querySelectorAll("[data-pack-unavailable]")];
      assert.equal(boxes.length, 2);
      assert.ok(boxes[0]!.textContent!.includes(t.unavailableNotImported));
      assert.ok(boxes[0]!.textContent!.includes(`npm run sources:seed -- --pack ${PACKS[0]!.id}`));
      assert.ok(boxes[1]!.textContent!.includes(t.unavailableRegion));
      if (locale === "en") assert.deepEqual(chinese(page.container), []);
    } finally {
      await page.teardown();
    }
  }
});

test("F6 the wizard warns when collection or a model is off, with links to the docs", async () => {
  const page = await render(createElement(GuidedCreation, { fetchImpl: stubFetch(wizardHandler(PACKS, { collectionOn: false, analysisOn: false })).fetch }));
  try {
    const root = page.container;
    await click(buttonByText(root, `${PACKS[0]!.labelEn} (${PACKS[0]!.sources.length} sources)`));
    await click(buttonByText(root, "That's all, next"));
    await click(buttonByText(root, "Preview"));
    const note = root.querySelector("[data-wizard-setup]");
    assert.ok(note, "the confirm step says what is off");
    const t = messages("en").projects.wizard;
    assert.ok(note!.textContent!.includes(t.setupCollectionOff) && note!.textContent!.includes(t.setupAnalysisOff));
    const hrefs = [...note!.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    assert.deepEqual(hrefs, [SOURCES_DOC_URL, MODEL_DOC_URL]);
    assert.deepEqual(chinese(root), []);
  } finally {
    await page.teardown();
  }
});

const projectToday = (sources: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  kind: "project-today",
  project: { id: "project:x", slug: "pabc", target: "Embodied AI & robotics", purpose: "Track Embodied AI & robotics across its 18 sources" },
  window: { since: "2026-11-09T13:22:00.000Z", until: "2026-11-10T13:22:00.000Z", basis: "default" },
  checkpoint: { readThrough: null }, sources, cardCount: 3, quietDay: true,
  result: "no-important-change", emptyState: { title: "无重要变化", detail: "……" }, items: [], awaitingAnalysis: 0, notice: "",
  ...extra,
});

test("F5 the project page's numbers agree: linked and switched-on sources, and which window it shows", async () => {
  const page = await render(createElement(TodayPage, { projectId: "pabc", fetchImpl: stubFetch(() => ({ body: projectToday({ linked: 18, active: 0, scheduled: 0, collectionOn: true, analysisOn: true }) })).fetch }));
  try {
    const line = page.container.querySelector("[data-sources-line]")!.textContent!;
    assert.match(line, /^18 sources linked · 0 switched on · updates from the last 24 hours/);
    assert.doesNotMatch(page.container.textContent ?? "", /covering all 18 sources · 0 sources/);
    assert.match(page.container.textContent ?? "", /important-update bar in the last 24 hours/, "the empty state names the same window");
    assert.doesNotMatch(page.container.textContent ?? "", /since you last read/);
    assert.deepEqual(chinese(page.container), []);
    const notice = page.container.querySelector("[data-sources-notice]");
    assert.ok(notice && /18 sources are switched off/.test(notice.textContent!), notice?.textContent ?? "no notice");
  } finally {
    await page.teardown();
  }
});

test("F6 a project page says when collection or analysis is off; the demo project (imported sources) needs neither", () => {
  const html = (el: ReactElement | null) => (el ? JSON.stringify(el.props) : "");
  const off = sourcesNotice({ linked: 2, active: 2, scheduled: 2, collectionOn: false, analysisOn: false }, "en");
  assert.ok(off);
  assert.match(html(off), /COLLECT_ENABLED=false/);
  assert.match(html(off), /No model is connected/);
  const demo = sourcesNotice({ linked: 3, active: 3, scheduled: 0, collectionOn: false, analysisOn: false }, "en");
  assert.equal(demo, null, "external demo sources are neither fetched nor analysed");
  assert.equal(sourcesNotice({ linked: 2, active: 2, scheduled: 2, collectionOn: true, analysisOn: true }, "en"), null);
});

function chatHandler(status: unknown): StubHandler {
  return (url, init) => {
    if (url.startsWith("/api/me/chat") && (!init?.method || init.method === "GET")) return { body: { messages: [] } };
    if (url === "/api/me/model-status") return { body: status };
    if (url === "/api/projects") return { body: { projects: [] } };
    return { status: 404, body: {} };
  };
}

test("F2 with no model the Chat gate links the model docs; with the demo model a banner says so", async () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const gate = await render(createElement(ChatPage, { fetchImpl: stubFetch(chatHandler({ chat: "none", reason: "model-calls-off", byokAvailable: false })).fetch }), locale);
    try {
      const link = gate.container.querySelector("[data-model-docs]");
      assert.ok(link, `${locale}: docs link in the gate`);
      assert.equal(link!.getAttribute("href"), MODEL_DOC_URL);
      assert.equal(gate.container.querySelector("[data-demo-model]"), null);
    } finally {
      await gate.teardown();
    }
    const demo = await render(createElement(ChatPage, { fetchImpl: stubFetch(chatHandler({ chat: "instance", reason: null, byokAvailable: false, instance: { available: true, reason: null, via: "demo" } })).fetch }), locale);
    try {
      const banner = demo.container.querySelector("[data-demo-model]");
      assert.ok(banner, `${locale}: demo banner`);
      assert.ok(!(demo.container.querySelector("input") as HTMLInputElement).disabled, "the input is open");
      if (locale === "en") assert.deepEqual(chinese(demo.container), []);
    } finally {
      await demo.teardown();
    }
  }
});

test("F6 the reminder names the reader's chosen time zone, not the browser's or Taipei", async () => {
  const handler: StubHandler = (url) => {
    if (url === "/api/auth/me") return { body: { user: { email: "a@example.com", locale: "zh-CN", timezone: "Asia/Shanghai" } } };
    if (url === "/api/me/keys") return { body: { keys: [], encryptionConfigured: true } };
    if (url === "/api/me/model-status") return { body: { chat: "none", reason: "not-configured", byokAvailable: true, userKey: { stored: false, usable: false, problem: null, last4: null } } };
    if (url === "/api/projects") return { body: { projects: [] } };
    if (url === "/api/me/feed") return { body: { enabled: false } };
    return { status: 404, body: {} };
  };
  const page = await render(createElement(SettingsPage, { fetchImpl: stubFetch(handler).fetch }), "zh-CN", "Asia/Taipei");
  try {
    const lead = page.container.querySelector("[data-feed-lead]")!.textContent!;
    assert.match(lead, /Asia\/Shanghai/);
    assert.doesNotMatch(lead, /台北/);
  } finally {
    await page.teardown();
  }
});

test("F5 'Stop seeing \"量产\"': the data keyword stays quoted, the words around it are English", async () => {
  const item = (n: number) => ({
    id: `a${n}`, position: n, title_a: `Lab ships model ${n}`, title_b: "", core_a: "Faster", core_b: "", summary: `Summary ${n}`, tag: "量产",
    source: "The Decoder", url: `https://example.org/${n}`, score: 80, project: { id: "p1", slug: "models", target: "Robots" },
    publishedAt: "2026-10-26T12:00:00.000Z", listedAt: "2026-10-27T00:00:00.000Z", hasCopy: true, overBudget: false,
  });
  const body = { projects: [{ id: "p1", slug: "models", target: "Robots" }], issue: { date: "2026-10-27", no: 3, fixedAt: "2026-10-27T00:00:00.000Z", hero: true, ready: true, items: [item(1), item(2), item(3)] }, opened: [], archive: [], notice: "" };
  const page = await render(createElement(MagazineToday, { fetchImpl: stubFetch(() => ({ body })).fetch }));
  try {
    const row = page.container.querySelector('[aria-expanded="false"]');
    assert.ok(row, "a card to expand");
    await click(row!);
    const mute = [...page.container.querySelectorAll("a.m-mute")].map((a) => a.textContent);
    assert.deepEqual(mute, ['Stop seeing "量产"']);
    assert.deepEqual(chinese(page.container), [], "only the quoted keyword is Chinese");
  } finally {
    await page.teardown();
  }
});
