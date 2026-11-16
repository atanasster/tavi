import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { recordText } from "../../src/cli/output.js";
import { parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";

const directories = temporaryDirectories({ prefix: "tavi-format-" });
afterEach(() => directories.cleanup());

describe("--format, every command's", () => {
  it("is taken by commands that did not read it themselves, and by those that do", () => {
    expect(parseArgs(["models", "list", "--format", "json"])).toMatchObject({ command: "models", format: "json" });
    expect(parseArgs(["models", "roles", "--format=text"])).toMatchObject({ command: "models", format: "text" });
    expect(parseArgs(["tasks", "--format", "json"])).toMatchObject({ command: "tasks", format: "json" });
    expect(parseArgs(["doctor", "--format", "text"])).toMatchObject({ command: "doctor", format: "text" });
    expect(parseArgs(["tasks", "folder", "task-1", "--format", "json"])).toMatchObject({ format: "json" });
    expect(parseArgs(["approvals", "list", "--format", "text"])).toMatchObject({ command: "approvals", format: "text" });
    expect(parseArgs(["router", "status", "--format", "text"])).toMatchObject({ format: "text" });
  });

  it("is refused plainly for an interactive command, and for a value it does not take", () => {
    expect(() => parseArgs(["chat", "--format", "json"])).toThrow("tavi chat is interactive and has no JSON form: drop --format json");
    expect(() => parseArgs(["models", "list", "--format", "yaml"])).toThrow('--format takes text or json, not "yaml"');
    expect(() => parseArgs(["models", "list", "--format", "json", "--format", "text"])).toThrow("--format may be given only once");
    expect(() => parseArgs(["models", "list", "--json", "--format", "text"])).toThrow("--json and --format text disagree");
  });

  it("prints a JSON-only answer as text under --format text, never JSON", async () => {
    const directory = directories.create();
    const listed = capture();
    expect(await main(["models", "roles", "--format", "text", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).not.toMatch(/^\s*[{[]/);
    expect(listed.stdout()).toContain("workspaceDefault: -");
    const doctor = capture();
    await main(["doctor", "--format", "text", "--data-dir", directory], { io: doctor.io });
    expect(doctor.stdout()).toContain("Database: quick check");
    expect(doctor.stdout()).toContain("The whole report: tavi doctor --format json");
  });
});

describe("own help pages", () => {
  it("answers doctor, needs and answer --help with their own pages", async () => {
    for (const [argv, first] of [
      [["doctor", "--help"], "tavi doctor [--deep] [options]"],
      [["needs", "--help"], "tavi needs [--limit <n>] [options]"],
      [["answer", "--help"], "tavi answer <task-id> <answer> [options]"],
    ] as const) {
      const shown = capture();
      expect(await main(argv, { io: shown.io })).toBe(EXIT.ok);
      expect(shown.stdout().split("\n")[0], argv.join(" ")).toBe(first);
    }
  });
});

describe("recordText", () => {
  it("prints a record as key: value lines, nested ones indented, a list's entries with -", () => {
    expect(recordText({ a: 1, b: null, c: { d: "x" }, e: [{ f: true }, "g"], h: [] })).toBe(
      "a: 1\nb: -\nc:\n  d: x\ne:\n  -\n    f: true\n  - g\nh: (none)\n",
    );
  });

  it("says (none) for an empty map, as for an empty list, never a key with nothing after it", () => {
    expect(recordText({ settings: { providerSettings: {}, featureThresholds: {} }, list: [{}] })).toBe(
      "settings:\n  providerSettings: (none)\n  featureThresholds: (none)\nlist:\n  -\n    (none)\n",
    );
  });
});
