import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { BrowserLiveMessage } from "@tavi/contracts";
import { FIXTURE_LIVE_JPEG, createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createBrowserLiveSource } from "@tavi/plugin-browser/live";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { createIpcClient, readDiscovery, readToken, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserLiveCli } from "../../src/features/browser/live-client.js";
import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { SqliteStore } from "../support/database-fixture.js";
import { fixtureRuntimeOptions, fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `browser-live` end to end: an owner
 * whose fixture browser streams synthetic frames, watched over its real IPC
 * socket.
 */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const handle of handles.splice(0)) await handle.shutdown("test");
  directories.cleanup();
});

const io: CliIo = { stdout: () => undefined, stderr: () => undefined, isTty: false };

async function ownerWithBrowser(
  taskId: string,
  extra: {
    readonly logs?: string[];
    readonly inputs?: string[];
    readonly selects?: Record<string, { value: string; label: string }[]>;
    readonly model?: boolean;
  } = {},
) {
  const directory = directories.create("tavi-browser-live-");
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  try {
    await store.asPort().repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: `op-${taskId}`,
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: taskId,
      newAdmissionId: `adm-${taskId}`,
      newThreadId: `thread-${taskId}`,
      now: "2026-01-01T00:00:00.000Z",
    });
  } finally {
    store.close();
  }
  const live = createBrowserLiveSource();
  const browser = createFixtureBrowser({
    live,
    liveFrameMs: 10,
    sensitive: { "https://bank.example/login": "password-field" },
    ...(extra.selects === undefined ? {} : { selects: extra.selects }),
    onControlInput: (type) => void extra.inputs?.push(type),
  });
  const handle = await serve(
    fixtureRuntimeOptions(directory, {
      logger:
        extra.logs === undefined
          ? { level: "error", sink: () => {} }
          : { level: "debug", sink: (line) => void extra.logs?.push(typeof line === "string" ? line : JSON.stringify(line)) },
    }),
    {
      dataDirectory: directory,
      drainDeadlineMs: 2_000,
      ...(extra.model === true
        ? { modelTarget: { source: "default" as const, connectionId: "fixture", model: "fixture-model", workspaceId: "default" } }
        : {}),
    },
    io,
    {
      browserOverride: browser,
      liveOverride: live,
      ...(extra.model === true ? { modelOverride: createFixtureModel({ turns: [{ text: "ok" }] }) } : {}),
    },
  );
  handles.push(handle);
  const discovery = readDiscovery(directory);
  const token = readToken(directory);
  if (discovery === undefined || token === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient({ endpoint: discovery.endpoint, sessionId: discovery.sessionId, token });
  clients.push(client);
  const messages: { subscriptionId: string; seq: number; message: BrowserLiveMessage }[] = [];
  client.onLive((frame) => messages.push(frame));
  return { handle, browser, client, messages, directory };
}

describe("browser-live over the owner's socket", () => {
  it("streams a task's session to a watcher, paced by its acks, and keeps no frame anywhere the model or a transcript reads", async () => {
    const { handle, browser, client, messages, directory } = await ownerWithBrowser("task-live");
    expect(client.features).toContain("browser-live");
    const session = await browser.createSession({ workspaceId: "default", taskId: "task-live", callId: "call-open" });
    await browser.navigate(session.sessionId, "https://example.com/news?utm_source=x", { callId: "call-nav" });
    const watched = await client.request(
      "browser-live",
      { action: "watch", workspaceId: "default", taskId: "task-live", maxWidth: 640 },
      "watch-1",
    );
    expect(watched.ok).toBe(true);
    const { subscriptionId, sessions } = watched.result as { subscriptionId: string; sessions: { sessionId: string; url?: string }[] };
    expect(sessions).toEqual([
      { sessionId: "fixture-live-1", taskId: "task-live", state: "open", url: "https://example.com/news", openedByCallId: "call-open" },
    ]);
    await vi.waitFor(() => expect(messages.filter((entry) => entry.message.kind === "frame")).toHaveLength(2), { timeout: 5_000 });
    // Two frames unacknowledged: nothing more comes until one is.
    await delay(100);
    expect(messages.filter((entry) => entry.message.kind === "frame")).toHaveLength(2);
    const first = messages.find((entry) => entry.message.kind === "frame");
    await client.request("browser-live", { action: "ack", subscriptionId, seq: first?.seq }, "ack-1");
    await vi.waitFor(() => expect(messages.filter((entry) => entry.message.kind === "frame")).toHaveLength(3), { timeout: 5_000 });
    expect(messages[0]?.message).toMatchObject({ kind: "session", sessionId: "fixture-live-1" });

    // Nothing of the stream reached the task's events or the artifact store.
    expect(handle.runtime.runEventBus.retains("task-live")).toBe(false);
    const artifacts = join(directory, "artifacts");
    expect(existsSync(artifacts) ? readdirSync(artifacts, { recursive: true }) : []).toEqual([]);

    await client.request("browser-live", { action: "unwatch", subscriptionId }, "unwatch-1");
    const count = messages.length;
    await delay(100);
    expect(messages.length).toBe(count);

    // The generic `unsubscribe` releases a live watch too, so no screencast is orphaned.
    const again = await client.request("browser-live", { action: "watch", workspaceId: "default", taskId: "task-live" }, "watch-2");
    const second = (again.result as { subscriptionId: string }).subscriptionId;
    const unsubscribed = await client.request("unsubscribe", { subscriptionId: second }, "unsubscribe-2");
    expect(unsubscribed.result).toEqual({ unsubscribed: true });
    const ack = await client.request("browser-live", { action: "ack", subscriptionId: second, seq: 0 }, "ack-2");
    expect(ack.error?.code).toBe("NOT_FOUND");
  });

  it("hands control to one watch, applies its input blind, refuses everyone else's, and hands back (invariants 8 and 9)", async () => {
    const logs: string[] = [];
    const inputs: string[] = [];
    const { handle, browser, client, messages, directory } = await ownerWithBrowser("task-live", {
      logs,
      inputs,
      selects: { "https://shop.example/": [{ value: "m", label: "Medium" }] },
    });
    const session = await browser.createSession({ workspaceId: "default", taskId: "task-live" });
    await browser.navigate(session.sessionId, "https://shop.example/");
    const watch = async (id: string) =>
      (
        (await client.request("browser-live", { action: "watch", workspaceId: "default", taskId: "task-live" }, id)).result as {
          subscriptionId: string;
        }
      ).subscriptionId;
    const mine = await watch("watch-1");
    const theirs = await watch("watch-2");
    const sessionId = "fixture-live-1";
    const live = (payload: Record<string, unknown>, id: string) => client.request("browser-live", payload, id);
    const SECRET = "correct-horse-battery-staple";

    expect(
      (await live({ action: "input", subscriptionId: mine, sessionId, seq: 0, events: [{ type: "text", text: SECRET }] }, "in-0")).error
        ?.code,
    ).toBe("NOT_AUTHORIZED");
    expect((await live({ action: "take", subscriptionId: mine, sessionId, maxWidth: 1600 }, "take-1")).ok).toBe(true);
    // The agent's browser calls wait while a person acts.
    await expect(browser.observe(session.sessionId)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await live({ action: "input", subscriptionId: theirs, sessionId, seq: 0, events: [{ type: "text", text: SECRET }] }, "in-1")).error
        ?.code,
    ).toBe("NOT_AUTHORIZED");
    const typed = await live(
      {
        action: "input",
        subscriptionId: mine,
        sessionId,
        seq: 1,
        events: [
          { type: "mouse", action: "move", x: 3, y: 4 },
          { type: "text", text: SECRET },
        ],
      },
      "in-2",
    );
    expect(typed.ok).toBe(true);
    expect(inputs).toEqual(["mouse", "text"]);
    // A press opens the host's list instead of reaching the page.
    expect(
      (
        await live(
          {
            action: "input",
            subscriptionId: mine,
            sessionId,
            seq: 2,
            events: [{ type: "mouse", action: "down", x: 5, y: 5, button: "left", clickCount: 1 }],
          },
          "in-3",
        )
      ).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(messages.some((entry) => entry.subscriptionId === mine && entry.message.kind === "select")).toBe(true));
    expect(messages.some((entry) => entry.subscriptionId === theirs && entry.message.kind === "select")).toBe(false);
    expect((await live({ action: "select", subscriptionId: mine, sessionId, ref: "select-1", value: "m" }, "sel-1")).ok).toBe(true);
    // A refused payload is not echoed back.
    const invalid = await live(
      { action: "input", subscriptionId: mine, sessionId, seq: 3, events: [{ type: "text", text: SECRET, extra: SECRET }] },
      "in-4",
    );
    expect(invalid.error?.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(invalid.error)).not.toContain(SECRET);
    expect((await live({ action: "release", subscriptionId: theirs, sessionId, outcome: "done" }, "rel-0")).error?.code).toBe(
      "NOT_AUTHORIZED",
    );
    expect((await live({ action: "release", subscriptionId: mine, sessionId, outcome: "done", note: "signed in" }, "rel-1")).ok).toBe(true);
    await browser.observe(session.sessionId);
    await vi.waitFor(() =>
      expect(
        messages.filter((entry) => entry.subscriptionId === theirs && entry.message.kind === "control").map((entry) => entry.message),
      ).toEqual([
        { kind: "control", sessionId, state: "operator", controller: "other" },
        { kind: "control", sessionId, state: "agent" },
      ]),
    );

    // Blind: what was typed is nowhere — not the log, the task's events, the database or artifacts.
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(handle.runtime.runEventBus.retains("task-live")).toBe(false);
    await handle.shutdown("test");
    handles.splice(handles.indexOf(handle), 1);
    for (const file of readdirSync(directory, { recursive: true }) as string[]) {
      const path = join(directory, file);
      if (statSync(path).isFile()) expect(readFileSync(path).includes(SECRET), file).toBe(false);
    }
  });

  it("tells the task's stream that a person held its browser while it waited for nothing, with no trace of what they typed", async () => {
    // With a model: handoffs (and their transcript rows) are a running owner's.
    const { handle, browser, client } = await ownerWithBrowser("task-live", { model: true });
    const bus = handle.runtime.runEventBus;
    // The task ran a turn before: its stream names the attempt.
    bus.publish("task-live", { kind: "text.delta", runId: "task-live", attemptId: "attempt-1", blockId: "b1", text: "Opening the shop." });
    const session = await browser.createSession({ workspaceId: "default", taskId: "task-live" });
    await browser.navigate(session.sessionId, "https://shop.example/");
    const watched = await client.request("browser-live", { action: "watch", workspaceId: "default", taskId: "task-live" }, "watch-1");
    const subscriptionId = (watched.result as { subscriptionId: string }).subscriptionId;
    const live = (payload: Record<string, unknown>, id: string) =>
      client.request("browser-live", { subscriptionId, sessionId: "fixture-live-1", ...payload }, id);
    expect((await live({ action: "take", maxWidth: 800 }, "take-1")).ok).toBe(true);
    expect((await live({ action: "input", seq: 1, events: [{ type: "text", text: "s3cret-typed" }] }, "in-1")).ok).toBe(true);
    expect((await live({ action: "release", outcome: "done", note: "Logged in" }, "rel-1")).ok).toBe(true);
    await vi.waitFor(
      () => {
        const { replayed } = bus.subscribe({ taskId: "task-live", from: "beginning", deliver: () => undefined });
        expect(replayed.at(-1)).toMatchObject({
          kind: "browser.controlled",
          runId: "task-live",
          attemptId: "attempt-1",
          sessionId: "fixture-live-1",
          outcome: "done",
          replyText: "Logged in",
        });
        expect(JSON.stringify(replayed)).not.toContain("s3cret-typed");
      },
      { timeout: 5_000 },
    );
  });

  it("hides a sensitive page, refuses another workspace's task, and ends a closed session's stream", async () => {
    const { browser, client, messages } = await ownerWithBrowser("task-live");
    const session = await browser.createSession({ workspaceId: "default", taskId: "task-live" });
    await browser.navigate(session.sessionId, "https://bank.example/login");
    const refused = await client.request("browser-live", { action: "watch", workspaceId: "elsewhere", taskId: "task-live" }, "watch-0");
    expect(refused.error?.code).toBe("NOT_FOUND");
    const missing = await client.request("browser-live", { action: "watch", workspaceId: "default", taskId: "task-missing" }, "watch-x");
    expect(missing.error?.code).toBe("NOT_FOUND");
    const watched = await client.request("browser-live", { action: "watch", workspaceId: "default", taskId: "task-live" }, "watch-1");
    expect(watched.ok).toBe(true);
    await vi.waitFor(() => expect(messages.some((entry) => entry.message.kind === "hidden")).toBe(true), { timeout: 5_000 });
    expect(messages.some((entry) => entry.message.kind === "frame")).toBe(false);
    await browser.close(session.sessionId);
    await vi.waitFor(() => expect(messages.at(-1)?.message).toEqual({ kind: "ended", sessionId: "fixture-live-1", reason: "closed" }), {
      timeout: 5_000,
    });
  });

  it("tavi browser live writes the frames it watched as JPEGs, acknowledging each, and stops at --frames", async () => {
    const { browser, client, directory } = await ownerWithBrowser("task-live");
    const session = await browser.createSession({ workspaceId: "default", taskId: "task-live" });
    await browser.navigate(session.sessionId, "https://example.com/");
    const out = join(directory, "frames");
    let printed = "";
    const { frames } = await browserLiveCli(
      { action: "live", workspaceId: "default", taskId: "task-live", out, frames: 3 },
      { client, stdout: (text) => (printed += text), stop: new Promise(() => undefined) },
    );
    expect(frames).toBe(3);
    // Three frames: more than the two the owner sends unacknowledged.
    const files = readdirSync(out).sort();
    expect(files).toEqual(["fixture-live-1-00001.jpg", "fixture-live-1-00002.jpg", "fixture-live-1-00003.jpg"]);
    expect(printed).toContain("session fixture-live-1 (task task-live): open at https://example.com/");
  });
});

describe("a model's browser turn while it is watched", () => {
  it("streams the turn's page to a watcher while no frame reaches the model, the task's events, the checkpoints or any file the owner wrote", async () => {
    const directory = directories.create("tavi-browser-live-turn-");
    const live = createBrowserLiveSource();
    const browser = createFixtureBrowser({ live, liveFrameMs: 10 });
    const scripted = createFixtureModel({
      turns: [
        { toolCall: { id: "call-open", name: "browser.create_session", input: {} } },
        {
          toolCall: {
            id: "call-nav",
            name: "browser.navigate",
            input: { sessionId: "browser-session-1", url: "https://example.com/news" },
          },
        },
        { toolCall: { id: "call-look", name: "browser.observe", input: { sessionId: "browser-session-1" } } },
        { text: "Read the news page." },
      ],
    });
    // The turn after the session opens waits until a watcher is streaming it.
    let streaming!: () => void;
    const watched = new Promise<void>((resolve) => (streaming = resolve));
    const model: typeof scripted = {
      calls: scripted.calls,
      stream: async (request, options) => (request.attemptNumber === 2 && (await watched), scripted.stream(request, options)),
    };
    const handle = await serve(
      fixtureServeOptions(directory),
      {
        dataDirectory: directory,
        drainDeadlineMs: 5_000,
        modelTarget: { source: "default", connectionId: "fixture", model: "fixture-model", workspaceId: "default" },
      },
      io,
      { modelOverride: model, browserOverride: browser, liveOverride: live },
    );
    handles.push(handle);
    const discovery = readDiscovery(directory);
    const token = readToken(directory);
    if (discovery === undefined || token === undefined) throw new Error("no owner");
    const client = await createIpcClient({ endpoint: discovery.endpoint, sessionId: discovery.sessionId, token });
    clients.push(client);
    const frames: { subscriptionId: string; seq: number }[] = [];
    // Every frame is acknowledged, so the stream runs for the whole turn.
    client.onLive((frame) => {
      if (frame.message.kind !== "frame") return;
      frames.push(frame);
      void client.request(
        "browser-live",
        { action: "ack", subscriptionId: frame.subscriptionId, seq: frame.seq },
        `ack-${frame.subscriptionId}-${frame.seq}`,
      );
    });

    const run = await client.request(
      "run",
      { prompt: "read the news", workspaceId: "default", principal: "operator", operationKey: "live-turn-1", approval: "approve" },
      "run-1",
    );
    expect(run.ok, JSON.stringify(run.error)).toBe(true);
    const taskId = (run.result as { taskId: string }).taskId;
    const answer = await client.request("browser-live", { action: "watch", workspaceId: "default", taskId }, "watch-1");
    expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    streaming();
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    await vi.waitFor(async () => expect((await tasks.get(taskId))?.status).toBe("completed"), { timeout: 15_000 });
    const during = frames.length;
    expect(during).toBeGreaterThan(2);

    // The frame's bytes, as base64 or raw, are nowhere the model or a transcript reads.
    const marker = FIXTURE_LIVE_JPEG.slice(-64);
    const raw = Buffer.from(FIXTURE_LIVE_JPEG, "base64").subarray(-48);
    expect(JSON.stringify(model.calls)).not.toContain(marker);
    expect(model.calls.at(-1)?.messages.some((message) => message.role === "tool")).toBe(true);
    client.close();
    clients.splice(clients.indexOf(client), 1);
    await handle.shutdown("test");
    handles.splice(handles.indexOf(handle), 1);
    const scanned: string[] = [];
    for (const file of readdirSync(directory, { recursive: true }) as string[]) {
      const path = join(directory, file);
      if (!statSync(path).isFile()) continue;
      const bytes = readFileSync(path);
      scanned.push(file);
      expect(bytes.includes(marker), file).toBe(false);
      expect(bytes.includes(raw), file).toBe(false);
    }
    // The database — checkpoints, task events, tool results — was among them.
    expect(scanned).toContain("tavi.sqlite");
  }, 40_000);
});

describe("tavi browser live against a live owner", () => {
  it("stops once every session it watched has ended, and when asked to", async () => {
    const { browser, client, directory } = await ownerWithBrowser("task-live");
    const session = await browser.createSession({ workspaceId: "default", taskId: "task-live" });
    let printed = "";
    const watching = browserLiveCli(
      { action: "live", workspaceId: "default", taskId: "task-live", out: join(directory, "a") },
      { client, stdout: (text) => (printed += text), stop: new Promise(() => undefined) },
    );
    await vi.waitFor(() => expect(printed).toContain("frame"), { timeout: 5_000 });
    await browser.close(session.sessionId);
    await watching;
    expect(printed).toContain("fixture-live-1: ended (closed)");

    // Ctrl-C: the stop promise, with nothing open to wait for.
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    let waited = "";
    const idle = browserLiveCli(
      { action: "live", workspaceId: "default", taskId: "task-live", out: join(directory, "b") },
      { client, stdout: (text) => (waited += text), stop: stopped },
    );
    await vi.waitFor(() => expect(waited).toContain("no open browser session in task task-live; waiting for one"), { timeout: 5_000 });
    stop();
    expect(await idle).toEqual({ frames: 0 });
  });

  it("answers a closed session at once, exits 2 for an unknown task, and stops on a write it cannot make", async () => {
    const { browser, client, directory } = await ownerWithBrowser("task-live");
    const closed = await browser.createSession({ workspaceId: "default", taskId: "task-live" });
    await browser.close(closed.sessionId);
    const missing = await browserLiveCli(
      { action: "live", workspaceId: "default", taskId: "task-live", sessionId: "fixture-live-1", out: join(directory, "c") },
      { client, stdout: () => undefined, stop: new Promise(() => undefined) },
    ).catch((error: unknown) => error);
    // A closed session is no longer the source's: the owner says it is not there.
    expect(missing).toMatchObject({ code: "NOT_FOUND" });

    let err = "";
    const code = await main(["browser", "live", "task-missing", "--out", join(directory, "d"), "--data-dir", directory], {
      io: {
        stdout: () => undefined,
        stderr: (text) => (err += text),
        isTty: false,
      },
    });
    expect(code).toBe(EXIT.usage);
    expect(err).toContain("task-missing");

    await browser.createSession({ workspaceId: "default", taskId: "task-live" });
    const out = join(directory, "e");
    mkdirSync(out, { recursive: true });
    // A directory where the first frame's file would go: the write fails.
    mkdirSync(join(out, "fixture-live-2-00001.jpg"));
    await expect(
      browserLiveCli(
        { action: "live", workspaceId: "default", taskId: "task-live", out },
        { client, stdout: () => undefined, stop: new Promise(() => undefined) },
      ),
    ).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("tavi browser live (the command)", () => {
  it("parses a task, --out and its bounds, and refuses what it does not take", () => {
    expect(
      parseArgs(["browser", "live", "task-1", "--out", "frames", "--width", "800", "--frames", "5", "--session", "s-1"]),
    ).toMatchObject({
      command: "browser",
      browser: { action: "live", taskId: "task-1", out: "frames", maxWidth: 800, frames: 5, sessionId: "s-1", workspaceId: "default" },
    });
    expect(() => parseArgs(["browser", "live", "task-1"])).toThrow(UsageError);
    expect(() => parseArgs(["browser", "live", "--out", "frames"])).toThrow(UsageError);
    expect(() => parseArgs(["browser", "live", "task-1", "--out", "f", "--width", "2000"])).toThrow(UsageError);
    expect(() => parseArgs(["browser", "live", "task-1", "--out", "f", "--limit", "2"])).toThrow(UsageError);
  });

  it("is refused with exit 4 when no owner serves the data directory", async () => {
    const directory = directories.create("tavi-browser-live-");
    let err = "";
    const code = await main(["browser", "live", "task-1", "--out", join(directory, "f"), "--data-dir", directory], {
      io: {
        stdout: () => undefined,
        stderr: (text) => (err += text),
        isTty: false,
      },
    });
    expect(code).toBe(EXIT.unavailable);
    expect(err).toBe("tavi browser live needs a live `tavi serve`: the live view exists only there\n");
  });
});
