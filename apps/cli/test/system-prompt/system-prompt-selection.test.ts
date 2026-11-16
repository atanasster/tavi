import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { inspectDatabase } from "../support/database-fixture.js";

import type { InvocationContext } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { DEFAULT_SYSTEM_PROMPT, SHIPPED_SYSTEM_PROMPT_VERSION, systemPromptTemplate } from "@tavi/agent-host/system-prompt";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * End-to-end acceptance of system-prompt selection: the
 * base a model request receives is resolved from the workspace setting at task
 * creation and pinned for that task's lifetime — driven through the *composed*
 * runtime, so the assertion is about the actual system message a model gets, not
 * about a resolver in isolation.
 *
 * The defect this exists for is that the base used to be captured once at
 * adapter construction (`const systemPrompt = options.systemPrompt ??
 * DEFAULT_SYSTEM_PROMPT`), which made a settings row unable to change any model
 * request at all.
 */

const workspaces = [
  { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
] as const;

const directories = temporaryDirectories({ prefix: "tavi-system-prompt-" });

afterEach(() => directories.cleanup());

async function composed(
  directory: string,
  turns: readonly ScriptedTurn[],
  extra: { readonly systemPrompt?: string } = {},
): Promise<{ readonly runtime: TaviRuntime; readonly model: ReturnType<typeof createFixtureModel> }> {
  const model = createFixtureModel({ turns });
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      workspaces: [...workspaces],
      approvalRequiredFor: [],
      ...(extra.systemPrompt === undefined ? {} : { systemPrompt: extra.systemPrompt }),
    }),
    { modelOverride: model },
  );
  return { runtime, model };
}

const context: InvocationContext = {
  workspaceId: "default",
  principalId: "operator",
  runId: "pending-admission",
  caller: "test",
};

function systemText(model: ReturnType<typeof createFixtureModel>, call: number): string {
  return model.calls[call]?.messages.find((message) => message.role === "system")?.text ?? "";
}

/** The persisted override, written the way the owner command does (step 3 wires the command). */
async function saveOverride(runtime: TaviRuntime, text: string): Promise<void> {
  const systemPrompts = runtime.store.asPort().repositories.systemPrompts;
  const current = await systemPrompts.get("default");
  await systemPrompts.set({
    workspaceId: "default",
    text,
    expectedRevision: current.revision,
    actor: "operator",
    now: nowTimestamp(),
  });
}

describe("workspace system prompt selection", () => {
  it("sends a saved override to a new task without restarting the owner", async () => {
    const directory = directories.create();
    const { runtime, model } = await composed(directory, [{ text: "done" }]);
    try {
      await saveOverride(runtime, "WORKSPACE-OVERRIDE-BASE");
      await runtime.workflow?.admit({ context, operationKey: "op-override", kind: "start", prompt: "go" });
      expect(systemText(model, 0)).toContain("WORKSPACE-OVERRIDE-BASE");
    } finally {
      await runtime.close();
    }
  });

  it("falls back to the shipped default for a workspace that never saved", async () => {
    const directory = directories.create();
    const { runtime, model } = await composed(directory, [{ text: "done" }]);
    try {
      await runtime.workflow?.admit({ context, operationKey: "op-default", kind: "start", prompt: "go" });
      // The shipped text itself, by constant: a promotion must move this test with
      // it rather than leave a stale literal behind.
      expect(systemText(model, 0)).toContain(DEFAULT_SYSTEM_PROMPT);
    } finally {
      await runtime.close();
    }
  });

  it("re-pins an existing chat's base from its next message, keeping the task's own snapshot", async () => {
    const directory = directories.create();
    const { runtime, model } = await composed(directory, [{ text: "first" }, { text: "second" }, { text: "third" }, { text: "fourth" }]);
    try {
      await saveOverride(runtime, "BASE-ONE");
      const first = await runtime.workflow?.admit({ context, operationKey: "op-pin-1", kind: "start", prompt: "go" });
      const taskId = first?.taskId ?? "";
      expect(systemText(model, 0)).toContain("BASE-ONE");

      // A follow-up with the setting unchanged runs under the same base.
      await runtime.workflow?.admit({
        context: { ...context, runId: taskId },
        operationKey: "op-pin-2",
        kind: "reply",
        taskId,
        prompt: "again",
      });
      expect(systemText(model, 1)).toContain("BASE-ONE");

      // The operator edits the setting while the chat goes on…
      await saveOverride(runtime, "BASE-TWO");

      // …and the chat's next message runs under the edit.
      await runtime.workflow?.admit({
        context: { ...context, runId: taskId },
        operationKey: "op-pin-3",
        kind: "reply",
        taskId,
        prompt: "and again",
      });
      expect(systemText(model, 2)).toContain("BASE-TWO");
      expect(systemText(model, 2)).not.toContain("BASE-ONE");

      // A task created afterwards selects the new revision too.
      await runtime.workflow?.admit({ context, operationKey: "op-pin-4", kind: "start", prompt: "go" });
      expect(systemText(model, 3)).toContain("BASE-TWO");

      // The task's own snapshot is still the base it was created with; the turn's pin is the edit.
      const tasks = runtime.store.asPort().repositories.tasks;
      expect(await tasks.getPromptSnapshot(taskId)).toEqual(
        expect.objectContaining({ source: "workspace", text: "BASE-ONE", revision: 1 }),
      );
      const third = await tasks.getAdmission(taskId, "op-pin-3");
      expect(await tasks.getPromptSnapshot(taskId, third?.admissionId)).toEqual(
        expect.objectContaining({ source: "workspace", text: "BASE-TWO", revision: 2 }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("reuses the original selection when a settings edit lands between an admission and its retry", async () => {
    const directory = directories.create();
    const { runtime, model } = await composed(directory, [{ text: "done" }]);
    try {
      await saveOverride(runtime, "BASE-BEFORE-RETRY");
      const first = await runtime.workflow?.admit({ context, operationKey: "op-retry", kind: "start", prompt: "go" });
      await saveOverride(runtime, "BASE-AFTER-EDIT");

      // A retry of the same operation key with the same content must resolve the
      // original admission, never a `CONFLICT` — the resolved base is deliberately
      // not part of the admission `intent`, whose hash is compared on every retry.
      const retry = await runtime.workflow?.admit({ context, operationKey: "op-retry", kind: "start", prompt: "go" });
      expect(retry?.taskId).toBe(first?.taskId);
      expect(model.calls).toHaveLength(1);
      expect(await runtime.store.asPort().repositories.tasks.getPromptSnapshot(first?.taskId ?? "")).toEqual(
        expect.objectContaining({ source: "workspace", text: "BASE-BEFORE-RETRY", revision: 1 }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("keeps an explicitly configured adapter prompt ahead of a workspace override", async () => {
    const directory = directories.create();
    const { runtime, model } = await composed(directory, [{ text: "done" }], { systemPrompt: "EXPLICIT-EMBEDDING-BASE" });
    try {
      await saveOverride(runtime, "WORKSPACE-OVERRIDE-BASE");
      await runtime.workflow?.admit({ context, operationKey: "op-explicit", kind: "start", prompt: "go" });
      expect(systemText(model, 0)).toContain("EXPLICIT-EMBEDDING-BASE");
      expect(systemText(model, 0)).not.toContain("WORKSPACE-OVERRIDE-BASE");
    } finally {
      await runtime.close();
    }
  });

  it("preserves a saved base's leading and trailing whitespace in the request", async () => {
    const directory = directories.create();
    const { runtime, model } = await composed(directory, [{ text: "done" }]);
    const text = "  keep\n\n  every\tcharacter  \n";
    try {
      await saveOverride(runtime, text);
      await runtime.workflow?.admit({ context, operationKey: "op-verbatim", kind: "start", prompt: "go" });
      expect(model.calls).toHaveLength(1);
      expect(systemText(model, 0)).toContain(text);
    } finally {
      await runtime.close();
    }
  });
});

describe("the prompt hash contract", () => {
  it("agrees between the plugin and runtime implementations", async () => {
    // The hash is computed in two packages on purpose — `packages/runtime` must
    // not depend on `@tavi/agent-host` — so the coupling is asserted here, where both
    // are importable, rather than left to a comment.
    const { systemPromptHash } = await import("@tavi/agent-host/system-prompt");
    const { SqliteStore } = await import("../support/database-fixture.js");
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    try {
      const text = "a prompt with \n newlines and unicode ✨";
      // The store's own hash is observable through a snapshot it accepts or
      // refuses: writing one with the plugin's hash must be accepted.
      await store.asPort().repositories.tasks.admit({
        prompt: { ...fixturePromptPolicy, explicitPrompt: text },
        workspaceId: "default",
        principalId: "operator",
        operationKey: "op-hash",
        kind: "start",
        intent: null,
        checkpointNamespace: "",
        newTaskId: (() => "task-hash")(),
        newAdmissionId: (() => "adm-hash")(),
        newThreadId: (() => "thread-hash")(),
        now: (() => "2026-01-01T00:00:00.000Z")(),
      });
      // The store re-verifies the hash on read; a mismatch would throw INTERNAL.
      expect(await store.asPort().repositories.tasks.getPromptSnapshot("task-hash")).toEqual(
        expect.objectContaining({ text, hash: systemPromptHash(text) }),
      );
    } finally {
      store.close();
    }
  });
});

describe("default upgrade behavior", () => {
  it("runs an existing task on its stored base, never re-resolving it from the template registry", async () => {
    // The upgrade guarantee, exercised rather than restated: a task created with
    // no override records the shipped template it used, and the base it runs under
    // comes from *that row*. Pointing the row's version at something this build
    // does not carry must not change the text — the registry is never consulted
    // for a bound task, so a later revision cannot rebind an existing one.
    const directory = directories.create();
    const { runtime, model } = await composed(directory, [{ text: "first" }, { text: "second" }]);
    try {
      const admitted = await runtime.workflow?.admit({ context, operationKey: "op-upgrade", kind: "start", prompt: "go" });
      const taskId = admitted?.taskId ?? "";
      const snapshot = await runtime.store.asPort().repositories.tasks.getPromptSnapshot(taskId);
      expect(model.calls).toHaveLength(1);
      // The *shipped* version, whatever it currently is: a promotion must not make
      // this test assert a stale one, and the row is what the task runs under.
      expect(snapshot).toMatchObject({ source: "builtin", templateVersion: SHIPPED_SYSTEM_PROMPT_VERSION });
      expect(snapshot?.text).toContain("You are Tavi, a local-first");
      expect(systemText(model, 0)).toContain(snapshot?.text ?? "");

      inspectDatabase(runtime.store)
        .prepare("UPDATE tavi_task_prompt_snapshots SET template_version = 'tavi-default-v99' WHERE task_id = ?")
        .run(taskId);
      await runtime.workflow?.admit({
        context: { ...context, runId: taskId },
        taskId,
        operationKey: "op-upgrade-2",
        kind: "reply",
        prompt: "again",
      });
      expect(model.calls).toHaveLength(2);
      expect(systemText(model, 1)).toContain(snapshot?.text ?? "");
      // …while the registry still names the version the row was stamped with, so
      // the stored text stays explainable after a content revision.
      expect(systemPromptTemplate(SHIPPED_SYSTEM_PROMPT_VERSION)?.text).toBe(snapshot?.text);
    } finally {
      await runtime.close();
    }
  });

  it("keeps a custom workspace's text, and puts it in front of the new task only", async () => {
    // The other half: an override always outranks the shipped default, so a
    // workspace that saved one is unaffected by an upgrade — and the task created
    // before the save still runs under the older selection.
    const directory = directories.create();
    const { runtime, model } = await composed(directory, [{ text: "first" }, { text: "second" }]);
    try {
      await saveOverride(runtime, "BASE-BEFORE-UPGRADE");
      const first = await runtime.workflow?.admit({ context, operationKey: "op-up-1", kind: "start", prompt: "go" });
      // A later save is the *workspace* moving on (the settings analogue of a
      // shipped revision: both leave an existing task's pinned row alone).
      await saveOverride(runtime, "SHIPPED-AFTER-UPGRADE");
      await runtime.workflow?.admit({ context, operationKey: "op-up-2", kind: "start", prompt: "go" });
      // Asserted before the text, so a run that never reached the model fails as a
      // call-count failure rather than as a prompt mismatch.
      expect(model.calls).toHaveLength(2);
      expect(systemText(model, 0)).toContain("BASE-BEFORE-UPGRADE");
      expect(systemText(model, 1)).toContain("SHIPPED-AFTER-UPGRADE");
      expect(await runtime.store.asPort().repositories.tasks.getPromptSnapshot(first?.taskId ?? "")).toMatchObject({
        source: "workspace",
        text: "BASE-BEFORE-UPGRADE",
        revision: 1,
      });
    } finally {
      await runtime.close();
    }
  });
});
