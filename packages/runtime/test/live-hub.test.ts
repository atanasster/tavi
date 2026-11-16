import {
  BROWSER_LIVE_MAX_UNACKED,
  BROWSER_LIVE_MAX_WATCHES,
  TaviError,
  type BrowserLiveMessage,
  type BrowserLivePort,
  type BrowserLiveSessionInfo,
  type BrowserLiveSink,
} from "@tavi/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLiveHub, type LiveHubConnection } from "../src/ipc/live-hub.js";

const METADATA = { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 };
const frame = (sessionId: string, data: string): BrowserLiveMessage => ({
  kind: "frame",
  sessionId,
  mime: "image/jpeg",
  data,
  width: 16,
  height: 9,
  metadata: METADATA,
  at: "2026-10-03T10:00:00.000Z",
  source: "live",
});

/** A live source a test drives: it records watches and lets the test push messages to them. */
function fakeSource() {
  const infos: { workspaceId: string; info: BrowserLiveSessionInfo }[] = [];
  const watches: { sessionId: string; maxWidth: number; sink: BrowserLiveSink; demands: number; closed: boolean }[] = [];
  /** What reached each watch's takeover controls: the action and the watch, never an event's content. */
  const controlled: string[] = [];
  const uncontrollable = new Set<string>();
  const listeners = new Set<(workspaceId: string, info: BrowserLiveSessionInfo) => void>();
  const source: BrowserLivePort = {
    sessions: (scope) =>
      infos
        .filter((entry) => entry.workspaceId === scope.workspaceId && scope.taskIds.includes(entry.info.taskId))
        .map((entry) => entry.info),
    watch(sessionId, options, sink) {
      const watch = { sessionId, maxWidth: options.maxWidth, sink, demands: 0, closed: false };
      watches.push(watch);
      const index = watches.length - 1;
      const record = async (action: string): Promise<void> => void controlled.push(`${action}:${sessionId}#${index}`);
      return {
        demand: () => void (watch.demands += 1),
        close: () => void (watch.closed = true),
        ...(uncontrollable.has(sessionId)
          ? {}
          : {
              control: {
                take: ({ maxWidth, viewport }) =>
                  record(`take@${maxWidth}${viewport === undefined ? "" : ` ${viewport.width}x${viewport.height}`}`),
                input: (events) => record(`input×${events.length}`),
                select: (ref, value) => record(`select ${ref}=${value}`),
                dialog: (accept) => record(`dialog ${accept}`),
                release: (outcome, _note, by) =>
                  void controlled.push(`release ${outcome}${by === undefined ? "" : ` by ${by}`}:${sessionId}#${index}`),
                decline: (_note, by) => void controlled.push(`decline${by === undefined ? "" : ` by ${by}`}:${sessionId}#${index}`),
                upload: (chunk) => record(`upload ${chunk.name}@${chunk.offset}`),
                cancelUpload: () => record("upload-cancel"),
              },
            }),
      };
    },
    onSession(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    watches,
    controlled,
    uncontrollable,
    open(workspaceId: string, info: BrowserLiveSessionInfo) {
      infos.push({ workspaceId, info });
      for (const listener of listeners) listener(workspaceId, info);
    },
    /** Pushes `message` to the session's open watches; answers what their sinks said. */
    push(sessionId: string, message: BrowserLiveMessage): boolean[] {
      return watches.filter((watch) => watch.sessionId === sessionId && !watch.closed).map((watch) => watch.sink(message));
    },
  };
}

function fakeConnection(backlog = () => 0) {
  const sent: { subscriptionId: string; seq: number; message: BrowserLiveMessage }[] = [];
  const subscriptions = new Map<string, { onDropped: (reason: string) => void }>();
  const closers: (() => void)[] = [];
  let closed = false;
  const connection: LiveHubConnection = {
    createSubscription: ({ subscriptionId, onDropped }) => {
      if (closed) throw new TaviError("UNAVAILABLE", "closed");
      subscriptions.set(subscriptionId, { onDropped });
    },
    dropSubscription: (subscriptionId) => void subscriptions.delete(subscriptionId),
    sendLive: (subscriptionId, seq, message) => {
      if (closed || !subscriptions.has(subscriptionId)) return false;
      sent.push({ subscriptionId, seq, message });
      return true;
    },
    backlogBytes: backlog,
    onClose: (listener) => {
      closers.push(listener);
      return () => undefined;
    },
  };
  return {
    connection,
    sent,
    subscriptions,
    kinds: (subscriptionId?: string) =>
      sent
        .filter((entry) => subscriptionId === undefined || entry.subscriptionId === subscriptionId)
        .map((entry) => (entry.message.kind === "frame" ? `frame:${entry.message.data}` : entry.message.kind)),
    close() {
      closed = true;
      for (const closer of closers) closer();
    },
  };
}

const TREE: Record<string, readonly string[]> = { root: ["root", "child"], child: ["child"] };

function hubWith(
  source: BrowserLivePort,
  ancestors: Record<string, readonly string[]> = {},
  now?: () => number,
  agents: Record<string, string> = {},
) {
  let counter = 0;
  return createLiveHub({
    source,
    agentLabel: async (_workspaceId, taskId) => agents[taskId],
    ...(now === undefined ? {} : { now }),
    taskTree: async (_workspaceId, taskId) => {
      const tree = TREE[taskId];
      if (tree === undefined) throw new TaviError("NOT_FOUND", `no task ${taskId}`);
      return tree;
    },
    ancestors: async (_workspaceId, taskId) => ancestors[taskId] ?? [],
    newSubscriptionId: () => `live-${(counter += 1)}`,
  });
}

const open = (sessionId: string, taskId: string): BrowserLiveSessionInfo => ({ sessionId, taskId, state: "open" });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the live hub", () => {
  it("watches every open session of the chat's task tree, sub-agents' included, at the clamped width", async () => {
    const page = fakeSource();
    page.open("w", open("s-root", "root"));
    page.open("w", open("s-child", "child"));
    page.open("w", open("s-other", "other"));
    page.open("other-workspace", open("s-elsewhere", "root"));
    const hub = hubWith(page.source);
    const tab = fakeConnection();
    const answer = await hub.watch({ connection: tab.connection, requestId: "r1", workspaceId: "w", taskId: "root", maxWidth: 5000 });
    expect(answer).toEqual({ subscriptionId: "live-1", sessions: [open("s-root", "root"), open("s-child", "child")] });
    expect(page.watches.map((watch) => [watch.sessionId, watch.maxWidth])).toEqual([
      ["s-root", 960],
      ["s-child", 960],
    ]);
    expect(tab.subscriptions.has("live-1")).toBe(true);
  });

  it("refuses an unknown task, an unknown session, and a watch past the per-connection limit", async () => {
    const page = fakeSource();
    page.open("w", open("s1", "root"));
    const hub = hubWith(page.source);
    const tab = fakeConnection();
    await expect(hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "root", sessionId: "s-missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (let index = 0; index < BROWSER_LIVE_MAX_WATCHES; index += 1)
      await hub.watch({ connection: tab.connection, requestId: `r${index}`, workspaceId: "w", taskId: "root" });
    await expect(hub.watch({ connection: tab.connection, requestId: "r-over", workspaceId: "w", taskId: "root" })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
    expect(hub.count(tab.connection)).toBe(BROWSER_LIVE_MAX_WATCHES);
  });

  it(`holds at most ${BROWSER_LIVE_MAX_UNACKED} frames unacknowledged, keeps only the latest waiting one, and frees the source on ack`, async () => {
    const page = fakeSource();
    page.open("w", open("s1", "root"));
    const hub = hubWith(page.source);
    const tab = fakeConnection();
    const { subscriptionId } = await hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "root" });
    expect(page.push("s1", frame("s1", "a"))).toEqual([true]);
    // The second frame uses the last credit: the source must hold Chromium.
    expect(page.push("s1", frame("s1", "b"))).toEqual([false]);
    expect(page.push("s1", frame("s1", "c"))).toEqual([false]);
    expect(page.push("s1", frame("s1", "d"))).toEqual([false]);
    expect(tab.kinds()).toEqual(["frame:a", "frame:b"]);
    // A message other than a frame is never held back by credit.
    page.push("s1", { kind: "navigated", sessionId: "s1", url: "https://example.com/", epoch: 1 });
    expect(tab.kinds()).toEqual(["frame:a", "frame:b", "navigated"]);
    const demandsBefore = page.watches[0]?.demands ?? 0;
    hub.ack(tab.connection, subscriptionId, 0);
    expect(tab.kinds()).toEqual(["frame:a", "frame:b", "navigated", "frame:d"]);
    expect(page.watches[0]?.demands).toBe(demandsBefore);
    hub.ack(tab.connection, subscriptionId, 1);
    expect(page.watches[0]?.demands).toBe(demandsBefore + 1);
    // An ack for a seq it never sent changes nothing.
    hub.ack(tab.connection, subscriptionId, 99);
  });

  it("never sends a frame that was waiting when its page was hidden or ended", async () => {
    const page = fakeSource();
    page.open("w", open("s1", "root"));
    const hub = hubWith(page.source);
    const tab = fakeConnection();
    const { subscriptionId } = await hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "root" });
    page.push("s1", frame("s1", "a"));
    page.push("s1", frame("s1", "b"));
    page.push("s1", frame("s1", "secret"));
    page.push("s1", { kind: "hidden", sessionId: "s1", reason: "password-field" });
    hub.ack(tab.connection, subscriptionId, 0);
    hub.ack(tab.connection, subscriptionId, 1);
    expect(tab.kinds()).toEqual(["frame:a", "frame:b", "hidden"]);
  });

  it("stops sending frames while the connection's backlog is over its pause, and resumes once it drains", async () => {
    let backlog = 9 * 1024 * 1024;
    const page = fakeSource();
    page.open("w", open("s1", "root"));
    const hub = hubWith(page.source);
    const tab = fakeConnection(() => backlog);
    await hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "root" });
    expect(page.push("s1", frame("s1", "a"))).toEqual([false]);
    page.push("s1", { kind: "navigated", sessionId: "s1", url: "https://example.com/", epoch: 1 });
    expect(tab.kinds()).toEqual(["navigated"]);
    backlog = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(tab.kinds()).toEqual(["navigated", "frame:a"]);
    expect(page.watches[0]?.demands).toBe(1);
  });

  it("lets a connection ack and unwatch only its own watches", async () => {
    const page = fakeSource();
    page.open("w", open("s1", "root"));
    const hub = hubWith(page.source);
    const mine = fakeConnection();
    const theirs = fakeConnection();
    const { subscriptionId } = await hub.watch({ connection: mine.connection, requestId: "r", workspaceId: "w", taskId: "root" });
    expect(() => hub.ack(theirs.connection, subscriptionId, 0)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => hub.unwatch(theirs.connection, subscriptionId)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(page.watches[0]?.closed).toBe(false);
    hub.unwatch(mine.connection, subscriptionId);
    expect(page.watches[0]?.closed).toBe(true);
    expect(mine.subscriptions.has(subscriptionId)).toBe(false);
  });

  it("takes up a session opened later in the tree, by its task or an ancestor, and nothing outside it", async () => {
    const page = fakeSource();
    const hub = hubWith(page.source, { grandchild: ["root", "child"] });
    const tab = fakeConnection();
    await hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "root" });
    page.open("w", open("s-child", "child"));
    page.open("w", open("s-grandchild", "grandchild"));
    page.open("w", open("s-stranger", "stranger"));
    page.open("other", open("s-elsewhere", "root"));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.watches.map((watch) => watch.sessionId)).toEqual(["s-child", "s-grandchild"]);
  });

  it("passes on a session's end, forgets a closed one, and watches it again once it is in use", async () => {
    const page = fakeSource();
    page.open("w", open("s-root", "root"));
    const hub = hubWith(page.source);
    const tab = fakeConnection();
    await hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "root" });
    page.push("s-root", { kind: "ended", sessionId: "s-root", reason: "closed" });
    expect(tab.sent.at(-1)?.message).toEqual({ kind: "ended", sessionId: "s-root", reason: "closed" });
    page.open("w", open("s-root", "root"));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.watches.filter((watch) => watch.sessionId === "s-root")).toHaveLength(2);
  });

  it("keeps a session whose task ended in the watch: a person can still take it, and it is not watched twice once in use", async () => {
    const page = fakeSource();
    page.open("w", open("s-root", "root"));
    const hub = hubWith(page.source);
    const tab = fakeConnection();
    const { subscriptionId } = await hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "root" });
    page.push("s-root", { kind: "ended", sessionId: "s-root", reason: "task-ended" });
    expect(tab.sent.at(-1)?.message).toEqual({ kind: "ended", sessionId: "s-root", reason: "task-ended" });
    await hub.control(tab.connection, { action: "take", subscriptionId, sessionId: "s-root", viewport: { width: 390, height: 700 } });
    expect(page.controlled).toEqual(["take@640 390x700:s-root#0"]);
    page.open("w", open("s-root", "root"));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.watches.filter((watch) => watch.sessionId === "s-root")).toHaveLength(1);
  });

  it("watches the one session a watch names again once it is back in use, and no other session", async () => {
    const page = fakeSource();
    page.open("w", open("s-root", "root"));
    const hub = hubWith(page.source);
    const tab = fakeConnection();
    await hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "root", sessionId: "s-root" });
    page.push("s-root", { kind: "ended", sessionId: "s-root", reason: "closed" });
    page.open("w", open("s-other", "root"));
    page.open("w", open("s-root", "root"));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.watches.map((watch) => watch.sessionId)).toEqual(["s-root", "s-root"]);
  });

  it("names the sub-agent whose task opened a session, in the answer, in session news and for a session opened later", async () => {
    const page = fakeSource();
    page.open("w", open("s-root", "root"));
    page.open("w", open("s-child", "child"));
    const hub = hubWith(page.source, { grandchild: ["root", "child"] }, undefined, {
      child: "Researcher",
      grandchild: "Checker",
      root: "never the watched task",
    });
    const tab = fakeConnection();
    const answer = await hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "root" });
    expect(answer.sessions).toEqual([open("s-root", "root"), { ...open("s-child", "child"), agent: "Researcher" }]);
    page.push("s-child", { kind: "session", sessionId: "s-child", taskId: "child", state: "open", url: "https://b.example/" });
    expect(tab.sent.at(-1)?.message).toEqual({
      kind: "session",
      sessionId: "s-child",
      taskId: "child",
      state: "open",
      url: "https://b.example/",
      agent: "Researcher",
    });
    page.open("w", open("s-grandchild", "grandchild"));
    await vi.advanceTimersByTimeAsync(0);
    page.push("s-grandchild", { kind: "session", sessionId: "s-grandchild", taskId: "grandchild", state: "open" });
    expect(tab.sent.at(-1)?.message).toMatchObject({ sessionId: "s-grandchild", agent: "Checker" });
  });

  it("stops every watch of a connection that closes (no screencast outlives its viewer)", async () => {
    const page = fakeSource();
    page.open("w", open("s1", "root"));
    const hub = hubWith(page.source);
    const tab = fakeConnection();
    await hub.watch({ connection: tab.connection, requestId: "r", workspaceId: "w", taskId: "root" });
    await hub.watch({ connection: tab.connection, requestId: "r2", workspaceId: "w", taskId: "root" });
    tab.close();
    expect(page.watches.every((watch) => watch.closed)).toBe(true);
    expect(hub.count(tab.connection)).toBe(0);
  });

  it("routes takeover to a session of the connection's own watch, in order and at most 30 batches a second", async () => {
    const page = fakeSource();
    page.open("w", open("s1", "root"));
    page.open("w", open("s2", "root"));
    page.uncontrollable.add("s2");
    let clock = 0;
    const hub = hubWith(page.source, {}, () => clock);
    const tab = fakeConnection();
    const other = fakeConnection();
    const { subscriptionId } = await hub.watch({
      connection: tab.connection,
      requestId: "r",
      workspaceId: "w",
      taskId: "root",
      maxWidth: 640,
    });
    const text = [{ type: "text" as const, text: "hunter2" }];
    await hub.control(tab.connection, { action: "take", subscriptionId, sessionId: "s1" });
    await hub.control(tab.connection, { action: "take", subscriptionId, sessionId: "s1", maxWidth: 1600 });
    await hub.control(tab.connection, { action: "input", subscriptionId, sessionId: "s1", seq: 0, events: text });
    await hub.control(tab.connection, { action: "select", subscriptionId, sessionId: "s1", ref: "select-1", value: "m" });
    await hub.control(tab.connection, { action: "dialog", subscriptionId, sessionId: "s1", accept: true });
    // Recorded as the front end that sent it.
    await hub.control(tab.connection, { action: "release", subscriptionId, sessionId: "s1", outcome: "done", note: "ok" }, "operator:ui");
    await hub.control(tab.connection, { action: "decline", subscriptionId, sessionId: "s1", note: "no access" }, "operator:cli");
    await hub.control(tab.connection, {
      action: "upload",
      subscriptionId,
      sessionId: "s1",
      count: 1,
      index: 0,
      name: "cv.pdf",
      type: "application/pdf",
      size: 3,
      offset: 0,
      data: "YWJj",
    });
    await hub.control(tab.connection, { action: "upload-cancel", subscriptionId, sessionId: "s1" });
    expect(page.controlled).toEqual([
      "take@640:s1#0",
      "take@1600:s1#0",
      "input×1:s1#0",
      "select select-1=m:s1#0",
      "dialog true:s1#0",
      "release done by operator:ui:s1#0",
      "decline by operator:cli:s1#0",
      "upload cv.pdf@0:s1#0",
      "upload-cancel:s1#0",
    ]);

    // Only the connection's own watch, and a session it shows that can be taken over.
    await expect(hub.control(other.connection, { action: "take", subscriptionId, sessionId: "s1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(hub.control(tab.connection, { action: "take", subscriptionId, sessionId: "s-elsewhere" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(hub.control(tab.connection, { action: "take", subscriptionId, sessionId: "s2" })).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
    });

    // In order: an older batch is refused, reaching nothing.
    await expect(
      hub.control(tab.connection, { action: "input", subscriptionId, sessionId: "s1", seq: 0, events: text }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    for (let seq = 1; seq < 30; seq += 1)
      await hub.control(tab.connection, { action: "input", subscriptionId, sessionId: "s1", seq, events: text });
    await expect(
      hub.control(tab.connection, { action: "input", subscriptionId, sessionId: "s1", seq: 30, events: text }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    clock += 1000;
    await hub.control(tab.connection, { action: "input", subscriptionId, sessionId: "s1", seq: 31, events: text });
    expect(page.controlled.filter((call) => call.startsWith("input"))).toHaveLength(31);
  });
});
