import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { guidesRoot } from "../scripts/docs/guides.mjs";

/**
 * A guide's Markdown renders as written. A line that starts with an HTML tag
 * (a `<picture>`, a `<details>`) opens a CommonMark HTML block that runs to the
 * next blank line, so a heading written directly under `</picture>` is printed
 * as literal "## 2. …" text, with no anchor for the step.
 */

/** Each `#` heading that sits inside an HTML block, as "line: text". */
function headingsInHtmlBlocks(text: string): string[] {
  const swallowed: string[] = [];
  let fence: string | undefined;
  let inHtml = false;
  let inComment = false;
  text.split("\n").forEach((line, index) => {
    const fenceMark = /^\s{0,3}(```|~~~)/.exec(line)?.[1];
    if (fence !== undefined) {
      if (fenceMark === fence) fence = undefined;
      return;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      return;
    }
    if (inHtml) {
      if (line.trim() === "") inHtml = false;
      else if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) swallowed.push(`${index + 1}: ${line}`);
      return;
    }
    if (fenceMark !== undefined) fence = fenceMark;
    else if (/^\s{0,3}<!--/.test(line)) inComment = !line.includes("-->");
    else if (/^\s{0,3}<\/?[a-z][a-z0-9-]*(\s|>|\/>|$)/i.test(line)) inHtml = true;
  });
  return swallowed;
}

const pages = readdirSync(guidesRoot, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".md"));

describe("guide Markdown", () => {
  it("finds a heading written directly under an HTML block", () => {
    expect(headingsInHtmlBlocks('<picture>\n  <img src="a.svg" alt="a">\n</picture>\n## 2. Next\n')).toEqual(["4: ## 2. Next"]);
    expect(headingsInHtmlBlocks('<picture>\n  <img src="a.svg" alt="a">\n</picture>\n\n## 2. Next\n')).toEqual([]);
    expect(headingsInHtmlBlocks("```html\n<picture>\n## not a heading\n```\n")).toEqual([]);
  });

  it.each(pages)("%s has no heading swallowed by an HTML block", (page) => {
    expect(headingsInHtmlBlocks(readFileSync(join(guidesRoot, page), "utf8"))).toEqual([]);
  });
});
