import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * Every relative link in the repository's Markdown resolves: the file or
 * folder exists, and a `#fragment` names a heading in the file it points at.
 * External links are not fetched.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

function markdownFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "*.md"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(root, path)));
}

/** The text outside fenced code blocks and inline code spans, line by line. */
function proseLines(text: string): string[] {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : line.replace(/`[^`]*`/g, "");
  });
}

/** GitHub's anchor for a heading's text. */
function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

const anchorCache = new Map<string, Set<string>>();

function anchors(path: string): Set<string> {
  let found = anchorCache.get(path);
  if (found !== undefined) return found;
  found = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const base = slug(heading[1] ?? "");
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      found.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const html of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) found.add(html[1] ?? "");
  }
  anchorCache.set(path, found);
  return found;
}

function brokenLinks(file: string): string[] {
  const broken: string[] = [];
  const lines = proseLines(readFileSync(join(root, file), "utf8"));
  lines.forEach((line, index) => {
    for (const match of line.matchAll(LINK)) {
      const target = match[1] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [pathPart = "", fragment] = target.split("#", 2);
      const path = pathPart === "" ? join(root, file) : resolve(root, dirname(file), decodeURIComponent(pathPart));
      const where = `${file}:${index + 1}: ${target}`;
      if (!existsSync(path)) {
        broken.push(`${where} (no such file)`);
        continue;
      }
      if (
        fragment !== undefined &&
        fragment !== "" &&
        statSync(path).isFile() &&
        path.endsWith(".md") &&
        !anchors(path).has(decodeURIComponent(fragment).toLowerCase())
      ) {
        broken.push(`${where} (no such heading)`);
      }
    }
  });
  return broken;
}

it("resolves every relative link and heading anchor in the repository's Markdown", () => {
  const files = markdownFiles();
  expect(files.length).toBeGreaterThan(10);
  expect(files.flatMap(brokenLinks)).toEqual([]);
});
