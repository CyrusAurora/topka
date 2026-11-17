// Opens the product on phone, tablet and desktop screens, in English and Chinese, in browsers set to
// time zones around the world, and fails on what a reader on that device would notice: a page that
// does not load, scrolls sideways, logs a console error (a server/browser time-zone mismatch shows
// up as a hydration error), shows the wrong language, or uses a time zone other than the reader's.
//   node scripts/check-devices.ts --url https://cyrusaurora.github.io/topka/ --demo --shots DIR
//   node scripts/check-devices.ts --url http://127.0.0.1:3000/ --shots DIR                 (visitor pages)
//   node scripts/check-devices.ts --url URL --email reader@example.com --password-env PW --shots DIR
// Signed in, each run sets the account's language and time zone (Settings does the same) and puts the
// account back as it was at the end, so point it at staging or a test account, not a real reader.
// Chrome: CHROME_PATH (default /usr/bin/google-chrome).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type APIRequestContext, type Page } from "playwright-core";
import { CJK, chromeText } from "./check-demo.ts";


export const DEVICES = [
  { name: "android-360", viewport: { width: 360, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "iphone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "ipad-820", viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
] as const;
export const LOCALES = ["en", "zh-CN"] as const;
export const ZONES = ["Asia/Taipei", "America/Los_Angeles", "Europe/Berlin", "UTC"] as const;

/** Each device × language gets a browser time zone, so every zone is covered twice. */
export function runs() {
  const out: Array<{ device: (typeof DEVICES)[number]; locale: (typeof LOCALES)[number]; zone: string }> = [];
  DEVICES.forEach((device, i) => LOCALES.forEach((locale, j) => out.push({ device, locale, zone: ZONES[(i * LOCALES.length + j) % ZONES.length] })));
  return out;
}

interface Result { run: string; page: string; status: number | null; overflow: string | null; lang: string; zone: string; errors: string[]; problems: string[]; shot?: string; note?: string }

/** Wider than the screen: the elements that stick out past the right edge (most specific first). */
async function overflow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= w + 1) return null;
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > w + 1 && !Array.from(el.children).some((c) => c.getBoundingClientRect().right > w + 1)) {
        out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} (right ${Math.round(r.right)})`);
        if (out.length >= 3) break;
      }
    }
    return `page is ${document.documentElement.scrollWidth}px wide on a ${w}px screen: ${out.join(", ")}`;
  });
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { url: { type: "string" }, demo: { type: "boolean" }, email: { type: "string" }, "password-env": { type: "string" }, shots: { type: "string" }, json: { type: "string" } },
    strict: true,
  });
  let url = values.url;
  if (!url) {
    console.error("usage: --url URL [--demo] [--email E --password-env VAR] [--shots DIR] [--json FILE]");
    process.exit(2);
  }
  if (!url.endsWith("/")) url += "/";
  const password = values["password-env"] ? process.env[values["password-env"]] : undefined;
  if (values.email && !password) {
    console.error(`--email needs the password in $${values["password-env"] ?? "(set --password-env)"}`);
    process.exit(2);
  }
  const signedIn = Boolean(values.email);
  const pages = values.demo ? ["", "archive", "chat"] : signedIn ? ["", "archive", "projects", "settings"] : ["", "archive", "about", "login"];
  if (values.shots) mkdirSync(values.shots, { recursive: true });

  const results: Result[] = [];
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  let restore: (() => Promise<void>) | undefined;
  try {
    for (const { device, locale, zone } of runs()) {
      const run = `${device.name}-${locale}-${zone.replace("/", "_")}`;
      const { name: _, ...options } = device;
      const context = await browser.newContext({ ...options, locale, timezoneId: zone });
      const api: APIRequestContext = context.request;
      // The account's language and zone, which the site uses instead of the browser's.
      let want = { locale: values.demo ? locale : "", zone: values.demo ? zone : "" };
      if (signedIn) {
        const login = await api.post(`${url}api/auth/login`, { data: { email: values.email, password }, headers: { origin: new URL(url).origin } });
        if (!login.ok()) throw new Error(`sign-in failed: HTTP ${login.status()}`);
        if (!restore) {
          const me = (await (await api.get(`${url}api/auth/me`)).json()) as { user: { locale: string; timezone: string } };
          const before = { locale: me.user.locale, timezone: me.user.timezone };
          restore = async () => {
            const ctx = await browser.newContext();
            await ctx.request.post(`${url}api/auth/login`, { data: { email: values.email, password }, headers: { origin: new URL(url!).origin } });
            await ctx.request.patch(`${url}api/auth/me`, { data: before, headers: { origin: new URL(url!).origin } });
            await ctx.close();
          };
        }
        // Readers mostly keep the browser's zone; half the runs use another one to catch mismatches.
        const accountZone = ZONES[(ZONES.indexOf(zone as (typeof ZONES)[number]) + (locale === "en" ? 0 : 1)) % ZONES.length];
        const set = await api.patch(`${url}api/auth/me`, { data: { locale, timezone: accountZone }, headers: { origin: new URL(url).origin } });
        if (!set.ok()) throw new Error(`could not set the account's language/zone: HTTP ${set.status()}`);
        want = { locale, zone: accountZone };
      }
      const page = await context.newPage();
      for (const path of pages) {
        const errors: string[] = [];
        // Signed out, the reader pages ask the API anyway and show "sign in" on its 401; Chrome logs
        // that 401 as a console error. It is the expected answer there, not a fault.
        const expected = (t: string) => !signedIn && !values.demo && /status of 401\b/.test(t);
        const onConsole = (m: { type(): string; text(): string }) => { if (m.type() === "error" && !expected(m.text())) errors.push(m.text()); };
        const onError = (e: Error) => errors.push(String(e));
        page.on("console", onConsole);
        page.on("pageerror", onError);
        const problems: string[] = [];
        const res = await page.goto(`${url}${path}`, { waitUntil: "load", timeout: 30_000 }).catch((e) => { problems.push(String(e)); return null; });
        // Pages that keep a connection open (live updates) never go idle; settle for a few seconds.
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        const status = res?.status() ?? null;
        if (status === null || status >= 400) problems.push(`HTTP ${status}`);
        const over = await overflow(page);
        if (over) problems.push(over);
        const lang = await page.evaluate(() => document.documentElement.lang);
        if (want.locale && lang !== want.locale) problems.push(`html lang is "${lang}", the reader's language is ${want.locale}`);
        let shownZone = "";
        if (values.demo) {
          shownZone = (await page.locator("[data-demo-zone]").inputValue().catch(() => "")) || "";
          if (shownZone !== want.zone) problems.push(`demo time zone is "${shownZone}", the browser's is ${want.zone}`);
        } else if (signedIn && path === "settings") {
          shownZone = await page.locator("#time-zone").inputValue().catch(() => "");
          if (shownZone !== want.zone) problems.push(`settings shows time zone "${shownZone}", the account's is ${want.zone}`);
        }
        if (want.locale === "en") {
          let text = await chromeText(page);
          text = text.replace(/"[^"\n]{1,40}"/g, " ");
          const m = text.match(new RegExp(`.{0,20}${CJK.source}.{0,20}`));
          if (m) problems.push(`Chinese in the English page chrome: "${m[0].trim()}"`);
        }
        page.off("console", onConsole);
        page.off("pageerror", onError);
        const shot = values.shots ? join(values.shots, `${run}-${path || "today"}.png`) : undefined;
        if (shot) await page.screenshot({ path: shot, fullPage: true });
        results.push({ run, page: path || "today", status, overflow: over, lang, zone: shownZone || want.zone || zone, errors, problems: [...problems, ...errors.map((e) => `console: ${e}`)], shot });
      }
      await context.close();
      const bad = results.filter((r) => r.run === run && r.problems.length).length;
      console.log(`${run}: ${pages.length} pages${bad ? `, ${bad} with problems` : ", clear"}`);
    }
    // One reader, two devices: a card opened on the phone shows as read on the desktop (the read
    // state lives on the server, not in the browser).
    if (signedIn) {
      const problems: string[] = [];
      const signIn = async (device: (typeof DEVICES)[number]) => {
        const { name: _, ...options } = device;
        const ctx = await browser.newContext({ ...options, locale: "zh-CN", timezoneId: "Asia/Taipei" });
        await ctx.request.post(`${url}api/auth/login`, { data: { email: values.email, password }, headers: { origin: new URL(url).origin } });
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: "load" });
        await page.waitForSelector("article.mag-item", { timeout: 15_000 }).catch(() => problems.push("no cards on today"));
        return { ctx, page };
      };
      const phone = await signIn(DEVICES[1]);
      const unread = await phone.page.$$eval("article.mag-item", (as) => as.findIndex((a) => !a.classList.contains("read")));
      let note = "";
      if (unread < 0) note = "every card was already read; nothing to carry over";
      else {
        await phone.page.locator("article.mag-item").nth(unread).locator("[aria-expanded]").first().click();
        await phone.page.waitForResponse((r) => r.url().endsWith("/api/me/issues/read"), { timeout: 10_000 }).catch(() => problems.push("opening a card on the phone sent no read mark"));
        const desk = await signIn(DEVICES[3]);
        const read = await desk.page.locator("article.mag-item").nth(unread).evaluate((a) => a.classList.contains("read")).catch(() => false);
        if (!read) problems.push(`card ${unread + 1} opened on the phone is not shown as read on the desktop`);
        else note = `card ${unread + 1} opened on ${DEVICES[1].name} shows as read on ${DEVICES[3].name}`;
        if (values.shots) await desk.page.screenshot({ path: join(values.shots, "continuity-desktop.png"), fullPage: true });
        await desk.ctx.close();
      }
      await phone.ctx.close();
      results.push({ run: "continuity", page: "today", status: null, overflow: null, lang: "zh-CN", zone: "Asia/Taipei", errors: [], problems, note });
      console.log(`continuity: ${problems.length ? problems.join("; ") : note}`);
    }
  } finally {
    await restore?.().catch((e) => console.error(`could not put the account back: ${e}`));
    await browser.close();
  }
  if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 2) + "\n");
  const failed = results.filter((r) => r.problems.length);
  for (const r of failed) for (const p of r.problems) console.error(`FAIL ${r.run} /${r.page === "today" ? "" : r.page}: ${p}`);
  console.log(`device check: ${results.length} page views, ${failed.length} with problems`);
  if (failed.length) process.exit(1);
}

if (import.meta.main) await main();
