import { join } from "node:path";

import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { acquireDataDirectoryOwnership } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import {
  ApprovalsPayloadSchema,
  approvalRoundKey,
  encodeRoundRisk,
  labelSummary,
  untrustedLabel,
  type ModelOutcome,
  type ModelPort,
  type PendingWaitsInput,
} from "@tavi/contracts";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { listNeeds, needLine } from "../../src/features/approvals/inbox.js";
import { parseArgs } from "../../src/cli/parse.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { EXIT, main } from "../../src/main.js";
import type { RuntimeFactory } from "../../src/cli/runtime-options.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * `tavi approvals list|approve|reject`.
 *
 * The gap this closes: a task suspended on an approval had no resolver anywhere.
 * `tavi serve` sets `approval: "deny"` and nothing reads it, the chat reply path
 * can settle a wait but never an approval, and no command could even list one —
 * so the first mutating tool call in a conversation wedged the task permanently.
 *
 * Driven end to end through `main()`: a real `tavi run` that stops on an approval
 * because it is not interactive, then a real `tavi approvals reject` that resumes
 * it. The resume is the write — the workflow's own approval node records the
 * decision — so the command needs a model, which is why these tests inject one.
 */

const directories = temporaryDirectories({ prefix: "tavi-approvals-" });

afterAll(() => directories.cleanup());

/** A model that asks for a mutating tool, then answers once it has been decided. */
function mutatingModel(): RuntimeFactory {
  const model = createFixtureModel({
    turns: [{ toolCall: { id: "call-1", name: "browser.create_session", input: {} } }, { text: "carried on without the browser" }],
  });
  return (options) => composeTaviRuntime(options, { modelOverride: model, browserOverride: createFixtureBrowser() });
}

/** Run a task that stops on an approval, and return the task id it suspended on. */
async function suspendOnApproval(directory: string, runtimeFactory: RuntimeFactory): Promise<string> {
  const run = capture();
  const code = await main(
    [
      "run",
      "--connection",
      "fixture-conn",
      "--model",
      "fixture-model",
      // Not interactive, and `ask` is the default: the operator is never offered
      // the decision here, which is exactly the `serve` shape this command exists
      // to resolve.
      "--approval",
      "ask",
      "--format",
      "json",
      "--data-dir",
      directory,
      "open a browser",
    ],
    { io: run.io, runtimeFactory },
  );
  expect(code, run.stderr()).toBe(EXIT.approvalRequired);

  const listed = capture();
  expect(await main(["approvals", "list", "--format", "json", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
  const payload = JSON.parse(listed.stdout()) as { rows: readonly { record: { taskId: string; toolId: string } }[] };
  expect(payload.rows).toHaveLength(1);
  expect(payload.rows[0]?.record.toolId).toBe("browser.create_session");
  return payload.rows[0]?.record.taskId as string;
}

describe("tavi approvals", () => {
  it("dispatches a gated tool without a round when the operator exempted it (`serve --allow`)", async () => {
    // The same model and the same policy that suspend above, with the tool
    // named in `approvalExemptTools`: the call runs, the task completes, and
    // there is nothing to list.
    const directory = directories.create();
    const model = createFixtureModel({
      turns: [{ toolCall: { id: "call-1", name: "browser.create_session", input: {} } }, { text: "opened without asking" }],
    });
    const runtimeFactory: RuntimeFactory = (options) =>
      composeTaviRuntime(
        { ...options, approvalExemptTools: ["browser.create_session"] },
        { modelOverride: model, browserOverride: createFixtureBrowser() },
      );
    const run = capture();
    const code = await main(
      [
        "run",
        "--connection",
        "fixture-conn",
        "--model",
        "fixture-model",
        "--approval",
        "ask",
        "--format",
        "json",
        "--data-dir",
        directory,
        "open a browser",
      ],
      { io: run.io, runtimeFactory },
    );
    expect(code, run.stderr()).toBe(EXIT.ok);
    expect(run.stdout()).toContain("opened without asking");
    const listed = capture();
    expect(await main(["approvals", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toContain("(no pending approvals)");
  });

  it("says where a pending round's chat read untrusted content in the list", async () => {
    const directory = directories.create();
    const taskId = await suspendOnApproval(directory, mutatingModel());
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const label = labelSummary(untrustedLabel("web", { ref: { ref: "c1", host: "news.example", at: "2026-10-13T00:00:00.000Z" } }));
      const steps = (await store.asPort().repositories.approvals.listForTask(taskId))[0]?.steps ?? 1;
      const round = await store.asPort().repositories.approvalRounds.get(taskId, steps);
      if (round === undefined)
        await store.asPort().repositories.approvalRounds.create({
          taskId,
          steps,
          token: "bcdefghi",
          workspaceId: "default",
          risk: "high",
          riskLabel: label,
          createdAt: "2026-10-13T00:00:00.000Z",
        });
      else
        store.handle
          .prepare("UPDATE tavi_approval_rounds SET risk = ? WHERE task_id = ? AND steps = ?")
          .run(encodeRoundRisk("high", label), taskId, steps);
    } finally {
      store.close();
    }
    const listed = capture();
    expect(await main(["approvals", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toContain(`${taskId}\tbrowser.create_session`);
    expect(listed.stdout()).toContain("\n  ⚠ after reading news.example");
  });

  it("lists a suspended approval and resumes the task when it is denied", async () => {
    const directory = directories.create();
    const runtimeFactory = mutatingModel();
    const taskId = await suspendOnApproval(directory, runtimeFactory);

    const decided = capture();
    const code = await main(
      ["approvals", "reject", taskId, "--connection", "fixture-conn", "--model", "fixture-model", "--data-dir", directory],
      { io: decided.io, runtimeFactory },
    );
    // A denied call becomes an error *result*, not a failed task: the model can
    // still answer without the effect, and the tool never runs.
    expect(code, decided.stderr()).toBe(EXIT.ok);

    const after = capture();
    expect(await main(["approvals", "list", "--data-dir", directory], { io: after.io })).toBe(EXIT.ok);
    expect(after.stdout()).toContain("(no pending approvals)");

    // The decision is in the history, read offline.
    const history = capture();
    expect(
      await main(["approvals", "history", "--kind", "approval", "--format", "json", "--data-dir", directory], { io: history.io }),
      history.stderr(),
    ).toBe(EXIT.ok);
    expect(JSON.parse(history.stdout())).toMatchObject({
      items: [
        {
          kind: "approval",
          taskId,
          toolId: "browser.create_session",
          state: "denied",
          taskTitle: "open a browser",
          via: "cli",
          channel: "terminal",
        },
      ],
    });
    const text = capture();
    expect(await main(["approvals", "history", "--state", "denied", "--data-dir", directory], { io: text.io })).toBe(EXIT.ok);
    expect(text.stdout()).toMatch(new RegExp(`\\tapproval\\tdenied\\t${taskId}\\tbrowser\\.create_session\\t`));
    const none = capture();
    expect(await main(["approvals", "history", "--state", "granted", "--data-dir", directory], { io: none.io })).toBe(EXIT.ok);
    expect(none.stdout()).toContain("(no decisions yet)");
  }, 20_000);

  it("lists what needs you, and answers a question only through a running owner", async () => {
    const directory = directories.create();
    // A directory with a store, as any command finds one.
    (await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite") })).close();
    const none = capture();
    expect(await main(["needs", "--data-dir", directory], { io: none.io }), none.stderr()).toBe(EXIT.ok);
    expect(none.stdout()).toContain("(nothing needs you)");
    const json = capture();
    expect(await main(["approvals", "needs", "--format", "json", "--data-dir", directory], { io: json.io })).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout())).toEqual({ needs: [], truncated: false });
    const answered = capture();
    expect(await main(["answer", "task-1", "2", "--data-dir", directory], { io: answered.io })).toBe(EXIT.unavailable);
    expect(answered.stderr()).toContain("needs a running owner");
  });

  it("lists a root chat's workers' questions, handoffs and approvals for approvals needs { rootTaskId }", async () => {
    const asked: PendingWaitsInput[] = [];
    const pendingAsked: unknown[] = [];
    const at = "2026-10-04T10:00:00.000Z";
    const worker = {
      taskId: "worker-1",
      workspaceId: "default",
      principalId: "operator",
      workerLabel: "Researcher",
      deadlineAt: at,
      askedAt: at,
    };
    const repositories = {
      approvalInbox: {
        pending: (input: unknown) => {
          pendingAsked.push(input);
          return { rows: [], truncated: false };
        },
        pendingWaits: (input: PendingWaitsInput) => {
          asked.push(input);
          return {
            questions: [{ ...worker, waitId: "wait-1", question: "Which source?", deliveries: [] }],
            reviews: [],
            handoffs: [{ ...worker, waitId: "wait-2", handoff: { sessionId: "session-1", reason: "sign-in" as const } }],
            truncated: false,
          };
        },
      },
    } as never;
    const listed = await listNeeds(repositories, { workspaceId: "default", rootTaskId: "root-1" });
    expect(asked).toEqual([{ workspaceId: "default", limit: 200, rootTaskId: "root-1" }]);
    expect(pendingAsked).toEqual([{ workspaceId: "default", limit: 200, rootTaskId: "root-1" }]);
    expect(listed.needs).toEqual([
      expect.objectContaining({
        kind: "question",
        taskId: "worker-1",
        question: expect.objectContaining({ workerLabel: "Researcher", waitId: "wait-1" }),
      }),
    ]);
    expect(listed.handoffs).toEqual([expect.objectContaining({ taskId: "worker-1", waitId: "wait-2" })]);
    // A root is a filter of `needs` alone, and not with a task.
    expect(ApprovalsPayloadSchema.safeParse({ action: "needs", rootTaskId: "root-1" }).success).toBe(true);
    expect(ApprovalsPayloadSchema.safeParse({ action: "list", rootTaskId: "root-1" }).success).toBe(false);
    expect(ApprovalsPayloadSchema.safeParse({ action: "needs", rootTaskId: "root-1", taskId: "task-1" }).success).toBe(false);
  });

  it("prints a need as what it asks, then its chat and when it stops waiting, then the command that answers it on its own line", () => {
    const askedAt = "2026-10-02T10:00:00.000Z";
    const deadlineAt = "2026-10-02T11:00:00.000Z";
    expect(
      needLine({
        kind: "question",
        needId: "question:w",
        taskId: "task-1",
        askedAt,
        deadlineAt,
        question: {
          taskId: "task-1",
          workspaceId: "default",
          principalId: "operator",
          originLabel: "Daily release",
          waitId: "w",
          question: "Ship it?",
          choices: { options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false },
          deadlineAt,
          askedAt,
          deliveries: [],
        },
      } as never),
    ).toBe("? Ship it?  [1. Yes  2. No]\n    Daily release (task-1) · until 2026-10-02 11:00Z\n    answer: tavi answer task-1 <answer>");
    expect(
      needLine({
        kind: "approval",
        needId: "approval:a",
        taskId: "task-2",
        askedAt,
        approval: { toolId: "fs.write", summary: "write notes.md" },
      } as never),
    ).toBe("! fs.write write notes.md\n    task-2\n    decide: tavi approvals approve task-2 (or reject)");
    expect(
      needLine({
        kind: "review",
        needId: "review:task-3",
        taskId: "task-3",
        askedAt,
        review: { taskId: "task-3", taskTitle: "Report", artifactCount: 1, askedAt },
      } as never),
    ).toBe("◆ 1 result to review\n    Report (task-3)\n    decide: tavi artifacts list, then approve or reject");
  });

  it("parses needs and answer, with or without the approvals noun", () => {
    expect(parseArgs(["needs", "--limit", "20"])).toMatchObject({ command: "approvals", approvals: { action: "needs", limit: 20 } });
    expect(parseArgs(["answer", "task-1", "next", "Monday", "--wait", "w-1"])).toMatchObject({
      command: "approvals",
      approvals: { action: "answer", taskId: "task-1", answer: "next Monday", waitId: "w-1" },
    });
    expect(parseArgs(["approvals", "answer", "task-1", "--answer", "2"])).toMatchObject({
      approvals: { action: "answer", taskId: "task-1", answer: "2" },
    });
    for (const argv of [
      ["answer", "task-1"],
      ["answer"],
      ["approvals", "answer", "--answer", "2"],
      ["approvals", "needs", "task-1"],
      ["approvals", "list", "--answer", "2"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow();
    }
  });

  it("parses approvals history's filters, and refuses what history does not take", () => {
    expect(
      parseArgs([
        "approvals",
        "history",
        "--kind",
        "approval,question",
        "--state",
        "granted,expired",
        "--since",
        "2026-09-01",
        "--until",
        "2026-09-02T12:00:00+02:00",
        "--limit",
        "100",
      ]),
    ).toMatchObject({
      command: "approvals",
      approvals: {
        action: "history",
        kinds: ["approval", "question"],
        states: ["granted", "expired"],
        since: "2026-09-01T00:00:00.000Z",
        until: "2026-09-02T10:00:00.000Z",
        limit: 100,
        workspaceId: "default",
      },
    });
    expect(parseArgs(["approvals", "history", "--until", "2026-09-02"])).toMatchObject({
      approvals: { until: "2026-09-02T23:59:59.999Z" },
    });
    expect(parseArgs(["approvals", "history", "--cursor", "eyJ2IjoxfQ"])).toMatchObject({
      approvals: { action: "history", cursor: "eyJ2IjoxfQ" },
    });
    expect(parseArgs(["approvals", "history", "--tool", "http.request", "--principal", "alice"])).toMatchObject({
      approvals: { action: "history", toolId: "http.request", principalId: "alice" },
    });
    for (const argv of [
      ["approvals", "history", "--tool", " "],
      ["approvals", "history", "--principal", "x".repeat(129)],
      ["approvals", "list", "--tool", "http.request"],
      ["approvals", "list", "--principal", "alice"],
      ["approvals", "history", "--limit", "101"],
      ["approvals", "history", "--kind", "memory"],
      ["approvals", "history", "--state", "pending"],
      ["approvals", "history", "--since", "last week"],
      ["approvals", "history", "--since", "2026-09-02", "--until", "2026-09-01"],
      ["approvals", "history", "task-1"],
      ["approvals", "history", "--call", "c"],
      ["approvals", "history", "--cursor", "not a cursor"],
      ["approvals", "list", "--cursor", "eyJ2IjoxfQ"],
      ["approvals", "list", "--kind", "approval"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow();
    }
  });

  it("grants a suspended approval, so an approve-mode deployment can be driven from here", async () => {
    const directory = directories.create();
    const runtimeFactory = mutatingModel();
    const taskId = await suspendOnApproval(directory, runtimeFactory);

    const decided = capture();
    const code = await main(
      [
        "approvals",
        "approve",
        taskId,
        "--decided-by",
        "someone-other-than-the-owner",
        "--connection",
        "fixture-conn",
        "--model",
        "fixture-model",
        "--data-dir",
        directory,
      ],
      { io: decided.io, runtimeFactory },
    );
    expect(code, decided.stderr()).toBe(EXIT.ok);

    // The grant is durable, and the decider is recorded as attribution — while
    // the resume ran as the *task's* owner. Using `--decided-by` as the admission
    // principal made any mismatch mark a merely-suspended task failed, which is
    // the normal case for a conversation task created by `serve`.
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const rows = await store.asPort().repositories.approvals.listForTask(taskId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("granted");
      expect(rows[0]?.decidedBy).toBe("someone-other-than-the-owner");
      expect((await store.asPort().repositories.tasks.get(taskId))?.status).toBe("completed");
      // Keyed on the round, not a random key: a second front end deciding
      // the same round replays this admission instead of racing it.
      expect((await store.asPort().repositories.tasks.listAdmissions(taskId)).map((admission) => admission.operationKey)).toContain(
        approvalRoundKey(taskId, 1),
      );
    } finally {
      store.close();
    }
  });

  it("refuses a partial decision instead of failing the task, and names the calls", async () => {
    // `--call` cannot narrow: the workflow's reply parser requires one decision
    // per request, so a subset is fatal. The guard turns that into a usage error.
    const directory = directories.create();
    // Two gated calls in one turn: one round of two, which the command reads
    // from the task's durable admission record.
    const fixture = createFixtureModel({ turns: [{ text: "carried on" }] });
    let turn = 0;
    const twoCalls: ModelPort = {
      ...fixture,
      stream: async (request, options): Promise<ModelOutcome> => {
        turn += 1;
        if (turn > 1) return fixture.stream(request, options);
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [
            { id: "call-1", name: "browser.create_session", input: {} },
            { id: "call-2", name: "browser.create_session", input: {} },
          ],
          finishReason: "tool-calls",
          usage: {},
        };
      },
    };
    const runtimeFactory: RuntimeFactory = (options) =>
      composeTaviRuntime(options, { modelOverride: twoCalls, browserOverride: createFixtureBrowser() });
    const suspended = capture();
    expect(
      await main(
        [
          "run",
          "--connection",
          "fixture-conn",
          "--model",
          "fixture-model",
          "--approval",
          "ask",
          "--format",
          "json",
          "--data-dir",
          directory,
          "open two browsers",
        ],
        { io: suspended.io, runtimeFactory },
      ),
    ).toBe(EXIT.approvalRequired);
    const taskId = (JSON.parse(suspended.stdout().split("\n")[0] ?? "{}") as { runId: string }).runId;

    const refused = capture();
    const code = await main(
      [
        "approvals",
        "approve",
        taskId,
        "--call",
        "call-1",
        "--connection",
        "fixture-conn",
        "--model",
        "fixture-model",
        "--data-dir",
        directory,
      ],
      { io: refused.io, runtimeFactory },
    );
    expect(code, refused.stderr()).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/pending approvals/);
    expect(refused.stderr()).toContain("call-2");

    // Non-destructive: the task is still suspended, not failed.
    const after = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      expect((await after.asPort().repositories.tasks.get(taskId))?.status).toBe("waiting");
    } finally {
      after.close();
    }
  });

  it("reports a chained approval as still waiting, not as a failed task", async () => {
    // A model that calls a second gated tool after the first is decided is
    // ordinary; reporting it through the task-failed fall-through both lied and
    // hid the decision the operator still owed.
    const directory = directories.create();
    const model = createFixtureModel({
      turns: [
        { toolCall: { id: "call-1", name: "browser.create_session", input: {} } },
        { toolCall: { id: "call-2", name: "browser.create_session", input: {} } },
        { text: "done" },
      ],
    });
    const runtimeFactory: RuntimeFactory = (options) =>
      composeTaviRuntime(options, { modelOverride: model, browserOverride: createFixtureBrowser() });
    const taskId = await suspendOnApproval(directory, runtimeFactory);

    const decided = capture();
    const code = await main(
      [
        "approvals",
        "approve",
        taskId,
        "--scope",
        "once",
        "--connection",
        "fixture-conn",
        "--model",
        "fixture-model",
        "--data-dir",
        directory,
      ],
      { io: decided.io, runtimeFactory },
    );
    expect(code, decided.stderr()).toBe(EXIT.approvalRequired);
    expect(decided.stderr()).toMatch(/still waiting on an approval/);
    expect(decided.stdout()).not.toContain("task.failed");

    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      expect((await store.asPort().repositories.tasks.get(taskId))?.status).toBe("waiting");
      const pending = (await store.asPort().repositories.approvals.listForTask(taskId)).filter((row) => row.state === "pending");
      expect(pending.map((row) => row.callId)).toEqual(["call-2"]);
    } finally {
      store.close();
    }
  });

  it("does not resume a cancelled task, and leaves it cancelled", async () => {
    // A cancellation writes no admission, so the waiting admission's round still
    // looks pending; deciding it resumed the task and turned it `failed`.
    const directory = directories.create();
    const runtimeFactory = mutatingModel();
    const taskId = await suspendOnApproval(directory, runtimeFactory);
    const cancel = capture();
    expect(await main(["cancel", taskId, "--reason", "not needed", "--data-dir", directory], { io: cancel.io }), cancel.stderr()).toBe(
      EXIT.ok,
    );

    const decided = capture();
    const code = await main(
      ["approvals", "approve", taskId, "--connection", "fixture-conn", "--model", "fixture-model", "--data-dir", directory],
      { io: decided.io, runtimeFactory },
    );
    expect(code, decided.stderr()).toBe(EXIT.resumeNotApplicable);
    expect(decided.stderr()).toMatch(/is cancelled/);

    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      expect((await store.asPort().repositories.tasks.get(taskId))?.status).toBe("cancelled");
      // Nothing was admitted, so no round key was burned.
      expect((await store.asPort().repositories.tasks.listAdmissions(taskId)).filter((admission) => admission.kind === "approval")).toEqual(
        [],
      );
    } finally {
      store.close();
    }
  });

  it("keeps --operation-key as the retry key: a retry never decides the round the first decision surfaced", async () => {
    // Deciding round 1 surfaces round 2. A scripted retry of the same command
    // used to re-read "whatever is pending" and grant round 2 — a call nobody
    // reviewed.
    const directory = directories.create();
    const model = createFixtureModel({
      turns: [
        { toolCall: { id: "call-1", name: "browser.create_session", input: {} } },
        { toolCall: { id: "call-2", name: "browser.create_session", input: {} } },
        { text: "done" },
      ],
    });
    const runtimeFactory: RuntimeFactory = (options) =>
      composeTaviRuntime(options, { modelOverride: model, browserOverride: createFixtureBrowser() });
    const taskId = await suspendOnApproval(directory, runtimeFactory);
    const approve = async () => {
      const result = capture();
      const code = await main(
        [
          "approvals",
          "approve",
          taskId,
          "--operation-key",
          "my-key",
          // One call: a browser round approved with no scope is allowed for the task.
          "--scope",
          "once",
          "--connection",
          "fixture-conn",
          "--model",
          "fixture-model",
          "--data-dir",
          directory,
        ],
        { io: result.io, runtimeFactory },
      );
      return { code, result };
    };
    const first = await approve();
    expect(first.code, first.result.stderr()).toBe(EXIT.approvalRequired);
    const retry = await approve();
    expect(retry.code).not.toBe(EXIT.ok);
    expect([EXIT.approvalRequired, EXIT.unavailable]).toContain(retry.code);

    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      expect((await store.asPort().repositories.tasks.get(taskId))?.status).toBe("waiting");
      const pending = (await store.asPort().repositories.approvals.listForTask(taskId)).filter((row) => row.state === "pending");
      expect(pending.map((row) => row.callId)).toEqual(["call-2"]);
      // The first decision is under the supplied key, not the round's own.
      expect((await store.asPort().repositories.tasks.getAdmission(taskId, "my-key"))?.state).toBe("committed");
      expect(await store.asPort().repositories.tasks.getAdmission(taskId, approvalRoundKey(taskId, 1))).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("reports a round a resume decided but never committed, rather than deciding it again", async () => {
    // A round's fourth state: the rows were settled by a resume (under another key)
    // that died before recording its outcome. The thread may already be past
    // the interrupt, so a second decision is refused with exit 8, not admitted.
    const directory = directories.create();
    const runtimeFactory = mutatingModel();
    const taskId = await suspendOnApproval(directory, runtimeFactory);
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const row = (await store.asPort().repositories.approvals.listForTask(taskId))[0];
      await store.asPort().repositories.approvals.decide({
        approvalId: row?.approvalId ?? "",
        state: "granted",
        decidedBy: "schedule:brief",
        now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
      });
    } finally {
      store.close();
    }

    const decided = capture();
    const code = await main(
      ["approvals", "approve", taskId, "--connection", "fixture-conn", "--model", "fixture-model", "--data-dir", directory],
      { io: decided.io, runtimeFactory },
    );
    expect(code, decided.stderr()).toBe(EXIT.resumeNotApplicable);
    expect(decided.stderr()).toMatch(/already decided by a resume that never committed/);
  });

  it("shows the workspace and owner of each pending approval, and never another workspace's", async () => {
    const directory = directories.create();
    const runtimeFactory = mutatingModel();
    await suspendOnApproval(directory, runtimeFactory);

    const listed = capture();
    expect(await main(["approvals", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    // The two values an operator needs to act are in the row.
    expect(listed.stdout()).toContain("default\toperator");

    const other = capture();
    expect(await main(["approvals", "list", "--workspace", "other", "--data-dir", directory], { io: other.io })).toBe(EXIT.ok);
    expect(other.stdout()).toContain("(no pending approvals)");
  });

  it("lists a pending call's input masked offline, as tools.redactResults says", async () => {
    const directory = directories.create();
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { scheduleSweepEnabled: false }), {
      requireModelTransport: false,
    });
    const repositories = runtime.store.asPort().repositories;
    await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-secret",
      kind: "start",
      intent: { prompt: "write" },
      checkpointNamespace: "",
      newTaskId: "task-secret",
      newAdmissionId: "adm-secret",
      newThreadId: "thread-secret",
      now: "2026-01-01T00:00:00.000Z",
    });
    await repositories.approvals.request({
      approvalId: "approval-secret",
      taskId: "task-secret",
      admissionId: "adm-secret",
      toolId: "fs.write",
      callId: "call-secret",
      steps: 1,
      inputs: { path: "notes.md", content: "key AKIAIOSFODNN7EXAMPLE" },
      now: { fixed: "2026-01-01T00:00:00.000Z" },
    });
    await runtime.close();

    const listed = capture();
    expect(await main(["approvals", "list", "--format", "json", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect((JSON.parse(listed.stdout()) as { rows: { record: { inputs: { content: string } } }[] }).rows[0]?.record.inputs.content).toBe(
      "key [redacted:aws-key]",
    );

    // With masking off for the workspace, the input is shown as stored.
    expect(await main(["config", "set", "tools.redactResults", "off", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const raw = capture();
    expect(await main(["approvals", "list", "--format", "json", "--data-dir", directory], { io: raw.io })).toBe(EXIT.ok);
    expect(raw.stdout()).toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("tries to attach before refusing, so a running owner is asked first", async () => {
    // `approvals list` now asks a live owner over IPC,
    // which is the only way to inspect a queue that is wedged *because* `serve` is
    // running. With a lock held but no owner answering, the command still refuses —
    // the attach attempt must not have replaced the ownership boundary with a
    // direct database open.
    const directory = directories.create();
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "test-owner-session" });
    try {
      const listed = capture();
      expect(await main(["approvals", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.alreadyOwned);
      expect(listed.stderr()).toMatch(/tavi serve/);
    } finally {
      ownership.release();
    }
  });

  it("says to stop the serving owner rather than reporting a generic conflict", async () => {
    // The deployment this command exists for is exactly the one where `serve`
    // holds the directory, so the refusal has to name the remedy.
    const directory = directories.create();
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "test-owner-session" });
    try {
      const listed = capture();
      expect(await main(["approvals", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.alreadyOwned);
      expect(listed.stderr()).toMatch(/tavi serve/);
    } finally {
      ownership.release();
    }
  });

  it("says nothing was pending rather than reporting a decision it did not make", async () => {
    const directory = directories.create();
    const failed = capture();
    // 8, not 0: a caller must be able to tell "nothing was pending" from
    // "decided and resumed", the same distinction `tavi artifacts --resume` draws.
    expect(await main(["approvals", "reject", "task-never-existed", "--data-dir", directory], { io: failed.io })).toBe(
      EXIT.resumeNotApplicable,
    );
    expect(failed.stderr()).toMatch(/nothing to decide/);
  });

  it("answers list with an explicit empty result, and reports an unknown action as usage", async () => {
    const directory = directories.create();
    const listed = capture();
    expect(await main(["approvals", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toContain("(no pending approvals)");

    const bad = capture();
    expect(await main(["approvals", "decide", "x", "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/Unknown approvals action/);

    const missing = capture();
    expect(await main(["approvals", "reject", "--data-dir", directory], { io: missing.io })).toBe(EXIT.usage);
    expect(missing.stderr()).toMatch(/needs a task id/);

    const wrongFlag = capture();
    expect(await main(["approvals", "list", "--call", "call-1", "--data-dir", directory], { io: wrongFlag.io })).toBe(EXIT.usage);
    expect(wrongFlag.stderr()).toMatch(/does not accept --call/);
  });
});
