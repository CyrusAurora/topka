// The online demo's leak scan: what may not appear in the published JSON (scripts/pages-export.ts runs
// it before writing, scripts/pages-check.ts again in the Pages workflow before deploying). Pure: no I/O.
export const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["api key", /\b(sk-[A-Za-z0-9_-]{16,}|sk-or-v1-[0-9a-f]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/],
  ["bearer token", /Bearer\s+[A-Za-z0-9._~+/-]{12,}/i],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["local address", /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b/],
  // A path on a machine, not inside a URL: "/srv/app/.env", a home directory.
  ["machine path", /(^|["'\s(=])\/(home|Users|root|workspace|srv|mnt|opt)\/[\w.-]+\//],
];

/**
 * Problems in the serialized files: a known pattern (email, uuid, key, local address, machine path), any
 * of `secrets` (the reader's email and id, project ids and slugs, article ids) or of `denyTerms`
 * (an operator's own deny list). An empty list means the files may be published.
 */
export function leakScan(files: Record<string, string>, secrets: string[] = [], denyTerms: string[] = []): string[] {
  const problems: string[] = [];
  const needles = [...secrets, ...denyTerms].map((s) => s.trim()).filter((s) => s.length >= 4);
  for (const [path, text] of Object.entries(files)) {
    if (!/^(meta|today|issues)\.json$|^issues\/\d{4}-\d{2}-\d{2}\.json$/.test(path)) problems.push(`${path}: unexpected file name`);
    for (const [name, re] of LEAK_PATTERNS) if (re.test(text)) problems.push(`${path}: ${name}`);
    const lower = text.toLowerCase();
    needles.forEach((n, i) => {
      if (lower.includes(n.toLowerCase())) problems.push(`${path}: ${i < secrets.length ? "private value" : "deny-list term"} #${i + 1}`);
    });
  }
  return problems;
}
