// The online demo's data (apps/web/demo, served from GitHub Pages): one reader's already-fixed daily
// issues, cut down to what a visitor of the public site may see. Every field is copied by name
// (whitelist), never by spreading a row: no user or project ids, no article ids, no read marks, no
// emails, no scores. `leakScan` re-checks the serialized files before anything is published.
import { sql, type Db } from "../db.ts";
import { issueCount, listArchive, readIssue, userLocale, userTimezone, type ArchiveEntry, type Issue } from "../projects/issues.ts";
import { listUserProjects } from "../projects/user-today.ts";

export const PAGES_SCHEMA_VERSION = 1;

export interface PagesMeta {
  schemaVersion: number;
  /** When this export ran (the page says "last updated", never "today"). */
  updatedAt: string;
  latestIssueDate: string | null;
  issueCount: number;
  /** The zone the issue days are counted in (the reader's), and the language the cards were written in. */
  issueTimeZone: string;
  contentLang: "zh-CN" | "en";
}

export interface PagesProject { id: string; slug: string; target: string }

/** path inside the data directory → JSON value. */
export type PagesFiles = Record<string, unknown>;

export interface PagesSource {
  projects: Array<{ id: string; slug: string; target: string }>;
  issues: Issue[];
  archive: ArchiveEntry[];
  issueCount: number;
  timeZone: string;
  locale: string;
}

const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.slice(0, max) : "");
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const httpUrl = (v: unknown): string => {
  const s = str(v, 2000);
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
};

/** Stable public stand-ins for the reader's projects: demo-1, demo-2… in listing order. */
export function projectAliases(projects: PagesSource["projects"]): Map<string, PagesProject> {
  const out = new Map<string, PagesProject>();
  projects.forEach((p, i) => out.set(p.id, { id: `demo-${i + 1}`, slug: `demo-${i + 1}`, target: str(p.target, 80) }));
  return out;
}

/** One issue, whitelisted: item ids become `<date>-<position>`, the project its alias. */
export function publicIssue(issue: Issue, aliases: Map<string, PagesProject>) {
  return {
    date: str(issue.date, 10),
    no: typeof issue.no === "number" ? issue.no : null,
    fixedAt: isoOrNull(issue.fixedAt),
    hero: issue.hero === true,
    ready: issue.ready === true,
    items: issue.items.map((it) => {
      const project = aliases.get(it.project.id)!;
      const w = it.withdrawal;
      return {
        id: `${issue.date}-${it.position}`,
        position: it.position,
        title_a: str(it.title_a, 200),
        title_b: str(it.title_b, 200),
        core_a: str(it.core_a, 400),
        core_b: str(it.core_b, 400),
        summary: str(it.summary, 2000),
        tag: str(it.tag, 40),
        source: str(it.source, 80),
        url: httpUrl(it.url),
        score: null,
        project,
        publishedAt: isoOrNull(it.publishedAt),
        listedAt: isoOrNull(it.listedAt),
        hasCopy: it.hasCopy === true,
        overBudget: it.overBudget === true,
        ledger: str(it.ledger, 20) || "current",
        withdrawal: w ? { basis: str(w.basis, 40), reason: str(w.reason, 400), at: isoOrNull(w.at) } : null,
      };
    }),
  };
}

/**
 * The files of one export: meta.json, today.json (the newest issue, as /api/me/today answers it),
 * issues.json (the archive, as /api/me/issues) and issues/<date>.json (as /api/me/issues/:date).
 */
export function pagesFiles(src: PagesSource, now: Date = new Date()): PagesFiles {
  // Projects in listing order, then any an older issue names that is gone since (deleted projects).
  const known = new Map(src.projects.map((p) => [p.id, p]));
  for (const issue of src.issues) for (const it of issue.items) if (!known.has(it.project.id)) known.set(it.project.id, it.project);
  const aliases = projectAliases([...known.values()]);
  const issues = src.issues.filter((i) => i.items.length > 0).sort((a, b) => (a.date < b.date ? 1 : -1)).map((i) => publicIssue(i, aliases));
  const latest = issues[0] ?? null;
  const contentLang = src.locale === "en" ? "en" : "zh-CN";
  const archive = src.archive
    .filter((a) => issues.some((i) => i.date === a.date))
    .map((a) => ({ date: str(a.date, 10), no: a.no, titles: (a.titles ?? []).map((t) => str(t, 200)) }));
  const meta: PagesMeta = {
    schemaVersion: PAGES_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    latestIssueDate: latest?.date ?? null,
    issueCount: issues.length,
    issueTimeZone: str(src.timeZone, 64) || "Asia/Shanghai",
    contentLang,
  };
  const files: PagesFiles = {
    "meta.json": meta,
    "today.json": {
      schemaVersion: 3,
      kind: "user-issue",
      user: { id: "demo" },
      projects: src.projects.map((p) => aliases.get(p.id)!),
      generatedAt: meta.updatedAt,
      nextAt: null,
      issueCount: issues.length,
      issue: latest,
      opened: [],
      archive: archive.filter((a) => a.date !== latest?.date),
      contentLang,
    },
    "issues.json": { archive: archive.filter((a) => a.date !== latest?.date), issueCount: issues.length, contentLang },
  };
  for (const issue of issues) files[`issues/${issue.date}.json`] = { issue, contentLang };
  return files;
}

/** Reads one reader's fixed issues (newest `limit`) for `pagesFiles`. Read-only: never fixes an issue. */
export async function readPagesSource(userId: string, opts: { db?: Db; limit?: number } = {}): Promise<PagesSource> {
  const db = opts.db ?? sql;
  const archive = await listArchive(userId, db, { limit: opts.limit ?? 30 });
  const issues: Issue[] = [];
  for (const a of archive) {
    const issue = await readIssue(userId, a.date, db);
    if (issue) issues.push(issue);
  }
  return {
    projects: (await listUserProjects(userId, db)).map(({ id, slug, target }) => ({ id, slug, target })),
    issues,
    archive,
    issueCount: await issueCount(userId, db),
    timeZone: await userTimezone(userId, db),
    locale: await userLocale(userId, db),
  };
}

// The scan is pure (no database), so the Pages workflow re-runs it on the data it is about to publish.
export { leakScan } from "@topka/contracts/pages-scan";
