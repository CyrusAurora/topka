// The runs page's count of model calls in the last 7 days.
/** "7 days: 3 paid requests · 19 demo" — free and demo calls are never counted as paid. */
export function requestsHint(
  receipts: { counts: Record<string, number>; kinds?: { paid: number; free: number; demo: number } },
  t: { paidRequests7d: (n: string) => string; freeRequests: (n: string) => string; demoRequests: (n: string) => string },
  num: (n: number) => string,
): string {
  const k = receipts.kinds ?? { paid: Object.values(receipts.counts).reduce((a, b) => a + b, 0), free: 0, demo: 0 };
  return [t.paidRequests7d(num(k.paid)), k.free ? t.freeRequests(num(k.free)) : "", k.demo ? t.demoRequests(num(k.demo)) : ""].filter(Boolean).join(" · ");
}
