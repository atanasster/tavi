import type { AdmissionOutcome, AdmissionRecord } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { endingOfOutcome, pendingRoundsOf, recordedStateOf, roundCallIds } from "../src/records.js";

/**
 * The record readers every front end shares (`tavi run --attach`, `tavi
 * chat`, the web canvas): what a task's record says when its stream cannot.
 */

const AT = "2026-09-19T12:00:00.000Z";
const admission = (fields: Partial<AdmissionRecord> & Pick<AdmissionRecord, "kind" | "state" | "result">): AdmissionRecord =>
  ({ admissionId: `a-${Math.random()}`, taskId: "task-1", operationKey: "op", createdAt: AT, updatedAt: AT, ...fields }) as AdmissionRecord;
const outcome = (fields: Record<string, unknown>): AdmissionOutcome => ({ finalText: "", ...fields }) as unknown as AdmissionOutcome;

describe("recordedStateOf", () => {
  it("says cancelled first, whatever its admissions", () => {
    expect(
      recordedStateOf({
        task: { status: "cancelled" },
        admissions: [admission({ kind: "start", state: "committed", result: outcome({ status: "completed" }) })],
      }),
    ).toEqual({
      kind: "cancelled",
    });
  });

  it("follows a task live while an admission is in flight — even past a stale suspension — or before anything settled", () => {
    const waiting = admission({
      kind: "start",
      state: "committed",
      result: outcome({ status: "waiting", interrupt: { requests: [{ toolName: "mail.send", callId: "c1", steps: 1 }] } }),
    });
    const claimed = admission({ kind: "approval", state: "claimed", result: null });
    expect(recordedStateOf({ task: { status: "running" }, admissions: [waiting, claimed] })).toEqual({ kind: "live" });
    expect(
      recordedStateOf({ task: { status: "queued" }, admissions: [admission({ kind: "start", state: "pending", result: null })] }),
    ).toEqual({ kind: "live" });
    expect(recordedStateOf({ task: null })).toEqual({ kind: "live" });
  });

  it("reports the latest settled admission's ending, passing over a refused one", () => {
    const done = admission({ kind: "start", state: "committed", result: outcome({ status: "completed" }) });
    const refused = admission({
      kind: "reply",
      state: "refused",
      result: outcome({ status: "failed", error: { code: "CONFLICT", message: "busy" } }),
    });
    expect(recordedStateOf({ task: { status: "completed" }, admissions: [done, refused] })).toEqual({
      kind: "settled",
      ending: { kind: "completed" },
    });
  });
});

describe("endingOfOutcome", () => {
  it("reads each suspension, and a failure's reason", () => {
    expect(
      endingOfOutcome(outcome({ status: "waiting", interrupt: { requests: [{ toolName: "mail.send", callId: "c1", steps: 2 }] } })),
    ).toMatchObject({
      kind: "approval",
      requests: [{ callId: "c1" }],
    });
    expect(
      endingOfOutcome(
        outcome({ status: "waiting", reviewInterrupt: { requests: [{ artifactId: "art", toolName: "t", callId: "c", steps: 3 }] } }),
      ),
    ).toMatchObject({
      kind: "review",
      steps: 3,
    });
    const wait = (extra: Record<string, unknown>) =>
      outcome({ status: "waiting", waitInterrupt: { wait: { deadlineAt: AT, ...extra }, question: "Which one?" } });
    expect(endingOfOutcome(wait({ correlationId: "corr-1" }))).toEqual({
      kind: "waiting",
      on: "a reply correlated to corr-1",
      deadlineAt: AT,
      question: "Which one?",
    });
    expect(endingOfOutcome(wait({ waitingOnWorkerTaskId: "task-9" }))).toMatchObject({ on: "worker task task-9 completing" });
    expect(endingOfOutcome(wait({}))).toMatchObject({ on: "its deadline" });
    // The wait's id, choices and why it was asked, so a seeded question is answerable as a live one.
    const choices = { options: [{ label: "A" }, { label: "B" }], multiSelect: false, allowOther: true, defaultOption: 2 };
    expect(
      endingOfOutcome(
        outcome({
          status: "waiting",
          waitInterrupt: { wait: { waitId: "w-1", deadlineAt: AT }, question: "Which one?", choices, context: "Needed for the report." },
        }),
      ),
    ).toEqual({
      kind: "waiting",
      on: "its deadline",
      deadlineAt: AT,
      question: "Which one?",
      choices,
      context: "Needed for the report.",
      waitId: "w-1",
    });
    expect(endingOfOutcome(outcome({ status: "failed", error: { code: "ABORTED", message: "stopped" } }))).toEqual({
      kind: "failed",
      reason: "ABORTED: stopped",
    });
    expect(endingOfOutcome(outcome({ status: "failed" }))).toEqual({ kind: "failed" });
    // A turn the person stopped is its own ending, in their words, and a real shutdown stays a failure.
    expect(endingOfOutcome(outcome({ status: "stopped", finalText: "You stopped this." }))).toEqual({
      kind: "stopped",
      message: "You stopped this.",
    });
  });

  it("does not read a round with no calls as one", () => {
    expect(endingOfOutcome(outcome({ status: "waiting", interrupt: { requests: [] } })).kind).not.toBe("approval");
    expect(endingOfOutcome(outcome({ status: "waiting", reviewInterrupt: { requests: [] } })).kind).not.toBe("review");
  });
});

describe("roundCallIds and pendingRoundsOf", () => {
  const row = (callId: string, steps: number) => ({ record: { approvalId: `a-${callId}`, callId, toolId: "mail.send", steps } });

  it("lists one round's calls, and groups rows into rounds", () => {
    const rows = [row("c1", 1), row("c2", 1), row("c3", 2)];
    expect([...roundCallIds(rows, 1)]).toEqual(["c1", "c2"]);
    expect([...roundCallIds(rows, 5)]).toEqual([]);
    const { rounds } = pendingRoundsOf("task-1", rows);
    expect(rounds.map((round) => [round.steps, round.requests.map((request) => request.callId)])).toEqual([
      [1, ["c1", "c2"]],
      [2, ["c3"]],
    ]);
  });

  it("keeps a row's headline, scopes and round risk, so a seeded round does not read as unassessed", () => {
    const { rounds } = pendingRoundsOf("task-1", [
      { ...row("c1", 1), summary: "Run ls", risk: "medium" as const, allowedScopes: ["once", "session"] as const },
      row("c2", 2),
    ]);
    expect(rounds[0]?.requests[0]).toMatchObject({
      summary: "Run ls",
      risk: { level: "medium", reasons: [], tainted: false },
      allowedScopes: ["once", "session"],
    });
    expect(rounds[1]?.requests[0]?.risk).toBeUndefined();
  });

  it("keeps where a tainted round read untrusted content, with its risk or without one", () => {
    const label = {
      integrity: "untrusted" as const,
      sources: ["web" as const],
      principals: [],
      confidentiality: "public" as const,
      refs: [],
    };
    const { rounds } = pendingRoundsOf("task-1", [
      { ...row("c1", 1), risk: "high" as const, label },
      { ...row("c2", 2), label },
    ]);
    expect(rounds[0]?.requests[0]?.risk).toEqual({ level: "high", reasons: [], tainted: true, label });
    for (const round of rounds)
      expect(round.requests[0]?.provenance).toEqual({ sources: ["web"], principals: [], refs: [], argOrigins: [] });
    expect(rounds[1]?.requests[0]?.risk).toBeUndefined();
  });
});

describe("a round reopened from the listing and the task's record", () => {
  it("reads as it did live: each call's title, diff, reasons, input and provenance from the record, the round's higher risk kept", () => {
    const display = { title: "Edit plan.md", detail: "--- plan.md\n+++ plan.md\n@@ -1 +1 @@\n-Wednesday: rest\n+Wednesday: walk" };
    const { rounds } = pendingRoundsOf(
      "task-1",
      [{ record: { approvalId: "a-c1", callId: "c1", toolId: "fs.edit", steps: 3 }, summary: "plan.md", risk: "high" as const }],
      [
        {
          callId: "c1",
          toolName: "fs.edit",
          input: { path: "plan.md" },
          display,
          risk: { level: "medium" as const, reasons: ["changes a file"], tainted: false },
          provenance: { sources: [], principals: [], refs: [], argOrigins: [] },
        },
      ],
    );
    expect(rounds[0]?.requests[0]).toMatchObject({
      summary: "plan.md",
      input: { path: "plan.md" },
      display,
      risk: { level: "high", reasons: ["changes a file"] },
      provenance: { sources: [] },
    });
  });
});

describe("a chat with no turn yet", () => {
  it("is settled, so a message to it goes rather than waiting on a turn", () => {
    expect(recordedStateOf({ task: { status: "completed", chatKind: "home" }, admissions: [] })).toEqual({
      kind: "settled",
      ending: { kind: "completed" },
    });
    // One just admitted, whose admission isn't read yet, stays live.
    expect(recordedStateOf({ task: { status: "admitted" }, admissions: [] })).toEqual({ kind: "live" });
  });
});
