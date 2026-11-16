import type {
  ChatContextAnswer,
  ChatContextForgetAnswer,
  ChatContextHistoryAnswer,
  MemoryItem,
  MemoryListAnswer,
  SystemPromptPreview,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { SYSTEM_PROMPT_TEMPLATES } from "@tavi/agent-host/system-prompt";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { memoryCommand } from "../../src/features/memory/owner.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * The chat panel's owner calls: `chat-context`,
 * `system-prompt preview {taskId}`, a chat's notes and moves in `memory`, and
 * `reminders` by the chat they were asked in.
 */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

async function owner(): Promise<{ readonly handle: ServeHandle; readonly client: IpcClient }> {
  const directory = directories.create("tavi-chat-context-");
  const handle = await serve(
    fixtureServeOptions(directory, {
      workspaces: [
        { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
        { workspaceId: "other", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
      ],
    }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  const discovered = await findLiveOwner(directory);
  if (discovered === undefined) throw new Error("no owner");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return { handle, client };
}

async function chat(handle: ServeHandle, taskId: string, workspaceId = "default", prompt = fixturePromptPolicy): Promise<void> {
  await handle.runtime.store.asPort().repositories.tasks.admit({
    prompt,
    workspaceId,
    principalId: "operator",
    operationKey: `op-${taskId}`,
    kind: "start",
    intent: { prompt: "hi" },
    checkpointNamespace: "",
    newTaskId: taskId,
    newAdmissionId: `adm-${taskId}`,
    newThreadId: `thread-${taskId}`,
    now: nowTimestamp(),
  });
}

const result = <T>(answer: { readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string } }): T => {
  if (!answer.ok) throw new Error(`refused: ${answer.error?.code ?? "?"}`);
  return answer.result as T;
};

describe("chat-context on a live owner", () => {
  it("saves a chat's instructions by revision, answers a stale save with CONFLICT, and keeps their history", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    expect(result<ChatContextAnswer>(await client.request("chat-context", { action: "get", taskId: "t1" }, "get"))).toEqual({
      taskId: "t1",
      revision: 0,
      current: null,
    });
    const saved = result<ChatContextAnswer>(
      await client.request("chat-context", { action: "set", taskId: "t1", text: "Answer in French.", expectedRevision: 0 }, "set"),
    );
    expect(saved).toMatchObject({ revision: 1, current: { text: "Answer in French.", author: "operator:cli" } });
    const stale = await client.request("chat-context", { action: "set", taskId: "t1", text: "Late", expectedRevision: 0 }, "stale");
    expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(
      result<ChatContextAnswer>(await client.request("chat-context", { action: "reset", taskId: "t1", expectedRevision: 1 }, "reset")),
    ).toMatchObject({ revision: 2, current: { text: "" } });
    expect(
      result<ChatContextHistoryAnswer>(await client.request("chat-context", { action: "history", taskId: "t1" }, "history")).revisions.map(
        (item) => item.revision,
      ),
    ).toEqual([2, 1]);
    // A chat in another workspace, or none at all, is not found alike.
    await chat(handle, "t-other", "other");
    for (const [taskId, workspaceId] of [
      ["t-other", "default"],
      ["nope", "default"],
    ] as const) {
      expect(await client.request("chat-context", { action: "get", taskId, workspaceId }, `nf-${taskId}`)).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    }
  });

  it("names a chat as the reader calls it, and goes back to its generated title", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    await handle.runtime.store.asPort().repositories.taskSummaries.rename({ taskId: "t1", title: null });
    expect(
      result<ChatContextAnswer>(await client.request("chat-context", { action: "rename", taskId: "t1", title: "Site audit" }, "rename")),
    ).toMatchObject({ title: "Site audit", renamed: true });
    const listed = result<{ rows: { taskId: string; title?: string; titleSource?: string }[] }>(
      await client.request("tasks", { action: "list", workspaceId: "default" }, "list"),
    );
    expect(listed.rows.find((row) => row.taskId === "t1")).toMatchObject({ title: "Site audit", titleSource: "reader" });
    const back = result<ChatContextAnswer>(await client.request("chat-context", { action: "rename", taskId: "t1", title: null }, "back"));
    expect(back.renamed).toBeUndefined();
    expect(await client.request("chat-context", { action: "rename", taskId: "t1", title: "   " }, "blank")).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("marks each listed chat with its notes, a chat of another workspace too", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    await chat(handle, "t2", "other");
    await chat(handle, "t3");
    const note = async (taskId: string, workspaceId: string, body: string) => {
      const actor = { principalId: "operator", workspaceId, runId: taskId, caller: "test", authority: "operator" } as const;
      await handle.runtime.memory.remember({
        actor,
        scope: { kind: "run_local", principalId: "operator", workspaceId, runId: taskId },
        kind: "fact",
        body,
        durable: true,
      });
    };
    await note("t1", "default", "One");
    await note("t2", "other", "Two");
    await note("t2", "other", "Three");
    const notesOf = async (payload: Record<string, unknown>) =>
      new Map(
        result<{ rows: { taskId: string; chatNotes?: number }[] }>(
          await client.request("tasks", { action: "list", ...payload }, "list"),
        ).rows.map((row) => [row.taskId, row.chatNotes]),
      );
    const every = await notesOf({});
    expect([...every]).toEqual(
      expect.arrayContaining([
        ["t1", 1],
        ["t2", 2],
        ["t3", undefined],
      ]),
    );
    const other = await notesOf({ workspaceId: "other" });
    expect([...other]).toEqual([["t2", 2]]);
  });

  it("previews a chat's next turn: its own base and its current instructions", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    await client.request("chat-context", { action: "set", taskId: "t1", text: "Be brief.", expectedRevision: 0 }, "set");
    const preview = result<SystemPromptPreview>(
      await client.request("system-prompt", { action: "preview", workspaceId: "default", taskId: "t1" }, "preview"),
    );
    expect(preview.taskId).toBe("t1");
    expect(preview.chatText).toContain("Be brief.");
    expect(preview.layers.map((layer) => layer.kind)).toContain("chat");
    expect(await client.request("system-prompt", { action: "get", workspaceId: "default", taskId: "t1" }, "refused")).toMatchObject({
      ok: false,
    });
    // The fixed prompt, measured against the owner's context budget.
    expect(preview.budget?.maxTokens).toBe(8000);
    expect(preview.budget?.fixedTokens).toBeGreaterThan(0);
  });

  it("previews a chat's next turn under a workspace edit made since it started", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    const prompts = handle.runtime.store.asPort().repositories.systemPrompts;
    const current = await prompts.get("default");
    await prompts.set({
      workspaceId: "default",
      text: "EDITED BASE",
      expectedRevision: current.revision,
      actor: "operator",
      now: nowTimestamp(),
    });
    const preview = result<SystemPromptPreview>(
      await client.request("system-prompt", { action: "preview", workspaceId: "default", taskId: "t1" }, "preview"),
    );
    expect(preview.baseText).toBe("EDITED BASE");
    expect(preview.overridden).toBe(true);
    expect(
      result<{ appliesTo: string }>(await client.request("system-prompt", { action: "get", workspaceId: "default" }, "get")).appliesTo,
    ).toBe("next-message");
  });

  it("previews a chat on an older shipped template under that template, until a workspace base moves it", async () => {
    const { handle, client } = await owner();
    const older = SYSTEM_PROMPT_TEMPLATES.find((template) => template.version === "tavi-default-1")!;
    // Started before tavi-default-2 shipped: its next turn keeps tavi-default-1, so the preview shows that.
    await chat(handle, "t1", "default", { builtin: { text: older.text, version: older.version } });
    const preview = result<SystemPromptPreview>(
      await client.request("system-prompt", { action: "preview", workspaceId: "default", taskId: "t1" }, "preview"),
    );
    expect(preview.baseText).toBe(older.text);
    expect(preview.overridden).toBe(false);
    expect(preview.layers.filter((layer) => layer.kind === "base")).toEqual([
      expect.objectContaining({ source: "shipped", active: true, templateVersion: "tavi-default-1", length: older.text.length }),
    ]);
    // A workspace base still moves every chat, this one included.
    const prompts = handle.runtime.store.asPort().repositories.systemPrompts;
    await prompts.set({
      workspaceId: "default",
      text: "EDITED BASE",
      expectedRevision: (await prompts.get("default")).revision,
      actor: "operator",
      now: nowTimestamp(),
    });
    const moved = result<SystemPromptPreview>(
      await client.request("system-prompt", { action: "preview", workspaceId: "default", taskId: "t1" }, "moved"),
    );
    expect(moved.baseText).toBe("EDITED BASE");
    expect(moved.layers.filter((layer) => layer.kind === "base").map((layer) => [layer.source, layer.active])).toEqual([
      ["shipped", false],
      ["workspace", true],
    ]);
  });

  it("asks for fresh context for a chat's next message, and refuses it for an unknown chat", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    expect(result(await client.request("chat-context", { action: "compact", taskId: "t1" }, "compact"))).toEqual({
      taskId: "t1",
      freshContext: "next-message",
    });
    // Asked again, it is still one request.
    expect(result(await client.request("chat-context", { action: "compact", taskId: "t1" }, "compact-again"))).toEqual({
      taskId: "t1",
      freshContext: "next-message",
    });
    expect(await client.request("chat-context", { action: "compact", taskId: "nope" }, "compact-nope")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await client.request("chat-context", { action: "compact", workspaceId: "other", taskId: "t1" }, "compact-other")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("refuses instructions for an agent's task, which runs under its agent's, and names its chat", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    await chat(handle, "w1");
    await handle.runtime.store.asPort().repositories.agentDelegations.recordSpawn({
      operationKey: "op-w1",
      workspaceId: "default",
      principalId: "operator",
      workerTaskId: "w1",
      workerAgentId: "agent-1",
      parentTaskId: "t1",
      rootTaskId: "t1",
      createdAt: nowTimestamp(),
      depth: 1,
    });
    // Nor fresh context: a worker is no chat.
    expect(await client.request("chat-context", { action: "compact", taskId: "w1" }, "compact-worker")).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("in its chat, t1") },
    });
    for (const action of ["set", "reset"] as const) {
      const refused = await client.request(
        "chat-context",
        { action, taskId: "w1", expectedRevision: 0, ...(action === "set" ? { text: "x" } : {}) },
        action,
      );
      expect(refused).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT", message: expect.stringContaining("set them on its chat, t1") },
      });
    }
    expect(result<ChatContextAnswer>(await client.request("chat-context", { action: "get", taskId: "w1" }, "get"))).toMatchObject({
      delegatedFrom: "t1",
    });
  });
});

describe("forgetting a chat's history on a live owner", () => {
  it("memory invariant 9: deletes the chat's fold archives and its waiting proposals; approved memory it taught stays unless asked, then goes too", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    await chat(handle, "t2");
    const artifacts = handle.runtime.store.asPort().repositories.artifacts;
    const archive = async (artifactId: string, taskId: string, fold?: "epoch" | "summary") =>
      await artifacts.putArtifact({
        artifactId,
        workspaceId: "default",
        runId: taskId,
        contentType: "application/json",
        body: JSON.stringify([{ id: "m1", role: "user", text: "folded words" }]),
        extension: "json",
        ...(fold === undefined ? {} : { fold }),
      });
    await archive("art-epoch", "t1", "epoch");
    await archive("art-other", "t2", "epoch");
    const model = { principalId: "operator", workspaceId: "default", runId: "t1", caller: "model", authority: "model" } as const;
    const operator = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" } as const;
    const personal = { kind: "personal", principalId: "operator" } as const;
    const waiting = await handle.runtime.memory.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      body: "Prefers trains",
      originTaskId: "t1",
    });
    const taught = await handle.runtime.memory.remember({
      actor: operator,
      scope: personal,
      kind: "fact",
      body: "Lives in Porto",
      originTaskId: "t1",
    });
    const elsewhere = await handle.runtime.memory.propose({
      actor: { ...model, runId: "t2" },
      scope: personal,
      kind: "fact",
      body: "Likes tea",
      originTaskId: "t2",
    });
    const before = new Date(Date.now() + 1_000).toISOString();

    const first = result<ChatContextForgetAnswer>(
      await client.request("chat-context", { action: "forget", taskId: "t1", before }, "forget"),
    );
    expect(first).toMatchObject({ archives: 1, proposals: 1, memoriesKept: 1 });
    expect(first.memories).toBeUndefined();
    expect(await artifacts.getArtifact("art-epoch")).toBeUndefined();
    expect(await artifacts.getArtifact("art-other")).toBeDefined();
    const status = async (recordId: string): Promise<string> =>
      (await handle.runtime.store.asPort().repositories.memory.getRecord(recordId))?.status ?? "none";
    expect(await status(waiting.recordId)).toBe("deleted");
    expect(await status(taught.recordId)).toBe("approved");
    expect(await status(elsewhere.recordId)).toBe("proposed");

    const second = result<ChatContextForgetAnswer>(
      await client.request("chat-context", { action: "forget", taskId: "t1", before, withMemory: true }, "forget-memory"),
    );
    expect(second).toMatchObject({ archives: 0, proposals: 0, memories: 1 });
    expect(second.memoriesKept).toBeUndefined();
    expect(await status(taught.recordId)).toBe("deleted");
    expect(await status(elsewhere.recordId)).toBe("proposed");
  });

  it("memory invariant 21: a bound person's chat keeps their memory, even with withMemory, and the answer says so", async () => {
    const { handle, client } = await owner();
    await handle.runtime.store.asPort().repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "bob",
      operationKey: "op-t3",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: "t3",
      newAdmissionId: "adm-t3",
      newThreadId: "thread-t3",
      now: nowTimestamp(),
    });
    const personal = { kind: "personal", principalId: "bob" } as const;
    const waiting = await handle.runtime.memory.propose({
      actor: { principalId: "bob", workspaceId: "default", runId: "t3", caller: "model", authority: "model" },
      scope: personal,
      kind: "fact",
      body: "Prefers buses",
      originTaskId: "t3",
    });
    const taught = await handle.runtime.memory.remember({
      actor: { principalId: "bob", workspaceId: "default", caller: "test", authority: "operator" },
      scope: personal,
      kind: "fact",
      body: "Lives in Faro",
      originTaskId: "t3",
    });
    const before = new Date(Date.now() + 1_000).toISOString();
    const answer = result<ChatContextForgetAnswer>(
      await client.request("chat-context", { action: "forget", taskId: "t3", before, withMemory: true }, "forget-bob"),
    );
    expect(answer.memoryNotYours).toBe(true);
    expect(answer.proposals).toBeUndefined();
    expect(answer.memories).toBeUndefined();
    const status = async (recordId: string): Promise<string> =>
      (await handle.runtime.store.asPort().repositories.memory.getRecord(recordId))?.status ?? "none";
    expect(await status(waiting.recordId)).toBe("proposed");
    expect(await status(taught.recordId)).toBe("approved");
  });
});

describe("a chat's notes on a live owner", () => {
  it("remembers a note for one chat, lists it only when the chat is named, and never its working memory", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    const note = result<MemoryItem>(
      await client.request("memory", { action: "remember", kind: "fact", scope: "chat:t1", body: "The client is Acme" }, "note"),
    );
    expect(note).toMatchObject({ target: "chat:t1", durable: true, originTaskId: "t1", status: "approved" });
    // The chat's working memory, which no page lists.
    await handle.runtime.memory.remember({
      actor: { principalId: "operator", workspaceId: "default", runId: "t1", caller: "test", authority: "operator" },
      scope: { kind: "run_local", principalId: "operator", workspaceId: "default", runId: "t1" },
      kind: "fact",
      body: "scratch",
    });
    const everywhere = result<MemoryListAnswer>(await client.request("memory", { action: "list" }, "all"));
    expect(everywhere.records.map((record) => record.recordId)).not.toContain(note.recordId);
    const notes = result<MemoryListAnswer>(await client.request("memory", { action: "list", scopes: ["chat:t1"] }, "notes"));
    expect(notes.records.map((record) => record.body)).toEqual(["The client is Acme"]);
    expect(
      result<{ record: MemoryItem }>(await client.request("memory", { action: "get", recordId: note.recordId }, "get")).record.recordId,
    ).toBe(note.recordId);
    expect(await client.request("memory", { action: "remember", kind: "fact", scope: "chat:nope", body: "x" }, "no-chat")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("lists every chat's notes on their own, never working memory or other memory", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    await chat(handle, "t2");
    await client.request("memory", { action: "remember", kind: "fact", scope: "chat:t1", body: "Note one" }, "n1");
    await client.request("memory", { action: "remember", kind: "fact", scope: "chat:t2", body: "Note two" }, "n2");
    await client.request("memory", { action: "remember", kind: "fact", scope: "personal", body: "Everywhere" }, "p");
    await handle.runtime.memory.remember({
      actor: { principalId: "operator", workspaceId: "default", runId: "t1", caller: "test", authority: "operator" },
      scope: { kind: "run_local", principalId: "operator", workspaceId: "default", runId: "t1" },
      kind: "fact",
      body: "scratch",
    });
    const every = result<MemoryListAnswer>(await client.request("memory", { action: "list", chatNotes: true }, "every"));
    expect(every.records.map((record) => [record.body, record.target]).sort()).toEqual([
      ["Note one", "chat:t1"],
      ["Note two", "chat:t2"],
    ]);
    expect(await client.request("memory", { action: "list", chatNotes: true, scopes: ["personal"] }, "mixed")).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("lists what a chat taught, and moves a note to every chat and back", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    const learned = result<MemoryItem>(
      await client.request(
        "memory",
        { action: "remember", kind: "fact", scope: "personal", body: "Prefers metric", originTaskId: "t1" },
        "learned",
      ),
    );
    await client.request("memory", { action: "remember", kind: "fact", scope: "personal", body: "Unrelated" }, "unrelated");
    expect(
      result<MemoryListAnswer>(await client.request("memory", { action: "list", originTaskId: "t1" }, "origin")).records.map(
        (record) => record.recordId,
      ),
    ).toEqual([learned.recordId]);
    const note = result<MemoryItem>(
      await client.request("memory", { action: "move", recordId: learned.recordId, to: "chat:t1" }, "to-chat"),
    );
    expect(note).toMatchObject({ target: "chat:t1", durable: true, originTaskId: "t1", body: "Prefers metric" });
    expect(await client.request("memory", { action: "get", recordId: learned.recordId }, "gone")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    const back = result<MemoryItem>(
      await client.request("memory", { action: "move", recordId: note.recordId, to: "personal" }, "to-personal"),
    );
    expect(back).toMatchObject({ target: "personal", originTaskId: "t1" });
    expect(back.durable).toBeUndefined();
    expect(await client.request("memory", { action: "move", recordId: back.recordId, to: "personal" }, "same")).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });
});

describe("what a chat used, on a live owner", () => {
  it("lists the records its turns were given, most recent first, leaving out what was forgotten since", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    const first = result<MemoryItem>(
      await client.request("memory", { action: "remember", kind: "fact", scope: "personal", body: "First" }, "first"),
    );
    const second = result<MemoryItem>(
      await client.request("memory", { action: "remember", kind: "fact", scope: "personal", body: "Second" }, "second"),
    );
    const gone = result<MemoryItem>(
      await client.request("memory", { action: "remember", kind: "fact", scope: "personal", body: "Gone" }, "gone"),
    );
    const use = handle.runtime.store.asPort().repositories.memoryUse;
    await use.record({ taskId: "t1", admissionId: "a1", recordIds: [first.recordId, gone.recordId], at: "2026-10-01T10:00:00.000Z" });
    await use.record({ taskId: "t1", admissionId: "a2", recordIds: [second.recordId], at: "2026-10-01T11:00:00.000Z" });
    await client.request("memory", { action: "forget", recordId: gone.recordId }, "forget");
    const used = result<MemoryListAnswer>(await client.request("memory", { action: "list", usedInTaskId: "t1" }, "used"));
    expect(used.records.map((record) => record.body)).toEqual(["Second", "First"]);
    // With when each was last given, and to which record.
    expect(used.records.map((record) => [record.recordId, record.usedAt])).toEqual([
      [second.recordId, "2026-10-01T11:00:00.000Z"],
      [first.recordId, "2026-10-01T10:00:00.000Z"],
    ]);
    // The other filters apply: none of these was written from the chat.
    expect(
      result<MemoryListAnswer>(await client.request("memory", { action: "list", usedInTaskId: "t1", originTaskId: "t1" }, "used-origin"))
        .records,
    ).toEqual([]);
    expect(await client.request("memory", { action: "list", usedInTaskId: "t1", query: "x" }, "query")).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await client.request("memory", { action: "list", usedInTaskId: "nope" }, "nope")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });
});

describe("a chat's notes across workspaces, and a move that cannot complete", () => {
  it("refuses a chat note, an origin or a move into a chat of another workspace", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t-other", "other");
    const kept = result<MemoryItem>(
      await client.request("memory", { action: "remember", kind: "fact", scope: "personal", body: "Keep" }, "keep"),
    );
    for (const [label, payload] of [
      ["note", { action: "remember", kind: "fact", scope: "chat:t-other", body: "x" }],
      ["origin", { action: "remember", kind: "fact", scope: "personal", body: "x", originTaskId: "t-other" }],
      ["move", { action: "move", recordId: kept.recordId, to: "chat:t-other" }],
    ] as const) {
      expect(await client.request("memory", payload, label)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
    expect(await client.request("chat-context", { action: "get", taskId: "t-other", workspaceId: "unserved" }, "unserved")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(
      result<{ record: MemoryItem }>(await client.request("memory", { action: "get", recordId: kept.recordId }, "still")).record.body,
    ).toBe("Keep");
  });

  it("undoes the copy when the record changed while it was moved, so it is never kept twice nor loses the edit", async () => {
    const { handle } = await owner();
    await chat(handle, "t1");
    const service = handle.runtime.memory;
    const repositories = handle.runtime.store.asPort().repositories;
    const deps = { memory: service, repositories, principalOf: () => "operator", fromBridge: false, now: () => new Date() };
    const original = result<MemoryItem>(await memoryCommand(deps, { action: "remember", kind: "fact", scope: "personal", body: "Before" }));
    // An edit lands between the copy and the forget.
    const racing = {
      ...deps,
      memory: {
        approve: (input: Parameters<typeof service.approve>[0]) => service.approve(input),
        reject: (input: Parameters<typeof service.reject>[0]) => service.reject(input),
        correct: (input: Parameters<typeof service.correct>[0]) => service.correct(input),
        forget: (input: Parameters<typeof service.forget>[0]) => service.forget(input),
        usage: (input: Parameters<typeof service.usage>[0]) => service.usage(input),
        get: (input: Parameters<typeof service.get>[0]) => service.get(input),
        list: (input: Parameters<typeof service.list>[0]) => service.list(input),
        search: (input: Parameters<typeof service.search>[0]) => service.search(input),
        history: (input: Parameters<typeof service.history>[0]) => service.history(input),
        related: (input: Parameters<typeof service.related>[0]) => service.related(input),
        operatorView: (input: Parameters<typeof service.operatorView>[0]) => service.operatorView(input),
        remember: async (input: Parameters<typeof service.remember>[0]) => {
          const copy = await service.remember(input);
          await service.correct({
            actor: { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" },
            recordId: original.recordId,
            body: "After",
          });
          return copy;
        },
      },
    };
    const refused = await memoryCommand(racing, { action: "move", recordId: original.recordId, to: "chat:t1" });
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    const notes = result<MemoryListAnswer>(await memoryCommand(deps, { action: "list", scopes: ["chat:t1"] }));
    expect(notes.records).toEqual([]);
    expect(result<{ record: MemoryItem }>(await memoryCommand(deps, { action: "get", recordId: original.recordId })).record.body).toBe(
      "After",
    );
  });
});

describe("a chat's reminders on a live owner", () => {
  it("creates a reminder from a chat and lists it by that chat", async () => {
    const { handle, client } = await owner();
    await chat(handle, "t1");
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const created = await client.request(
      "reminders",
      { action: "create", text: "Check the audit", when: { kind: "once", at }, originTaskId: "t1" },
      "create",
    );
    expect(created).toMatchObject({ ok: true, result: { reminder: { originTaskId: "t1" } } });
    await client.request("reminders", { action: "create", text: "Elsewhere", when: { kind: "once", at } }, "create-2");
    const listed = result<{ reminders: { text: string }[] }>(
      await client.request("reminders", { action: "list", originTaskId: "t1" }, "list"),
    );
    expect(listed.reminders.map((reminder) => reminder.text)).toEqual(["Check the audit"]);
    expect(
      await client.request("reminders", { action: "create", text: "x", when: { kind: "once", at }, originTaskId: "nope" }, "nf"),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    // A delegated task's reminders are its chat's, as the agent's own tool files them.
    await chat(handle, "w1");
    await handle.runtime.store.asPort().repositories.agentDelegations.recordSpawn({
      operationKey: "op-w1",
      workspaceId: "default",
      principalId: "operator",
      workerTaskId: "w1",
      workerAgentId: "agent-1",
      parentTaskId: "t1",
      rootTaskId: "t1",
      createdAt: nowTimestamp(),
      depth: 1,
    });
    expect(
      await client.request(
        "reminders",
        { action: "create", text: "From the worker", when: { kind: "once", at }, originTaskId: "w1" },
        "worker",
      ),
    ).toMatchObject({ ok: true, result: { reminder: { originTaskId: "t1" } } });
    const fromWorker = result<{ reminders: { text: string }[] }>(
      await client.request("reminders", { action: "list", originTaskId: "w1" }, "list-worker"),
    );
    expect(fromWorker.reminders.map((reminder) => reminder.text).sort()).toEqual(["Check the audit", "From the worker"]);
  });
});

describe("a chat's memory from tavi memory", () => {
  it("parses move and the chat filters, and refuses what cannot go together", () => {
    expect(parseArgs(["memory", "move", "mem-1", "--scope", "chat:t1"])).toMatchObject({
      command: "memory",
      memory: { action: "move", recordId: "mem-1", scope: "chat:t1" },
    });
    expect(parseArgs(["memory", "list", "--origin-task", "t1", "--used-in", "t2"])).toMatchObject({
      memory: { originTaskId: "t1", usedInTaskId: "t2" },
    });
    expect(parseArgs(["memory", "list", "--chat-notes"])).toMatchObject({ memory: { chatNotes: true } });
    expect(() => parseArgs(["memory", "move", "mem-1"])).toThrow(/needs --scope/);
    expect(() => parseArgs(["memory", "move", "mem-1", "--scope", "shared"])).toThrow(/cannot write shared memory/);
    expect(() => parseArgs(["memory", "list", "--chat-notes", "--scope", "personal"])).toThrow(UsageError);
    expect(() => parseArgs(["memory", "proposals", "--chat-notes"])).toThrow(/does not accept --chat-notes/);
    expect(() => parseArgs(["memory", "list", "--used-in", "t1", "--offset", "5"])).toThrow(/takes no --offset/);
  });

  it("remembers a chat note, lists it by its chat and among every chat's, moves it to every chat, and lists what the chat taught", async () => {
    const { handle } = await owner();
    await chat(handle, "t1");
    const directory = handle.runtime.dataDirectory;
    const run = async (...argv: string[]) => {
      let out = "";
      let err = "";
      const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (err += text), isTty: false };
      const code = await main(["memory", ...argv, "--data-dir", directory], { io });
      return { code, out, err };
    };
    const remembered = await run("remember", "--body", "The client is Acme", "--scope", "chat:t1");
    expect(remembered.code, remembered.err).toBe(EXIT.ok);
    const note = JSON.parse(remembered.out) as MemoryItem;
    expect(note.target).toBe("chat:t1");
    expect(
      (JSON.parse((await run("list", "--scope", "chat:t1", "--format", "json")).out) as MemoryItem[]).map((row) => row.recordId),
    ).toEqual([note.recordId]);
    expect((JSON.parse((await run("list", "--chat-notes", "--format", "json")).out) as MemoryItem[]).map((row) => row.recordId)).toEqual([
      note.recordId,
    ]);
    const moved = await run("move", note.recordId, "--scope", "personal");
    expect(moved.code, moved.err).toBe(EXIT.ok);
    const everywhere = JSON.parse(moved.out) as MemoryItem;
    expect(everywhere).toMatchObject({ target: "personal", originTaskId: "t1" });
    expect(
      (JSON.parse((await run("list", "--origin-task", "t1", "--format", "json")).out) as MemoryItem[]).map((row) => row.recordId),
    ).toEqual([everywhere.recordId]);
    expect((await run("list", "--used-in", "t1")).out).toBe("(no records)\n");
  });

  it("says a chat's memory needs a running owner when none is", async () => {
    const directory = directories.create("tavi-chat-memory-offline-");
    let err = "";
    const io: CliIo = { stdout: () => undefined, stderr: (text) => void (err += text), isTty: false };
    expect(await main(["memory", "move", "mem-1", "--scope", "personal", "--data-dir", directory], { io })).toBe(EXIT.usage);
    expect(err).toContain("`tavi memory move` needs a running owner");
    err = "";
    expect(await main(["memory", "remember", "--body", "x", "--scope", "chat:t1", "--data-dir", directory], { io })).toBe(EXIT.usage);
    expect(err).toContain("`--scope chat:t1` needs a running owner");
  });
});
