import { capture } from "@tavi/test-support";
import { describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { SERVE_USAGE } from "../../src/server/parse.js";

/** A command's `--help` fits the terminal's columns, 80 in a pipe, its words whole and its descriptions in their column. */
describe("--help width", () => {
  const help = async (columns: number | undefined): Promise<string> => {
    const shown = capture();
    expect(await main(["serve", "--help"], { io: { ...shown.io, columns } })).toBe(EXIT.ok);
    return shown.stdout();
  };
  const words = (text: string): string => text.replace(/\s+/g, " ").trim();

  it.each([
    [undefined, 80],
    [100, 100],
    [60, 60],
  ])("serve --help at %s columns stays within %i", async (columns, width) => {
    const text = await help(columns);
    for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(width);
    expect(words(text)).toBe(words(SERVE_USAGE));
  });

  it("carries a long option's description on in its own column", async () => {
    const lines = (await help(80)).split("\n");
    const at = lines.findIndex((line) => line.startsWith("  --data-dir <path>"));
    const column = lines[at]?.indexOf("Data directory") ?? -1;
    expect(lines[at + 1]?.slice(0, column).trim()).toBe("");
    expect(lines[at + 1]?.[column]).toMatch(/\S/);
  });
});
