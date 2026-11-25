// The discovery channel's pure rules (master design 3.2 discovery_signals, 8.2 step 10; handover 3.7):
// the URL identity (the nine v0 rules plus decisions A–E: origin normalisation, identity-bearing
// queries, redirect wrappers, mirrors), the promotion gate, duplicate folding, the deterministic
// order and the 20-item cap that fails closed. Table-driven: one row per rule, no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PENDING_CAP, compareEarliest, identityOf, normalizeCap, pendingList, promotionGate, urlIdentity,
  type SavedObservation, type SignalCandidate,
} from "@topka/contracts/discovery";

type Row = [rule: string, input: unknown, expected: string | { refused: string }];

const IDENTITY: Row[] = [
  // 1. absolute only
  ["1 relative path", "/news/1", { refused: "not-absolute" }],
  ["1 scheme-relative", "//example.com/a", { refused: "not-absolute" }],
  ["1 bare host", "example.com/a", { refused: "not-absolute" }],
  ["1 empty", "", { refused: "not-absolute" }],
  ["1 whitespace", "   ", { refused: "not-absolute" }],
  ["1 not a string", 42, { refused: "not-absolute" }],
  ["1 null", null, { refused: "not-absolute" }],
  ["1 unparsable", "https://exa mple.com/a", { refused: "not-absolute" }],
  // 2. http(s) only
  ["2 ftp", "ftp://example.com/a", { refused: "not-http" }],
  ["2 mailto", "mailto:someone@example.com", { refused: "not-http" }],
  ["2 javascript", "javascript:alert(1)", { refused: "not-http" }],
  ["2 host:port without scheme reads as a scheme", "localhost:3000/x", { refused: "not-http" }],
  // 3. userinfo refused
  ["3 user and password", "https://user:pw@example.com/a", { refused: "userinfo" }],
  ["3 user only", "https://user@example.com/a", { refused: "userinfo" }],
  // 4. origin + pathname
  ["4 plain", "https://example.com/a/b", "https://example.com/a/b"],
  ["4 surrounding whitespace", "  https://example.com/a  ", "https://example.com/a"],
  // 5. query ignored (tracking parameters included)
  ["5 query", "https://example.com/a?x=1", "https://example.com/a"],
  ["5 tracking", "https://example.com/a?utm_source=x&utm_medium=y&fbclid=z&spm=1", "https://example.com/a"],
  // 6. fragment ignored
  ["6 fragment", "https://example.com/a#section-2", "https://example.com/a"],
  ["6 query and fragment", "https://example.com/a/?ref=hn#top", "https://example.com/a"],
  // 7. path case-sensitive
  ["7 upper-case path kept", "https://example.com/News/A", "https://example.com/News/A"],
  // 8. non-root trailing slash dropped, root kept
  ["8 trailing slash", "https://example.com/a/", "https://example.com/a"],
  ["8 several trailing slashes", "https://example.com/a///", "https://example.com/a"],
  ["8 root with slash", "https://example.com/", "https://example.com/"],
  ["8 root without slash", "https://example.com", "https://example.com/"],
  ["8 root with only tracking", "https://example.com/?utm_source=x#top", "https://example.com/"],
  // 9. http and https differ
  ["9 http", "http://example.com/a", "http://example.com/a"],
  // A. WHATWG origin
  ["A host and scheme case", "HTTPS://Example.COM/a", "https://example.com/a"],
  ["A default https port", "https://example.com:443/a", "https://example.com/a"],
  ["A default http port", "http://example.com:80/a", "http://example.com/a"],
  ["A other port kept", "https://example.com:8443/a", "https://example.com:8443/a"],
  ["A https on port 80 keeps it", "https://example.com:80/a", "https://example.com:80/a"],
  ["A trailing dot", "https://example.com./a", "https://example.com/a"],
  ["A no www folding", "https://www.example.com/a", "https://www.example.com/a"],
  ["A IDN to punycode", "https://例子.测试/a", "https://xn--fsqu00a.xn--0zwm56d/a"],
  ["A percent escapes upper-cased", "https://example.com/%e4%b8%ad", "https://example.com/%E4%B8%AD"],
  ["A non-ASCII path escaped", "https://example.com/中", "https://example.com/%E4%B8%AD"],
  ["A dot segments resolved", "https://example.com/a/./b/../c", "https://example.com/a/c"],
  // B. identity-bearing queries
  ["B WeChat article", "https://mp.weixin.qq.com/s?__biz=MzA&mid=1&idx=2&sn=abc&chksm=zz&scene=1#rd", "https://mp.weixin.qq.com/s?__biz=MzA&idx=2&mid=1&sn=abc"],
  ["B WeChat short link has no query identity", "https://mp.weixin.qq.com/s/AbCdEf?scene=1", "https://mp.weixin.qq.com/s/AbCdEf"],
  ["B Hacker News item", "https://news.ycombinator.com/item?id=42&utm_source=x", "https://news.ycombinator.com/item?id=42"],
  ["B YouTube video", "https://www.youtube.com/watch?v=abc&t=10&feature=share", "https://www.youtube.com/watch?v=abc"],
  ["B rule needs its parameter", "https://news.ycombinator.com/item?x=1", "https://news.ycombinator.com/item"],
  // C. redirect wrappers
  ["C google.com/url q", "https://www.google.com/url?q=https://example.com/a/?utm_source=x&sa=D", "https://example.com/a"],
  ["C google.com/url url", "https://google.com/url?url=https%3A%2F%2Fexample.com%2Fb", "https://example.com/b"],
  ["C facebook", "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fc&h=AT0", "https://example.com/c"],
  ["C zhihu", "https://link.zhihu.com/?target=https%3A//example.com/d", "https://example.com/d"],
  ["C nested", "https://www.google.com/url?q=https%3A%2F%2Flink.zhihu.com%2F%3Ftarget%3Dhttps%253A%2F%2Fexample.com%2Fe", "https://example.com/e"],
  ["C wrapper to javascript", "https://www.google.com/url?q=javascript:alert(1)", { refused: "bad-wrapper" }],
  ["C wrapper without target", "https://www.google.com/url?sa=D", { refused: "bad-wrapper" }],
  ["C wrapper to relative", "https://link.zhihu.com/?target=/local", { refused: "bad-wrapper" }],
  ["C wrapper to userinfo", "https://link.zhihu.com/?target=https%3A%2F%2Fu%3Ap%40example.com%2Ff", { refused: "userinfo" }],
  ["C google search page is not a wrapper", "https://www.google.com/search?q=x", { refused: "search-page" }],
  // D. mirrors
  ["D twitter to x", "https://twitter.com/a/status/1", "https://x.com/a/status/1"],
  ["D mobile twitter", "https://mobile.twitter.com/a/status/1/", "https://x.com/a/status/1"],
  ["D mirror keeps the scheme", "http://twitter.com/a", "http://x.com/a"],
  ["D old reddit", "https://old.reddit.com/r/x/comments/1/t/", "https://www.reddit.com/r/x/comments/1/t"],
  ["D youtu.be", "https://youtu.be/abc?t=3", "https://www.youtube.com/watch?v=abc"],
  ["D m.youtube", "https://m.youtube.com/watch?v=abc&feature=share", "https://www.youtube.com/watch?v=abc"],
  ["D arxiv pdf", "https://arxiv.org/pdf/2401.00001v2.pdf", "https://arxiv.org/abs/2401.00001v2"],
  ["D arxiv pdf without suffix", "https://arxiv.org/pdf/2401.00001", "https://arxiv.org/abs/2401.00001"],
  ["D export.arxiv", "https://export.arxiv.org/abs/2401.00001", "https://arxiv.org/abs/2401.00001"],
  // E. query-only addresses (found on production data)
  ["E Sogou WeChat search", "http://weixin.sogou.com/weixin?type=2&query=MacTalk+x", { refused: "search-page" }],
  ["E Sogou click link", "https://weixin.sogou.com/link?url=dn9a_-gY295K0Rci", { refused: "search-page" }],
  ["E Baidu search", "https://www.baidu.com/s?wd=x", { refused: "search-page" }],
  ["E Bing search", "https://www.bing.com/search?q=x", { refused: "search-page" }],
  ["E dynamic script keeps its query", "https://www.dapenti.com/blog/more.asp?name=caijing&id=196796&utm_source=x", "https://www.dapenti.com/blog/more.asp?id=196796&name=caijing"],
  ["E php keeps its query", "https://example.com/index.php?p=12&from=timeline", "https://example.com/index.php?p=12"],
  ["E root keeps its query", "https://example.com/?p=123&fbclid=z", "https://example.com/?p=123"],
  ["E plain path still ignores its query", "https://example.com/post/1?id=9", "https://example.com/post/1"],
  ["E wrapper to a search page", "https://www.google.com/url?q=https%3A%2F%2Fwww.baidu.com%2Fs%3Fwd%3Dx", { refused: "search-page" }],
];

test("URL identity: the nine v0 rules and decisions A–E, one row each", () => {
  for (const [rule, input, expected] of IDENTITY) {
    const got = urlIdentity(input);
    if (typeof expected === "string") assert.deepEqual(got, { ok: true, identity: expected }, rule);
    else assert.deepEqual(got, { ok: false, reason: expected.refused }, rule);
  }
});

test("URL identity: pairs that are and are not the same address", () => {
  const same: Array<[string, string, string]> = [
    ["tracking", "https://example.com/a?utm_source=x", "https://example.com/a"],
    ["slash", "https://example.com/a/", "https://example.com/a"],
    ["fragment", "https://example.com/a#x", "https://example.com/a"],
    ["host case", "https://EXAMPLE.com/a", "https://example.com/a"],
    ["mirror", "https://twitter.com/u/status/9", "https://x.com/u/status/9"],
    ["wrapper", "https://www.google.com/url?q=https://example.com/a", "https://example.com/a/"],
  ];
  const different: Array<[string, string, string]> = [
    ["scheme", "http://example.com/a", "https://example.com/a"],
    ["path case", "https://example.com/A", "https://example.com/a"],
    ["www", "https://www.example.com/a", "https://example.com/a"],
    ["port", "https://example.com:8443/a", "https://example.com/a"],
    ["WeChat article", "https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=1&sn=x", "https://mp.weixin.qq.com/s?__biz=A&mid=2&idx=1&sn=y"],
    ["dynamic script ids", "https://www.dapenti.com/blog/more.asp?name=caijing&id=1", "https://www.dapenti.com/blog/more.asp?name=caijing&id=2"],
  ];
  for (const [label, a, b] of same) assert.equal(identityOf(a), identityOf(b), `same: ${label}`);
  for (const [label, a, b] of different) assert.notEqual(identityOf(a), identityOf(b), `different: ${label}`);
  assert.equal(identityOf("not a url"), null);
});

test("URL identity: at most three wrappers are unwrapped", () => {
  let u = "https://example.com/deep";
  for (let i = 0; i < 4; i++) u = `https://www.google.com/url?q=${encodeURIComponent(u)}`;
  assert.equal(identityOf(u), "https://www.google.com/url", "the fourth wrapper is the address itself");
  let three = "https://example.com/deep";
  for (let i = 0; i < 3; i++) three = `https://www.google.com/url?q=${encodeURIComponent(three)}`;
  assert.equal(identityOf(three), "https://example.com/deep");
});

const sig = (id: string, url: string, at: string | null = "2026-11-17T00:00:00Z"): SignalCandidate => ({ id, url, discoveredAtUtc: at });
const obs = (id: string, urls: string[], at: string | null = "2026-11-17T01:00:00Z"): SavedObservation => ({ id, urls, capturedAtUtc: at });

test("promotion gate: decision table", () => {
  type GateRow = [label: string, signals: SignalCandidate[], observations: SavedObservation[], promoted: Array<[string, string]>, awaiting: string[], invalid: string[]];
  const rows: GateRow[] = [
    ["no observations: everything waits", [sig("s1", "https://example.com/a")], [], [], ["s1"], []],
    ["same identity: promoted with the observation id", [sig("s1", "https://example.com/a?utm_source=x")], [obs("o1", ["https://example.com/a/"])], [["s1", "o1"]], [], []],
    ["http vs https: not the same", [sig("s1", "http://example.com/a")], [obs("o1", ["https://example.com/a"])], [], ["s1"], []],
    ["path case: not the same", [sig("s1", "https://example.com/A")], [obs("o1", ["https://example.com/a"])], [], ["s1"], []],
    ["invalid URL never promotes, even on an equal string", [sig("s1", "/a")], [obs("o1", ["/a"])], [], [], ["s1"]],
    ["userinfo never promotes", [sig("s1", "https://u@example.com/a")], [obs("o1", ["https://example.com/a"])], [], [], ["s1"]],
    ["the observation's guid counts (a redirected feed link)", [sig("s1", "https://example.com/final")], [obs("o1", ["https://feeds.example.net/x/123", "https://example.com/final"])], [["s1", "o1"]], [], []],
    ["mirror: twitter.com lead, x.com observation", [sig("s1", "https://twitter.com/u/status/9")], [obs("o1", ["https://x.com/u/status/9"])], [["s1", "o1"]], [], []],
    ["wrapper lead, plain observation", [sig("s1", "https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fa")], [obs("o1", ["https://example.com/a"])], [["s1", "o1"]], [], []],
    ["earliest captured observation wins", [sig("s1", "https://example.com/a")], [obs("o2", ["https://example.com/a"], "2026-11-17T02:00:00Z"), obs("o9", ["https://example.com/a"], "2026-11-17T01:00:00Z")], [["s1", "o9"]], [], []],
    ["tie on time: smallest observation id", [sig("s1", "https://example.com/a")], [obs("o2", ["https://example.com/a"]), obs("o1", ["https://example.com/a"])], [["s1", "o1"]], [], []],
    ["invalid capture time sorts after a valid one", [sig("s1", "https://example.com/a")], [obs("o0", ["https://example.com/a"], "garbage"), obs("o5", ["https://example.com/a"])], [["s1", "o5"]], [], []],
    ["duplicate candidates all point at the same observation", [sig("s2", "https://example.com/a/"), sig("s1", "https://example.com/a")], [obs("o1", ["https://example.com/a"])], [["s1", "o1"], ["s2", "o1"]], [], []],
    ["an observation without a usable URL is ignored", [sig("s1", "https://example.com/a")], [obs("o1", ["mailto:x@example.com", ""])], [], ["s1"], []],
  ];
  for (const [label, signals, observations, promoted, awaiting, invalid] of rows) {
    const r = promotionGate(signals, observations);
    assert.deepEqual(r.promoted.map((p) => [p.signalId, p.observationId]), promoted, `${label}: promoted`);
    assert.deepEqual(r.awaiting, awaiting, `${label}: awaiting`);
    assert.deepEqual(r.invalid, invalid, `${label}: invalid`);
  }
});

test("promotion gate: the answer does not depend on input order", () => {
  const signals = [sig("s3", "https://example.com/c"), sig("s1", "https://example.com/a"), sig("s2", "https://example.com/b?x=1"), sig("s4", "nope")];
  const observations = [obs("o3", ["https://example.com/a"], "2026-11-17T03:00:00Z"), obs("o1", ["https://example.com/b/"]), obs("o2", ["https://example.com/a"], "2026-11-17T02:00:00Z")];
  const base = promotionGate(signals, observations);
  for (let i = 0; i < 6; i++) {
    const shuffledS = [...signals].sort(() => (((i * 7 + 3) % 5) - 2));
    const shuffledO = [...observations].reverse();
    assert.deepEqual(promotionGate(i % 2 ? shuffledS : [...signals].reverse(), i % 2 ? shuffledO : observations), base);
  }
  assert.deepEqual(base.promoted.map((p) => [p.signalId, p.observationId]), [["s1", "o2"], ["s2", "o1"]]);
});

test("compareEarliest: valid time, then invalid time, then id", () => {
  const items = [{ id: "c", at: null }, { id: "b", at: "2026-01-02T00:00:00Z" }, { id: "a", at: "x" }, { id: "d", at: "2026-01-01T00:00:00Z" }, { id: "a2", at: "2026-01-02T00:00:00Z" }];
  assert.deepEqual([...items].sort(compareEarliest).map((i) => i.id), ["d", "a2", "b", "a", "c"]);
});

test("cap: an integer in 1..20 is kept, anything else fails closed to 20", () => {
  const rows: Array<[unknown, number]> = [
    [undefined, 20], [null, 20], [1, 1], [5, 5], [20, 20], [21, 20], [25, 20], [0, 20], [-1, 20], [1.5, 20], [Number.NaN, 20],
    [Number.POSITIVE_INFINITY, 20], ["5", 5], [" 7 ", 7], ["21", 20], ["abc", 20], ["", 20], ["1e1", 20], [{}, 20], [[3], 20], [true, 20],
  ];
  for (const [raw, expected] of rows) assert.equal(normalizeCap(raw), expected, `cap ${JSON.stringify(raw)}`);
  assert.equal(DEFAULT_PENDING_CAP, 20);
});

test("pending list: awaiting only, duplicates folded, newest first, cut to the cap", () => {
  const at = (h: number) => `2026-11-17T${String(h).padStart(2, "0")}:00:00Z`;
  const list = pendingList([
    { ...sig("s1", "https://example.com/a", at(3)), status: "awaiting" as const },
    { ...sig("s0", "https://example.com/a/?utm_source=x", at(1)), status: "awaiting" as const }, // earlier: represents /a
    { ...sig("s2", "https://example.com/b", at(5)), status: "promoted" as const },
    { ...sig("s3", "https://example.com/c", at(4)), status: "dismissed" as const },
    { ...sig("s4", "not a url", at(6)) },
    { ...sig("s5", "not a url", at(6)) }, // invalid URLs never fold
    { ...sig("s6", "https://example.com/d", "bad time") },
    { ...sig("s7", "https://example.com/e", at(6)) },
  ]);
  assert.deepEqual(list.items.map((i) => [i.id, i.duplicates, i.identity]), [
    ["s4", 0, null], ["s5", 0, null], ["s7", 0, "https://example.com/e"], ["s0", 1, "https://example.com/a"], ["s6", 0, "https://example.com/d"],
  ]);
  assert.deepEqual([list.total, list.hidden, list.cap], [5, 0, 20]);
  // Tie on discovery time between duplicates: the smallest id represents them.
  const tie = pendingList([sig("sb", "https://example.com/x"), sig("sa", "https://example.com/x/")]);
  assert.deepEqual(tie.items.map((i) => [i.id, i.duplicates]), [["sa", 1]]);
  // A duplicate with an invalid time never beats one with a valid time.
  const badTime = pendingList([sig("s1", "https://example.com/x", "nope"), sig("s9", "https://example.com/x", at(9))]);
  assert.equal(badTime.items[0]!.id, "s9");
});

test("pending list: 25 leads show 20 (the cap), a bad cap is 20, a smaller cap is honoured", () => {
  const many = Array.from({ length: 25 }, (_, i) => sig(`s${String(i).padStart(2, "0")}`, `https://example.com/${i}`, new Date(Date.UTC(2026, 10, 17, 0, i)).toISOString()));
  const full = pendingList(many);
  assert.deepEqual([full.items.length, full.total, full.hidden, full.cap], [20, 25, 5, 20]);
  assert.equal(full.items[0]!.id, "s24", "newest first");
  assert.equal(full.items[19]!.id, "s05");
  for (const cap of [0, 21, 1000, -3, "x", 2.5]) assert.equal(pendingList(many, cap).items.length, 20, `cap ${cap} fails closed`);
  assert.equal(pendingList(many, 3).items.length, 3);
  assert.deepEqual(pendingList(many, "4").items.map((i) => i.id), ["s24", "s23", "s22", "s21"]);
  // Same time: smallest id first; deterministic whatever the input order.
  const same = [sig("b", "https://example.com/b"), sig("a", "https://example.com/a"), sig("c", "https://example.com/c")];
  assert.deepEqual(pendingList(same).items.map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(pendingList([...same].reverse()).items.map((i) => i.id), ["a", "b", "c"]);
});
