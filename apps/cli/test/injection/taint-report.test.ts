import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ENFORCE_BARS,
  formatTaintReport,
  readReportInput,
  taintReport,
  type ObservationRow,
  type ReportInput,
} from "../../../../evals/injection/taint-report.js";
import { startMemoryOwner } from "../support/memory-owner.js";

/** The `security.taint` rollout report (evals/injection/taint-report.ts): the scoring and its bars. */

const NOW = "2026-10-20T00:00:00.000Z";
const at = (daysAgo: number): string => new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString();

function row(overrides: Partial<ObservationRow> & Pick<ObservationRow, "taskId" | "callId">): ObservationRow {
  return {
    toolId: "http.request",
    effect: "external",
    sink: "network",
    decisionEnforced: "allow",
    gateReason: "tainted-payload",
    createdAt: at(1),
    approvalState: null,
    ...overrides,
  };
}

function input(overrides: Partial<ReportInput>): ReportInput {
  return { now: NOW, days: 7, recordingSince: at(10), observations: [], tasks: 50, callsByTool: {}, ...overrides };
}

describe("taint rollout report", () => {
  it("counts would-be asks by reason, tool and sink, and what became of each", () => {
    const report = taintReport(
      input({
        observations: [
          row({ taskId: "t1", callId: "c1" }),
          row({
            taskId: "t1",
            callId: "c2",
            toolId: "browser.act",
            sink: "browser-type",
            gateReason: "tainted-payload",
            decisionEnforced: "ask",
            approvalState: "granted",
          }),
          row({
            taskId: "t2",
            callId: "c3",
            toolId: "web_fetch",
            sink: "url-only",
            gateReason: "novel-url",
            decisionEnforced: "ask",
            approvalState: "denied",
          }),
          row({
            taskId: "t2",
            callId: "c4",
            toolId: "web_fetch",
            sink: "url-only",
            gateReason: "novel-url",
            decisionEnforced: "ask",
            approvalState: "expired",
          }),
          row({
            taskId: "t3",
            callId: "c5",
            toolId: "memory.propose",
            sink: "persist",
            gateReason: "tainted-persist",
            decisionEnforced: "deny",
          }),
          // Outside the window: not counted.
          row({ taskId: "t9", callId: "old", createdAt: at(8) }),
        ],
        callsByTool: { "http.request": 4 },
      }),
    );
    expect(report.totals).toEqual({ calls: 5, neverAsked: 1, approved: 1, rejected: 1, unanswered: 1, denied: 1 });
    expect(report.observedTasks).toBe(3);
    expect(report.byReason.map((entry) => [entry.key, entry.calls])).toEqual([
      ["novel-url", 2],
      ["tainted-payload", 2],
      ["tainted-persist", 1],
    ]);
    expect(report.bySink.find((entry) => entry.key === "url-only")).toMatchObject({ calls: 2, rejected: 1, unanswered: 1 });
    expect(report.byTool.find((entry) => entry.key === "http.request")).toMatchObject({
      neverAsked: 1,
      ledgeredCalls: 4,
      gatedShare: 0.25,
    });
    // Benign-looking: the one that ran unasked and the one the person approved.
    expect(report.falseGateCandidates.map((candidate) => [candidate.callId, candidate.why])).toEqual([
      ["c1", "ran-unasked"],
      ["c2", "approved"],
    ]);
    expect(report.falseGateRate).toBeCloseTo(2 / 5);
    expect(report.extraApprovalsPerTask).toBeCloseTo(1 / 50);
    expect(report.extraApprovalsPerObservedTask).toBeCloseTo(1 / 3);
    expect(report.verdict.decision).toBe("enough-data");
    expect(formatTaintReport(report)).toMatch(/verdict: enough-data\n$/);
  });

  it("is not enough data under a week of recording, or too few tasks", () => {
    expect(taintReport(input({ recordingSince: at(2) })).verdict).toEqual({
      decision: "not-enough-data",
      reasons: ["2.0 days of recording (needs 7)"],
    });
    expect(taintReport(input({ recordingSince: undefined })).verdict.reasons[0]).toMatch(/^0\.0 days of recording/);
    expect(taintReport(input({ tasks: ENFORCE_BARS.minTasks - 1 })).verdict.reasons).toEqual([
      `${ENFORCE_BARS.minTasks - 1} tasks in the window (needs ${ENFORCE_BARS.minTasks})`,
    ]);
  });

  it("is over the bar on too many extra approvals, or one tool asked too often", () => {
    const unasked = Array.from({ length: 12 }, (_, index) => row({ taskId: `t${index % 6}`, callId: `c${index}` }));
    const report = taintReport(input({ observations: unasked, callsByTool: { "http.request": 20 } }));
    expect(report.verdict.decision).toBe("over-the-bar");
    expect(report.verdict.reasons).toEqual([
      "0.24 extra approvals per task (bar 0.2)",
      "2.00 extra approvals per task with an observation (bar 1)",
      "http.request would be asked on 60% of its 20 calls (bar 25%)",
    ]);
    // A tool with too few ledgered calls is not judged on its share.
    expect(taintReport(input({ observations: unasked.slice(0, 3), callsByTool: { "http.request": 3 } })).verdict.decision).toBe(
      "enough-data",
    );
  });
});

describe("readReportInput", () => {
  it("reads a migrated data directory's copy: the window, the newest approval of a call, tasks since recording, ledgered calls", async () => {
    const owner = await startMemoryOwner("tavi-taint-report-");
    try {
      const now = new Date(Date.now() + 60_000).toISOString();
      const ago = (days: number): string => new Date(Date.parse(now) - days * 86_400_000).toISOString();
      const Database = createRequire(import.meta.url)("better-sqlite3") as typeof import("better-sqlite3");
      const db = new Database(join(owner.directory, "tavi.sqlite"));
      try {
        const observe = db.prepare(
          "INSERT INTO tavi_gate_observations (task_id, call_id, tool_id, effect, sink, decision_enforced, decision_observed, gate_reason, created_at) VALUES (?, ?, 'http.request', 'external', 'network', ?, 'ask', 'tainted-payload', ?)",
        );
        observe.run("home-1", "c-in", "ask", ago(1));
        observe.run("home-1", "c-old", "allow", ago(8));
        const approve = db.prepare(
          "INSERT INTO tavi_approvals (approval_id, task_id, admission_id, tool_id, call_id, inputs, inputs_hash, state, created_at, updated_at, steps) VALUES (?, 'home-1', 'adm-home-1', 'http.request', 'c-in', '{}', 'h', ?, ?, ?, ?)",
        );
        approve.run("ap-1", "denied", ago(1), ago(1), 1);
        approve.run("ap-2", "granted", ago(0.5), ago(0.5), 2);
        db.prepare(
          "INSERT INTO tavi_effects (effect_key, task_id, admission_id, tool_id, inputs, inputs_hash, state, created_at, updated_at) VALUES ('e-1', 'home-1', 'adm-home-1', 'http.request', '{}', 'h', 'completed', ?, ?)",
        ).run(ago(1), ago(1));
      } finally {
        db.close();
      }
      const input = await readReportInput(owner.directory, now, 7);
      expect(input.recordingSince).toBeDefined();
      expect(input.observations.map((row) => [row.callId, row.approvalState])).toEqual([["c-in", "granted"]]);
      expect(input.callsByTool).toEqual({ "http.request": 1 });
      expect(input.tasks).toBeGreaterThanOrEqual(1);

      // A task last active before recording began is not counted.
      const raw = new Database(join(owner.directory, "tavi.sqlite"));
      try {
        raw.prepare("UPDATE tavi_tasks SET updated_at = '2000-01-01T00:00:00.000Z' WHERE task_id = 'home-1'").run();
      } finally {
        raw.close();
      }
      expect((await readReportInput(owner.directory, now, 7)).tasks).toBe(input.tasks - 1);
    } finally {
      await owner.close();
    }
  }, 60_000);
});
