import { EventEmitter } from "node:events";

import { STEP_FACTS_HEADING } from "@tavi/agent-host/system-prompt";

import {
  CLIENT_PROTOCOL_VERSION,
  IPC_COMMANDS,
  TURN_STOPPED_MESSAGE,
  type ClientEvent,
  type InvocationContext,
  type ModelOutcome,
  type ModelPort,
} from "@tavi/contracts";
import type { IpcClient, IpcClientResponse } from "@tavi/runtime";
import { waitFor, delay } from "@tavi/test-support";
import { describe, expect, it } from "vitest";

import { approveOnOwner, attachToRunningTask, runOnOwner, type FollowOptions } from "../../src/features/run/attached.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { ATTACHED, capture, capturing, ndjson, turns, useAttachedOwners } from "../support/attached-owner.js";

/**
 * `tavi run` under a live owner, `tavi run --attach` and `tavi abort`:
 * dispatched to the owner, followed here, exit codes from the
 * event the stream ends on, and Ctrl-C detaching rather than aborting.
 */

const owners = useAttachedOwners("tavi-attached-");
const { tempDirectory } = owners;
const withoutStepFacts = (text: string): string => text.split(`\n\n${STEP_FACTS_HEADING}`)[0] ?? text;
const isStepFacts = (message: { readonly role: string; readonly text: string }): boolean =>
  message.role === "user" && message.text.startsWith(STEP_FACTS_HEADING);
const startOwner = (model: ModelPort) => owners.startOwner(model);

describe("tavi run under a live owner", ATTACHED, () => {
  it("dispatches the run to the owner and renders its stream, exiting on the event it ends with", async () => {
    const { handle, directory } = await startOwner(turns([]));
    const run = capture();
    const code = await main(["run", "say done", "--format", "json", "--data-dir", directory], { io: run.io });
    expect(code, run.stderr()).toBe(EXIT.ok);
    const events = ndjson(run.stdout());
    expect(events.map((event) => event.kind)).toEqual(["run.started", "text.delta", "task.completed"]);
    expect((await handle.runtime.store.asPort().repositories.tasks.get(events[0]?.runId ?? ""))?.origin).toBe("ipc");
  });

  it("runs a chat on the --connection/--model both named, and refuses one the owner offers no connection for", async () => {
    const { handle, directory } = await startOwner(turns([]));
    const refused = capture();
    expect(await main(["run", "hi", "--connection", "other", "--model", "x", "--data-dir", directory], { io: refused.io })).toBe(
      EXIT.usage,
    );
    expect(refused.stderr()).toContain("no configured connection offers other/x");
    // One alone is still an assertion of what the owner runs.
    const asserted = capture();
    expect(await main(["run", "hi", "--model", "x", "--data-dir", directory], { io: asserted.io })).toBe(EXIT.usage);
    expect(asserted.stderr()).toContain("fixture-conn/fixture-model");
    const same = capture();
    expect(await main(["run", "hi", "--connection", "fixture-conn", "--data-dir", directory], { io: same.io }), same.stderr()).toBe(
      EXIT.ok,
    );
    // Both naming a configured connection: the chat's own model.
    const added = capture();
    expect(
      await main(["models", "add", "c1", "--base-url", "http://127.0.0.1:1/v1", "--credential", "c1.key", "--data-dir", directory], {
        io: added.io,
      }),
      added.stderr(),
    ).toBe(EXIT.ok);
    const chosen = capture();
    expect(
      await main(["run", "say done", "--connection", "c1", "--model", "m1", "--format", "json", "--data-dir", directory], {
        io: chosen.io,
      }),
      chosen.stderr(),
    ).toBe(EXIT.ok);
    const taskId = ndjson(chosen.stdout())[0]?.runId ?? "";
    expect(await handle.runtime.taskRouting.effectiveTarget?.({ workspaceId: "default", principalId: "operator" }, taskId)).toEqual({
      connectionId: "c1",
      model: "m1",
    });
  });

  it("reports a round it may not ask for with exit 3, and lets the owner answer under --approval approve", async () => {
    const { handle, directory } = await startOwner(turns(["call-1"]));
    const asked = capture();
    expect(await main(["run", "open a browser", "--data-dir", directory], { io: asked.io })).toBe(EXIT.approvalRequired);
    expect(asked.stderr()).toContain("Pending approval: browser.create_session (call call-1)");
    const waiting = (await handle.runtime.store.asPort().repositories.tasks.list(10)).find((task) => task.status === "waiting");
    expect(waiting).toBeDefined();

    // The same task, followed from its beginning: still waiting on the round.
    const attached = capture();
    expect(await main(["run", "--attach", waiting?.taskId ?? "", "--data-dir", directory], { io: attached.io })).toBe(
      EXIT.approvalRequired,
    );

    const approved = capture();
    expect(
      await main(["run", "open a browser", "--approval", "approve", "--operation-key", "op-auto", "--data-dir", directory], {
        io: approved.io,
      }),
    ).toBe(EXIT.ok);
  });

  it("releases a review round under --approval approve, so the run goes on to its answer; without it the run stops on the review", async () => {
    const { handle, directory } = await owners.startOwner(capturing("seen it"), { review: true });
    const artifacts = handle.runtime.store.asPort().repositories.artifacts;

    // Attended (`ask`): the review is a person's, and the run stops on it.
    const asked = capture();
    expect(await main(["run", "capture it", "--data-dir", directory], { io: asked.io })).toBe(EXIT.reviewRequired);
    expect(asked.stderr()).toContain("waiting on artifact review");
    expect(await artifacts.listPendingReview("default", 10)).toHaveLength(1);

    const approved = capture();
    expect(
      await main(["run", "capture it", "--approval", "approve", "--format", "json", "--data-dir", directory], { io: approved.io }),
      approved.stderr(),
    ).toBe(EXIT.ok);
    const events = ndjson(approved.stdout());
    expect(events.map((event) => event.kind)).toContain("task.review_required");
    expect(events.at(-1)?.kind).toBe("task.completed");
    const taskId = events[0]?.runId ?? "";
    const released = (await artifacts.listPendingReview("default", 10)).filter((record) => record.runId === taskId);
    expect(released).toEqual([]);
    // The ask run's artifact is untouched: approve releases only its own run's round.
    expect(await artifacts.listPendingReview("default", 10)).toHaveLength(1);
  });

  it("ends an --approval approve run with exit 6 and the reason when the owner gives up on its review, as ask still does", async () => {
    const asking: ModelPort = {
      async stream(request, options): Promise<ModelOutcome> {
        if (!request.messages.some((message) => (message.toolResults?.length ?? 0) > 0)) {
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [{ id: "call-a", name: "fixture.capture", input: {} }],
            finishReason: "tool-calls",
            usage: {},
          };
        }
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b-seen", text: "seen it" });
        return { status: "completed", attemptId: request.attemptId, text: "seen it", toolCalls: [], usage: {} };
      },
    };
    const { handle, directory } = await owners.startOwner(asking, { review: true });
    // Every artifact reads as another task's: the owner's loop may not release it, so it gives the review up.
    const artifacts = handle.runtime.store.asPort().repositories.artifacts;
    const getArtifact = artifacts.getArtifact.bind(artifacts);
    artifacts.getArtifact = async (artifactId) => {
      const record = await getArtifact(artifactId);
      return record === undefined ? undefined : { ...record, runId: "task-another" };
    };

    const approved = capture();
    expect(
      await main(["run", "capture it", "--approval", "approve", "--format", "json", "--data-dir", directory], { io: approved.io }),
      approved.stderr(),
    ).toBe(EXIT.reviewRequired);
    expect(approved.stderr()).toContain("The owner stopped answering task");
    expect(approved.stderr()).toContain("was not made by this run");
    expect(approved.stderr()).toContain("tavi artifacts approve <artifact-id>");
    expect(approved.stderr()).not.toContain("re-run with --approval");
    const events = ndjson(approved.stdout());
    expect(events.at(-1)).toMatchObject({ kind: "task.review_required", policyStopped: { reason: "not-own-artifact" } });
    const taskId = events[0]?.runId ?? "";
    expect((await handle.runtime.store.asPort().repositories.tasks.get(taskId))?.status).toBe("waiting");

    // Followed again later: the replay ends on the round the owner left.
    const attached = capture();
    expect(await main(["run", "--attach", taskId, "--data-dir", directory], { io: attached.io })).toBe(EXIT.reviewRequired);

    // Ask is unchanged: the review is a person's from the start, and no reason is given.
    const asked = capture();
    expect(await main(["run", "capture it", "--data-dir", directory], { io: asked.io })).toBe(EXIT.reviewRequired);
    expect(asked.stderr()).toContain("waiting on artifact review");
    expect(asked.stderr()).not.toContain("The owner stopped answering");
  });

  it("asks a browser round on a terminal once: approving it allows the browser for the rest of the task", async () => {
    const { handle } = await startOwner(turns(["call-1", "call-2"]));
    const client = await owners.attach(handle);
    const asked: string[] = [];
    const out = capture(true);
    const code = await runOnOwner(
      client,
      { prompt: "open two", operationKey: "op-tty" },
      {
        format: "text",
        approval: "ask",
        workspaceId: "default",
        principalId: "operator",
        exit: EXIT,
        io: out.io,
        prompt: async (summary) => {
          asked.push(summary);
          return true;
        },
      },
    );
    expect(code, out.stderr()).toBe(EXIT.ok);
    // Both turns open a browser session: the first approval covers the second.
    expect(asked).toHaveLength(1);
  });

  it("detaches on Ctrl-C, leaving the run to the owner and saying how to follow, abort or cancel it", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { handle } = await startOwner(turns([], held));
    const client = await owners.attach(handle);
    const signals = new EventEmitter();
    const out = capture();
    const running = runOnOwner(
      client,
      { prompt: "take your time", operationKey: "op-detach" },
      {
        format: "json",
        approval: "ask",
        workspaceId: "default",
        principalId: "operator",
        exit: EXIT,
        io: out.io,
        signals: {
          on: (signal, listener) => signals.on(signal, listener),
          off: (signal, listener) => signals.off(signal, listener),
        },
      },
    );
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    // Events reach the renderer only once the client has bound the answer, so
    // the task id is known by then.
    await waitFor(() => out.stdout().includes('"kind":"run.started"'));
    signals.emit("SIGINT");
    expect(await running).toBe(EXIT.detached);
    const taskId = (await tasks.list(10))[0]?.taskId ?? "";
    expect(out.stderr()).toContain(`tavi run --attach ${taskId}`);
    expect(out.stderr()).toContain(`tavi abort ${taskId}`);
    // Still the owner's: it finishes once the model answers.
    release();
    await waitFor(async () => (await tasks.get(taskId))?.status === "completed");
  });
});

describe("tavi abort", ATTACHED, () => {
  it("stops a running turn under an owner, and says there is nothing to abort otherwise", async () => {
    const unowned = tempDirectory();
    const none = capture();
    expect(await main(["abort", "task-x", "--data-dir", unowned], { io: none.io })).toBe(EXIT.resumeNotApplicable);

    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { handle, directory } = await startOwner(abortable(held));
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const admitted = handle.runtime.workflow?.admit({ context, operationKey: "op-held", kind: "start", prompt: "wait" });
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    await waitFor(
      async () => (await tasks.list(10)).length === 1 && handle.runtime.abortRegistry.has((await tasks.list(10))[0]?.taskId ?? ""),
    );
    const taskId = (await tasks.list(10))[0]?.taskId ?? "";

    const aborted = capture();
    expect(await main(["abort", taskId, "--data-dir", directory], { io: aborted.io }), aborted.stderr()).toBe(EXIT.ok);
    const outcome = await admitted;
    // Stopped by the person: said in their words, and no failure in the list, though the chat goes on.
    expect(outcome?.outcome).toMatchObject({ status: "stopped", error: { code: "STOPPED", message: TURN_STOPPED_MESSAGE } });
    const listed = await handle.runtime.store.listTaskSessions({ workspaceId: "default" });
    expect(listed.rows.find((row) => row.taskId === taskId)?.status).toBe("stopped");
    expect((await tasks.get(taskId))?.status).toBe("stopped");
    release();

    const again = capture();
    expect(await main(["abort", taskId, "--data-dir", directory], { io: again.io })).toBe(EXIT.resumeNotApplicable);
    const unknown = capture();
    expect(await main(["abort", "task-none", "--data-dir", directory], { io: unknown.io })).toBe(EXIT.unavailable);
  });
});

describe("tavi cancel", ATTACHED, () => {
  it("ends a running turn as well as the record, so the run stops and fails", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const model = abortable(held);
    let streaming = false;
    const { handle, directory } = await startOwner({
      stream: async (request, options) => {
        streaming = true;
        return await model.stream(request, options);
      },
    });
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const admitted = handle.runtime.workflow?.admit({ context, operationKey: "op-held", kind: "start", prompt: "wait" });
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    await waitFor(() => streaming);
    const taskId = (await tasks.list(10))[0]?.taskId ?? "";

    const cancelled = capture();
    expect(
      await main(["cancel", taskId, "--reason", "no longer needed", "--data-dir", directory], { io: cancelled.io }),
      cancelled.stderr(),
    ).toBe(EXIT.ok);
    // The model is still held: only the cancel can end this turn.
    const outcome = await admitted;
    expect(outcome?.outcome).toMatchObject({ status: "failed", error: { code: "CANCELLED" } });
    expect((await tasks.get(taskId))?.status).toBe("cancelled");
    release();
  });
});

describe("a chat the person stopped", ATTACHED, () => {
  it("stays stopped across an owner restart, keeps its history, and a reply goes on in the same chat", async () => {
    const seen: string[][] = [];
    let turn = 0;
    const model: ModelPort = {
      async stream(request, options): Promise<ModelOutcome> {
        turn += 1;
        seen.push(
          request.messages
            .filter((message) => message.role === "user" && !isStepFacts(message))
            .map((message) => withoutStepFacts(message.text)),
        );
        if (turn === 1) {
          await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
          return {
            status: "aborted",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [],
            usage: {},
            error: { code: "aborted", message: "Generation was aborted", retryable: false },
          };
        }
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b-go", text: "going on" });
        return { status: "completed", attemptId: request.attemptId, text: "going on", toolCalls: [], usage: {} };
      },
    };
    const { handle, directory } = await startOwner(model);
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const admitted = handle.runtime.workflow?.admit({ context, operationKey: "op-stop-me", kind: "start", prompt: "a long job" });
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    await waitFor(async () => turn === 1 && handle.runtime.abortRegistry.has((await tasks.list(10))[0]?.taskId ?? ""));
    const taskId = (await tasks.list(10))[0]?.taskId ?? "";
    const aborted = capture();
    expect(await main(["abort", taskId, "--data-dir", directory], { io: aborted.io }), aborted.stderr()).toBe(EXIT.ok);
    await admitted;
    await owners.stopLatest("restart");

    const again = await owners.startOwner(model, { directory });
    const shown = capture();
    expect(await main(["tasks", taskId, "--data-dir", directory], { io: shown.io }), shown.stderr()).toBe(EXIT.ok);
    expect(JSON.parse(shown.stdout()).task.status).toBe("stopped");
    expect(
      (await again.handle.runtime.store.listTaskSessions({ workspaceId: "default" })).rows.find((row) => row.taskId === taskId)?.status,
    ).toBe("stopped");
    // Nothing took the chat back up on its own.
    const after = again.handle.runtime.store.asPort().repositories.tasks;
    expect(await after.listAdmissions(taskId)).toHaveLength(1);

    const replied = await again.handle.runtime.workflow?.admit({
      context: { ...context, runId: taskId },
      operationKey: "op-go-on",
      kind: "reply",
      taskId,
      prompt: "go on",
    });
    expect(replied?.outcome.status).toBe("completed");
    expect(seen.at(-1)).toEqual(["a long job", "go on"]);
    expect((await after.get(taskId))?.status).toBe("completed");
  });

  it("takes a reply on a chat stopped by a build before the status: its record says failed with STOPPED", async () => {
    const { handle } = await startOwner(turns([]));
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const first = await handle.runtime.workflow?.admit({ context, operationKey: "op-old", kind: "start", prompt: "hello" });
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    const taskId = first?.taskId ?? "";
    const [admission] = await tasks.listAdmissions(taskId);
    await tasks.commitAdmission({
      admissionId: admission?.admissionId ?? "",
      taskId,
      state: "failed",
      result: { status: "failed", finalText: "You stopped this.", error: { code: "STOPPED", message: "You stopped this." } },
    });
    const replied = await handle.runtime.workflow?.admit({
      context: { ...context, runId: taskId },
      operationKey: "op-new",
      kind: "reply",
      taskId,
      prompt: "go on",
    });
    expect(replied?.outcome.status).toBe("completed");
  });
});

/** A model that runs until its signal fires, or until `hold` settles. */
function abortable(hold: Promise<void>): ModelPort {
  return {
    async stream(request, options): Promise<ModelOutcome> {
      await Promise.race([hold, new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }))]);
      if (options.signal.aborted) {
        return {
          status: "aborted",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [],
          usage: {},
          error: { code: "aborted", message: "aborted", retryable: false },
        };
      }
      return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
    },
  };
}

describe("tavi run under a live owner: refusals", ATTACHED, () => {
  it("refuses --attach with a prompt or a flag that shapes a run, and needs an owner", async () => {
    const unowned = tempDirectory();
    for (const argv of [
      ["run", "hi", "--attach", "task-x"],
      ["run", "--attach", "task-x", "--approval", "approve"],
      ["run", "--attach", "task-x", "--operation-key", "k"],
      ["run", "--attach", "task-x", "--model", "m"],
      ["run", "--attach", "task-x", "--in-memory"],
      ["run", "--attach", "task-x", "--browser-allow-host", "example.com"],
    ]) {
      const refused = capture();
      expect(await main([...argv, "--data-dir", unowned], { io: refused.io }), argv.join(" ")).toBe(EXIT.usage);
    }
    const none = capture();
    expect(await main(["run", "--attach", "task-x", "--data-dir", unowned], { io: none.io })).toBe(EXIT.unavailable);
    expect(none.stderr()).toContain("no owner is running");
  });

  it("refuses an unknown task, another model, and the owner's own tool-policy flags, admitting nothing", async () => {
    const { handle, directory } = await startOwner(turns([]));
    const unknown = capture();
    expect(await main(["run", "--attach", "task-none", "--data-dir", directory], { io: unknown.io })).toBe(EXIT.unavailable);
    expect(unknown.stderr()).toContain("NOT_FOUND");

    // A model-only assertion is checked as well as a connection.
    const model = capture();
    expect(await main(["run", "hi", "--model", "other-model", "--data-dir", directory], { io: model.io })).toBe(EXIT.usage);
    expect(model.stderr()).toContain("fixture-conn/fixture-model");

    const policy = capture();
    expect(
      await main(["run", "hi", "--browser-allow-host", "example.com", "--api-key-file", "/nowhere", "--data-dir", directory], {
        io: policy.io,
      }),
    ).toBe(EXIT.usage);
    expect(policy.stderr()).toContain("--api-key-file, --browser-allow-host are the owner's to set");
    expect(await handle.runtime.store.asPort().repositories.tasks.list(10)).toEqual([]);
  });

  it("narrows `approvals list` to a task, and says who answers a task's rounds when subscribing", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = false;
    const { handle } = await startOwner(firstCallThenHeld("call-1", held, () => (holding = true)));
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    const client = await owners.attach(handle);
    // A run whose rounds the owner answers: subscribed while its loop answers them.
    const policy = await client.request(
      "run",
      { prompt: "open", workspaceId: "default", principal: "operator", operationKey: "op-policy", approval: "approve" },
      "run-policy",
    );
    const policyTask = (policy.result as { taskId: string }).taskId;
    // The loop has answered the round and the resumed turn is running.
    await waitFor(() => holding);
    const watching = await client.request("subscribe", { taskId: policyTask }, "watch-policy");
    expect(watching.result).toMatchObject({ roundsAnsweredBy: "owner" });
    release();
    await waitFor(async () => (await tasks.get(policyTask))?.status === "completed");

    // A run that leaves its round to the client.
    const asking = await client.request(
      "run",
      { prompt: "open", workspaceId: "default", principal: "operator", operationKey: "op-client", approval: "client" },
      "run-client",
    );
    const clientTask = (asking.result as { taskId: string }).taskId;
    await waitFor(async () => (await tasks.get(clientTask))?.status === "waiting");
    const followed = await client.request("subscribe", { taskId: clientTask }, "watch-client");
    expect(followed.result).toMatchObject({ roundsAnsweredBy: "client" });
    // No fire answers it, so none is named.
    expect(followed.result).not.toHaveProperty("schedule");
    const listed = await client.request("approvals", { action: "list", taskId: clientTask }, "list-task");
    const rows = (listed.result as { rows: { record: { taskId: string; callId: string } }[] }).rows;
    expect(rows.map((row) => row.record)).toEqual([expect.objectContaining({ taskId: clientTask, callId: "call-1" })]);
  });
});

describe("tavi abort: arguments", () => {
  it("refuses a second task id, an unknown flag and a missing id", async () => {
    for (const argv of [["abort", "a", "b"], ["abort", "a", "--reason", "x"], ["abort"]]) {
      const refused = capture();
      expect(await main(argv, { io: refused.io }), argv.join(" ")).toBe(EXIT.usage);
    }
  });
});

/**
 * The follow session's edges, against a scripted owner: every path that used to
 * hang, crash or misreport, deterministically.
 */
describe("attached run: edges", () => {
  it("decides --attach on the replay's last event, not on a suspension an earlier admission ended with", async () => {
    const resumed = [
      started(),
      event("task.waiting", { on: "its deadline", deadlineAt: AT }),
      event("attempt.replaced", { supersededAttemptId: "attempt-0", reason: "resumed" }),
      event("text.delta", { blockId: "b-1", text: "done" }),
      event("task.completed", { finalText: "done" }),
    ];
    const done = fakeOwner((command) => (command === "subscribe" ? subscribed(resumed) : unplanned(command)));
    const out = capture();
    expect(await attachToRunningTask(done.client, "task-1", follow(out.io)), out.stderr()).toBe(EXIT.ok);
    expect(out.stderr()).not.toContain("waiting on");

    // A replay that ends on the wait: the task is still waiting.
    const waiting = fakeOwner((command) =>
      command === "subscribe" ? subscribed([started(), event("task.waiting", { on: "its deadline", deadlineAt: AT })]) : unplanned(command),
    );
    const still = capture();
    expect(await attachToRunningTask(waiting.client, "task-1", follow(still.io))).toBe(EXIT.taskWaiting);
  });

  it("follows a run through a wait on its worker to the answer the resumed turn gives", async () => {
    const workerWait = event("task.waiting", { on: "worker task task-2 completing", deadlineAt: AT, workerTaskId: "task-2" });
    const owner = fakeOwner((command) => (command === "run" ? ran([started(), workerWait]) : unplanned(command)));
    const out = capture();
    const following = runOnOwner(owner.client, { prompt: "p", operationKey: "op-1" }, follow(out.io));
    await waitFor(() => out.stderr().includes("[waiting] on worker task task-2"));
    owner.emit(
      event("attempt.replaced", { supersededAttemptId: "attempt-0", reason: "resuming after the worker" }),
      event("text.delta", { blockId: "b-1", text: "11 vowels" }),
      event("task.completed", { finalText: "11 vowels" }),
    );
    expect(await following, out.stderr()).toBe(EXIT.ok);
    expect(out.stdout()).toContain("11 vowels");
    expect(out.stderr()).not.toContain("resolves on its own");

    // A replay that ends on the worker wait keeps following too: the answer is still to come.
    const replayed = fakeOwner((command) => (command === "subscribe" ? subscribed([started(), workerWait]) : unplanned(command)));
    const again = capture();
    const attached = attachToRunningTask(replayed.client, "task-1", follow(again.io));
    await waitFor(() => again.stderr().includes("[waiting] on worker task task-2"));
    replayed.emit(event("task.completed", { finalText: "11 vowels" }));
    expect(await attached).toBe(EXIT.ok);
  });

  it("asks only the round still open once the replay ends, and reports it without a terminal", async () => {
    const replay = [
      started(),
      required("call-1", 1),
      event("approval.settled", { steps: 1, decisions: [{ callId: "call-1", approved: true }], decidedBy: "operator" }),
      required("call-2", 2),
    ];
    const owner = fakeOwner((command) =>
      command === "subscribe" ? subscribed(replay) : command === "approvals" ? { response: rows(2, ["call-2"]) } : unplanned(command),
    );
    const out = capture();
    expect(await attachToRunningTask(owner.client, "task-1", follow(out.io))).toBe(EXIT.approvalRequired);
    // Only the open round was listed, for this task.
    expect(owner.sent.filter((request) => request.command === "approvals").map((request) => request.payload)).toEqual([
      expect.objectContaining({ action: "list", taskId: "task-1" }),
    ]);
    expect(out.stderr()).toContain("Pending approval: browser.create_session (call call-2)");
    // An attached client starts nothing, so it offers no policy to re-run with.
    expect(out.stderr()).not.toContain("re-run with --approval");
  });

  it("leaves rounds the owner answers to it, only rendering them", async () => {
    const owner = fakeOwner((command) =>
      command === "subscribe"
        ? subscribed([], "owner")
        : command === "tasks"
          ? { response: recorded("running", [admission("claimed", null)]) }
          : unplanned(command),
    );
    const out = capture();
    const following = attachToRunningTask(owner.client, "task-1", follow(out.io, { prompt: async () => true }));
    await waitFor(() => out.stderr().includes("following it live"));
    owner.emit(started(), required("call-1", 1));
    owner.emit(
      event("approval.settled", { steps: 1, decisions: [{ callId: "call-1", approved: true }], decidedBy: "schedule:nightly" }),
      event("task.completed", { finalText: "done" }),
    );
    expect(await following).toBe(EXIT.ok);
    expect(owner.sent.map((request) => request.command)).toEqual(["subscribe", "tasks"]);
  });

  it("detaches with 130 on Ctrl-C at an open prompt, sending nothing", async () => {
    const owner = liveRun();
    const out = capture(true);
    const code = await runOnOwner(
      owner.client,
      { prompt: "p", operationKey: "op-1" },
      follow(out.io, {
        prompt: async () => {
          throw Object.assign(new Error("Aborted with Ctrl+C"), { name: "AbortError" });
        },
      }),
    );
    expect(code).toBe(EXIT.detached);
    expect(out.stderr()).toContain("tavi run --attach task-1");
    // Suspended on the round: there is no running turn to abort.
    expect(out.stderr()).toContain("tavi cancel task-1");
    expect(owner.sent.map((request) => request.command)).not.toContain("approve");
  });

  it("withdraws an open prompt when its round is decided elsewhere, and follows the stream on", async () => {
    let asked = (): void => {};
    const prompting = new Promise<void>((resolve) => (asked = resolve));
    const owner = liveRun();
    const out = capture(true);
    const running = runOnOwner(
      owner.client,
      { prompt: "p", operationKey: "op-1" },
      follow(out.io, {
        prompt: (_summary, _input, signal) =>
          new Promise<boolean>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            asked();
          }),
      }),
    );
    await prompting;
    owner.emit(
      event("approval.settled", { steps: 1, decisions: [{ callId: "call-1", approved: false }], decidedBy: "someone" }),
      event("task.completed", { finalText: "done" }),
    );
    expect(await running).toBe(EXIT.ok);
    expect(out.stderr()).toContain("decided elsewhere (by someone)");
    expect(owner.sent.map((request) => request.command)).not.toContain("approve");
  });

  it("continues the stream when its approve is refused because another front end decided first", async () => {
    const owner = liveRun({ approve: { ok: false, error: { code: "CONFLICT", message: "decided" } } });
    const out = capture(true);
    const running = runOnOwner(owner.client, { prompt: "p", operationKey: "op-1" }, follow(out.io, { prompt: async () => true }));
    await waitFor(() => owner.sent.some((request) => request.command === "approve"));
    owner.emit(
      event("approval.settled", { steps: 1, decisions: [{ callId: "call-1", approved: true }], decidedBy: "other" }),
      event("task.completed", { finalText: "done" }),
    );
    expect(await running).toBe(EXIT.ok);
  });

  it("ends an --approval approve run with exit 3, never asking, on a round the owner says it stopped answering", async () => {
    const owner = liveRun();
    const out = capture(true);
    let asked = false;
    const running = runOnOwner(
      owner.client,
      { prompt: "p", operationKey: "op-1" },
      follow(out.io, {
        approval: "approve",
        prompt: async () => {
          asked = true;
          return true;
        },
      }),
    );
    // The owner answers the round: nothing is listed or asked here.
    await tick();
    expect(owner.sent.map((request) => request.command)).toEqual(["run"]);
    owner.emit({
      ...required("call-1", 1),
      policyStopped: { reason: "round-limit", message: "the run reached its limit of 50 rounds" },
    } as ClientEvent);
    expect(await running).toBe(EXIT.approvalRequired);
    expect(asked).toBe(false);
    expect(out.stderr()).toContain("The owner stopped answering task task-1's rounds under --approval approve: the run reached its limit");
    expect(out.stderr()).toContain("tavi approvals approve task-1");
    expect(out.stderr()).not.toContain("re-run with --approval");
    expect(owner.sent.map((request) => request.command)).not.toContain("approve");
  });

  it("reports a failed round listing instead of waiting forever", async () => {
    const owner = liveRun({ approvals: { ok: false, error: { code: "UNAVAILABLE", message: "shutting down" } } });
    const out = capture(true);
    expect(await runOnOwner(owner.client, { prompt: "p", operationKey: "op-1" }, follow(out.io, { prompt: async () => true }))).toBe(
      EXIT.unavailable,
    );
    expect(out.stderr()).toContain("Could not list task task-1's approval round: UNAVAILABLE");
  });

  it("reports a run whose answer never came as of unknown outcome, naming the key that finds it", async () => {
    const timedOut = fakeOwner(() => Promise.reject(new Error("IPC request run timed out")));
    const out = capture();
    expect(await runOnOwner(timedOut.client, { prompt: "p", operationKey: "op-key" }, follow(out.io))).toBe(EXIT.unavailable);
    expect(out.stderr()).toContain("outcome is unknown: IPC request run timed out");
    expect(out.stderr()).toContain("--operation-key op-key");

    const dropped = fakeOwner(() => ({ response: { ok: false, error: { code: "DISCONNECTED", message: "IPC connection closed" } } }));
    const lost = capture();
    expect(await runOnOwner(dropped.client, { prompt: "p", operationKey: "op-key" }, follow(lost.io))).toBe(EXIT.unavailable);
    expect(lost.stderr()).toContain("--operation-key op-key");
  });

  it("settles a detach asked before the answer once the owner names the task, and reports a refusal alone", async () => {
    let answer = (_planned: Planned): void => {};
    const owner = fakeOwner(() => new Promise<Planned>((resolve) => (answer = resolve)));
    const signals = new EventEmitter();
    const out = capture();
    const running = runOnOwner(owner.client, { prompt: "p", operationKey: "op-1" }, follow(out.io, { signals: emitterSignals(signals) }));
    await tick();
    signals.emit("SIGINT");
    expect(out.stderr()).toContain("operation key op-1");
    answer(ran([]));
    expect(await running).toBe(EXIT.detached);
    expect(out.stderr()).toContain("tavi run --attach task-1");
    expect(out.stderr()).not.toContain("<task-id>");

    let refuse = (_planned: Planned): void => {};
    const refusing = fakeOwner(() => new Promise<Planned>((resolve) => (refuse = resolve)));
    const again = new EventEmitter();
    const refused = capture();
    const attempt = runOnOwner(
      refusing.client,
      { prompt: "p", operationKey: "op-2" },
      follow(refused.io, { signals: emitterSignals(again) }),
    );
    await tick();
    again.emit("SIGINT");
    refuse({ response: { ok: false, error: { code: "CONFLICT", message: "key reused" } } });
    expect(await attempt).toBe(EXIT.unavailable);
    expect(refused.stderr()).toContain("run failed: CONFLICT");
    expect(refused.stderr()).not.toContain("Detached from task");
  });

  it("detaches with 143 on SIGTERM", async () => {
    const owner = fakeOwner(() => ran([started()]));
    const signals = new EventEmitter();
    const out = capture();
    const running = runOnOwner(owner.client, { prompt: "p", operationKey: "op-1" }, follow(out.io, { signals: emitterSignals(signals) }));
    await tick();
    signals.emit("SIGTERM");
    expect(await running).toBe(EXIT.terminated);
    expect(out.stderr()).toContain("tavi abort task-1");
  });

  it("reports the owner dropping the stream, or closing the connection, instead of waiting on it", async () => {
    const backlog = fakeOwner(() => ran([started()]));
    const out = capture();
    const running = runOnOwner(backlog.client, { prompt: "p", operationKey: "op-1" }, follow(out.io));
    await tick();
    backlog.orphan("run-op-1", "BACKLOG");
    expect(await running).toBe(EXIT.unavailable);
    expect(out.stderr()).toContain("dropped this stream (BACKLOG");

    const closing = fakeOwner(() => ran([started()]));
    const closed = capture();
    const following = runOnOwner(closing.client, { prompt: "p", operationKey: "op-1" }, follow(closed.io));
    await tick();
    closing.close();
    expect(await following).toBe(EXIT.unavailable);
    expect(closed.stderr()).toContain("`tavi tasks task-1` shows how it stands");
    expect(closed.stderr()).toContain("`tavi run --attach task-1` follows it once an owner is back");
  });

  it("reports a task the owner retains nothing of from its recorded outcome, and follows one still admitted", async () => {
    const reviewed = fakeOwner((command) =>
      command === "subscribe"
        ? subscribed([])
        : command === "tasks"
          ? {
              response: recorded("waiting", [
                admission("committed", {
                  status: "waiting",
                  finalText: "",
                  reviewInterrupt: { requests: [{ artifactId: "art-1", toolName: "sandbox.run", callId: "call-1", steps: 1 }] },
                }),
              ]),
            }
          : unplanned(command),
    );
    const review = capture();
    expect(await attachToRunningTask(reviewed.client, "task-1", follow(review.io))).toBe(EXIT.reviewRequired);
    expect(review.stderr()).toContain("Pending artifact review: art-1");

    const cancelled = fakeOwner((command) =>
      command === "subscribe" ? subscribed([]) : command === "tasks" ? { response: recorded("cancelled", []) } : unplanned(command),
    );
    const gone = capture();
    expect(await attachToRunningTask(cancelled.client, "task-1", follow(gone.io))).toBe(EXIT.taskFailed);
    expect(gone.stderr()).toContain("was cancelled");

    const queued = fakeOwner((command) =>
      command === "subscribe"
        ? subscribed([])
        : command === "tasks"
          ? { response: recorded("running", [admission("pending", null)]) }
          : unplanned(command),
    );
    const live = capture();
    const following = attachToRunningTask(queued.client, "task-1", follow(live.io));
    await waitFor(() => live.stderr().includes("following it live"));
    queued.emit(started(), event("task.completed", { finalText: "done" }));
    expect(await following).toBe(EXIT.ok);
  });
});

/** A decision answered by a scripted owner, and the resumed turn it admitted. */
describe("attached decisions: following the resume", () => {
  const decided = (result: Record<string, unknown>, events: readonly ClientEvent[] = [event("task.completed", { finalText: "done" })]) =>
    fakeOwner((command) => {
      if (command === "approvals") {
        return { response: { ok: true, result: { taskId: "task-1", steps: 1, operationKey: "round-key", decisions: [], ...result } } };
      }
      if (command === "subscribe") return subscribed(events);
      if (command === "tasks") {
        return {
          response: recorded("waiting", [
            {
              ...admission("committed", {
                status: "waiting",
                finalText: "",
                reviewInterrupt: { requests: [{ artifactId: "art-1", toolName: "sandbox.run", callId: "call-1", steps: 2 }] },
              }),
              operationKey: "round-key",
            },
          ]),
        };
      }
      return unplanned(command);
    });
  const decide = { taskId: "task-1", verdict: "approve", decidedBy: "operator" } as const;

  it("follows the resume from the cursor the owner read before admitting it, or from the beginning without one", async () => {
    const cursor = { epoch: "epoch-1", sequence: 7 };
    const pinned = decided({ replayed: false, cursor });
    expect(await approveOnOwner(pinned.client, decide, follow(capture().io))).toBe(EXIT.ok);
    expect(pinned.sent.find((request) => request.command === "subscribe")?.payload).toMatchObject({ taskId: "task-1", from: cursor });

    const unpinned = decided({ replayed: false });
    expect(await approveOnOwner(unpinned.client, decide, follow(capture().io))).toBe(EXIT.ok);
    expect(unpinned.sent.find((request) => request.command === "subscribe")?.payload).toMatchObject({ from: "beginning" });
  });

  it("reports the next round a resume suspends on with exit 3 even on a terminal, asking nothing", async () => {
    let decisions = 0;
    const owner = fakeOwner((command, payload) => {
      if (command === "approvals" && payload["action"] === "approve") {
        decisions += 1;
        return {
          response: { ok: true, result: { taskId: "task-1", steps: 1, operationKey: "round-key", decisions: [], replayed: false } },
        };
      }
      if (command === "approvals") return { response: rows(2, ["call-2"]) };
      if (command === "subscribe") return subscribed([required("call-2", 2)]);
      return unplanned(command);
    });
    const out = capture(true);
    let asked = false;
    const code = await approveOnOwner(owner.client, decide, follow(out.io, { prompt: async () => (asked = true) }));
    expect(code).toBe(EXIT.approvalRequired);
    expect(decisions).toBe(1);
    expect(asked).toBe(false);
    expect(out.stderr()).toContain("Pending approval: browser.create_session (call call-2)");
  });

  it("answers a decision already committed from its recorded outcome, following nothing", async () => {
    const replay = decided({ replayed: true, status: "waiting" });
    const out = capture();
    expect(await approveOnOwner(replay.client, decide, follow(out.io))).toBe(EXIT.reviewRequired);
    expect(out.stderr()).toContain("no work was re-run");
    expect(replay.sent.map((request) => request.command)).toEqual(["approvals", "tasks"]);
  });

  it("reports a decision whose answer was lost as of unknown outcome, sending the operator to look before deciding again", async () => {
    const lost = fakeOwner(() => ({ response: { ok: false, error: { code: "DISCONNECTED", message: "IPC connection closed" } } }));
    const out = capture();
    expect(await approveOnOwner(lost.client, decide, follow(out.io))).toBe(EXIT.unavailable);
    expect(out.stderr()).toContain("before deciding again");
    const timedOut = fakeOwner(() => Promise.reject(new Error("IPC request approvals timed out")));
    const late = capture();
    expect(await approveOnOwner(timedOut.client, decide, follow(late.io))).toBe(EXIT.unavailable);
    expect(late.stderr()).toContain("outcome is unknown: IPC request approvals timed out");
  });
});

/**
 * A model whose every task asks for one gated call, then answers — its resumed
 * turns held until `hold` settles, saying so. Turns alternate, one task at a time.
 */
function firstCallThenHeld(id: string, hold: Promise<void>, onHeld: () => void): ModelPort {
  let calls = 0;
  return {
    async stream(request): Promise<ModelOutcome> {
      calls += 1;
      if (calls % 2 === 1) {
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id, name: "browser.create_session", input: {} }],
          finishReason: "tool-calls",
          usage: {},
        };
      }
      onHeld();
      await hold;
      return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
    },
  };
}

const AT = "2026-09-18T00:00:00.000Z";
let sequence = 0;

function event(kind: ClientEvent["kind"], fields: Record<string, unknown>): ClientEvent {
  sequence += 1;
  return {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "epoch-1",
    sequence,
    runId: "task-1",
    attemptId: "attempt-1",
    at: AT,
    kind,
    ...fields,
  } as ClientEvent;
}

const started = (): ClientEvent => event("run.started", { threadId: "thread-1", workspaceId: "default" });
const required = (callId: string, steps: number): ClientEvent =>
  event("approval.required", {
    callId,
    toolName: "browser.create_session",
    summary: `open ${callId}`,
    input: {},
    steps,
    approvalId: `approval-${callId}`,
  });

type Planned = { readonly response: IpcClientResponse; readonly events?: readonly ClientEvent[] };

/** A scripted owner: each request is answered by `plan`, and the answer's events follow it, as the transport delivers them. */
function fakeOwner(plan: (command: string, payload: Record<string, unknown>) => Planned | Promise<Planned>) {
  const listeners = new Set<Parameters<IpcClient["onEvent"]>[0]>();
  const orphans = new Set<Parameters<IpcClient["onOrphanResponse"]>[0]>();
  const closes = new Set<() => void>();
  const sent: { command: string; payload: Record<string, unknown>; requestId: string }[] = [];
  let closed = false;
  const emit = (...events: ClientEvent[]): void => {
    for (const next of events) for (const listener of [...listeners]) listener({ subscriptionId: "sub-1", event: next });
  };
  const client: IpcClient = {
    features: [...IPC_COMMANDS],
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onLive: () => () => undefined,
    onOrphanResponse: (listener) => {
      orphans.add(listener);
      return () => orphans.delete(listener);
    },
    onClose: (listener) => {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const listener of [...closes]) listener();
    },
    async request(command, payload, requestId, options) {
      sent.push({ command, payload: payload as Record<string, unknown>, requestId });
      const planned = await plan(command, payload as Record<string, unknown>);
      options?.onResponse?.(planned.response);
      emit(...(planned.events ?? []));
      return planned.response;
    },
  };
  return {
    client,
    sent,
    emit,
    orphan: (requestId: string, code: string) => {
      for (const listener of [...orphans]) listener({ requestId, code, message: "dropped by the owner" });
    },
    close: () => client.close(),
  };
}

/** A new run answered with no replay, whose first round (one call) arrives live; `answers` overrides a command's response. */
function liveRun(answers: Partial<Record<string, IpcClientResponse>> = {}) {
  return fakeOwner((command) => {
    if (command === "run") return ran([started(), required("call-1", 1)]);
    const answer = answers[command];
    if (answer !== undefined) return { response: answer };
    if (command === "approvals") return { response: rows(1, ["call-1"]) };
    if (command === "approve") return { response: { ok: true, result: { taskId: "task-1" } } };
    return unplanned(command);
  });
}

const ran = (events: readonly ClientEvent[]): Planned => ({
  response: { ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", created: true, replay: false, replayed: 0 } },
  events,
});

const subscribed = (replay: readonly ClientEvent[], roundsAnsweredBy: "owner" | "client" = "client"): Planned => ({
  response: {
    ok: true,
    result: { subscriptionId: "sub-1", replayed: replay.length, resync: false, truncated: false, roundsAnsweredBy },
  },
  events: replay,
});

const rows = (steps: number, callIds: readonly string[]): IpcClientResponse => ({
  ok: true,
  result: {
    rows: callIds.map((callId) => ({
      record: { approvalId: `approval-${callId}`, taskId: "task-1", toolId: "browser.create_session", callId, steps, createdAt: AT },
      task: { workspaceId: "default", principalId: "operator", status: "waiting" },
    })),
    truncated: false,
  },
});

const recorded = (status: string, admissions: readonly unknown[]): IpcClientResponse => ({
  ok: true,
  result: { taskId: "task-1", found: true, task: { taskId: "task-1", status }, admissions },
});

const admission = (state: string, result: unknown) => ({
  admissionId: `adm-${state}`,
  taskId: "task-1",
  operationKey: "op",
  kind: "start",
  intent: {},
  intentHash: "h",
  state,
  result,
  createdAt: AT,
  updatedAt: AT,
});

function unplanned(command: string): never {
  throw new Error(`the scripted owner has no answer for ${command}`);
}

function follow(io: CliIo, extra: Partial<FollowOptions> = {}): FollowOptions {
  return {
    format: "text",
    approval: "ask",
    workspaceId: "default",
    principalId: "operator",
    exit: EXIT,
    io,
    signals: emitterSignals(new EventEmitter()),
    ...extra,
  };
}

function emitterSignals(emitter: EventEmitter): NonNullable<FollowOptions["signals"]> {
  return { on: (signal, listener) => emitter.on(signal, listener), off: (signal, listener) => emitter.off(signal, listener) };
}

const tick = (): Promise<void> => delay(0);
