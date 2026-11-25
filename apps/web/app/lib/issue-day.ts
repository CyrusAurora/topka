// The reader's issue day: the latest date whose 08:00 in their time zone has passed. The same rule
// as currentIssueDateInTz in packages/backend/src/projects/issue-rules.ts (a test holds them equal);
// the masthead uses it while the day's issue is still being prepared.
export function issueDayIn(now: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) >= 8) return date;
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12) - 86_400_000).toISOString().slice(0, 10);
}
