import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The documentation's images stay used, described and small: every file under
 * docs/assets is shown by some tracked Markdown page, every image a page shows
 * has alt text, and none is past the budget a README can load quickly. The
 * screenshots are retaken with `node scripts/docs/capture-ui.mjs`, the banner
 * with `node scripts/docs/render-assets.mjs`.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET_BYTES = 250 * 1024;

const tracked = (pattern: string): string[] =>
  execFileSync("git", ["ls-files", "-z", "--", pattern], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "");

interface Shown {
  readonly path: string;
  readonly alt: string;
}

/** A tag's attribute, double-, single- or un-quoted; `undefined` when the tag has none. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3] ?? "");
}

/**
 * Each image some Markdown shows, outside code and comments: `![alt](path)`,
 * an `<img>` (with its alt, empty when it has none) and each candidate of a
 * `<source>`'s srcset, which borrows the alt of its `<picture>`'s `<img>`.
 */
function images(text: string): Shown[] {
  const prose = text.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*(```|~~~)[\s\S]*?^\s*\1/gm, "");
  const found: Shown[] = [];
  for (const match of prose.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) found.push({ alt: match[1] ?? "", path: match[2] ?? "" });
  for (const match of prose.matchAll(/<(img|source)\b[^>]*>/gi)) {
    const tag = match[0];
    if (match[1]?.toLowerCase() === "img") {
      const src = attribute(tag, "src");
      if (src !== undefined) found.push({ alt: attribute(tag, "alt") ?? "", path: src });
    } else {
      for (const candidate of (attribute(tag, "srcset") ?? "").split(",")) {
        const path = candidate.trim().split(/\s+/)[0];
        if (path !== undefined && path !== "") found.push({ alt: "(picture)", path });
      }
    }
  }
  return found.filter((image) => !/^[a-z]+:/i.test(image.path));
}

const pages = tracked("*.md");
const shown = pages.flatMap((page) =>
  images(readFileSync(join(root, page), "utf8")).map((image) => ({
    page,
    alt: image.alt,
    // As `git ls-files` names them, `/` on every platform.
    path: posix.normalize(posix.join(posix.dirname(page), image.path.split("#")[0] ?? "")),
  })),
);
const assets = tracked("docs/assets/**");

describe("reading images out of Markdown", () => {
  it.each([
    ["![A chat](a.png)", [{ alt: "A chat", path: "a.png" }]],
    ['<img src="a.png" alt="A chat">', [{ alt: "A chat", path: "a.png" }]],
    ["<img src='a.png' alt='A chat'>", [{ alt: "A chat", path: "a.png" }]],
    ["<img src=a.png>", [{ alt: "", path: "a.png" }]],
    ['<img data-src="x.png" src="a.png" data-alt="no">', [{ alt: "", path: "a.png" }]],
    [
      '<source srcset="a.png 1x, b.png 2x">',
      [
        { alt: "(picture)", path: "a.png" },
        { alt: "(picture)", path: "b.png" },
      ],
    ],
    ["```\n![In code](a.png)\n```", []],
    ["<!-- ![Hidden](a.png) -->", []],
    ["![Remote](https://example.com/a.png)", []],
  ])("%s", (text, expected) => {
    expect(images(text)).toEqual(expected);
  });
});

describe("the documentation's images", () => {
  it("finds the images and the pages that show them", () => {
    expect(assets.length).toBeGreaterThan(0);
    expect(shown.length).toBeGreaterThan(0);
  });

  it("every image under docs/assets is shown by a page", () => {
    const used = new Set(shown.map((image) => image.path));
    expect(assets.filter((asset) => !used.has(asset))).toEqual([]);
  });

  it("every image a page shows has alt text", () => {
    expect(shown.filter((image) => image.alt.trim() === "").map((image) => `${image.page}: ${image.path}`)).toEqual([]);
  });

  it("every image under docs/assets is within the budget", () => {
    expect(assets.filter((asset) => statSync(join(root, asset)).size > BUDGET_BYTES)).toEqual([]);
  });
});
