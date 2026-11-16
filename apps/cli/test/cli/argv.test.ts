import { describe, expect, it } from "vitest";

import { UsageError, integerFlag, parseFlags } from "../../src/cli/argv.js";
import { parseArgs } from "../../src/cli/parse.js";

describe("the duplicate-flag rule", () => {
  it.each([
    ["run", ["run", "hi", "--model", "a", "--model", "b"], "--model"],
    ["serve", ["serve", "--log-file", "a", "--log-file", "b"], "--log-file"],
    ["chat", ["chat", "--workspace", "a", "--workspace", "b"], "--workspace"],
    ["ui", ["ui", "--port", "1", "--port", "2"], "--port"],
    ["abort", ["abort", "t", "--data-dir", "a", "--data-dir", "b"], "--data-dir"],
    ["doctor", ["doctor", "--data-dir", "a", "--data-dir=b"], "--data-dir"],
    ["tasks history", ["tasks", "history", "t", "--workspace", "a", "--workspace", "b"], "--workspace"],
    ["tasks folders prune", ["tasks", "folders", "prune", "--chat", "a", "--chat", "b"], "--chat"],
    ["models", ["models", "add", "c", "--model", "a", "--model", "b"], "--model"],
    ["memory", ["memory", "search", "q", "--format", "json", "--format", "text"], "--format"],
    ["skills", ["skills", "list", "--format", "json", "--format", "text"], "--format"],
    ["plugins", ["plugins", "list", "--format", "json", "--format", "text"], "--format"],
    ["channels", ["channels", "list", "--format", "json", "--format", "text"], "--format"],
    ["service", ["service", "unit", "--label", "a", "--label", "b"], "--label"],
    ["reports", ["reports", "list", "--format", "json", "--format", "text"], "--format"],
  ])("refuses a repeated single-valued flag in tavi %s", (_command, argv, flag) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(`${flag} may be given only once`);
  });

  it("keeps a repeatable flag's values in order, and a pass-through value verbatim", () => {
    const parsed = parseFlags(["--serve-arg", "--model", "--serve-arg=x", "--tag", "a", "--tag", "b"], {
      usage: "",
      lists: ["--serve-arg", "--tag"],
      verbatim: ["--serve-arg"],
    });
    expect(parsed).not.toBe("help");
    if (parsed === "help") return;
    expect(parsed.lists.get("--serve-arg")).toEqual(["--model", "x"]);
    expect(parsed.lists.get("--tag")).toEqual(["a", "b"]);
  });

  it.each([
    [["serve", "--drain-deadine", "5"], "serve does not accept --drain-deadine"],
    [["run", "hi", "--bogus", "x"], "run does not accept --bogus"],
    [["run", "hi", "--", "x"], "run does not accept --"],
    [["channels", "add", "telegram", "--", "x"], "channels add does not accept --"],
  ])("refuses a flag the command does not take: %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it("still takes channels add's free-form settings as flags", () => {
    expect(parseArgs(["channels", "add", "telegram", "--chat-id", "42"])).toMatchObject({
      channels: { settings: { "chat-id": "42" } },
    });
  });

  it("says what an empty --yes= on memory config lacks", () => {
    expect(() => parseArgs(["memory", "config", "retrieval", "hybrid", "--yes="])).toThrow(
      "--yes= needs the connection its disclosure named: --yes=<connection>",
    );
  });
});

describe("a whole-number flag", () => {
  it("takes digits within its bounds", () => {
    expect(integerFlag("50", { min: 1 }, "no", "usage")).toBe(50);
    expect(integerFlag("0", { min: 0, max: 0 }, "no", "usage")).toBe(0);
  });

  it.each(["50abc", "1e3", "-1", "2.0", "", " 5", "0x10", "99999999999999999"])("refuses %j", (raw) => {
    expect(() => integerFlag(raw, { min: 0 }, "--limit takes a whole number", "usage")).toThrow(UsageError);
  });

  it("refuses a value outside its bounds with the command's own message", () => {
    expect(() => integerFlag("0", { min: 1 }, "--limit must be positive", "usage")).toThrow("--limit must be positive");
    expect(() => integerFlag("53", { min: 1, max: 52 }, "--limit is 1 to 52", "usage")).toThrow("--limit is 1 to 52");
  });

  it.each([
    [["inbox", "--limit", "50abc"]],
    [["reports", "--limit", "5x"]],
    [["logs", "--tail", "10lines"]],
    [["serve", "--log-keep", "3.5"]],
    [["memory", "list", "--offset", "-1"]],
    [["memory", "list", "--limit", "-5"]],
    [["prune", "--older-than", "30x"]],
  ])("is how %j refuses a number with trailing text or a sign", (argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  it("takes prune's age in days with or without its d", () => {
    for (const age of ["30", "30d"]) expect(parseArgs(["prune", "--older-than", age])).toMatchObject({ prune: { olderThanDays: 30 } });
  });
});
