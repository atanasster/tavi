import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APP_LOG_ERROR,
  type FsCase,
  appLog,
  fixtureText,
  formatSummary,
  parseArgs,
  parseCasesFile,
  scoreCase,
  seedFolder,
  summarize,
  summarizeStream,
} from "../evals/fs/eval.js";
import { runnerData } from "../evals/template.js";

/** The live file-and-sandbox action eval's offline parts (evals/fs): its cases, fixtures, the stream it reads and its scoring. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "evals", "fs", "fixtures");
const file = parseCasesFile(JSON.parse(readFileSync(join(root, "evals", "fs", "cases.json"), "utf8")));
const byId = (id: string): FsCase => {
  const entry = file.cases.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no case ${id}`);
  return entry;
};

/** A `tavi run --format json` stream of these calls, ending in `finalText`. */
const stream = (calls: readonly [string, Record<string, unknown>][], finalText = "", kind = "task.completed"): string =>
  [
    ...calls.map(([toolName, input], index) => JSON.stringify({ kind: "tool.started", callId: `c${index}`, toolName, input })),
    "not json",
    JSON.stringify({ kind, finalText, metrics: { totalTokens: 1200 } }),
  ].join("\n");

const failing = (result: ReturnType<typeof scoreCase>): string[] => result.checks.filter((check) => !check.pass).map((check) => check.id);

describe("the fs action eval", () => {
  it("reads its cases: unique ids, fixtures that exist, and something to check", () => {
    expect(file.cases.map((entry) => entry.id)).toEqual(["edit-three-hunks", "grep-window-big-log", "sandbox-script-stdin"]);
    const one = (entry: Record<string, unknown>) =>
      parseCasesFile({ version: 1, cases: [{ id: "a", prompt: "p", files: {}, expect: { answer: [["x"]] }, ...entry }] }, fixtures);
    expect(() => one({})).not.toThrow();
    expect(() =>
      parseCasesFile({
        version: 1,
        cases: [
          { id: "a", prompt: "p", files: {}, expect: { answer: [["x"]] } },
          { id: "a", prompt: "q", files: {}, expect: { answer: [["x"]] } },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() => one({ files: { "a.txt": "missing.txt" } })).toThrow(/no fixture/);
    expect(() => one({ files: { "a.log": "generated:nope" } })).toThrow(/no generated fixture/);
    expect(() => one({ files: { "../escape.txt": "sales.csv" } })).toThrow(/inside the folder/);
    expect(() => one({ expect: {} })).toThrow(/expects nothing/);
    expect(() => one({ expect: { calls: [{ tool: "fs.read" }] } })).toThrow(/min or max/);
    expect(() => one({ expect: { calls: [{ tool: "fs.read", min: 2, max: 1 }] } })).toThrow(/above max/);
  });

  it("generates the same >1 MiB log every time, with exactly one ERROR where the case says", () => {
    const log = appLog();
    expect(appLog()).toBe(log);
    expect(Buffer.byteLength(log)).toBeGreaterThan(1024 * 1024);
    const lines = log.split("\n");
    const errors = lines.flatMap((line, index) => (/error/i.test(line) ? [index + 1] : []));
    expect(errors).toEqual([APP_LOG_ERROR.line]);
    expect(lines[APP_LOG_ERROR.line - 1]).toContain(APP_LOG_ERROR.text);
    expect(lines[APP_LOG_ERROR.line]).toContain(APP_LOG_ERROR.next);
    // The answer's facts are on those two lines only, so no other line can supply them.
    for (const fact of [APP_LOG_ERROR.requestId, APP_LOG_ERROR.order])
      expect(
        lines.flatMap((line, index) => (line.includes(fact) ? [index + 1] : [])),
        fact,
      ).toEqual([APP_LOG_ERROR.line, APP_LOG_ERROR.line + 1]);
    expect(byId("grep-window-big-log").expect.answer).toEqual([
      [String(APP_LOG_ERROR.line)],
      [APP_LOG_ERROR.requestId],
      [APP_LOG_ERROR.order],
      ["retry"],
    ]);
  });

  it("seeds a case's folder with its fixtures, generated ones built in place", () => {
    const folder = mkdtempSync(join(tmpdir(), "tfs-test-"));
    try {
      seedFolder(byId("grep-window-big-log"), folder, fixtures);
      expect(statSync(join(folder, "app.log")).size).toBeGreaterThan(1024 * 1024);
      seedFolder(byId("edit-three-hunks"), join(folder, "nested"), fixtures);
      expect(readFileSync(join(folder, "nested", "inventory.py"), "utf8")).toBe(fixtureText("inventory.py", fixtures));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("asks for three separate hunks in one file, and the edits the prompt names make the expected file", () => {
    const before = fixtureText("inventory.py", fixtures);
    const after = fixtureText("inventory.expected.py", fixtures);
    const was = before.split("\n");
    const now = after.split("\n");
    expect(now.length).toBe(was.length);
    const changed = was.flatMap((line, index) => (line === now[index] ? [] : [index]));
    expect(changed.length).toBe(3);
    // Far enough apart that a unified diff with three lines of context shows three hunks, not one.
    for (let index = 1; index < changed.length; index += 1) expect((changed[index] ?? 0) - (changed[index - 1] ?? 0)).toBeGreaterThan(6);
    const edits = [
      ["LOW_STOCK_THRESHOLD = 5", "LOW_STOCK_THRESHOLD = 10"],
      ['print("restocked", item["sku"])', 'log.info("restocked %s", item["sku"])'],
      ['or "none"', 'or "nothing to reorder"'],
    ] as const;
    let edited = before;
    for (const [oldText, newText] of edits) {
      expect(edited.split(oldText).length - 1, oldText).toBe(1);
      edited = edited.replace(oldText, newText);
    }
    expect(edited).toBe(after);
    for (const named of ["LOW_STOCK_THRESHOLD to 10", 'log.info("restocked %s", item["sku"])', '"nothing to reorder"'])
      expect(byId("edit-three-hunks").prompt).toContain(named);
  });

  it("gives the sales case the per-region totals the CSV adds up to", () => {
    const [header, ...rows] = fixtureText("sales.csv", fixtures).trim().split("\n");
    expect(header).toBe("date,region,product,units,unit_price");
    const cents = new Map<string, number>();
    for (const row of rows) {
      const [, region = "", , units = "0", price = "0"] = row.split(",");
      cents.set(region, (cents.get(region) ?? 0) + Number(units) * Math.round(Number(price) * 100));
    }
    const totals = [...cents.values()].map((value) => (value / 100).toFixed(2));
    expect(new Set(byId("sandbox-script-stdin").expect.answer?.map((fact) => fact[0]))).toEqual(new Set(totals));
  });

  it("reads a run's calls with their inputs, its answer and its tokens", () => {
    const run = summarizeStream(
      [
        JSON.stringify({ kind: "text.delta", text: "Line " }),
        JSON.stringify({ kind: "tool.started", callId: "c1", toolName: "fs.grep", input: { pattern: "ERROR" } }),
        JSON.stringify({ kind: "tool.failed", callId: "c1", toolName: "fs.grep" }),
        JSON.stringify({ kind: "text.delta", text: "9137" }),
        JSON.stringify({ kind: "task.failed", metrics: { totalTokens: 50 } }),
      ].join("\n"),
    );
    expect(run).toEqual({
      status: "failed",
      finalText: "Line 9137",
      calls: [{ name: "fs.grep", input: { pattern: "ERROR" } }],
      failedCalls: 1,
      tokens: 50,
    });
  });

  it("scores the edit case from the file it leaves and the calls that made it", () => {
    const entry = byId("edit-three-hunks");
    const expected = fixtureText("inventory.expected.py", fixtures);
    const untouched = fixtureText("inventory.py", fixtures);
    const fixture = (name: string) => fixtureText(name, fixtures);
    const oneEdit = stream([
      ["fs.read", { path: "inventory.py" }],
      ["fs.edit", { path: "inventory.py", edits: [{}, {}, {}] }],
    ]);
    expect(scoreCase(entry, summarizeStream(oneEdit), () => expected, fixture).passed).toBe(true);
    expect(failing(scoreCase(entry, summarizeStream(oneEdit), () => untouched, fixture))).toEqual(["file:inventory.py"]);
    expect(failing(scoreCase(entry, summarizeStream(oneEdit), () => undefined, fixture))).toEqual(["file:inventory.py"]);
    // Three calls of one change each, or a rewrite of the whole file, is not one three-hunk edit.
    const threeEdits = stream([1, 2, 3].map(() => ["fs.edit", { path: "inventory.py", oldText: "a", newText: "b" }]));
    expect(failing(scoreCase(entry, summarizeStream(threeEdits), () => expected, fixture))).toEqual([
      "calls:fs.edit",
      "calls:fs.edit+edits",
    ]);
    const rewrite = stream([["fs.write", { path: "inventory.py", content: expected }]]);
    expect(failing(scoreCase(entry, summarizeStream(rewrite), () => expected, fixture))).toEqual([
      "calls:fs.edit",
      "calls:fs.edit+edits",
      "calls:fs.write",
    ]);
    // A run that did not complete passes nothing, whatever it left.
    const result = scoreCase(entry, summarizeStream(oneEdit.replace("task.completed", "task.failed")), () => expected, fixture);
    expect(result.passed).toBe(false);
    expect(result.checks.every((check) => check.reason === "run failed")).toBe(true);
  });

  it("scores the log case on a grep, a line-window read, and the facts in the answer", () => {
    const entry = byId("grep-window-big-log");
    const answer = "The ERROR is on line 9,137: request r-7f3a9c, order 55821. The next line says a retry was scheduled in 120s.";
    const good = stream(
      [
        ["fs.grep", { pattern: "ERROR", path: "app.log" }],
        ["fs.read", { path: "app.log", startLine: 9134, lineCount: 8 }],
      ],
      answer,
    );
    expect(scoreCase(entry, summarizeStream(good), () => undefined).passed).toBe(true);
    const wholeRead = stream([["fs.read", { path: "app.log" }]], answer);
    expect(failing(scoreCase(entry, summarizeStream(wholeRead), () => undefined))).toEqual(["calls:fs.grep", "calls:fs.read+startLine"]);
    const shell = stream(
      [
        ["fs.grep", { pattern: "error" }],
        ["fs.read", { path: "app.log", startLine: 9137 }],
        ["sandbox.run", { command: "sed", args: ["-n", "9130,9140p", "app.log"] }],
      ],
      "Line 9137, r-7f3a9c.",
    );
    expect(failing(scoreCase(entry, summarizeStream(shell), () => undefined))).toEqual([
      "calls:sandbox.run",
      "answer:55821",
      "answer:retry",
    ]);
  });

  it("scores the sandbox case on a python run fed by stdin and the totals it reports", () => {
    const entry = byId("sandbox-script-stdin");
    const csv = fixtureText("sales.csv", fixtures);
    const fixture = (name: string) => fixtureText(name, fixtures);
    const answer = "East: 7,342.42; North: 4,746.65; South: 2,089.80; West: 2,628.17.";
    const piped = stream(
      [
        ["fs.read", { path: "sales.csv" }],
        ["sandbox.run", { command: "python3", args: ["-c", "import sys, csv; ..."], stdin: csv }],
      ],
      answer,
    );
    expect(scoreCase(entry, summarizeStream(piped), () => csv, fixture).passed).toBe(true);
    // The program opening the file itself is not a run fed by stdin; a changed CSV is not the CSV left alone.
    const opened = stream([["sandbox.run", { command: "python3", args: ["-c", "open('sales.csv')"] }]], answer);
    expect(failing(scoreCase(entry, summarizeStream(opened), () => `${csv}x`, fixture))).toEqual([
      "file:sales.csv",
      "calls:sandbox.run+stdin",
    ]);
  });

  it("sums runs into a pass rate and pass^k, and refuses to run without a template or data directory", () => {
    const entry = byId("grep-window-big-log");
    const pass = scoreCase(
      entry,
      summarizeStream(
        stream(
          [
            ["fs.grep", { pattern: "ERROR" }],
            ["fs.read", { startLine: 9137 }],
          ],
          "9137 r-7f3a9c 55821 retry",
        ),
      ),
      () => undefined,
    );
    const fail = scoreCase(entry, summarizeStream(stream([], "")), () => undefined);
    const summary = summarize([pass, { ...fail, repeat: 2 }]);
    expect(summary).toEqual({ cases: 1, runs: 2, passRate: 0.5, passAll: 0, failing: ["grep-window-big-log"], tokensPerRun: 1200 });
    expect(formatSummary(summary, [pass, fail])).toContain("✗ grep-window-big-log calls:fs.grep");
    const data = (template?: string, dataDir?: string) => runnerData(template, dataDir, "evals/fs/README.md");
    expect(() => parseArgs([], data)).toThrow(/--template/);
    expect(parseArgs(["--template", "/tmp/t", "--case", "edit-three-hunks", "--repeat", "3"], data)).toMatchObject({
      only: ["edit-three-hunks"],
      repeat: 3,
      data: { template: "/tmp/t" },
    });
    expect(() => parseArgs(["--template", "/tmp/t", "--repeat", "0"], data)).toThrow(/--repeat/);
  });
});
