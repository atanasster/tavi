import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { usages } from "../support/usages.js";

/**
 * docs/CLI.md documents what each command's `--help` offers: every flag a
 * usage text names, and every action it lists, appears in
 * that command's sections of the reference (a `### \`tavi <command>…\``
 * heading and what follows it, up to the next such heading) or among the
 * global and common flags. A flag added to a parser without a word in the
 * reference fails here.
 */

const docPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/CLI.md");
const doc = readFileSync(docPath, "utf8");

/** The text under each `### ` heading, keyed by the heading. */
function sections(): Map<string, string> {
  const found = new Map<string, string>();
  let heading: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (heading !== undefined) found.set(heading, body.join("\n"));
  };
  for (const line of doc.split("\n")) {
    if (/^#{2,3} /.test(line)) {
      flush();
      heading = line.replace(/^#{2,3} /, "");
      body = [];
    } else body.push(line);
  }
  flush();
  return found;
}

const bySection = sections();
const shared = [...bySection].filter(([heading]) => /^(Global Flags|Common flags)/i.test(heading)).map(([, body]) => body);

/** The reference text for the commands a usage text's synopsis lines name, then the shared flags. */
function commandText(commands: readonly string[]): string {
  const own = [...bySection].filter(([heading]) =>
    commands.some((command) => heading.startsWith(`\`tavi ${command}\``) || heading.startsWith(`\`tavi ${command} `)),
  );
  return [...own.map(([heading, body]) => `${heading}\n${body}`), ...shared].join("\n");
}

/** The commands a usage text's synopsis lines name: the tasks usage also gives `tavi doctor`. */
function commandsOf(usage: string): string[] {
  const commands = [...new Set([...usage.matchAll(/^tavi ([a-z-]+)/gm)].map((match) => match[1] ?? ""))];
  if (commands.length === 0) throw new Error(`a usage text that does not start with tavi <command>: ${usage.slice(0, 60)}`);
  return commands;
}

/** Each whole flag a usage text names; a family written `--http-*`, or one passed on as `--serve-arg=--x`, is not one. */
function flagsOf(usage: string): string[] {
  return [...new Set([...usage.matchAll(/(?<![\w=-])--[a-z][a-z0-9-]*[a-z0-9](?![\w*-])/g)].map((match) => match[0]))];
}

/**
 * The actions a usage text names: the word after `tavi <command>` on a
 * synopsis line (`tavi browser site-notes …` gives `site-notes`), and each
 * indented action line's leading word or words (`  enable|disable <id>`).
 */
function actionsOf(usage: string, commands: readonly string[]): string[] {
  const synopsis = commands.flatMap((command) =>
    [...usage.matchAll(new RegExp(`^tavi ${command} ([a-z][a-z-]+)`, "gm"))].map((match) => match[1] ?? ""),
  );
  const listed = [...usage.matchAll(/^ {2}([a-z][a-z-]*(?:\|[a-z][a-z-]*)*)(?=[ <[]|$)/gm)].flatMap((match) => (match[1] ?? "").split("|"));
  return [...new Set([...synopsis, ...listed])];
}

/** `word` stands alone in the text: not inside a longer word (`folder` in `folders`). */
function named(text: string, word: string): boolean {
  return new RegExp(`(?<![\\w-])${word}(?![\\w-])`).test(text);
}

describe("docs/CLI.md", () => {
  it.each(usages)("documents every flag and subcommand of %s", (_name, usage) => {
    const commands = commandsOf(usage);
    const text = commandText(commands);
    expect(text, `docs/CLI.md has no section for tavi ${commands.join(", ")}`).not.toBe(shared.join("\n"));
    const missing = [
      ...flagsOf(usage).filter((flag) => !named(text, flag)),
      ...actionsOf(usage, commands).filter((word) => !named(text, word)),
    ];
    expect(missing.join(" "), `tavi ${commands.join(", ")}: in --help but not in docs/CLI.md`).toBe("");
  });
});
