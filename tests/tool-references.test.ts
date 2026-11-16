import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * Every tool the system prompt names is a tool that exists. A name the prompt
 * teaches and the registry does not hold is a call the model makes and the
 * dispatcher refuses, on every turn that reads it.
 *
 * The registered ids are read from the sources (`id: "family.name"`, or a
 * `…_ID = "family.name"` constant), so the check needs no runtime
 * wiring. A family whose ids are built from a template is listed in
 * `TEMPLATED_FAMILIES` and accepts any name.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Families whose tool ids are assembled at registration, so no literal names each one. */
const TEMPLATED_FAMILIES: readonly string[] = ["routines"];

const TOOL_ID = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

function sourceFiles(): string[] {
  // A git pathspec's `*` crosses `/`: these match every source file under any depth of each package's `src`.
  return execFileSync("git", ["ls-files", "-z", "--", "apps/*/src/*.ts", "packages/*/src/*.ts"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path !== "" && !path.endsWith(".d.ts"));
}

function registeredToolIds(): Set<string> {
  const ids = new Set<string>();
  for (const path of sourceFiles()) {
    for (const line of readFileSync(join(root, path), "utf8").split("\n")) {
      const at = line.search(/\bid:\s|_ID\s*=/);
      if (at === -1) continue;
      for (const match of line.slice(at).matchAll(/"([^"]+)"/g)) {
        const id = match[1] as string;
        if (TOOL_ID.test(id)) ids.add(id);
      }
    }
  }
  return ids;
}

/** Backticked `family.name` tokens whose family is a tool family: the ones a reader takes for a tool. */
function namedTools(text: string, families: ReadonlySet<string>): string[] {
  const named = new Set<string>();
  for (const match of text.matchAll(/`([a-z][a-z_]*\.[a-z][a-z_]*)`/g)) {
    const id = match[1] as string;
    if (families.has(id.slice(0, id.indexOf(".")))) named.add(id);
  }
  return [...named];
}

it("the system prompt names only registered tools", () => {
  const ids = registeredToolIds();
  // The scan found the registrations: an empty set would pass the check below without checking anything.
  expect(ids).toContain("browser.close");
  expect(ids).toContain("tools.search");
  const families = new Set([...ids].map((id) => id.slice(0, id.indexOf("."))));
  const prompt = readFileSync(join(root, "packages/agent-host/src/prompts/system-prompt.ts"), "utf8");
  const unknown = namedTools(prompt, families).filter(
    (id) => !ids.has(id) && !TEMPLATED_FAMILIES.some((family) => id.startsWith(`${family}.`)),
  );
  expect(unknown).toEqual([]);
});

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y;

/**
 * The text of every tool and field description in `source`: the string
 * literals after `description:` or `.describe(`, joined across `+`. A
 * template's `${…}` holes are code, not text, and are left out.
 */
function descriptionTexts(source: string): string[] {
  const texts: string[] = [];
  for (const start of source.matchAll(/\bdescription:\s*|\.describe\(\s*/g)) {
    let at = (start.index ?? 0) + start[0].length;
    let text = "";
    for (;;) {
      LITERAL.lastIndex = at;
      const literal = LITERAL.exec(source);
      if (literal === null) break;
      text += literal[0].slice(1, -1).replace(/\$\{[^}]*\}/g, " ");
      const joined = /^\s*\+\s*/.exec(source.slice(LITERAL.lastIndex));
      if (joined === null) break;
      at = LITERAL.lastIndex + joined[0].length;
    }
    if (text !== "") texts.push(text);
  }
  return texts;
}

/** `family.name` tokens in `text` whose family is a tool family: what a description tells the model to call. */
function toolNamesIn(text: string, families: ReadonlySet<string>): string[] {
  const named = new Set<string>();
  for (const match of text.matchAll(/(?<![\w.$/-])([a-z][a-z_]*)\.([a-z][a-z_]*)(?![\w(-]|\.\w)/g)) {
    if (families.has(match[1] as string)) named.add(`${match[1]}.${match[2]}`);
  }
  return [...named];
}

it("tool descriptions name only registered tools", () => {
  const ids = registeredToolIds();
  const families = new Set([...ids].map((id) => id.slice(0, id.indexOf("."))));
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const path of sourceFiles()) {
    const names = descriptionTexts(readFileSync(join(root, path), "utf8")).flatMap((text) => toolNamesIn(text, families));
    for (const id of new Set(names)) {
      seen.add(id);
      if (!ids.has(id) && !TEMPLATED_FAMILIES.some((family) => id.startsWith(`${family}.`))) unknown.push(`${path}: ${id}`);
    }
  }
  // The scan read descriptions: pdf.overlay's description names pdf.fill, agents.request's names agents.wait.
  expect(seen).toContain("pdf.fill");
  expect(seen).toContain("agents.wait");
  expect(unknown).toEqual([]);
});
