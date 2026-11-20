import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  CLIENT_PROTOCOL_VERSION,
  ClientEventSchema,
  homeConversationId,
  protocolMismatchError,
  unreadableFrameError,
  type ClientEvent,
  type ModelOutcome,
  type ModelPort,
} from "@tavi/contracts";
import { CLIENT_TIMEOUT } from "@tavi/client/node";
import { STEP_FACTS_HEADING } from "@tavi/agent-host/system-prompt";
import { temporaryDirectories, waitFor, delay } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { render } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, describe, expect, it } from "vitest";

import { ChatApp, RESERVED_ROWS } from "../../src/tui/app.js";
import { chatInkOptions, runChat, type ChatStats } from "../../src/tui/index.js";
import { ChatStore, MAX_LIVE_ROWS } from "../../src/tui/store.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import { EXIT, main } from "../../src/main.js";
import type { ServeHandle } from "../../src/server/serve.js";
import { ATTACHED, capture, turns, useAttachedOwners } from "../support/attached-owner.js";
import { ScriptedClient, subscription } from "../support/fake-client.js";
import { BACKSPACE, CLEAR_SCROLLBACK, CTRL_C, fakeTty } from "../support/fake-tty.js";

/**
 * `tavi chat`: the TUI in a terminal of a fixed size,
 * over a recorded stream and over a live owner.
 */

const owners = useAttachedOwners("tavi-chat-");
const scratch = temporaryDirectories();

afterEach(() => scratch.cleanup());

const CODES = { ok: EXIT.ok, usage: EXIT.usage, unavailable: EXIT.unavailable, detached: EXIT.detached };

function tempFile(name: string, content = ""): string {
  const directory = scratch.create("tavi-chat-file-");
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

const AT = "2026-09-19T00:00:00.000Z";
const BASE = { protocolVersion: CLIENT_PROTOCOL_VERSION, epoch: "epoch-0", runId: "task-1", at: AT };

/**
 * A recorded run of `deltas` text deltas, a newline every `lineEvery`, then its
 * end. The release gate builds the same stream as text (`tests/support/chat-recording.ts`).
 */
function recordedEvents(deltas: number, lineEvery = 40): ClientEvent[] {
  const events: ClientEvent[] = [
    ClientEventSchema.parse({
      ...BASE,
      sequence: 0,
      attemptId: "attempt-0",
      kind: "run.started",
      threadId: "thread-1",
      workspaceId: "default",
    }),
  ];
  for (let index = 1; index <= deltas; index += 1) {
    const text = index % lineEvery === 0 ? `w${index}\n` : `w${index} `;
    events.push(ClientEventSchema.parse({ ...BASE, sequence: index, attemptId: "attempt-1", kind: "text.delta", blockId: "b", text }));
  }
  events.push(ClientEventSchema.parse({ ...BASE, sequence: deltas + 1, attemptId: "attempt-1", kind: "task.completed", finalText: "…" }));
  return events;
}
const recording = (deltas: number, lineEvery = 40): string =>
  recordedEvents(deltas, lineEvery)
    .map((event) => JSON.stringify(event))
    .join("\n") + "\n";

const stderrOf = (errors: string[]) => (text: string) => {
  errors.push(text);
};

describe("tavi chat, replaying a recorded stream", () => {
  it("renders 10,000 deltas in a few frames, never clearing the terminal's scrollback", async () => {
    const tty = fakeTty({ rows: 20, columns: 60 });
    const stats = tempFile("stats.json");
    const code = await runChat(
      {
        replay: tempFile("run.ndjson", recording(10_000)),
        stats,
        workspaceId: "default",
        principalId: "operator",
        dataDirectory: "/unused",
      },
      { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined },
      CODES,
    );
    expect(code).toBe(EXIT.ok);
    const recorded = JSON.parse(readFileSync(stats, "utf8")) as ChatStats;
    expect(recorded.deltas).toBe(10_000);
    expect(recorded.events).toBe(10_002);
    // Deltas are buffered above the tree: frames, not events, drive rendering.
    // A replay plays 250 events a frame, so the stream is drawn as it plays.
    expect(recorded.treeUpdates).toBeGreaterThan(10);
    expect(recorded.treeUpdates).toBeLessThan(500);
    expect(recorded.renders).toBeGreaterThan(0);
    expect(recorded.renders).toBeLessThan(500);
    expect(recorded.peakRssBytes).toBeGreaterThan(0);
    // Every line reached the scrollback: 250 whole ones, the last one ending the run.
    expect(recorded.committedLines).toBe(10_000 / 40);
    const output = tty.output();
    expect(output).not.toContain(CLEAR_SCROLLBACK);
    expect(output).toContain("w9960");
    expect(output).toContain("w10000");
    expect(output).toContain("✓ Done.");
  });

  it("keeps an unterminated paragraph within the live budget, and commits it when the run ends", async () => {
    const tty = fakeTty({ rows: 12, columns: 40 });
    const stats = tempFile("stats.json");
    // No newline at all: the whole stream is one line being written.
    const code = await runChat(
      {
        replay: tempFile("run.ndjson", recording(3_000, 1_000_000)),
        stats,
        workspaceId: "default",
        principalId: "operator",
        dataDirectory: "/unused",
      },
      { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined },
      CODES,
    );
    expect(code).toBe(EXIT.ok);
    expect(tty.output()).not.toContain(CLEAR_SCROLLBACK);
    expect(tty.output()).toContain("w3000");
    expect((JSON.parse(readFileSync(stats, "utf8")) as ChatStats).committedLines).toBe(1);
  });

  it("refuses what is not one task's recorded stream, and a missing terminal", async () => {
    const tty = fakeTty({ rows: 20, columns: 60 });
    const errors: string[] = [];
    const replay = (path: string) =>
      runChat(
        { replay: path, workspaceId: "default", principalId: "operator", dataDirectory: "/unused" },
        { stdout: tty.stdout, stdin: tty.stdin, stderr: stderrOf(errors) },
        CODES,
      );
    expect(await replay(tempFile("bad.ndjson", '{"kind":"nope"}\n'))).toBe(EXIT.usage);
    expect(errors.join("")).toContain("bad.ndjson:1 is not a client event");
    expect(await replay(tempFile("torn.ndjson", '{"kind":\n'))).toBe(EXIT.usage);
    expect(errors.join("")).toContain("torn.ndjson:1 is not JSON");
    // Two runs' events interleaved: refused before anything is drawn.
    const events = recordedEvents(3);
    const shuffled = [events[0], events[2], events[1], events[3], events[4]].map((event) => JSON.stringify(event)).join("\n");
    expect(await replay(tempFile("shuffled.ndjson", shuffled))).toBe(EXIT.usage);
    expect(errors.join("")).toContain("shuffled.ndjson:2 is not one task's stream in order");
    expect(await replay(join(tmpdir(), "tavi-chat-no-such-dir", "run.ndjson"))).toBe(EXIT.usage);
    expect(errors.join("")).toContain("ENOENT");
    expect(tty.output()).toBe("");

    const piped = fakeTty({ rows: 20, columns: 60 });
    Object.assign(piped.stdout, { isTTY: false });
    expect(
      await runChat(
        { workspaceId: "default", principalId: "operator", dataDirectory: "/unused" },
        { stdout: piped.stdout, stdin: piped.stdin, stderr: stderrOf(errors) },
        CODES,
      ),
    ).toBe(EXIT.usage);
    expect(errors.join("")).toContain("tavi chat needs a terminal");
  });

  it("plays only what it checked: a line added while it plays is not played, and a line changed ends it with 2", async () => {
    const replayWhile = async (change: (path: string) => void): Promise<{ code: number; errors: string; stats: ChatStats }> => {
      const tty = fakeTty({ rows: 20, columns: 60 });
      const path = tempFile("growing.ndjson", recording(5_000));
      const stats = tempFile("stats.json");
      const errors: string[] = [];
      const done = runChat(
        { replay: path, stats, workspaceId: "default", principalId: "operator", dataDirectory: "/unused" },
        { stdout: tty.stdout, stdin: tty.stdin, stderr: stderrOf(errors) },
        CODES,
      );
      // Drawing has begun: the recording was checked, and is playing.
      await waitFor(() => tty.output().includes("w40"));
      change(path);
      const code = await done;
      return { code, errors: errors.join(""), stats: JSON.parse(readFileSync(stats, "utf8")) as ChatStats };
    };

    // As `tavi run --format json > file` still writing it would: never played.
    const grown = await replayWhile((path) => appendFileSync(path, '{"kind":\n'));
    expect(grown.code).toBe(EXIT.ok);
    expect(grown.stats.events).toBe(5_002);

    // Rewritten in place, past what was read: refused, and the statistics still written.
    const changed = await replayWhile((path) => {
      const size = statSync(path).size;
      writeFileSync(path, `${"{".repeat(99)}\n`.repeat(Math.ceil(size / 100)));
    });
    expect(changed.code).toBe(EXIT.usage);
    expect(changed.errors).toContain("changed while it played");
    expect(changed.errors).toContain("is not JSON");
    expect(changed.stats.events).toBeLessThan(5_002);
  });

  it("is refused by `tavi chat` itself without a terminal, before the TUI is loaded", async () => {
    const out = capture();
    expect(await main(["chat", "--data-dir", owners.tempDirectory()], { io: out.io })).toBe(EXIT.usage);
    expect(out.stderr()).toContain("tavi chat needs a terminal");
    const both = capture();
    expect(await main(["chat", "--attach", "t", "--replay", "f"], { io: both.io })).toBe(EXIT.usage);
    expect(both.stderr()).toContain("--attach and --replay cannot be combined");
    const help = capture();
    expect(await main(["--help"], { io: help.io })).toBe(EXIT.ok);
    expect(help.stdout()).toContain("tavi chat --attach <task-id> [options]");
  });
});

describe("the chat TUI in a terminal that is resized", () => {
  it("renders with the command's own options: incremental, interactive, 30 frames a second", () => {
    const tty = fakeTty({ rows: 20, columns: 60 });
    expect(chatInkOptions(tty, () => undefined)).toMatchObject({
      incrementalRendering: true,
      interactive: true,
      maxFps: 30,
      patchConsole: false,
    });
  });

  it("does clear the scrollback when shrunk below the frame already drawn — the one case the live region's bound cannot cover", async () => {
    // The positive control: the terminal these tests draw on shows Ink's
    // clear when it happens, so the tests that find none are not empty.
    const tty = fakeTty({ rows: 30, columns: 60 });
    const store = new ChatStore({
      columns: () => tty.stdout.columns,
      rows: () => tty.stdout.rows,
      reservedRows: RESERVED_ROWS,
      prompting: false,
    });
    const instance = render(
      createElement(ChatApp, { store }),
      chatInkOptions(tty, () => undefined),
    );
    try {
      store.begin();
      for (const event of recordedEvents(1_000, 1_000_000).slice(0, 1_000)) store.push(event);
      store.flush();
      await delay(60);
      expect(tty.output()).not.toContain(CLEAR_SCROLLBACK);
      tty.resize({ rows: 5, columns: 60 });
      await delay(60);
      expect(tty.output()).toContain(CLEAR_SCROLLBACK);
    } finally {
      const exited = instance.waitUntilExit();
      instance.unmount();
      await exited;
    }
  });

  it("never clears the scrollback when the terminal shrinks to the live region's cap, or changes width", async () => {
    const tty = fakeTty({ rows: 30, columns: 60 });
    const size = (): { rows: number; columns: number } => ({ rows: tty.stdout.rows, columns: tty.stdout.columns });
    const store = new ChatStore({ columns: () => size().columns, rows: () => size().rows, reservedRows: RESERVED_ROWS, prompting: false });
    const instance = render(
      createElement(ChatApp, { store }),
      chatInkOptions(tty, () => undefined),
    );
    const frame = (): Promise<void> => delay(60);
    tty.stdout.on("resize", () => store.flush());
    try {
      const events = recordedEvents(2_000, 1_000_000);
      let played = 1_000;
      store.begin();
      for (const event of events.slice(0, played)) store.push(event);
      store.flush();
      await frame();
      // The live region is full: its cap, and the status and prompt rows.
      expect(store.view().live).toHaveLength(MAX_LIVE_ROWS);
      for (const next of [
        { rows: MAX_LIVE_ROWS + RESERVED_ROWS + 1, columns: 60 },
        { rows: MAX_LIVE_ROWS + RESERVED_ROWS + 1, columns: 30 },
        { rows: 40, columns: 90 },
        { rows: MAX_LIVE_ROWS + RESERVED_ROWS + 1, columns: 20 },
      ]) {
        tty.resize(next);
        await frame();
        for (const event of events.slice(played, played + 100)) store.push(event);
        played += 100;
        store.flush();
        await frame();
      }
      for (const event of events.slice(played)) store.push(event);
      store.end();
      store.flush();
      await frame();
      expect(tty.output()).toContain("w2000");
      expect(tty.output()).not.toContain(CLEAR_SCROLLBACK);
    } finally {
      const exited = instance.waitUntilExit();
      instance.unmount();
      await exited;
    }
  });
});

describe("the chat TUI through the real renderer", () => {
  it("keeps blank lines, and draws wide characters within the terminal's width", async () => {
    const columns = 20;
    const tty = fakeTty({ rows: 20, columns });
    const store = new ChatStore({ columns: () => columns, rows: () => 20, reservedRows: RESERVED_ROWS, prompting: false });
    const instance = render(
      createElement(ChatApp, { store }),
      chatInkOptions(tty, () => undefined),
    );
    try {
      store.begin();
      store.push(
        ClientEventSchema.parse({
          ...BASE,
          sequence: 0,
          attemptId: "attempt-0",
          kind: "run.started",
          threadId: "thread-1",
          workspaceId: "default",
        }),
      );
      const text = `a\n\nb\n${"日本語のテキスト👍🏽".repeat(4)}`;
      store.push(ClientEventSchema.parse({ ...BASE, sequence: 1, attemptId: "attempt-1", kind: "text.delta", blockId: "b", text }));
      store.flush();
      await delay(80);
      const output = tty.output();
      expect(output).toContain("a\n\nb\n");
      const drawn = stripVTControlCharacters(output).split("\n");
      expect(drawn.some((row) => row.includes("日本語"))).toBe(true);
      for (const row of drawn) expect(stringWidth(row)).toBeLessThanOrEqual(columns);
    } finally {
      const exited = instance.waitUntilExit();
      instance.unmount();
      await exited;
    }
  });
});

describe("tavi chat over a scripted owner", () => {
  const options = (extra: Record<string, string> = {}) => ({
    workspaceId: "default",
    principalId: "operator",
    dataDirectory: "/scripted",
    ...extra,
  });
  const chatOver = (
    client: ScriptedClient,
    extra: Record<string, string> = {},
    deps: { readonly answerSettleMs?: number; readonly workerPollMs?: number } = {},
  ) => {
    // Wide enough that no line these tests look for wraps.
    const tty = fakeTty({ rows: 24, columns: 200 });
    const errors: string[] = [];
    const done = runChat(options(extra), { stdout: tty.stdout, stdin: tty.stdin, stderr: stderrOf(errors) }, CODES, {
      connect: () => Promise.resolve(client),
      ...deps,
    });
    return { tty, errors, done };
  };
  const event = (sequence: number, kind: string, fields: Record<string, unknown>) =>
    ClientEventSchema.parse({ ...BASE, sequence, attemptId: "attempt-1", kind, ...fields });
  /** What the chat asked the owner after its start, which reads whether the workspace has Home on. */
  // What a command asked, without the reads every chat makes at start: its settings, and the plugins' slash commands.
  const asked = (client: ScriptedClient) =>
    client.requests.filter(
      (request) =>
        request.command !== "workspace-settings" &&
        !(request.command === "plugin-commands" && (request.payload as { action?: string }).action === "list"),
    );
  /** A task's record, as `tasks { taskId }` answers it, settled on `result`. */
  const recorded = (result: unknown) => ({
    ok: true,
    result: {
      task: { status: "waiting" },
      admissions: [
        {
          admissionId: "admission-1",
          taskId: "task-1",
          operationKey: "op-1",
          kind: "start",
          state: "committed",
          result,
          createdAt: AT,
          updatedAt: AT,
        },
      ],
    },
  });

  it("says it joined late when the owner says the stream's start is gone", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: true, roundsAnsweredBy: "client" },
      events: [event(5, "text.delta", { blockId: "b", text: "the tail\n" }), event(6, "task.completed", { finalText: "…" })],
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("✓ Done."));
    const output = tty.output();
    expect(output).toContain("joined late");
    expect(output.indexOf("joined late")).toBeLessThan(output.indexOf("the tail"));
    // It settled while it replayed: the subscription is let go, not kept for a later restart to replay into.
    expect(client.closedSubscriptions).toEqual(["task-1"]);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("gives up on a run the owner does not answer twice, naming why, and quits with 0", async () => {
    const client = new ScriptedClient();
    client.runAnswers = [
      () => ({
        response: {
          ok: false,
          error: { code: "TIMEOUT", message: "the owner did not answer run; sending it again under operation key k rejoins it" },
        },
      }),
    ];
    const { tty, done } = chatOver(client);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("please reply\r");
    await waitFor(() => tty.output().includes("✗ TIMEOUT"));
    expect(client.runs).toHaveLength(2);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("says the owner came back as another version, rather than that it did not come back", async () => {
    const client = new ScriptedClient();
    const { tty, done } = chatOver(client);
    await waitFor(() => tty.output().includes("Type a prompt"));
    client.become("closed", protocolMismatchError(99));
    await waitFor(() => tty.output().includes("speaks protocol 99"));
    expect(tty.output()).not.toContain("did not come back");
    tty.type(CTRL_C);
    await done;
  });

  it("shows the round a task it holds no stream of waits on, from its record and its pending rows", async () => {
    const client = new ScriptedClient();
    client.answers = {
      tasks: () =>
        recorded({
          status: "waiting",
          interrupt: { requests: [{ toolName: "browser.create_session", callId: "call-a", summary: "", steps: 3 }] },
        }),
      approvals: () => ({
        ok: true,
        result: {
          rows: [
            {
              record: {
                approvalId: "approval-3",
                taskId: "task-1",
                callId: "call-a",
                toolId: "browser.create_session",
                steps: 3,
                createdAt: AT,
              },
              task: {},
            },
          ],
          truncated: false,
        },
      }),
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("tavi approvals approve|reject task-1"));
    expect(tty.output()).toContain("Round 3 needs approval:");
    expect(tty.output()).toContain("• browser.create_session");
    tty.type(CTRL_C);
    await done;
  });

  it("shows a review from the record with its round, and the command the owner accepts", async () => {
    const client = new ScriptedClient();
    client.answers = {
      tasks: () =>
        recorded({
          status: "waiting",
          reviewInterrupt: { requests: [{ artifactId: "artifact-1", toolName: "sandbox.run", callId: "call-r", steps: 2 }] },
        }),
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("• artifact-1 (from sandbox.run)"));
    // Its round is known, so this chat may decide it: the keys are offered.
    expect(tty.output()).toContain("y releases all of it");
    tty.type(CTRL_C);
    await done;
  });

  it("asks once more under the same key when the owner does not answer a run, and rejoins it", async () => {
    const client = new ScriptedClient();
    client.runAnswers = [
      () => ({
        response: {
          ok: false,
          error: { code: "TIMEOUT", message: "the owner did not answer run within 30000 ms; the outcome is unknown" },
        },
      }),
      (callbacks) => {
        queueMicrotask(() => {
          callbacks.onEvent(event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }));
          callbacks.onEvent(event(1, "task.completed", { finalText: "…" }));
        });
        return { response: { ok: true, result: { taskId: "task-1", subscriptionId: "sub-1" } }, subscription: subscription("task-1") };
      },
    ];
    const { tty, done } = chatOver(client);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("please reply\r");
    await waitFor(() => tty.output().includes("✓ Done."));
    expect(tty.output()).toContain("asking again under the same key");
    expect(client.runs).toHaveLength(2);
    expect(client.runs[1]?.operationKey).toBe(client.runs[0]?.operationKey);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("sends a round's decision whole, naming the round, and offers it again when the owner refuses it", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 3, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "approval.required", {
          callId: "call-a",
          toolName: "fs.write",
          summary: "Write notes.md?",
          input: {},
          steps: 4,
          approvalId: "approval-a",
          effect: "mutating",
        }),
        event(2, "approval.required", {
          callId: "call-b",
          toolName: "fs.write",
          summary: "Write todo.md?",
          input: {},
          steps: 4,
          approvalId: "approval-b",
          effect: "mutating",
        }),
      ],
    };
    client.answers = {
      approve: () => ({ ok: false, error: { code: "CONFLICT", message: "round 4 is no longer pending: the task moved on" } }),
      // The round's call set, which the keys wait for.
      approvals: () => ({
        ok: true,
        result: {
          rows: ["call-a", "call-b"].map((callId) => ({
            record: { approvalId: `approval-${callId}`, taskId: "task-1", callId, toolId: "fs.write", steps: 4, createdAt: AT },
            task: {},
          })),
          truncated: false,
        },
      }),
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("round 4: y approves it"));
    expect(tty.output()).toContain("• fs.write — Write notes.md?");
    expect(tty.output()).toContain("• fs.write — Write todo.md?");
    tty.type("y");
    await waitFor(() => tty.output().includes("✗ Round 4 was not decided here"));
    expect(client.requests.filter((request) => request.command === "approve").map((request) => request.payload)).toEqual([
      { taskId: "task-1", workspaceId: "default", expectedSteps: 4, verdict: "approve", decidedBy: "operator" },
    ]);
    // Refused: offered again, not left "deciding" — a second y sends a second decision.
    tty.type("y");
    await waitFor(() => client.requests.filter((request) => request.command === "approve").length === 2);
    tty.type(CTRL_C);
    await done;
  });

  it("takes a plugin's command typed while a round is offered, rather than its keys as a decision", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "approval.required", {
          callId: "call-a",
          toolName: "fs.write",
          summary: "Write notes.md?",
          input: {},
          steps: 1,
          approvalId: "approval-a",
          effect: "mutating",
        }),
      ],
    };
    client.answers = {
      approvals: () => ({
        ok: true,
        result: {
          rows: [
            {
              record: { approvalId: "approval-a", taskId: "task-1", callId: "call-a", toolId: "fs.write", steps: 1, createdAt: AT },
              task: {},
            },
          ],
          truncated: false,
        },
      }),
      "plugin-commands": (payload) =>
        (payload as { action: string }).action === "list"
          ? { ok: true, result: { commands: [{ name: "tally", pluginId: "acme.tally", description: "Counts." }] } }
          : { ok: true, result: { text: "3 tool calls" } },
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("round 1: y approves it"));
    // `/tally reset`: its `y`, `a` and `n` are the command's, not the round's.
    tty.type("/tally reset\r");
    await waitFor(() =>
      client.requests.some((request) => request.command === "plugin-commands" && (request.payload as { action: string }).action === "run"),
    );
    expect(client.requests.find((request) => (request.payload as { action?: string }).action === "run")?.payload).toMatchObject({
      action: "run",
      name: "tally",
      args: "reset",
    });
    expect(client.requests.filter((request) => request.command === "approve" || request.command === "reject")).toEqual([]);
    tty.type(CTRL_C);
    await done;
  });

  it("reads plugins' commands again on a reconnect, and drops the idle row's plugin lines no stream follows", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 3, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "plugin.status", { pluginId: "acme.tally", line: "3 calls so far" }),
        event(2, "task.completed", { finalText: "done" }),
      ],
    };
    let commands: readonly { readonly name: string; readonly pluginId: string; readonly description: string }[] = [];
    client.answers = {
      tasks: () => recorded({ status: "completed" }),
      "plugin-commands": (payload) =>
        (payload as { action: string }).action === "list" ? { ok: true, result: { commands } } : { ok: true, result: { text: "counted" } },
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("3 calls so far"));
    const lists = () =>
      client.requests.filter(
        (request) => request.command === "plugin-commands" && (request.payload as { action: string }).action === "list",
      ).length;
    expect(lists()).toBe(1);
    // The owner restarts with another plugin; the line was cleared while the chat followed nothing.
    commands = [{ name: "tally", pluginId: "acme.tally", description: "Counts." }];
    client.become("reconnecting");
    client.become("ready");
    await waitFor(() => tty.output().includes("… reconnected"));
    await waitFor(() => lists() === 2);
    const after = tty.output().slice(tty.output().lastIndexOf("… reconnected"));
    expect(after).toContain("✓ Done.");
    expect(after).not.toContain("3 calls so far");
    tty.type("/tally\r");
    await waitFor(() =>
      client.requests.some((request) => request.command === "plugin-commands" && (request.payload as { action: string }).action === "run"),
    );
    tty.type(CTRL_C);
    await done;
  });

  it("sends one decision for two keys in one chunk, and one abort for two Escs", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "approval.required", {
          callId: "call-a",
          toolName: "fs.write",
          summary: "Write notes.md?",
          input: {},
          steps: 1,
          approvalId: "approval-a",
          effect: "mutating",
        }),
      ],
    };
    client.answers = {
      approvals: () => ({
        ok: true,
        result: {
          rows: [
            {
              record: { approvalId: "approval-a", taskId: "task-1", callId: "call-a", toolId: "fs.write", steps: 1, createdAt: AT },
              task: {},
            },
          ],
          truncated: false,
        },
      }),
      // Never answered in time for the second key: the first must hold it off by itself.
      approve: () => ({ ok: true, result: {} }),
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("round 1: y approves it"));
    tty.type("yn");
    await delay(100);
    expect(client.requests.filter((request) => request.command === "approve")).toHaveLength(1);
    tty.type(CTRL_C);
    await done;

    const running = new ScriptedClient();
    running.subscribed = {
      result: { replayed: 1, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [event(0, "run.started", { threadId: "thread-1", workspaceId: "default" })],
    };
    running.answers = { abort: () => ({ ok: true, result: {} }) };
    const second = chatOver(running, { attach: "task-1" });
    await waitFor(() => second.tty.output().includes("Esc aborts it"));
    second.tty.type(String.fromCharCode(27));
    second.tty.type(String.fromCharCode(27));
    await delay(150);
    expect(running.requests.filter((request) => request.command === "abort")).toHaveLength(1);
    second.tty.type(CTRL_C);
    await second.done;
  });

  it("prints the status panes a command asks for, and never sends one as a prompt", async () => {
    const client = new ScriptedClient();
    client.answers = {
      schedules: () => ({
        ok: true,
        result: {
          schedules: [
            {
              scheduleId: "s-1",
              workspaceId: "default",
              principalId: "operator",
              name: "morning-brief",
              spec: { kind: "interval", everyMs: 60_000 },
              missedRunPolicy: "skip",
              autoApproveTools: [],
              agentId: "brief",
              enabled: true,
              nextRunAt: "2999-01-01T00:00:00.000Z",
              lastRunAt: AT,
              lastRunTaskId: "task-9",
              lastOutcome: "failed: MODEL_ERROR",
              consecutiveFailures: 2,
              createdAt: AT,
              updatedAt: AT,
            },
          ],
          truncated: false,
        },
      }),
      agents: () => ({
        ok: true,
        result: {
          agents: [{ agentId: "brief", workspaceId: "default", name: "Brief writer", enabled: true, createdAt: AT, updatedAt: AT }],
          truncated: false,
        },
      }),
      approvals: () => ({ ok: true, result: { rows: [], truncated: false } }),
    };
    const { tty, done } = chatOver(client);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("/help\r");
    await waitFor(() => tty.output().includes("─ commands ─"));
    tty.type("/schedules\r");
    await waitFor(() => tty.output().includes("─ schedules (workspace default) ─"));
    expect(tty.output()).toContain("● morning-brief as brief — next in ");
    expect(tty.output()).toContain("failed: MODEL_ERROR (task task-9)");
    expect(tty.output()).toContain("⚠ 2 failures in a row");
    tty.type("/AGENTS\r");
    await waitFor(() => tty.output().includes("─ agents (workspace default) ─"));
    expect(tty.output()).toContain("● brief — Brief writer");
    expect(tty.output()).toContain("mailbox: no task followed here");
    tty.type("/approvals\r");
    await waitFor(() => tty.output().includes("─ pending approvals (workspace default) ─"));
    // Reads, in the workspace, and not one run: a pane command is never a prompt.
    expect(asked(client).map((request) => request.command)).toEqual(["schedules", "agents", "approvals"]);
    expect(asked(client)[1]?.payload).toEqual({ action: "list", workspaceId: "default" });
    expect(client.runs).toEqual([]);
    // A refused read says so; an inexact command is a prompt like any other.
    client.answers.schedules = () => ({ ok: false, error: { code: "INTERNAL", message: "store unreadable" } });
    tty.type("/schedules\r");
    await waitFor(() => tty.output().includes("✗ /schedules: INTERNAL: store unreadable"));
    // A lone slash-word that is no command is a typo: said, and no run.
    tty.type("/agnets\r");
    await waitFor(() => tty.output().includes("✗ no command /agnets: /help lists them"));
    expect(client.runs).toEqual([]);
    // A command's word going on with more is no prompt either; a path is one.
    tty.type("/schedules please\r");
    await waitFor(() => tty.output().includes("✗ no command /schedules please"));
    tty.type("/etc/hosts: what is in it?\r");
    await waitFor(() => client.runs.length === 1);
    expect(client.runs[0]?.prompt).toBe("/etc/hosts: what is in it?");
    tty.type(CTRL_C);
    await done;
  });

  it("takes a pane command while a round is offered — its keys never decide the round — and Esc drops it", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "approval.required", {
          callId: "call-a",
          toolName: "fs.write",
          summary: "Write notes.md?",
          input: {},
          steps: 1,
          approvalId: "approval-a",
          effect: "mutating",
        }),
      ],
    };
    const row = {
      record: { approvalId: "approval-a", taskId: "task-1", callId: "call-a", toolId: "fs.write", steps: 1, createdAt: AT },
      task: {},
    };
    client.answers = {
      approvals: () => ({ ok: true, result: { rows: [row], truncated: false } }),
      approve: () => ({ ok: true, result: {} }),
      abort: () => ({ ok: true, result: {} }),
      agents: () => ({
        ok: true,
        result: {
          agents: [],
          truncated: false,
          mailbox: {
            taskId: "task-1",
            pending: [{ messageId: "m-1", kind: "result", senderAgentId: "researcher", senderTaskId: "task-2", createdAt: AT }],
            truncated: false,
          },
        },
      }),
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("round 1: y approves it"));
    // Key by key: "n" and "y" inside a command are the command's.
    for (const key of "/agents") tty.type(key);
    await waitFor(() => tty.output().includes("❯ /agents") && tty.output().includes("█"));
    tty.type("\r");
    await waitFor(() => tty.output().includes("mailbox of task task-1: 1 waiting to be received"));
    expect(tty.output()).toContain("result from researcher (task task-2)");
    expect(client.requests.find((request) => request.command === "agents")?.payload).toEqual({
      action: "list",
      workspaceId: "default",
      taskId: "task-1",
    });
    tty.type("/approvals\r");
    await waitFor(() => tty.output().includes("task task-1, round 1: fs.write"));
    expect(tty.output()).toContain("the task followed here: its card above decides it (y/n, s/a where offered)");
    const reads = (command: string) => client.requests.filter((request) => request.command === command).length;
    // One chunk that starts with "/": its command's prefix is kept, the rest —
    // "all", "yes, no" — dropped, never a key. Enter runs the command.
    tty.type("/agents all yes, no\r");
    await waitFor(() => reads("agents") === 2);
    // Typed a key at a time, as a person does: writes this close together
    // would otherwise reach the chat as one chunk (Esc then y, as Alt-y).
    const key = async (text: string) => {
      tty.type(text);
      await delay(40);
    };
    // Pasted, a command waits for Enter; half typed, Enter runs nothing and keeps it.
    tty.paste("/schedules\n");
    await delay(40);
    expect(reads("schedules")).toBe(0);
    await key("\r");
    await waitFor(() => reads("schedules") === 1);
    await key("/ag\r");
    // A key no command goes on with is dropped; Backspace edits what is kept.
    await key("x");
    await key("en");
    await key(BACKSPACE);
    await key("nts\r");
    await waitFor(() => reads("agents") === 3);
    // Esc while typing one drops the command; it aborts nothing.
    await key("/sch");
    await key(String.fromCharCode(27));
    // Dropped: the round is still offered, to the keys alone — a "y" after a
    // kept "/sch" would have been the command's, and dropped.
    await key("y");
    await waitFor(() => client.requests.some((request) => request.command === "approve"));
    expect(reads("abort")).toBe(0);
    expect(reads("schedules")).toBe(1);
    expect(client.requests.filter((request) => request.command === "approve")).toHaveLength(1);
    const beforeExit = tty.output().length;
    tty.type(CTRL_C);
    await done;
    expect(tty.output().slice(beforeExit)).toContain("❯");
    expect(tty.output().slice(beforeExit)).not.toContain("█");
  });

  it("names who decides the followed task's round when it is not this chat, and a task in another workspace", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "owner" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "other" }),
        event(1, "approval.required", {
          callId: "call-a",
          toolName: "fs.write",
          summary: "Write notes.md?",
          input: {},
          steps: 1,
          approvalId: "approval-a",
          effect: "mutating",
        }),
      ],
    };
    client.answers = {
      approvals: () => ({
        ok: true,
        result: {
          rows: [
            {
              record: { approvalId: "approval-a", taskId: "task-1", callId: "call-a", toolId: "fs.write", steps: 1, createdAt: AT },
              task: {},
            },
          ],
          truncated: false,
        },
      }),
      // The task is not in the chat's workspace: the owner refuses its mailbox, not the agents.
      agents: (payload) =>
        (payload as { taskId?: string }).taskId === undefined
          ? { ok: true, result: { agents: [], truncated: false } }
          : { ok: false, error: { code: "NOT_FOUND", message: "no task task-1 exists in workspace default" } },
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("Round 1 needs approval"));
    tty.type("/approvals\r");
    await waitFor(() => tty.output().includes("the task followed here: the owner answers it (the run's own policy)"));
    tty.type("/agents\r");
    await waitFor(() => tty.output().includes("mailbox of task task-1: not shown, the task is not in workspace default"));
    expect(tty.output()).not.toContain("✗ /agents");
    tty.type(CTRL_C);
    await done;
  });

  it("decides an attached task's round in the task's own workspace, not the chat's — read from its record on a late attach", async () => {
    for (const late of [false, true]) {
      const client = new ScriptedClient();
      const round = event(late ? 5 : 1, "approval.required", {
        callId: "call-a",
        toolName: "fs.write",
        summary: "Write notes.md?",
        input: {},
        steps: 1,
        approvalId: "approval-a",
        effect: "mutating",
      });
      client.subscribed = {
        result: { replayed: late ? 1 : 2, resync: false, truncated: late, roundsAnsweredBy: "client" },
        // Joined late, the stream holds no `run.started` to say the workspace.
        events: late ? [round] : [event(0, "run.started", { threadId: "thread-1", workspaceId: "other" }), round],
      };
      client.answers = {
        // The owner lists a task's rows only in the task's workspace.
        approvals: (payload) =>
          (payload as { workspaceId?: string }).workspaceId === "other"
            ? {
                ok: true,
                result: {
                  rows: [
                    {
                      record: { approvalId: "approval-a", taskId: "task-1", callId: "call-a", toolId: "fs.write", steps: 1, createdAt: AT },
                      task: {},
                    },
                  ],
                  truncated: false,
                },
              }
            : { ok: true, result: { rows: [], truncated: false } },
        tasks: () => ({
          ok: true,
          result: { found: true, task: { taskId: "task-1", workspaceId: "other", status: "waiting" }, admissions: [] },
        }),
      };
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("Round 1 needs approval"));
      // Offered only once the round is listed whole — which it is only in "other".
      await waitFor(() => tty.output().includes("y approves"));
      tty.type("y");
      await waitFor(() => client.requests.some((request) => request.command === "approve"));
      const approve = client.requests.find((request) => request.command === "approve")?.payload as { workspaceId?: string };
      expect(approve.workspaceId, late ? "late attach" : "run.started").toBe("other");
      expect(
        client.requests
          .filter((request) => request.command === "approvals")
          .every((request) => (request.payload as { workspaceId?: string }).workspaceId === "other"),
      ).toBe(true);
      tty.type(CTRL_C);
      await done;
    }
  });

  it("offers a round's scopes as keys and sends them, and takes a rejection's reason after N", async () => {
    for (const keys of ["s", "a", "N"] as const) {
      const client = new ScriptedClient();
      client.subscribed = {
        result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
        events: [
          event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
          event(1, "approval.required", {
            callId: "call-a",
            toolName: "sandbox.run",
            summary: "Run `make test` in the sandbox",
            input: { command: "make", args: ["test"] },
            steps: 1,
            approvalId: "approval-a",
            effect: "external",
            risk: { level: "medium", reasons: ["this plugin asks for approval before its tools run"], tainted: false },
            display: { title: "Run `make test` in the sandbox", command: "make test" },
            allowedScopes: ["once", "session", "always"],
          }),
        ],
      };
      client.answers = {
        approvals: () => ({
          ok: true,
          result: {
            rows: [
              {
                record: { approvalId: "approval-a", taskId: "task-1", callId: "call-a", toolId: "sandbox.run", steps: 1, createdAt: AT },
                task: {},
              },
            ],
            truncated: false,
          },
        }),
        tasks: () => ({
          ok: true,
          result: { found: true, task: { taskId: "task-1", workspaceId: "default", status: "waiting" }, admissions: [] },
        }),
      };
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("s for the rest of this chat, a always (a workspace rule)"));
      expect(tty.output()).toContain("sandbox.run — Run `make test` in the sandbox [medium risk]");
      expect(tty.output()).toContain("Flagged: this plugin asks for approval before its tools run");
      tty.type(keys);
      if (keys === "N") {
        await waitFor(() => tty.output().includes("why reject round 1?"));
        tty.type("not on the release branch\r");
      }
      await waitFor(() => client.requests.some((request) => request.command === "approve"));
      const approve = client.requests.find((request) => request.command === "approve")?.payload as {
        verdict?: string;
        scope?: string;
        note?: string;
      };
      expect(approve, keys).toMatchObject(
        keys === "N"
          ? { verdict: "reject", note: "not on the release branch" }
          : { verdict: "approve", scope: keys === "s" ? "session" : "always" },
      );
      tty.type(CTRL_C);
      await done;
    }
  });

  it("ignores a scope a round does not offer, and cancels a rejection with Esc without aborting the turn", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "approval.required", {
          callId: "call-a",
          toolName: "fs.write",
          summary: "Write notes.md?",
          input: {},
          steps: 1,
          approvalId: "approval-a",
          effect: "mutating",
          allowedScopes: ["once"],
        }),
      ],
    };
    client.answers = {
      approvals: () => ({
        ok: true,
        result: {
          rows: [
            {
              record: { approvalId: "approval-a", taskId: "task-1", callId: "call-a", toolId: "fs.write", steps: 1, createdAt: AT },
              task: {},
            },
          ],
          truncated: false,
        },
      }),
      tasks: () => ({
        ok: true,
        result: { found: true, task: { taskId: "task-1", workspaceId: "default", status: "waiting" }, admissions: [] },
      }),
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("y approves it, n rejects it, N rejects with a reason"));
    tty.type("sa");
    tty.type("N");
    await waitFor(() => tty.output().includes("why reject round 1?"));
    tty.type(String.fromCharCode(27));
    await waitFor(() => tty.output().includes("the rejection was not sent"));
    expect(client.requests.some((request) => request.command === "approve" || request.command === "abort")).toBe(false);
    tty.type(CTRL_C);
    await done;
  });

  it("reads a task's workspace again after a read that failed, rather than keeping the chat's own", async () => {
    const client = new ScriptedClient();
    const required = (sequence: number, steps: number) =>
      event(sequence, "approval.required", {
        callId: `call-${steps}`,
        toolName: "fs.write",
        summary: "Write?",
        input: {},
        steps,
        approvalId: `approval-${steps}`,
        effect: "mutating",
      });
    client.subscribed = {
      result: { replayed: 1, resync: false, truncated: true, roundsAnsweredBy: "client" },
      events: [required(5, 1)],
    };
    let reads = 0;
    client.answers = {
      approvals: (payload) => {
        const workspaceId = (payload as { workspaceId?: string }).workspaceId;
        return workspaceId === "other"
          ? {
              ok: true,
              result: {
                rows: [
                  {
                    record: { approvalId: "approval-2", taskId: "task-1", callId: "call-2", toolId: "fs.write", steps: 2, createdAt: AT },
                    task: {},
                  },
                ],
                truncated: false,
              },
            }
          : { ok: true, result: { rows: [], truncated: false } };
      },
      // The first read of the record fails; the next succeeds.
      tasks: () =>
        ++reads === 1
          ? { ok: false, error: { code: "UNAVAILABLE", message: "busy" } }
          : { ok: true, result: { found: true, task: { taskId: "task-1", workspaceId: "other", status: "waiting" } } },
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => client.requests.some((request) => request.command === "approvals"));
    // Round 1 settles elsewhere; round 2 is asked for, and its listing reads the record again.
    client.emit(event(6, "approval.settled", { steps: 1, decisions: [{ callId: "call-1", approved: true }], decidedBy: "someone" }));
    client.emit(required(7, 2));
    await waitFor(() => reads === 2);
    await waitFor(() => tty.output().includes("round 2: y approves"));
    tty.type("y");
    await waitFor(() => client.requests.some((request) => request.command === "approve"));
    expect((client.requests.find((request) => request.command === "approve")?.payload as { workspaceId?: string }).workspaceId).toBe(
      "other",
    );
    tty.type(CTRL_C);
    await done;
  });

  it("starts a new task for a prompt after a settled task it cannot continue — one with no conversation here", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "task.completed", { finalText: "done" }),
      ],
    };
    // Started on another connection (Telegram, say): no IPC conversation to reply into.
    client.answers = {
      tasks: () => ({
        ok: true,
        result: {
          found: true,
          task: { taskId: "task-1", workspaceId: "default", status: "completed", origin: "messaging" },
          admissions: [],
        },
      }),
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("✓ Done."));
    tty.type("carry on\r");
    await waitFor(() => tty.output().includes("chat task-1 has no conversation here to continue: this prompt starts a new chat"));
    await waitFor(() => client.runs.length === 1);
    expect(client.requests.some((request) => request.command === "reply")).toBe(false);
    // The prompt is shown once, not again by the task it starts.
    expect(tty.output().split("❯ carry on").length - 1).toBe(1);
    tty.type(CTRL_C);
    await done;
  });

  describe("a continuation that does not go as planned", () => {
    /** Task task-1, attached and completed; an IPC run started it, as conversation op-1. Its later subscriptions replay nothing. */
    const settledTask = async (deps: { readonly answerSettleMs?: number; readonly workerPollMs?: number } = {}) => {
      const client = new ScriptedClient();
      client.subscribed = {
        result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
        events: [
          event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
          event(1, "task.completed", { finalText: "done" }),
        ],
      };
      const record = {
        ok: true,
        result: {
          found: true,
          task: { taskId: "task-1", workspaceId: "default", status: "completed", origin: "ipc" },
          admissions: [
            {
              admissionId: "admission-1",
              taskId: "task-1",
              operationKey: "op-1",
              kind: "start",
              state: "committed",
              result: { status: "completed" },
              createdAt: AT,
              updatedAt: AT,
            },
          ],
        },
      };
      client.answers = { tasks: () => record };
      const chat = chatOver(client, { attach: "task-1" }, deps);
      await waitFor(() => chat.tty.output().includes("✓ Done."));
      client.subscribed = { result: { replayed: 0, resync: false, truncated: false, roundsAnsweredBy: "client" }, events: [] };
      return { client, record, ...chat };
    };
    const replies = (client: ScriptedClient) =>
      client.requests
        .filter((request) => request.command === "reply")
        .map((request) => request.payload as { conversationId: string; clientMessageId: string; text: string });

    it("follows the next turn from where the last stopped, and takes a resync of that place as lines it cannot trust", async () => {
      const client = new ScriptedClient();
      client.subscribed = {
        result: { replayed: 3, resync: false, truncated: false, roundsAnsweredBy: "client" },
        events: [
          event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
          event(1, "plugin.status", { pluginId: "acme.tally", line: "3 calls" }),
          event(2, "task.completed", { finalText: "done" }),
        ],
      };
      const record = {
        ok: true,
        result: {
          found: true,
          task: { taskId: "task-1", workspaceId: "default", status: "completed", origin: "ipc" },
          admissions: [
            {
              admissionId: "admission-1",
              taskId: "task-1",
              operationKey: "op-1",
              kind: "start",
              state: "committed",
              result: { status: "completed" },
              createdAt: AT,
              updatedAt: AT,
            },
          ],
        },
      };
      client.answers = { tasks: () => record };
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("✓ Done.") && tty.output().includes("3 calls"));
      // The owner holds nothing from after that place any more (its ring was evicted).
      client.subscribed = {
        result: { replayed: 0, resync: true, truncated: false, roundsAnsweredBy: "client" },
        events: [event(3, "resync.required", { reason: "the owner holds no events after that place" })],
      };
      client.answers.reply = () => ({ ok: true, result: { recorded: true } });
      tty.type("carry on\r");
      await waitFor(() => replies(client).length === 1);
      // Followed from the last turn's place, not from now.
      expect(client.subscribes.at(-1)?.options.from).toBeDefined();
      const after = tty.output().slice(tty.output().lastIndexOf("❯ carry on"));
      expect(after).not.toContain("⚠");
      // The row drawn with the prompt still had the line; the one drawn since has not.
      await waitFor(() => tty.output().lastIndexOf("● starting…") > tty.output().lastIndexOf("3 calls"));
      tty.type(CTRL_C);
      await done;
    });

    it("follows from now when the place's replay holds another turn of the task, and still sends the prompt", async () => {
      const client = new ScriptedClient();
      client.subscribed = {
        result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
        events: [
          event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
          event(1, "task.completed", { finalText: "done" }),
        ],
      };
      const record = {
        ok: true,
        result: {
          found: true,
          task: { taskId: "task-1", workspaceId: "default", status: "completed", origin: "ipc" },
          admissions: [
            {
              admissionId: "admission-1",
              taskId: "task-1",
              operationKey: "op-1",
              kind: "start",
              state: "committed",
              result: { status: "completed" },
              createdAt: AT,
              updatedAt: AT,
            },
          ],
        },
      };
      client.answers = { tasks: () => record };
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("✓ Done."));
      // A message from a channel into the chat ran a turn meanwhile: its events follow the place.
      client.subscribed = {
        result: { replayed: 3, resync: false, truncated: false, roundsAnsweredBy: "client" },
        // From the place only: followed from now, nothing of the past is replayed.
        events: (options) =>
          options.from === undefined
            ? []
            : [
                event(2, "attempt.replaced", { attemptId: "attempt-2", supersededAttemptId: "attempt-1", reason: "resuming after reply" }),
                event(3, "text.delta", { blockId: "b9", text: "FOREIGN ANSWER" }),
                event(4, "task.completed", { finalText: "FOREIGN ANSWER" }),
              ],
      };
      client.answers.reply = () => ({ ok: true, result: { recorded: true } });
      tty.type("carry on\r");
      await waitFor(() => replies(client).length === 1);
      expect(tty.output()).not.toContain("FOREIGN ANSWER");
      // Followed again from now.
      expect(client.subscribes.at(-1)?.options.from).toBeUndefined();
      // The replaced subscription's end is not the turn's: its turn is still running here, so a prompt typed now steers it.
      client.emit(event(5, "run.started", { threadId: "thread-1", workspaceId: "default" }));
      tty.type("/steer and more\r");
      await waitFor(() =>
        client.requests.some((request) => request.command === "reply" && (request.payload as { intent?: string }).intent === "steer"),
      );
      tty.type(CTRL_C);
      await done;
    });

    it("prints a live answer's memory line after the answer, not above it", async () => {
      const { client, record, tty, done } = await settledTask();
      client.answers.reply = () => ({ ok: true, result: { recorded: true } });
      const saved = {
        taskId: "task-1",
        seq: 2,
        turn: {
          admissionKind: "reply",
          prompt: "dinner?",
          items: [{ kind: "text", text: "A quick dinner." }],
          outcome: { status: "completed", finalText: "A quick dinner." },
          memoryUsed: { records: [{ recordId: "r1", revisionId: "v1" }], preferences: 0, more: 0 },
        },
        createdAt: AT,
      };
      client.answers.tasks = (payload) =>
        (payload as { action?: string }).action === "transcript" ? { ok: true, result: { entries: [saved] } } : record;
      tty.type("dinner?\r");
      await waitFor(() => replies(client).length === 1);
      client.emit(event(2, "text.delta", { blockId: "b2", text: "A quick dinner." }));
      client.emit(event(3, "task.completed", { finalText: "A quick dinner." }));
      await waitFor(() => tty.output().includes("memory: 1 used · /why"));
      const output = tty.output();
      expect(output.lastIndexOf("A quick dinner.")).toBeLessThan(output.indexOf("memory: 1 used"));
      tty.type(CTRL_C);
      await done;
    });

    it("sends a reply the owner did not answer in time once more, as the same message", async () => {
      const { client, tty, done } = await settledTask();
      let sent = 0;
      client.answers.reply = () =>
        ++sent === 1
          ? { ok: false, error: { code: CLIENT_TIMEOUT, message: "no answer in time" } }
          : { ok: true, result: { recorded: true } };
      tty.type("carry on\r");
      await waitFor(() => replies(client).length === 2);
      const [first, second] = replies(client);
      expect(first?.conversationId).toBe("op-1");
      expect(second?.clientMessageId).toBe(first?.clientMessageId);
      await waitFor(() => tty.output().includes("sending the prompt again as the same message"));
      expect(tty.output()).not.toContain("not sent");
      // Its turn arrives on the stream followed from before the reply.
      client.emit(event(2, "text.delta", { blockId: "b2", text: "carried on" }));
      client.emit(event(3, "task.completed", { finalText: "carried on" }));
      await waitFor(() => tty.output().split("✓ Done.").length - 1 >= 2);
      tty.type(CTRL_C);
      await done;
    });

    describe("a worker's question, asked in its root chat", () => {
      const asked = (waitId: string, taskId: string, label: string, question: string) => ({
        kind: "question",
        needId: `question:${waitId}`,
        taskId,
        askedAt: AT,
        deadlineAt: "2099-01-01T00:00:00.000Z",
        question: {
          taskId,
          workspaceId: "default",
          principalId: "operator",
          workerLabel: label,
          waitId,
          question,
          deadlineAt: "2099-01-01T00:00:00.000Z",
          askedAt: AT,
          deliveries: [],
        },
      });
      const answers = (client: ScriptedClient) =>
        client.requests
          .filter((request) => request.command === "approvals" && (request.payload as { action?: string }).action === "answer")
          .map((request) => request.payload);

      it("shows it inline with the worker's name, and answers the one open question by typing — at the worker's wait", async () => {
        const { client, tty, done } = await settledTask({ workerPollMs: 20 });
        let open = [asked("wait-1", "worker-1", "Researcher", "Which source?")];
        client.answers.approvals = (payload) =>
          (payload as { action: string }).action === "needs"
            ? {
                ok: true,
                result: {
                  needs: open,
                  handoffs: [
                    {
                      taskId: "worker-2",
                      workspaceId: "default",
                      principalId: "operator",
                      workerLabel: "Browser",
                      waitId: "wait-h",
                      handoff: { sessionId: "s-1", reason: "sign-in", instructions: "Sign in to the shop" },
                      deadlineAt: "2099-01-01T00:00:00.000Z",
                      askedAt: AT,
                    },
                  ],
                  truncated: false,
                },
              }
            : { ok: true, result: { taskId: "worker-1", waitId: "wait-1", answers: [], other: "the docs" } };
        await waitFor(() => tty.output().includes("? Researcher asks: Which source?"));
        expect(client.requests.find((request) => request.command === "approvals")?.payload).toEqual({
          action: "needs",
          workspaceId: "default",
          rootTaskId: "task-1",
        });
        expect(tty.output()).toContain("… type your answer");
        expect(tty.output()).toContain("! Browser needs you in its browser: Sign in to the shop");
        open = [];
        tty.type("the docs\r");
        await waitFor(() => tty.output().includes("✓ answered Researcher's question"));
        expect(answers(client)).toEqual([
          { action: "answer", workspaceId: "default", taskId: "worker-1", answer: "the docs", waitId: "wait-1" },
        ]);
        // Never a turn of the root.
        expect(replies(client)).toEqual([]);
        expect(client.runs).toEqual([]);
        tty.type(CTRL_C);
        await done;
      });

      it("reads nothing more from an owner that drops the root and lists the workspace — no handoffs — and sends the line as a message", async () => {
        const { client, tty, done } = await settledTask({ workerPollMs: 20 });
        client.answers.reply = () => ({ ok: true, result: { recorded: true } });
        let reads = 0;
        client.answers.approvals = () => {
          reads += 1;
          return { ok: true, result: { needs: [asked("wait-9", "other-chat", "Someone", "Someone else's?")], truncated: false } };
        };
        await waitFor(() => reads === 1);
        await delay(100);
        expect(reads).toBe(1);
        expect(tty.output()).not.toContain("Someone else's?");
        tty.type("carry on\r");
        await waitFor(() => replies(client).length === 1);
        expect(answers(client)).toEqual([]);
        tty.type(CTRL_C);
        await done;
      });

      it("lets a worker's question go when the chat shown changes: the next prompt after /side starts the side chat", async () => {
        const { client, tty, done } = await settledTask({ workerPollMs: 20 });
        client.answers.approvals = () => ({
          ok: true,
          result: { needs: [asked("wait-1", "worker-1", "Researcher", "Which source?")], handoffs: [], truncated: false },
        });
        await waitFor(() => tty.output().includes("? Researcher asks: Which source?"));
        client.answers.approvals = () => ({ ok: true, result: { needs: [], handoffs: [], truncated: false } });
        client.runAnswers = [
          () => ({ response: { ok: true, result: { taskId: "task-2", subscriptionId: "sub-2" } }, subscription: subscription("task-2") }),
        ];
        tty.type("/side\r");
        await waitFor(() => tty.output().includes("the next prompt starts"));
        tty.type("plan the trip\r");
        await waitFor(() => client.runs.length === 1);
        expect(client.runs[0]).toMatchObject({ prompt: "plan the trip" });
        expect(answers(client)).toEqual([]);
        tty.type(CTRL_C);
        await done;
      });

      it("queues a typed line behind the chat's own question when a worker asks too, answering neither", async () => {
        const client = new ScriptedClient();
        client.subscribed = {
          result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
          events: [
            event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
            event(1, "task.waiting", {
              on: "the operator's answer",
              deadlineAt: "2099-01-01T00:00:00.000Z",
              question: "Which market?",
              waitId: "wait-own",
            }),
          ],
        };
        client.answers.tasks = () => ({
          ok: true,
          result: {
            task: { status: "waiting", origin: "ipc" },
            admissions: [
              {
                admissionId: "admission-1",
                taskId: "task-1",
                operationKey: "op-ipc-1",
                kind: "start",
                state: "committed",
                result: null,
                createdAt: AT,
                updatedAt: AT,
              },
            ],
          },
        });
        client.answers.approvals = () => ({
          ok: true,
          result: { needs: [asked("wait-1", "worker-1", "Researcher", "Which source?")], handoffs: [], truncated: false },
        });
        const { tty, done } = chatOver(client, { attach: "task-1" }, { workerPollMs: 20 });
        await waitFor(() => tty.output().includes("Type the answer and press Enter."));
        await waitFor(() => tty.output().includes("2 questions are open: /answer lists them"));
        tty.type("and check prices\r");
        await waitFor(() => tty.output().includes("… queued: sends after this turn"));
        expect(replies(client)).toEqual([]);
        expect(answers(client)).toEqual([]);
        tty.type(CTRL_C);
        await done;
      });

      it("with two open, sends a typed line as a message, says how many are open, and answers one with /answer", async () => {
        const { client, tty, done } = await settledTask({ workerPollMs: 20 });
        client.answers.reply = () => ({ ok: true, result: { recorded: true } });
        client.answers.approvals = (payload) =>
          (payload as { action: string }).action === "needs"
            ? {
                ok: true,
                result: {
                  needs: [asked("wait-1", "worker-1", "Researcher", "Which source?"), asked("wait-2", "worker-2", "Analyst", "How deep?")],
                  handoffs: [],
                  truncated: false,
                },
              }
            : { ok: true, result: { taskId: "worker-2", waitId: "wait-2", answers: [], other: "one level" } };
        await waitFor(() => tty.output().includes("? Analyst asks: How deep?"));
        expect(tty.output()).toContain("2 questions are open: /answer lists them, /answer <n> <text> answers one");
        tty.type("/answer\r");
        await waitFor(() => tty.output().includes("─ open questions ─"));
        expect(tty.output()).toContain("2. Analyst: How deep?");
        tty.type("also check prices\r");
        await waitFor(() => replies(client).length === 1);
        expect(replies(client)[0]?.text).toBe("also check prices");
        expect(tty.output()).toContain("2 questions are open, so this is a message, not an answer");
        expect(answers(client)).toEqual([]);
        tty.type("/answer 2 one level\r");
        await waitFor(() => answers(client).length === 1);
        expect(answers(client)[0]).toEqual({
          action: "answer",
          workspaceId: "default",
          taskId: "worker-2",
          answer: "one level",
          waitId: "wait-2",
        });
        tty.type("/answer 7 nope\r");
        await waitFor(() => tty.output().includes("✗ no open question 7: /answer lists them"));
        tty.type(CTRL_C);
        await done;
      });
    });

    it("starts a new task when the owner finds no such conversation", async () => {
      const { client, tty, done } = await settledTask();
      client.answers.reply = () => ({ ok: false, error: { code: "NOT_FOUND", message: "no conversation op-1" } });
      client.runAnswers = [() => ({ response: { ok: false, error: { code: "REFUSED", message: "scripted" } } })];
      tty.type("carry on\r");
      await waitFor(() => client.runs.length === 1);
      expect(tty.output()).toContain("chat task-1 has no conversation on this owner's local connection: this prompt starts a new chat");
      expect(client.runs[0]?.prompt).toBe("carry on");
      expect(tty.output().split("❯ carry on").length - 1).toBe(1);
      tty.type(CTRL_C);
      await done;
    });

    it("keeps the task to continue when a reply is refused, or its record cannot be read — nothing starts in its place", async () => {
      const { client, record, tty, done } = await settledTask();
      client.answers.reply = () => ({ ok: false, error: { code: "INVALID_INPUT", message: "scripted refusal" } });
      tty.type("carry on\r");
      await waitFor(() =>
        tty.output().includes("the prompt was not sent: INVALID_INPUT: scripted refusal; type it again to send it to this chat"),
      );
      // The conversation is known now; a record that cannot be read is said so, not taken for none.
      let reads = 0;
      client.answers.tasks = () => (++reads === 1 ? { ok: false, error: { code: "UNAVAILABLE", message: "busy" } } : record);
      client.answers.reply = () => ({ ok: true, result: { recorded: true } });
      tty.type("again\r");
      await waitFor(() => tty.output().includes("could not read task task-1's record (UNAVAILABLE: busy): nothing was sent"));
      expect(replies(client)).toHaveLength(1);
      tty.type("again\r");
      await waitFor(() => replies(client).length === 2);
      expect(replies(client).map((reply) => reply.text)).toEqual(["carry on", "again"]);
      expect(client.runs).toHaveLength(0);
      tty.type(CTRL_C);
      await done;
    });

    it("prints a chat's saved turns when the owner holds none of its stream", async () => {
      const client = new ScriptedClient();
      client.subscribed = { result: { replayed: 0, resync: false, truncated: false, roundsAnsweredBy: "client" }, events: [] };
      const record = {
        ok: true,
        result: {
          found: true,
          task: { taskId: "task-1", workspaceId: "default", status: "completed", origin: "ipc" },
          admissions: [
            {
              admissionId: "admission-1",
              taskId: "task-1",
              operationKey: "op-1",
              kind: "start",
              state: "committed",
              result: { status: "completed" },
              createdAt: AT,
              updatedAt: AT,
            },
          ],
        },
      };
      const saved = {
        taskId: "task-1",
        seq: 1,
        turn: {
          admissionKind: "start",
          prompt: "what changed?",
          items: [
            { kind: "text", text: "Three files changed." },
            { kind: "tool", callId: "c1", toolName: "fs.read", status: "completed" },
          ],
          outcome: { status: "completed", finalText: "Three files changed." },
        },
        createdAt: AT,
      };
      client.answers = {
        tasks: (payload) =>
          (payload as { action?: string }).action === "transcript" ? { ok: true, result: { entries: [saved] } } : record,
      };
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("✓ completed (recorded)"));
      const output = tty.output();
      expect(output).toContain("❯ what changed?");
      expect(output).toContain("Three files changed.");
      expect(output).toContain("fs.read completed");
      expect(output.indexOf("Three files changed.")).toBeLessThan(output.indexOf("✓ completed (recorded)"));
      tty.type(CTRL_C);
      await done;
    });

    it("prints a dim memory line under a saved answer that used memory, naming /why", async () => {
      const client = new ScriptedClient();
      client.subscribed = { result: { replayed: 0, resync: false, truncated: false, roundsAnsweredBy: "client" }, events: [] };
      const record = {
        ok: true,
        result: {
          found: true,
          task: { taskId: "task-1", workspaceId: "default", status: "completed", origin: "ipc" },
          admissions: [
            {
              admissionId: "admission-1",
              taskId: "task-1",
              operationKey: "op-1",
              kind: "start",
              state: "committed",
              result: { status: "completed" },
              createdAt: AT,
              updatedAt: AT,
            },
          ],
        },
      };
      const turn = (prompt: string, memoryUsed?: unknown) => ({
        admissionKind: "start",
        prompt,
        items: [{ kind: "text", text: `${prompt} answered.` }],
        outcome: { status: "completed", finalText: "" },
        ...(memoryUsed === undefined ? {} : { memoryUsed }),
      });
      const entries = [
        { taskId: "task-1", seq: 1, turn: turn("older"), createdAt: AT },
        { taskId: "task-1", seq: 2, turn: turn("none", { records: [], preferences: 2, more: 0 }), createdAt: AT },
        {
          taskId: "task-1",
          seq: 3,
          turn: turn("where do I live?", {
            records: [
              { recordId: "r1", revisionId: "v1" },
              { recordId: "r2", revisionId: "v2" },
            ],
            preferences: 0,
            more: 1,
          }),
          createdAt: AT,
        },
        {
          taskId: "task-1",
          seq: 4,
          turn: turn("what do you know?", {
            records: [],
            preferences: 0,
            more: 0,
            listed: { records: [{ recordId: "r1", revisionId: "v1" }], more: 5 },
          }),
          createdAt: AT,
        },
      ];
      client.answers = {
        tasks: (payload) => ((payload as { action?: string }).action === "transcript" ? { ok: true, result: { entries } } : record),
      };
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("✓ completed (recorded)"));
      const output = tty.output();
      // Only the answer that used memory says so: 2 named and 1 counted past them.
      expect(output.match(/memory: \d+ used/g)).toEqual(["memory: 3 used"]);
      expect(output).toContain("memory: 3 used · /why");
      expect(output.indexOf("where do I live? answered.")).toBeLessThan(output.indexOf("memory: 3 used"));
      // An answer that only looked through what is kept says that, and still says something.
      expect(output).toContain("memory: 6 looked through · /why");
      tty.type(CTRL_C);
      await done;
    });

    it("says a record it cannot read, and sends nothing", async () => {
      const client = new ScriptedClient();
      client.subscribed = {
        result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
        events: [
          event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
          event(1, "task.completed", { finalText: "done" }),
        ],
      };
      client.answers = { tasks: () => ({ ok: false, error: { code: "UNAVAILABLE", message: "busy" } }) };
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("✓ Done."));
      tty.type("carry on\r");
      await waitFor(() => tty.output().includes("could not read task task-1's record (UNAVAILABLE: busy): nothing was sent"));
      expect(client.runs).toHaveLength(0);
      expect(replies(client)).toHaveLength(0);
      tty.type(CTRL_C);
      await done;
    });

    it("releases the prompt when a recorded reply starts no turn", async () => {
      const { client, tty, done } = await settledTask({ answerSettleMs: 30 });
      client.answers.reply = () => ({ ok: true, result: { recorded: true } });
      tty.type("carry on\r");
      await waitFor(() => tty.output().includes("but task task-1 has not started its turn"));
      expect(tty.output()).toMatch(/the prompt was recorded \(message chat-[0-9a-f-]+\), but task task-1/);
      // Released, and still the task the next prompt continues.
      tty.type("once more\r");
      await waitFor(() => replies(client).length === 2);
      tty.type(CTRL_C);
      await done;
    });

    it("reads the record again after a read that failed, and reads back a turn that ran unseen rather than call it never started", async () => {
      const { client, record, tty, done } = await settledTask({ answerSettleMs: 30 });
      client.answers.reply = () => ({ ok: true, result: { recorded: true } });
      const later = {
        ok: true,
        result: {
          ...record.result,
          admissions: [
            ...record.result.admissions,
            {
              admissionId: "admission-2",
              taskId: "task-1",
              operationKey: "msg-2",
              kind: "reply",
              state: "committed",
              result: { status: "completed" },
              createdAt: AT,
              updatedAt: AT,
            },
          ],
        },
      };
      let reads = 0;
      // The conversation's read and the one before the reply: one admission. Then a read that fails; then the reply's turn, ended.
      client.answers.tasks = () =>
        ++reads <= 2 ? record : reads === 3 ? { ok: false, error: { code: "UNAVAILABLE", message: "busy" } } : later;
      tty.type("carry on\r");
      await waitFor(() => tty.output().includes("✓ completed (recorded)"));
      expect(reads).toBeGreaterThanOrEqual(4);
      expect(tty.output()).not.toContain("has not started its turn");
      tty.type(CTRL_C);
      await done;
    });

    it("does not continue a cancelled task: the next prompt starts a new one", async () => {
      const client = new ScriptedClient();
      client.subscribed = {
        result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
        events: [
          event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
          event(1, "task.failed", { errorCode: "CANCELLED", message: "Task was cancelled by operator: enough" }),
        ],
      };
      client.runAnswers = [() => ({ response: { ok: false, error: { code: "REFUSED", message: "scripted" } } })];
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("✗ failed:"));
      expect(tty.output()).not.toContain("type to continue it");
      tty.type("next\r");
      await waitFor(() => client.runs.length === 1);
      expect(replies(client)).toEqual([]);
      tty.type(CTRL_C);
      await done;
    });

    it("follows an attached task through every turn its replay holds, and on into the one still running", async () => {
      const client = new ScriptedClient();
      const turn2 = (sequence: number, kind: string, fields: Record<string, unknown>) =>
        ClientEventSchema.parse({ ...BASE, sequence, attemptId: "attempt-2", kind, ...fields });
      client.subscribed = {
        result: { replayed: 5, resync: false, truncated: false, roundsAnsweredBy: "client" },
        events: [
          event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
          event(1, "text.delta", { blockId: "b", text: "turn one" }),
          event(2, "task.completed", { finalText: "turn one" }),
          turn2(3, "attempt.replaced", { supersededAttemptId: "attempt-1", reason: "resuming after reply" }),
          turn2(4, "text.delta", { blockId: "b2", text: "turn two so far" }),
        ],
      };
      const { tty, errors, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("turn two so far"));
      // Not let go at the first turn's end: the second goes on live.
      expect(client.closedSubscriptions).toEqual([]);
      client.emit(turn2(5, "text.delta", { blockId: "b2", text: " and more" }));
      await waitFor(() => tty.output().includes("and more"));
      expect(tty.output()).not.toContain("resuming after reply");
      // A turn is running: Ctrl-C detaches, naming the task.
      tty.type(CTRL_C);
      expect(await done).toBe(EXIT.detached);
      expect(errors.join("")).toContain("tavi chat --attach task-1");
    });

    /** A settled task continued, its turn running, and "and then this" typed behind it: queued, not sent. */
    const queuedBehindATurn = async () => {
      const opened = await settledTask();
      const { client, tty } = opened;
      client.answers.reply = () => ({ ok: true, result: { recorded: true } });
      tty.type("carry on\r");
      await waitFor(() => replies(client).length === 1);
      // The continued turn is running now: the next prompt waits for it.
      client.emit(event(2, "text.delta", { blockId: "b2", text: "working on it" }));
      await waitFor(() => tty.output().includes("working on it"));
      tty.type("and then this\r");
      await waitFor(() => tty.output().includes("queued: sends after this turn"));
      expect(replies(client)).toHaveLength(1);
      return opened;
    };

    it("queues a prompt typed while a turn runs, and sends it once the turn ends", async () => {
      const { client, tty, done } = await queuedBehindATurn();
      client.emit(event(3, "task.completed", { finalText: "done" }));
      await waitFor(() => replies(client).length === 2);
      expect(replies(client)[1]?.text).toBe("and then this");
      tty.type(CTRL_C);
      await done;
    });

    it("says a queued prompt was not sent when Ctrl-C detaches before the turn ends", async () => {
      const { client, errors, tty, done } = await queuedBehindATurn();
      tty.type(CTRL_C);
      expect(await done).toBe(EXIT.detached);
      expect(replies(client)).toHaveLength(1);
      expect(errors.join("")).toContain("1 queued prompt was not sent: “and then this”");
      expect(errors.join("")).toContain("tavi chat --attach task-1");
    });

    it("quits without claiming the task continues when Ctrl-C comes before the prompt is sent", async () => {
      const { client, errors, tty, done } = await settledTask();
      // The conversation's read never answers.
      client.answers.tasks = () => new Promise<never>(() => undefined) as never;
      // The conversation's read; the taint chip's label read at the turn's end is not it, nor the attach's read of the record.
      const reads = () =>
        client.requests.filter(
          (request) => request.command === "tasks" && (request.payload as { action?: string } | undefined)?.action !== "label",
        ).length;
      const before = reads();
      tty.type("carry on\r");
      await waitFor(() => reads() === before + 1);
      tty.type(CTRL_C);
      expect(await done).toBe(EXIT.ok);
      expect(errors.join("")).toContain("Quit before the prompt was sent: task task-1 was not continued.");
      expect(errors.join("")).not.toContain("the owner continues task");
      expect(replies(client)).toHaveLength(0);
    });
  });

  it("stores a credential through its form: the value typed masked, sent once, and never shown", async () => {
    const client = new ScriptedClient();
    client.answers = { credentials: () => ({ ok: true, result: { stored: "openai" } }) };
    const { tty, done } = chatOver(client);
    await waitFor(() => tty.output().includes("Type a prompt"));
    const key = async (text: string) => {
      tty.type(text);
      await delay(40);
    };
    await key("/credentials set\r");
    await waitFor(() => tty.output().includes("✎ store a credential, 1/2: reference"));
    await key("openai\r");
    await waitFor(() => tty.output().includes("✎ store a credential, 2/2: value (hidden)"));
    // Typed and pasted, the value is bullets on screen; its keys are the form's.
    await key("sk-live-");
    tty.paste("abcdef123456\n");
    await waitFor(() => tty.output().includes("value ❯ ••••••••••••••••••••"));
    await key("\r");
    await waitFor(() => tty.output().includes("✓ credential openai stored"));
    expect(client.requests.find((request) => request.command === "credentials")?.payload).toEqual({
      action: "set",
      reference: "openai",
      value: "sk-live-abcdef123456",
    });
    expect(tty.output()).not.toContain("sk-live");
    expect(tty.output()).not.toContain("abcdef123456");
    expect(client.runs).toEqual([]);
    tty.type(CTRL_C);
    await done;
  });

  it("refuses a credential typed as a prompt, pointing at its form, and sends it nowhere", async () => {
    const client = new ScriptedClient();
    const { tty, done } = chatOver(client);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("use this key: sk-live-abcdef123456\r");
    await waitFor(() =>
      tty.output().includes("✗ That looks like a credential, so it was not sent or shown. Store it with /credentials set <reference>"),
    );
    expect(client.runs).toEqual([]);
    // Refused before it was echoed: the prompt line never went into the transcript.
    expect(tty.output()).not.toContain("❯ use this key");
    // After a command's word too — a form's, or a typo's — before any refusal could echo it.
    const refusals = () => tty.output().split("That looks like a credential").length - 1;
    tty.type("/credentials set openai sk-live-abcdef123456\r");
    await waitFor(() => refusals() === 2);
    tty.type("/credentials add openai sk-live-abcdef123456\r");
    await waitFor(() => refusals() === 3);
    expect(tty.output()).not.toContain("sk-live");
    expect(asked(client)).toEqual([]);
    // Typed a key at a time, it is masked in the prompt row before Enter too —
    // from the moment it has a key's shape (`sk-` and six more).
    const before = tty.output().length;
    for (const key of "sk-live-abcdef") {
      tty.type(key);
      await delay(5);
    }
    await waitFor(() => tty.output().includes("❯ ••••••••••••••"));
    expect(tty.output().slice(before)).not.toContain("sk-live-a");
    tty.type(CTRL_C);
    await done;
  });

  it("sets the default from a form's words at once, says a restart is needed, asks a field again, and cancels with Esc", async () => {
    const client = new ScriptedClient();
    client.answers = {
      models: (payload) => {
        const action = (payload as { action: string }).action;
        if (action === "set-default") return { ok: true, result: { result: {}, restartRequired: true } };
        if (action === "test")
          return { ok: true, result: { connectionId: "local", modelId: "llama3", ok: true, capabilities: ["chat"], latencyMs: 12 } };
        return { ok: false, error: { code: "UNSUPPORTED", message: action } };
      },
    };
    const { tty, done } = chatOver(client);
    await waitFor(() => tty.output().includes("Type a prompt"));
    const key = async (text: string) => {
      tty.type(text);
      await delay(40);
    };
    await key("/models set-default local llama3\r");
    await waitFor(() => tty.output().includes("✓ the workspace's default model is local/llama3"));
    expect(tty.output()).toContain("⚠ restart `tavi serve` for this to take effect");
    expect(asked(client)[0]?.payload).toEqual({ action: "set-default", workspaceId: "default", connectionId: "local", model: "llama3" });

    // A role no one has is asked again; Esc cancels, and nothing is sent.
    await key("/models set-role\r");
    await waitFor(() => tty.output().includes("✎ bind a role to a model, 1/3: role"));
    await key("chief\r");
    await waitFor(() => tty.output().includes("✗ role must be one of"));
    // A connection id that is none — a key pasted there, say — is asked again, never echoed.
    await key("main\r");
    await waitFor(() => tty.output().includes("2/3: connection id"));
    await key("Not A Connection!\r");
    await waitFor(() => tty.output().includes("✗ connectionId must be a connection id like openai or local"));
    expect(tty.output()).not.toContain(
      "✗ connectionId must be a connection id like openai or local (lower-case letters, digits, . _ -) Not",
    );
    await key(String.fromCharCode(27));
    await waitFor(() => tty.output().includes("… bind a role to a model: cancelled, nothing was sent"));
    expect(asked(client)).toHaveLength(1);

    await key("/models test local\r");
    await waitFor(() => tty.output().includes("✓ local/llama3 answered in 12 ms; observed: chat"));
    tty.type(CTRL_C);
    await done;
  });

  it("keeps a form's keys its own while a round is offered: none decides the round", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "approval.required", {
          callId: "call-a",
          toolName: "fs.write",
          summary: "Write notes.md?",
          input: {},
          steps: 1,
          approvalId: "approval-a",
          effect: "mutating",
        }),
      ],
    };
    client.answers = {
      approvals: () => ({
        ok: true,
        result: {
          rows: [
            {
              record: { approvalId: "approval-a", taskId: "task-1", callId: "call-a", toolId: "fs.write", steps: 1, createdAt: AT },
              task: {},
            },
          ],
          truncated: false,
        },
      }),
      approve: () => ({ ok: true, result: {} }),
      credentials: () => ({ ok: true, result: { stored: "yandex" } }),
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("round 1: y approves it"));
    const key = async (text: string) => {
      tty.type(text);
      await delay(40);
    };
    await key("/credentials set\r");
    await waitFor(() => tty.output().includes("✎ store a credential"));
    // One chunk answering both fields, and more after the form is done: that is dropped.
    await key("yandex\rnyny\ry");
    await waitFor(() => tty.output().includes("✓ credential yandex stored"));
    expect(client.requests.filter((request) => request.command === "approve")).toEqual([]);
    // The form done, the round's keys are back.
    await key("y");
    await waitFor(() => client.requests.some((request) => request.command === "approve"));
    tty.type(CTRL_C);
    await done;
  });

  it("sends a review for every flagged artifact at once, naming the round, and resuming", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "task.review_required", {
          steps: 2,
          requests: [
            { artifactId: "artifact-1", toolName: "sandbox.run", callId: "call-a" },
            { artifactId: "artifact-2", toolName: "sandbox.run", callId: "call-b" },
          ],
        }),
      ],
    };
    client.answers = { review: () => ({ ok: true, result: {} }) };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("y releases all of it"));
    tty.type("y");
    await waitFor(() => tty.output().includes("releasing the output, as operator"));
    expect(client.requests.filter((request) => request.command === "review").map((request) => request.payload)).toEqual([
      {
        taskId: "task-1",
        workspaceId: "default",
        expectedSteps: 2,
        decisions: [
          { artifactId: "artifact-1", approved: true },
          { artifactId: "artifact-2", approved: true },
        ],
        reviewedBy: "operator",
        resume: true,
      },
    ]);
    tty.type(CTRL_C);
    await done;
  });

  it("shows a round a schedule's fire answers read-only, and offers it once the owner says the fire has ended", async () => {
    const client = new ScriptedClient();
    let subscriptions = 0;
    const firing = { roundsAnsweredBy: "owner" as const, schedule: { scheduleId: "sched-1", name: "morning-brief" } };
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: false, ...firing },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "approval.required", {
          callId: "call-a",
          toolName: "fs.write",
          summary: "Write notes.md?",
          input: {},
          steps: 1,
          approvalId: "approval-a",
          effect: "mutating",
        }),
      ],
    };
    const original = client.subscribe.bind(client);
    client.subscribe = (taskId, options) => {
      subscriptions += 1;
      // The first probes find the fire still running; then it ends, and the rounds are left to a client.
      if (subscriptions > 1) client.subscribed = { result: { replayed: 0, resync: false, truncated: false, ...firing }, events: [] };
      if (subscriptions > 3)
        client.subscribed = { result: { replayed: 0, resync: false, truncated: false, roundsAnsweredBy: "client" }, events: [] };
      return original(taskId, options);
    };
    client.answers = {
      approvals: () => ({
        ok: true,
        result: {
          rows: [
            {
              record: { approvalId: "approval-a", taskId: "task-1", callId: "call-a", toolId: "fs.write", steps: 1, createdAt: AT },
              task: {},
            },
          ],
          truncated: false,
        },
      }),
      approve: () => ({ ok: true, result: {} }),
    };
    const tty = fakeTty({ rows: 24, columns: 200 });
    const done = runChat(
      { workspaceId: "default", principalId: "operator", dataDirectory: "/scripted", attach: "task-1" },
      { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined },
      CODES,
      { connect: () => Promise.resolve(client), probeMs: 50 },
    );
    await waitFor(() => tty.output().includes("schedule morning-brief's fire decides it while it runs"));
    // No key while the fire runs: approve would refuse it.
    tty.type("y");
    await delay(30);
    expect(client.requests.filter((request) => request.command === "approve")).toHaveLength(0);
    await waitFor(() => subscriptions >= 3);
    // Still running at the last look: nothing changed, and every probe was let go.
    expect(tty.output()).not.toContain("fire has ended");
    await waitFor(() => tty.output().includes("fire has ended"));
    expect(client.closedSubscriptions.length).toBeGreaterThanOrEqual(3);
    await waitFor(() => tty.output().includes("y approves it"));
    expect(tty.output().split("fire has ended")).toHaveLength(2);
    tty.type("y");
    await waitFor(() => client.requests.filter((request) => request.command === "approve").length === 1);
    tty.type(CTRL_C);
    await done;
  });

  it("says why a review was refused, names what is left, and does not offer the same keys again", async () => {
    const client = new ScriptedClient();
    client.subscribed = {
      result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
      events: [
        event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
        event(1, "task.review_required", { steps: 2, requests: [{ artifactId: "artifact-1", toolName: "sandbox.run", callId: "call-a" }] }),
      ],
    };
    client.answers = {
      review: () => ({ ok: false, error: { code: "CONFLICT", message: "Artifact artifact-1 was already rejected; nothing was decided" } }),
    };
    const { tty, done } = chatOver(client, { attach: "task-1" });
    await waitFor(() => tty.output().includes("y releases all of it"));
    tty.type("y");
    await waitFor(() => tty.output().includes("✗ The review was refused"));
    expect(tty.output()).toContain("Decide what is left artifact by artifact");
    tty.type("y");
    await delay(60);
    expect(client.requests.filter((request) => request.command === "review")).toHaveLength(1);
    tty.type(CTRL_C);
    await done;
  });

  describe("answering an attached task's question", () => {
    const waitingOnQuestion = (client: ScriptedClient, origin: string): void => {
      client.subscribed = {
        result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
        events: [
          event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
          event(1, "task.waiting", {
            on: "the operator's answer",
            deadlineAt: "2026-09-20T00:00:00.000Z",
            question: "Which one?",
            waitId: "wait-1",
          }),
        ],
      };
      client.answers.tasks = () => ({
        ok: true,
        result: {
          task: { status: "waiting", origin },
          admissions: [
            {
              admissionId: "admission-1",
              taskId: "task-1",
              operationKey: "op-ipc-1",
              kind: "start",
              state: "committed",
              result: null,
              createdAt: AT,
              updatedAt: AT,
            },
          ],
        },
      });
    };

    it("sends an answer the owner did not answer in time once more, and the next answer as the same message", async () => {
      const client = new ScriptedClient();
      waitingOnQuestion(client, "ipc");
      client.answers.reply = () => ({ ok: false, error: { code: CLIENT_TIMEOUT, message: "slow" } });
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("Type the answer and press Enter."));
      tty.type("acme\r");
      await waitFor(() => tty.output().includes("the answer may have been recorded"));
      tty.type("globex\r");
      // Each answer sent and resent: four sends, the owner silent throughout.
      await waitFor(() => client.requests.filter((request) => request.command === "reply").length === 4);
      const ids = client.requests
        .filter((request) => request.command === "reply")
        .map((request) => (request.payload as { clientMessageId: string }).clientMessageId);
      // One message throughout — the owner records it once, whichever arrives.
      expect(new Set(ids).size).toBe(1);
      expect(tty.output()).not.toContain("The answer was not sent");
      tty.type(CTRL_C);
      await done;
    });

    it("offers typing for an IPC-started task, in its start's conversation", async () => {
      const client = new ScriptedClient();
      waitingOnQuestion(client, "ipc");
      client.answers.reply = () => ({ ok: true, result: { taskId: "task-1", conversationId: "op-ipc-1", duplicate: false } });
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("Type the answer and press Enter."));
      tty.type("acme\r");
      await waitFor(() => client.requests.some((request) => request.command === "reply"));
      expect(client.requests.find((request) => request.command === "reply")?.payload).toMatchObject({
        workspaceId: "default",
        conversationId: "op-ipc-1",
        text: "acme",
      });
      tty.type(CTRL_C);
      await done;
    });

    it("takes a command while the question is offered, never as the answer", async () => {
      const client = new ScriptedClient();
      waitingOnQuestion(client, "ipc");
      client.answers.reply = () => ({ ok: true, result: { taskId: "task-1", conversationId: "op-ipc-1", duplicate: false } });
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("Type the answer and press Enter."));
      tty.type("/help\r");
      await waitFor(() => tty.output().includes("─ commands ─"));
      tty.type("/nope\r");
      await waitFor(() => tty.output().includes("✗ no command /nope"));
      expect(client.requests.filter((request) => request.command === "reply")).toEqual([]);
      // The question is still offered: the next line is the answer.
      tty.type("acme\r");
      await waitFor(() => client.requests.some((request) => request.command === "reply"));
      tty.type(CTRL_C);
      await done;
    });

    it("keeps a form's half-typed value when the question goes away, and closes the form when the owner does", async () => {
      const client = new ScriptedClient();
      waitingOnQuestion(client, "ipc");
      client.answers.credentials = () => ({ ok: true, result: { stored: "openai" } });
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => tty.output().includes("Type the answer and press Enter."));
      const key = async (text: string) => {
        tty.type(text);
        await delay(40);
      };
      await key("/credentials set openai\r");
      await waitFor(() => tty.output().includes("value (hidden)"));
      await key("sk-live-abc");
      // The question is answered elsewhere: the task's resumed turn starts.
      client.emit(event(2, "run.started", { threadId: "thread-1", workspaceId: "default" }));
      await waitFor(() => !tty.output().split("value (hidden)").at(-1)!.includes("Type the answer"));
      await delay(60);
      await key("def123456\r");
      await waitFor(() => client.requests.some((request) => request.command === "credentials"));
      expect(client.requests.find((request) => request.command === "credentials")?.payload).toMatchObject({
        value: "sk-live-abcdef123456",
      });

      // A form open when the owner goes: closed, and the chat's ending shows.
      await key("/credentials set other\r");
      await waitFor(() => tty.output().includes("✎ store a credential, 2/2"));
      client.become("closed");
      await waitFor(() => tty.output().includes("✗ the owner did not come back"));
      expect(tty.output()).not.toContain("sk-live");
      tty.type(CTRL_C);
      await done;
    });

    it("offers none for a task another chat started: it is answered there", async () => {
      const client = new ScriptedClient();
      waitingOnQuestion(client, "messaging");
      const { tty, done } = chatOver(client, { attach: "task-1" });
      await waitFor(() => client.requests.some((request) => request.command === "tasks"));
      await delay(60);
      expect(tty.output()).toContain("It waits for the answer in the conversation it was asked in.");
      expect(tty.output()).not.toContain("Type the answer");
      tty.type("acme\r");
      await delay(60);
      // Neither answered nor a new run: typing waits for the prompt the run's end frees.
      expect(client.requests.filter((request) => request.command === "reply")).toHaveLength(0);
      expect(client.runs).toHaveLength(0);
      tty.type(CTRL_C);
      await done;
    });

    it("stops offering when the owner finds no conversation, offers again after another refusal, and unlocks a recorded answer that does not resume", async () => {
      const client = new ScriptedClient();
      waitingOnQuestion(client, "ipc");
      const refusals = [
        { ok: false, error: { code: "UNAVAILABLE", message: "the local connection is closing" } },
        { ok: true, result: { taskId: "task-1", conversationId: "op-ipc-1", duplicate: false } },
        { ok: false, error: { code: "NOT_FOUND", message: "no conversation op-ipc-1" } },
      ];
      client.answers.reply = () => refusals.shift() ?? { ok: false, error: { code: "NOT_FOUND", message: "none" } };
      const tty = fakeTty({ rows: 24, columns: 200 });
      const done = runChat(
        { workspaceId: "default", principalId: "operator", dataDirectory: "/scripted", attach: "task-1" },
        { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined },
        CODES,
        { connect: () => Promise.resolve(client), answerSettleMs: 50 },
      );
      await waitFor(() => tty.output().includes("Type the answer and press Enter."));
      // Refused for a passing reason: offered again.
      tty.type("acme\r");
      await waitFor(() => tty.output().includes("✗ The answer was not sent: UNAVAILABLE"));
      // Recorded, but the task never resumes: unlocked, not left "sending".
      tty.type("acme\r");
      await waitFor(() => tty.output().includes("the answer was recorded, but the chat has not resumed yet"));
      // The owner finds no conversation: the offer stops.
      tty.type("acme\r");
      await waitFor(() => tty.output().includes("✗ The answer was not sent: NOT_FOUND"));
      tty.type("again\r");
      await delay(60);
      expect(client.requests.filter((request) => request.command === "reply")).toHaveLength(3);
      tty.type(CTRL_C);
      await done;
    });
  });

  it("says the owner refused this client's frames, rather than that it went away", async () => {
    const client = new ScriptedClient();
    const { tty, done } = chatOver(client);
    await waitFor(() => tty.output().includes("Type a prompt"));
    client.become("closed", unreadableFrameError("event.protocolVersion: expected 3"));
    await waitFor(() => tty.output().includes("cannot read"));
    expect(tty.output()).not.toContain("did not come back");
    tty.type(CTRL_C);
    await done;
  });

  describe("with Home on", () => {
    const HOME_RECORD = {
      ok: true,
      result: {
        found: true,
        task: { taskId: "home-1", workspaceId: "default", status: "completed", origin: "ipc", chatKind: "home", principalId: "operator" },
        admissions: [
          {
            admissionId: "admission-h",
            taskId: "home-1",
            operationKey: "op-home",
            kind: "start",
            state: "committed",
            result: { status: "completed" },
            createdAt: AT,
            updatedAt: AT,
          },
        ],
      },
    };
    const TASK_RECORD = {
      ok: true,
      result: {
        found: true,
        task: { taskId: "task-1", workspaceId: "default", status: "completed", origin: "ipc" },
        admissions: [
          {
            admissionId: "admission-1",
            taskId: "task-1",
            operationKey: "op-1",
            kind: "start",
            state: "committed",
            result: { status: "completed" },
            createdAt: AT,
            updatedAt: AT,
          },
        ],
      },
    };
    const row = (taskId: string, extra: Record<string, unknown>) => ({
      taskId,
      workspaceId: "default",
      status: "completed",
      origin: "ipc",
      createdAt: AT,
      updatedAt: AT,
      needs: [],
      counts: { admissions: 1, tools: 0 },
      ...extra,
    });
    const HOME_ROW = row("home-1", { chatKind: "home", principalId: "operator", title: "Home" });
    const SAVED = {
      taskId: "home-1",
      seq: 1,
      turn: {
        admissionKind: "start",
        prompt: "what is on today?",
        items: [{ kind: "text", text: "Two meetings, one *in person*." }],
        outcome: { status: "completed", finalText: "Two meetings, one *in person*." },
      },
      createdAt: AT,
    };
    /** An owner whose workspace has `chat.home` set `on`, and — with `home` — the person's Home, home-1, settled. */
    const homeOwner = ({ on = true, home = true }: { readonly on?: boolean; readonly home?: boolean } = {}) => {
      const client = new ScriptedClient();
      client.answers["workspace-settings"] = () => ({ ok: true, result: { effective: { homeChat: on } } });
      client.answers.tasks = (payload) => {
        const asked = payload as { action?: string; taskId?: string; chatKinds?: string[] };
        if (asked.action === "list") {
          const homeOnly = asked.chatKinds?.length === 1 && asked.chatKinds[0] === "home";
          const rows = homeOnly
            ? home
              ? [HOME_ROW]
              : []
            : [row("side-1", { title: "plan a trip", chatKind: "side" }), ...(home ? [HOME_ROW] : [])];
          return { ok: true, result: { action: "list", rows, truncated: false } };
        }
        if (asked.action === "transcript") return { ok: true, result: { entries: asked.taskId === "home-1" ? [SAVED] : [] } };
        return asked.taskId === "home-1" ? HOME_RECORD : TASK_RECORD;
      };
      client.answers.reply = () => ({ ok: true, result: { recorded: true } });
      return client;
    };
    /** A run the owner admits as `taskId`, which completes at once. */
    const admits = (taskId: string) => (callbacks: Parameters<ScriptedClient["runAnswers"][number]>[0]) => {
      queueMicrotask(() => {
        callbacks.onEvent(
          ClientEventSchema.parse({
            ...BASE,
            runId: taskId,
            sequence: 0,
            attemptId: "attempt-1",
            kind: "run.started",
            threadId: "thread-1",
            workspaceId: "default",
          }),
        );
        callbacks.onEvent(
          ClientEventSchema.parse({ ...BASE, runId: taskId, sequence: 1, attemptId: "attempt-1", kind: "task.completed", finalText: "…" }),
        );
      });
      return {
        response: { ok: true, result: { taskId, subscriptionId: `sub-${taskId}`, conversationId: `op-${taskId}` } },
        subscription: subscription(taskId),
      };
    };
    const replies = (client: ScriptedClient) =>
      client.requests
        .filter((request) => request.command === "reply")
        .map((request) => request.payload as { conversationId: string; text: string });

    it("opens on the person's Home: its newest saved turns, then a prompt continues it", async () => {
      const client = homeOwner();
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      const listed = client.requests.find(
        (request) => request.command === "tasks" && (request.payload as { action?: string }).action === "list",
      )?.payload;
      expect(listed).toEqual({ action: "list", workspaceId: "default", chatKinds: ["home"], principalId: "operator", limit: 1 });
      expect(tty.output()).toContain("❯ what is on today?");
      // A saved answer's Markdown emphasis shows as its words, as a live one does.
      expect(tty.output()).toContain("Two meetings, one in person.");
      tty.type("and tomorrow?\r");
      await waitFor(() => replies(client).length === 1);
      expect(replies(client)[0]).toMatchObject({ conversationId: homeConversationId("operator"), text: "and tomorrow?" });
      expect(client.runs).toHaveLength(0);
      tty.type(CTRL_C);
      await done;
    });

    it("sends the first prompt to Home when there is none yet, which begins it", async () => {
      const client = homeOwner({ home: false });
      client.runAnswers = [admits("home-new")];
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("Type a message for Home"));
      tty.type("hello\r");
      await waitFor(() => tty.output().includes("✓ Done."));
      expect(client.runs[0]).toMatchObject({ prompt: "hello", target: "home" });
      tty.type(CTRL_C);
      await done;
    });

    it("starts a side chat with /side — its topic the first prompt — and goes back with /home", async () => {
      const client = homeOwner();
      client.runAnswers = [admits("side-1")];
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/side plan a trip\r");
      await waitFor(() => tty.output().includes("✓ Done."));
      // A side chat of the chat it left: Home is its parent, and it has no target.
      expect(client.runs[0]?.prompt).toBe("plan a trip");
      expect(client.runs[0]?.target).toBeUndefined();
      expect(client.runs[0]?.parentChatId).toBe("home-1");
      tty.type("/home\r");
      await waitFor(() => tty.output().split("… type to continue Home").length === 3);
      tty.type("back home\r");
      await waitFor(() => replies(client).length === 1);
      expect(replies(client)[0]?.conversationId).toBe(homeConversationId("operator"));
      tty.type(CTRL_C);
      await done;
    });

    it("runs /new as /side with Home on, saying so", async () => {
      const client = homeOwner();
      client.runAnswers = [admits("side-2")];
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/new\r");
      await waitFor(() => tty.output().includes("/new does what /side does"));
      expect(tty.output()).toContain("the next prompt starts a side chat");
      tty.type("something else\r");
      await waitFor(() => client.runs.length === 1);
      expect(client.runs[0]?.target).toBeUndefined();
      expect(client.runs[0]?.parentChatId).toBe("home-1");
      expect(replies(client)).toHaveLength(0);
      tty.type(CTRL_C);
      await done;
    });

    it("lists the recent chats with /chats, Home first, and continues one with /open", async () => {
      const client = homeOwner();
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/chats\r");
      await waitFor(() => tty.output().includes("/open <task-id> continues one; /home goes back to Home"));
      const output = tty.output();
      expect(output).toContain("❯ home-1  Home  completed       Home");
      expect(output.indexOf("home-1  Home")).toBeLessThan(output.indexOf("side-1  side"));
      const listed = client.requests
        .filter((request) => request.command === "tasks" && (request.payload as { action?: string }).action === "list")
        .at(-1)?.payload;
      expect((listed as { chatKinds?: string[] }).chatKinds).not.toContain("worker");
      client.subscribed = {
        result: { replayed: 2, resync: false, truncated: false, roundsAnsweredBy: "client" },
        events: [
          event(0, "run.started", { threadId: "thread-1", workspaceId: "default" }),
          event(1, "task.completed", { finalText: "done" }),
        ],
      };
      tty.type("/open task-1\r");
      await waitFor(() => tty.output().includes("✓ Done."));
      // Its later subscriptions replay nothing: a continuation follows it from now.
      client.subscribed = { result: { replayed: 0, resync: false, truncated: false, roundsAnsweredBy: "client" }, events: [] };
      tty.type("carry on\r");
      await waitFor(() => replies(client).length === 1);
      expect(replies(client)[0]?.conversationId).toBe("op-1");
      tty.type(CTRL_C);
      await done;
    });

    it("asks for fresh context for the chat shown on /compact", async () => {
      const client = homeOwner();
      client.answers["chat-context"] = (payload) => ({
        ok: true,
        result: { taskId: (payload as { taskId: string }).taskId, freshContext: "next-message" },
      });
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/compact\r");
      await waitFor(() => tty.output().includes("fresh context: your next message starts a new epoch"));
      expect(client.requests.filter((request) => request.command === "chat-context").map((request) => request.payload)).toEqual([
        { action: "compact", taskId: "home-1", workspaceId: "default" },
      ]);
      expect(client.runs).toHaveLength(0);
      expect(replies(client)).toHaveLength(0);
      tty.type(CTRL_C);
      await done;
    });

    it("names the chat shown's model on /model, and sets it — and the default — with one named", async () => {
      const client = homeOwner();
      client.answers["models"] = (payload) => {
        const action = (payload as { action: string }).action;
        if (action === "chat")
          return { ok: true, result: { taskId: "home-1", target: { connectionId: "or", model: "fast" }, source: "chosen" } };
        if (action === "set-chat") return { ok: true, result: { result: {}, restartRequired: false } };
        if (action === "set-default") return { ok: false, error: { code: "CONFLICT", message: "busy" } };
        return { ok: true, result: {} };
      };
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/model\r");
      await waitFor(() => tty.output().includes("… this chat runs or/fast"));
      tty.type("/model or slow\r");
      await waitFor(() => tty.output().includes("… this chat runs or/slow; it could not be made the default for new chats: busy"));
      expect(client.requests.filter((request) => request.command === "models").map((request) => request.payload)).toEqual([
        { workspaceId: "default", action: "chat", taskId: "home-1" },
        { workspaceId: "default", action: "set-chat", taskId: "home-1", connectionId: "or", model: "slow" },
        { workspaceId: "default", action: "set-default", connectionId: "or", model: "slow" },
      ]);
      tty.type("/model or\r");
      await waitFor(() => tty.output().includes("✗ no command /model or"));
      tty.type(CTRL_C);
      await done;
    });

    it("shows the chat shown's folder on /folder, and changes it with set, add, drop and reset", async () => {
      const client = homeOwner();
      const view = (fields: Record<string, unknown> = {}) => ({
        ok: true,
        result: {
          taskId: "home-1",
          revision: 1,
          managed: "/data/chats/default/home-1",
          primary: { kind: "managed", path: "/data/chats/default/home-1", label: "Chat files" },
          attachments: [],
          ...fields,
        },
      });
      client.answers["folder"] = (payload) => {
        const action = (payload as { action: string }).action;
        if (action === "show") return view();
        if (action === "set") return view({ revision: 2, primary: { kind: "host", path: "/work/app", label: "app" } });
        if (action === "attach") return view({ revision: 3, attachments: [{ path: "/work/lib", mode: "rw", label: "lib" }] });
        if (action === "detach") return { ok: false, error: { code: "NOT_FOUND", message: 'This chat has no attached folder "nope"' } };
        return view({ revision: 5 });
      };
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/folder\r");
      await waitFor(() => tty.output().includes("… this chat works in its own folder, /data/chats/default/home-1"));
      tty.type("/folder set ~/work/app\r");
      await waitFor(() => tty.output().includes("… from its next message, this chat works in /work/app"));
      tty.type("/folder add lib dir --rw\r");
      await waitFor(() => tty.output().includes("read-write"));
      tty.type("/folder drop nope\r");
      await waitFor(() => tty.output().includes('✗ this chat\'s folder was not changed: This chat has no attached folder "nope"'));
      tty.type("/folder reset\r");
      await waitFor(() => client.requests.filter((request) => request.command === "folder").length === 5);
      tty.type("/folder sideways\r");
      await waitFor(() => tty.output().includes("✗ no command /folder sideways"));
      // A path is this terminal's: `~` is the home folder, a relative path this directory's.
      expect(client.requests.filter((request) => request.command === "folder").map((request) => request.payload)).toEqual([
        { action: "show", workspaceId: "default", taskId: "home-1" },
        { action: "set", folder: { path: join(homedir(), "work/app") }, workspaceId: "default", taskId: "home-1" },
        { action: "attach", folder: { path: join(process.cwd(), "lib dir") }, mode: "rw", workspaceId: "default", taskId: "home-1" },
        { action: "detach", label: "nope", workspaceId: "default", taskId: "home-1" },
        { action: "reset", workspaceId: "default", taskId: "home-1" },
      ]);
      tty.type(CTRL_C);
      await done;
    });

    it("sends this terminal's directory with /side, never with a message to Home, and prints why it was not used (decisions e, g)", async () => {
      const client = homeOwner({ home: false });
      // Its events after its answer, as the owner sends them: the answer carries the folder's note.
      const noted = (taskId: string) => (callbacks: Parameters<ScriptedClient["runAnswers"][number]>[0]) => {
        const answer = admits(taskId)({ ...callbacks, onEvent: (event) => setTimeout(() => callbacks.onEvent(event), 20) });
        return {
          ...answer,
          response: {
            ...answer.response,
            result: { ...answer.response.result, folder: { kind: "managed", note: "Not under an --fs-root" } },
          },
        };
      };
      client.runAnswers = [admits("home-new"), noted("side-1")];
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("Type a message for Home"));
      tty.type("hello\r");
      await waitFor(() => tty.output().includes("✓ Done."));
      const beforeSide = tty.output().length;
      tty.type("/side plan a trip\r");
      await waitFor(() => tty.output().slice(beforeSide).includes("✓ Done."));
      expect(client.runs[0]).toMatchObject({ target: "home" });
      expect(client.runs[0]).not.toHaveProperty("clientCwd");
      expect(client.runs[1]).toMatchObject({ prompt: "plan a trip", parentChatId: "home-new", clientCwd: process.cwd() });
      await waitFor(() => tty.output().includes("… Not under an --fs-root"));
      tty.type(CTRL_C);
      await done;
    });

    it("on /model, says when role main outranks the default, and sets no default after a refused chat model", async () => {
      const client = homeOwner();
      let refuseChat = false;
      client.answers["models"] = (payload) => {
        const action = (payload as { action: string }).action;
        if (action === "chat") return { ok: true, result: { taskId: "home-1", target: null, source: "chosen" } };
        if (action === "set-chat")
          return refuseChat
            ? { ok: false, error: { code: "NOT_CONFIGURED", message: "no configured connection offers or/gone" } }
            : { ok: true, result: { result: {}, restartRequired: false } };
        if (action === "roles") return { ok: true, result: { activeTarget: { connectionId: "or", model: "main" } } };
        return { ok: true, result: { result: {}, restartRequired: false } };
      };
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/model\r");
      await waitFor(() => tty.output().includes("✗ this chat's model is offered by no connection now"));
      tty.type("/model or slow\r");
      await waitFor(() =>
        tty.output().includes("… this chat runs or/slow; new chats run or/main, which role main or the owner's own flags choose"),
      );
      refuseChat = true;
      const before = client.requests.length;
      tty.type("/model or gone\r");
      await waitFor(() => tty.output().includes("✗ this chat's model was not set: no configured connection offers or/gone"));
      expect(
        client.requests
          .slice(before)
          .filter((request) => request.command === "models")
          .map((request) => (request.payload as { action: string }).action),
      ).toEqual(["set-chat"]);
      tty.type(CTRL_C);
      await done;
    });

    it("says why fresh context was not set when the owner refuses it", async () => {
      const client = homeOwner();
      client.answers["chat-context"] = () => ({
        ok: false,
        error: { code: "UNSUPPORTED", message: "This owner cannot start a fresh context" },
      });
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/compact\r");
      await waitFor(() => tty.output().includes("✗ fresh context was not set: This owner cannot start a fresh context"));
      tty.type(CTRL_C);
      await done;
    });

    /** A run the owner admits as `taskId` and leaves running: `finish` ends it. */
    const running = (taskId: string) => {
      let onEvent: ((event: ClientEvent) => void) | undefined;
      const at = (sequence: number, kind: string, fields: Record<string, unknown> = {}) =>
        ClientEventSchema.parse({ ...BASE, runId: taskId, sequence, attemptId: "attempt-1", kind, ...fields });
      return {
        answer: (callbacks: Parameters<ScriptedClient["runAnswers"][number]>[0]) => {
          onEvent = (event) => callbacks.onEvent(event);
          queueMicrotask(() => onEvent?.(at(0, "run.started", { threadId: "thread-1", workspaceId: "default" })));
          return {
            response: { ok: true, result: { taskId, subscriptionId: `sub-${taskId}`, conversationId: `op-${taskId}` } },
            subscription: subscription(taskId),
          };
        },
        finish: () => onEvent?.(at(1, "task.completed", { finalText: "…" })),
        /** One more event of the running turn, on its stream. */
        send: (event: ClientEvent) => onEvent?.(event),
        at,
      };
    };

    it("leaves a running turn for Home with /home: it goes on at the owner, and what was queued behind it is dropped", async () => {
      const client = homeOwner();
      const side = running("side-a");
      client.runAnswers = [side.answer];
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/side first\r");
      await waitFor(() => tty.output().includes("● running side-a"));
      tty.type("queued one\r");
      await waitFor(() => tty.output().includes("… queued: sends after this turn"));
      tty.type("/home\r");
      await waitFor(() => tty.output().split("… type to continue Home").length === 3);
      expect(tty.output()).toContain("1 queued prompt was not sent: they were for the chat left");
      expect(tty.output()).toContain("chat side-a goes on at the owner; /open side-a follows it again");
      // The turn left ends unseen: its queued prompt is never sent.
      side.finish();
      await delay(50);
      expect(client.runs).toHaveLength(1);
      expect(replies(client)).toHaveLength(0);
      tty.type(CTRL_C);
      await done;
    });

    it("keeps a /side typed during a turn for the prompt after the one queued before it", async () => {
      const client = homeOwner();
      const side = running("side-a");
      client.runAnswers = [side.answer, admits("side-b")];
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/side first\r");
      await waitFor(() => tty.output().includes("● running side-a"));
      tty.type("A\r");
      await waitFor(() => tty.output().includes("… queued: sends after this turn"));
      tty.type("/side\r");
      await waitFor(() => tty.output().includes("the next prompt starts a side chat"));
      side.finish();
      // A continues the chat it was queued behind.
      await waitFor(() => replies(client).length === 1);
      expect(replies(client)[0]).toMatchObject({ conversationId: "op-side-a", text: "A" });
      client.emit(side.at(2, "task.completed", { finalText: "…" }));
      await waitFor(() => tty.output().includes("Type a prompt for a side chat"));
      tty.type("B\r");
      await waitFor(() => client.runs.length === 2);
      // Its parent is the chat shown when /side was typed, not the one the prompt was sent after.
      expect(client.runs[0]?.parentChatId).toBe("home-1");
      expect(client.runs[1]).toMatchObject({ prompt: "B", parentChatId: "side-a" });
      expect(client.runs[1]?.target).toBeUndefined();
      expect(replies(client)).toHaveLength(1);
      tty.type(CTRL_C);
      await done;
    });

    it("sends /steer into the running turn, and shows it there once the turn takes it", async () => {
      const client = homeOwner();
      const side = running("side-a");
      client.runAnswers = [side.answer];
      client.answers.reply = (payload) => ({
        ok: true,
        result: { taskId: (payload as { taskId: string }).taskId, conversationId: "op-side-a", duplicate: false, steered: true },
      });
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/side first\r");
      await waitFor(() => tty.output().includes("● running side-a"));
      tty.type("/steer use metres\r");
      await waitFor(() => tty.output().includes("… sent into the running turn"));
      const sent = client.requests
        .filter((request) => request.command === "reply")
        .map((request) => request.payload as { taskId?: string; text: string; intent?: string; clientMessageId: string });
      expect(sent).toEqual([expect.objectContaining({ taskId: "side-a", text: "use metres", intent: "steer" })]);
      // Not queued: nothing waits for the turn to end.
      expect(tty.output()).not.toContain("… queued: sends after this turn");
      side.send(side.at(1, "turn.steered", { messageId: sent[0]?.clientMessageId, text: "use metres" }));
      await waitFor(() => tty.output().includes("❯ use metres (sent into the turn)"));
      side.send(side.at(2, "task.completed", { finalText: "in metres" }));
      await waitFor(() => tty.output().includes("✓ Done."));
      tty.type(CTRL_C);
      await done;
    });

    it("sends /steer with no turn running as a message like any other", async () => {
      const client = homeOwner();
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("… type to continue Home"));
      tty.type("/steer hello there\r");
      await waitFor(() => replies(client).length === 1);
      expect(replies(client)[0]).toMatchObject({ text: "hello there" });
      expect((replies(client)[0] as { intent?: string }).intent).toBeUndefined();
      tty.type(CTRL_C);
      await done;
    });

    it("takes a refused settings read as Home off", async () => {
      const client = homeOwner();
      client.answers["workspace-settings"] = () => ({ ok: false, error: { code: "UNAVAILABLE", message: "busy" } });
      client.runAnswers = [admits("task-9")];
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("Type a prompt"));
      expect(client.requests.some((request) => request.command === "tasks")).toBe(false);
      tty.type("hello\r");
      await waitFor(() => tty.output().includes("✓ Done."));
      expect(client.runs[0]?.target).toBeUndefined();
      tty.type(CTRL_C);
      await done;
    });

    it("still sends to Home when its list is refused, or it cannot be followed", async () => {
      const unlisted = homeOwner();
      const listed = unlisted.answers.tasks;
      unlisted.answers.tasks = (payload) =>
        (payload as { action?: string }).action === "list"
          ? { ok: false, error: { code: "UNAVAILABLE", message: "busy" } }
          : listed!(payload);
      unlisted.runAnswers = [admits("home-1")];
      const first = chatOver(unlisted);
      await waitFor(() => first.tty.output().includes("Type a message for Home"));
      first.tty.type("hello\r");
      await waitFor(() => unlisted.runs.length === 1);
      expect(unlisted.runs[0]).toMatchObject({ prompt: "hello", target: "home" });
      first.tty.type(CTRL_C);
      await first.done;

      const unfollowed = homeOwner();
      unfollowed.subscribe = () =>
        Promise.resolve({ response: { ok: false, error: { code: "UNAVAILABLE", message: "no stream for you" } } });
      unfollowed.runAnswers = [admits("home-1")];
      const second = chatOver(unfollowed);
      await waitFor(() => second.tty.output().includes("Home could not be followed: no stream for you; a message still goes to it"));
      second.tty.type("hello\r");
      await waitFor(() => unfollowed.runs.length === 1);
      expect(unfollowed.runs[0]).toMatchObject({ prompt: "hello", target: "home" });
      second.tty.type(CTRL_C);
      await second.done;
    });

    it("does not hang on 'starting…' when Home's record cannot be read: a prompt goes to Home", async () => {
      const client = homeOwner();
      const answer = client.answers.tasks;
      client.answers.tasks = (payload) => {
        const asked = payload as { action?: string; taskId?: string };
        return asked.action === undefined && asked.taskId === "home-1"
          ? { ok: false, error: { code: "UNAVAILABLE", message: "busy" } }
          : answer!(payload);
      };
      client.runAnswers = [admits("home-1")];
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("could not read task home-1's record"));
      await waitFor(() => tty.output().includes("Type a message for Home"));
      tty.type("hello\r");
      await waitFor(() => client.runs.length === 1);
      expect(client.runs[0]).toMatchObject({ prompt: "hello", target: "home" });
      expect(tty.output()).not.toContain("… queued");
      tty.type(CTRL_C);
      await done;
    });

    it("opens a Home named by --attach as Home: its saved turns, followed from now, not replayed", async () => {
      const client = homeOwner();
      const froms: unknown[] = [];
      const subscribe = client.subscribe.bind(client);
      client.subscribe = (taskId, options) => {
        froms.push((options as { from?: unknown }).from);
        return subscribe(taskId, options);
      };
      const { tty, done } = chatOver(client, { attach: "home-1" });
      await waitFor(() => tty.output().includes("… type to continue Home"));
      expect(tty.output()).toContain("❯ what is on today?");
      expect(froms).toEqual([undefined]);
      tty.type(CTRL_C);
      await done;
    });

    it("with Home off, keeps /new, makes /side the same, says how to turn Home on, and sends no target", async () => {
      const client = homeOwner({ on: false });
      client.runAnswers = [admits("task-9")];
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("Type a prompt"));
      // Off, Home is not looked for, nor opened.
      expect(client.requests.some((request) => request.command === "tasks")).toBe(false);
      tty.type("/home\r");
      await waitFor(() => tty.output().includes("Home is off in this workspace: `tavi config set chat.home on` turns it on"));
      tty.type("/new\r");
      await waitFor(() => tty.output().includes("the next prompt starts a new chat"));
      expect(tty.output()).not.toContain("/new does what /side does");
      tty.type("/side\r");
      await waitFor(() => tty.output().split("the next prompt starts a new chat").length === 3);
      tty.type("hello\r");
      await waitFor(() => tty.output().includes("✓ Done."));
      expect(client.runs[0]?.target).toBeUndefined();
      // Nothing was shown: no parent either.
      expect(client.runs[0]?.parentChatId).toBeUndefined();
      tty.type(CTRL_C);
      await done;
    });

    it("with no chat shown, /model names and sets the default new chats run", async () => {
      const client = homeOwner({ on: false });
      let refuseDefault = false;
      client.answers["models"] = (payload) => {
        const action = (payload as { action: string }).action;
        if (action === "roles") return { ok: true, result: { activeTarget: { connectionId: "or", model: "fast" } } };
        if (action === "set-default")
          return refuseDefault
            ? { ok: false, error: { code: "CONFLICT", message: "busy" } }
            : { ok: true, result: { result: {}, restartRequired: false } };
        return { ok: false, error: { code: "INVALID_INPUT", message: `unexpected ${action}` } };
      };
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("Type a prompt"));
      tty.type("/model\r");
      await waitFor(() => tty.output().includes("… no chat is shown: a new chat runs or/fast"));
      tty.type("/model or fast\r");
      await waitFor(() => tty.output().includes("… new chats run or/fast"));
      refuseDefault = true;
      tty.type("/model or slow\r");
      await waitFor(() => tty.output().includes("✗ the default was not set: busy"));
      expect(
        client.requests.filter((request) => request.command === "models").map((request) => (request.payload as { action: string }).action),
      ).toEqual(["roles", "set-default", "roles", "set-default"]);
      tty.type(CTRL_C);
      await done;
    });

    it("with Home off, /side still opens a side chat of the chat shown, while /new starts one of its own", async () => {
      const client = homeOwner({ on: false });
      client.runAnswers = [admits("task-1"), admits("side-9"), admits("task-2")];
      const { tty, done } = chatOver(client);
      await waitFor(() => tty.output().includes("Type a prompt"));
      tty.type("first\r");
      await waitFor(() => tty.output().includes("✓ Done."));
      const beforeSide = tty.output().length;
      tty.type("/side aside\r");
      await waitFor(() => tty.output().slice(beforeSide).includes("✓ Done."));
      expect(client.runs[1]).toMatchObject({ prompt: "aside", parentChatId: "task-1" });
      tty.type("/new\r");
      await waitFor(() => tty.output().includes("the next prompt starts a new chat"));
      tty.type("fresh\r");
      await waitFor(() => client.runs.length === 3);
      expect(client.runs[2]?.prompt).toBe("fresh");
      expect(client.runs[2]?.parentChatId).toBeUndefined();
      tty.type(CTRL_C);
      await done;
    });
  });
});

describe("tavi chat's usage", () => {
  it("says what --attach does: a prompt after it continues the attached chat, and its question is answered here", async () => {
    const help = capture();
    expect(await main(["chat", "--help"], { io: help.io })).toBe(EXIT.ok);
    const usage = help.stdout().replace(/\s+/g, " ");
    expect(usage).toContain("once it ends, the next prompt continues it");
    expect(usage).toContain("/side [topic] starts a side chat");
    expect(usage).not.toContain("starts a new task");
    expect(usage).not.toContain("does not answer the attached");
  });
});

/**
 * Whether the run whose prompt was echoed as `❯ prompt` has drawn its own
 * "✓ Done.": the owner may record a run's end before the chat reads it, and
 * the run before's "✓ Done." stays on screen (redrawn by `/new`, say) until
 * the new run's first frame — only one drawn after the echo is the run's. A
 * Ctrl-C before the chat reads the end detaches, rightly.
 */
function doneAfterEcho(output: string, prompt: string): boolean {
  const echo = output.lastIndexOf(`❯ ${prompt}`);
  return echo >= 0 && output.lastIndexOf("✓ Done.") > echo;
}

/**
 * `chat.home` off in the owner's workspace, read by the chat as it starts: for a
 * test of the chat without Home, whose `/new` starts an ordinary chat (Home is
 * on by default).
 */
async function homeOff(handle: ServeHandle): Promise<void> {
  const settings = handle.runtime.store.asPort().repositories.workspaceSettings;
  const current = await settings.get("default");
  await settings.set({
    workspaceId: "default",
    settings: { ...current.settings, homeChat: false },
    expectedRevision: current.revision,
    actor: "operator",
    now: "2026-01-01T00:00:00.000Z",
  });
}

describe("tavi chat under a live owner", ATTACHED, () => {
  const options = (dataDirectory: string, extra: Record<string, string> = {}) => ({
    workspaceId: "default",
    principalId: "operator",
    dataDirectory,
    ...extra,
  });

  it("dispatches each prompt as a run and renders its stream, then quits on Ctrl-C", async () => {
    const { handle, directory } = await owners.startOwner(turns([]));
    const tty = fakeTty({ rows: 20, columns: 80 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("please reply\r");
    await waitFor(() => tty.output().includes("✓ Done."));
    const output = tty.output();
    expect(output).toContain("❯ please reply");
    // The model's answer, after the prompt that asked for it.
    expect(output.indexOf("done", output.indexOf("❯ please reply"))).toBeGreaterThan(-1);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
    const task = (await handle.runtime.store.asPort().repositories.tasks.list(10))[0];
    expect(task).toMatchObject({ status: "completed", origin: "ipc" });
  });

  it("edits the prompt as typed — in one chunk or several, pasted or not — and starts one run per Enter", async () => {
    const { handle, directory } = await owners.startOwner(turns([]));
    await homeOff(handle);
    const tasks = async () => await handle.runtime.store.asPort().repositories.tasks.list(10);
    const tty = fakeTty({ rows: 20, columns: 80 });
    // Settled as the chat saw it, not only as the owner recorded it: a prompt
    // typed before the chat reads the run's end is, rightly, not taken.
    const settled = async (count: number, prompt: string) =>
      (await tasks()).length === count &&
      (await tasks()).every((task) => task.status === "completed") &&
      doneAfterEcho(tty.output(), prompt);
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    // Dispatched before React commits the first: each builds on the last, and
    // a second prompt typed while the first is being sent starts nothing.
    tty.type("x");
    tty.type(`ab${BACKSPACE}c`);
    tty.type("\r");
    tty.type("two\r");
    await waitFor(async () => await settled(1, "xac"));
    expect(tty.output()).not.toContain("❯ two");
    // A task of its own each time (`/new`): what is tested here is the typing, not continuing.
    tty.type("/new\r");
    await waitFor(() => tty.output().includes("the next prompt starts a new chat"));
    // A cursor key in the same chunk is a key, not text.
    tty.type(`hello${String.fromCharCode(27)}[D\r`);
    await waitFor(async () => await settled(2, "hello"));
    tty.type("/new\r");
    await waitFor(() => tty.output().split("the next prompt starts a new chat").length === 3);
    // A pasted line break is a space: pasting never submits.
    tty.paste("line one\nline two");
    await delay(100);
    expect(await tasks()).toHaveLength(2);
    tty.type("\r");
    await waitFor(async () => await settled(3, "line one line two"));
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
    expect(await tasks()).toHaveLength(3);
  });

  it("stores a credential on the owner through the form, and lists it in /credentials — its value never on screen", async () => {
    const { directory } = await owners.startOwner(turns([]));
    const tty = fakeTty({ rows: 20, columns: 120 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    const key = async (text: string) => {
      tty.type(text);
      await delay(40);
    };
    await key("/credentials set stripe.apiKey\r");
    await waitFor(() => tty.output().includes("value (hidden)"));
    await key("sk-live-owner-9876\r");
    await waitFor(() => tty.output().includes("✓ credential stripe.apiKey stored"));
    // Stored encrypted (a new directory is), and it reads back as typed.
    expect(readFileSync(join(directory, "credentials", "stripe.apiKey"), "utf8")).not.toContain("sk-live-owner-9876");
    expect(await createLocalCredentialStore(directory).getSecret("stripe.apiKey")).toBe("sk-live-owner-9876");
    expect(statSync(join(directory, "credentials", "stripe.apiKey")).mode & 0o777).toBe(0o600);
    await key("/credentials\r");
    await waitFor(() => tty.output().includes("─ credentials (the owner's store) ─"));
    expect(tty.output()).toContain("stripe.apiKey");
    expect(tty.output()).not.toContain("sk-live-owner");
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("says why the owner refused a run, and quits with 0: nothing is left running", async () => {
    const { directory } = await owners.startOwner(turns([]));
    const tty = fakeTty({ rows: 20, columns: 80 });
    const errors: string[] = [];
    const done = runChat(
      options(directory, { workspaceId: "nowhere" }),
      { stdout: tty.stdout, stdin: tty.stdin, stderr: stderrOf(errors) },
      CODES,
    );
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("please reply\r");
    await waitFor(() => tty.output().includes("✗ "));
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
    expect(errors.join("")).toBe("");
  });

  it("approves a round with y, and the resumed turn runs to its end", async () => {
    const { handle, directory } = await owners.startOwner(turns(["call-1"]));
    const tty = fakeTty({ rows: 20, columns: 160 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("open a browser\r");
    await waitFor(() => tty.output().includes("Round 1 needs approval:"));
    expect(tty.output()).toContain("• browser.create_session");
    // The round's header is drawn as it arrives; its keys are offered — and a key
    // decides it — only once the owner has listed the round whole.
    await waitFor(() => tty.output().includes("⏸ round 1: "));
    tty.type("y");
    await waitFor(() => tty.output().includes("✓ Round 1 approved by operator"));
    await waitFor(() => tty.output().includes("✓ Done."));
    const taskId = (await handle.runtime.store.asPort().repositories.tasks.list(10))[0]?.taskId ?? "";
    expect((await handle.runtime.store.asPort().repositories.tasks.get(taskId))?.status).toBe("completed");
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("rejects a round with n, and the task carries on without the call", async () => {
    const { handle, directory } = await owners.startOwner(turns(["call-1"]));
    const tty = fakeTty({ rows: 20, columns: 160 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("open a browser\r");
    await waitFor(() => tty.output().includes("Round 1 needs approval:"));
    // The round's header is drawn as it arrives; its keys are offered — and a key
    // decides it — only once the owner has listed the round whole.
    await waitFor(() => tty.output().includes("⏸ round 1: "));
    tty.type("n");
    await waitFor(() => tty.output().includes("✗ Round 1 rejected by operator"));
    await waitFor(() => tty.output().includes("✓ Done."));
    const taskId = (await handle.runtime.store.asPort().repositories.tasks.list(10))[0]?.taskId ?? "";
    const rows = await handle.runtime.store.asPort().repositories.approvals.listForTask(taskId);
    expect(rows.map((row) => row.state)).toEqual(["denied"]);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("releases a pending artifact with y, and the task resumes to its end", async () => {
    const archiving: ModelPort = {
      async stream(request, options): Promise<ModelOutcome> {
        if (!request.messages.some((message) => (message.toolResults?.length ?? 0) > 0)) {
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [
              // An artifact a person must review: oversized output is archived approved and no longer pauses.
              { id: "call-a", name: "fixture.capture", input: {} },
            ],
            finishReason: "tool-calls",
            usage: {},
          };
        }
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b-review", text: "reviewed" });
        return { status: "completed", attemptId: request.attemptId, text: "reviewed", toolCalls: [], usage: {} };
      },
    };
    const { handle, directory } = await owners.startOwner(archiving, { review: true });
    const tty = fakeTty({ rows: 20, columns: 200 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("archive it\r");
    await waitFor(() => tty.output().includes("y releases all of it"));
    tty.type("y");
    await waitFor(() => tty.output().includes("✓ Done."));
    expect(tty.output()).toContain("releasing the output, as operator");
    const taskId = (await handle.runtime.store.asPort().repositories.tasks.list(10))[0]?.taskId ?? "";
    expect((await handle.runtime.store.asPort().repositories.tasks.get(taskId))?.status).toBe("completed");
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("answers the question the task asks by typing it: a reply into the run's own conversation", async () => {
    const asking = createFixtureModel({
      turns: [
        { toolCall: { id: "call-ask", name: "operator.ask_user", input: { question: "Which one: acme or globex?" } } },
        { text: "thanks for the answer" },
      ],
    });
    const { handle, directory } = await owners.startOwner(asking);
    const tty = fakeTty({ rows: 20, columns: 200 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("pick one for me\r");
    // Asking needs no round of its own: a shipped rule allows it.
    await waitFor(() => tty.output().includes("⏸ The chat asks: Which one: acme or globex?"));
    expect(tty.output()).not.toContain("needs approval");
    await waitFor(() => tty.output().includes("Type the answer and press Enter."));
    tty.type("acme\r");
    await waitFor(() => tty.output().includes("✓ Done."));
    expect(tty.output()).toContain("❯ acme");
    const repositories = handle.runtime.store.asPort().repositories;
    const task = (await repositories.tasks.list(10))[0];
    if (task === undefined) throw new Error("no task");
    // Answered through the one settle point, with what was typed.
    expect((await repositories.tasks.listAdmissions(task.taskId)).filter((admission) => admission.kind === "deadline")).toHaveLength(1);
    // One task: the answer did not start a run.
    expect(await repositories.tasks.list(10)).toHaveLength(1);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("answers an attached task's question — asked in an IPC run nobody followed — by typing", async () => {
    const asking = createFixtureModel({
      turns: [
        { toolCall: { id: "call-ask", name: "operator.ask_user", input: { question: "Which one: acme or globex?" } } },
        { text: "thanks for the answer" },
      ],
    });
    const { handle, directory } = await owners.startOwner(asking);
    const ipc = await owners.attach(handle);
    const started = await ipc.request(
      "run",
      { prompt: "pick one for me", workspaceId: "default", principal: "operator", operationKey: "op-attached", approval: "approve" },
      "run-attached",
      { timeoutMs: 15_000 },
    );
    const taskId = (started.result as { taskId: string }).taskId;
    const repositories = handle.runtime.store.asPort().repositories;
    await waitFor(async () => (await repositories.agentWaits.getActiveByTask(taskId)) !== undefined);

    const tty = fakeTty({ rows: 20, columns: 200 });
    const done = runChat(options(directory, { attach: taskId }), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type the answer and press Enter."));
    tty.type("acme\r");
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    expect((await repositories.tasks.listAdmissions(taskId)).filter((admission) => admission.kind === "deadline")).toHaveLength(1);
    // The chat's own view, not only the record: Ctrl-C before its stream said so would detach a run it still thinks is going.
    await waitFor(() => tty.output().includes("✓ Done."));
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("aborts the running turn with Esc; the task says you stopped it, and nothing is left running", async () => {
    const untilAborted: ModelPort = {
      async stream(request, options): Promise<ModelOutcome> {
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          status: "aborted",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [],
          usage: {},
          error: { code: "aborted", message: "Generation was aborted", retryable: false },
        };
      },
    };
    const { handle, directory } = await owners.startOwner(untilAborted);
    const tty = fakeTty({ rows: 20, columns: 160 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("take forever\r");
    await waitFor(() => tty.output().includes("Esc aborts it"));
    tty.type(String.fromCharCode(27));
    await waitFor(() => tty.output().includes("You stopped this."));
    expect(tty.output()).toContain("aborting task");
    expect(tty.output()).not.toContain("✗ failed");
    const taskId = (await handle.runtime.store.asPort().repositories.tasks.list(10))[0]?.taskId ?? "";
    expect((await handle.runtime.store.asPort().repositories.tasks.get(taskId))?.status).toBe("stopped");
    tty.type(CTRL_C);
    // Nothing runs: Ctrl-C quits, it does not detach.
    expect(await done).toBe(EXIT.ok);
  });

  it("detaches from a run still going with 130, naming how to follow it again", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { handle, directory } = await owners.startOwner(turns([], held));
    const tty = fakeTty({ rows: 20, columns: 80 });
    const errors: string[] = [];
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: stderrOf(errors) }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("take your time\r");
    await waitFor(() => tty.output().includes("● running"));
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.detached);
    const taskId = (await handle.runtime.store.asPort().repositories.tasks.list(10))[0]?.taskId ?? "";
    expect(errors.join("")).toContain(`tavi chat --attach ${taskId}`);
    release();
    await waitFor(async () => (await handle.runtime.store.asPort().repositories.tasks.get(taskId))?.status === "completed");
  });

  it("follows a task with --attach from its beginning, and refuses one that does not exist", async () => {
    const { directory } = await owners.startOwner(turns([]));
    const ran = capture();
    expect(await main(["run", "say done", "--format", "json", "--data-dir", directory], { io: ran.io })).toBe(EXIT.ok);
    const taskId = (JSON.parse(ran.stdout().split("\n")[0] ?? "{}") as { runId: string }).runId;

    const tty = fakeTty({ rows: 20, columns: 80 });
    const done = runChat(options(directory, { attach: taskId }), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("✓ Done."));
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);

    const missing = fakeTty({ rows: 20, columns: 80 });
    const errors: string[] = [];
    expect(
      await runChat(
        options(directory, { attach: "task-none" }),
        { stdout: missing.stdout, stdin: missing.stdin, stderr: stderrOf(errors) },
        CODES,
      ),
    ).toBe(EXIT.unavailable);
    expect(errors.join("")).toContain("task-none does not exist");
  });

  it("reports a task whose stream the owner no longer holds from its record, and continues it on a prompt", async () => {
    const { directory } = await owners.startOwner(turns([]));
    const ran = capture();
    expect(await main(["run", "say done", "--format", "json", "--data-dir", directory], { io: ran.io })).toBe(EXIT.ok);
    const taskId = (JSON.parse(ran.stdout().split("\n")[0] ?? "{}") as { runId: string }).runId;
    // A restarted owner holds no stream of a task that ended before it started.
    await owners.stopLatest("restart");
    const { handle } = await owners.startOwner(turns([]), { directory });

    const tty = fakeTty({ rows: 20, columns: 80 });
    const done = runChat(options(directory, { attach: taskId }), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("✓ completed (recorded)"));
    expect(tty.output()).toContain(`The owner holds no stream of task ${taskId}`);
    // Settled by its record, it is continued all the same.
    expect(tty.output()).toContain("type to continue this chat");
    const repositories = handle.runtime.store.asPort().repositories;
    tty.type("please reply\r");
    await waitFor(async () => (await repositories.tasks.listAdmissions(taskId)).length === 2);
    await waitFor(() => tty.output().includes("✓ Done."));
    expect((await repositories.tasks.listAdmissions(taskId)).map((admission) => admission.kind)).toEqual(["start", "reply"]);
    expect(await repositories.tasks.list(10)).toHaveLength(1);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("does not let earlier runs' streams into the next when the owner restarts between them", async () => {
    const { handle: first, directory } = await owners.startOwner(turns([]));
    await homeOff(first);
    const tty = fakeTty({ rows: 20, columns: 80 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    const tasks = async () => await first.runtime.store.asPort().repositories.tasks.list(10);
    for (const [index, prompt] of ["first", "second"].entries()) {
      // Separate tasks (`/new`): what is tested is that their streams stay apart.
      if (index > 0) {
        tty.type("/new\r");
        await waitFor(() => tty.output().includes("the next prompt starts a new chat"));
      }
      tty.type(`${prompt}\r`);
      await waitFor(
        async () =>
          (await tasks()).length === index + 1 &&
          (await tasks()).every((task) => task.status === "completed") &&
          doneAfterEcho(tty.output(), prompt),
      );
    }
    const earlier = new Set((await tasks()).map((task) => task.taskId));
    await owners.stopLatest("restart");
    await waitFor(() => tty.output().includes("reconnecting"));
    const { handle } = await owners.startOwner(turns([]), { directory });
    await waitFor(() => tty.output().includes("… reconnected"), 15_000);
    const before = tty.output().length;
    tty.type("/new\r");
    await waitFor(() => tty.output().slice(before).includes("the next prompt starts a new chat"));
    tty.type("third\r");
    const third = async () => (await handle.runtime.store.asPort().repositories.tasks.list(10)).find((task) => !earlier.has(task.taskId));
    await waitFor(async () => (await third())?.status === "completed");
    // The third task's own line: `/new` redraws the status row, which names the second task's completion.
    await waitFor(() => doneAfterEcho(tty.output(), "third"));
    // The first tasks' streams were left when they settled: no resync of them reaches the third.
    const after = tty.output().slice(before);
    expect(after).not.toContain("⚠");
    expect(after).not.toContain("recorded outcome");
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("says when the owner does not come back, and refuses a prompt after", async () => {
    const { directory } = await owners.startOwner(turns([]));
    const tty = fakeTty({ rows: 20, columns: 80 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    await owners.stopLatest("gone");
    // The client's attempts take about 12 s.
    await waitFor(() => tty.output().includes("✗ the owner did not come back"), 25_000);
    tty.type("anyone there?\r");
    await waitFor(() => tty.output().includes("✗ the owner is gone"));
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("says no owner is serving the directory, with the remedy", async () => {
    const tty = fakeTty({ rows: 20, columns: 80 });
    const errors: string[] = [];
    const directory = owners.tempDirectory();
    expect(await runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: stderrOf(errors) }, CODES)).toBe(
      EXIT.unavailable,
    );
    expect(errors.join("")).toContain(`No tavi owner is serving ${directory}: start \`tavi serve\``);
  });
});

describe("tavi chat continues a task across prompts", ATTACHED, () => {
  const options = (dataDirectory: string, extra: Record<string, string> = {}) => ({
    workspaceId: "default",
    principalId: "operator",
    dataDirectory,
    ...extra,
  });

  /** A model that answers each turn `answer <n>`, remembering the user and assistant texts each turn was sent. */
  /** A message's text without the per-call step facts the runtime appends to the last user message. */
  const withoutStepFacts = (text: string): string => text.split(`\n\n${STEP_FACTS_HEADING}`)[0] ?? text;
  const isStepFacts = (message: { readonly role: string; readonly text: string }): boolean =>
    message.role === "user" && message.text.startsWith(STEP_FACTS_HEADING);

  function remembering(): { readonly model: ModelPort; readonly seen: string[][] } {
    const seen: string[][] = [];
    const model: ModelPort = {
      async stream(request, stream): Promise<ModelOutcome> {
        seen.push(
          request.messages
            .filter((message) => (message.role === "user" || message.role === "assistant") && !isStepFacts(message))
            .map((message) => `${message.role}: ${withoutStepFacts(message.text)}`),
        );
        const text = `answer ${seen.length}`;
        stream.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: `b-${seen.length}`, text });
        return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: {} };
      },
    };
    return { model, seen };
  }

  /** Settled as the chat shows it: the task done in the owner's record, and its answer on screen. */
  const settled = async (handle: ServeHandle, tty: ReturnType<typeof fakeTty>, answer: string) =>
    (await handle.runtime.store.asPort().repositories.tasks.list(10)).every((task) => task.status === "completed") &&
    tty.output().includes(answer);
  /**
   * Settled as the chat shows it: the offer to continue drawn after `answer`, in
   * what was drawn since `from` — not the earlier status row, which a keystroke
   * redraws. The task's row can read completed, and the answer be on screen,
   * before the chat has the stream's end; Ctrl-C then detaches from a running
   * turn (exit 130) rather than quitting.
   */
  const shownSettled = (tty: ReturnType<typeof fakeTty>, from: number, answer: string): boolean => {
    const tail = tty.output().slice(from);
    const answered = tail.indexOf(answer);
    return answered >= 0 && tail.slice(answered).includes("Type to continue it");
  };

  it("sends a later prompt into the same task, whose model sees what came before; /new starts another", async () => {
    const { model, seen } = remembering();
    const { handle, directory } = await owners.startOwner(model);
    await homeOff(handle);
    const tasks = async () => await handle.runtime.store.asPort().repositories.tasks.list(10);
    const tty = fakeTty({ rows: 20, columns: 200 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("name a colour\r");
    // Settled as the chat sees it — the status line offers to continue — or the next prompt is typed into a run.
    await waitFor(async () => (await settled(handle, tty, "answer 1")) && tty.output().includes("Type to continue it"));
    const beforeReply = tty.output().length;
    tty.type("and another\r");
    await waitFor(async () => seen.length === 2 && (await settled(handle, tty, "answer 2")));
    // One task, two turns: the second was a reply into its conversation.
    expect(await tasks()).toHaveLength(1);
    const taskId = (await tasks())[0]?.taskId ?? "";
    expect((await handle.runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).map((admission) => admission.kind)).toEqual([
      "start",
      "reply",
    ]);
    // The model's second turn carried the first exchange.
    expect(seen[1]).toEqual(["user: name a colour", "assistant: answer 1", "user: and another"]);
    // The new turn is drawn once — the first turn's answer is not replayed into it — and without the resume boundary it opens with.
    // A streaming tail can be redrawn when committed. Check the new turn's
    // output: a replay would show the old answer after the second prompt.
    expect(tty.output().slice(beforeReply)).not.toContain("answer 1");
    expect(tty.output()).not.toContain("resuming after reply");
    expect(tty.output()).toContain("answer 2");

    const second = tty.output().lastIndexOf("answer 2");
    await waitFor(() => tty.output().slice(second).includes("Type to continue it"));
    tty.type("/new\r");
    await waitFor(() => tty.output().includes("the next prompt starts a new chat"));
    const beforeFresh = tty.output().length;
    tty.type("a fresh start\r");
    await waitFor(
      async () => (await tasks()).length === 2 && (await settled(handle, tty, "answer 3")) && shownSettled(tty, beforeFresh, "answer 3"),
    );
    expect(seen[2]).toEqual(["user: a fresh start"]);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("continues a task past the loop guard's budget: it bounds each turn, not the task", async () => {
    const { model, seen } = remembering();
    const { handle, directory } = await owners.startOwner(model);
    const tty = fakeTty({ rows: 20, columns: 200 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    // One model call a turn, ten turns: more than the default eight steps.
    for (let turn = 1; turn <= 10; turn += 1) {
      const before = tty.output().length;
      tty.type(`turn ${turn}\r`);
      await waitFor(() => seen.length === turn && tty.output().slice(before).includes("Type to continue it"));
    }
    expect(tty.output()).not.toContain("Bounded loop guard");
    const tasks = await handle.runtime.store.asPort().repositories.tasks.list(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("completed");
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("continues a task after an owner restart, from its recorded thread", async () => {
    const first = remembering();
    const { directory } = await owners.startOwner(first.model);
    const tty = fakeTty({ rows: 20, columns: 200 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("remember seven\r");
    await waitFor(() => first.seen.length === 1 && tty.output().includes("✓ Done."));
    await owners.stopLatest("restart");
    await waitFor(() => tty.output().includes("reconnecting"));
    const second = remembering();
    const { handle } = await owners.startOwner(second.model, { directory });
    await waitFor(() => tty.output().includes("… reconnected"), 15_000);
    const before = tty.output().length;
    tty.type("what was it?\r");
    // Settled as the chat shows it: the offer to continue drawn after the new answer —
    // not the earlier status row, which a keystroke redraws.
    await waitFor(() => second.seen.length === 1 && shownSettled(tty, before, "answer 1"));
    expect(await handle.runtime.store.asPort().repositories.tasks.list(10)).toHaveLength(1);
    expect(second.seen[0]).toEqual(["user: remember seven", "assistant: answer 1", "user: what was it?"]);
    // Only the new turn: no resync of the stream the chat saw end.
    expect(tty.output().slice(before)).not.toContain("⚠");
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("shows every turn of a continued task on --attach, and continues it from there", async () => {
    const { model, seen } = remembering();
    const { handle, directory } = await owners.startOwner(model);
    await homeOff(handle);
    const first = fakeTty({ rows: 20, columns: 200 });
    const chatted = runChat(options(directory), { stdout: first.stdout, stdin: first.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => first.output().includes("Type a prompt"));
    first.type("one\r");
    await waitFor(async () => (await settled(handle, first, "answer 1")) && first.output().includes("Type to continue it"));
    first.type("two\r");
    await waitFor(async () => seen.length === 2 && (await settled(handle, first, "answer 2")));
    first.type(CTRL_C);
    await chatted;
    const taskId = (await handle.runtime.store.asPort().repositories.tasks.list(10))[0]?.taskId ?? "";

    const tty = fakeTty({ rows: 20, columns: 200 });
    const done = runChat(options(directory, { attach: taskId }), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    // Both turns, replayed: not let go at the first one's end.
    await waitFor(
      () => tty.output().includes("answer 1") && tty.output().includes("answer 2") && tty.output().includes("Type to continue it"),
    );
    const before = tty.output().length;
    tty.type("three\r");
    await waitFor(() => seen.length === 3 && shownSettled(tty, before, "answer 3"));
    expect(seen[2]).toEqual(["user: one", "assistant: answer 1", "user: two", "assistant: answer 2", "user: three"]);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("opens a Home named by --attach from its saved turns, though it is not found as this person's Home, and continues it", async () => {
    const { model, seen } = remembering();
    const { handle, directory } = await owners.startOwner(model);
    // Home is on by default: the first chat's prompts are Home's turns.
    const first = fakeTty({ rows: 20, columns: 200 });
    const chatted = runChat(options(directory), { stdout: first.stdout, stdin: first.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => first.output().includes("Type a prompt"));
    first.type("one\r");
    await waitFor(async () => (await settled(handle, first, "answer 1")) && first.output().includes("Type to continue it"));
    first.type("two\r");
    await waitFor(async () => seen.length === 2 && (await settled(handle, first, "answer 2")));
    first.type(CTRL_C);
    await chatted;
    const [home] = await handle.runtime.store.asPort().repositories.tasks.list(10);
    expect(home?.chatKind).toBe("home");
    // With Home off the chat looks for no Home of its own: only the task's record says it is one.
    await homeOff(handle);
    const tty = fakeTty({ rows: 20, columns: 200 });
    const done = runChat(
      options(directory, { attach: home?.taskId ?? "" }),
      { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined },
      CODES,
    );
    // Its newest saved turns, not a replay of a stream the owner does not hold from its start.
    await waitFor(
      () =>
        tty.output().includes("❯ one") &&
        tty.output().includes("answer 1") &&
        tty.output().includes("❯ two") &&
        tty.output().includes("answer 2"),
    );
    expect(tty.output()).not.toContain("joined late");
    const before = tty.output().length;
    tty.type("three\r");
    await waitFor(() => seen.length === 3 && tty.output().slice(before).includes("answer 3"));
    expect(seen[2]).toEqual(["user: one", "assistant: answer 1", "user: two", "assistant: answer 2", "user: three"]);
    expect((await handle.runtime.store.asPort().repositories.tasks.list(10)).map((task) => task.taskId)).toEqual([home?.taskId]);
    tty.type(CTRL_C);
    await done;
  }, 60_000);

  it("continues an attached task an IPC run started, through the conversation its record names", async () => {
    const { model, seen } = remembering();
    const { handle, directory } = await owners.startOwner(model);
    const ipc = await owners.attach(handle);
    const started = await ipc.request(
      "run",
      { prompt: "start elsewhere", workspaceId: "default", principal: "operator", operationKey: "op-elsewhere", approval: "approve" },
      "run-elsewhere",
      { timeoutMs: 15_000 },
    );
    const taskId = (started.result as { taskId: string }).taskId;
    const repositories = handle.runtime.store.asPort().repositories;
    await waitFor(async () => (await repositories.tasks.get(taskId))?.status === "completed");
    const tty = fakeTty({ rows: 20, columns: 200 });
    const done = runChat(options(directory, { attach: taskId }), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("✓ Done."));
    const before = tty.output().length;
    tty.type("and then?\r");
    await waitFor(async () => seen.length === 2 && (await settled(handle, tty, "answer 2")) && shownSettled(tty, before, "answer 2"));
    expect(await repositories.tasks.list(10)).toHaveLength(1);
    expect(seen[1]).toEqual(["user: start elsewhere", "assistant: answer 1", "user: and then?"]);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });

  it("continues a task whose turn was aborted", async () => {
    let release = (): void => undefined;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const seen: string[][] = [];
    const model: ModelPort = {
      async stream(request, stream): Promise<ModelOutcome> {
        seen.push(
          request.messages
            .filter((message) => message.role === "user" && !isStepFacts(message))
            .map((message) => withoutStepFacts(message.text)),
        );
        if (seen.length === 1) {
          // The first turn waits until it is aborted.
          await new Promise<void>((resolve, reject) => {
            const signal = (stream as { signal?: AbortSignal }).signal;
            signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
            void hold.then(resolve);
          });
        }
        stream.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: `b-${seen.length}`, text: "later" });
        return { status: "completed", attemptId: request.attemptId, text: "later", toolCalls: [], usage: {} };
      },
    };
    const { handle, directory } = await owners.startOwner(model);
    const tty = fakeTty({ rows: 20, columns: 200 });
    const done = runChat(options(directory), { stdout: tty.stdout, stdin: tty.stdin, stderr: () => undefined }, CODES);
    await waitFor(() => tty.output().includes("Type a prompt"));
    tty.type("a long job\r");
    await waitFor(() => seen.length === 1);
    tty.type(String.fromCharCode(27));
    await waitFor(() => tty.output().includes("You stopped this."));
    expect(tty.output()).not.toContain("STOPPED");
    release();
    tty.type("try again\r");
    await waitFor(() => tty.output().includes("✓ Done."));
    const repositories = handle.runtime.store.asPort().repositories;
    expect(await repositories.tasks.list(10)).toHaveLength(1);
    const taskId = (await repositories.tasks.list(10))[0]?.taskId ?? "";
    expect((await repositories.tasks.listAdmissions(taskId)).map((admission) => admission.kind)).toEqual(["start", "reply"]);
    // The aborted turn's prompt is in the continued turn's context.
    expect(seen.at(-1)).toEqual(["a long job", "try again"]);
    tty.type(CTRL_C);
    expect(await done).toBe(EXIT.ok);
  });
});
