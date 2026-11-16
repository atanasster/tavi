import { approvalRowId, pendingRoundOf, type InvocationContext, type ModelOutcome, type ModelPort } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import type { ServeHandle } from "../../src/server/serve.js";
import { ATTACHED, capture, ndjson, turns, useAttachedOwners } from "../support/attached-owner.js";

/**
 * `tavi approvals approve|reject` and `tavi artifacts approve|reject [--resume]`
 * under a live owner: decided over IPC, the resumed turn
 * followed to its end, with the offline command's exit codes.
 */

const owners = useAttachedOwners("tavi-decide-");
const PLACEHOLDER = { source: "placeholder", connectionId: "default", model: "default", workspaceId: "default" } as const;
const TARGET = ["--connection", "fixture-conn", "--model", "fixture-model"];

/** A task waiting on its first approval round, started by an attached `tavi run` that could not ask it. */
async function waitingTask(directory: string, handle: ServeHandle): Promise<string> {
  const asked = capture();
  expect(await main(["run", "open a browser", "--data-dir", directory], { io: asked.io }), asked.stderr()).toBe(EXIT.approvalRequired);
  const task = (await handle.runtime.store.asPort().repositories.tasks.list(10)).find((row) => row.status === "waiting");
  if (task === undefined) throw new Error("no waiting task");
  return task.taskId;
}

/** One turn asking for two gated calls at once — a round of two — then an answer. */
function twoCallRound(): ModelPort {
  let calls = 0;
  return {
    async stream(request): Promise<ModelOutcome> {
      calls += 1;
      if (calls > 1) return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: "",
        toolCalls: [
          { id: "call-a", name: "browser.create_session", input: {} },
          { id: "call-b", name: "browser.create_session", input: {} },
        ],
        finishReason: "tool-calls",
        usage: {},
      };
    },
  };
}

/** A model whose first turn per task runs `sandbox.run` once per id, archived for review, and which then answers. */
function archiving(ids: readonly string[]): ModelPort {
  return {
    async stream(request, options): Promise<ModelOutcome> {
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
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b-review", text: "reviewed" });
      return { status: "completed", attemptId: request.attemptId, text: "reviewed", toolCalls: [], usage: {} };
    },
  };
}

const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };

/** An owner with a task suspended on the review of one archived artifact per id. */
async function reviewing(ids: readonly string[]) {
  const { handle, directory } = await owners.startOwner(archiving(ids), { review: true });
  const outcome = await handle.runtime.workflow?.admit({ context, operationKey: "op-review", kind: "start", prompt: "archive" });
  const taskId = outcome?.taskId ?? "";
  const round = pendingRoundOf(await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId));
  const artifactIds = round?.kind === "review" ? round.artifactIds : [];
  return { handle, directory, taskId, artifactIds };
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("tavi approvals approve|reject under a live owner", ATTACHED, () => {
  it("decides the round on the owner and renders the resumed turn to its end", async () => {
    const { handle, directory } = await owners.startOwner(turns(["call-1"]));
    const taskId = await waitingTask(directory, handle);

    const decided = capture();
    expect(
      await main(["approvals", "approve", taskId, "--format", "json", "--data-dir", directory], { io: decided.io }),
      decided.stderr(),
    ).toBe(EXIT.ok);
    const events = ndjson(decided.stdout());
    // The turn the round suspended is not rendered again; the resumed one is.
    expect(events.map((event) => event.kind)).not.toContain("run.started");
    expect(events.map((event) => event.kind)).not.toContain("approval.required");
    expect(events.at(-1)?.kind).toBe("task.completed");
    const repositories = handle.runtime.store.asPort().repositories;
    expect(await repositories.approvals.get(approvalRowId(taskId, "call-1", 1))).toMatchObject({ state: "granted", decidedBy: "operator" });

    // Nothing is left to decide: the offline command's exit 8.
    const again = capture();
    expect(await main(["approvals", "approve", taskId, "--data-dir", directory], { io: again.io })).toBe(EXIT.resumeNotApplicable);
  });

  it("reports the next round with exit 3 even on a terminal, and refuses what the owner cannot honour", async () => {
    const { handle, directory } = await owners.startOwner(turns(["call-1", "call-2"]));
    const taskId = await waitingTask(directory, handle);
    const repositories = handle.runtime.store.asPort().repositories;

    for (const [argv, code, says] of [
      [["--operation-key", "k"], EXIT.usage, "--operation-key cannot apply"],
      [["--api-key-file", "/nowhere"], EXIT.usage, "--api-key-file cannot apply"],
      [["--model", "other-model"], EXIT.usage, "fixture-conn/fixture-model"],
      [["--workspace", "elsewhere"], EXIT.usage, "belongs to workspace default"],
      [["--call", "call-9"], EXIT.resumeNotApplicable, "no pending approval for call call-9"],
    ] as const) {
      const refused = capture();
      expect(await main(["approvals", "approve", taskId, ...argv, "--data-dir", directory], { io: refused.io }), argv.join(" ")).toBe(code);
      expect(refused.stderr()).toContain(says);
    }
    expect((await repositories.approvals.get(approvalRowId(taskId, "call-1", 1)))?.state).toBe("pending");
    const unknown = capture();
    expect(await main(["approvals", "approve", "task-none", "--data-dir", directory], { io: unknown.io })).toBe(EXIT.resumeNotApplicable);

    // The resumed turn asks for another call: reported, as offline, not asked.
    const rejected = capture(true);
    expect(await main(["approvals", "reject", taskId, "--data-dir", directory], { io: rejected.io }), rejected.stderr()).toBe(
      EXIT.approvalRequired,
    );
    expect(rejected.stderr()).toContain("Pending approval: browser.create_session (call call-2)");
    expect((await repositories.approvals.get(approvalRowId(taskId, "call-1", 1)))?.state).toBe("denied");
  });

  it("refuses --call on a round of several calls, deciding nothing", async () => {
    const { handle, directory } = await owners.startOwner(twoCallRound());
    const taskId = await waitingTask(directory, handle);
    const partial = capture();
    expect(await main(["approvals", "approve", taskId, "--call", "call-a", "--data-dir", directory], { io: partial.io })).toBe(EXIT.usage);
    expect(partial.stderr()).toContain("decide them together");
    const repositories = handle.runtime.store.asPort().repositories;
    expect((await repositories.approvals.get(approvalRowId(taskId, "call-a", 1)))?.state).toBe("pending");

    const whole = capture();
    expect(await main(["approvals", "approve", taskId, "--data-dir", directory], { io: whole.io }), whole.stderr()).toBe(EXIT.ok);
    expect((await repositories.approvals.get(approvalRowId(taskId, "call-b", 1)))?.state).toBe("granted");
  });

  it("refuses to resume a task on an owner with no configured model, after telling an unknown task apart", async () => {
    const first = await owners.startOwner(turns(["call-1"]));
    const taskId = await waitingTask(first.directory, first.handle);
    await owners.stopLatest("restart unconfigured");

    const placeholder = await owners.startOwner(turns([]), { directory: first.directory, modelTarget: PLACEHOLDER });
    const refused = capture();
    expect(await main(["approvals", "approve", taskId, "--data-dir", first.directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toContain("NOT_CONFIGURED");
    // Nothing to decide comes first, as offline.
    const unknown = capture();
    expect(await main(["approvals", "approve", "task-none", "--data-dir", first.directory], { io: unknown.io })).toBe(
      EXIT.resumeNotApplicable,
    );

    // The owner's own `approve` refuses it too.
    const client = await owners.attach(placeholder.handle);
    const direct = await client.request("approve", { taskId, workspaceId: "default", verdict: "approve" }, "approve-placeholder");
    expect(direct.error?.code).toBe("NOT_CONFIGURED");
    const repositories = placeholder.handle.runtime.store.asPort().repositories;
    expect((await repositories.approvals.get(approvalRowId(taskId, "call-1", 1)))?.state).toBe("pending");
    expect((await repositories.tasks.get(taskId))?.status).toBe("waiting");
  });
});

describe("tavi artifacts approve|reject under a live owner", ATTACHED, () => {
  it("decides an artifact and resumes its task, re-suspending on the rest (6), then finishing (0)", async () => {
    const { handle, directory, taskId, artifactIds } = await reviewing(["call-a", "call-b"]);
    const [first, second] = artifactIds;

    const partial = capture();
    expect(
      await main(["artifacts", "approve", first ?? "", "--resume", ...TARGET, "--data-dir", directory], { io: partial.io }),
      partial.stderr(),
    ).toBe(EXIT.reviewRequired);
    expect(partial.stderr()).toContain(`Pending artifact review: ${second}`);

    // Another target is refused before anything is written.
    const other = capture();
    expect(
      await main(
        ["artifacts", "approve", second ?? "", "--resume", "--connection", "fixture-conn", "--model", "x", "--data-dir", directory],
        { io: other.io },
      ),
    ).toBe(EXIT.usage);
    expect(other.stderr()).toContain("name fixture-conn/fixture-model");
    expect((await handle.runtime.store.asPort().repositories.artifacts.getArtifact(second ?? ""))?.reviewState).toBe("pending");

    const rest = capture();
    expect(
      await main(["artifacts", "reject", second ?? "", "--resume", ...TARGET, "--data-dir", directory], { io: rest.io }),
      rest.stderr(),
    ).toBe(EXIT.ok);
    expect(rest.stdout()).toContain("reviewed");
    expect((await handle.runtime.store.asPort().repositories.tasks.get(taskId))?.status).toBe("completed");
  });

  it("prints the decided artifact's record, as offline", async () => {
    const { directory, taskId, artifactIds } = await reviewing(["call-a"]);
    const decided = capture();
    expect(
      await main(["artifacts", "approve", artifactIds[0] ?? "", "--format", "json", "--data-dir", directory], { io: decided.io }),
    ).toBe(EXIT.ok);
    expect(JSON.parse(decided.stdout())).toMatchObject({
      artifactId: artifactIds[0],
      runId: taskId,
      reviewState: "approved",
      sha256: expect.any(String),
    });
  });

  it("renders only its own resume: not earlier partial acknowledgements, and all of it after an owner restart", async () => {
    const { directory, artifactIds } = await reviewing(["call-a", "call-b", "call-c"]);
    const [first, second, third] = artifactIds;
    const json = ["--format", "json", "--data-dir", directory];

    const one = capture();
    expect(await main(["artifacts", "approve", first ?? "", "--resume", ...TARGET, ...json], { io: one.io }), one.stderr()).toBe(
      EXIT.reviewRequired,
    );
    const two = capture();
    expect(await main(["artifacts", "approve", second ?? "", "--resume", ...TARGET, ...json], { io: two.io }), two.stderr()).toBe(
      EXIT.reviewRequired,
    );
    // Its own re-suspension, not the first resume's as well.
    expect(count(two.stdout(), '"kind":"task.review_required"')).toBe(1);

    // After a restart the owner holds nothing of the task: the resumed turn is all there is.
    await owners.stopLatest("restart mid-review");
    await owners.startOwner(archiving(["call-a", "call-b", "call-c"]), { directory, review: true });
    const three = capture();
    expect(await main(["artifacts", "approve", third ?? "", "--resume", ...TARGET, ...json], { io: three.io }), three.stderr()).toBe(
      EXIT.ok,
    );
    expect(three.stdout()).toContain('"kind":"text.delta"');
    expect(three.stdout()).toContain('"kind":"task.completed"');
    expect(count(three.stdout(), '"kind":"task.review_required"')).toBe(0);
  });

  it("records a decision with nothing to resume and exits 8; a plain decision ignores the resume's flags", async () => {
    const { handle, directory, taskId, artifactIds } = await reviewing(["call-a", "call-b"]);
    const [first, second] = artifactIds;
    const artifacts = handle.runtime.store.asPort().repositories.artifacts;

    // Without --resume: decided, the task left suspended on the rest. The
    // resume's flags are ignored, as offline.
    const plain = capture();
    expect(
      await main(["artifacts", "approve", first ?? "", "--api-key-file", "/nowhere", "--data-dir", directory], { io: plain.io }),
      plain.stderr(),
    ).toBe(EXIT.ok);
    expect((await artifacts.getArtifact(first ?? ""))?.reviewState).toBe("approved");
    expect((await handle.runtime.store.asPort().repositories.tasks.get(taskId))?.status).toBe("waiting");

    const cancelled = capture();
    expect(
      await main(["cancel", taskId, "--reason", "no longer needed", "--data-dir", directory], { io: cancelled.io }),
      cancelled.stderr(),
    ).toBe(EXIT.ok);
    const nothing = capture();
    expect(await main(["artifacts", "reject", second ?? "", "--resume", ...TARGET, "--data-dir", directory], { io: nothing.io })).toBe(
      EXIT.resumeNotApplicable,
    );
    expect(nothing.stderr()).toContain("The artifact decision is recorded; there is nothing to resume");
    expect((await artifacts.getArtifact(second ?? ""))?.reviewState).toBe("rejected");

    // A task-less artifact: decided, with nothing to resume.
    const orphan = await artifacts.putArtifact({
      workspaceId: "default",
      contentType: "text/plain",
      body: "loose",
      reviewState: "pending",
    });
    const loose = capture();
    expect(await main(["artifacts", "approve", orphan.artifactId, "--resume", ...TARGET, "--data-dir", directory], { io: loose.io })).toBe(
      EXIT.resumeNotApplicable,
    );
    expect(loose.stderr()).toContain("has no associated task");
    expect((await artifacts.getArtifact(orphan.artifactId))?.reviewState).toBe("approved");

    const pendingMetadata = await artifacts.putArtifact({
      workspaceId: "default",
      contentType: "text/plain",
      body: "pending",
      reviewState: "pending",
    });
    // The metadata review queue is readable through the live owner.
    const listed = capture();
    expect(await main(["artifacts", "list", "--data-dir", directory], { io: listed.io }), listed.stderr()).toBe(EXIT.ok);
    expect(listed.stderr()).toBe("");
    expect(listed.stdout()).toContain(pendingMetadata.artifactId);

    const keyed = capture();
    expect(
      await main(["artifacts", "approve", "art-x", "--resume", ...TARGET, "--operation-key", "k", "--data-dir", directory], {
        io: keyed.io,
      }),
    ).toBe(EXIT.usage);
  });
});

describe("IPC review, addressed by artifact", ATTACHED, () => {
  it("derives the task, decides task-less artifacts without one, and refuses artifacts of two tasks", async () => {
    const { handle, taskId, artifactIds } = await reviewing(["call-a"]);
    const artifacts = handle.runtime.store.asPort().repositories.artifacts;
    const client = await owners.attach(handle);

    const orphan = await artifacts.putArtifact({
      workspaceId: "default",
      contentType: "text/plain",
      body: "loose",
      reviewState: "pending",
    });
    const taskless = await client.request(
      "review",
      { workspaceId: "default", decisions: [{ artifactId: orphan.artifactId, approved: false }], resume: true },
      "review-taskless",
    );
    expect(taskless.ok, JSON.stringify(taskless.error)).toBe(true);
    expect(taskless.result).toMatchObject({ taskId: null, records: [{ artifactId: orphan.artifactId, reviewState: "rejected" }] });
    expect((taskless.result as { resumed?: unknown }).resumed).toBeUndefined();

    const another = await artifacts.putArtifact({
      workspaceId: "default",
      contentType: "text/plain",
      body: "other",
      reviewState: "pending",
    });
    const mixed = await client.request(
      "review",
      {
        workspaceId: "default",
        decisions: [
          { artifactId: artifactIds[0], approved: true },
          { artifactId: another.artifactId, approved: true },
        ],
      },
      "review-mixed",
    );
    expect(mixed.error?.code).toBe("INVALID_INPUT");
    expect((await artifacts.getArtifact(artifactIds[0] ?? ""))?.reviewState).toBe("pending");

    // A resume asserting another target is refused before anything is written;
    // a plain decision is not a resume, and is not checked.
    const targeted = await client.request(
      "review",
      { workspaceId: "default", decisions: [{ artifactId: artifactIds[0], approved: true }], resume: true, expectTarget: { model: "x" } },
      "review-targeted",
    );
    expect(targeted.error?.code).toBe("INVALID_INPUT");
    expect((await artifacts.getArtifact(artifactIds[0] ?? ""))?.reviewState).toBe("pending");
    const plain = await client.request(
      "review",
      { workspaceId: "default", decisions: [{ artifactId: artifactIds[0], approved: true }], expectTarget: { model: "x" } },
      "review-plain",
    );
    expect(plain.result).toMatchObject({ taskId });
  });

  it("refuses a review's resume on an owner with no configured model, and records a plain decision", async () => {
    const { directory, artifactIds } = await reviewing(["call-a", "call-b"]);
    await owners.stopLatest("restart unconfigured");
    const placeholder = await owners.startOwner(archiving([]), { directory, modelTarget: PLACEHOLDER, review: true });
    const client = await owners.attach(placeholder.handle);
    const artifacts = placeholder.handle.runtime.store.asPort().repositories.artifacts;

    const resumed = await client.request(
      "review",
      { workspaceId: "default", decisions: [{ artifactId: artifactIds[0], approved: true }], resume: true },
      "review-resume",
    );
    expect(resumed.error?.code).toBe("NOT_CONFIGURED");
    expect((await artifacts.getArtifact(artifactIds[0] ?? ""))?.reviewState).toBe("pending");
    const recorded = await client.request(
      "review",
      { workspaceId: "default", decisions: [{ artifactId: artifactIds[0], approved: true }] },
      "review-record",
    );
    expect(recorded.ok, JSON.stringify(recorded.error)).toBe(true);
    expect((await artifacts.getArtifact(artifactIds[0] ?? ""))?.reviewState).toBe("approved");
  });
});
