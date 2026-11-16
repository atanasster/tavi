import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { IPC_EXECUTION_BUSY, TaviError, type ArtifactRepositoryPort, type PersistencePort, type WorkflowPort } from "@tavi/contracts";
import {
  createInMemoryApprovalRepository,
  createInMemoryArtifactRepository,
  createInMemoryCancellationRepository,
  createInMemoryExecutionRepository,
  createInMemoryTaskRepository,
} from "@tavi/test-support/fakes";
import { createInFlightFires } from "@tavi/agent-host/schedule-scheduler";
import { describe, expect, it } from "vitest";

import { reviewRound, type ReviewDependencies } from "../../src/features/artifacts/review-owner.js";

/**
 * `reviewRound`'s branches that a live owner cannot easily reach:
 * no model connection, a concurrent decider racing the write, and a slot held
 * by an owner that died — each answered without the records drifting from what
 * the client is told.
 */

const now = () => "2026-01-01T00:00:00.000Z";

async function fixture(options: { readonly workflow?: WorkflowPort; readonly artifacts?: ArtifactRepositoryPort } = {}) {
  const tasks = createInMemoryTaskRepository();
  const artifacts = options.artifacts ?? createInMemoryArtifactRepository();
  const executions = createInMemoryExecutionRepository();
  const repositories = {
    tasks,
    artifacts,
    executions,
    approvals: createInMemoryApprovalRepository(),
    cancellations: createInMemoryCancellationRepository(),
  } as unknown as PersistencePort["repositories"];
  const { task, admission } = await tasks.admit({
    prompt: fixturePromptPolicy,
    workspaceId: "default",
    principalId: "operator",
    operationKey: "op-start",
    kind: "start",
    intent: { prompt: "go" },
    checkpointNamespace: "",
    newTaskId: (() => "task-1")(),
    newAdmissionId: (() => "adm-start")(),
    newThreadId: (() => "thread-1")(),
    now: now(),
  });
  const pending = async (body: string) =>
    await artifacts.putArtifact({ workspaceId: "default", runId: task.taskId, contentType: "text/plain", body, reviewState: "pending" });
  const first = await pending("a");
  const second = await pending("b");
  // The task is suspended on a review of both.
  await tasks.commitAdmission({
    admissionId: admission.admissionId,
    taskId: task.taskId,
    state: "committed",
    result: {
      status: "waiting",
      finalText: "",
      reviewInterrupt: {
        requests: [
          { artifactId: (await first).artifactId, callId: "c1", toolName: "sandbox.run", steps: 1 },
          { artifactId: (await second).artifactId, callId: "c2", toolName: "sandbox.run", steps: 1 },
        ],
      },
    },
  });
  const deps: ReviewDependencies = {
    repositories,
    workflow: options.workflow,
    scheduleFires: createInFlightFires(),
    ownerSession: "session-live",
    now,
  };
  return { deps, taskId: task.taskId, artifacts, executions, first: (await first).artifactId, second: (await second).artifactId };
}

/** A workflow that must never be reached. */
const unreachable: WorkflowPort = {
  admit: async () => {
    throw new Error("admission was not expected");
  },
  checkpoints: {} as never,
};

describe("reviewRound", () => {
  it("refuses a resume with no model connection, but records without one", async () => {
    const { deps, taskId, first, artifacts } = await fixture();
    const resumed = await reviewRound(deps, {
      taskId,
      workspaceId: "default",
      decisions: [{ artifactId: first, approved: true }],
      resume: true,
    });
    expect(resumed).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect((await artifacts.getArtifact(first))?.reviewState).toBe("pending");
    const recorded = await reviewRound(deps, { taskId, workspaceId: "default", decisions: [{ artifactId: first, approved: true }] });
    expect(recorded).toMatchObject({ ok: true, result: { decisions: [{ artifactId: first, reviewState: "approved" }] } });
  });

  it("copies what it approves into the chat's folder — never what it rejects", async () => {
    const { deps, taskId, first, second } = await fixture();
    const materialized: string[] = [];
    const answer = await reviewRound(
      { ...deps, materializeArtifact: async (artifactId) => void materialized.push(artifactId) },
      {
        taskId,
        workspaceId: "default",
        decisions: [
          { artifactId: first, approved: true },
          { artifactId: second, approved: false },
        ],
      },
    );
    expect(answer).toMatchObject({ ok: true });
    expect(materialized).toEqual([first]);
    // Approving again retries the copy (a failed one is made then; a made one is found).
    const again = await reviewRound(
      { ...deps, materializeArtifact: async (artifactId) => void materialized.push(artifactId) },
      { taskId, workspaceId: "default", decisions: [{ artifactId: first, approved: true }] },
    );
    expect(again).toMatchObject({ ok: true, result: { decisions: [{ artifactId: first, alreadyDecided: true }] } });
    expect(materialized).toEqual([first, first]);
  });

  it("refuses a task in another workspace", async () => {
    const { deps, taskId, first } = await fixture();
    const answer = await reviewRound(deps, { taskId, workspaceId: "other", decisions: [{ artifactId: first, approved: true }] });
    expect(answer).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("treats a concurrent decider with the same verdict as the same decision", async () => {
    const inner = createInMemoryArtifactRepository();
    const racing: ArtifactRepositoryPort = {
      ...inner,
      setReviewState: async (input) => {
        // Another front end records the same decision first; this write then
        // meets the compare-and-set.
        await inner.setReviewState({ ...input, reviewedBy: "someone-else" });
        await inner.setReviewState(input);
      },
    };
    const { deps, taskId, first } = await fixture({ artifacts: racing });
    const answer = await reviewRound(deps, { taskId, workspaceId: "default", decisions: [{ artifactId: first, approved: true }] });
    expect(answer).toMatchObject({ ok: true, result: { decisions: [{ artifactId: first, alreadyDecided: true }] } });
  });

  it("reports a concurrent opposite verdict, naming what this request had already written", async () => {
    const inner = createInMemoryArtifactRepository();
    let target = "";
    const racing: ArtifactRepositoryPort = {
      ...inner,
      setReviewState: async (input) => {
        if (input.artifactId === target) await inner.setReviewState({ ...input, reviewState: "rejected", reviewedBy: "someone-else" });
        await inner.setReviewState(input);
      },
    };
    const { deps, taskId, first, second } = await fixture({ artifacts: racing });
    target = second;
    const answer = await reviewRound(deps, {
      taskId,
      workspaceId: "default",
      decisions: [
        { artifactId: first, approved: true },
        { artifactId: second, approved: true },
      ],
    });
    expect(answer).toMatchObject({ ok: false, error: { code: "CONFLICT", message: expect.stringContaining(`before it: ${first}`) } });
    expect((await racing.getArtifact(first))?.reviewState).toBe("approved");
  });

  it("refuses a slot held by an owner that died before writing anything", async () => {
    const { deps, taskId, first, artifacts, executions } = await fixture({ workflow: unreachable });
    const dead = await executions.acquire({
      taskId,
      ownerSession: "session-dead",
      admissionId: "adm-x",
      leaseMs: 60_000,
      now: { fixed: now() },
    });
    const answer = await reviewRound(deps, {
      taskId,
      workspaceId: "default",
      expectedSteps: 1,
      decisions: [{ artifactId: first, approved: true }],
      resume: true,
    });
    expect(answer).toMatchObject({
      ok: false,
      error: { code: IPC_EXECUTION_BUSY, message: expect.stringContaining(`--generation ${(await dead).generation}`) },
    });
    expect((await artifacts.getArtifact(first))?.reviewState).toBe("pending");
  });

  it("maps an admission's busy slot to EXECUTION_BUSY, saying the records are written", async () => {
    // The race the pre-check cannot see: the slot is taken between the check and
    // the admission's own `acquire`.
    const busy: WorkflowPort = {
      admit: async () => {
        throw new TaviError("CONFLICT", "Task task-1 is already executing under session-other", {
          details: { reason: "execution-busy", generation: 4 },
        });
      },
      checkpoints: {} as never,
    };
    const { deps, taskId, first, artifacts } = await fixture({ workflow: busy });
    const answer = await reviewRound(deps, {
      taskId,
      workspaceId: "default",
      decisions: [{ artifactId: first, approved: true }],
      resume: true,
    });
    expect(answer).toMatchObject({
      ok: false,
      error: { code: IPC_EXECUTION_BUSY, message: expect.stringContaining("the artifact decisions are recorded") },
    });
    expect((await artifacts.getArtifact(first))?.reviewState).toBe("approved");
  });
});
