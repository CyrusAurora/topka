// Opens the site's main pages and machine endpoints and checks each answers: the whole-site check after a
// deploy, and CI's check of the built site on an empty database.
//   node scripts/smoke.ts [--base http://localhost:3000]
import { SITE } from "@topka/industry/site";
import { siteAddress } from "@topka/contracts/address";

const at = process.argv.indexOf("--base");
const base = at > 0 && process.argv[at + 1] ? process.argv[at + 1]! : siteAddress(process.env, "http://localhost:3000");

// The site is 今日 (/) and what serves it; the retired public pages answer with a redirect (below).
const PAGES = ["/", "/today", "/archive", "/chat", "/settings", "/login", "/register", "/about", "/feedback", "/admin/login"];
const RETIRED: Array<[path: string, location: string]> = [["/all", "/"], ["/hot", "/"], ["/daily", "/archive"], ["/topics", "/"], ["/agent", "/"], ["/leaderboard", "/"], ["/changelog", "/"]];
const MACHINE: Array<[path: string, type: RegExp]> = [
  ["/api/health", /json/],
  ["/api/site/stats", /json/],
  ["/robots.txt", /text\/plain/],
  ["/manifest.webmanifest", /manifest/],
  ["/og/site.png", /image\/png/],
  ["/icon.png", /image\/png/],
  ["/favicon.ico", /icon/],
];

let failed = 0;
async function check(path: string, expect: (res: Response, body: string) => string | null) {
  try {
    const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const body = res.headers.get("content-type")?.startsWith("image/") ? "" : await res.text();
    const problem = res.status !== 200 ? `HTTP ${res.status}` : expect(res, body);
    console.log(`${problem ? "✗" : "✓"} ${path}${problem ? `  ${problem}` : ""}`);
    if (problem) failed += 1;
  } catch (error) {
    console.log(`✗ ${path}  ${String(error)}`);
    failed += 1;
  }
}

for (const path of PAGES) await check(path, (_res, body) => (body.includes(SITE.name) ? null : `the page does not name ${SITE.name}`));
for (const [path, location] of RETIRED) {
  try {
    const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const at = res.headers.get("location") ?? "";
    const ok = res.status === 301 && new URL(at, base).pathname === location;
    console.log(`${ok ? "✓" : "✗"} ${path} → ${location}${ok ? "" : `  HTTP ${res.status} ${at}`}`);
    if (!ok) failed += 1;
  } catch (error) {
    console.log(`✗ ${path}  ${String(error)}`);
    failed += 1;
  }
}
for (const [path, type] of MACHINE) await check(path, (res) => (type.test(res.headers.get("content-type") ?? "") ? null : `content-type ${res.headers.get("content-type")}`));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
