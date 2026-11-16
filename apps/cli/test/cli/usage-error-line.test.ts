import { capture } from "@tavi/test-support";
import { describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * A usage error is one line: what was wrong, the nearest valid action or
 * option when one is close, and where the whole page is. Only `--help`
 * prints the page.
 */
async function refused(argv: readonly string[]): Promise<string> {
  const captured = capture();
  expect(await main(argv, { io: captured.io }), argv.join(" ")).toBe(EXIT.usage);
  expect(captured.stdout()).toBe("");
  const text = captured.stderr();
  expect(
    text.split("\n").filter((line) => line !== ""),
    argv.join(" "),
  ).toHaveLength(1);
  return text;
}

describe("a usage error", () => {
  it("names the nearest action and points at the command's help", async () => {
    const text = await refused(["permissions", "lst"]);
    expect(text).toMatch(/did you mean list\?/);
    expect(text).toMatch(/See `tavi permissions --help`\.\n$/);
  });

  it("names the nearest option", async () => {
    expect(await refused(["backup", "--outt", "/tmp/x"])).toMatch(/did you mean --out\?.*See `tavi backup --help`\.\n$/);
  });

  it("names the nearest command, pointing at tavi --help", async () => {
    expect(await refused(["modles"])).toMatch(/^Unknown command "modles"; did you mean models\? See `tavi --help`\.\n$/);
  });

  it("is one line even when nothing is near", async () => {
    expect(await refused(["permissions", "zzzzzz"])).toMatch(/See `tavi permissions --help`\.\n$/);
  });

  it("leaves --help printing the whole page", async () => {
    const captured = capture();
    expect(await main(["permissions", "--help"], { io: captured.io })).toBe(EXIT.ok);
    expect(captured.stdout().split("\n").length).toBeGreaterThan(10);
  });
});

describe("a removal action", () => {
  it("answers to rm, remove and delete in every command", async () => {
    const { parseArgs } = await import("../../src/cli/parse.js");
    for (const argv of [
      ["permissions", "*", "rule-1"],
      ["agents", "*", "a1"],
      ["apps", "*", "gmail"],
      ["channels", "*", "c1"],
      ["channels", "rooms", "c1", "*", "room-1"],
      ["plugins", "*", "p1"],
      ["projects", "*", "acme"],
      ["schedules", "*", "s1"],
      ["search", "*", "brave"],
      ["todos", "*", "todo-1"],
    ]) {
      const parsed = ["rm", "remove", "delete"].map((name) => JSON.stringify(parseArgs(argv.map((part) => (part === "*" ? name : part)))));
      expect(new Set(parsed).size, argv.join(" ")).toBe(1);
    }
  });
});
