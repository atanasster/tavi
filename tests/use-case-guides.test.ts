import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseArgs } from "../apps/cli/src/cli/parse.js";
import { type IdeaCapability, ideaCapabilityLabel } from "../packages/contracts/src/ideas.js";
import { IDEA_CATALOGUE } from "../packages/plugin-kit/src/ideas/catalogue.js";
import { type Guide, guidesRoot, imagesRoot, indexes, listGuides, stepImagePath } from "../scripts/docs/guides.mjs";

/**
 * The how-to guides under docs/use-cases/ keep their shape (title, lead,
 * context box, numbered steps with one picture each, Related), their pictures
 * exist where the walks write them and stay small, each has a walk in
 * tests/guides/, the indexes are the ones the pages generate, every everyday
 * recipe matches its Ideas template, and every `tavi …` command a guide shows
 * is one the CLI accepts.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** `path` from the repository's root, with `/` on every platform (as the guides and their indexes write it). */
const fromRoot = (path: string): string => relative(root, path).split(sep).join("/");
const guides = listGuides();
const recipes = guides.filter((guide) => guide.folder.startsWith("everyday/"));

/**
 * The Ideas templates with no recipe page yet, by key. Writing a recipe takes its key off; a template added to the
 * catalogue fails the check until it is listed here or its recipe is written.
 */
const RECIPES_TO_WRITE: ReadonlySet<string> = new Set(["health-home.load-shift"]);

const MAX_IMAGE_BYTES = 250 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const name = (guide: Guide) => `${guide.folder}/${guide.slug}`;

describe.each(guides.map((guide) => [name(guide), guide] as const))("%s", (_, guide) => {
  const recipe = guide.folder.startsWith("everyday/");

  it("has a title, a lead and a context box", () => {
    expect(guide.title).not.toBe("");
    expect(guide.lead).not.toBe("");
    expect(Object.keys(guide.context)).toContain("Uses");
    expect(Object.keys(guide.context)).toContain("Before you start");
  });

  it("numbers its steps from 1, each with exactly one picture", () => {
    const [fewest, most] = recipe ? [2, 6] : [4, 9];
    expect(guide.steps.length).toBeGreaterThanOrEqual(fewest);
    expect(guide.steps.length).toBeLessThanOrEqual(most);
    expect(guide.steps.map((step) => step.number)).toEqual(guide.steps.map((_, index) => index + 1));
    for (const step of guide.steps) {
      expect(step.images, `${step.title}: one picture`).toHaveLength(1);
      expect(step.body, `${step.title}: what to do`).not.toBe("");
    }
  });

  it("shows each step's picture at the path its walk writes, with alt text and a dark twin for a terminal", () => {
    for (const step of guide.steps) {
      const image = step.images[0];
      if (image === undefined) continue;
      expect(image.alt.trim(), `${step.title}: alt text`).not.toBe("");
      const kind = image.src.endsWith(".svg") ? "svg" : "webp";
      const expected = stepImagePath(guide, step, kind);
      expect(fromRoot(join(dirname(guide.file), image.src)), step.title).toBe(expected);
      expect(existsSync(join(root, expected)), `${expected} exists`).toBe(true);
      if (kind === "svg") {
        const dark = expected.replace(/\.svg$/, "-dark.svg");
        expect(image.dark === undefined ? undefined : fromRoot(join(dirname(guide.file), image.dark)), step.title).toBe(dark);
        expect(existsSync(join(root, dark)), `${dark} exists`).toBe(true);
      }
    }
  });

  it("ends with what Tavi will and won't do (guides) and Related", () => {
    expect(guide.sections.at(-1)).toBe("Related");
    if (!recipe) expect(guide.sections).toContain("What Tavi will and won't do");
  });

  it("has a walk in tests/guides/", () => {
    expect(existsSync(join(root, "tests/guides", guide.folder, `${guide.slug}.guide.test.ts`))).toBe(true);
  });

  it("shows only tavi commands the CLI accepts", () => {
    for (const command of taviCommands(guide.text)) {
      expect(() => parseArgs(command.argv), `\`${command.text}\``).not.toThrow();
    }
  });
});

/** Every `tavi …` the page shows, in inline code or a code block, as the words a shell would pass. */
function taviCommands(text: string): { text: string; argv: string[] }[] {
  const snippets = [
    ...[...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((match) => (match[1] ?? "").split("\n")),
    ...[...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? ""),
  ];
  return snippets
    .map((snippet) => snippet.trim())
    .filter((snippet) => /^tavi\s/.test(snippet))
    .map((snippet) => ({ text: snippet, argv: words(snippet).slice(1) }));
}

/** Home in the guides' commands. */
const HOME = "/home/reader";

/**
 * A command line's words: quotes group, a placeholder (`<task-id>`) stands for a
 * value, and an unquoted `~` is home, as a shell reads it. Home is a fixed POSIX
 * folder, not this host's: the guides' commands are POSIX shell lines, and on
 * Windows the home folder would spell `~/x` as `C:\Users\me/x`.
 */
function words(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const bare = match[3];
    const word = match[1] ?? match[2] ?? (bare !== undefined && /^~(?:\/|$)/.test(bare) ? `${HOME}${bare.slice(1)}` : bare) ?? "";
    out.push(/^<[^>]+>$/.test(word) ? "x" : word);
  }
  return out;
}

it("has one recipe page per Ideas template still to write, and none for anything else", () => {
  const keys = new Map(IDEA_CATALOGUE.map((template) => [template.key, template]));
  const written = new Set<string>();
  for (const guide of recipes) {
    const key = /\(`([^`]+)`\)/.exec(guide.context["Idea card"] ?? "")?.[1];
    expect(key === undefined ? undefined : keys.has(key), `${name(guide)} names an Ideas template`).toBe(true);
    if (key === undefined) continue;
    expect(written.has(key), `${key} has one recipe`).toBe(false);
    written.add(key);
    expect(guide.slug, `${name(guide)}: its slug is the key without its prefix`).toBe(key.slice(key.indexOf(".") + 1));
  }
  const missing = [...keys.keys()].filter((key) => !written.has(key)).sort();
  expect(missing, "take a written recipe off RECIPES_TO_WRITE").toEqual([...RECIPES_TO_WRITE].sort());
});

it("gives every recipe the context box of its Ideas template", () => {
  const label = (capabilities: readonly IdeaCapability[]) => capabilities.map((capability) => ideaCapabilityLabel(capability)).join(" · ");
  for (const guide of recipes) {
    const key = /\(`([^`]+)`\)/.exec(guide.context["Idea card"] ?? "")?.[1];
    const template = IDEA_CATALOGUE.find((candidate) => candidate.key === key);
    if (template === undefined) continue;
    expect(guide.context["Uses"], name(guide)).toBe(label(template.requires));
    expect(guide.context["Asks first"], name(guide)).toBe(
      template.asks === undefined || template.asks.length === 0 ? "Nothing — it only reads and suggests" : label(template.asks),
    );
    expect(guide.context["Runs"], name(guide)).toBe(
      template.cadence === "daily" ? "Daily" : template.cadence === "weekly" ? "Weekly" : "When you ask",
    );
    expect(guide.context["Idea card"], name(guide)).toBe(`"${template.label}" (\`${template.key}\`)`);
  }
});

it("keeps every walk beside a guide page", () => {
  const walks = join(root, "tests/guides");
  const files = readdirSync(walks, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".guide.test.ts"));
  const pages = new Set(guides.map((guide) => `${name(guide)}.guide.test.ts`));
  expect(files.filter((file) => !pages.has(file.split("\\").join("/")))).toEqual([]);
});

it("keeps the indexes the guides generate (pnpm docs:indexes)", () => {
  const wanted = indexes(guides);
  for (const { path, text } of wanted) {
    expect(existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined, path).toBe(text);
  }
  const stray = readdirSync(guidesRoot, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith("README.md"))
    .map((file) => `docs/use-cases/${file.split("\\").join("/")}`)
    .filter((path) => !wanted.some((index) => index.path === path));
  expect(stray).toEqual([]);
});

it("keeps the guides' pictures small, and only the ones a guide shows", () => {
  if (!existsSync(imagesRoot)) return;
  const shown = new Set(
    guides.flatMap((guide) =>
      guide.steps.flatMap((step) =>
        step.images.flatMap((image) =>
          [image.src, ...(image.dark === undefined ? [] : [image.dark])].map((src) => fromRoot(join(dirname(guide.file), src))),
        ),
      ),
    ),
  );
  let total = 0;
  for (const file of readdirSync(imagesRoot, { recursive: true, encoding: "utf8" })) {
    const path = join(imagesRoot, file);
    if (!statSync(path).isFile()) continue;
    const size = statSync(path).size;
    total += size;
    expect(size, `${file} is at most 250 KB`).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(shown.has(fromRoot(path)), `docs/assets/use-cases/${file} is shown by a guide`).toBe(true);
  }
  expect(total, "all the guides' pictures together").toBeLessThanOrEqual(MAX_TOTAL_BYTES);
});

it("finds the guides at all", () => {
  // A parser that silently read nothing would pass every check above.
  expect(guides.length).toBeGreaterThan(0);
});

it("shows no path of this machine, and nothing shaped like a key, in a guide's terminal pictures or alt text", () => {
  const leaks = /\/Users\/|\/home\/[a-z]|sk-or-v1-|sk-ant-|Bearer [A-Za-z0-9]|tavi-docs-[A-Za-z0-9]{4}/;
  const texts = [
    ...guides.flatMap((guide) =>
      guide.steps.flatMap((step) => step.images.map((image) => [`${name(guide)}: ${step.title}`, image.alt] as const)),
    ),
    ...(existsSync(imagesRoot)
      ? readdirSync(imagesRoot, { recursive: true, encoding: "utf8" })
          .filter((file) => file.endsWith(".svg"))
          .map((file) => [file, readFileSync(join(imagesRoot, file), "utf8")] as const)
      : []),
  ];
  expect(texts.filter(([, text]) => leaks.test(text)).map(([where]) => where)).toEqual([]);
});
