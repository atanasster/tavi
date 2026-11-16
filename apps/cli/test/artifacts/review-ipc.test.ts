import {
  IPC_EXECUTION_BUSY,
  IPC_NOT_PENDING,
  pendingRoundOf,
  type InvocationContext,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createFixtureSandbox } from "@tavi/test-support/sandbox";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/io.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * IPC `review`: artifact decisions, and with `resume` the
 * review suspension's acknowledgement under its own key, answered on the claim.
 */

const directories = temporaryDirectories({ prefix: "tavi-review-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };

/**
 * A model whose first turn runs `fixture.capture` once per id, each making an
 * artifact a person must review, and which then answers. Every request is
 * kept, so a test can read what the model was shown.
 */
function archivingModel(
  ids: readonly string[],
  /** Hold every answering turn until this settles. */
  hold?: Promise<void>,
): ModelPort & { readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async stream(request): Promise<ModelOutcome> {
      requests.push(request);
      // Each task's first turn — one with no tool results yet — runs the tools.
      if (!request.messages.some((message) => (message.toolResults?.length ?? 0) > 0)) {
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: ids.map((id) => ({ id, name: "fixture.capture", input: {} })),
          finishReason: "tool-calls",
          usage: {},
        };
      }
      if (hold !== undefined) await hold;
      return { status: "completed", attemptId: request.attemptId, text: "reviewed", toolCalls: [], usage: {} };
    },
  };
}

/** A model whose first turn asks for a gated browser call instead. */
function gatedModel(): ModelPort {
  let calls = 0;
  return {
    async stream(request): Promise<ModelOutcome> {
      calls += 1;
      if (calls === 1) {
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: "call-a", name: "browser.create_session", input: {} }],
          finishReason: "tool-calls",
          usage: {},
        };
      }
      return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
    },
  };
}

async function startServe(directory: string, model: ModelPort): Promise<ServeHandle> {
  const handle = await serve(
    fixtureServeOptions(directory, {
      defaultConnectionId: "fixture-conn",
      // Only the (mutating) browser tool is gated here, so the read-only
      // `fixture.capture` goes straight to its artifact's review.
      approvalRequiredFor: ["mutating"],
      devFixtureTools: true,
    }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    quietIo,
    { modelOverride: model, sandboxOverride: createFixtureSandbox({ mode: "echo" }), browserOverride: createFixtureBrowser() },
  );
  handles.push(handle);
  return handle;
}

async function attach(directory: string): Promise<IpcClient> {
  const owner = await findLiveOwner(directory);
  if (owner === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(owner);
  clients.push(client);
  return client;
}

const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };

async function started(handle: ServeHandle, operationKey = "op-start"): Promise<string> {
  const outcome = await handle.runtime.workflow?.admit({ context, operationKey, kind: "start", prompt: "do it" });
  if (outcome === undefined) throw new Error("no workflow");
  return outcome.taskId;
}

const pendingOf = async (handle: ServeHandle, taskId: string) =>
  pendingRoundOf(await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId));
const statusOf = async (handle: ServeHandle, taskId: string) =>
  (await handle.runtime.store.asPort().repositories.tasks.get(taskId))?.status;

describe("IPC review", () => {
  it("decides part of a review round and resumes, re-suspends on the rest, then finishes with the reviewer's note", async () => {
    const directory = directories.create();
    const model = archivingModel(["call-a", "call-b"]);
    const handle = await startServe(directory, model);
    const taskId = await started(handle);
    const round = await pendingOf(handle, taskId);
    expect(round?.kind).toBe("review");
    const [first, second] = round?.kind === "review" ? round.artifactIds : [];
    const client = await attach(directory);

    const partial = await client.request(
      "review",
      { taskId, workspaceId: "default", expectedSteps: round?.steps, decisions: [{ artifactId: first, approved: true }], resume: true },
      "partial",
    );
    expect(partial.ok, JSON.stringify(partial.error)).toBe(true);
    expect(partial.result).toMatchObject({
      decisions: [{ artifactId: first, reviewState: "approved", alreadyDecided: false }],
      resumed: { replayed: false },
    });
    // The node suspends again, under the same round, on what is still undecided.
    await waitFor(async () => {
      const next = await pendingOf(handle, taskId);
      return next?.kind === "review" && next.admissionId !== round?.admissionId;
    });
    const again = await pendingOf(handle, taskId);
    expect(again?.kind === "review" ? again.artifactIds : []).toEqual([second]);

    const rest = await client.request(
      "review",
      {
        taskId,
        workspaceId: "default",
        expectedSteps: again?.steps,
        decisions: [{ artifactId: second, approved: false, note: "it prints a token" }],
        reviewedBy: "alice",
        resume: true,
      },
      "rest",
    );
    expect(rest.ok, JSON.stringify(rest.error)).toBe(true);
    await waitFor(async () => (await statusOf(handle, taskId)) === "completed");
    // The model was told why, in the reviewer's words.
    const shown = JSON.stringify(model.requests.at(-1)?.messages);
    expect(shown).toContain("it prints a token");
    expect(await handle.runtime.store.asPort().repositories.artifacts.getArtifact(second ?? "")).toMatchObject({
      reviewState: "rejected",
      reviewedBy: "alice",
      reviewNote: "it prints a token",
    });
  });

  it("records decisions without resuming, and treats the same decision again as already made", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, archivingModel(["call-a"]));
    const taskId = await started(handle);
    const round = await pendingOf(handle, taskId);
    const artifactId = round?.kind === "review" ? round.artifactIds[0] : undefined;
    const admissions = (await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).length;
    const client = await attach(directory);

    const recorded = await client.request(
      "review",
      { taskId, workspaceId: "default", decisions: [{ artifactId, approved: true }] },
      "record",
    );
    expect(recorded.ok, JSON.stringify(recorded.error)).toBe(true);
    expect(recorded.result).toEqual({
      taskId,
      decisions: [{ artifactId, reviewState: "approved", alreadyDecided: false }],
      // The decided record, as `tavi artifacts approve` prints it.
      records: [expect.objectContaining({ artifactId, runId: taskId, reviewState: "approved", reviewedBy: "operator" })],
    });
    expect(await statusOf(handle, taskId)).toBe("waiting");
    expect(await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).toHaveLength(admissions);

    const repeated = await client.request(
      "review",
      { taskId, workspaceId: "default", decisions: [{ artifactId, approved: true }] },
      "again",
    );
    expect(repeated.result).toMatchObject({ decisions: [{ artifactId, alreadyDecided: true }] });
    const reversed = await client.request(
      "review",
      { taskId, workspaceId: "default", decisions: [{ artifactId, approved: false }] },
      "reverse",
    );
    expect(reversed.error?.code).toBe("CONFLICT");
  });

  it("refuses before writing anything: a foreign, unknown or repeated artifact, a stale round, or no review pending", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, archivingModel(["call-a"]));
    const taskId = await started(handle);
    const round = await pendingOf(handle, taskId);
    const artifactId = round?.kind === "review" ? (round.artifactIds[0] ?? "") : "";
    const other = await started(handle, "op-other");
    const otherRound = await pendingOf(handle, other);
    const foreign = otherRound?.kind === "review" ? otherRound.artifactIds[0] : undefined;
    const client = await attach(directory);
    const artifacts = handle.runtime.store.asPort().repositories.artifacts;

    const cases: [Record<string, unknown>, string][] = [
      [{ decisions: [{ artifactId: foreign, approved: true }] }, "INVALID_INPUT"],
      [{ decisions: [{ artifactId: "art-none", approved: true }] }, "NOT_FOUND"],
      [
        {
          decisions: [
            { artifactId, approved: true },
            { artifactId, approved: false },
          ],
        },
        "INVALID_INPUT",
      ],
      [{ decisions: [{ artifactId, approved: true }], resume: true, expectedSteps: (round?.steps ?? 0) + 3 }, "CONFLICT"],
    ];
    for (const [payload, code] of cases) {
      const response = await client.request("review", { taskId, workspaceId: "default", ...payload }, `case-${code}-${Math.random()}`);
      expect(response.error?.code, JSON.stringify(payload)).toBe(code);
    }
    expect((await artifacts.getArtifact(artifactId))?.reviewState).toBe("pending");
    expect((await artifacts.getArtifact(foreign ?? ""))?.reviewState).toBe("pending");

    // A task waiting on an approval has no review to resume: nothing is written.
    const gatedDirectory = directories.create();
    await handles.pop()?.shutdown("next owner");
    const gated = await startServe(gatedDirectory, gatedModel());
    const gatedTask = await started(gated);
    const gatedClient = await attach(gatedDirectory);
    const noReview = await gatedClient.request(
      "review",
      { taskId: gatedTask, workspaceId: "default", decisions: [{ artifactId: "art-none", approved: true }], resume: true },
      "no-review",
    );
    // The artifact is checked first; with a real one of this task, the missing
    // review round is what refuses.
    expect(noReview.error?.code).toBe("NOT_FOUND");
    const gatedArtifact = await gated.runtime.store.asPort().repositories.artifacts.putArtifact({
      workspaceId: "default",
      runId: gatedTask,
      contentType: "text/plain",
      body: "x",
      reviewState: "pending",
    });
    const refused = await gatedClient.request(
      "review",
      { taskId: gatedTask, workspaceId: "default", decisions: [{ artifactId: gatedArtifact.artifactId, approved: true }], resume: true },
      "refused",
    );
    expect(refused.error).toMatchObject({ code: IPC_NOT_PENDING, message: expect.stringContaining("approve") });
    expect((await gated.runtime.store.asPort().repositories.artifacts.getArtifact(gatedArtifact.artifactId))?.reviewState).toBe("pending");
  });

  it("answers a retried acknowledgement from the record once it committed", async () => {
    // A client's retry after a lost response: every artifact is already decided,
    // and an acknowledgement of that round made after them committed.
    const directory = directories.create();
    const handle = await startServe(directory, archivingModel(["call-a"]));
    const taskId = await started(handle);
    const round = await pendingOf(handle, taskId);
    const artifactId = round?.kind === "review" ? round.artifactIds[0] : undefined;
    const client = await attach(directory);
    const request = {
      taskId,
      workspaceId: "default",
      expectedSteps: round?.steps,
      decisions: [{ artifactId, approved: true }],
      resume: true,
    };

    const first = await client.request("review", request, "first");
    expect(first.result).toMatchObject({ resumed: { replayed: false } });
    await waitFor(async () => (await statusOf(handle, taskId)) === "completed");
    const admissions = (await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).length;

    const retried = await client.request("review", request, "retry");
    expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
    expect(retried.result).toMatchObject({
      decisions: [{ artifactId, alreadyDecided: true }],
      resumed: { steps: round?.steps, replayed: true, status: "completed" },
    });
    expect(await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).toHaveLength(admissions);
  });

  it("acknowledges decisions recorded earlier without resume", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, archivingModel(["call-a"]));
    const taskId = await started(handle);
    const round = await pendingOf(handle, taskId);
    const artifactId = round?.kind === "review" ? round.artifactIds[0] : undefined;
    const client = await attach(directory);
    expect(
      (await client.request("review", { taskId, workspaceId: "default", decisions: [{ artifactId, approved: true }] }, "record")).ok,
    ).toBe(true);
    const resumed = await client.request(
      "review",
      { taskId, workspaceId: "default", expectedSteps: round?.steps, decisions: [{ artifactId, approved: true }], resume: true },
      "resume",
    );
    expect(resumed.result).toMatchObject({ decisions: [{ artifactId, alreadyDecided: true }], resumed: { replayed: false } });
    await waitFor(async () => (await statusOf(handle, taskId)) === "completed");
  });

  it("refuses a rejection with a different note, and a round without resume", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, archivingModel(["call-a"]));
    const taskId = await started(handle);
    const round = await pendingOf(handle, taskId);
    const artifactId = round?.kind === "review" ? round.artifactIds[0] : undefined;
    const client = await attach(directory);
    const reject = (note: string, requestId: string) =>
      client.request("review", { taskId, workspaceId: "default", decisions: [{ artifactId, approved: false, note }] }, requestId);
    expect((await reject("it prints a token", "first")).ok).toBe(true);
    expect((await reject("it prints a token", "same")).result).toMatchObject({ decisions: [{ alreadyDecided: true }] });
    // The note is what the model reads: another one is another decision.
    expect((await reject("it is too long", "other")).error).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("different note"),
    });
    const stepsOnly = await client.request(
      "review",
      {
        taskId,
        workspaceId: "default",
        expectedSteps: round?.steps,
        decisions: [{ artifactId, approved: false, note: "it prints a token" }],
      },
      "steps",
    );
    expect(stepsOnly.error?.code).toBe("INVALID_INPUT");
  });

  it("answers an identical acknowledgement that is running at once, and refuses one that would write under it", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const directory = directories.create();
    const handle = await startServe(directory, archivingModel(["call-a"], held));
    const taskId = await started(handle);
    const round = await pendingOf(handle, taskId);
    const artifactId = round?.kind === "review" ? round.artifactIds[0] : undefined;
    const client = await attach(directory);
    const request = {
      taskId,
      workspaceId: "default",
      expectedSteps: round?.steps,
      decisions: [{ artifactId, approved: true }],
      resume: true,
    };

    const first = await client.request("review", request, "first");
    expect(first.result).toMatchObject({ resumed: { replayed: false } });
    // The acknowledged turn is now held in its model call.
    const same = await client.request("review", request, "same");
    expect(same.result).toMatchObject({ resumed: { replayed: true } });
    expect((same.result as { resumed?: { status?: string } }).resumed?.status).toBeUndefined();

    // Another of the task's artifacts, decided with `resume` while the
    // acknowledgement runs: it would be answered as that one, which already read
    // the artifacts — so it is refused, and nothing is written.
    const extra = await handle.runtime.store.asPort().repositories.artifacts.putArtifact({
      workspaceId: "default",
      runId: taskId,
      contentType: "text/plain",
      body: "x",
      reviewState: "pending",
    });
    const writing = await client.request(
      "review",
      { taskId, workspaceId: "default", decisions: [{ artifactId: extra.artifactId, approved: true }], resume: true },
      "writing",
    );
    expect(writing.error?.code).toBe(IPC_EXECUTION_BUSY);
    expect((await handle.runtime.store.asPort().repositories.artifacts.getArtifact(extra.artifactId))?.reviewState).toBe("pending");
    release();
    await waitFor(async () => (await statusOf(handle, taskId)) === "completed");
  });

  it("leaves a schedule's in-flight task to its fire", async () => {
    const directory = directories.create();
    const handle = await startServe(directory, archivingModel(["call-a"]));
    const taskId = await started(handle);
    const round = await pendingOf(handle, taskId);
    const artifactId = round?.kind === "review" ? round.artifactIds[0] : undefined;
    const leave = handle.runtime.scheduleFires.enter(taskId, "sched-brief");
    const client = await attach(directory);
    const refused = await client.request("review", { taskId, workspaceId: "default", decisions: [{ artifactId, approved: true }] }, "fire");
    expect(refused.error?.code).toBe("NOT_AUTHORIZED");
    leave();
    const decided = await client.request(
      "review",
      { taskId, workspaceId: "default", decisions: [{ artifactId, approved: true }] },
      "after",
    );
    expect(decided.ok, JSON.stringify(decided.error)).toBe(true);
  });
});
