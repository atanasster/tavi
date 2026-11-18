/**
 * The command index is the only discovery surface an operator has, and nothing
 * tied it to the parser: a new command could be dispatched by `parseArgs` and
 * `main` while `tavi help` and every usage error stayed silent about it.
 *
 * The `Record<ParsedCommand["command"], true>` below is the gate. It is total
 * over the union, so adding a member to `ParsedCommand["command"]` without
 * adding it here does not compile, and it admits no key the union does not
 * have — a rename cannot leave a stale entry behind. The runtime assertions then
 * cover the half a type cannot: that the index actually spells the command.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { COMMAND_INDEX } from "../../src/cli/help.js";
import { parseArgs, type ParsedCommand } from "../../src/cli/parse.js";

const PARSED_COMMANDS: Readonly<Record<ParsedCommand["command"], true>> = {
  run: true,
  serve: true,
  doctor: true,
  tasks: true,
  plugins: true,
  mcp: true,
  apps: true,
  permissions: true,
  models: true,
  router: true,
  memory: true,
  skills: true,
  bindings: true,
  channels: true,
  artifacts: true,
  credentials: true,
  reports: true,
  schedules: true,
  reminders: true,
  todos: true,
  heartbeat: true,
  ideas: true,
  onboard: true,
  setup: true,
  browser: true,
  agents: true,
  projects: true,
  search: true,
  "system-prompt": true,
  config: true,
  service: true,
  remote: true,
  sandbox: true,
  approvals: true,
  help: true,
  version: true,
  recover: true,
  cancel: true,
  abort: true,
  chat: true,
  ui: true,
  backup: true,
  export: true,
  restore: true,
  reset: true,
  logs: true,
  prune: true,
  inbox: true,
};

/**
 * The commands with no `tavi <command>` line, each with the reason it has none.
 *
 * Exactly two, and both are the *same* invocation the index opens with: the bare
 * `tavi` (and `tavi help`) prints the whole manual rather than appearing as a row
 * in it, and `--version` is documented as a flag. A third entry here would mean a
 * real command had quietly gone undocumented.
 */
const NOT_A_BARE_COMMAND_LINE: Readonly<Partial<Record<ParsedCommand["command"], string>>> = {
  help: "the bare invocation prints the whole manual; there is no `tavi help` row",
  version: "documented as the `tavi --version` flag",
};

describe("the command index", () => {
  it("has a `tavi <command>` line for every command the parser dispatches", () => {
    const undocumented = Object.keys(PARSED_COMMANDS).filter(
      (command) => NOT_A_BARE_COMMAND_LINE[command as ParsedCommand["command"]] === undefined && !COMMAND_INDEX.includes(`tavi ${command}`),
    );
    expect(undocumented).toEqual([]);
  });

  it("documents the two exceptions the way it says it does", () => {
    expect(COMMAND_INDEX).toContain("tavi --version");
    expect(COMMAND_INDEX).not.toContain("tavi help");
    // The index lists command families, one line each; a command may not appear
    // twice, or a rename that forgot the old row would read as two commands.
    for (const command of Object.keys(PARSED_COMMANDS)) {
      const rows = COMMAND_INDEX.split("\n").filter((line) => line.includes(`tavi ${command} `));
      expect(rows.length, `rows for ${command}: ${rows.join(" | ")}`).toBeLessThanOrEqual(1);
    }
  });

  it("points at a glossary heading that exists, for the terms it keeps", () => {
    // The index keeps a few real terms (owner, principal, taint); the glossary
    // explains them once. A renamed heading would leave the pointer dangling.
    expect(COMMAND_INDEX).toContain("docs/CONCEPTS.md#glossary");
    const concepts = readFileSync(new URL("../../../../docs/CONCEPTS.md", import.meta.url), "utf8");
    expect(concepts).toMatch(/^## Glossary$/m);
    for (const term of ["owner", "principal", "taint", "operator", "epoch"]) {
      expect(concepts, term).toContain(`| **${term}** |`);
    }
  });

  it("reaches the parser: no command in the record is refused as unknown", () => {
    for (const command of Object.keys(PARSED_COMMANDS)) {
      // Every command except `run` may refuse a *missing argument*, which is a
      // usage error about the command rather than about the name. Only the
      // unknown-command error means the record and `parseArgs` disagree.
      try {
        parseArgs([command]);
      } catch (error) {
        expect(String(error), `${command} is not handled by parseArgs`).not.toMatch(/Unknown command/);
      }
    }
  });
});
