// Source independence (events/independence.ts): reports that only repeat one upstream — a relay of a
// named outlet, a brief that links the original, a link post on an aggregator, a reprint of the same
// text or title — count once; a background mention ("此前据…报道") does not make a report a relay; a
// signal group counts as one voice.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignParticipant, briefOrigin, fingerprint, independentUpstreams, isAggregator, ownKey, relayedOutlet, siteOf, similarity, upstreamKeys, type UpstreamItem,
} from "@topka/backend/events/independence";

const LONG = "Acme robotics unveiled a humanoid that folds laundry and loads dishwashers in ordinary homes, with a price below twenty thousand dollars and deliveries planned for next spring across three countries.";

let n = 0;
const item = (over: Partial<UpstreamItem> & { sourceId: string }): UpstreamItem => ({
  id: `a${++n}`, sourceName: over.sourceId, aggregator: false, url: `https://${over.sourceId}.example/${n}`, title: `Title ${n}`,
  publishedAt: new Date(Date.UTC(2026, 10, 1, 0, n)), lead: "", tail: "", bodyChars: 3000, signature: [], ...over,
});

test("site and relay detection", () => {
  assert.equal(siteOf("https://www.Reuters.com/x"), "reuters.com");
  assert.equal(siteOf("ftp://x.example"), "");
  assert.equal(siteOf("nonsense"), "");
  assert.equal(relayedOutlet("据《纽约时报》报道，某公司计划裁员。"), "nytimes.com");
  assert.equal(relayedOutlet("The company plans layoffs, according to The Wall Street Journal."), "wsj.com");
  assert.equal(relayedOutlet("Acme hired a crisis firm a year ago, Wired reported."), "wired.com");
  assert.equal(relayedOutlet("近日，彭博社记者马克·古尔曼爆料，苹果正在研发新设备。"), "bloomberg.com");
  // Background, not the source of the news; and company statements are not outlets.
  assert.equal(relayedOutlet("公司发布公开信致歉。此前据《纽约时报》报道，相关调查已启动。"), null);
  assert.equal(relayedOutlet("据公司官方消息，新品下月发售。"), null);
});

test("a short brief points at the first other site it links; a long article does not", () => {
  const brief = { url: "https://brief.example/1", tail: "原文 https://www.theverge.com/a 另见 https://other.example/b" };
  assert.equal(briefOrigin(brief, 600), "theverge.com");
  assert.equal(briefOrigin(brief, 5000), null);
  assert.equal(briefOrigin({ url: "https://brief.example/1", tail: "https://github.com/x/y" }, 600), null);
});

test("near-identical bodies have close signatures; short ones have none", () => {
  assert.deepEqual(fingerprint("short"), []);
  assert.equal(similarity(fingerprint(LONG), fingerprint(`${LONG} Shared by a mirror.`)) >= 0.5, true);
  assert.equal(similarity(fingerprint(LONG), fingerprint("A completely different text about chips, earnings, data centres and the quarterly guidance of a large company in the semiconductor industry.")) < 0.5, true);
  assert.equal(similarity([], [1]), 0);
});

test("relays, briefs, link posts and reprints join their upstream; independent reports stay apart", () => {
  const original = item({ sourceId: "verge", sourceName: "The Verge · AI", url: "https://www.theverge.com/story" });
  const relay = item({ sourceId: "cn1", lead: "据 The Verge 报道，某公司发布新机器人。" });
  const hn = item({ sourceId: "hn", aggregator: true, url: "https://www.theverge.com/story" });
  const reprintA = item({ sourceId: "wx1", url: "https://weixin.sogou.com/link?url=AAA", title: "同一篇公众号文章的标题很长很长", signature: fingerprint(LONG) });
  const reprintB = item({ sourceId: "wx2", url: "https://weixin.sogou.com/link?url=BBB", title: "同一篇公众号文章的标题很长很长", signature: fingerprint(LONG) });
  const own = item({ sourceId: "wx3", url: "https://weixin.sogou.com/link?url=CCC", title: "另一家媒体自己的报道" });
  const keys = upstreamKeys([original, relay, hn, reprintA, reprintB, own]);
  assert.equal(keys.get(relay.id), keys.get(original.id));
  assert.equal(keys.get(hn.id), keys.get(original.id));
  assert.equal(keys.get(reprintA.id), keys.get(reprintB.id));
  // The same shared host with a different query is a different article.
  assert.notEqual(keys.get(own.id), keys.get(reprintA.id));
  assert.equal(independentUpstreams([original, relay, hn, reprintA, reprintB, own]), 3);
});

test("a signal group is one voice; the product merges a copy into its peer's participant only", () => {
  const a = item({ sourceId: "blog", signalGroupId: "acme" });
  const b = item({ sourceId: "x-acme", signalGroupId: "acme" });
  const c = item({ sourceId: "press" });
  assert.equal(ownKey(a), "group:acme");
  assert.equal(independentUpstreams([a, b, c]), 2);
  const orig = item({ sourceId: "reuters-src", sourceName: "Reuters", url: "https://www.reuters.com/x" });
  const copy = item({ sourceId: "cn2", lead: "据路透社报道，交易接近完成。" });
  const existing = new Map([[orig.id, "source:reuters-src"]]);
  assert.equal(assignParticipant([orig, copy], copy.id, existing, "source:cn2"), "source:reuters-src");
  assert.equal(assignParticipant([orig, c], c.id, existing, "source:press"), "source:press");
});

test("an aggregator links many sites, none of them dominant", () => {
  assert.equal(isAggregator(["a", "b", "c", "d", "e", "f"].map((h) => `https://${h}.example/x`)), true);
  assert.equal(isAggregator(Array.from({ length: 6 }, () => "https://one.example/x")), false);
  assert.equal(isAggregator([]), false);
});
