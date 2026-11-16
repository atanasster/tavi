import { describe, expect, it } from "vitest";

import { BINDINGS_USAGE } from "../../src/features/bindings/parse.js";
import { CHANNELS_USAGE } from "../../src/features/channels/parse.js";
import { INBOX_USAGE } from "../../src/features/inbox/parse.js";
import { MODELS_USAGE } from "../../src/features/models/parse.js";
import { PERMISSIONS_USAGE } from "../../src/features/permissions/parse.js";
import { SKILLS_USAGE } from "../../src/features/skills/parse.js";
import { PLUGINS_USAGE } from "../../src/features/plugins/parse.js";
import { IDEAS_USAGE } from "../../src/features/ideas/parse.js";
import { SERVICE_USAGE } from "../../src/features/service/parse.js";
import { fittedText } from "../../src/shared/terminal-text.js";

/** A help page fitted to a terminal: each option's description wrapped once to the width, never a stranded word. */
describe("fittedText", () => {
  it("rewraps an option whose hand-wrapped lines are too wide as one description", () => {
    const page = [
      "  remove <id>   Close it, delete its secrets, revoke the people",
      "                allowed on it; its history stays",
    ].join("\n");
    expect(fittedText(page, 50)).toBe(
      [
        "  remove <id>   Close it, delete its secrets,",
        "                revoke the people allowed on it;",
        "                its history stays",
      ].join("\n"),
    );
    // Lines that fit keep the author's breaks.
    expect(fittedText(page, 80)).toBe(page);
  });

  it.each([
    ["channels", CHANNELS_USAGE],
    ["inbox", INBOX_USAGE],
    ["plugins", PLUGINS_USAGE],
    ["ideas", IDEAS_USAGE],
    ["service", SERVICE_USAGE],
    // QA 2032: descriptions under a long label, or one column deeper, and a paragraph's over-long line.
    ["permissions", PERMISSIONS_USAGE],
    ["skills", SKILLS_USAGE],
    ["models", MODELS_USAGE],
  ])("leaves no line of one or two words inside a description in `tavi %s --help` at 80 columns", (_name, usage) => {
    const source = new Set(usage.split("\n"));
    const lines = fittedText(usage, 80).split("\n");
    for (const [index, line] of lines.entries()) {
      expect(line.length, line).toBeLessThanOrEqual(80);
      // A line the fitting made, of a word or two, with the same description or paragraph going on below it, is a stranded fragment.
      const next = lines[index + 1] ?? "";
      const words = line.trim().split(/\s+/).length;
      const continued = /^ *\S/.test(next) && next.search(/\S/) === line.search(/\S/);
      if (!source.has(line) && continued) expect(words, `${line}\n${next}`).toBeGreaterThan(2);
      // Nor is a paragraph's last word cut from a line of its own source (`inbox`'s "replays / it.").
      if (!source.has(line) && /^\S/.test(line) && next.trim() === "") expect(words, line).toBeGreaterThan(2);
    }
  });

  it.each([
    ["bindings", BINDINGS_USAGE],
    ["inbox", INBOX_USAGE],
  ])("starts every description of a block in one column in `tavi %s --help` (QA 2031)", (_name, usage) => {
    for (const block of usage.split(/\n(?:[A-Z][^\n]*:)?\n/)) {
      // Each labelled row: two spaces, a name, two or more spaces, then its words.
      const starts = block
        .split("\n")
        .flatMap((line) => /^ {2}\S(?:.*?\S)? {2,}(?=\S)/.exec(line)?.[0].length ?? [])
        .filter((start) => start < 40);
      expect(new Set(starts).size, block).toBeLessThanOrEqual(1);
    }
  });

  it("gives `pair` and `revoke` their own description, not the second half of `link`'s and `unlink`'s", () => {
    expect(CHANNELS_USAGE).toMatch(/^ {2}pair \[connection\] +\S/m);
    expect(CHANNELS_USAGE).not.toMatch(/^ {2}pair \[connection\] +or the channel's deep link/m);
    expect(CHANNELS_USAGE).not.toMatch(/^ {2}revoke <connection> <sender> connection \(or/m);
  });
});
