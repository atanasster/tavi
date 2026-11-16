import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  matchesTool,
  parseArgs,
  parseCasesFile,
  scoreRun,
  selectCases,
  summarize,
  summarizeStream,
  type ToolCall,
} from "../evals/tool-choice/eval.js";

/** The live tool-choice eval's pure parts (evals/tool-choice): its cases, the stream it reads, scoring and pass^k. */

/** A completed run that made `calls`, in order (a bare name is a call with no input). */
const ran = (...calls: readonly (string | ToolCall)[]) => ({
  status: "completed" as const,
  calls: calls.map((call) => (typeof call === "string" ? { name: call, input: {} } : call)),
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the live tool-choice eval", () => {
  it("reads its cases, each with a prompt and the tools that are a right call", () => {
    const file = parseCasesFile(JSON.parse(readFileSync(join(root, "evals", "tool-choice", "cases.json"), "utf8")));
    expect(file.cases.length).toBeGreaterThanOrEqual(40);
    expect(() =>
      parseCasesFile({
        version: 1,
        cases: [
          { id: "a", prompt: "x", expect: [] },
          { id: "a", prompt: "y", expect: [] },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() => parseCasesFile({ version: 1, cases: [{ id: "a", prompt: "x", expect: [], requires: ["fax"] }] })).toThrow(/unknown fax/);
  });

  it("skips a case whose data directory lacks what it requires, and reports it", () => {
    const cases = [
      { id: "mail", prompt: "", expect: ["gmail.*"], requires: ["mail"] },
      { id: "plain", prompt: "", expect: ["math.eval"] },
    ];
    expect(selectCases(cases, [])).toEqual({ run: [cases[1]], skipped: [{ id: "mail", requires: ["mail"] }] });
    expect(selectCases(cases, ["mail"]).skipped).toEqual([]);
    expect(summarize([{ id: "plain", passed: true, strict: true }], [{ id: "mail", requires: ["mail"] }])).toMatchObject({
      cases: 1,
      skipped: [{ id: "mail", requires: ["mail"] }],
    });
    // A template holds no mail account or calendar, so declaring one needs a data directory.
    expect(() => parseArgs(["--template", "/nowhere", "--with", "mail"])).toThrow(/--data-dir/);
    expect(() => parseArgs(["--data-dir", "/nowhere", "--with", "fax"])).toThrow(/--with/);
    expect(parseArgs(["--data-dir", "/nowhere", "--with", "mail,calendar"]).available).toEqual(["mail", "calendar"]);
  });

  it("keeps a later call that reuses an earlier call's id under another tool", () => {
    const stream = [
      JSON.stringify({ kind: "tool.started", callId: "c1", toolName: "tools.search", input: {} }),
      JSON.stringify({ kind: "tool.started", callId: "c1", toolName: "reminders.create", input: {} }),
    ].join("\n");
    expect(summarizeStream(stream).calls.map((call) => call.name)).toEqual(["tools.search", "reminders.create"]);
  });

  it("takes the calls a run made, in order, a refused one once, and the run's tokens", () => {
    const stream = [
      JSON.stringify({ kind: "tool.started", callId: "c1", toolName: "tools.search", input: { query: "reminders" } }),
      JSON.stringify({ kind: "approval.required", callId: "c2", toolName: "reminders.create", input: { text: "Pay rent" } }),
      JSON.stringify({ kind: "tool.started", callId: "c2", toolName: "reminders.create", input: { text: "Pay rent" } }),
      "not json",
      JSON.stringify({ kind: "task.completed", metrics: { totalTokens: 900 } }),
    ].join("\n");
    expect(summarizeStream(stream)).toEqual({
      status: "completed",
      calls: [
        { name: "tools.search", input: { query: "reminders" } },
        { name: "reminders.create", input: { text: "Pay rent" } },
      ],
      tokens: 900,
    });
  });

  it("scores the first call after a search, its key arguments, and an answer with no call where one is fine", () => {
    const run = summarizeStream(
      [
        JSON.stringify({ kind: "tool.started", callId: "c1", toolName: "tools.search", input: {} }),
        JSON.stringify({ kind: "tool.started", callId: "c2", toolName: "reminders.create", input: { text: "Call the Dentist" } }),
      ].join("\n"),
    );
    expect(scoreRun({ id: "r", prompt: "", expect: ["reminders.create"], args: { text: "dentist" } }, run)).toMatchObject({
      passed: true,
      strict: true,
    });
    expect(scoreRun({ id: "r", prompt: "", expect: ["reminders.create"], args: { text: "gym" } }, run)).toMatchObject({
      passed: false,
      reason: 'text lacks "gym"',
    });
    expect(scoreRun({ id: "r", prompt: "", expect: ["schedules.create"] }, run)).toMatchObject({
      passed: false,
      chose: "reminders.create",
    });
    const silent = summarizeStream(JSON.stringify({ kind: "task.completed" }));
    expect(scoreRun({ id: "f", prompt: "", expect: ["math.eval"], noToolOk: true }, silent).passed).toBe(true);
    // A run that failed chose nothing, even where an answer with no call would do.
    const failed = summarizeStream(JSON.stringify({ kind: "task.failed" }));
    expect(scoreRun({ id: "f", prompt: "", expect: [], noToolOk: true }, failed)).toMatchObject({ passed: false, reason: "run failed" });
    expect(scoreRun({ id: "f", prompt: "", expect: ["math.eval"] }, silent)).toMatchObject({ passed: false, reason: "no tool called" });
    expect(matchesTool("gmail.*", "gmail.me.search")).toBe(true);
    expect(matchesTool("gmail.*", "gmailx.search")).toBe(false);
    expect(matchesTool("*.list", "schedules.list")).toBe(true);
    expect(matchesTool("*.list", "schedules.listen")).toBe(false);
  });

  it("passes the expected call after read-only look-ups, within the window, and reports it as not strict", () => {
    const create = { id: "s", prompt: "", expect: ["schedules.create"] };
    expect(scoreRun(create, ran("schedules.list", "tools.search", "schedules.create"))).toEqual({
      id: "s",
      passed: true,
      strict: false,
      chose: "schedules.create",
      leadIn: ["schedules.list"],
    });
    expect(scoreRun({ id: "w", prompt: "", expect: ["fs.write"] }, ran("fs.list", "fs.glob", "fs.write")).passed).toBe(true);
    expect(scoreRun({ id: "a", prompt: "", expect: ["operator.ask_user"] }, ran("memory.search", "operator.ask_user")).passed).toBe(true);
    // A case's own look-ups count too, and only for that case.
    expect(scoreRun({ ...create, leadIn: ["routines.targets"] }, ran("routines.targets", "schedules.create")).passed).toBe(true);
    expect(scoreRun(create, ran("routines.targets", "schedules.create"))).toMatchObject({
      passed: false,
      reason: "chose routines.targets",
    });
    // The expected call past the window fails, even after only look-ups.
    expect(scoreRun(create, ran("schedules.list", "memory.search", "fs.list", "schedules.create"))).toMatchObject({
      passed: false,
      reason: "no expected call in the first 3 (schedules.list, memory.search, fs.list)",
    });
    expect(scoreRun(create, ran("schedules.list"))).toMatchObject({ passed: false, reason: "only looked up (schedules.list)" });
    // The key arguments are read from the expected call, not the look-up.
    const dentist = { id: "d", prompt: "", expect: ["reminders.create"], args: { text: "dentist" } };
    expect(
      scoreRun(dentist, ran({ name: "reminders.list", input: {} }, { name: "reminders.create", input: { text: "Dentist at 9" } })).passed,
    ).toBe(true);
  });

  it("fails a wrong action first, even when the expected call follows", () => {
    const edit = { id: "e", prompt: "", expect: ["fs.edit"] };
    expect(scoreRun(edit, ran("fs.write", "fs.edit"))).toMatchObject({
      passed: false,
      strict: false,
      chose: "fs.write",
      reason: "chose fs.write",
    });
    expect(scoreRun(edit, ran("fs.list", "sandbox.run", "fs.edit"))).toMatchObject({ passed: false, reason: "chose sandbox.run" });
  });

  it("counts pass^k: a case passes only when every run of it did", () => {
    expect(
      summarize([
        { id: "a", passed: true, strict: true, tokens: 100 },
        { id: "a", passed: false, strict: false, tokens: 300 },
        { id: "b", passed: true, strict: true },
      ]),
    ).toEqual({
      cases: 2,
      runs: 3,
      passRate: 0.667,
      passAll: 0.5,
      strictPassRate: 0.667,
      strictPassAll: 0.5,
      failing: ["a"],
      strictFailing: [],
      skipped: [],
      tokensPerRun: 200,
    });
  });

  it("reports the strict first-call rate beside the lenient one", () => {
    const summary = summarize([
      { id: "a", passed: true, strict: true },
      { id: "a", passed: true, strict: false, chose: "schedules.create", leadIn: ["schedules.list"] },
      { id: "b", passed: true, strict: true },
      { id: "c", passed: false, strict: false },
    ]);
    expect(summary).toMatchObject({
      passRate: 0.75,
      passAll: 0.667,
      strictPassRate: 0.5,
      strictPassAll: 0.333,
      failing: ["c"],
      strictFailing: ["a"],
    });
  });

  it("refuses to run without a template or a data directory", () => {
    expect(() => parseArgs([])).toThrow();
  });
});
