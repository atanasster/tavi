import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { judgeAnswer, parseArgs, parseCasesFile, scoreRun, summarize, summarizeStream } from "../evals/skills/eval.js";

/** The skill eval pair's pure parts (evals/skills): its cases, the checks that judge an answer, and the per-arm summary. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = parseCasesFile(JSON.parse(readFileSync(join(root, "evals", "skills", "cases.json"), "utf8")));

describe("the skill eval pair", () => {
  it("reads its cases, each with a skill and checks, and refuses a case that checks nothing", () => {
    expect(file.cases.length).toBeGreaterThanOrEqual(6);
    const skill = { skillId: "s", name: "S", description: "d", body: "b" };
    const examples = { pass: "y", fail: "n" };
    expect(() => parseCasesFile({ version: 1, cases: [{ id: "a", prompt: "x", skill, checks: {}, examples }] })).toThrow(/no checks/);
    expect(() =>
      parseCasesFile({
        version: 1,
        cases: [{ id: "a", prompt: "x", skill: { ...skill, skillId: "Bad Id" }, checks: { mustInclude: ["y"] }, examples }],
      }),
    ).toThrow(/needs a skillId/);
    expect(() =>
      parseCasesFile({
        version: 1,
        cases: [
          { id: "a", prompt: "x", skill, checks: { mustInclude: ["y"] }, examples },
          { id: "a", prompt: "y", skill, checks: { mustInclude: ["y"] }, examples },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it.each(file.cases.map((entry) => [entry.id, entry] as const))(
    "%s: an answer that follows the skill passes its checks, and a typical one without it fails them",
    (_, entry) => {
      expect(judgeAnswer(entry.checks, entry.examples.pass)).toBeUndefined();
      expect(judgeAnswer(entry.checks, entry.examples.fail)).toBeDefined();
    },
  );

  it("judges an answer by its case's checks, not by the model", () => {
    const notes = file.cases.find((entry) => entry.id === "release-notes");
    expect(notes).toBeDefined();
    const good =
      "Release 4.2 — 2026-10-27\n### Added\n- Dark mode [APP-311]\n### Fixed\n- Login crash [APP-298]\n### Changed\n- Export label [APP-305]";
    expect(judgeAnswer(notes!.checks, good)).toBeUndefined();
    expect(judgeAnswer(notes!.checks, good.replace("[APP-298]", "(APP-298)"))).toBe('lacks "[APP-298]"');
    const swapped = "Release 4.2 — 2026-10-27\n### Fixed\n- [APP-298]\n### Added\n- [APP-311]\n### Changed\n- [APP-305]";
    expect(judgeAnswer(notes!.checks, swapped)).toMatch(/out of order/);
    expect(judgeAnswer({ mustNotInclude: ["Index"] }, "we rebuilt the index")).toBe('holds "Index"');
    expect(judgeAnswer({ mustMatch: ["^TL;DR: "] }, "Notes\nTL;DR: done")).toBeUndefined();
  });

  it("reads a run's answer and tools, and says whether the skill was loaded", () => {
    const stream = [
      JSON.stringify({ kind: "tool.started", callId: "c1", toolName: "skills.read", input: { skillId: "release-notes" } }),
      JSON.stringify({ kind: "text.delta", text: "partial" }),
      JSON.stringify({ kind: "task.completed", finalText: "### Added", metrics: { totalTokens: 900 } }),
    ].join("\n");
    const run = summarizeStream(stream);
    expect(run).toEqual({ status: "completed", finalText: "### Added", tools: ["skills.read"], tokens: 900 });
    const entry = {
      id: "x",
      prompt: "p",
      skill: { skillId: "s", name: "S", description: "d", body: "b" },
      checks: { mustInclude: ["### Added"] },
      examples: { pass: "### Added", fail: "Added things" },
    };
    expect(scoreRun(entry, "with", run)).toEqual({ id: "x", arm: "with", passed: true, loaded: true, tokens: 900 });
    expect(scoreRun(entry, "without", { ...run, timedOut: true })).toMatchObject({ passed: false, reason: "timed out" });
  });

  it("reports each arm, the lift, and the cases the skill made worse", () => {
    const run = (id: string, arm: "with" | "without", passed: boolean) => ({ id, arm, passed, loaded: arm === "with" });
    const summary = summarize([run("a", "without", false), run("a", "with", true), run("b", "without", true), run("b", "with", false)]);
    expect(summary).toMatchObject({ cases: 2, lift: 0, regressed: ["b"] });
    expect(summary.with).toMatchObject({ runs: 2, passRate: 0.5, loadRate: 1 });
  });

  it("needs a template: one arm's skill must never reach the other", () => {
    expect(() => parseArgs(["--data-dir", "/tmp/x"])).toThrow(/needs --template/);
  });
});
