import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { SqliteStore } from "../support/database-fixture.js";
import { nowTimestamp } from "@tavi/contracts/util";
import { waitFor } from "@tavi/test-support";
import { describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import type { StrandedAdmissionsReport } from "../../src/features/doctor/reports.js";
import { ATTACHED, capture, turns, useAttachedOwners } from "../support/attached-owner.js";

/**
 * `tavi doctor` reports an admission an unclean stop left `claimed`:
 * nothing re-admits one automatically, so the operator is told
 * which task, what holds its slot, and the step that settles it — and never
 * to recover a turn the owner is running.
 */

const owners = useAttachedOwners("tavi-doctor-");

async function doctorReport(directory: string): Promise<StrandedAdmissionsReport> {
  const out = capture();
  expect(await main(["doctor", "--data-dir", directory], { io: out.io }), out.stderr()).toBe(EXIT.ok);
  return (JSON.parse(out.stdout()) as { strandedAdmissions: StrandedAdmissionsReport }).strandedAdmissions;
}

/** Seed admissions straight into a directory's store, each a millisecond after the last. */
async function seeding(directory: string) {
  const store = await SqliteStore.open({ databasePath: `${directory}/tavi.sqlite`, artifactsDirectory: `${directory}/artifacts` });
  const repositories = store.asPort().repositories;
  let clock = Date.now();
  const now = (): string => new Date((clock += 1)).toISOString();
  let sequence = 0;
  const admit = async (taskId: string, existing = false) =>
    (
      await repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "operator",
        ...(existing ? { taskId } : {}),
        operationKey: `op-${taskId}-${(sequence += 1)}`,
        kind: existing ? "reply" : "start",
        intent: { prompt: "work", sequence },
        checkpointNamespace: "",
        newTaskId: (() => taskId)(),
        newAdmissionId: (() => `adm-${taskId}-${sequence}`)(),
        newThreadId: (() => `thread-${taskId}`)(),
        now: now(),
      })
    ).admission;
  /** A turn cut off mid-run: claimed, `session`'s lease on the slot (none when `undefined`). */
  const strand = async (taskId: string, session?: string, leaseMs = 60_000) => {
    const admission = await admit(taskId);
    await repositories.tasks.setAdmissionState(admission.admissionId, "claimed");
    if (session !== undefined) {
      await repositories.executions.acquire({
        taskId,
        ownerSession: session,
        admissionId: admission.admissionId,
        leaseMs,
        now: { fixed: now() },
      });
    }
    return admission;
  };
  return { repositories, admit, strand, now, close: () => store.close() };
}

describe("tavi doctor: admissions left claimed", ATTACHED, () => {
  it("lists each stranded admission newest first, with what holds its slot and the step that settles it", async () => {
    const directory = owners.tempDirectory();
    const seed = await seeding(directory);
    try {
      await seed.strand("task-held", "session-dead");
      await seed.strand("task-lapsed", "session-dead", 1);
      // Recovered: its own execution terminated, the admission still claimed.
      await seed.strand("task-recovered", "session-dead");
      await seed.repositories.executions.terminate({
        taskId: "task-recovered",
        generation: 1,
        confirmedTerminated: true,
        reason: "owner gone",
        terminatedBy: "operator",
        now: { fixed: seed.now() },
      });
      await seed.strand("task-free");
      // Needing nothing: superseded by a later settled admission, or cancelled.
      await seed.strand("task-superseded");
      const later = await seed.admit("task-superseded", true);
      await seed.repositories.tasks.commitAdmission({
        admissionId: (await later).admissionId,
        taskId: "task-superseded",
        state: "committed",
        result: { status: "completed", finalText: "done" },
      });
      await seed.strand("task-cancelled");
      await seed.repositories.cancellations.request({
        taskId: "task-cancelled",
        requestedBy: "operator",
        reason: "not needed",
        now: { fixed: seed.now() },
      });
      // Queued behind nothing, never claimed: not listed.
      await seed.admit("task-queued");
    } finally {
      await seed.close();
    }

    const report = await doctorReport(directory);
    expect(report.truncated).toBe(false);
    expect(report.admissions.map((admission) => [admission.taskId, admission.slot])).toEqual([
      ["task-free", "free"],
      ["task-recovered", "recovered"],
      ["task-lapsed", "held"],
      ["task-held", "held"],
    ]);
    const [free, recovered, lapsed, held] = report.admissions;
    expect(held).toMatchObject({
      execution: { generation: 1, ownerSession: "session-dead", expired: false },
      remedy: expect.stringContaining("tavi recover task-held --generation 1 --reason <text>"),
    });
    expect(held?.remedy).toContain(`retry its operation key \`${held?.operationKey}\``);
    expect(lapsed?.execution).toMatchObject({ expired: true });
    expect(recovered).toMatchObject({ execution: null, remedy: expect.stringContaining("its execution was recovered") });
    expect(free).toMatchObject({ execution: null, remedy: expect.stringContaining("tavi tasks task-free") });
  });

  it("lists at most 50, newest first, and says it truncated", async () => {
    const directory = owners.tempDirectory();
    const seed = await seeding(directory);
    try {
      for (let index = 0; index < 51; index += 1) await seed.strand(`task-${String(index).padStart(2, "0")}`);
    } finally {
      await seed.close();
    }
    const report = await doctorReport(directory);
    expect(report.admissions).toHaveLength(50);
    expect(report.truncated).toBe(true);
    expect(report.admissions[0]?.taskId).toBe("task-50");
  });

  it("attached, lists a dead owner's strand but neither the owner's running turn nor a recover of its own slot", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const directory = owners.tempDirectory();
    const seed = await seeding(directory);
    try {
      await seed.strand("task-dead", "session-dead");
      // Stranded and recovered, before the owner took the task's slot for a newer turn.
      await seed.strand("task-shared", "session-dead");
      await seed.repositories.executions.terminate({
        taskId: "task-shared",
        generation: 1,
        confirmedTerminated: true,
        reason: "owner gone",
        terminatedBy: "operator",
        now: { fixed: seed.now() },
      });
    } finally {
      await seed.close();
    }
    const { handle } = await owners.startOwner(turns([], held), { directory });
    const repositories = handle.runtime.store.asPort().repositories;
    // The owner runs a newer turn of task-shared (its slot, another admission).
    await repositories.executions.acquire({
      taskId: "task-shared",
      ownerSession: handle.runtime.ownerSession,
      admissionId: "adm-newer",
      leaseMs: 60_000,
      now: { fixed: (() => nowTimestamp())() },
    });
    // And a run of its own, claimed and running now.
    const client = await owners.attach(handle);
    await client.request(
      "run",
      { prompt: "take your time", workspaceId: "default", principal: "operator", operationKey: "op-running", approval: "client" },
      "run",
    );
    const running = async () => (await repositories.tasks.list(10)).find((task) => task.origin === "ipc");
    await waitFor(async () => (await running()) !== undefined && handle.runtime.abortRegistry.has((await running())?.taskId ?? ""));
    expect((await repositories.tasks.listAdmissions((await running())?.taskId ?? ""))[0]).toMatchObject({ state: "claimed", result: null });

    const report = await doctorReport(directory);
    expect(report.admissions.map((admission) => [admission.taskId, admission.slot])).toEqual([
      ["task-shared", "busy"],
      ["task-dead", "held"],
    ]);
    const shared = report.admissions[0];
    expect(shared?.execution).toMatchObject({ ownerSession: handle.runtime.ownerSession, admissionId: "adm-newer" });
    // Never a recover of the owner's own running turn.
    expect(shared?.remedy).not.toContain("tavi recover");
    expect(shared?.remedy).toContain("this owner is running another turn of the task (admission adm-newer)");
    release();
    await waitFor(async () => (await running())?.status === "completed");
  });
});
