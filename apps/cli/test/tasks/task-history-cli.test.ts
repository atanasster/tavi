import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { nowTimestamp } from "@tavi/contracts/util";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { chatContextCommand } from "../../src/features/tasks/history-owner.js";
import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `tavi tasks history`: a chat's saved history,
 * exported as Markdown or erased before a time, through a running owner.
 */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

/** An owner on a fresh data directory with one chat, `t1`. */
async function owner(): Promise<{ readonly directory: string; readonly handle: ServeHandle }> {
  const directory = directories.create("tavi-task-history-");
  const handle = await serve(
    fixtureServeOptions(directory),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  await handle.runtime.store.asPort().repositories.tasks.admit({
    prompt: fixturePromptPolicy,
    workspaceId: "default",
    principalId: "operator",
    operationKey: "op-t1",
    kind: "start",
    intent: { prompt: "hi" },
    checkpointNamespace: "",
    newTaskId: "t1",
    newAdmissionId: "adm-t1",
    newThreadId: "thread-t1",
    now: nowTimestamp(),
  });
  return { directory, handle };
}

const run = async (directory: string, ...argv: string[]) => {
  const captured = capture();
  const code = await main(["tasks", "history", ...argv, "--data-dir", directory], { io: captured.io });
  return { code, out: captured.out(), err: captured.err() };
};

describe("tavi tasks history", () => {
  it("parses export by default, and forget only with a time", () => {
    expect(parseArgs(["tasks", "history", "t1"])).toMatchObject({
      command: "tasks",
      taskHistory: { action: "export", taskId: "t1", workspaceId: "default" },
    });
    expect(parseArgs(["tasks", "history", "t1", "forget", "--before", "2026-10-01T00:00:00Z"])).toMatchObject({
      taskHistory: { action: "forget", before: "2026-10-01T00:00:00.000Z" },
    });
    expect(() => parseArgs(["tasks", "history", "t1", "forget"])).toThrow(/needs --before/);
    expect(() => parseArgs(["tasks", "history", "t1", "export", "--before", "2026-10-01T00:00:00Z"])).toThrow(UsageError);
    expect(parseArgs(["tasks", "history", "t1", "forget", "--epoch", "3"])).toMatchObject({ taskHistory: { action: "forget", epoch: 3 } });
    expect(() => parseArgs(["tasks", "history", "t1", "forget", "--epoch", "0"])).toThrow(/positive whole number/);
    expect(() => parseArgs(["tasks", "history", "t1", "forget", "--epoch", "2", "--before", "2026-10-01T00:00:00Z"])).toThrow(/not both/);
    expect(() => parseArgs(["tasks", "history", "t1", "export", "--epoch", "2"])).toThrow(UsageError);
    expect(parseArgs(["tasks", "history", "t1", "rewind", "--turn", "4"])).toMatchObject({
      taskHistory: { action: "rewind", taskId: "t1", turn: 4 },
    });
    expect(() => parseArgs(["tasks", "history", "t1", "rewind"])).toThrow(/needs --turn/);
    expect(() => parseArgs(["tasks", "history", "t1", "rewind", "--turn", "0"])).toThrow(/positive whole number/);
    expect(() => parseArgs(["tasks", "history", "t1", "export", "--turn", "2"])).toThrow(/rewind only/);
    expect(() => parseArgs(["tasks", "history", "t1", "rewind", "--turn", "2", "--before", "2026-10-01T00:00:00Z"])).toThrow(/forget only/);
    expect(parseArgs(["tasks", "history", "t1", "forget", "--epoch", "2", "--with-memory"])).toMatchObject({
      taskHistory: { action: "forget", epoch: 2, withMemory: true },
    });
    expect(parseArgs(["tasks", "history", "t1", "forget", "--epoch", "2"]).taskHistory?.withMemory).toBeUndefined();
    expect(() => parseArgs(["tasks", "history", "t1", "export", "--with-memory"])).toThrow(/forget only/);
  });

  it("rewinds a chat to before a turn through the owner, and on the data directory when none runs", async () => {
    const { directory, handle } = await owner();
    const { tasks, transcripts } = handle.runtime.store.asPort().repositories;
    await tasks.commitAdmission({
      admissionId: "adm-t1",
      taskId: "t1",
      state: "committed",
      result: { status: "completed", finalText: "hello" },
    });
    await transcripts.append({
      taskId: "t1",
      admissionId: "adm-t1",
      turn: { admissionKind: "start", prompt: "hi", items: [], outcome: { status: "completed" } },
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    for (const [index, prompt] of ["second", "third"].entries()) {
      const admissionId = `adm-${prompt}`;
      await tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "operator",
        operationKey: `op-${prompt}`,
        kind: "reply",
        taskId: "t1",
        intent: { prompt },
        checkpointNamespace: "",
        newTaskId: "t1",
        newAdmissionId: admissionId,
        newThreadId: "thread-t1",
        now: nowTimestamp(),
      });
      await tasks.commitAdmission({
        admissionId,
        taskId: "t1",
        state: "committed",
        result: { status: "completed", finalText: `${prompt} answer` },
      });
      await transcripts.append({
        taskId: "t1",
        admissionId,
        turn: { admissionKind: "reply", prompt, items: [], outcome: { status: "completed" } },
        createdAt: `2026-10-0${index + 2}T00:00:00.000Z`,
      });
    }
    const missing = await run(directory, "t1", "rewind", "--turn", "9");
    expect(missing.code).not.toBe(EXIT.ok);
    expect(missing.err).toContain("has no turn 9");
    const rewound = await run(directory, "t1", "rewind", "--turn", "3");
    expect(rewound.code, rewound.err).toBe(EXIT.ok);
    expect(rewound.out).toContain("took back 1 saved turn.");
    // Rewind never touches the chat's folder, and says so.
    expect(rewound.out).toContain("Files in the chat's folder were not changed.\n");
    expect(rewound.out).toContain("Turn 3's message, to send again:\nthird");
    expect((await transcripts.page("t1", { limit: 10 })).entries.map((entry) => entry.turn.prompt)).toEqual(["hi", "second"]);

    await handle.shutdown("test: offline next");
    handles.splice(handles.indexOf(handle), 1);
    const offline = await run(directory, "t1", "rewind", "--turn", "2");
    expect(offline.code, offline.err).toBe(EXIT.ok);
    expect(offline.out).toContain("Files in the chat's folder were not changed.\n");
    expect(offline.out).toContain("Turn 2's message, to send again:\nsecond");
    const exported = await run(directory, "t1");
    expect(exported.out).toContain("> hi");
    expect(exported.out).not.toContain("> second");
  });

  it("forgets what came before an epoch began, names the chats begun from it, and lets go of the owner's stream", async () => {
    const { directory, handle } = await owner();
    const { tasks, transcripts } = handle.runtime.store.asPort().repositories;
    await transcripts.append({
      taskId: "t1",
      admissionId: "adm-t1",
      turn: { admissionKind: "start", prompt: "hi", items: [], outcome: { status: "completed" } },
      createdAt: "2026-09-30T00:00:00.000Z",
    });
    await transcripts.postNotice({
      noticeId: "n-epoch",
      taskId: "t1",
      kind: "epoch",
      sourceKey: "epoch:1",
      title: "Epoch 1 began",
      summary: "",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await transcripts.append({
      taskId: "t1",
      admissionId: "adm-2",
      turn: { admissionKind: "reply", prompt: "later", items: [], outcome: { status: "completed" } },
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-side",
      kind: "start",
      intent: { prompt: "aside" },
      checkpointNamespace: "",
      chatKind: "side",
      parentChatId: "t1",
      newTaskId: "side-1",
      newAdmissionId: "adm-side",
      newThreadId: "thread-side",
      now: "2026-09-30T12:00:00.000Z",
    });
    const bus = handle.runtime.runEventBus;
    bus.publish("t1", {
      kind: "text.delta",
      runId: "t1",
      attemptId: "a1",
      blockId: "b1",
      text: "said before",
      at: "2026-09-30T00:00:01.000Z",
    });
    bus.publish("t1", {
      kind: "text.delta",
      runId: "t1",
      attemptId: "a2",
      blockId: "b1",
      text: "said after",
      at: "2026-10-02T00:00:01.000Z",
    });
    const unknown = await run(directory, "t1", "forget", "--epoch", "7");
    expect(unknown.code).not.toBe(EXIT.ok);
    expect(unknown.err).toContain("no epoch 7");
    const forgot = await run(directory, "t1", "forget", "--epoch", "1");
    expect(forgot.code, forgot.err).toBe(EXIT.ok);
    expect(forgot.out).toContain("Erased 1 saved turn from before 2026-10-01T00:00:00.000Z (epoch 1 began)");
    expect(forgot.out).toContain("side-1\tside chat");
    // Nothing was pruned, so nothing is said of checkpoints.
    expect(forgot.out).not.toContain("checkpoint");
    const replayed = bus.subscribe({ taskId: "t1", from: "beginning", deliver: () => {} }).replayed;
    expect(replayed.map((event) => (event as { text?: string }).text)).toEqual(["said after"]);
  });

  it("exports oldest first with the notices between the turns, the steers marked, and the epoch summary first", async () => {
    const { handle } = await owner();
    const repositories = handle.runtime.store.asPort().repositories;
    await repositories.transcripts.append({
      taskId: "t1",
      admissionId: "adm-t1",
      turn: { admissionKind: "start", prompt: "first", items: [{ kind: "steer", text: "and quickly" }], outcome: { status: "completed" } },
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await repositories.transcripts.postNotice({
      noticeId: "n1",
      taskId: "t1",
      kind: "reminder",
      sourceKey: "r1",
      title: "Water the plants",
      summary: "",
      createdAt: "2026-10-01T00:00:01.000Z",
    });
    await repositories.transcripts.append({
      taskId: "t1",
      admissionId: "adm-2",
      turn: {
        admissionKind: "reply",
        prompt: "second",
        items: [],
        outcome: { status: "failed", errorCode: "CANCELLED", message: "Task was cancelled by ipc: no longer needed" },
      },
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    const deps = {
      repositories,
      author: "operator:cli",
      principalOf: () => "operator",
      now: () => "2026-10-05T00:00:00.000Z",
      epochSummary: async () => "We planned the garden.",
    };
    const answer = await chatContextCommand(deps, { action: "export", workspaceId: "default", taskId: "t1" });
    if (!answer.ok) throw new Error(answer.error.message);
    const page = answer.result as { markdown: string; epochSummary?: string; turns: number; nextAfter?: number };
    expect(page.epochSummary).toBe("We planned the garden.");
    expect(page.turns).toBe(2);
    expect(page.nextAfter).toBeUndefined();
    const at = (text: string) => page.markdown.indexOf(text);
    expect(at("> first")).toBeLessThan(at("**Steered:**"));
    expect(at("**Steered:**")).toBeLessThan(at("Water the plants"));
    expect(at("Water the plants")).toBeLessThan(at("> second"));
    expect(page.markdown).toContain("*Cancelled: no longer needed*");
    // Read forward from a cursor: the next page holds only what came after it, and no epoch summary.
    const next = await chatContextCommand(deps, { action: "export", workspaceId: "default", taskId: "t1", after: 1 });
    if (!next.ok) throw new Error(next.error.message);
    expect((next.result as { markdown: string; epochSummary?: string }).epochSummary).toBeUndefined();
    expect((next.result as { markdown: string }).markdown).not.toContain("> first");
    expect((next.result as { markdown: string }).markdown).toContain("Water the plants");
  });

  it("exports the saved turns as Markdown, and erases those before a time", async () => {
    const { directory, handle } = await owner();
    const transcripts = handle.runtime.store.asPort().repositories.transcripts;
    await transcripts.append({
      taskId: "t1",
      admissionId: "adm-t1",
      turn: {
        admissionKind: "start",
        prompt: "hi",
        items: [
          { kind: "text", text: "Hello there." },
          { kind: "tool", callId: "c1", toolName: "web_search", status: "completed" },
        ],
        outcome: { status: "completed", finalText: "Hello there." },
      },
      createdAt: "2026-09-30T00:00:00.000Z",
    });
    await transcripts.append({
      taskId: "t1",
      admissionId: "adm-t2",
      turn: {
        admissionKind: "reply",
        prompt: "and now?",
        items: [{ kind: "text", text: "Still here." }],
        outcome: { status: "completed", finalText: "Still here." },
      },
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    const exported = await run(directory, "t1");
    expect(exported.code, exported.err).toBe(EXIT.ok);
    expect(exported.out).toContain("> hi");
    expect(exported.out).toContain("Hello there.");
    expect(exported.out).toContain("- `web_search` completed");
    expect(exported.out.indexOf("> hi")).toBeLessThan(exported.out.indexOf("> and now?"));
    // A worker's result sent before then, never read, and one after.
    const mailbox = handle.runtime.store.asPort().repositories.agentMailbox;
    for (const [messageId, createdAt] of [
      ["result-old", "2026-09-30T00:00:00.000Z"],
      ["result-new", "2026-10-02T00:00:00.000Z"],
    ] as const) {
      await mailbox.insertEnvelope({
        messageId,
        protocolVersion: 1,
        workspaceId: "default",
        senderAgentId: "agent-w",
        senderTaskId: "t1",
        recipientAgentId: "t1",
        recipientTaskId: "t1",
        kind: "result",
        createdAt,
        deliveryState: "pending",
        retentionState: "active",
        content: "the answer",
      });
    }
    // The chat's folder holds a file forget leaves alone: it is named, with its size and how to clear it.
    const folder = join(directory, "chats", "default", "t1");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "notes.md"), "kept notes");
    const forgot = await run(directory, "t1", "forget", "--before", "2026-10-01T00:00:00Z");
    expect(forgot.code, forgot.err).toBe(EXIT.ok);
    expect(forgot.out).toContain("Erased 1 saved turn from before 2026-10-01T00:00:00.000Z");
    expect(forgot.out).toMatch(
      /The chat's folder was not touched: \S*\/chats\/default\/t1 \(10 B\); clear it with `tavi tasks folders prune --chat t1` \(with the owner stopped\)\.\n/,
    );
    expect(readFileSync(join(folder, "notes.md"), "utf8")).toBe("kept notes");
    // What came before is not read into a later turn; what came after still is.
    expect((await mailbox.listPending("t1", 10)).map((envelope) => envelope.messageId)).toEqual(["result-new"]);
    const after = await run(directory, "t1");
    expect(after.out).not.toContain("Hello there.");
    expect(after.out).toContain("Still here.");
    // With no owner running, forget names the folder the same way.
    await handle.shutdown("test: offline next");
    handles.splice(handles.indexOf(handle), 1);
    const offline = await run(directory, "t1", "forget", "--before", "2026-10-03T00:00:00Z");
    expect(offline.code, offline.err).toBe(EXIT.ok);
    expect(offline.out).toContain("Erased 1 saved turn");
    // The chat's memory is the owner's to forget: offline it says so, and refuses --with-memory.
    expect(offline.out).toContain("Its memory proposals were not checked offline");
    const withMemory = await run(directory, "t1", "forget", "--before", "2026-10-03T00:00:00Z", "--with-memory");
    expect(withMemory.code).toBe(EXIT.usage);
    expect(withMemory.err).toContain("`--with-memory` needs a running owner");
    expect(offline.out).toMatch(
      /The chat's folder was not touched: \S*\/chats\/default\/t1 \(10 B\); clear it with `tavi tasks folders prune --chat t1`/,
    );
  });

  it("forgets the proposals the chat made with its history, and the memories it taught with --with-memory", async () => {
    const { directory, handle } = await owner();
    const operator = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" } as const;
    const personal = { kind: "personal", principalId: "operator" } as const;
    await handle.runtime.memory.propose({
      actor: { ...operator, runId: "t1", caller: "model", authority: "model" },
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
    const before = new Date(Date.now() + 1_000).toISOString();
    const forgot = await run(directory, "t1", "forget", "--before", before);
    expect(forgot.code, forgot.err).toBe(EXIT.ok);
    expect(forgot.out).toContain("Forgot 1 memory proposal it made that still waited.");
    expect(forgot.out).toContain("1 memory it taught stays; --with-memory forgets it too.");
    const withMemory = await run(directory, "t1", "forget", "--before", before, "--with-memory");
    expect(withMemory.code, withMemory.err).toBe(EXIT.ok);
    expect(withMemory.out).toContain("Forgot 1 memory it taught.");
    expect((await handle.runtime.store.asPort().repositories.memory.getRecord(taught.recordId))?.status).toBe("deleted");
  });

  it("lets go of the chat's older checkpoints when it forgets, and pages a long export", async () => {
    const { directory, handle } = await owner();
    const checkpoints = handle.runtime.store.checkpoints;
    for (let index = 0; index < 25; index += 1) {
      await checkpoints.put({
        threadId: "thread-t1",
        namespace: "",
        checkpointId: `c${String(index).padStart(3, "0")}`,
        parentId: null,
        type: "json",
        checkpoint: Buffer.from("{}"),
        metadata: Buffer.from("{}"),
      });
    }
    const transcripts = handle.runtime.store.asPort().repositories.transcripts;
    // Five turns of 100,000 characters each: more than one page of export.
    for (let index = 0; index < 5; index += 1) {
      await transcripts.append({
        taskId: "t1",
        admissionId: `adm-${index}`,
        turn: {
          admissionKind: "reply",
          prompt: `turn ${index}`,
          items: [{ kind: "text", text: "x".repeat(60_000) }],
          outcome: { status: "completed" },
        },
        createdAt: `2026-10-0${index + 1}T00:00:00.000Z`,
      });
    }
    const exported = await run(directory, "t1");
    expect(exported.code, exported.err).toBe(EXIT.ok);
    expect([0, 1, 2, 3, 4].map((index) => exported.out.indexOf(`> turn ${index}`))).toEqual(
      [...[0, 1, 2, 3, 4].map((index) => exported.out.indexOf(`> turn ${index}`))].sort((a, b) => a - b),
    );
    expect(exported.out.split("> turn ").length - 1).toBe(5);
    // A time with no milliseconds is the same instant as one with them.
    const forgot = await run(directory, "t1", "forget", "--before", "2026-10-03T00:00:00Z");
    expect(forgot.out).toContain("Erased 2 saved turns");
    expect(forgot.out).toContain("let go of 5 older checkpoints");
  });

  it("memory invariant 9: offline, deletes the chat's fold archive", async () => {
    const { directory, handle } = await owner();
    const artifacts = handle.runtime.store.asPort().repositories.artifacts;
    await artifacts.putArtifact({
      artifactId: "art-fold",
      workspaceId: "default",
      runId: "t1",
      contentType: "application/json",
      body: JSON.stringify([{ id: "m1", role: "user", text: "folded words" }]),
      extension: "json",
      fold: "summary",
    });
    await handle.runtime.store.asPort().repositories.transcripts.append({
      taskId: "t1",
      admissionId: "adm-t1",
      turn: { admissionKind: "start", prompt: "hi", items: [], outcome: { status: "completed" } },
      createdAt: "2026-09-30T00:00:00.000Z",
    });
    await handle.shutdown("test: offline next");
    handles.splice(handles.indexOf(handle), 1);
    const offline = await run(directory, "t1", "forget", "--before", new Date(Date.now() + 60_000).toISOString());
    expect(offline.code, offline.err).toBe(EXIT.ok);
    expect(offline.out).toContain("Deleted 1 archive of its earlier turns.");
  });

  it("splits an export mid-read and among trailing notices, dropping none", async () => {
    const { handle } = await owner();
    const repositories = handle.runtime.store.asPort().repositories;
    // Three turns of 100,000 characters: a page holds two.
    for (let index = 1; index <= 3; index += 1) {
      await repositories.transcripts.append({
        taskId: "t1",
        admissionId: `adm-${index}`,
        turn: {
          admissionKind: "reply",
          prompt: `turn ${index}`,
          items: [
            { kind: "text", text: "x".repeat(50_000) },
            { kind: "text", text: "x".repeat(50_000) },
          ],
          outcome: { status: "completed" },
        },
        createdAt: `2026-10-0${index}T00:00:00.000Z`,
      });
    }
    // After the newest turn, more notices than a page holds: 150 of about 2,000 characters each.
    for (let index = 0; index < 150; index += 1) {
      await repositories.transcripts.postNotice({
        noticeId: `n${index}`,
        taskId: "t1",
        kind: "reminder",
        sourceKey: `r${index}`,
        title: `Notice ${index}`,
        summary: "y".repeat(1_900),
        createdAt: "2026-10-04T00:00:00.000Z",
      });
    }
    const deps = { repositories, author: "operator:cli", principalOf: () => "operator", now: () => "2026-10-05T00:00:00.000Z" };
    const pages: { markdown: string; turns: number; nextAfter?: number; nextNoticeSkip?: number }[] = [];
    let cursor: { after?: number; noticeSkip?: number } = {};
    for (let guard = 0; guard < 20; guard += 1) {
      const answer = await chatContextCommand(deps, { action: "export", workspaceId: "default", taskId: "t1", ...cursor });
      if (!answer.ok) throw new Error(answer.error.message);
      const page = answer.result as (typeof pages)[number];
      pages.push(page);
      if (page.nextAfter === undefined) break;
      cursor = { after: page.nextAfter, ...(page.nextNoticeSkip === undefined ? {} : { noticeSkip: page.nextNoticeSkip }) };
    }
    expect(pages[0]).toMatchObject({ turns: 2, nextAfter: 2 });
    expect(pages.length).toBeGreaterThan(2);
    const all = pages.map((page) => page.markdown).join("\n");
    expect(all.split("> turn ").length - 1).toBe(3);
    for (let index = 0; index < 150; index += 1) expect(all.split(`**Notice ${index}**`).length - 1, `notice ${index}`).toBe(1);
    expect(pages.some((page) => page.nextNoticeSkip !== undefined)).toBe(true);
  });

  it("names the memory providers the removal of what it taught waits for", async () => {
    const { handle } = await owner();
    const repositories = handle.runtime.store.asPort().repositories;
    const operator = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" } as const;
    await handle.runtime.memory.remember({
      actor: operator,
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "Lives in Porto",
      originTaskId: "t1",
    });
    // A provider that could not take the removal now: the receipt names it, as the provider sync answers.
    const memory = {
      list: (input: Parameters<typeof handle.runtime.memory.list>[0]) => handle.runtime.memory.list(input),
      forget: async (input: Parameters<typeof handle.runtime.memory.forget>[0]) => ({
        ...(await handle.runtime.memory.forget(input)),
        cleanupStatus: "pending" as const,
        pendingProviders: ["acme.index"],
      }),
    };
    const deps = { repositories, memory, author: "operator:cli", principalOf: () => "operator", now: () => nowTimestamp() };
    const answer = await chatContextCommand(deps, {
      action: "forget",
      workspaceId: "default",
      taskId: "t1",
      before: new Date(Date.now() + 60_000).toISOString(),
      withMemory: true,
    });
    if (!answer.ok) throw new Error(answer.error.message);
    expect(answer.result).toMatchObject({ memories: 1, memoryWaitsFor: ["acme.index"] });
  });

  it("lets go of older checkpoints for a chat with records but no saved turns", async () => {
    const { handle } = await owner();
    const repositories = handle.runtime.store.asPort().repositories;
    await repositories.tasks.commitAdmission({
      admissionId: "adm-t1",
      taskId: "t1",
      state: "committed",
      result: { status: "completed", finalText: "an answer from before saved turns" },
    });
    const pruned: string[] = [];
    const deps = {
      repositories,
      author: "operator:cli",
      principalOf: () => "operator",
      now: () => "2026-10-05T00:00:00.000Z",
      pruneCheckpoints: async (threadId: string) => (pruned.push(threadId), 3),
    };
    const answer = await chatContextCommand(deps, {
      action: "forget",
      workspaceId: "default",
      taskId: "t1",
      before: new Date(Date.now() + 60_000).toISOString(),
    });
    if (!answer.ok) throw new Error(answer.error.message);
    expect(answer.result).toMatchObject({ forgotten: 0, checkpointsPruned: 3 });
    expect(pruned).toEqual(["thread-t1"]);
    // Nothing left to erase: nothing pruned, and none reported.
    const again = await chatContextCommand(deps, {
      action: "forget",
      workspaceId: "default",
      taskId: "t1",
      before: new Date(Date.now() + 60_000).toISOString(),
    });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.result).toMatchObject({ forgotten: 0, checkpointsPruned: 0 });
  });

  it("rewinds a still chat to before a turn, lets go of the owner's stream, and refuses one waiting on an answer", async () => {
    const { handle } = await owner();
    const repositories = handle.runtime.store.asPort().repositories;
    const { tasks, transcripts } = repositories;
    await tasks.commitAdmission({
      admissionId: "adm-t1",
      taskId: "t1",
      state: "committed",
      result: { status: "completed", finalText: "hello" },
    });
    await transcripts.append({
      taskId: "t1",
      admissionId: "adm-t1",
      turn: { admissionKind: "start", prompt: "hi", items: [], outcome: { status: "completed", finalText: "hello" } },
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-2",
      kind: "reply",
      taskId: "t1",
      intent: { prompt: "later" },
      checkpointNamespace: "",
      newTaskId: "t1",
      newAdmissionId: "adm-2",
      newThreadId: "thread-t1",
      now: nowTimestamp(),
    });
    await tasks.commitAdmission({
      admissionId: "adm-2",
      taskId: "t1",
      state: "committed",
      result: { status: "completed", finalText: "later answer" },
    });
    await transcripts.append({
      taskId: "t1",
      admissionId: "adm-2",
      turn: { admissionKind: "reply", prompt: "later", items: [], outcome: { status: "completed", finalText: "later answer" } },
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    const bus = handle.runtime.runEventBus;
    bus.publish("t1", {
      kind: "text.delta",
      runId: "t1",
      attemptId: "a2",
      blockId: "b1",
      text: "later answer",
      at: "2026-10-02T00:00:01.000Z",
    });
    const deps = {
      repositories,
      author: "operator:ui",
      principalOf: () => "operator",
      now: () => "2026-10-05T00:00:00.000Z",
      dropRetainedEvents: (taskId: string, before?: string) => void bus.dropRetained(taskId, before),
    };

    const changed = await chatContextCommand(deps, {
      action: "rewind",
      workspaceId: "default",
      taskId: "t1",
      seq: 2,
      prompt: "something else",
    });
    expect(changed).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const answer = await chatContextCommand(deps, { action: "rewind", workspaceId: "default", taskId: "t1", seq: 2, prompt: "later" });
    if (!answer.ok) throw new Error(answer.error.message);
    expect(answer.result).toEqual({ taskId: "t1", seq: 2, rewound: 1, prompt: "later" });
    expect((await transcripts.page("t1", { limit: 10 })).entries.map((entry) => entry.turn.prompt)).toEqual(["hi"]);
    expect(await transcripts.rewindMarker("t1")).toEqual(["adm-2"]);
    expect(bus.subscribe({ taskId: "t1", from: "beginning", deliver: () => {} }).replayed).toEqual([]);

    // A chat whose last turn waits on an answer is answered (or stopped) first: nothing is taken back.
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-3",
      kind: "reply",
      taskId: "t1",
      intent: { prompt: "ask me" },
      checkpointNamespace: "",
      newTaskId: "t1",
      newAdmissionId: "adm-3",
      newThreadId: "thread-t1",
      now: nowTimestamp(),
    });
    await tasks.commitAdmission({ admissionId: "adm-3", taskId: "t1", state: "committed", result: { status: "waiting", finalText: "" } });
    await transcripts.append({
      taskId: "t1",
      admissionId: "adm-3",
      turn: { admissionKind: "reply", prompt: "ask me", items: [], outcome: { status: "waiting" } },
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    const waiting = await chatContextCommand(deps, { action: "rewind", workspaceId: "default", taskId: "t1", seq: 1, prompt: "hi" });
    expect(waiting).toMatchObject({ ok: false, error: { code: "CONFLICT", message: expect.stringContaining("waits on an answer") } });
    expect((await transcripts.page("t1", { limit: 10 })).entries.map((entry) => entry.turn.prompt)).toEqual(["hi", "ask me"]);
  });

  it("exports no folder record: a chat's host folders and the paths its tools touched are not in it", async () => {
    const { directory, handle } = await owner();
    const { taskFolders, transcripts } = handle.runtime.store.asPort().repositories;
    const host = join(directory, "..", "acme-site-private");
    await taskFolders.write({
      taskId: "t1",
      workspaceId: "default",
      primaryKind: "host",
      primaryPath: host,
      attachments: [{ path: `${host}-data`, mode: "ro", label: "acme-data" }],
      expectedRevision: 0,
      now: "2026-10-10T00:00:00.000Z",
    });
    await transcripts.append({
      taskId: "t1",
      admissionId: "adm-t1",
      turn: {
        admissionKind: "start",
        prompt: "tidy the site",
        items: [
          {
            kind: "tool",
            callId: "c1",
            toolName: "fs.write",
            status: "failed",
            errorCode: "PERMISSION_DENIED",
            message: `${host}/index.html is read-only`,
          },
          { kind: "text", text: "Done." },
        ],
        outcome: { status: "completed" },
      },
      createdAt: "2026-10-10T00:00:01.000Z",
    });
    const exported = await run(directory, "t1");
    expect(exported.code, exported.err).toBe(EXIT.ok);
    expect(exported.out).toContain("- `fs.write` failed (PERMISSION_DENIED)");
    expect(exported.out).not.toContain("acme-site-private");
    expect(exported.out).not.toContain("acme-data");
  });

  it("works on the data directory when no owner runs", async () => {
    const { directory, handle } = await owner();
    await handle.runtime.store.asPort().repositories.transcripts.append({
      taskId: "t1",
      admissionId: "adm-1",
      turn: { admissionKind: "start", prompt: "offline?", items: [], outcome: { status: "completed" } },
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await handle.shutdown("test: offline next");
    handles.splice(handles.indexOf(handle), 1);
    const exported = await run(directory, "t1");
    expect(exported.code, exported.err).toBe(EXIT.ok);
    expect(exported.out).toContain("> offline?");
  });
});
