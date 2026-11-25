// Relative links in Markdown (scripts/link-check.ts): a good relative link and an https link pass, a
// relative link to nothing is reported against the file that carries it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { anchorsOf, checkLinks, linkTargets, localTarget, markdownFiles, slugOf } from "../scripts/link-check.ts";

test("a broken relative link is reported, good links are not", () => {
  const root = mkdtempSync(path.join(tmpdir(), "link-check-"));
  try {
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "README.md"), [
      "# Fixture",
      "",
      "## Section",
      "",
      "- [good](docs/guide.md)",
      "- [site](https://example.com/nope.md)",
      "- [anchor](#section)",
      "- [mail](mailto:someone@example.com)",
      "- [broken](docs/missing.md)",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n\nBack to [the readme](../README.md#fixture).\n");

    const broken = checkLinks(root, markdownFiles(root));
    assert.deepEqual(broken, [{ file: "README.md", target: "docs/missing.md" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("query strings, fragments and code blocks are not mistaken for broken links", () => {
  assert.deepEqual(linkTargets("- [a](guide.md?plain=1#top)\n\n```md\n[b](missing.md)\n```\n"), ["guide.md?plain=1#top"]);
  assert.equal(localTarget("guide.md?plain=1#top"), "guide.md");
  assert.equal(localTarget("https://example.com"), null);
  assert.equal(localTarget("#section"), null);
});

// Trial 2026-11-10: README.en linked tutorial.en.md#part-2-two-real-sources-still-no-model-key, a heading
// that had been renamed; the file existed, so the old check passed. Fragments now name a real heading.
test("a link to a missing heading is broken; GitHub's slugs (CJK, punctuation, repeats) resolve", () => {
  assert.equal(slugOf("Part 2: real articles, still no model key"), "part-2-real-articles-still-no-model-key");
  assert.equal(slugOf("第二部分：接两个真实信源，仍然不用模型 Key"), "第二部分接两个真实信源仍然不用模型-key");
  assert.equal(slugOf("HTTPS (Caddy profile)"), "https-caddy-profile");
  assert.equal(slugOf("Set <code>PORT</code> once <<b>b>"), "set-port-once");
  assert.deepEqual([...anchorsOf("# A\n## A\n<a id=\"x\"></a>\n```\n# not\n```\n")], ["a", "a-1", "x"]);
  const root = mkdtempSync(path.join(tmpdir(), "link-anchor-"));
  try {
    writeFileSync(path.join(root, "guide.md"), "# Guide\n\n## Part 2: real articles\n");
    writeFileSync(path.join(root, "README.md"), "- [ok](guide.md#part-2-real-articles)\n- [gone](guide.md#part-2-two-real-sources)\n- [lines](guide.md#L3)\n- [self](#nowhere)\n");
    assert.deepEqual(checkLinks(root, ["README.md", "guide.md"]), [
      { file: "README.md", target: "guide.md#part-2-two-real-sources" },
      { file: "README.md", target: "#nowhere" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
