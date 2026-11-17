// Offline demo seed: fills a fresh database with a finished 今日 (three cards) and two earlier days for
// 往期, so a first run shows real-looking content before any collection or model call. Every source,
// headline and summary below is invented example data (example.org URLs, names marked 示例); nothing is
// fetched and no model is called.
//
//   node --env-file=.env scripts/demo.ts                 seed now (prints the demo login)
//   node --env-file=.env scripts/demo.ts --if-enabled    seed only when DEMO_SEED=true, else exit 0 quietly
//                                                        (what the docker compose `setup` service runs)
//   node --env-file=.env scripts/demo.ts --force         seed even though the database has other content
//   docker compose exec api npm run demo:seed
//
// The demo reader is demo@example.com. Its password is DEMO_PASSWORD when set, otherwise a random one
// printed once when the account is created. A re-run leaves the password alone unless DEMO_PASSWORD is
// set, in which case it is reset to that value. In docker compose the containers read .env only when
// they are (re)created, so after adding DEMO_PASSWORD run `docker compose up -d` first, or pass it to
// this one run: `docker compose exec -e DEMO_PASSWORD=… api npm run demo:seed`.
//
// Language: the stories are written in Chinese, or in English when SITE_LOCALE=en (the site's content
// language). The demo sources are `external` rows (items arrive by import, nothing is ever fetched)
// and switched on, so the demo project's own page shows the same stories as 今日.
//
// Safety rule: a first seed refuses (exit 1) when the database holds anything that is not the demo's own:
// a user other than demo@example.com, or an article from a source that is not a demo source. --force
// overrides this (the demo rows are then added next to the existing ones; nothing is deleted). Once the
// demo reader exists the check is skipped: a re-run only refreshes the demo's own rows, so DEMO_SEED=true
// can stay in .env after real sources are switched on. With --if-enabled a refusal is reported and exits
// 0, so it never stops the stack from starting.
//
// Idempotent: sources, articles, publications and card copy are upserted by fixed ids/URLs; the account
// and the project are reused when they exist; the issues are only written when the demo reader has none
// yet, so a re-run (even on a later day) never duplicates or reorders them.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { closeDb, sql } from "@topka/backend/db";
import { registerWithInvite } from "@topka/backend/accounts/register";
import { hashPassword } from "@topka/backend/accounts/password";
import { upsertMaterial } from "@topka/backend/content/materials";
import { createProject } from "@topka/backend/projects/create-project";
import { bindProjectSources } from "@topka/backend/projects/bind-sources";
import { currentIssueDate, issueCutoff } from "@topka/backend/projects/issue-rules";

export const DEMO_EMAIL = "demo@example.com";

const { values } = parseArgs({ args: process.argv.slice(2), options: { force: { type: "boolean" }, "if-enabled": { type: "boolean" } }, strict: true });

if (values["if-enabled"] && (process.env.DEMO_SEED ?? "").trim().toLowerCase() !== "true") process.exit(0);

const EN = (process.env.SITE_LOCALE ?? "").trim().toLowerCase().startsWith("en");

const SOURCES = [
  { id: "demo-robot-letter", name: EN ? "Example Robotics Letter" : "示例机器人通讯" },
  { id: "demo-embodied-weekly", name: EN ? "Example Embodied AI Weekly" : "示例具身智能周刊" },
  { id: "demo-factory-notes", name: EN ? "Example Factory Automation Notes" : "示例工厂自动化笔记" },
] as const;

const PROJECT = EN
  ? { target: "Humanoid robot mass production (example)", purpose: "Example project: follow humanoid robots from prototype to mass production" }
  : { target: "人形机器人量产（示例）", purpose: "示例项目：跟踪人形机器人从样机到量产的进展" };
const DEMO_SOURCE_IDS = SOURCES.map((s) => s.id);

interface Story { source: string; title: string; core: string; summary: string; tag: string; score: number }

// Index 0 is today, 1 yesterday, 2 the day before. Three stories a day, best first.
const DAYS_ZH: Story[][] = [
  [
    { source: "demo-robot-letter", score: 92, tag: "量产", title: "【示例】虚构公司“星桥机器人”宣布人形机器人试产线每周下线 50 台",
      core: "示例数据：从样机走向小批量，关键在于关节模组的良率。",
      summary: "这是一条演示用的虚构新闻。虚构公司“星桥机器人”称其人形机器人试产线已稳定在每周 50 台，关节模组良率从 70% 提到 92%。文中数字均为示例，用来展示一张完整的今日卡片：标题、核心一句、摘要、标签和出处。" },
    { source: "demo-embodied-weekly", score: 88, tag: "模型", title: "【示例】开源视觉-语言-动作模型“示例VLA-2”在仿真抓取基准上提升 12 个百分点",
      core: "示例数据：同一套权重在三种机械臂上无需重训即可使用。",
      summary: "演示内容，并非真实发布。一个虚构的开源 VLA 模型在虚构的仿真抓取基准上成功率从 61% 提升到 73%，作者把提升归因于更多样的遥操作数据。这段摘要用来展示展开卡片后看到的完整文字。" },
    { source: "demo-factory-notes", score: 84, tag: "供应链", title: "【示例】虚构供应商把灵巧手成本压到每只 3000 元以内",
      core: "示例数据：腱绳驱动替代微型电机，零件数减少四成。",
      summary: "示例数据。一家虚构的零部件供应商称，改用腱绳驱动后灵巧手的物料成本降到每只 3000 元以内，零件数减少约四成。真实部署后，这里会是模型根据原文写出的摘要。" },
  ],
  [
    { source: "demo-embodied-weekly", score: 90, tag: "数据", title: "【示例】虚构联盟发布 10 万小时家务场景遥操作数据集",
      core: "示例数据：覆盖叠衣、洗碗、整理桌面等 40 类任务。",
      summary: "演示用虚构新闻。一个虚构的研究联盟发布了 10 万小时的家务场景遥操作数据，覆盖 40 类任务，采用宽松许可。这条出现在往期，用来展示过去某一天的期刊。" },
    { source: "demo-robot-letter", score: 86, tag: "量产", title: "【示例】虚构车企工厂引入 20 台人形机器人做物料搬运试点",
      core: "示例数据：试点为期三个月，先在夜班进行。",
      summary: "示例数据，并非真实事件。一家虚构车企在总装车间引入 20 台人形机器人做物料搬运试点，为期三个月，评估指标是每小时搬运次数和人工干预次数。" },
    { source: "demo-factory-notes", score: 81, tag: "零部件", title: "【示例】国产谐波减速器寿命测试突破 1 万小时（虚构）",
      core: "示例数据：寿命是人形机器人关节成本之外的第二个瓶颈。",
      summary: "演示内容。虚构厂商公布其谐波减速器在额定负载下连续运行 1 万小时无失效。真实部署中，这里会是从原文提炼的要点。" },
  ],
  [
    { source: "demo-robot-letter", score: 89, tag: "融资", title: "【示例】虚构初创公司完成 A 轮融资，专做双足机器人步态控制",
      core: "示例数据：资金主要用于扩大真机测试场地。",
      summary: "这是一条虚构的示例新闻。一家虚构初创公司完成 A 轮融资，专注双足机器人的步态控制，计划把真机测试场地扩大到 2000 平方米。金额与机构均为示例。" },
    { source: "demo-embodied-weekly", score: 85, tag: "评测", title: "【示例】新的具身智能评测榜单加入“开门”与“上楼梯”两项任务",
      core: "示例数据：榜单同时报告仿真与真机两种成绩。",
      summary: "演示数据。一个虚构的评测榜单新增两项长程任务，并要求同时提交仿真与真机成绩，以减少只在仿真里好看的结果。" },
    { source: "demo-factory-notes", score: 80, tag: "安全", title: "【示例】协作机器人安全标准草案征求意见（虚构）",
      core: "示例数据：草案首次给出人形机器人与人共处的速度上限。",
      summary: "示例内容，不对应任何真实标准。一份虚构的标准草案提出人形机器人在与人共处区域的速度与力上限，征求意见期为 30 天。" },
  ],
];

const DAYS_EN: Story[][] = [
  [
    { source: "demo-robot-letter", score: 92, tag: "mass production", title: "[Example] Fictional company Starbridge Robotics says its humanoid pilot line now ships 50 units a week",
      core: "Example data: from prototype to small batches, joint-module yield is the deciding factor.",
      summary: "This is an invented story for the demo. The fictional company Starbridge Robotics says its humanoid pilot line has settled at 50 units a week and joint-module yield rose from 70% to 92%. All numbers are examples; the card shows what a complete Today card looks like: title, one-line takeaway, summary, tag and source." },
    { source: "demo-embodied-weekly", score: 88, tag: "models", title: "[Example] Open vision-language-action model \"Example VLA-2\" gains 12 points on a simulated grasping benchmark",
      core: "Example data: the same weights run on three robot arms without retraining.",
      summary: "Demo content, not a real release. A fictional open VLA model raised its success rate on a fictional simulated grasping benchmark from 61% to 73%; the authors credit more varied teleoperation data. This summary shows the full text you see when a card is expanded." },
    { source: "demo-factory-notes", score: 84, tag: "supply chain", title: "[Example] Fictional supplier brings dexterous-hand cost under $400 per hand",
      core: "Example data: tendon drives replace micro motors and cut the part count by 40%.",
      summary: "Example data. A fictional parts supplier says switching to tendon drives brought the bill of materials for a dexterous hand under $400 and cut the part count by about 40%. In a real deployment this is the summary a model writes from the original article." },
  ],
  [
    { source: "demo-embodied-weekly", score: 90, tag: "data", title: "[Example] Fictional consortium releases 100,000 hours of household teleoperation data",
      core: "Example data: 40 task types, including folding clothes, washing dishes and tidying desks.",
      summary: "An invented story for the demo. A fictional research consortium released 100,000 hours of household teleoperation data across 40 task types under a permissive licence. It appears in the archive to show an earlier day's issue." },
    { source: "demo-robot-letter", score: 86, tag: "mass production", title: "[Example] Fictional carmaker pilots 20 humanoid robots for material handling",
      core: "Example data: a three-month pilot, starting on the night shift.",
      summary: "Example data, not a real event. A fictional carmaker is piloting 20 humanoid robots for material handling in final assembly for three months, measured by moves per hour and human interventions." },
    { source: "demo-factory-notes", score: 81, tag: "components", title: "[Example] Harmonic reducer passes a 10,000-hour life test (fictional)",
      core: "Example data: service life is the second bottleneck for humanoid joints after cost.",
      summary: "Demo content. A fictional maker reports its harmonic reducer ran 10,000 hours at rated load without failure. In a real deployment this is the key point taken from the original article." },
  ],
  [
    { source: "demo-robot-letter", score: 89, tag: "funding", title: "[Example] Fictional start-up closes a Series A for bipedal gait control",
      core: "Example data: the money mainly goes to a larger real-robot test site.",
      summary: "An invented example story. A fictional start-up focused on bipedal gait control closed a Series A and plans to grow its real-robot test site to 2,000 square metres. Amounts and investors are examples." },
    { source: "demo-embodied-weekly", score: 85, tag: "benchmarks", title: "[Example] Embodied AI leaderboard adds \"open a door\" and \"climb stairs\" tasks",
      core: "Example data: the leaderboard reports simulation and real-robot results side by side.",
      summary: "Demo data. A fictional leaderboard adds two long-horizon tasks and asks for both simulation and real-robot results, so results that only look good in simulation stand out." },
    { source: "demo-factory-notes", score: 80, tag: "safety", title: "[Example] Draft safety standard for collaborative robots opens for comment (fictional)",
      core: "Example data: the draft gives a first speed limit for humanoids working near people.",
      summary: "Example content that matches no real standard. A fictional draft standard proposes speed and force limits for humanoid robots in areas shared with people, open for comment for 30 days." },
  ],
];

const DAYS = EN ? DAYS_EN : DAYS_ZH;

const slug = (day: number, i: number) => `https://example.org/topka-demo/story-${day}-${i + 1}`;

function password(): { value: string; generated: boolean } {
  const fromEnv = process.env.DEMO_PASSWORD?.trim();
  if (fromEnv) return { value: fromEnv, generated: false };
  return { value: `demo-${randomBytes(6).toString("hex")}`, generated: true };
}

class Refused extends Error {}

try {
  const [already] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${DEMO_EMAIL}`;
  if (!values.force && !already) {
    const [others] = await sql<{ users: number; articles: number }[]>`
      SELECT (SELECT count(*)::int FROM users WHERE email <> ${DEMO_EMAIL}) AS users,
             (SELECT count(*)::int FROM articles WHERE NOT (source_id = ANY(${DEMO_SOURCE_IDS}))) AS articles`;
    if (others!.users || others!.articles) {
      console.error(`demo: this database already has real content (${others!.users} other users, ${others!.articles} non-demo articles); refusing. Pass --force to add the demo anyway.`);
      process.exitCode = values["if-enabled"] ? 0 : 1;
      throw new Refused();
    }
  }

  // Sources: invented, example.org only. `external` means items arrive by import and the worker never
  // schedules a fetch, so they can be switched on: the demo project then reads like a live one. They are
  // switched on when first added only: a re-run (every `docker compose up` with DEMO_SEED=true) keeps
  // whatever the operator chose since, so `sources:only` stays true across restarts.
  for (const s of SOURCES) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, next_fetch_at)
              VALUES (${s.id}, ${s.name}, 'external', ${sql.json({ url: `https://example.org/topka-demo/${s.id}.xml` })}, 'T1', 'editorial', true, NULL)
              ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = 'external', next_fetch_at = NULL`;
  }

  // The reader, through the real registration code path (open mode: the demo needs no invite).
  let pw: { value: string; generated: boolean } | null = null;
  let [user] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${DEMO_EMAIL}`;
  if (!user) {
    pw = password();
    user = { id: (await registerWithInvite({ code: "", email: DEMO_EMAIL, password: pw.value, userAgent: "scripts/demo.ts" }, sql, "open")).user.id };
  } else if (process.env.DEMO_PASSWORD?.trim()) {
    pw = password();
    await sql`UPDATE users SET password_hash = ${await hashPassword(pw.value)} WHERE id = ${user.id}`;
  }

  const sources = SOURCES.map((s) => ({ sourceId: s.id, required: false }));
  const { project, created } = await createProject({ ownerId: user.id, target: PROJECT.target, purpose: PROJECT.purpose, sources });
  if (!created) await bindProjectSources(project.id, sources);

  const today = currentIssueDate(new Date());
  const [{ n: haveIssues }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_issues WHERE user_id = ${user.id}`;
  const dayDate = (d: number) => new Date(issueCutoff(today).getTime() - d * 86_400_000).toISOString().slice(0, 10);

  for (const [d, stories] of DAYS.entries()) {
    const date = dayDate(d);
    const ids: string[] = [];
    for (const [i, s] of stories.entries()) {
      // Published a few hours before that day's issue was fixed.
      const at = new Date(issueCutoff(date).getTime() - (3 + i) * 3_600_000);
      const url = slug(d, i);
      const id = (await upsertMaterial({ sourceId: s.source, url, title: s.title, bodyText: `${s.title}\n\n${s.summary}`, bodyStatus: "ok", via: "import", publishedAt: at, discoveredAt: at })).articleId;
      await sql`INSERT INTO publications (article_id, title, original_title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, score, visible_after, listed_at, tags)
                VALUES (${id}, ${s.title}, ${s.title}, ${s.summary}, ${s.source}, 'news', ${url}, ${at}, ${at}, ${at}, ${at}, true, ${s.score}, ${at}, ${at}, ${[s.tag]})
                ON CONFLICT (article_id) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, score = EXCLUDED.score`;
      await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${id}`;
      await sql`INSERT INTO issue_card_copy (project_id, article_id, prompt_version, title_a, core_a, summary, tag, source_short)
                VALUES (${project.id}, ${id}, 'demo', ${s.title}, ${s.core}, ${s.summary}, ${s.tag}, ${SOURCES.find((x) => x.id === s.source)!.name})
                ON CONFLICT (project_id, article_id) DO UPDATE SET title_a = EXCLUDED.title_a, core_a = EXCLUDED.core_a, summary = EXCLUDED.summary, tag = EXCLUDED.tag`;
      ids.push(id);
    }
    if (haveIssues) continue;
    // Oldest day is issue 1, today is issue 3.
    const no = DAYS.length - d;
    const cutoff = issueCutoff(date);
    await sql`INSERT INTO user_issues (user_id, issue_date, issue_no, cutoff, window_since) VALUES (${user.id}, ${date}, ${no}, ${cutoff}, ${new Date(cutoff.getTime() - 86_400_000)})
              ON CONFLICT DO NOTHING`;
    for (const [i, id] of ids.entries()) {
      await sql`INSERT INTO user_issue_items (user_id, issue_date, position, article_id, project_id, score, listed_at)
                VALUES (${user.id}, ${date}, ${i + 1}, ${id}, ${project.id}, ${stories[i]!.score}, ${cutoff}) ON CONFLICT DO NOTHING`;
    }
  }

  console.log(`demo: ready. Log in at /login as ${DEMO_EMAIL}`);
  const howToReset = "to reset it: add DEMO_PASSWORD=<10+ characters> to .env, run `docker compose up -d`, then `docker compose exec api npm run demo:seed`";
  if (pw) console.log(`demo: password ${pw.value}${pw.generated ? `  (shown once; ${howToReset})` : " (from DEMO_PASSWORD)"}`);
  else console.log(`demo: account already existed, password unchanged (${howToReset})`);
  console.log(`demo: project ${project.id}, issues ${haveIssues ? "already present, left as they were" : `written for ${dayDate(2)}, ${dayDate(1)} and ${today}`}`);
} catch (error) {
  if (!(error instanceof Refused)) throw error;
} finally {
  await closeDb();
}
