// Relative links in Markdown (scripts/link-check.ts): a good relative link and an https link pass, a
// relative link to nothing is reported against the file that carries it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkLinks, linkTargets, localTarget, markdownFiles } from "../scripts/link-check.ts";

test("a broken relative link is reported, good links are not", () => {
  const root = mkdtempSync(path.join(tmpdir(), "link-check-"));
  try {
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "README.md"), [
      "# Fixture",
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
