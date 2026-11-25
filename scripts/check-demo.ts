// Clicks through the online demo in a real browser, in English and Chinese, and fails on anything a
// visitor would notice: the latest real issue missing or under the wrong date, internal links that do
// not load, source links that are not plain web links, a demo chat that does not answer, console
// errors, or Chinese in the English page chrome (the issue copy itself is marked with lang).
//   node scripts/check-demo.ts --url https://cyrusaurora.github.io/topka/ [--shots DIR]
//   node scripts/check-demo.ts --serve apps/web/build-demo --base /topka/      (a local Pages stand-in)
// Chrome: CHROME_PATH (default /usr/bin/google-chrome).
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";


const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

/** Serves DIR under BASE the way GitHub Pages does: dir/index.html, else 404.html with status 404. */
export function pagesServer(dir: string, base: string): Server {
  const root = resolve(dir);
  return createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const send = (file: string, status: number) => {
      res.writeHead(status, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    };
    if (!path.startsWith(base)) return send(join(root, "404.html"), 404);
    const file = normalize(join(root, path.slice(base.length)));
    if (!file.startsWith(root)) return send(join(root, "404.html"), 404);
    if (existsSync(file) && statSync(file).isFile()) return send(file, 200);
    if (existsSync(join(file, "index.html"))) return send(join(file, "index.html"), 200);
    return send(join(root, "404.html"), 404);
  });
}

export const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/** The page's visible text outside elements that declare their own language. */
export async function chromeText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) out.push(n.textContent ?? "");
      else if (n instanceof HTMLElement) {
        if (n !== document.documentElement && n.hasAttribute("lang") && n.getAttribute("lang") !== document.documentElement.lang) return;
        if (n.tagName === "SCRIPT" || n.tagName === "STYLE" || n.hidden || getComputedStyle(n).display === "none") return;
        n.childNodes.forEach(walk);
      }
    };
    walk(document.body);
    return out.join(" ");
  });
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { url: { type: "string" }, serve: { type: "string" }, base: { type: "string" }, shots: { type: "string" } }, strict: true });
  let server: Server | undefined;
  let url = values.url;
  if (values.serve) {
    const base = values.base ?? "/";
    server = pagesServer(values.serve, base);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    url = `http://127.0.0.1:${port}${base}`;
  }
  if (!url) {
    console.error("usage: --url URL | --serve DIR [--base /topka/]");
    process.exit(2);
  }
  if (!url.endsWith("/")) url += "/";
  if (values.shots) mkdirSync(values.shots, { recursive: true });

  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  const meta = await (await fetch(`${url}data/meta.json`, { cache: "no-store" })).json() as { latestIssueDate: string; updatedAt: string; issueCount: number };
  // Project names are the reader's own words (content, like the cards), not page chrome.
  const today = await (await fetch(`${url}data/today.json`, { cache: "no-store" })).json() as { projects?: Array<{ target: string }> };
  const contentNames = (today.projects ?? []).map((p) => p.target).filter(Boolean);
  console.log(`data: ${meta.issueCount} issues, latest ${meta.latestIssueDate}, updated ${meta.updatedAt}`);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  try {
    for (const lang of ["en", "zh-CN"] as const) {
      const context = await browser.newContext({ locale: lang, timezoneId: "Asia/Taipei", viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(String(e)));
      const shot = async (name: string) => { if (values.shots) await page.screenshot({ path: join(values.shots, `${lang}-${name}.png`), fullPage: true }); };
      const noCjk = async (where: string) => {
        if (lang !== "en") return;
        let text = await chromeText(page);
        for (const name of contentNames) text = text.split(name).join(" ");
        // A data keyword quoted inside an English sentence (Stop seeing "量产") is data, not chrome.
        text = text.replace(/"[^"\n]{1,40}"/g, " ");
        const m = text.match(new RegExp(`.{0,20}${CJK.source}.{0,20}`));
        if (m) fail(`${lang} ${where}: Chinese in the page chrome: "${m[0].trim()}"`);
      };

      // Today: the latest real issue, under its own date.
      const res = await page.goto(`${url}?lang=${lang}`);
      if (res?.status() !== 200) fail(`${lang} today: HTTP ${res?.status()}`);
      await page.waitForSelector(".mag-card, .m-card, article", { timeout: 20_000 }).catch(() => fail(`${lang} today: no cards`));
      const latest = await page.getAttribute("[data-demo-latest]", "data-demo-latest").catch(() => null);
      if (latest !== meta.latestIssueDate) fail(`${lang} today: bar shows latest ${latest}, data says ${meta.latestIssueDate}`);
      const [, mo, d] = meta.latestIssueDate.split("-");
      const mast = (await page.textContent(".mag-date"))?.replace(/\s+/g, " ") ?? "";
      if (!mast.startsWith(`${mo}.${d}`)) fail(`${lang} today: masthead "${mast}" is not ${meta.latestIssueDate}`);
      // Sources show when a card is opened.
      await page.click("[aria-expanded]", { timeout: 5_000 }).catch(() => fail(`${lang} today: could not open a card`));
      await page.waitForTimeout(300);
      const sources = await page.$$eval("a[target=_blank]", (as) => as.map((a) => (a as HTMLAnchorElement).href).filter((h) => {
        // The demo bar's own links (the repository) are not sources.
        const u = new URL(h);
        return !(u.hostname === "github.com" && u.pathname.toLowerCase().startsWith("/cyrusaurora/topka"));
      }));
      if (sources.length === 0) fail(`${lang} today: no source links`);
      for (const h of sources) if (!/^https?:\/\//.test(h)) fail(`${lang} today: source link ${h} is not http(s)`);
      await noCjk("today");
      await shot("today");

      // A source link opens in a new tab.
      const first = page.locator(".magazine a[target=_blank]").first();
      const [popup] = await Promise.all([context.waitForEvent("page", { timeout: 10_000 }).catch(() => null), first.click({ timeout: 5_000 }).catch(() => fail(`${lang}: could not click a source link`))]);
      if (!popup) fail(`${lang}: a source link did not open a tab`);
      else await popup.close();

      // Past issues: the list, then one issue by link, then the same issue loaded directly.
      await page.click(`a[href$="/archive"]`);
      await page.waitForURL(/\/archive$/);
      await page.waitForSelector(`a[href*="/issue/"]`, { timeout: 15_000 }).catch(() => fail(`${lang} archive: no issues listed`));
      await noCjk("archive");
      await shot("archive");
      const issueHref = await page.getAttribute(`a[href*="/issue/"]`, "href");
      if (issueHref) {
        await page.click(`a[href="${issueHref}"]`);
        await page.waitForURL(/\/issue\/\d{4}-\d{2}-\d{2}$/);
        await page.waitForSelector(".mag-card, .m-card, article", { timeout: 15_000 }).catch(() => fail(`${lang} issue: no cards at ${issueHref}`));
        const direct = await page.goto(new URL(issueHref, url).href);
        if (direct?.status() !== 200) fail(`${lang} issue: direct load of ${issueHref} gave HTTP ${direct?.status()}`);
        await page.waitForSelector(".mag-card, .m-card, article", { timeout: 15_000 }).catch(() => fail(`${lang} issue: no cards on direct load`));
        await noCjk("issue");
        await shot("issue");
      }

      // The demo chat answers, and walks to a project card.
      await page.goto(`${url}chat?lang=${lang}`);
      const input = page.locator(".chat-inputbar input");
      await input.waitFor({ timeout: 15_000 });
      const before = await page.locator(".chat-msg").count();
      await input.fill(lang === "en" ? "I want to follow humanoid robot news" : "我想关注人形机器人的进展");
      await input.press("Enter");
      await page.waitForFunction((n) => document.querySelectorAll(".chat-msg").length >= n + 2 && !document.querySelector(".thinking"), before, { timeout: 15_000 })
        .catch(() => fail(`${lang} chat: no answer`));
      // Answer with the first chip until the model proposes a project, then confirm it.
      for (let i = 0; i < 10 && (await page.locator(".btn.dark").count()) === 0; i++) {
        // The first chip of the latest question (on the confirm step that is "Yes").
        const chip = page.locator(".chat-msg").last().locator(".chip:not(.other)").first();
        if ((await chip.count()) === 0) {
          await input.fill(lang === "en" ? "Nothing to exclude" : "没有要排除的");
          await input.press("Enter");
        } else await chip.click();
        await page.waitForFunction(() => !document.querySelector(".thinking"), undefined, { timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(200);
      }
      const projectsBefore = await page.textContent(".chat-projbar");
      await page.locator(".btn.dark").last().click({ timeout: 5_000 }).catch(() => fail(`${lang} chat: never proposed a project`));
      await page.waitForFunction((t) => document.querySelector(".chat-projbar")?.textContent !== t, projectsBefore, { timeout: 10_000 })
        .catch(() => fail(`${lang} chat: confirming did not add a project`));
      await noCjk("chat");
      await shot("chat");

      // Settings and a page that needs a server say so instead of breaking.
      await page.goto(`${url}settings?lang=${lang}`);
      await page.waitForLoadState("networkidle");
      await noCjk("settings");
      await page.goto(`${url}login?lang=${lang}`);
      await page.waitForSelector("[data-demo-info]", { timeout: 10_000 }).catch(() => fail(`${lang} login: no demo info page`));

      for (const e of errors) fail(`${lang} console: ${e}`);
      await context.close();
      console.log(`${lang}: checked`);
    }
  } finally {
    await browser.close();
    server?.close();
  }
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log("demo check: all clear");
}

if (import.meta.main) await main();
