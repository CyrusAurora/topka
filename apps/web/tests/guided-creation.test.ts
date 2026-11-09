// The guided creation wizard (master design J2 / handover §2.2, construction step 3): pack, sources,
// naming, confirm card and done screen, with the handover's copy locked verbatim. Repeated
// confirmation must create exactly one project. All network goes through an injected fetch stub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import {
  assemblePurpose,
  validateDraft,
  filterSourcesByRegion,
  GuidedCreation,
  PACKS_UNAVAILABLE,
  EMPTY_PACK_HINT,
  NAME_REQUIRED,
  GOAL_PURPOSE_REQUIRED,
  DONE_NOTICE,
} from "../app/features/projects/guided-creation.ts";
import { buttonByText, checkboxes, click, includes, mount, stubFetch, type, type StubAnswer, type StubHandler } from "./harness.ts";

const SOURCE_NAMES = ["通义千问博客", "DeepSeek 动态", "Kimi 更新", "豆包发布", "OpenAI 发布说明", "Anthropic 新闻", "DeepMind 博客", "Meta AI 博客",
  "魔搭社区更新", "Ollama Releases", "llama.cpp Releases", "vLLM Releases", "SGLang Releases", "Hugging Face 博客"];
const PACKS = [
  { id: "ai-models", label: "AI 模型跟踪", sources: SOURCE_NAMES.map((name, i) => ({ id: `rss:src-${i}`, name, publisher: "示例发布方" })) },
  { id: "embodied-ai", label: "具身智能与机器人", sources: [{ id: "rss:unitree", name: "宇树科技动态", publisher: "宇树科技" }] },
  { id: "opensource-dev", label: "开源与开发者", sources: [] },
  { id: "semiconductor", label: "半导体与算力", sources: [{ id: "rss:nvidia", name: "NVIDIA 新闻", publisher: "NVIDIA" }] },
];

function baseHandler(overrides: { packs?: unknown; prefs?: unknown; onPost?: () => StubAnswer | Promise<StubAnswer> } = {}): StubHandler {
  return (url, init) => {
    if (url === "/api/packs") return { body: { packs: overrides.packs ?? PACKS } };
    if (url === "/api/pack-prefs" && init?.method === "PUT") return { body: { packId: "x", picks: [] } };
    if (url === "/api/pack-prefs") return { body: { packId: null, picks: [] } };
    if (url === "/api/projects" && init?.method === "POST") {
      return overrides.onPost?.() ?? { status: 201, body: { project: { id: "project:a:b:c", target: "t", purpose: "p" } } };
    }
    return { status: 404, body: {} };
  };
}

async function renderWizard(fetchImpl: typeof fetch) {
  const page = await mount();
  await page.render(createElement(GuidedCreation, { fetchImpl }));
  return page;
}

test("the wizard walks pack, sources, naming, confirm and done in one pass", async () => {
  const stub = stubFetch(baseHandler());
  const page = await renderWizard(stub.fetch);

  assert.ok(includes(page.container, "AI 模型跟踪（14 个源）"), `pack buttons carry the label and source count: ${page.container.textContent}`);
  await click(buttonByText(page.container, "AI 模型跟踪（14 个源）"));

  assert.ok(includes(page.container, "第二步：AI 模型跟踪包盯这些来源，勾上重点看的"), page.container.textContent);
  assert.equal(checkboxes(page.container).length, 14, "the source list is the pack's static list, rendered without further requests");
  await click(checkboxes(page.container)[0]!);
  await click(checkboxes(page.container)[1]!);
  assert.equal(stub.count("/api/packs"), 1, "picking sources never talks to the network");
  await click(buttonByText(page.container, "就这些，下一步"));
  assert.equal(stub.count("/api/pack-prefs", "PUT"), 1, "the pack choice is saved as the user's preference");

  assert.ok(includes(page.container, "第三步：起个名就建好"), page.container.textContent);
  assert.ok(includes(page.container, "通义千问博客（示例发布方）；另有13个包内来源持续更新。"), page.container.textContent);
  await type(page.container.querySelector("input[type=text]")!, "国产大模型动向");
  await click(buttonByText(page.container, "预览确认"));

  assert.ok(includes(page.container, "AI 模型跟踪 · 创建确认"), page.container.textContent);
  assert.ok(includes(page.container, "核对一下，没问题就创建"), page.container.textContent);
  assert.ok(includes(page.container, "以下是我理解的跟踪方向，确认后开始跟踪："), page.container.textContent);
  assert.ok(includes(page.container, "跟踪AI 模型跟踪方向，重点看通义千问博客、DeepSeek 动态"), page.container.textContent);
  assert.ok(includes(page.container, "重点看通义千问博客、DeepSeek 动态"), "the source summary names the picks");

  assert.equal(stub.count("/api/projects", "POST"), 0, "nothing is created before the explicit confirmation");
  await click(buttonByText(page.container, "确认创建"));

  assert.ok(includes(page.container, "跟踪项目建好了"), page.container.textContent);
  assert.ok(includes(page.container, "国产大模型动向"), "the done screen shows the goal");
  assert.ok(includes(page.container, "跟踪AI 模型跟踪方向，重点看通义千问博客、DeepSeek 动态"), "the done screen shows the purpose");
  assert.ok(includes(page.container, DONE_NOTICE), page.container.textContent);

  const posts = stub.calls.filter((c) => c.url === "/api/projects" && c.init?.method === "POST");
  assert.equal(posts.length, 1, "exactly one creation request left the page");
  assert.deepEqual(JSON.parse(String(posts[0]!.init!.body)), {
    target: "国产大模型动向",
    purpose: "跟踪AI 模型跟踪方向，重点看通义千问博客、DeepSeek 动态",
    sourceIds: ["rss:src-0", "rss:src-1"],
  });
  await page.teardown();
});

test("an empty name falls back to the pack label, and a blank direction stops the wizard", async () => {
  const stub = stubFetch(baseHandler());
  const page = await renderWizard(stub.fetch);
  await click(buttonByText(page.container, "AI 模型跟踪（14 个源）"));
  await click(buttonByText(page.container, "就这些，下一步"));
  await click(buttonByText(page.container, "预览确认"));
  assert.ok(includes(page.container, "AI 模型跟踪 · 创建确认"), page.container.textContent);
  assert.ok(includes(page.container, "AI 模型跟踪方向"), "the target defaults to the pack label");
  await page.teardown();

  const blankLabel = [{ id: "blank", label: " ", sources: [] }];
  const stub2 = stubFetch(baseHandler({ packs: blankLabel }));
  const page2 = await renderWizard(stub2.fetch);
  await click(buttonByText(page2.container, "（0 个源）"));
  await click(buttonByText(page2.container, "就这些，下一步"));
  await click(buttonByText(page2.container, "预览确认"));
  assert.ok(includes(page2.container, NAME_REQUIRED), page2.container.textContent);
  assert.equal(stub2.count("/api/projects"), 0, "an invalid draft never reaches the api");
  await page2.teardown();
});

test("repeated confirmation while the request is in flight creates only once", async () => {
  let release!: (answer: StubAnswer) => void;
  const held = new Promise<StubAnswer>((resolve) => {
    release = resolve;
  });
  const stub = stubFetch(baseHandler({ onPost: () => held }));
  const page = await renderWizard(stub.fetch);
  await click(buttonByText(page.container, "AI 模型跟踪（14 个源）"));
  await click(buttonByText(page.container, "就这些，下一步"));
  await click(buttonByText(page.container, "预览确认"));
  const confirm = buttonByText(page.container, "确认创建");
  await click(confirm);
  assert.equal(confirm.disabled, true, "the confirm button disables itself while creating");
  await click(confirm);
  assert.equal(stub.count("/api/projects", "POST"), 1, "the in-flight request is never duplicated");
  release({ status: 201, body: { project: { id: "project:a:b:c", target: "t", purpose: "p" } } });
  await page.teardown();
});

test("a pack without sources says so and lets the user move on", async () => {
  const stub = stubFetch(baseHandler());
  const page = await renderWizard(stub.fetch);
  await click(buttonByText(page.container, "开源与开发者（0 个源）"));
  assert.ok(includes(page.container, EMPTY_PACK_HINT), page.container.textContent);
  await click(buttonByText(page.container, "就这些，下一步"));
  assert.ok(includes(page.container, "覆盖全部0个来源"), "with nothing picked, the purpose covers the whole pack");
  await page.teardown();
});

test("an unreadable pack catalog answers with the locked alert", async () => {
  const stub = stubFetch((url) => (url === "/api/packs" ? { status: 503, body: {} } : { body: {} }));
  const page = await renderWizard(stub.fetch);
  const alert = page.container.querySelector("[role=alert]");
  assert.ok(alert, "the failure renders as an alert");
  assert.equal(alert!.textContent, PACKS_UNAVAILABLE);
  await page.teardown();
});

test("the previous pack choice is offered back on the first step", async () => {
  const handler: StubHandler = (url, init) => {
    if (url === "/api/packs") return { body: { packs: PACKS } };
    if (url === "/api/pack-prefs" && init?.method === "PUT") return { body: { packId: "x", picks: [] } };
    if (url === "/api/pack-prefs") return { body: { packId: "embodied-ai", picks: [] } };
    return { status: 404, body: {} };
  };
  const stub = stubFetch(handler);
  const page = await renderWizard(stub.fetch);
  assert.ok(includes(page.container, "上次你选了具身智能与机器人包"), page.container.textContent);
  await click(buttonByText(page.container, "直接用上次的"));
  assert.ok(includes(page.container, "第二步：具身智能与机器人包盯这些来源，勾上重点看的"), page.container.textContent);
  await page.teardown();
});

test("purpose assembly follows the handover's pick rules", () => {
  const pack = PACKS[0]!;
  assert.equal(assemblePurpose(pack, []), "跟踪AI 模型跟踪方向，覆盖全部14个来源");
  assert.equal(assemblePurpose(pack, ["rss:src-0"]), "跟踪AI 模型跟踪方向，重点看通义千问博客");
  assert.equal(assemblePurpose(pack, ["rss:src-2", "rss:src-0", "rss:src-1"]), "跟踪AI 模型跟踪方向，重点看Kimi 更新、通义千问博客、DeepSeek 动态");
  const four = ["rss:src-0", "rss:src-1", "rss:src-2", "rss:src-3"];
  assert.equal(assemblePurpose(pack, four), "跟踪AI 模型跟踪方向，重点看通义千问博客、DeepSeek 动态、Kimi 更新等4个来源");
});

test("draft validation answers with the handover's refusal copy", () => {
  const pack = PACKS[0]!;
  assert.equal(validateDraft({ target: "", purpose: "", pack }), "goal-purpose");
  assert.equal(validateDraft({ target: "有目标", purpose: " ", pack }), "goal-purpose");
  assert.equal(validateDraft({ target: "", purpose: "有目的", pack: null }), "name", "without a pack there is no label to fall back on, so the name is required");
  assert.equal(validateDraft({ target: "名字", purpose: "有目的", pack }), null, "an empty name falls back to the pack label: nothing to refuse");
  assert.ok(GOAL_PURPOSE_REQUIRED.length > 0);
});

test("the region filter hides the wrong region and always keeps global", () => {
  const sources = [
    { id: "a", name: "A", publisher: null, regions: ["us"] },
    { id: "b", name: "B", publisher: null, regions: ["global"] },
    { id: "c", name: "C", publisher: null, regions: ["cn", "global"] },
    { id: "d", name: "D", publisher: null, regions: ["cn"] },
  ];
  assert.deepEqual(filterSourcesByRegion(sources, []).map((s) => s.id), ["a", "b", "c", "d"], "empty filter shows all");
  assert.deepEqual(filterSourcesByRegion(sources, ["cn"]).map((s) => s.id), ["b", "c", "d"], "filter cn hides {us} but keeps global and cn");
  assert.deepEqual(filterSourcesByRegion(sources, ["us"]).map((s) => s.id), ["a", "b", "c"], "filter us keeps {us}, {global} and {cn,global}");
});
