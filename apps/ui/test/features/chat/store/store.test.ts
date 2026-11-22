import { CLIENT_PROTOCOL_VERSION, TaviError, type ClientEvent } from "@tavi/contracts";
import {
  CLIENT_TIMEOUT,
  initialRunState,
  type ClientResponse,
  type ClientState,
  type Opened,
  type RunOptions,
  type SubscribeOptions,
  type Subscription,
} from "@tavi/client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { directoryRows, runStatus, sessionStats, sessionsOf, sessionToolGroups } from "../../../../src/features/shell/shell.js";
import { mergeNotices } from "../../../../src/features/chat/store/notices.js";
import {
  chatPluginStatus,
  decidableRound,
  transcriptWindow,
  TRANSCRIPT_HEAD,
  TRANSCRIPT_TAIL,
} from "../../../../src/features/chat/store/runs.js";
import { createCanvasStore } from "../../../../src/features/chat/store/store.js";
import { BLOCKING_KINDS } from "../../../../src/features/chat/store/stream.js";
import type { CanvasClient, CanvasRun } from "../../../../src/features/chat/store/types.js";
import { spoken, type Said } from "../../../../src/features/chat/store/said.js";
import { translateNow } from "../../../../src/lib/i18n.js";

/** A message the store kept, in the words the page shows for it. */
function words(value: Said | readonly Said[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" || "key" in value) return spoken(value, translateNow);
  return value.map((line) => spoken(line, translateNow)).join(" ");
}

/**
 * The canvas's state: runs folded by the client's own
 * reducer, and decided as the terminal decides them — a round only once it is
 * seen whole, held until the owner settles it, and a suspension a restart
 * erased read back from the task's record.
 */

let sequence = 0;
function event(kind: string, fields: Record<string, unknown> = {}): ClientEvent {
  return {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "epoch-1",
    sequence: sequence++,
    runId: "task-1",
    attemptId: "attempt-1",
    at: "2026-09-19T12:00:00.000Z",
    kind,
    ...fields,
  } as ClientEvent;
}

const call = (steps: number, callId: string) => ({
  steps,
  callId,
  toolName: "mail.send",
  summary: `send ${callId}`,
  input: {},
  approvalId: `a-${callId}`,
});
const row = (steps: number, callId: string) => ({
  record: { approvalId: `a-${callId}`, taskId: "task-1", toolId: "mail.send", callId, steps, createdAt: "2026-09-19T12:00:00.000Z" },
  task: {},
});

type Answer = (command: string, payload: unknown) => ClientResponse;

function fakeClient(answer: Answer = () => ({ ok: true, result: {} })) {
  const requests: { command: string; payload: unknown }[] = [];
  const runs: { payload: unknown; options: RunOptions }[] = [];
  const subscribes: { taskId: string; options: SubscribeOptions }[] = [];
  const closed: string[] = [];
  let stateListener: (state: ClientState) => void = () => undefined;
  const runAnswers: ClientResponse[] = [];
  const subscription = (name: string): Subscription =>
    ({ close: () => Promise.resolve(void closed.push(name)) }) as unknown as Subscription;
  const fake = {
    requests,
    runs,
    subscribes,
    closed,
    failure: undefined as unknown,
    answer,
    queueRun: (response: ClientResponse) => runAnswers.push(response),
    /** What `subscribe` answers; ok by default. */
    subscribeResponse: { ok: true, result: {} } as ClientResponse,
    setState: (state: ClientState) => stateListener(state),
  };
  const client: CanvasClient = {
    state: "ready",
    features: [],
    get failure() {
      return fake.failure;
    },
    onState: (listener) => {
      stateListener = listener;
      return () => {
        stateListener = () => undefined;
      };
    },
    run: (payload, options) => {
      runs.push({ payload, options });
      const response = runAnswers.shift() ?? { ok: true, result: { taskId: "task-1", subscriptionId: `sub-${runs.length}` } };
      return Promise.resolve({ response, ...(response.ok ? { subscription: subscription(`run-${runs.length}`) } : {}) } as Opened);
    },
    subscribe: (taskId, options) => {
      subscribes.push({ taskId, options });
      const response = fake.subscribeResponse;
      return Promise.resolve({ response, ...(response.ok ? { subscription: subscription(`resume-${subscribes.length}`) } : {}) } as Opened);
    },
    request: (command, payload) => {
      requests.push({ command, payload });
      return Promise.resolve(fake.answer(command, payload));
    },
  };
  return { client, fake };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A scheduler the test drives: frames and timers fire only when it is told to,
 * and its clock only when it is advanced — so what the store batches is
 * asserted rather than waited for.
 */
function fakeScheduler() {
  let clock = 0;
  let frames: (() => void)[] = [];
  let timers: { readonly at: number; readonly run: () => void }[] = [];
  return {
    scheduler: {
      frame: (callback: () => void) => {
        frames.push(callback);
        return () => (frames = frames.filter((pending) => pending !== callback));
      },
      timer: (ms: number, callback: () => void) => {
        const entry = { at: clock + ms, run: callback };
        timers.push(entry);
        return () => (timers = timers.filter((pending) => pending !== entry));
      },
      now: () => clock,
    },
    /** Paint: every frame waiting now. */
    paint: () => {
      const waiting = frames;
      frames = [];
      for (const callback of waiting) callback();
    },
    /** Move the clock on without serving anything: a starved event loop. */
    tick: (ms: number) => (clock += ms),
    /** Move the clock on, firing the timers that come due. */
    advance: (ms: number) => {
      clock += ms;
      const due = timers.filter((timer) => timer.at <= clock);
      timers = timers.filter((timer) => timer.at > clock);
      for (const timer of due) timer.run();
    },
    frames: () => frames.length,
  };
}
let keys = 0;
const options = { workspaceId: "default", principal: "operator", mintKey: () => `ui-${(keys += 1)}` };
/** An owner whose `approvals list` names `calls` for round `steps`. */
const listing =
  (steps: number, ...calls: string[]): Answer =>
  (command) =>
    command === "approvals"
      ? { ok: true, result: { rows: calls.map((callId) => row(steps, callId)), truncated: false } }
      : { ok: true, result: {} };

describe("the canvas store", () => {
  it("sends a new chat's drafted instructions with the prompt that starts it, and nothing blank", () => {
    keys = 0;
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, options);
    store.submit("audit the site", { chatInstructions: "Answer in French." });
    expect(fake.runs[0]?.payload).toMatchObject({ prompt: "audit the site", chatInstructions: "Answer in French." });
    store.newTask();
    store.submit("another", { chatInstructions: "   " });
    expect(fake.runs[1]?.payload).not.toHaveProperty("chatInstructions");
    // The tests after this one count keys from the first.
    keys = 0;
  });

  it("sends the uploaded files a message carries, with a new chat's prompt and with a reply", async () => {
    let turn = 0;
    const { client, fake } = fakeClient();
    fake.queueRun({ ok: true, result: { taskId: "pdf-task", subscriptionId: "sub-1", conversationId: "op-pdf" } });
    const store = createCanvasStore(client, { ...options, mintKey: () => `pdf-${(turn += 1)}` });
    store.submit("fill this in", { attachments: ["art-up-1"], attachmentNames: ["form.pdf"] });
    expect(fake.runs[0]?.payload).toMatchObject({ prompt: "fill this in", attachments: ["art-up-1"] });
    // The names are the message's to show, never sent.
    expect(JSON.stringify(fake.runs[0]?.payload)).not.toContain("form.pdf");
    expect(store.getSnapshot().runs.at(-1)?.fileNames).toEqual(["form.pdf"]);
    await settle();
    const first = fake.runs[0]!.options.onEvent!;
    first(event("run.started", { runId: "pdf-task", threadId: "t", workspaceId: "default" }));
    first(event("task.completed", { runId: "pdf-task", finalText: "done" }));
    store.submit("and this one", { attachments: ["art-up-2"] });
    for (let index = 0; index < 4; index += 1) await settle();
    expect(fake.requests.find((request) => request.command === "reply")?.payload).toMatchObject({
      text: "and this one",
      attachments: ["art-up-2"],
    });
    store.dispose();
  });

  it("queues a message with files behind a running turn, never steers it, and sends its files when its turn comes", async () => {
    let turn = 0;
    const { client, fake } = fakeClient();
    fake.queueRun({ ok: true, result: { taskId: "busy-task", subscriptionId: "sub-1", conversationId: "op-busy" } });
    const store = createCanvasStore(client, { ...options, mintKey: () => `busy-${(turn += 1)}` });
    store.submit("start");
    await settle();
    const first = fake.runs[0]!.options.onEvent!;
    first(event("run.started", { runId: "busy-task", threadId: "t", workspaceId: "default" }));
    store.submit("and the form", { attachments: ["art-up-9"] });
    const queued = store.getSnapshot().runs.at(-1);
    expect(queued).toMatchObject({ queued: true, carriesFiles: true, continues: "busy-task" });
    store.steerQueued(queued!.id);
    await settle();
    expect(fake.requests.filter((request) => request.command === "reply")).toHaveLength(0);
    first(event("task.completed", { runId: "busy-task", finalText: "done" }));
    for (let index = 0; index < 6; index += 1) await settle();
    expect(fake.requests.find((request) => request.command === "reply")?.payload).toMatchObject({
      text: "and the form",
      attachments: ["art-up-9"],
    });
    store.dispose();
  });

  it("sends a new chat's own model with the prompt that starts it, and none into Home", () => {
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, { ...options, mintKey: () => `model-${fake.runs.length}` });
    store.submit("audit the site", { model: { connectionId: "openrouter", model: "gpt-4.1" } });
    expect(fake.runs[0]?.payload).toMatchObject({ prompt: "audit the site", model: { connectionId: "openrouter", model: "gpt-4.1" } });
    expect(fake.runs[0]?.payload).not.toHaveProperty("chatInstructions");
    const home = fakeClient();
    const homeStore = createCanvasStore(home.client, { ...options, mintKey: () => `home-model-${home.fake.runs.length}` });
    homeStore.setHome(true);
    homeStore.submit("what's on today?", { model: { connectionId: "openrouter", model: "gpt-4.1" } });
    expect(home.fake.runs[0]?.payload).toMatchObject({ target: "home" });
    expect(home.fake.runs[0]?.payload).not.toHaveProperty("model");
  });

  it("remarks on a chat whose picked model the owner could not save", async () => {
    const { client, fake } = fakeClient();
    fake.queueRun({ ok: true, result: { taskId: "t-unsaved", subscriptionId: "sub-1", modelSaved: false } });
    const store = createCanvasStore(client, { ...options, mintKey: () => "unsaved-1" });
    store.submit("audit the site", { model: { connectionId: "openrouter", model: "gpt-4.1" } });
    await settle();
    expect(words(store.getSnapshot().runs.find((run) => run.id === "unsaved-1")?.remark)).toBe(
      "The model picked for this chat could not be saved: it runs the default.",
    );
  });

  it("sends the folders picked on an empty chat with the prompt that starts it, Home's too, and remarks on what was not attached", async () => {
    const picked = [{ folder: { pick: "tok0000000000001" }, mode: "rw" as const }];
    const { client, fake } = fakeClient();
    fake.queueRun({
      ok: true,
      result: { taskId: "t-draft", subscriptionId: "sub-1", folder: { kind: "managed", note: "Not attached: /home/me/photos (gone)" } },
    });
    const store = createCanvasStore(client, { ...options, mintKey: () => "draft-1" });
    store.submit("sort my photos", { folderAttachments: picked });
    expect(fake.runs[0]?.payload).toMatchObject({ prompt: "sort my photos", folderAttachments: picked });
    await settle();
    expect(words(store.getSnapshot().runs.find((run) => run.id === "draft-1")?.remark)).toBe("Not attached: /home/me/photos (gone)");
    const home = fakeClient();
    const homeStore = createCanvasStore(home.client, { ...options, mintKey: () => "draft-home" });
    homeStore.setHome(true);
    homeStore.submit("sort my photos", { folderAttachments: picked });
    expect(home.fake.runs[0]?.payload).toMatchObject({ target: "home", folderAttachments: picked });
  });

  it("sends a prompt that starts nothing of its own into Home while chat.home is on, and none after New side chat", async () => {
    let home = 0;
    const own = { ...options, mintKey: () => `home-${(home += 1)}` };
    const { client, fake } = fakeClient();
    fake.queueRun({ ok: true, result: { taskId: "home-task", subscriptionId: "sub-1", conversationId: "home:operator" } });
    const store = createCanvasStore(client, own);
    store.setHome(true);
    store.submit("what's on today?", { chatInstructions: "Answer in French." });
    // Into Home: the owner makes it or admits the message as its next turn; Home keeps its own instructions.
    expect(fake.runs[0]?.payload).toMatchObject({ prompt: "what's on today?", target: "home" });
    expect(fake.runs[0]?.payload).not.toHaveProperty("chatInstructions");
    expect(store.getSnapshot().runs[0]?.toHome).toBe(true);
    await settle();
    expect(store.getSnapshot().home).toBe("home-task");
    // After New side chat: an ordinary chat, no target, its instructions kept.
    store.newTask();
    store.submit("plan the trip", { chatInstructions: "Be brief." });
    expect(fake.runs[1]?.payload).not.toHaveProperty("target");
    expect(fake.runs[1]?.payload).toMatchObject({ prompt: "plan the trip", chatInstructions: "Be brief." });
    expect(store.getSnapshot().runs[1]?.toHome).toBeUndefined();
    store.dispose();

    // Off: as before, no target.
    const off = fakeClient();
    const plain = createCanvasStore(off.client, own);
    plain.setHome(false);
    plain.submit("what's on today?");
    expect(off.fake.runs[0]?.payload).not.toHaveProperty("target");
    plain.dispose();
  });

  it("opens a Home that has no task yet: the next prompt starts it, whatever chat was on screen", async () => {
    let key = 0;
    const { client, fake } = fakeClient();
    fake.queueRun({ ok: true, result: { taskId: "side-task", subscriptionId: "sub-1" } });
    fake.queueRun({ ok: true, result: { taskId: "home-task", subscriptionId: "sub-2", conversationId: "home:operator" } });
    const store = createCanvasStore(client, { ...options, mintKey: () => `k-${(key += 1)}` });
    store.setHome(true);
    // Only + used: a chat of its own, finished, is what the page shows.
    store.newTask();
    store.submit("plan the trip");
    await settle();
    fake.runs[0]!.options.onEvent(event("task.completed", { runId: "side-task", finalText: "done" }));
    await settle();
    store.openHome();
    expect(store.getSnapshot().next).toEqual({ kind: "home" });
    store.submit("what's on today?");
    expect(fake.runs[1]?.payload).toMatchObject({ prompt: "what's on today?", target: "home" });
    expect(fake.runs[1]?.payload).not.toHaveProperty("parentChatId");
    expect(fake.runs[1]?.payload).not.toHaveProperty("taskId");
    // New side chat after it: a side chat again, not Home.
    store.newTask("home-task");
    expect(store.getSnapshot().next).toMatchObject({ kind: "new", side: true });
    store.dispose();
  });

  it("starts a turn about a heartbeat item in Home, or a new chat with Home off, naming the item and what to do with it", () => {
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, { ...options, mintKey: () => "beat-1" });
    store.heartbeatTurn({ prompt: "Do it: A payment failed", toHome: true, itemId: "hbi-1", action: "do" });
    expect(fake.runs[0]?.payload).toMatchObject({
      prompt: "Do it: A payment failed",
      target: "home",
      fromHeartbeatItemId: "hbi-1",
      heartbeatAction: "do",
    });
    expect(store.getSnapshot().runs[0]?.toHome).toBe(true);
    store.heartbeatTurn({ prompt: "Chat about this: A payment failed", toHome: false, itemId: "hbi-1", action: "chat" });
    expect(fake.runs[1]?.payload).not.toHaveProperty("target");
    expect(fake.runs[1]?.payload).not.toHaveProperty("parentChatId");
    expect(fake.runs[1]?.payload).toMatchObject({ fromHeartbeatItemId: "hbi-1", heartbeatAction: "chat" });
    store.dispose();
  });

  it("reads a chat's notices, and replies to one in a side chat of its chat that names the notice", async () => {
    const notice = {
      noticeId: "notice-1",
      taskId: "home-task",
      kind: "run-result" as const,
      sourceTaskId: "run-1",
      title: "Scheduled run “Brief”",
      summary: "Completed",
      afterSeq: 0,
      createdAt: "2026-10-04T08:00:00.000Z",
    };
    const { client, fake } = fakeClient((command, payload) =>
      command === "tasks" && (payload as { action?: string }).action === "notices"
        ? { ok: true, result: { notices: [notice] } }
        : { ok: true, result: {} },
    );
    const store = createCanvasStore(client, { ...options, mintKey: () => "reply-1" });
    store.setHome(true);
    await store.loadNotices("home-task");
    expect(fake.requests.at(-1)).toMatchObject({ command: "tasks", payload: { action: "notices", taskId: "home-task" } });
    expect(store.getSnapshot().notices?.["home-task"]).toEqual([notice]);
    store.replyToNotice(notice);
    expect(store.getSnapshot().replyingTo?.noticeId).toBe("notice-1");
    store.submit("tell me more");
    expect(fake.runs[0]?.payload).toMatchObject({ prompt: "tell me more", parentChatId: "home-task", fromNoticeId: "notice-1" });
    expect(store.getSnapshot().replyingTo).toBeUndefined();
    // The reply is for the one prompt: a later New side chat names no notice.
    store.newTask("home-task");
    store.submit("another aside");
    expect(fake.runs.at(-1)?.payload).not.toHaveProperty("fromNoticeId");
    store.dispose();
  });

  it("keeps an epoch divider the poll's newest notices no longer name, and drops one erased within their span", async () => {
    const at = (minute: number) => `2026-10-04T08:${String(minute).padStart(2, "0")}:00.000Z`;
    const notice = (id: string, minute: number, kind: "epoch" | "run-result" = "run-result") => ({
      noticeId: id,
      taskId: "home-task",
      kind,
      title: id,
      summary: "s",
      afterSeq: 0,
      createdAt: at(minute),
    });
    let polled = [notice("epoch-1", 1, "epoch"), ...Array.from({ length: 19 }, (_, index) => notice(`n-${index}`, 10 + index))];
    const { client } = fakeClient((command, payload) =>
      command === "tasks" && (payload as { action?: string }).action === "notices"
        ? { ok: true, result: { notices: polled } }
        : { ok: true, result: {} },
    );
    const store = createCanvasStore(client, { ...options, mintKey: () => "notices" });
    await store.loadNotices("home-task");
    // A busy Home: the poll's newest 20 no longer reach the divider.
    polled = Array.from({ length: 20 }, (_, index) => notice(`n-${index}`, 10 + index));
    await store.loadNotices("home-task");
    const held = store.getSnapshot().notices?.["home-task"] ?? [];
    expect(held[0]?.noticeId).toBe("epoch-1");
    expect(held).toHaveLength(21);
    // Fewer than a full poll: it covers every notice, so one it no longer names was erased.
    polled = [notice("n-19", 29)];
    await store.loadNotices("home-task");
    expect(store.getSnapshot().notices?.["home-task"]?.map((listed) => listed.noticeId)).toEqual(["n-19"]);
    store.dispose();
  });

  it("merges a saved page's notices into the chat's, by id and time", () => {
    const notice = (id: string, minute: number) => ({
      noticeId: id,
      taskId: "t",
      kind: "epoch" as const,
      title: id,
      summary: "",
      afterSeq: 0,
      createdAt: `2026-10-04T08:${String(minute).padStart(2, "0")}:00.000Z`,
    });
    expect(mergeNotices([notice("b", 5), notice("c", 9)], [notice("a", 1), notice("b", 5)]).map((listed) => listed.noticeId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("says a chat started with nothing on screen is no side chat, and one started from a chat is", () => {
    const store = createCanvasStore(fakeClient().client, options);
    store.setHome(true);
    store.newTask();
    expect(store.getSnapshot().next).toEqual({ kind: "new" });
    store.newTask("chat-2");
    expect(store.getSnapshot().next).toEqual({ kind: "new", side: true });
    store.dispose();
  });

  it("opens New side chat as a side chat of the chat on screen, never of a worker, and an ordinary chat with none", async () => {
    let side = 0;
    const own = { ...options, mintKey: () => `side-${(side += 1)}` };
    const { client, fake } = fakeClient((command, payload) =>
      command === "tasks" && (payload as { taskId?: string }).taskId === "worker-task"
        ? {
            ok: true,
            result: {
              found: true,
              task: { workspaceId: "default", origin: "ipc", chatKind: "worker", principalId: "operator", status: "completed" },
              admissions: [],
            },
          }
        : { ok: true, result: {} },
    );
    const store = createCanvasStore(client, own);
    store.setHome(true);
    store.newTask("home-task");
    store.submit("plan the trip", { chatInstructions: "Be brief." });
    expect(fake.runs[0]?.payload).toMatchObject({ prompt: "plan the trip", parentChatId: "home-task", chatInstructions: "Be brief." });
    expect(fake.runs[0]?.payload).not.toHaveProperty("target");
    // The parent is for the one prompt after New side chat.
    store.submit("and then?");
    expect(fake.runs.slice(1).every((run) => !("parentChatId" in (run.payload as object)))).toBe(true);
    // Home off: still a side chat of the chat on screen.
    store.setHome(false);
    store.newTask("chat-2");
    store.submit("aside");
    expect(fake.runs.at(-1)?.payload).toMatchObject({ prompt: "aside", parentChatId: "chat-2" });
    // Pressed again while the side chat is still a draft (nothing on screen then): the same parent.
    store.newTask("chat-3");
    store.newTask();
    store.submit("drafted twice");
    expect(fake.runs.at(-1)?.payload).toMatchObject({ prompt: "drafted twice", parentChatId: "chat-3" });
    // A worker is no chat: New side chat from it is an ordinary chat.
    await store.openTask("worker-task");
    store.newTask("worker-task");
    store.submit("from a worker");
    expect(fake.runs.at(-1)?.payload).toMatchObject({ prompt: "from a worker" });
    expect(fake.runs.at(-1)?.payload).not.toHaveProperty("parentChatId");
    // Nothing on screen: an ordinary chat.
    store.newTask();
    store.submit("fresh");
    expect(fake.runs.at(-1)?.payload).not.toHaveProperty("parentChatId");
    store.dispose();
  });

  it("starts New private chat as a private chat of its own, never Home or a side chat, for its first message only", () => {
    let key = 0;
    const own = { ...options, mintKey: () => `private-${(key += 1)}` };
    const { client, fake } = fakeClient(() => ({ ok: true, result: {} }));
    const store = createCanvasStore(client, own);
    store.setHome(true);
    store.newTask("home-task", { private: true });
    expect(store.getSnapshot().privateDraft).toBe(true);
    store.submit("a private thought");
    expect(fake.runs[0]?.payload).toMatchObject({ prompt: "a private thought", memory: "private" });
    expect(fake.runs[0]?.payload).not.toHaveProperty("parentChatId");
    expect(fake.runs[0]?.payload).not.toHaveProperty("target");
    expect(store.getSnapshot().privateDraft).toBeUndefined();
    // An ordinary New side chat after it is not private.
    store.newTask("home-task");
    store.submit("aside");
    expect(fake.runs.at(-1)?.payload).not.toHaveProperty("memory");
    store.dispose();
  });

  it("opens a chat of its own for an idea's Try it, whatever side-chat draft or notice reply was left open", () => {
    let key = 0;
    const own = { ...options, mintKey: () => `own-${(key += 1)}` };
    const { client, fake } = fakeClient(() => ({ ok: true, result: {} }));
    const store = createCanvasStore(client, own);
    // + on chat A, left a draft: Try it is not a side chat of A.
    store.newTask("chat-a");
    store.newTask(undefined, { own: true });
    store.submit("the idea's prompt");
    expect(fake.runs.at(-1)?.payload).toMatchObject({ prompt: "the idea's prompt" });
    expect(fake.runs.at(-1)?.payload).not.toHaveProperty("parentChatId");
    expect(fake.runs.at(-1)?.payload).not.toHaveProperty("memory");
    // A notice's Reply, left a draft: Try it answers no notice.
    store.replyToNotice({
      noticeId: "notice-1",
      taskId: "chat-a",
      kind: "run-result",
      sourceTaskId: "run-1",
      title: "Scheduled run “Brief”",
      summary: "Completed",
      afterSeq: 0,
      createdAt: "2026-10-19T10:00:00.000Z",
    });
    expect(store.getSnapshot().replyingTo?.noticeId).toBe("notice-1");
    store.newTask(undefined, { own: true });
    expect(store.getSnapshot().replyingTo).toBeUndefined();
    store.submit("another idea");
    expect(fake.runs.at(-1)?.payload).not.toHaveProperty("parentChatId");
    expect(fake.runs.at(-1)?.payload).not.toHaveProperty("fromNoticeId");
    store.dispose();
  });

  it("knows a Home it opens or restores, and continues it as any chat", async () => {
    let home = 0;
    const own = { ...options, mintKey: () => `opened-${(home += 1)}` };
    const { client, fake } = fakeClient((command, payload) =>
      command === "tasks" && (payload as { taskId?: string }).taskId === "home-task"
        ? {
            ok: true,
            result: {
              found: true,
              task: { workspaceId: "default", origin: "web", chatKind: "home", principalId: "operator", status: "completed" },
              admissions: [],
            },
          }
        : { ok: true, result: {} },
    );
    const store = createCanvasStore(client, own);
    store.setHome(true);
    await store.openTask("home-task");
    expect(store.getSnapshot().home).toBe("home-task");
    store.dispose();
    const restored = createCanvasStore(fakeClient().client, {
      ...own,
      memory: { load: () => ({ taskId: "home-task", conversationId: "home:operator" }), save: () => undefined },
    });
    expect(restored.getSnapshot().home).toBe("home-task");
    restored.dispose();
    expect(fake.runs).toEqual([]);
  });

  it("publishes where the next prompt goes, the decision submit acts on", async () => {
    let home = 0;
    const own = { ...options, mintKey: () => `next-${(home += 1)}` };
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, own);
    expect(store.getSnapshot().next).toEqual({ kind: "new" });
    store.setHome(true);
    expect(store.getSnapshot().next).toEqual({ kind: "home" });
    store.newTask();
    expect(store.getSnapshot().next).toEqual({ kind: "new" });
    // A chat on screen that nothing continues — its prompt refused at admission — is not where the next prompt goes.
    fake.queueRun({ ok: false, error: { code: "INVALID_INPUT", message: "refused" } });
    store.submit("plan the trip");
    await settle();
    expect(store.getSnapshot().runs.at(-1)?.error).toBeDefined();
    expect(store.getSnapshot().next).toEqual({ kind: "home" });
    store.submit("so, what now?");
    expect(fake.runs.at(-1)?.payload).toMatchObject({ target: "home" });
    store.dispose();
  });

  it("continues a settled Home by its conversation, and queues behind a Home turn still running", async () => {
    sequence = 0;
    let home = 0;
    const own = { ...options, mintKey: () => `cont-${(home += 1)}` };
    const { client, fake } = fakeClient();
    fake.queueRun({ ok: true, result: { taskId: "home-task", subscriptionId: "sub-1", conversationId: "home:operator" } });
    const store = createCanvasStore(client, own);
    store.setHome(true);
    store.submit("first");
    await settle();
    const first = fake.runs[0]!.options.onEvent!;
    first(event("run.started", { runId: "home-task", threadId: "t", workspaceId: "default" }));
    first(event("task.completed", { runId: "home-task", finalText: "done" }));
    expect(store.getSnapshot().next).toEqual({ kind: "continue", taskId: "home-task" });
    store.submit("next");
    for (let index = 0; index < 4; index += 1) await settle();
    // A reply into Home's conversation, never a second run.
    expect(fake.runs).toHaveLength(1);
    expect(fake.requests.find((request) => request.command === "reply")?.payload).toMatchObject({
      conversationId: "home:operator",
      text: "next",
    });
    store.dispose();

    // Home's turn still running while another chat is last on the page: a prompt for Home waits behind it.
    const busy = fakeClient();
    busy.fake.queueRun({ ok: true, result: { taskId: "home-task", subscriptionId: "sub-1", conversationId: "home:operator" } });
    busy.fake.queueRun({ ok: false, error: { code: "INVALID_INPUT", message: "refused" } });
    const queued = createCanvasStore(busy.client, own);
    queued.setHome(true);
    queued.submit("first");
    await settle();
    busy.fake.runs[0]!.options.onEvent!(event("run.started", { runId: "home-task", threadId: "t", workspaceId: "default" }));
    queued.newTask();
    queued.submit("a side chat");
    await settle();
    expect(queued.getSnapshot().next).toEqual({ kind: "queue", taskId: "home-task" });
    queued.submit("and for Home");
    expect(busy.fake.runs).toHaveLength(2);
    expect(queued.getSnapshot().runs.at(-1)).toMatchObject({ prompt: "and for Home", queued: true, continues: "home-task" });
    queued.dispose();
  });

  it("lets go of Home's earlier entries when a message to Home is admitted, but never one whose turn still runs", async () => {
    sequence = 0;
    let home = 0;
    const own = { ...options, mintKey: () => `ret-${(home += 1)}` };
    const admitted = { ok: true, result: { taskId: "home-task", subscriptionId: "sub", conversationId: "home:operator" } } as const;
    const { client, fake } = fakeClient();
    fake.queueRun(admitted);
    fake.queueRun({ ok: false, error: { code: "INVALID_INPUT", message: "refused" } });
    fake.queueRun(admitted);
    const store = createCanvasStore(client, own);
    store.setHome(true);
    store.submit("first");
    await settle();
    // Home's first turn asks a question: its stream stays open, and it is not busy.
    const first = fake.runs[0]!.options.onEvent!;
    first(event("run.started", { runId: "home-task", threadId: "t", workspaceId: "default" }));
    first(event("task.waiting", { runId: "home-task", on: "a reply", deadlineAt: "2099-01-01T00:00:00.000Z", question: "Which one?" }));
    // A side chat refused at admission is last: the next prompt goes to Home by target.
    store.newTask();
    store.submit("a side chat");
    await settle();
    store.submit("for Home");
    await settle();
    expect(fake.runs[2]?.payload).toMatchObject({ target: "home" });
    expect(fake.closed).toContain("run-1");
    store.dispose();

    // A Home turn still running — one this page did not know was Home's — is left to finish on its own stream.
    const running = fakeClient();
    running.fake.queueRun(admitted);
    running.fake.queueRun({ ok: false, error: { code: "INVALID_INPUT", message: "refused" } });
    running.fake.queueRun(admitted);
    const kept = createCanvasStore(running.client, own);
    kept.submit("first");
    await settle();
    running.fake.runs[0]!.options.onEvent!(event("run.started", { runId: "home-task", threadId: "t", workspaceId: "default" }));
    kept.newTask();
    kept.submit("a side chat");
    await settle();
    kept.setHome(true);
    kept.submit("for Home");
    await settle();
    expect(running.fake.runs[2]?.payload).toMatchObject({ target: "home" });
    expect(running.fake.closed).not.toContain("run-1");
    expect(kept.getSnapshot().runs[0]?.run.status).toBe("running");
  });

  it("sends a prompt as a run the page answers rounds for, and folds its stream with the client's reducer", () => {
    sequence = 0;
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, options);
    let notified = 0;
    store.subscribe(() => (notified += 1));
    store.submit("write the brief");
    expect(fake.runs[0]?.payload).toEqual({
      prompt: "write the brief",
      workspaceId: "default",
      principal: "operator",
      operationKey: "ui-1",
      approval: "client",
    });
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.(event("text.delta", { blockId: "b", text: "the " }));
    onEvent?.(event("text.delta", { blockId: "b", text: "brief" }));
    const [run] = store.getSnapshot().runs;
    expect(run?.run.transcript).toMatchObject([{ kind: "text", text: "the brief" }]);
    expect(run?.run.status).toBe("running");
    expect(notified).toBeGreaterThanOrEqual(2);
  });

  it("does not decide a round until every call the owner listed for it has arrived", async () => {
    sequence = 0;
    const { client, fake } = fakeClient(listing(3, "c1", "c2"));
    const store = createCanvasStore(client, options);
    store.submit("tidy the inbox");
    const id = store.getSnapshot().runs[0]?.id ?? "";
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.(event("approval.required", call(3, "c1")));
    await settle();
    // Listed once, as the first call of the round arrived.
    expect(fake.requests).toEqual([
      { command: "approvals", payload: { action: "list", taskId: "task-1", workspaceId: "default", limit: 1000 } },
    ]);
    const firstOnly = store.getSnapshot().runs[0];
    expect(firstOnly !== undefined && decidableRound(firstOnly)).toBeFalsy();
    store.decide(id, true);
    expect(fake.requests.filter((request) => request.command === "approve")).toEqual([]);

    onEvent?.(event("approval.required", call(3, "c2")));
    await settle();
    expect(fake.requests.filter((request) => request.command === "approvals")).toHaveLength(1);
    store.decide(id, true);
    await settle();
    expect(fake.requests.filter((request) => request.command === "approve")).toEqual([
      {
        command: "approve",
        payload: { taskId: "task-1", workspaceId: "default", expectedSteps: 3, verdict: "approve", decidedBy: "operator" },
      },
    ]);
  });

  it("holds a decision until the owner settles its round, so a second click sends nothing", async () => {
    sequence = 0;
    const { client, fake } = fakeClient(listing(1, "c1"));
    const store = createCanvasStore(client, options);
    store.submit("send it");
    const id = store.getSnapshot().runs[0]?.id ?? "";
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.(event("approval.required", call(1, "c1")));
    await settle();
    store.decide(id, false);
    await settle();
    // Answered: still deciding, until the stream says the round settled.
    expect(store.getSnapshot().runs[0]?.deciding).toBe(1);
    store.decide(id, false);
    await settle();
    expect(fake.requests.filter((request) => request.command === "approve")).toHaveLength(1);
    onEvent?.(event("approval.settled", { steps: 1, decisions: [{ callId: "c1", approved: false }], decidedBy: "operator" }));
    expect(store.getSnapshot().runs[0]?.deciding).toBeUndefined();
    expect(store.getSnapshot().runs[0]?.error).toBeUndefined();
  });

  it("closes a finished run's stream, so an owner restart cannot erase its transcript", () => {
    sequence = 0;
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, options);
    store.submit("done soon");
    return settle().then(() => {
      const onEvent = fake.runs[0]?.options.onEvent;
      onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      onEvent?.(event("task.completed", { finalText: "done" }));
      expect(fake.closed).toEqual(["run-1"]);
      expect(store.getSnapshot().runs[0]?.run.outcome).toEqual({ kind: "completed", finalText: "done" });
    });
  });

  it("reads a suspension a resync erased back from the task's record, round whole", async () => {
    sequence = 0;
    const record = {
      task: { status: "waiting" },
      admissions: [
        {
          kind: "start",
          operationKey: "ui-1",
          state: "committed",
          result: {
            status: "waiting",
            interrupt: {
              requests: [
                { toolName: "mail.send", callId: "c1" },
                { toolName: "mail.send", callId: "c2" },
              ],
            },
          },
        },
      ],
    };
    const { client, fake } = fakeClient((command) =>
      command === "tasks" ? { ok: true, result: record } : listing(4, "c1", "c2")(command, undefined),
    );
    const store = createCanvasStore(client, options);
    store.submit("wait for me");
    const id = store.getSnapshot().runs[0]?.id ?? "";
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2" });
    expect(words(store.getSnapshot().runs[0]?.notice)).toContain("owner restarted");
    await settle();
    await settle();
    const run = store.getSnapshot().runs[0];
    expect(fake.requests.map((request) => request.command)).toEqual(["tasks", "approvals"]);
    expect(run?.run.status).toBe("awaiting_approval");
    expect(run?.run.pending[0]?.steps).toBe(4);
    expect(words(run?.notice)).toContain("no longer holds");
    expect(run !== undefined && decidableRound(run)?.steps).toBe(4);
    store.decide(id, true);
    await settle();
    expect(fake.requests.at(-1)).toMatchObject({ command: "approve", payload: { expectedSteps: 4 } });
  });

  it("resumes a stream that lost its place from the last event applied, and says so when it cannot", async () => {
    sequence = 0;
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, options);
    store.submit("follow me");
    await settle();
    const first = fake.runs[0]?.options;
    first?.onEvent(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    const orderError = new TaviError("CONFLICT", "expected sequence 1, received 3", { details: { reason: "event-order" } });
    first?.onEnd?.(orderError);
    await settle();
    expect(fake.subscribes).toHaveLength(1);
    expect(fake.subscribes[0]?.taskId).toBe("task-1");
    expect(fake.subscribes[0]?.options.from).toEqual({ epoch: "epoch-1", sequence: 0 });
    // Resumed three times, then given up on in words.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fake.subscribes.at(-1)?.options.onEnd?.(orderError);
      await settle();
    }
    expect(fake.subscribes).toHaveLength(3);
    expect(words(store.getSnapshot().runs[0]?.error)).toContain("lost its place");
  });

  it("rejoins a timed-out run once under its key, and says why a run could not start", async () => {
    sequence = 0;
    const { client, fake } = fakeClient();
    fake.queueRun({ ok: false, error: { code: "TIMEOUT", message: "the owner did not answer run" } });
    const store = createCanvasStore(client, options);
    store.submit("slow");
    await settle();
    await settle();
    expect(fake.runs).toHaveLength(2);
    expect((fake.runs[1]?.payload as { operationKey: string }).operationKey).toBe(
      (fake.runs[0]?.payload as { operationKey: string }).operationKey,
    );
    expect(store.getSnapshot().runs[0]?.error).toBeUndefined();

    fake.queueRun({ ok: false, error: { code: "NOT_CONFIGURED", message: "no model is configured" } });
    store.submit("anything");
    await settle();
    expect(words(store.getSnapshot().runs[1]?.error)).toBe("no model is configured");
  });

  it("stops a running turn once, treats nothing running as no failure, and clears an old error when acting again", async () => {
    sequence = 0;
    const { client, fake } = fakeClient((command) =>
      command === "abort"
        ? { ok: false, error: { code: "NOT_RUNNING", message: "nothing runs" } }
        : { ok: false, error: { code: "CONFLICT", message: "decided elsewhere" } },
    );
    const store = createCanvasStore(client, options);
    store.submit("long");
    const id = store.getSnapshot().runs[0]?.id ?? "";
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    store.abort(id);
    store.abort(id);
    expect(fake.requests.filter((request) => request.command === "abort")).toHaveLength(1);
    await settle();
    expect(store.getSnapshot().runs[0]?.aborting).toBe(false);
    expect(store.getSnapshot().runs[0]?.error).toBeUndefined();

    fake.runs[0]?.options.onEnd?.(new Error("the owner refused to resume the stream"));
    expect(words(store.getSnapshot().runs[0]?.error)).toBe("the owner refused to resume the stream");
    store.abort(id);
    expect(store.getSnapshot().runs[0]?.error).toBeUndefined();
  });

  describe("a prompt typed while the chat's turn goes on is queued, not forked", () => {
    const going = async () => {
      sequence = 0;
      const { client, fake } = fakeClient(() => ({ ok: true, result: { taskId: "task-1", conversationId: "ui-1", duplicate: false } }));
      fake.queueRun({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", conversationId: "ui-1" } });
      const store = createCanvasStore(client, options);
      store.submit("first");
      await settle();
      const onEvent = fake.runs[0]?.options.onEvent;
      onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      return { fake, store, onEvent };
    };

    it("holds the prompt until the turn ends, then sends it as the chat's next turn", async () => {
      const { fake, store, onEvent } = await going();
      store.submit("and then this");
      store.submit("and this too");
      await settle();
      expect(fake.runs).toHaveLength(1);
      expect(fake.requests.filter((request) => request.command === "reply")).toHaveLength(0);
      expect(store.getSnapshot().runs.map((run) => run.queued === true)).toEqual([false, true, true]);
      onEvent?.(event("task.completed", { finalText: "done" }));
      await settle();
      await settle();
      await settle();
      const replies = fake.requests.filter((request) => request.command === "reply");
      expect(replies).toHaveLength(1);
      expect(replies[0]?.payload).toMatchObject({ conversationId: "ui-1", text: "and then this" });
      expect(store.getSnapshot().runs[1]?.queued).toBeUndefined();
      expect(store.getSnapshot().runs[2]?.queued).toBe(true);
      expect(fake.runs).toHaveLength(1);
      store.dispose();
    });

    it("answers the question a chat waits on with what is typed, instead of starting a task", async () => {
      const { fake, store, onEvent } = await going();
      onEvent?.(
        event("task.waiting", { on: "the operator", wait: { waitId: "w-1", deadlineAt: "2099-01-01T00:00:00Z" }, question: "Which one?" }),
      );
      await settle();
      store.submit("the blue one");
      await settle();
      await settle();
      expect(fake.runs).toHaveLength(1);
      expect(
        fake.requests.some((request) => request.command === "reply" && (request.payload as { text?: string }).text === "the blue one"),
      ).toBe(true);
      store.dispose();
    });

    it("queues a message with files behind a chat waiting on a question, rather than answering or starting a chat", async () => {
      const { fake, store, onEvent } = await going();
      onEvent?.(
        event("task.waiting", { on: "the operator", wait: { waitId: "w-1", deadlineAt: "2099-01-01T00:00:00Z" }, question: "Which one?" }),
      );
      await settle();
      store.submit("this form", { attachments: ["art-up-3"] });
      await settle();
      expect(fake.runs).toHaveLength(1);
      expect(fake.requests.filter((request) => request.command === "reply")).toHaveLength(0);
      expect(store.getSnapshot().runs.at(-1)).toMatchObject({ queued: true, carriesFiles: true });
      store.dispose();
    });

    it("queues a message behind a chat waiting on the reader in the browser, never sending it to Home", async () => {
      const { fake, store, onEvent } = await going();
      onEvent?.(
        event("task.waiting", {
          on: "the operator",
          wait: { waitId: "w-1", deadlineAt: "2099-01-01T00:00:00Z" },
          handoff: { sessionId: "browser-session-1", reason: "Sign in to the portal", kind: "login" },
        }),
      );
      await settle();
      expect(store.getSnapshot().next).toEqual({ kind: "queue", taskId: "task-1" });
      store.submit("and the October bill too");
      await settle();
      expect(fake.runs).toHaveLength(1);
      expect(store.getSnapshot().runs.at(-1)).toMatchObject({ queued: true, continues: "task-1" });
      store.dispose();
    });

    it("takes back a queued prompt: it is never sent", async () => {
      const { fake, store, onEvent } = await going();
      store.submit("never mind");
      const id = store.getSnapshot().runs[1]?.id ?? "";
      store.cancelQueued(id);
      expect(store.getSnapshot().runs).toHaveLength(1);
      onEvent?.(event("task.completed", { finalText: "done" }));
      await settle();
      await settle();
      expect(fake.requests.filter((request) => request.command === "reply")).toHaveLength(0);
      store.dispose();
    });

    describe("rewind", () => {
      const saved = (seq: number, prompt: string) => ({
        taskId: "task-1",
        seq,
        turn: {
          admissionKind: seq === 1 ? "start" : "reply",
          prompt,
          items: [],
          outcome: { status: "completed", finalText: `answer to ${prompt}` },
        },
        createdAt: "2026-10-05T00:00:00.000Z",
      });
      const rewinding =
        (rewound: Record<string, unknown> | undefined) =>
        (command: string, payload: unknown): ClientResponse => {
          if (command === "tasks") return { ok: true, result: { entries: [saved(1, "first")] } };
          if (command === "chat-context")
            return rewound === undefined
              ? { ok: false, error: { code: "CONFLICT", message: "Chat task-1 has a turn running: stop it, then rewind" } }
              : { ok: true, result: rewound };
          return {
            ok: true,
            result: { taskId: "task-1", conversationId: "ui-1", duplicate: (payload as { intent?: string }).intent === undefined },
          };
        };

      it("finds a turn sent from the page among the saved ones, takes it back, and keeps the chat the one a message goes to", async () => {
        const { fake, store, onEvent } = await going();
        fake.answer = rewinding({ taskId: "task-1", seq: 1, rewound: 1, prompt: "first" });
        onEvent?.(event("task.completed", { finalText: "done" }));
        await settle();
        const taken = await store.rewind(store.getSnapshot().runs[0]?.id ?? "");
        expect(taken).toEqual({ ok: true, prompt: "first" });
        expect(fake.requests.find((request) => request.command === "chat-context")?.payload).toEqual({
          action: "rewind",
          workspaceId: "default",
          taskId: "task-1",
          seq: 1,
          prompt: "first",
        });
        expect(store.getSnapshot().runs).toEqual([]);
        expect(store.getSnapshot().next).toEqual({ kind: "continue", taskId: "task-1" });
        store.dispose();
      });

      it("takes nothing back while the chat's turn goes on, and keeps the turns when the owner refuses", async () => {
        const { fake, store, onEvent } = await going();
        fake.answer = rewinding(undefined);
        const id = store.getSnapshot().runs[0]?.id ?? "";
        expect(await store.rewind(id)).toMatchObject({ ok: false, message: expect.stringContaining("Wait for the chat's turn to end") });
        onEvent?.(event("task.completed", { finalText: "done" }));
        await settle();
        expect(await store.rewind(id)).toMatchObject({ ok: false, message: expect.stringContaining("has a turn running") });
        expect(store.getSnapshot().runs).toHaveLength(1);
        store.dispose();
      });
    });

    describe("Send now", () => {
      /** A turn going, whose owner takes a steer while it runs: `steered` says whether the turn still ran. */
      const steering = async (steered: boolean) => {
        sequence = 0;
        const { client, fake } = fakeClient((command, payload) =>
          command === "reply" && (payload as { intent?: string }).intent === "steer" && steered
            ? { ok: true, result: { taskId: "task-1", conversationId: "ui-1", duplicate: false, steered: true } }
            : {
                ok: true,
                result: {
                  taskId: "task-1",
                  conversationId: "ui-1",
                  duplicate: (payload as { intent?: string }).intent === undefined && !steered,
                },
              },
        );
        fake.queueRun({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", conversationId: "ui-1" } });
        const store = createCanvasStore(client, options);
        store.submit("first");
        await settle();
        const onEvent = fake.runs[0]?.options.onEvent;
        onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
        return { fake, store, onEvent };
      };

      it("sends a queued prompt into the running turn, and shows it there once the turn takes it", async () => {
        const { fake, store, onEvent } = await steering(true);
        store.submit("in kilometres, please");
        const id = store.getSnapshot().runs[1]?.id ?? "";
        store.steerQueued(id);
        expect(store.getSnapshot().runs[1]?.steering).toBe("sending");
        await settle();
        const replies = fake.requests.filter((request) => request.command === "reply");
        expect(replies.map((request) => request.payload)).toEqual([
          { workspaceId: "default", conversationId: "ui-1", text: "in kilometres, please", clientMessageId: id, intent: "steer" },
        ]);
        expect(store.getSnapshot().runs[1]).toMatchObject({ queued: true, steering: "sent" });
        // Not taken back once it is the turn's.
        store.cancelQueued(id);
        expect(store.getSnapshot().runs).toHaveLength(2);
        onEvent?.(event("turn.steered", { messageId: id, text: "in kilometres, please" }));
        await settle();
        // Its queued entry goes: the running turn shows it, where the model read it.
        expect(store.getSnapshot().runs).toHaveLength(1);
        expect(store.getSnapshot().runs[0]?.run.transcript.at(-1)).toMatchObject({
          kind: "steer",
          messageId: id,
          text: "in kilometres, please",
        });
        onEvent?.(event("task.completed", { finalText: "12 km" }));
        await settle();
        await settle();
        // Nothing left to send after the turn.
        expect(fake.requests.filter((request) => request.command === "reply")).toHaveLength(1);
        store.dispose();
      });

      it("waits for the turn before to end when the owner found no turn running: only the mark is cleared", async () => {
        const { fake, store, onEvent } = await steering(false);
        onEvent?.(event("text.delta", { blockId: "b1", text: "still writing" }));
        store.submit("too late to steer");
        const id = store.getSnapshot().runs[1]?.id ?? "";
        store.steerQueued(id);
        await settle();
        await settle();
        // Answered not steered while the turn before's last events are still on their way.
        expect(store.getSnapshot().runs[1]).toMatchObject({ id, queued: true });
        expect(store.getSnapshot().runs[1]?.steering).toBeUndefined();
        expect(fake.requests.filter((request) => request.command === "reply")).toHaveLength(1);
        // The turn before is followed on, not retired: its text keeps arriving.
        onEvent?.(event("text.delta", { blockId: "b1", text: ", done" }));
        expect(store.getSnapshot().runs[0]?.run.transcript.at(-1)).toMatchObject({ kind: "text", text: "still writing, done" });
        onEvent?.(event("task.completed", { finalText: "done" }));
        await settle();
        await settle();
        await settle();
        // Now sent as the chat's next turn, under the same id: the owner's hand-off and this are one message.
        const replies = fake.requests
          .filter((request) => request.command === "reply")
          .map((request) => request.payload as { clientMessageId: string; intent?: string });
        expect(replies.map((reply) => [reply.clientMessageId, reply.intent])).toEqual([
          [id, "steer"],
          [id, undefined],
        ]);
        expect(store.getSnapshot().runs.find((run) => run.id === id)?.queued).toBeUndefined();
        store.dispose();
      });

      it("follows a steer the turn ended before taking as the chat's next turn: the same message, sent again", async () => {
        const { fake, store, onEvent } = await steering(true);
        store.submit("one more thing");
        store.submit("and after it");
        const id = store.getSnapshot().runs[2]?.id ?? "";
        // The later prompt goes first: Send now puts it at the head of the queue.
        store.steerQueued(id);
        await settle();
        onEvent?.(event("task.completed", { finalText: "done" }));
        await settle();
        await settle();
        await settle();
        const replies = fake.requests
          .filter((request) => request.command === "reply")
          .map((request) => request.payload as { text: string; clientMessageId: string; intent?: string });
        expect(replies.map((reply) => [reply.text, reply.clientMessageId, reply.intent])).toEqual([
          ["and after it", id, "steer"],
          ["and after it", id, undefined],
        ]);
        expect(store.getSnapshot().runs.find((run) => run.id === id)).toMatchObject({ prompt: "and after it" });
        expect(store.getSnapshot().runs.find((run) => run.id === id)?.queued).toBeUndefined();
        expect(store.getSnapshot().runs.find((run) => run.prompt === "one more thing")?.queued).toBe(true);
        store.dispose();
      });
    });

    it("does not send what was queued behind a task that was cancelled", async () => {
      const { fake, store, onEvent } = await going();
      store.submit("after that");
      onEvent?.(event("task.failed", { errorCode: "TASK_CANCELLED", message: "cancelled" }));
      await settle();
      expect(words(store.getSnapshot().runs[1]?.error)).toContain("cancelled, so this prompt was not sent");
      expect(store.getSnapshot().runs[1]?.queued).toBeUndefined();
      expect(fake.requests.filter((request) => request.command === "reply")).toHaveLength(0);
      store.dispose();
    });
  });

  describe("continuing a finished task", () => {
    /** A page whose first prompt ran as task-1, conversation ui-1, and completed. */
    const finished = async (answer?: Answer, extra: { readonly settleMs?: number } = {}) => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient(answer);
      fake.queueRun({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", conversationId: "ui-1" } });
      const store = createCanvasStore(client, { ...options, ...extra });
      store.submit("name a colour");
      await settle();
      const onEvent = fake.runs[0]?.options.onEvent;
      onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      onEvent?.(event("task.completed", { finalText: "blue" }));
      return { client, fake, store };
    };
    /** `finished`, under fake timers: its waits advance them. */
    const finishedFaked = async (answer?: Answer) => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient(answer);
      fake.queueRun({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", conversationId: "ui-1" } });
      const store = createCanvasStore(client, options);
      store.submit("name a colour");
      await vi.advanceTimersByTimeAsync(0);
      const onEvent = fake.runs[0]?.options.onEvent;
      onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      onEvent?.(event("task.completed", { finalText: "blue" }));
      return { client, fake, store };
    };
    const replies = (fake: ReturnType<typeof fakeClient>["fake"]) =>
      fake.requests.filter((request) => request.command === "reply").map((request) => request.payload);

    it("sends the next prompt as a reply into the task's conversation, following its stream from where the last turn stopped", async () => {
      const { fake, store } = await finished();
      expect(store.getSnapshot().continuing).toBe("task-1");
      store.submit("and another");
      expect(store.getSnapshot().continuing).toBeUndefined();
      await settle();
      await settle();
      // No second run: the stream is followed from the last event the turn before applied, then the reply sent under the entry's id.
      expect(fake.runs).toHaveLength(1);
      expect(fake.subscribes.map((subscribe) => [subscribe.taskId, subscribe.options.from])).toEqual([
        ["task-1", store.getSnapshot().runs[0]?.run.cursor],
      ]);
      expect(replies(fake)).toEqual([{ workspaceId: "default", conversationId: "ui-1", text: "and another", clientMessageId: "ui-2" }]);
      const turn = store.getSnapshot().runs[1];
      expect(turn?.continues).toBe("task-1");
      // Its turn arrives on that stream, opening with the resume boundary a follow-up turn is:
      // not drawn, since the entry says it continues the task; nor is it a late join.
      const onEvent = fake.subscribes[0]?.options.onEvent;
      onEvent?.(event("attempt.replaced", { attemptId: "attempt-2", supersededAttemptId: "attempt-1", reason: "resuming after reply" }));
      onEvent?.({ ...event("text.delta", { blockId: "b2", text: "green" }), attemptId: "attempt-2" });
      expect(store.getSnapshot().runs[1]?.run.truncated).toBe(false);
      expect(store.getSnapshot().runs[1]?.run.transcript).toMatchObject([{ kind: "text", text: "green" }]);
      expect(store.getSnapshot().runs[1]?.run.transcript).toHaveLength(1);
      // A boundary later in the turn (an approval's resume) is drawn as ever.
      onEvent?.(event("attempt.replaced", { attemptId: "attempt-3", supersededAttemptId: "attempt-2", reason: "resuming after approval" }));
      expect(store.getSnapshot().runs[1]?.run.transcript.at(-1)).toMatchObject({ kind: "boundary", reason: "resuming after approval" });
      onEvent?.({ ...event("task.completed", { finalText: "green" }), attemptId: "attempt-3" });
      expect(store.getSnapshot().continuing).toBe("task-1");
    });

    it("keeps writing to a finished chat after its kept page is handed back (QA 2001)", async () => {
      const { fake, store } = await finished();
      expect(store.getSnapshot().next).toEqual({ kind: "continue", taskId: "task-1" });
      // The person took the page the finished turn kept, then handed it back: a note between turns.
      fake.runs[0]?.options.onEvent?.(event("browser.controlled", { sessionId: "browser-1", outcome: "done", controlledMs: 3000 }));
      expect(store.getSnapshot().runs[0]?.run.browserControls).toHaveLength(1);
      expect(store.getSnapshot().next).toEqual({ kind: "continue", taskId: "task-1" });
    });

    it("lets the reread of a finished chat go once its hand-back row is replayed, so a reply is drawn once (QA 2103)", async () => {
      const { fake, store } = await finished();
      // The page reads the chat again after a kept page is handed back: the owner holds one event since, that row.
      fake.subscribeResponse = { ok: true, result: { replayed: 1 } };
      await store.openTask("task-1");
      await settle();
      fake.subscribes[0]?.options.onEvent?.(event("browser.controlled", { sessionId: "browser-1", outcome: "done", controlledMs: 3000 }));
      expect(fake.closed).toContain("resume-1");
    });

    it("shows a plugin's line cleared between the turns, without taking it for the turn starting", async () => {
      const { fake, store } = await finished();
      const first = fake.runs[0]?.options.onEvent;
      first?.(event("plugin.status", { pluginId: "acme.tally", line: "1 call" }));
      expect(chatPluginStatus(store.getSnapshot().runs, "task-1")).toEqual({ "acme.tally": "1 call" });
      store.submit("and another");
      await settle();
      await settle();
      const onEvent = fake.subscribes[0]?.options.onEvent;
      // The plugin was disabled between the turns: its clear is replayed from the last turn's cursor.
      onEvent?.(event("plugin.status", { pluginId: "acme.tally" }));
      expect(chatPluginStatus(store.getSnapshot().runs, "task-1")).toEqual({});
      expect(store.getSnapshot().runs[1]?.run.truncated).toBe(false);
      // The turn itself still opens as a continuation: its resume boundary is not drawn, nor is it a late join.
      onEvent?.(event("attempt.replaced", { attemptId: "attempt-2", supersededAttemptId: "attempt-1", reason: "resuming after reply" }));
      onEvent?.({ ...event("text.delta", { blockId: "b2", text: "green" }), attemptId: "attempt-2" });
      expect(store.getSnapshot().runs[1]?.run.truncated).toBe(false);
      expect(store.getSnapshot().runs[1]?.run.transcript).toMatchObject([{ kind: "text", text: "green" }]);
    });

    it("takes a resync of the place it resumes from as lines it cannot trust, not an owner restart", async () => {
      const { fake, store } = await finished();
      fake.runs[0]?.options.onEvent?.(event("plugin.status", { pluginId: "acme.tally", line: "1 call" }));
      store.submit("and another");
      // Subscribed, its prompt not yet sent.
      for (let tick = 0; tick < 3 && fake.subscribes.length === 0; tick += 1) await Promise.resolve();
      expect(replies(fake)).toHaveLength(0);
      // The owner no longer holds what came after the last turn (its ring was evicted).
      fake.subscribes[0]?.options.onEvent?.(event("resync.required", {}));
      expect(chatPluginStatus(store.getSnapshot().runs, "task-1")).toEqual({});
      expect(store.getSnapshot().runs[1]?.notice).toBeUndefined();
      await settle();
      await settle();
      expect(replies(fake)).toHaveLength(1);
    });

    it("follows from now when the place's replay holds another turn of the task, and still sends the prompt", async () => {
      const { fake, store } = await finished();
      store.submit("and another");
      for (let tick = 0; tick < 3 && fake.subscribes.length === 0; tick += 1) await Promise.resolve();
      // A message from a channel into the chat ran a turn meanwhile: its events follow the place.
      const replayed = fake.subscribes[0]?.options.onEvent;
      replayed?.(event("attempt.replaced", { attemptId: "attempt-2", supersededAttemptId: "attempt-1", reason: "resuming after reply" }));
      replayed?.({ ...event("text.delta", { blockId: "b9", text: "FOREIGN" }), attemptId: "attempt-2" });
      replayed?.({ ...event("task.completed", { finalText: "FOREIGN" }), attemptId: "attempt-2" });
      await settle();
      await settle();
      expect(fake.subscribes).toHaveLength(2);
      expect("from" in (fake.subscribes[1]?.options ?? {})).toBe(false);
      expect(replies(fake)).toHaveLength(1);
      expect(store.getSnapshot().runs[1]?.run.transcript).toEqual([]);
      expect(store.getSnapshot().runs[1]?.run.status).not.toBe("completed");
    });

    it("draws another turn's round when the owner refuses the prompt for it, so it can be decided here", async () => {
      const refusal = {
        ok: false as const,
        error: { code: "CONFLICT", message: "task task-1 waits on its approval round 3: decide it (approve) first; nothing was delivered" },
      };
      const { fake, store } = await finished((command, payload) => (command === "reply" ? refusal : listing(3, "c1")(command, payload)));
      const place = store.getSnapshot().runs[0]?.run.cursor;
      store.submit("and another");
      for (let tick = 0; tick < 3 && fake.subscribes.length === 0; tick += 1) await Promise.resolve();
      // A message from a channel ran a turn meanwhile, which waits on a round.
      const foreign = [
        event("attempt.replaced", { attemptId: "attempt-2", supersededAttemptId: "attempt-1", reason: "resuming after reply" }),
        { ...event("approval.required", call(3, "c1")), attemptId: "attempt-2" },
      ];
      for (const replayed of foreign) fake.subscribes[0]?.options.onEvent?.(replayed);
      fake.subscribeResponse = { ok: true, result: { replayed: foreign.length } };
      await settle();
      await settle();
      await settle();
      expect(words(store.getSnapshot().unsent?.message)).toContain("waits on its approval round 3");
      // The chat is taken up again from the place, and the other turn is an entry of its own, its round decidable.
      expect(fake.subscribes).toHaveLength(3);
      expect(fake.subscribes[2]?.options).toMatchObject({ from: place });
      for (const replayed of foreign) fake.subscribes[2]?.options.onEvent?.(replayed);
      await settle();
      const drawn = store.getSnapshot().runs.at(-1);
      expect(drawn?.run.status).toBe("awaiting_approval");
      expect(drawn !== undefined && decidableRound(drawn)).toBeTruthy();
    });

    it("takes the shown chat up again when the chat list says it waits on its person while the page holds it settled", async () => {
      let listed = {
        taskId: "task-1",
        workspaceId: "default",
        status: "input-required",
        origin: "messaging",
        createdAt: "2026-10-19T08:31:13.144Z",
        updatedAt: "2026-10-19T11:44:28.006Z",
        needs: ["approval"],
        counts: { admissions: 3, tools: null },
      };
      const { fake, store } = await finished((command) =>
        command === "tasks" ? { ok: true, result: { action: "list", rows: [listed], truncated: false } } : { ok: true, result: {} },
      );
      const place = store.getSnapshot().runs[0]?.run.cursor;
      const before = fake.subscribes.length;
      // A replay that holds nothing new leaves the chat settled as it was.
      fake.subscribeResponse = { ok: true, result: { replayed: 1 } };
      await store.loadSessions();
      expect(fake.subscribes.slice(before).map((subscribe) => subscribe.options)).toMatchObject([{ from: place }]);
      await settle();
      expect(store.getSnapshot().runs.at(-1)?.run.status).toBe("completed");
      // Once per change in the list, not on every refresh.
      await store.loadSessions();
      expect(fake.subscribes.length).toBe(before + 1);
      listed = { ...listed, updatedAt: "2026-10-19T12:00:00.000Z" };
      await store.loadSessions();
      expect(fake.subscribes.length).toBe(before + 2);
    });

    it("follows the shown chat again when the chat list says it took a turn the page did not start, as Home on a worker's answer", async () => {
      const listed = {
        taskId: "task-1",
        workspaceId: "default",
        status: "working",
        origin: "ipc",
        chatKind: "home",
        createdAt: "2026-10-19T08:31:13.144Z",
        updatedAt: "2026-10-19T11:44:28.006Z",
        needs: [],
        counts: { admissions: 3, tools: null },
      };
      const { fake, store } = await finished((command) =>
        command === "tasks" ? { ok: true, result: { action: "list", rows: [listed], truncated: false } } : { ok: true, result: {} },
      );
      const place = store.getSnapshot().runs[0]?.run.cursor;
      const before = fake.subscribes.length;
      fake.subscribeResponse = { ok: true, result: { replayed: 1 } };
      await store.loadSessions();
      expect(fake.subscribes.slice(before).map((subscribe) => subscribe.options)).toMatchObject([{ from: place }]);
      // Once per change in the list.
      await store.loadSessions();
      expect(fake.subscribes.length).toBe(before + 1);
    });

    it("follows the shown chat again when the list shows it changed since it settled, though no poll saw it working", async () => {
      // Home's turn on a worker's answer can start and end between two polls: the list only shows it updated since.
      const listed = (updatedAt: string) => ({
        taskId: "task-1",
        workspaceId: "default",
        status: "idle",
        origin: "ipc",
        chatKind: "home",
        createdAt: "2026-10-19T08:31:13.144Z",
        updatedAt,
        needs: [],
        counts: { admissions: 3, tools: null },
      });
      let row = listed("2026-10-19T11:44:28.006Z");
      const { fake, store } = await finished((command) =>
        command === "tasks" ? { ok: true, result: { action: "list", rows: [row], truncated: false } } : { ok: true, result: {} },
      );
      const place = store.getSnapshot().runs[0]?.run.cursor;
      fake.subscribeResponse = { ok: true, result: { replayed: 1 } };
      await store.loadSessions();
      const before = fake.subscribes.length;
      row = listed("2026-10-19T11:45:02.120Z");
      await store.loadSessions();
      expect(fake.subscribes.slice(before).map((subscribe) => subscribe.options)).toMatchObject([{ from: place }]);
      // Unchanged since: nothing more.
      await store.loadSessions();
      expect(fake.subscribes.length).toBe(before + 1);
    });

    it("keeps the chat's finished turn as it was when catching up fails, and tries again on the next refresh", async () => {
      const listed = {
        taskId: "task-1",
        workspaceId: "default",
        status: "input-required",
        origin: "messaging",
        createdAt: "2026-10-19T08:31:13.144Z",
        updatedAt: "2026-10-19T11:44:28.006Z",
        needs: ["approval"],
        counts: { admissions: 3, tools: null },
      };
      const { fake, store } = await finished((command) =>
        command === "tasks" ? { ok: true, result: { action: "list", rows: [listed], truncated: false } } : { ok: true, result: {} },
      );
      const before = fake.subscribes.length;
      fake.subscribeResponse = { ok: false, error: { code: "UNAVAILABLE", message: "the owner is restarting" } };
      await store.loadSessions();
      await settle();
      const shown = store.getSnapshot().runs.at(-1);
      expect(shown?.run.status).toBe("completed");
      expect(shown?.error).toBeUndefined();
      expect(words(shown?.notice)).toContain("Could not catch up with this chat");
      await store.loadSessions();
      expect(fake.subscribes.length).toBe(before + 2);
    });

    it("keeps the late-join mark when the owner restarts before a continued turn speaks", async () => {
      const { fake, store } = await finished();
      store.submit("and another");
      await settle();
      await settle();
      const onEvent = fake.subscribes[0]?.options.onEvent;
      onEvent?.({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2", sequence: 0 });
      onEvent?.({ ...event("text.delta", { blockId: "b2", text: "green" }), epoch: "epoch-2", sequence: 1 });
      expect(store.getSnapshot().runs[1]?.run.truncated).toBe(true);
    });

    it("follows the next turn from now after a reconnect, since a restarted owner knows no earlier place", async () => {
      const { fake, store } = await finished();
      fake.setState("reconnecting");
      fake.setState("ready");
      store.submit("and another");
      await settle();
      await settle();
      expect(fake.subscribes.map((subscribe) => [subscribe.taskId, "from" in subscribe.options])).toEqual([["task-1", false]]);
    });

    it("starts a task of its own after New task, or while the last prompt's task is still going", async () => {
      const { fake, store } = await finished();
      store.newTask();
      expect(store.getSnapshot().continuing).toBeUndefined();
      store.submit("something else");
      await settle();
      expect(fake.runs).toHaveLength(2);
      expect(replies(fake)).toEqual([]);
      // The second task is running: a prompt now starts a third.
      store.submit("and a third");
      await settle();
      expect(fake.runs).toHaveLength(3);
    });

    it("sends a reply the owner did not answer in time once more, as the same message", async () => {
      let sent = 0;
      const { fake, store } = await finished((command) =>
        command === "reply" && ++sent === 1 ? { ok: false, error: { code: CLIENT_TIMEOUT, message: "slow" } } : { ok: true, result: {} },
      );
      store.submit("carry on");
      await settle();
      await settle();
      await settle();
      expect(replies(fake)).toHaveLength(2);
      expect((replies(fake)[1] as { clientMessageId: string }).clientMessageId).toBe(
        (replies(fake)[0] as { clientMessageId: string }).clientMessageId,
      );
      expect(store.getSnapshot().runs[1]?.error).toBeUndefined();
    });

    it("never forks when the owner finds no such conversation: nothing is sent, and the next send names the task", async () => {
      const { fake, store } = await finished((command) =>
        command === "reply" ? { ok: false, error: { code: "NOT_FOUND", message: "no conversation" } } : { ok: true, result: {} },
      );
      store.submit("carry on");
      await settle();
      await settle();
      await settle();
      expect(fake.runs).toHaveLength(1);
      expect(words(store.getSnapshot().unsent?.message)).toContain("Not sent: no conversation");
      expect(store.getSnapshot().continuing).toBe("task-1");
      store.submit("once more");
      await settle();
      await settle();
      await settle();
      const replies = fake.requests.filter((request) => request.command === "reply");
      expect(replies.at(-1)?.payload).toMatchObject({ taskId: "task-1", text: "once more" });
      expect(replies.at(-1)?.payload).not.toHaveProperty("conversationId");
    });

    it("keeps the task to continue when a reply is refused: nothing starts in its place", async () => {
      const { fake, store } = await finished((command) =>
        command === "reply" ? { ok: false, error: { code: "INVALID_INPUT", message: "scripted refusal" } } : { ok: true, result: {} },
      );
      store.submit("carry on");
      await settle();
      await settle();
      await settle();
      expect(words(store.getSnapshot().unsent?.message)).toContain("Not sent: scripted refusal");
      expect(store.getSnapshot().continuing).toBe("task-1");
      expect(fake.runs).toHaveLength(1);
    });

    describe("its turn watched until it speaks", () => {
      afterEach(() => {
        vi.useRealTimers();
      });
      /** A record of task-1 whose admissions are `kinds`, the last settled as `status` (or still claimed). */
      const recordOf = (kinds: readonly string[], status: "completed" | "failed" | "claimed") => ({
        task: { status: status === "claimed" ? "running" : status },
        admissions: kinds.map((kind, index) => ({
          kind,
          operationKey: `op-${index}`,
          state: index === kinds.length - 1 && status === "claimed" ? "claimed" : "committed",
          result: index === kinds.length - 1 && status === "claimed" ? null : { status: status === "claimed" ? "completed" : status },
        })),
      });
      const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

      it("says so when a recorded prompt starts no turn, keeps following, and takes it back if the turn speaks", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const records = [recordOf(["start"], "completed")];
        const { fake, store } = await finishedFaked((command) =>
          command === "tasks" ? { ok: true, result: records[0] } : { ok: true, result: {} },
        );
        store.submit("carry on");
        await tick();
        await tick(5_000);
        expect(words(store.getSnapshot().runs[1]?.error)).toContain(
          "The prompt was recorded (message ui-2), but task task-1 has not started its turn",
        );
        expect(store.getSnapshot().continuing).toBe("task-1");
        // The stream is kept: a turn that starts after all shows, and the task is not offered while it goes.
        expect(fake.closed).not.toContain("resume-1");
        fake.subscribes[0]?.options.onEvent(event("text.delta", { blockId: "b2", text: "late" }));
        expect(store.getSnapshot().runs[1]?.error).toBeUndefined();
        expect(store.getSnapshot().continuing).toBeUndefined();
      });

      it("reads the record again after a resync that comes once the watch found the turn in flight, and a failed read", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let answer: ClientResponse = { ok: true, result: recordOf(["start"], "completed") };
        const { fake, store } = await finishedFaked((command) => (command === "tasks" ? answer : { ok: true, result: {} }));
        store.submit("carry on");
        await tick();
        // In flight when the watch reads it.
        answer = { ok: true, result: recordOf(["start", "reply"], "claimed") };
        await tick(5_000);
        expect(store.getSnapshot().runs[1]?.error).toBeUndefined();
        // The owner restarts; the turn ran and ended in the gap. A read fails first, and is tried again.
        fake.subscribes[0]?.options.onEvent({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2" });
        answer = { ok: false, error: { code: "UNAVAILABLE", message: "busy" } };
        await tick(5_000);
        expect(words(store.getSnapshot().runs[1]?.notice)).toContain("trying again");
        answer = { ok: true, result: recordOf(["start", "reply"], "completed") };
        await tick(5_000);
        await tick();
        const turn = store.getSnapshot().runs[1];
        // Its ending, read back — not "has not started its turn".
        expect(turn?.error).toBeUndefined();
        expect(words(turn?.notice)).toContain("The chat finished while the page was away.");
        expect(store.getSnapshot().continuing).toBe("task-1");
      });

      it("does not read a resync's record before the turn speaks as the turn's end", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const { fake, store } = await finishedFaked((command) =>
          command === "tasks" ? { ok: true, result: recordOf(["start"], "completed") } : { ok: true, result: {} },
        );
        store.submit("carry on");
        await tick();
        const reads = fake.requests.filter((request) => request.command === "tasks").length;
        fake.subscribes[0]?.options.onEvent({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2" });
        await tick();
        expect(fake.requests.filter((request) => request.command === "tasks")).toHaveLength(reads);
        expect(words(store.getSnapshot().runs[1]?.notice) ?? "").not.toContain("completed while the page was away");
      });
    });

    it("sends nothing when the task cannot be followed or its record read, and keeps it to continue", async () => {
      const { fake, store } = await finished();
      fake.subscribeResponse = { ok: false, error: { code: "NOT_FOUND", message: "no such task" } };
      store.submit("carry on");
      await settle();
      await settle();
      expect(store.getSnapshot().unsent).toEqual({ key: expect.any(String), text: "carry on", message: expect.anything() });
      expect(words(store.getSnapshot().unsent?.message)).toBe("Not sent: no such task. Your message is back in the box: send it again.");
      expect(replies(fake)).toEqual([]);
      expect(store.getSnapshot().continuing).toBe("task-1");

      fake.subscribeResponse = { ok: true, result: {} };
      fake.answer = (command) =>
        command === "tasks" ? { ok: false, error: { code: "UNAVAILABLE", message: "busy" } } : { ok: true, result: {} };
      store.submit("carry on");
      await settle();
      await settle();
      await settle();
      expect(words(store.getSnapshot().unsent?.message)).toContain("Not sent: busy.");
      expect(replies(fake)).toEqual([]);
      expect(store.getSnapshot().continuing).toBe("task-1");
    });

    it("keeps following when the resent reply is not answered either", async () => {
      const { fake, store } = await finished((command) =>
        command === "reply" ? { ok: false, error: { code: CLIENT_TIMEOUT, message: "slow" } } : { ok: true, result: {} },
      );
      store.submit("carry on");
      for (let index = 0; index < 5; index += 1) await settle();
      expect(replies(fake)).toHaveLength(2);
      expect(words(store.getSnapshot().runs[1]?.notice)).toContain("may have been recorded");
      expect(store.getSnapshot().runs[1]?.error).toBeUndefined();
      expect(fake.closed).not.toContain("resume-1");
    });

    it("continues a task settled by its record, but not one whose stream moved on while the record was read", async () => {
      for (const status of ["completed", "failed"])
        for (const movedOn of [false, true]) {
          const record = {
            task: { status },
            admissions: [{ kind: "start", operationKey: "ui-1", state: "committed", result: { status } }],
          };
          sequence = 0;
          keys = 0;
          const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
          fake.queueRun({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", conversationId: "ui-1" } });
          const store = createCanvasStore(client, options);
          store.submit("name a colour");
          await settle();
          const onEvent = fake.runs[0]?.options.onEvent;
          onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
          onEvent?.({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2" });
          // The stream speaks before the record answers: it speaks for itself.
          if (movedOn) onEvent?.({ ...event("text.delta", { blockId: "b", text: "still going" }), epoch: "epoch-2" });
          await settle();
          await settle();
          expect(fake.closed.includes("run-1")).toBe(!movedOn);
          if (movedOn) expect(store.getSnapshot().runs[0]?.error).toBeUndefined();
          expect(store.getSnapshot().continuing, movedOn ? "moved on" : "settled by record").toBe(movedOn ? undefined : "task-1");
        }
    });

    it("does not offer a cancelled task to continue", async () => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient();
      fake.queueRun({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", conversationId: "ui-1" } });
      const store = createCanvasStore(client, options);
      store.submit("long job");
      await settle();
      const onEvent = fake.runs[0]?.options.onEvent;
      onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      onEvent?.(event("task.failed", { errorCode: "CANCELLED", message: "Task was cancelled by operator: enough" }));
      expect(store.getSnapshot().continuing).toBeUndefined();
      store.submit("next");
      await settle();
      expect(fake.runs).toHaveLength(2);
    });

    it("stops following a task's earlier entries once a prompt continues it, so its turn is drawn once", async () => {
      // Settled by its record after a restart: the entry's stream was still open.
      const record = {
        task: { status: "completed" },
        admissions: [{ kind: "start", operationKey: "ui-1", state: "committed", result: { status: "completed" } }],
      };
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient((command) =>
        command === "tasks" ? { ok: true, result: record } : listing(2, "c1")(command, undefined),
      );
      fake.queueRun({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", conversationId: "ui-1" } });
      const store = createCanvasStore(client, options);
      store.submit("name a colour");
      await settle();
      const first = fake.runs[0]?.options.onEvent;
      first?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      first?.({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2" });
      await settle();
      await settle();
      expect(store.getSnapshot().continuing).toBe("task-1");
      // Settled by the record: its stream is closed (and its bridge slot freed).
      expect(fake.closed).toEqual(["run-1"]);
      store.submit("and another");
      await settle();
      await settle();
      const next = fake.subscribes[0]?.options.onEvent;
      next?.({ ...event("text.delta", { blockId: "b2", text: "green" }), epoch: "epoch-2" });
      next?.({ ...event("approval.required", call(2, "c1")), epoch: "epoch-2" });
      await settle();
      const [earlier, later] = store.getSnapshot().runs;
      expect(earlier?.run.transcript.some((entry) => entry.kind === "text" && entry.text === "green")).toBe(false);
      expect(later?.run.transcript).toMatchObject([{ kind: "text", text: "green" }]);
      expect(fake.requests.filter((request) => request.command === "approvals")).toHaveLength(1);
    });

    it("names only the last prompt's task when runs overlap, and New task declines it", async () => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient();
      fake.queueRun({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", conversationId: "ui-1" } });
      fake.queueRun({ ok: true, result: { taskId: "task-2", subscriptionId: "sub-2", conversationId: "ui-2" } });
      const store = createCanvasStore(client, options);
      store.submit("first");
      store.submit("second");
      await settle();
      const at = (runId: string, kind: string, fields: Record<string, unknown> = {}) => ({ ...event(kind, fields), runId });
      fake.runs[0]?.options.onEvent(at("task-1", "run.started", { threadId: "t1", workspaceId: "default" }));
      fake.runs[0]?.options.onEvent(at("task-1", "task.completed", { finalText: "one" }));
      expect(store.getSnapshot().continuing).toBeUndefined();
      sequence = 0;
      fake.runs[1]?.options.onEvent(at("task-2", "run.started", { threadId: "t2", workspaceId: "default" }));
      fake.runs[1]?.options.onEvent(at("task-2", "task.completed", { finalText: "two" }));
      expect(store.getSnapshot().continuing).toBe("task-2");
      store.newTask();
      expect(store.getSnapshot()).toMatchObject({ declined: "task-2" });
      expect(store.getSnapshot().continuing).toBeUndefined();
    });
  });

  describe("after a reload", () => {
    const remembered = { taskId: "task-1", conversationId: "ui-1" };
    const memoryOf = (initial?: typeof remembered) => {
      const saved: (typeof remembered)[] = [];
      return { saved, memory: { load: () => initial, save: (task: typeof remembered) => void saved.push(task) } };
    };

    it("remembers the page's last task once its conversation is known, and again as it settles", async () => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient();
      fake.queueRun({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", conversationId: "ui-1" } });
      const { saved, memory } = memoryOf();
      const store = createCanvasStore(client, { ...options, memory });
      store.submit("name a colour");
      await settle();
      expect(saved).toEqual([remembered]);
      fake.runs[0]?.options.onEvent(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      fake.runs[0]?.options.onEvent(event("task.completed", { finalText: "blue" }));
      expect(saved.at(-1)).toEqual(remembered);
    });

    it("replays the remembered task as its turns, lets its stream go, and continues it", async () => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient();
      fake.subscribeResponse = { ok: true, result: { replayed: 5 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      expect(fake.subscribes[0]).toMatchObject({ taskId: "task-1", options: { from: "beginning" } });
      await settle();
      const onEvent = fake.subscribes[0]?.options.onEvent;
      onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      onEvent?.(event("text.delta", { blockId: "b", text: "blue" }));
      onEvent?.(event("task.completed", { finalText: "blue" }));
      onEvent?.({ ...event("text.delta", { blockId: "b2", text: "green" }), attemptId: "attempt-2" });
      onEvent?.({ ...event("task.completed", { finalText: "green" }), attemptId: "attempt-2" });
      const runs = store.getSnapshot().runs;
      // Two turns, two entries: answers only, marked as replayed.
      expect(
        runs.map((run) => [run.restored, run.run.transcript.map((entry) => (entry.kind === "text" ? entry.text : entry.kind))]),
      ).toEqual([
        [true, ["blue"]],
        [true, ["green"]],
      ]);
      expect(runs[1]?.continues).toBe("task-1");
      // Replayed whole and settled: let go, and the next prompt continues it.
      expect(fake.closed).toEqual(["resume-1"]);
      expect(store.getSnapshot().continuing).toBe("task-1");
      store.submit("and another");
      await settle();
      await settle();
      expect(fake.requests.filter((request) => request.command === "reply").map((request) => request.payload)).toEqual([
        { workspaceId: "default", conversationId: "ui-1", text: "and another", clientMessageId: "ui-3" },
      ]);
    });

    it("shows each replayed turn's prompt from the record when every turn is replayed", async () => {
      sequence = 0;
      keys = 0;
      const record = {
        task: { status: "completed" },
        admissions: [
          { kind: "start", operationKey: "ui-1", intent: { prompt: "name a colour" }, state: "committed" },
          // Refused before any node ran: no turn of its own.
          { kind: "reply", intent: { prompt: "raced" }, state: "refused" },
          { kind: "reply", intent: { prompt: "another" }, state: "committed" },
          // Queued, not yet run: no turn either.
          { kind: "reply", intent: { prompt: "queued" }, state: "pending" },
        ],
      };
      const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
      fake.subscribeResponse = { ok: true, result: { replayed: 4 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      const onEvent = fake.subscribes[0]?.options.onEvent;
      onEvent?.(event("text.delta", { blockId: "b", text: "blue" }));
      onEvent?.(event("task.completed", { finalText: "blue" }));
      onEvent?.({ ...event("text.delta", { blockId: "b2", text: "green" }), attemptId: "attempt-2" });
      onEvent?.({ ...event("task.completed", { finalText: "green" }), attemptId: "attempt-2" });
      const runs = store.getSnapshot().runs;
      expect(runs.map((run) => run.prompt)).toEqual(["name a colour", "another"]);
      expect(runs[0]?.recordedPrompts).toBeUndefined();
    });

    const twoTurns = (onEvent: SubscribeOptions["onEvent"] | undefined) => {
      onEvent?.(event("text.delta", { blockId: "b", text: "blue" }));
      onEvent?.(event("task.completed", { finalText: "blue" }));
      onEvent?.({ ...event("text.delta", { blockId: "b2", text: "green" }), attemptId: "attempt-2" });
      onEvent?.({ ...event("task.completed", { finalText: "green" }), attemptId: "attempt-2" });
    };
    const ran = (...prompts: string[]) =>
      prompts.map((prompt, index) => ({
        kind: index === 0 ? "start" : "reply",
        operationKey: "ui-1",
        intent: { prompt },
        state: "committed",
      }));

    it("pairs the prompts when the record is read after the replay", async () => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient();
      let answerRecord: (response: ClientResponse) => void = () => undefined;
      const late: CanvasClient = {
        ...client,
        request: (command, payload) => {
          fake.requests.push({ command, payload });
          // The record is held back; a replay's turns also read their saved history.
          return command === "tasks" && (payload as { action?: string }).action !== "transcript"
            ? new Promise((resolve) => {
                answerRecord = resolve;
              })
            : client.request(command, payload);
        },
      };
      fake.subscribeResponse = { ok: true, result: { replayed: 4 } };
      const store = createCanvasStore(late, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      twoTurns(fake.subscribes[0]?.options.onEvent);
      expect(store.getSnapshot().runs.map((run) => run.prompt)).toEqual(["", ""]);
      answerRecord({ ok: true, result: { task: { status: "completed" }, admissions: ran("name a colour", "another") } });
      await settle();
      expect(store.getSnapshot().runs.map((run) => run.prompt)).toEqual(["name a colour", "another"]);
    });

    it("keeps each replayed turn's own prompt when the chat is taken up again from its record", async () => {
      sequence = 0;
      keys = 0;
      const record = { task: { status: "completed" }, admissions: ran("research it", "sum it up", "who decides") };
      const { client, fake } = fakeClient((command, payload) =>
        command === "tasks" && (payload as { action?: string }).action !== "transcript"
          ? { ok: true, result: record }
          : { ok: true, result: {} },
      );
      fake.subscribeResponse = { ok: true, result: { replayed: 9 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      const onEvent = fake.subscribes[0]?.options.onEvent;
      for (const [index, answer] of ["found", "summed", "decided"].entries()) {
        const attemptId = `attempt-${index + 1}`;
        onEvent?.({
          ...event("tool.started", { blockId: `c${index}`, callId: `c${index}`, toolName: "web_search", input: {} }),
          attemptId,
        });
        onEvent?.({ ...event("text.delta", { blockId: `b${index}`, text: answer }), attemptId });
        onEvent?.({ ...event("task.completed", { finalText: answer }), attemptId });
      }
      await settle();
      expect(store.getSnapshot().runs.map((run) => run.prompt)).toEqual(["research it", "sum it up", "who decides"]);
      // Opened again (or caught up) while the owner holds nothing newer: its record is read over the last turn.
      fake.subscribeResponse = { ok: true, result: { replayed: 0 } };
      await store.openTask("task-1");
      await settle();
      await settle();
      expect(store.getSnapshot().runs.map((run) => run.prompt)).toEqual(["research it", "sum it up", "who decides"]);
    });

    it("keeps the prompts listed apart when the replay holds fewer turns than the record", async () => {
      sequence = 0;
      keys = 0;
      const record = { task: { status: "completed" }, admissions: ran("dropped", "name a colour", "another") };
      const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
      fake.subscribeResponse = { ok: true, result: { replayed: 4 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      twoTurns(fake.subscribes[0]?.options.onEvent);
      const runs = store.getSnapshot().runs;
      expect(runs.map((run) => run.prompt)).toEqual(["", ""]);
      expect(runs[0]?.recordedPrompts).toEqual(["dropped", "name a colour", "another"]);
    });

    it("shows a record-only reload's prompt once", async () => {
      sequence = 0;
      keys = 0;
      const record = { task: { status: "completed" }, admissions: [{ ...ran("name a colour")[0], result: { status: "completed" } }] };
      const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
      fake.subscribeResponse = { ok: true, result: { replayed: 0 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      await settle();
      expect(store.getSnapshot().runs[0]).toMatchObject({ prompt: "name a colour" });
      expect(store.getSnapshot().runs[0]?.recordedPrompts).toBeUndefined();
    });

    const reloaded = async (extra: object) => {
      sequence = 0;
      keys = 0;
      const record = {
        task: { status: "completed" },
        admissions: [{ kind: "start", operationKey: "ui-1", state: "committed", result: { status: "completed" } }],
        ...extra,
      };
      const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
      fake.subscribeResponse = { ok: true, result: { replayed: 0 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      await settle();
      return { store, fake };
    };

    it("doesn't say turns are gone when the record still has them", async () => {
      const { store } = await reloaded({
        history: { startedAt: "2026-09-19T12:00:00.000Z", lastAt: "2026-09-19T12:00:03.000Z", activeMs: 3000 },
      });
      expect(store.getSnapshot().runs[0]?.notice).toBeUndefined();
    });

    it("reads a remembered task's record when the owner holds none of its stream", async () => {
      const { store, fake } = await reloaded({});
      expect(fake.closed).toEqual(["resume-1"]);
      expect(words(store.getSnapshot().runs[0]?.notice)).toContain("The chat finished while the page was away.");
      expect(store.getSnapshot().continuing).toBe("task-1");
    });

    it("reads the chat's saved history when the owner holds none of its stream, and pages back", async () => {
      sequence = 0;
      keys = 0;
      const record = {
        task: { status: "completed" },
        admissions: [{ kind: "start", operationKey: "ui-1", state: "committed", result: { status: "completed" } }],
      };
      const saved = (seq: number) => ({
        taskId: "task-1",
        seq,
        turn: {
          admissionKind: seq === 1 ? "start" : "reply",
          prompt: `prompt ${seq}`,
          items: [
            { kind: "text", text: `answer ${seq}` },
            { kind: "tool", callId: `c${seq}`, toolName: "web_search", status: "completed" },
          ],
          outcome: { status: "completed", finalText: `answer ${seq}` },
          // The newest turn read a page: its links are drawn as they streamed.
          ...(seq === 3 ? { tainted: true, knownUrls: ["https://docs.example/"] } : {}),
        },
        createdAt: "2026-10-04T00:00:00.000Z",
      });
      const { client, fake } = fakeClient((command, payload) => {
        if (command !== "tasks") return { ok: true, result: {} };
        const asked = payload as { action?: string; before?: number };
        if (asked.action !== "transcript") return { ok: true, result: record };
        return asked.before === undefined
          ? { ok: true, result: { entries: [saved(2), saved(3)], nextBefore: 2 } }
          : { ok: true, result: { entries: [saved(1)] } };
      });
      fake.subscribeResponse = { ok: true, result: { replayed: 0 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      await settle();
      await settle();
      const runs = store.getSnapshot().runs;
      expect(runs.map((run) => run.prompt)).toEqual(["prompt 2", "prompt 3"]);
      // Each keeps its place in the history, the entry the newest filled too: where notices go.
      expect(runs.map((run) => run.seq)).toEqual([2, 3]);
      expect(runs[1]?.run.transcript.map((item) => item.kind)).toEqual(["text", "tool"]);
      expect(runs.map((run) => [run.run.tainted, run.run.knownUrls])).toEqual([
        [undefined, undefined],
        [true, ["https://docs.example/"]],
      ]);
      expect(store.getSnapshot().earlier).toEqual({ "task-1": 2 });
      store.loadEarlier("task-1");
      await settle();
      expect(store.getSnapshot().runs.map((run) => run.prompt)).toEqual(["prompt 1", "prompt 2", "prompt 3"]);
      expect(store.getSnapshot().runs.map((run) => run.seq)).toEqual([1, 2, 3]);
      expect(store.getSnapshot().earlier).toEqual({});
      // The chat is still the one the next prompt continues.
      expect(store.getSnapshot().continuing).toBe("task-1");
    });

    /** A saved turn that used `records` memories, saved at minute `minute`. */
    const usedTurn = (seq: number, minute: number, records: number) => ({
      taskId: "task-1",
      seq,
      turn: {
        admissionKind: seq === 1 ? "start" : "reply",
        prompt: `prompt ${seq}`,
        items: [],
        outcome: { status: "completed", finalText: `answer ${seq}` },
        memoryUsed: {
          records: Array.from({ length: records }, (_unused, index) => ({ recordId: `r${index}`, revisionId: `v${index}` })),
          preferences: 0,
          more: 0,
        },
      },
      createdAt: `2026-10-04T00:${String(minute).padStart(2, "0")}:00.500Z`,
    });
    const endedAt = (minute: number): string => `2026-10-04T00:${String(minute).padStart(2, "0")}:00.000Z`;
    const replayTwoTurns = (onEvent: ((event: ClientEvent) => void) | undefined) => {
      onEvent?.({ ...event("task.completed", { finalText: "answer 1" }), at: endedAt(1) });
      onEvent?.({ ...event("text.delta", { blockId: "b2", text: "answer 2" }), attemptId: "attempt-2", at: endedAt(2) });
      onEvent?.({ ...event("task.completed", { finalText: "answer 2" }), attemptId: "attempt-2", at: endedAt(2) });
    };

    it("gives each turn replayed after a reload what its saved turn used, read once", async () => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient((_command, payload) =>
        (payload as { action?: string }).action === "transcript"
          ? { ok: true, result: { entries: [usedTurn(1, 1, 2), usedTurn(2, 2, 0)] } }
          : { ok: true, result: {} },
      );
      fake.subscribeResponse = { ok: true, result: { replayed: 4 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      const onEvent = fake.subscribes[0]?.options.onEvent;
      onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      replayTwoTurns(onEvent);
      await settle();
      await settle();
      expect(store.getSnapshot().runs.map((run) => [run.memorySeq, run.memoryUsed?.records.length])).toEqual([
        [1, 2],
        [2, 0],
      ]);
      expect(fake.requests.filter((request) => (request.payload as { action?: string }).action === "transcript")).toHaveLength(1);
    });

    it("gives a replayed turn no other turn's memory when its own saved turn is not to be found", async () => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient((_command, payload) =>
        (payload as { action?: string }).action === "transcript"
          ? { ok: true, result: { entries: [usedTurn(5, 2, 3)] } }
          : { ok: true, result: {} },
      );
      fake.subscribeResponse = { ok: true, result: { replayed: 3 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      const onEvent = fake.subscribes[0]?.options.onEvent;
      replayTwoTurns(onEvent);
      await settle();
      await settle();
      expect(store.getSnapshot().runs.map((run) => run.memorySeq)).toEqual([undefined, 5]);
    });

    it("reads back through the saved pages to the turns a reload replayed", async () => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient((_command, payload) => {
        const asked = payload as { action?: string; before?: number };
        if (asked.action !== "transcript") return { ok: true, result: {} };
        return asked.before === undefined
          ? { ok: true, result: { entries: [usedTurn(2, 2, 1)], nextBefore: 2 } }
          : { ok: true, result: { entries: [usedTurn(1, 1, 4)] } };
      });
      fake.subscribeResponse = { ok: true, result: { replayed: 3 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      const onEvent = fake.subscribes[0]?.options.onEvent;
      replayTwoTurns(onEvent);
      await settle();
      await settle();
      await settle();
      expect(store.getSnapshot().runs.map((run) => run.memoryUsed?.records.length)).toEqual([4, 1]);
    });

    it("keeps what the newest turn used when the saved history fills its entry", async () => {
      sequence = 0;
      keys = 0;
      const record = {
        task: { status: "completed" },
        admissions: [{ kind: "start", operationKey: "ui-1", state: "committed", result: { status: "completed", finalText: "answer 1" } }],
      };
      const { client, fake } = fakeClient((command, payload) =>
        command !== "tasks"
          ? { ok: true, result: {} }
          : (payload as { action?: string }).action === "transcript"
            ? { ok: true, result: { entries: [usedTurn(1, 1, 2)] } }
            : { ok: true, result: record },
      );
      fake.subscribeResponse = { ok: true, result: { replayed: 0 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      await settle();
      await settle();
      expect(store.getSnapshot().runs.map((run) => [run.prompt, run.memorySeq, run.memoryUsed?.records.length])).toEqual([
        ["prompt 1", 1, 2],
      ]);
    });

    /** A chat the person stopped, then cancelled with `reason`: what the owner's record says of it. */
    const cancelledRecord = (reason: string) => ({
      task: { status: "cancelled" },
      admissions: ran("name a colour"),
      history: { tools: [], partial: false },
      cancellations: [{ taskId: "task-1", requestedBy: "operator", reason, requestedAt: "2026-10-04T00:00:00.000Z" }],
    });
    const stoppedTurn = (onEvent: ((event: ClientEvent) => void) | undefined) => {
      onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      onEvent?.(event("text.delta", { blockId: "b", text: "partly" }));
      onEvent?.(event("task.stopped", { message: "You stopped this." }));
    };
    /** A reload of a chat cancelled with "qa": three events to replay, and the record after them. */
    const reloadCancelled = () => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient((command, payload) =>
        command === "tasks" && (payload as { action?: string }).action === undefined
          ? { ok: true, result: cancelledRecord("qa") }
          : { ok: true, result: {} },
      );
      fake.subscribeResponse = { ok: true, result: { replayed: 3 } };
      return { store: createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory }), fake };
    };

    it("projects a task's cancel over the stopped turn a reload replays, and offers no reply", async () => {
      const { store, fake } = reloadCancelled();
      await settle();
      stoppedTurn(fake.subscribes[0]?.options.onEvent);
      await settle();
      const run = store.getSnapshot().runs[0];
      expect(run === undefined ? undefined : runStatus(run)).toBe("canceled");
      expect(run?.error).toBeUndefined();
      expect(run?.run.outcome).toMatchObject({ kind: "failed", errorCode: "CANCELLED", message: "qa" });
      expect(run?.run.transcript.map((entry) => entry.kind)).toEqual(["text"]);
      expect(store.getSnapshot().next).toEqual({ kind: "new" });
      expect(store.getSnapshot().continuing).toBeUndefined();
      expect(fake.closed).toEqual(["resume-1"]);
    });

    it("projects it when the record comes back before the replay is through", async () => {
      const { store, fake } = reloadCancelled();
      await settle();
      await settle();
      stoppedTurn(fake.subscribes[0]?.options.onEvent);
      const run = store.getSnapshot().runs[0];
      expect(run === undefined ? undefined : runStatus(run)).toBe("canceled");
    });

    it("projects it on a chat opened from the list", async () => {
      sequence = 0;
      keys = 0;
      const { client, fake } = fakeClient((command, payload) =>
        command === "tasks" && (payload as { action?: string }).action === undefined
          ? { ok: true, result: { ...cancelledRecord("qa"), found: true, task: { status: "cancelled", workspaceId: "default" } } }
          : { ok: true, result: {} },
      );
      fake.subscribeResponse = { ok: true, result: { replayed: 3 } };
      const store = createCanvasStore(client, options);
      await store.openTask("task-1");
      await settle();
      stoppedTurn(fake.subscribes[0]?.options.onEvent);
      const run = store.getSnapshot().runs[0];
      expect(run === undefined ? undefined : runStatus(run)).toBe("canceled");
      expect(store.getSnapshot().next).toEqual({ kind: "new" });
      // Opened again from the list: still no reply.
      await store.openTask("task-1");
      expect(store.getSnapshot().next).toEqual({ kind: "new" });
    });

    it("reads a stopped chat cancelled elsewhere as canceled, never failed, on the list's word", async () => {
      sequence = 0;
      keys = 0;
      const row = (status: string, updatedAt: string) => ({
        taskId: "task-1",
        workspaceId: "default",
        principalId: "operator",
        origin: "web",
        status,
        createdAt: "2026-10-04T00:00:00.000Z",
        updatedAt,
        delegated: 0,
        summary: null,
        summaryState: null,
        needs: [],
        ownNeeds: [],
        counts: { admissions: 1, tools: 0 },
        followUps: 0,
        title: "name a colour",
      });
      let listed = row("stopped", "2026-10-04T00:01:00.000Z");
      let cancelled = false;
      const { client, fake } = fakeClient((command, payload) => {
        if (command !== "tasks") return { ok: true, result: {} };
        const asked = payload as { action?: string };
        if (asked.action === "list") return { ok: true, result: { action: "list", rows: [listed], truncated: false } };
        return { ok: true, result: cancelled ? cancelledRecord("qa") : { task: { status: "stopped" } } };
      });
      const store = createCanvasStore(client, options);
      store.submit("name a colour");
      await settle();
      const live = fake.runs[0]?.options.onEvent;
      stoppedTurn(live);
      await store.loadSessions();
      cancelled = true;
      listed = row("canceled", "2026-10-04T00:02:00.000Z");
      fake.subscribeResponse = { ok: true, result: { replayed: 0 } };
      await store.loadSessions(undefined, false, true);
      await settle();
      await settle();
      const run = store.getSnapshot().runs[0];
      expect(run === undefined ? undefined : runStatus(run)).toBe("canceled");
      expect(run?.error).toBeUndefined();
      expect(run?.notice).toBeUndefined();
      expect(run?.run.transcript.map((entry) => entry.kind)).toEqual(["text"]);
      expect(store.getSnapshot().next).toEqual({ kind: "new" });
      expect(directoryRows(store.getSnapshot(), "default")[0]?.status).toBe("canceled");
    });

    it("keeps a failed chat's error when its saved history fills the entry", async () => {
      sequence = 0;
      keys = 0;
      const record = {
        task: { status: "failed" },
        admissions: [
          {
            kind: "start",
            operationKey: "ui-1",
            state: "committed",
            result: { status: "failed", error: { code: "MODEL_FAILED", message: "down" } },
          },
        ],
      };
      const saved = {
        taskId: "task-1",
        seq: 1,
        turn: {
          admissionKind: "start",
          prompt: "try it",
          items: [{ kind: "text", text: "partial" }],
          outcome: { status: "failed", errorCode: "MODEL_FAILED", message: "down" },
        },
        createdAt: "2026-10-04T00:00:00.000Z",
      };
      const { client, fake } = fakeClient((command, payload) =>
        command !== "tasks"
          ? { ok: true, result: {} }
          : (payload as { action?: string }).action === "transcript"
            ? { ok: true, result: { entries: [saved] } }
            : { ok: true, result: record },
      );
      fake.subscribeResponse = { ok: true, result: { replayed: 0 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      await settle();
      await settle();
      const run = store.getSnapshot().runs[0];
      expect(run?.prompt).toBe("try it");
      expect(run?.run.transcript.map((item) => item.kind)).toEqual(["text"]);
      expect(words(run?.error)).toContain("the chat failed");
    });

    it("retains saved calls while a restored approval resumes and uses current execution metrics", async () => {
      sequence = 0;
      const history = {
        metrics: { models: ["old/model"], totalTokens: 20, partial: false },
        tools: [
          { kind: "tool", key: "old:done", attemptId: "old", callId: "done", toolName: "web_search", status: "completed" },
          {
            kind: "tool",
            key: "original:c1",
            attemptId: "original",
            callId: "c1",
            toolName: "mail.send",
            status: "interrupted",
            model: "provider/model",
          },
        ],
        partial: false,
      };
      const record = {
        task: { status: "waiting" },
        admissions: [
          {
            kind: "start",
            state: "committed",
            result: { status: "waiting", interrupt: { requests: [{ callId: "c1", toolName: "mail.send" }] } },
          },
        ],
        history,
      };
      const { client, fake } = fakeClient((command) =>
        command === "tasks" ? { ok: true, result: record } : listing(4, "c1")(command, undefined),
      );
      fake.subscribeResponse = { ok: true, result: { replayed: 0 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      await settle();
      expect(store.getSnapshot().runs[0]?.run.status).toBe("awaiting_approval");
      const onEvent = fake.subscribes[0]?.options.onEvent;
      onEvent?.(event("approval.settled", { steps: 4, decisions: [{ callId: "c1", approved: true }], decidedBy: "operator" }));
      onEvent?.(event("attempt.replaced", { attemptId: "resumed", supersededAttemptId: "original", reason: "resuming after approval" }));
      onEvent?.(event("tool.started", { attemptId: "original", blockId: "c1", callId: "c1", toolName: "mail.send", input: {} }));
      onEvent?.(
        event("tool.completed", { attemptId: "original", callId: "c1", toolName: "mail.send", output: { sent: true }, durationMs: 5 }),
      );
      const metrics = { models: ["provider/model"], totalTokens: 30, partial: false };
      onEvent?.(event("task.completed", { finalText: "done", metrics }));
      const restored = store.getSnapshot().runs[0];
      expect(restored?.recordedHistory?.tools).toEqual(history.tools);
      expect(restored?.recordedHistory?.metrics).toBeUndefined();
      expect(restored?.run.metrics).toEqual(metrics);
      const session = sessionsOf(store.getSnapshot().runs)[0];
      if (session === undefined) throw new Error("Missing restored session");
      expect(sessionStats(session).tools).toBe(2);
      const cards = sessionToolGroups(session).flatMap((group) => group.cards);
      expect(cards.filter((card) => card.callId === "c1")).toEqual([
        expect.objectContaining({ status: "completed", output: { sent: true }, model: "provider/model" }),
      ]);
      expect(cards.filter((card) => card.callId === "done")).toHaveLength(1);
    });

    it("restores saved metrics, timing, and trajectory without replayed events", async () => {
      const history = {
        metrics: { models: ["provider/model"], totalTokens: 103054, partial: false },
        startedAt: "2026-09-27T20:29:52Z",
        lastAt: "2026-09-27T20:30:23Z",
        tools: [
          {
            kind: "tool",
            key: "a:c",
            attemptId: "a",
            callId: "c",
            toolName: "web_search",
            input: { query: "example" },
            output: { result: "found" },
            status: "completed",
          },
        ],
        partial: false,
      };
      const record = {
        task: { status: "completed", finalText: "Saved answer" },
        admissions: [{ kind: "start", state: "committed", result: { status: "completed" } }],
        history,
      };
      const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
      fake.subscribeResponse = { ok: true, result: { replayed: 0 } };
      const store = createCanvasStore(client, { ...options, memory: memoryOf(remembered).memory });
      await settle();
      await settle();
      expect(store.getSnapshot().runs[0]).toMatchObject({
        recordedHistory: history,
        startedAt: history.startedAt,
        lastAt: history.lastAt,
        run: { status: "completed", outcome: { finalText: "Saved answer" } },
      });
    });
  });

  describe("the batch", () => {
    it("coalesces a stream's deltas into one repaint per frame, and repaints the state it had folded", () => {
      sequence = 0;
      const { client, fake } = fakeClient();
      const clock = fakeScheduler();
      const store = createCanvasStore(client, { ...options, scheduler: clock.scheduler });
      store.submit("write the brief");
      const onEvent = fake.runs[0]?.options.onEvent;
      let notified = 0;
      store.subscribe(() => (notified += 1));
      onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
      // Blocking: on screen at once.
      expect(notified).toBe(1);
      for (const text of ["a", "b", "c", "d"]) onEvent?.(event("text.delta", { blockId: "b", text }));
      // Deferred — yet the snapshot is already current, so a repaint for any other reason is not stale.
      expect(notified).toBe(1);
      expect(store.getSnapshot().runs[0]?.run.transcript).toMatchObject([{ kind: "text", text: "abcd" }]);
      clock.paint();
      expect(notified).toBe(2);
      // Nothing waiting: a second frame repaints nothing.
      clock.paint();
      expect(notified).toBe(2);
    });

    it("repaints a hidden tab on the coalescing timer, since no frame comes", () => {
      sequence = 0;
      const { client, fake } = fakeClient();
      const clock = fakeScheduler();
      const store = createCanvasStore(client, { ...options, scheduler: clock.scheduler });
      store.submit("p");
      const onEvent = fake.runs[0]?.options.onEvent;
      let notified = 0;
      store.subscribe(() => (notified += 1));
      onEvent?.(event("text.delta", { blockId: "b", text: "x" }));
      expect(notified).toBe(0);
      clock.advance(249);
      expect(notified).toBe(0);
      clock.advance(1);
      expect(notified).toBe(1);
      // The frame that was racing the timer was called off, so it repaints nothing.
      clock.paint();
      expect(notified).toBe(1);
    });

    it("gives way at the ceiling, so an unbroken stream still repaints", () => {
      sequence = 0;
      const { client, fake } = fakeClient();
      const clock = fakeScheduler();
      const store = createCanvasStore(client, { ...options, scheduler: clock.scheduler });
      store.submit("p");
      const onEvent = fake.runs[0]?.options.onEvent;
      let notified = 0;
      store.subscribe(() => (notified += 1));
      onEvent?.(event("text.delta", { blockId: "b", text: "x" }));
      expect(notified).toBe(0);
      // Neither the frame nor the timer has been served — a starved main thread.
      clock.tick(499);
      onEvent?.(event("text.delta", { blockId: "b", text: "y" }));
      expect(notified).toBe(0);
      clock.tick(1);
      // The ceiling: the delta that reaches it repaints rather than waiting again.
      onEvent?.(event("text.delta", { blockId: "b", text: "z" }));
      expect(notified).toBe(1);
      expect(store.getSnapshot().runs[0]?.run.transcript).toMatchObject([{ kind: "text", text: "xyz" }]);
      // And the window it was waiting in is closed: the frame it had asked for repaints nothing.
      clock.paint();
      expect(notified).toBe(1);
    });

    it("lets every blocking event jump the batch", () => {
      // One sample per blocking kind. A kind added to the set without a sample
      // fails here rather than going untested.
      const samples: readonly [ClientEvent["kind"], () => ClientEvent][] = [
        ["run.started", () => event("run.started", { threadId: "thread-1", workspaceId: "default" })],
        ["approval.required", () => event("approval.required", call(1, "c1"))],
        ["task.waiting", () => event("task.waiting", { on: "a reply", deadlineAt: "2026-09-20T00:00:00.000Z" })],
        [
          "task.review_required",
          () => event("task.review_required", { steps: 2, requests: [{ artifactId: "art-1", toolName: "t", callId: "c9" }] }),
        ],
        ["task.failed", () => event("task.failed", { errorCode: "PROVIDER", message: "down" })],
        ["task.stopped", () => event("task.stopped", { message: "You stopped this." })],
        ["task.completed", () => event("task.completed", { finalText: "done" })],
        ["resync.required", () => ({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2" })],
      ];
      expect([...samples.map(([kind]) => kind)].sort()).toEqual([...BLOCKING_KINDS].sort());

      for (const [kind, sample] of samples) {
        // A store of its own per kind, so no sample has to follow another.
        sequence = 0;
        const { client, fake } = fakeClient(listing(1, "c1"));
        const clock = fakeScheduler();
        const store = createCanvasStore(client, { ...options, scheduler: clock.scheduler });
        store.submit("p");
        const onEvent = fake.runs[0]?.options.onEvent;
        let notified = 0;
        store.subscribe(() => (notified += 1));
        onEvent?.(event("text.delta", { blockId: "b", text: "x" }));
        expect(notified, kind).toBe(0);
        // On screen without a frame, and the delta it followed with it.
        onEvent?.(sample());
        expect(notified, kind).toBeGreaterThan(0);
        expect(store.getSnapshot().runs[0]?.run.transcript, kind).toMatchObject(
          kind === "resync.required" ? [] : [{ kind: "text", text: "x" }],
        );
        const painted = notified;
        clock.paint();
        expect(notified, kind).toBe(painted);
      }
    });
  });

  it("holds an entry's frames while its record is read back, then applies them in order", async () => {
    sequence = 0;
    const record = { task: { status: "running" }, admissions: [{ kind: "start", operationKey: "ui-1", state: "committed" }] };
    const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
    const store = createCanvasStore(client, options);
    store.submit("keep going");
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2" });
    // The read is in flight: what the stream says now — in the epoch the resync opened — waits for it.
    onEvent?.({ ...event("text.delta", { blockId: "b", text: "after " }), epoch: "epoch-2" });
    onEvent?.({ ...event("text.delta", { blockId: "b", text: "the gap" }), epoch: "epoch-2" });
    expect(store.getSnapshot().runs[0]?.run.transcript).toEqual([]);
    expect(words(store.getSnapshot().runs[0]?.notice)).toContain("owner restarted");
    await settle();
    await settle();
    // Released in order, over the state the read left.
    expect(store.getSnapshot().runs[0]?.run.transcript).toMatchObject([{ kind: "text", text: "after the gap" }]);
    expect(store.getSnapshot().runs[0]?.notice).toBeUndefined();
  });

  it("holds again when a held frame is another resync, and releases only when the last read is through", async () => {
    sequence = 0;
    const record = { task: { status: "running" }, admissions: [{ kind: "start", operationKey: "ui-1", state: "committed" }] };
    const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
    const store = createCanvasStore(client, options);
    store.submit("keep going");
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.({ ...event("resync.required", { reason: "once" }), epoch: "epoch-2" });
    onEvent?.({ ...event("text.delta", { blockId: "b", text: "A" }), epoch: "epoch-2" });
    onEvent?.({ ...event("resync.required", { reason: "twice" }), epoch: "epoch-3" });
    onEvent?.({ ...event("text.delta", { blockId: "b", text: "B" }), epoch: "epoch-3" });
    expect(store.getSnapshot().runs[0]?.run.transcript).toEqual([]);
    for (let turn = 0; turn < 6; turn += 1) await settle();
    // Each resync among the held frames took a read of its own, in turn.
    expect(fake.requests.filter((request) => request.command === "tasks")).toHaveLength(2);
    // A was folded on the first release; the resync that followed it erased
    // what the stream had said, as a resync does, and B was held for the
    // second read rather than folded into the state it was about to replace.
    expect(store.getSnapshot().runs[0]?.run.transcript).toMatchObject([{ kind: "text", text: "B" }]);
    expect(store.getSnapshot().runs[0]?.notice).toBeUndefined();
  });

  it("releases an entry's held frames even when its record could not be read", async () => {
    sequence = 0;
    const { client, fake } = fakeClient((command) =>
      command === "tasks" ? { ok: false, error: { code: "FAILED", message: "the owner is busy" } } : { ok: true, result: {} },
    );
    const store = createCanvasStore(client, options);
    store.submit("keep going");
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2" });
    onEvent?.({ ...event("text.delta", { blockId: "b", text: "still here" }), epoch: "epoch-2" });
    for (let turn = 0; turn < 4; turn += 1) await settle();
    // The read failed and said so — and the held frame was not stranded in the queue.
    expect(words(store.getSnapshot().runs[0]?.error)).toContain("the owner is busy");
    expect(store.getSnapshot().runs[0]?.run.transcript).toMatchObject([{ kind: "text", text: "still here" }]);
  });

  it("stops following when the fold refuses a held frame, rather than folding later events over the hole", async () => {
    sequence = 0;
    const record = { task: { status: "running" }, admissions: [{ kind: "start", operationKey: "ui-1", state: "committed" }] };
    const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
    const store = createCanvasStore(client, options);
    store.submit("keep going");
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2" });
    // Held, and out of order for the epoch the resync opened: the fold refuses it.
    onEvent?.({ ...event("text.delta", { blockId: "b", text: "lost" }), epoch: "epoch-1" });
    for (let turn = 0; turn < 4; turn += 1) await settle();
    expect(words(store.getSnapshot().runs[0]?.error)).toContain("without a resync");
    // The stream is let go: no later event is folded over the gap.
    expect(fake.closed).toContain("run-1");
  });

  it("does not count a reconnect as work: a resync does not move the clock the strip measures", async () => {
    sequence = 0;
    const record = { task: { status: "running" }, admissions: [{ kind: "start", operationKey: "ui-1", state: "committed" }] };
    const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
    const store = createCanvasStore(client, options);
    store.submit("thirty seconds of work");
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.({ ...event("run.started", { threadId: "thread-1", workspaceId: "default" }), at: "2026-09-20T12:00:00.000Z" });
    onEvent?.({ ...event("task.completed", { finalText: "done" }), at: "2026-09-20T12:00:30.000Z" });
    const settledEntry = store.getSnapshot().runs[0];
    expect(settledEntry?.startedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(settledEntry?.lastAt).toBe("2026-09-20T12:00:30.000Z");
    // Two hours later the page rebinds. The owner stamps the resync with *now*,
    // which is when this page reconnected, not when the task last worked.
    onEvent?.({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2", at: "2026-09-20T14:00:00.000Z" });
    await settle();
    await settle();
    const after = store.getSnapshot().runs[0];
    expect(after?.startedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(after?.lastAt).toBe("2026-09-20T12:00:30.000Z");
  });

  it("counts only the time a turn ran: three hours waiting on an approval are not work", async () => {
    sequence = 0;
    const record = { task: { status: "running" }, admissions: [{ kind: "start", operationKey: "ui-1", state: "committed" }] };
    const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
    const store = createCanvasStore(client, options);
    store.submit("find flights");
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.({ ...event("run.started", { threadId: "thread-1", workspaceId: "default" }), at: "2026-09-20T12:00:00.000Z" });
    onEvent?.({ ...event("approval.required", call(1, "c1")), at: "2026-09-20T12:00:20.000Z" });
    onEvent?.({
      ...event("approval.settled", { steps: 1, decisions: [{ callId: "c1", approved: true }], decidedBy: "operator" }),
      at: "2026-09-20T15:00:00.000Z",
    });
    onEvent?.({ ...event("text.delta", { blockId: "b", text: "found" }), at: "2026-09-20T15:00:10.000Z" });
    onEvent?.({ ...event("task.completed", { finalText: "found" }), at: "2026-09-20T15:00:30.000Z" });
    expect(store.getSnapshot().runs[0]?.activeMs).toBe(50_000);
  });

  describe("a bounded transcript", () => {
    const longRun = (entries: number): CanvasRun => ({
      id: "r",
      prompt: "p",
      run: {
        ...initialRunState(),
        transcript: Array.from({ length: entries }, (_unused, index) => ({
          kind: "text" as const,
          key: `k${index}`,
          attemptId: "a",
          blockId: `b${index}`,
          text: `line ${index}`,
        })),
      },
      roundCalls: {},
      deciding: undefined,
      aborting: false,
    });

    it("shows a short transcript whole", () => {
      const window = transcriptWindow(longRun(TRANSCRIPT_HEAD + TRANSCRIPT_TAIL));
      expect(window.hidden).toBe(0);
      expect(window.head).toHaveLength(TRANSCRIPT_HEAD + TRANSCRIPT_TAIL);
      expect(window.tail).toEqual([]);
    });

    it("folds a long one's middle behind a count, keeping its head and its tail", () => {
      const window = transcriptWindow(longRun(TRANSCRIPT_HEAD + TRANSCRIPT_TAIL + 30));
      expect(window.head).toHaveLength(TRANSCRIPT_HEAD);
      expect(window.head[0]).toMatchObject({ text: "line 0" });
      expect(window.hidden).toBe(30);
      expect(window.tail).toHaveLength(TRANSCRIPT_TAIL);
      expect(window.tail.at(-1)).toMatchObject({ text: `line ${TRANSCRIPT_HEAD + TRANSCRIPT_TAIL + 29}` });
    });

    it("stops bounding it once the reader expands it", () => {
      const all = TRANSCRIPT_HEAD + TRANSCRIPT_TAIL + 30;
      expect(transcriptWindow({ ...longRun(all), expanded: true })).toMatchObject({ hidden: 0 });
      expect(transcriptWindow({ ...longRun(all), expanded: true }).head).toHaveLength(all);
    });

    it("expands the entry the reader asked for, and keeps it expanded", () => {
      const { client } = fakeClient();
      const store = createCanvasStore(client, options);
      store.submit("p");
      const id = store.getSnapshot().runs[0]?.id ?? "";
      expect(store.getSnapshot().runs[0]?.expanded).toBeUndefined();
      store.setExpanded(id, true);
      expect(store.getSnapshot().runs[0]?.expanded).toBe(true);
      // And undone: a misclick on the longest transcript is not permanent.
      store.setExpanded(id, false);
      expect(store.getSnapshot().runs[0]?.expanded).toBe(false);
    });
  });

  it("says why the client closed on its own", () => {
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, options);
    fake.failure = new Error("the bridge refused this page's session");
    fake.setState("closed");
    expect(store.getSnapshot()).toMatchObject({ connection: "closed", failure: "the bridge refused this page's session" });
    fake.failure = undefined;
    fake.setState("connecting");
    expect(store.getSnapshot().failure).toBeUndefined();
  });
});

describe("canvas disposal", () => {
  const options = { workspaceId: "default", principal: "operator", mintKey: () => "dispose-test" };
  it("closes an admission delivered after disposal and ignores state changes", async () => {
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, options);
    store.submit("late");
    store.dispose();
    const snapshot = store.getSnapshot();
    await settle();
    fake.setState("closed");
    fake.runs[0]?.options.onEvent(event("text.delta", { blockId: "b", text: "late" }));
    expect(fake.closed).toEqual(["run-1"]);
    expect(store.getSnapshot()).toBe(snapshot);
  });
  it("closes a restored live stream exactly once", async () => {
    const { client, fake } = fakeClient();
    fake.subscribeResponse = { ok: true, result: { replayed: 1 } };
    const store = createCanvasStore(client, {
      ...options,
      memory: { load: () => ({ taskId: "task-1", conversationId: "c" }), save: () => undefined },
    });
    await settle();
    store.dispose();
    store.dispose();
    expect(fake.closed).toEqual(["resume-1"]);
  });
});

it("rejects a legacy list response with the owner restart remedy", async () => {
  const { client } = fakeClient(() => ({ ok: true, result: { tasks: [] } }));
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "open" });
  await store.loadSessions();
  expect(store.getSnapshot().directory?.error).toContain("Restart the owner");
  store.dispose();
});

describe("a chat the person stopped", () => {
  const stoppedRecord = {
    found: true,
    task: { workspaceId: "default", origin: "ipc", status: "stopped", finalText: null },
    admissions: [
      {
        kind: "start",
        operationKey: "conversation",
        intent: { prompt: "a long job" },
        state: "committed",
        result: { status: "stopped", finalText: "You stopped this.", error: { code: "STOPPED", message: "You stopped this." } },
      },
    ],
    history: { startedAt: "2026-09-19T12:00:00.000Z", lastAt: "2026-09-19T12:00:03.000Z", activeMs: 3000 },
  };
  const calm = { status: "stopped", outcome: { kind: "stopped", message: "You stopped this." } };

  it("reads the same read back from its record: no failure, no owner notice, no error, and a reply continues it", async () => {
    let key = 0;
    const { client, fake } = fakeClient((command) => ({ ok: true, result: command === "tasks" ? stoppedRecord : {} }));
    const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => `open-${++key}` });
    await store.openTask("task-1");
    await settle();
    const run = store.getSnapshot().runs[0];
    expect(run).toMatchObject({ prompt: "a long job", run: calm });
    expect(run?.error).toBeUndefined();
    expect(run?.notice).toBeUndefined();
    expect(store.getSnapshot().continuing).toBe("task-1");
    store.submit("go on");
    await settle();
    await settle();
    expect(fake.requests.find((request) => request.command === "reply")?.payload).toMatchObject({
      conversationId: "conversation",
      text: "go on",
    });
  });

  it("reads the same after leaving and coming back, where the owner has nothing to replay", async () => {
    const { client, fake } = fakeClient((command) => ({ ok: true, result: command === "tasks" ? stoppedRecord : {} }));
    const store = createCanvasStore(client, options);
    store.submit("a long job");
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.(event("task.stopped", { message: "You stopped this." }));
    expect(store.getSnapshot().runs[0]?.run).toMatchObject(calm);
    await settle();
    await store.openTask("task-1");
    await settle();
    await settle();
    const run = store.getSnapshot().runs.at(-1);
    expect(run?.run).toMatchObject(calm);
    expect(run?.error).toBeUndefined();
    expect(run?.notice).toBeUndefined();
  });

  it("keeps the owner notice when the record holds no saved turn to show", async () => {
    const { history: _history, ...bare } = stoppedRecord;
    const { client } = fakeClient((command) => ({ ok: true, result: command === "tasks" ? bare : {} }));
    const store = createCanvasStore(client, options);
    await store.openTask("task-1");
    await settle();
    expect(store.getSnapshot().runs[0]?.run).toMatchObject(calm);
    expect(words(store.getSnapshot().runs[0]?.notice)).toContain("no longer holds");
  });
});

it("opens a record-only IPC task, displays its prompt and outcome, and continues its conversation", async () => {
  let key = 0;
  const record = {
    found: true,
    task: { workspaceId: "default", origin: "ipc", status: "completed", finalText: "recorded answer" },
    admissions: [
      {
        kind: "start",
        operationKey: "conversation",
        intent: { prompt: "recorded prompt" },
        state: "committed",
        result: { status: "completed", finalText: "recorded answer" },
      },
    ],
  };
  const { client, fake } = fakeClient((command) => ({ ok: true, result: command === "tasks" ? record : {} }));
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => `open-${++key}` });
  await store.openTask("task-1");
  await settle();
  expect(store.getSnapshot().runs[0]).toMatchObject({
    prompt: "recorded prompt",
    run: { status: "completed", outcome: { finalText: "recorded answer" } },
  });
  expect(words(store.getSnapshot().runs[0]?.notice)).toContain("no longer holds");
  expect(store.getSnapshot().continuing).toBe("task-1");
  store.submit("continue");
  await settle();
  await settle();
  expect(fake.requests.find((request) => request.command === "reply")?.payload).toMatchObject({
    conversationId: "conversation",
    text: "continue",
  });
  store.dispose();
});

it("refreshes every loaded history page without losing its cursor", async () => {
  const session = (taskId: string) => ({
    taskId,
    workspaceId: "default",
    status: "completed",
    origin: "ipc",
    createdAt: "2026-09-19T12:00:00.000Z",
    updatedAt: "2026-09-19T12:00:00.000Z",
    needs: [],
    counts: { admissions: 1, tools: null },
  });
  const { client } = fakeClient((_command, payload) => {
    const query = payload as { needs?: string[]; cursor?: string };
    return {
      ok: true,
      result: {
        action: "list",
        rows: query.needs ? [] : [session(query.cursor ? "older" : "latest")],
        truncated: false,
        ...(!query.needs ? { nextCursor: query.cursor ? "third" : "second" } : {}),
      },
    };
  });
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "page" });
  await store.loadSessions();
  await store.loadSessions({}, true);
  await store.loadSessions({}, false, true);
  expect(store.getSnapshot().directory?.rows.map((row) => row.taskId)).toEqual(["latest", "older"]);
  expect(store.getSnapshot().directory?.nextCursor).toBe("third");
  store.dispose();
});

it("does not pair durable prompts with partial replay and opens concurrent requests once", async () => {
  let key = 0;
  const record = {
    found: true,
    task: { workspaceId: "default", origin: "ipc", status: "completed" },
    admissions: [
      { kind: "start", operationKey: "conversation", intent: { prompt: "first prompt" } },
      { kind: "reply", intent: { prompt: "later prompt" } },
    ],
  };
  const { client, fake } = fakeClient(() => ({ ok: true, result: record }));
  fake.subscribeResponse = { ok: true, result: { replayed: 2 } };
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => `partial-${++key}` });
  await Promise.all([store.openTask("task-1"), store.openTask("task-1")]);
  await settle();
  expect(fake.subscribes).toHaveLength(1);
  fake.subscribes[0]?.options.onEvent(event("text.delta", { blockId: "last", text: "last answer" }));
  fake.subscribes[0]?.options.onEvent(event("task.completed", { finalText: "last answer" }));
  expect(store.getSnapshot().runs).toHaveLength(1);
  expect(store.getSnapshot().runs[0]).toMatchObject({ prompt: "", recordedPrompts: ["first prompt", "later prompt"] });
  store.dispose();
});

it("pairs an opened task's prompts with its turns when every turn is replayed", async () => {
  let key = 0;
  const record = {
    found: true,
    task: { workspaceId: "default", origin: "ipc", status: "completed" },
    admissions: [
      { kind: "start", operationKey: "conversation", intent: { prompt: "first prompt" }, state: "committed" },
      { kind: "reply", intent: { prompt: "later prompt" }, state: "committed" },
    ],
  };
  const { client, fake } = fakeClient(() => ({ ok: true, result: record }));
  fake.subscribeResponse = { ok: true, result: { replayed: 4 } };
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => `whole-${++key}` });
  await store.openTask("task-1");
  await settle();
  const onEvent = fake.subscribes[0]?.options.onEvent;
  onEvent?.(event("text.delta", { blockId: "first", text: "first answer" }));
  onEvent?.(event("task.completed", { finalText: "first answer" }));
  onEvent?.({ ...event("text.delta", { blockId: "later", text: "later answer" }), attemptId: "attempt-2" });
  onEvent?.({ ...event("task.completed", { finalText: "later answer" }), attemptId: "attempt-2" });
  expect(store.getSnapshot().runs.map((run) => run.prompt)).toEqual(["first prompt", "later prompt"]);
  store.dispose();
});

it("scopes both list reads and excludes a second workspace from its needs snapshot", async () => {
  const other = {
    taskId: "other-task",
    workspaceId: "other",
    status: "input-required",
    origin: "ipc",
    createdAt: "2026-09-19T12:00:00.000Z",
    updatedAt: "2026-09-19T12:00:00.000Z",
    needs: ["question"],
    counts: { admissions: 1, tools: 0 },
  };
  const { client, fake } = fakeClient(() => ({ ok: true, result: { action: "list", rows: [other], truncated: false } }));
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "scope" });
  await store.loadSessions({ workspaceId: "other" });
  expect(fake.requests.every((request) => (request.payload as { workspaceId: string }).workspaceId === "default")).toBe(true);
  expect(store.getSnapshot().directory).toMatchObject({ rows: [], needs: [] });
  await expect(store.openTask("other-task")).rejects.toThrow("Chat not found in this workspace");
  expect(fake.subscribes).toHaveLength(0);
  store.dispose();
});

it("retains known history needs when the independent inbox is capped", async () => {
  const row = {
    taskId: "older",
    workspaceId: "default",
    status: "input-required",
    origin: "ipc",
    createdAt: "2026-09-19T12:00:00.000Z",
    updatedAt: "2026-09-19T12:00:00.000Z",
    needs: ["question"],
    counts: { admissions: 1, tools: 0 },
  };
  const { client } = fakeClient((_command, payload) => ({
    ok: true,
    result: { action: "list", rows: "needs" in (payload as object) ? [] : [row], truncated: "needs" in (payload as object) },
  }));
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "cap" });
  await store.loadSessions();
  expect(store.getSnapshot().directory?.rows[0]?.needs).toEqual(["question"]);
  store.dispose();
});

it("sends a complete per-call decision and retains approval details after settlement", async () => {
  const { client, fake } = fakeClient((command) => ({
    ok: true,
    result: command === "approvals" ? { rows: [row(1, "c1"), row(1, "c2")] } : {},
  }));
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "mixed" });
  store.submit("mixed tools");
  await settle();
  const emit = fake.runs[0]!.options.onEvent;
  emit(event("approval.required", call(1, "c1")));
  emit(event("approval.required", call(1, "c2")));
  await settle();
  store.decide("mixed", [{ callId: "c1", approved: true }]);
  expect(fake.requests.filter((request) => request.command === "approve")).toHaveLength(0);
  const decisions = [
    { callId: "c1", approved: true },
    { callId: "c2", approved: false },
  ];
  store.decide("mixed", decisions);
  await settle();
  expect(fake.requests.find((request) => request.command === "approve")?.payload).toMatchObject({ expectedSteps: 1, decisions });
  emit(event("approval.settled", { steps: 1, decisions, decidedBy: "other-client" }));
  expect(store.getSnapshot().runs[0]?.approvalHistory?.[1]?.requests).toHaveLength(2);
  expect(store.getSnapshot().runs[0]?.run.settled[0]?.decidedBy).toBe("other-client");
  store.dispose();
});

it("sends a per-call decision's scope on the approved calls and its trimmed reason on the rejected ones", async () => {
  const { client, fake } = fakeClient((command) => ({
    ok: true,
    result: command === "approvals" ? { rows: [row(1, "c1"), row(1, "c2")] } : {},
  }));
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "mixed" });
  store.submit("mixed tools");
  await settle();
  const emit = fake.runs[0]!.options.onEvent;
  emit(event("approval.required", call(1, "c1")));
  emit(event("approval.required", call(1, "c2")));
  await settle();
  store.decide(
    "mixed",
    [
      { callId: "c1", approved: true },
      { callId: "c2", approved: false },
    ],
    { scope: "session", note: "  not that one  " },
  );
  await settle();
  expect(fake.requests.find((request) => request.command === "approve")?.payload).toEqual({
    taskId: "task-1",
    workspaceId: "default",
    expectedSteps: 1,
    decisions: [
      { callId: "c1", approved: true, scope: "session" },
      { callId: "c2", approved: false, note: "not that one" },
    ],
    decidedBy: "operator",
  });
  store.dispose();
});

it("sends a rejection's reason trimmed, and no reason with an approval", async () => {
  const decide = async (approved: boolean, note: string) => {
    const { client, fake } = fakeClient((command) => ({ ok: true, result: command === "approvals" ? { rows: [row(2, "c1")] } : {} }));
    const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "whole" });
    store.submit("one tool");
    await settle();
    fake.runs[0]!.options.onEvent(event("approval.required", call(2, "c1")));
    await settle();
    store.decide("whole", approved, { note });
    await settle();
    store.dispose();
    return fake.requests.find((request) => request.command === "approve")?.payload;
  };
  expect(await decide(false, "  use the draft  ")).toEqual({
    taskId: "task-1",
    workspaceId: "default",
    expectedSteps: 2,
    verdict: "reject",
    note: "use the draft",
    decidedBy: "operator",
  });
  expect(await decide(false, "   ")).toEqual({
    taskId: "task-1",
    workspaceId: "default",
    expectedSteps: 2,
    verdict: "reject",
    decidedBy: "operator",
  });
  expect(await decide(true, "fine")).toEqual({
    taskId: "task-1",
    workspaceId: "default",
    expectedSteps: 2,
    verdict: "approve",
    decidedBy: "operator",
  });
});

it("answers an inline question once and retries a timeout with the same message ID", async () => {
  let key = 0;
  const record = {
    task: { status: "waiting", workspaceId: "default", origin: "ipc" },
    admissions: [
      {
        kind: "start",
        operationKey: "question-conversation",
        state: "committed",
        result: {
          status: "waiting",
          waitInterrupt: { wait: { waitId: "wait", deadlineAt: "2099-01-01T00:00:00Z" }, question: "Which folder?" },
        },
      },
    ],
  };
  let replies = 0;
  const { client, fake } = fakeClient((command) =>
    command === "tasks"
      ? { ok: true, result: record }
      : ++replies === 1
        ? { ok: false, error: { code: CLIENT_TIMEOUT, message: "timeout" } }
        : { ok: true, result: { taskId: "task-1" } },
  );
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => `question-${++key}` });
  await store.openTask("task-1");
  await settle();
  const id = store.getSnapshot().runs[0]!.id;
  store.answerQuestion(id, "reports");
  store.answerQuestion(id, "duplicate");
  await settle();
  const sent = fake.requests.filter((request) => request.command === "reply");
  expect(sent).toHaveLength(2);
  expect(sent[0]?.payload).toEqual(sent[1]?.payload);
  expect(sent[0]?.payload).toMatchObject({ workspaceId: "default", conversationId: "question-conversation", text: "reports" });
  expect(store.getSnapshot().runs[0]?.answer).toMatchObject({ status: "recorded", text: "reports" });
  store.answerQuestion(id, "duplicate");
  expect(fake.requests.filter((request) => request.command === "reply")).toHaveLength(2);
  store.dispose();
});

it("puts a message the owner never got back in the box, plainly, and leaves the chat as it was", async () => {
  let key = 0;
  const record = {
    task: { status: "completed", workspaceId: "default", origin: "ipc" },
    admissions: [{ kind: "start", operationKey: "conversation", state: "committed", result: { status: "completed", finalText: "first" } }],
  };
  const { client, fake } = fakeClient((command) => ({ ok: true, result: command === "tasks" ? record : { taskId: "task-1" } }));
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => `stall-${++key}` });
  await store.openTask("task-1");
  await settle();
  // The owner stalls: following the chat times out on the client, so no reply is sent.
  fake.subscribeResponse = { ok: false, error: { code: CLIENT_TIMEOUT, message: "the owner did not answer subscribe within 5000 ms" } };
  store.submit("and the next step?");
  await settle();
  await settle();
  const snapshot = store.getSnapshot();
  expect(fake.requests.some((request) => request.command === "reply")).toBe(false);
  expect(snapshot.runs.some((run) => run.prompt === "and the next step?")).toBe(false);
  expect(snapshot.runs.some((run) => run.error !== undefined)).toBe(false);
  expect(snapshot.unsent?.text).toBe("and the next step?");
  expect(words(snapshot.unsent?.message)).toContain("did not answer in time");
  expect(words(snapshot.unsent?.message)).not.toContain("subscribe");
  // Sent again once the owner is back: the same chat continues, and the note goes.
  fake.subscribeResponse = { ok: true, result: {} };
  store.submit("and the next step?");
  await settle();
  expect(store.getSnapshot().unsent).toBeUndefined();
  expect(fake.requests.at(-1)).toMatchObject({ command: "reply", payload: { text: "and the next step?" } });
  store.dispose();
});

it.each(["continued", "replayed"])("keeps local reply capability in a later %s turn", async (mode) => {
  let key = 0;
  const record = {
    task: { status: "completed", workspaceId: "default", origin: "ipc" },
    admissions: [{ kind: "start", operationKey: "conversation", state: "committed", result: { status: "completed", finalText: "first" } }],
  };
  const { client, fake } = fakeClient((command) => ({ ok: true, result: command === "tasks" ? record : { taskId: "task-1" } }));
  fake.subscribeResponse = { ok: true, result: { replayed: mode === "replayed" ? 3 : 0 } };
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => `later-${++key}` });
  await store.openTask("task-1");
  await settle();
  if (mode === "continued") {
    store.submit("next turn");
    await settle();
  }
  const emit = fake.subscribes.at(-1)!.options.onEvent;
  if (mode === "replayed") emit(event("task.completed", { finalText: "first" }));
  const waiting = { on: "reply", question: "Which?", deadlineAt: "2099-01-01T00:00:00Z" };
  emit(event("task.waiting", waiting));
  const current = store.getSnapshot().runs.at(-1)!;
  store.answerQuestion(current.id, "answer");
  await settle();
  // A task started here answers in its own conversation.
  expect(fake.requests.at(-1)?.command).toBe("reply");
  expect(store.getSnapshot().runs.at(-1)?.answer?.status).toBe("recorded");
  emit(event("task.waiting", waiting));
  store.answerQuestion(current.id, "answer again");
  await settle();
  expect(fake.requests.filter((request) => request.command === "reply").at(-1)?.payload).toMatchObject({ text: "answer again" });
  store.dispose();
});

it("loads review metadata and resumes only after the last pending artifact is decided", async () => {
  const requests = ["a", "b"].map((artifactId) => ({ artifactId, toolName: "browser", callId: artifactId, steps: 2 }));
  const record = {
    task: { workspaceId: "default", origin: "ipc", status: "waiting" },
    admissions: [
      { kind: "start", operationKey: "conversation", state: "committed", result: { status: "waiting", reviewInterrupt: { requests } } },
    ],
  };
  const rows = requests.map(({ artifactId }) => ({
    artifactId,
    workspaceId: "default",
    runId: "task-1",
    contentType: "image/png",
    byteSize: 42,
    reviewState: "pending",
  }));
  const { client, fake } = fakeClient((command, payload) =>
    command === "tasks"
      ? { ok: true, result: record }
      : command === "artifacts"
        ? { ok: true, result: { rows } }
        : {
            ok: true,
            result: {
              decisions: (payload as { decisions: { artifactId: string; approved: boolean }[] }).decisions.map((decision) => ({
                artifactId: decision.artifactId,
                reviewState: decision.approved ? "approved" : "rejected",
                alreadyDecided: false,
              })),
            },
          },
  );
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "review" });
  await store.openTask("task-1");
  await settle();
  await store.loadArtifacts("review");
  expect(store.getSnapshot().runs[0]?.artifacts).toHaveLength(2);
  store.reviewArtifacts("review", [{ artifactId: "a", approved: true }]);
  await settle();
  expect(fake.requests.filter((request) => request.command === "review").at(-1)?.payload).toMatchObject({ resume: false });
  store.reviewArtifacts("review", [{ artifactId: "b", approved: false }]);
  await settle();
  expect(fake.requests.filter((request) => request.command === "review").at(-1)?.payload).toMatchObject({ resume: true, expectedSteps: 2 });
  expect(store.getSnapshot().runs[0]?.artifacts?.map((row) => row.reviewState)).toEqual(["approved", "rejected"]);
  store.dispose();
});

it("rejects stale artifact reads and ignores a write response from an older round", async () => {
  const requests = ["a", "b"].map((artifactId) => ({ artifactId, toolName: "browser", callId: artifactId, steps: 2 }));
  const record = {
    task: { workspaceId: "default", origin: "ipc", status: "waiting" },
    admissions: [
      { kind: "start", operationKey: "conversation", state: "committed", result: { status: "waiting", reviewInterrupt: { requests } } },
    ],
  };
  const rows = requests.map(({ artifactId }) => ({
    artifactId,
    workspaceId: "default",
    runId: "task-1",
    contentType: "image/png",
    byteSize: 42,
    reviewState: "pending",
  }));
  const { client, fake } = fakeClient((command, payload) =>
    command === "tasks"
      ? { ok: true, result: record }
      : command === "artifacts"
        ? { ok: true, result: { rows } }
        : {
            ok: true,
            result: {
              decisions: (payload as { decisions: { artifactId: string; approved: boolean }[] }).decisions.map((decision) => ({
                artifactId: decision.artifactId,
                reviewState: decision.approved ? "approved" : "rejected",
              })),
            },
          },
  );
  const baseRequest = client.request;
  const reads: ((answer: ClientResponse) => void)[] = [];
  let delayReads = false;
  let delayedWrite: ((answer: ClientResponse) => void) | undefined;
  let delayWrites = false;
  client.request = (command, payload) =>
    command === "artifacts" && delayReads
      ? new Promise((resolve) => reads.push(resolve))
      : command === "review" && delayWrites
        ? new Promise((resolve) => {
            delayedWrite = resolve;
          })
        : baseRequest(command, payload);
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "races" });
  await store.openTask("task-1");
  await settle();
  await store.loadArtifacts("races");
  delayReads = true;
  const first = store.loadArtifacts("races");
  const second = store.loadArtifacts("races");
  reads[1]!({ ok: true, result: { rows: rows.map((row) => ({ ...row, byteSize: 99 })) } });
  await second;
  reads[0]!({ ok: true, result: { rows } });
  await first;
  expect(store.getSnapshot().runs[0]?.artifacts?.[0]?.byteSize).toBe(99);
  const stale = store.loadArtifacts("races");
  store.reviewArtifacts("races", [{ artifactId: "a", approved: true }]);
  await settle();
  reads[2]!({ ok: true, result: { rows } });
  await stale;
  expect(store.getSnapshot().runs[0]?.artifacts?.[0]?.reviewState).toBe("approved");
  delayWrites = true;
  store.reviewArtifacts("races", [{ artifactId: "b", approved: false }]);
  fake.subscribes[0]!.options.onEvent(
    event("task.review_required", { steps: 3, requests: [{ artifactId: "new", toolName: "browser", callId: "new" }] }),
  );
  delayedWrite!({ ok: false, error: { code: "CONFLICT", message: "old round" } });
  await settle();
  expect(store.getSnapshot().runs[0]).toMatchObject({ reviewBusy: false, reviewError: "", artifacts: [] });
  store.dispose();
});

it("preserves search filters when the global inbox refreshes history", async () => {
  const { client, fake } = fakeClient(() => ({ ok: true, result: { action: "list", rows: [], truncated: false } }));
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "filter" });
  await store.loadSessions({ query: "needle", status: ["failed"] });
  await store.loadSessions(undefined, false, true);
  // Each read is the list, the needs inbox and the reader's Home, read apart.
  expect(fake.requests[3]?.payload).toMatchObject({ query: "needle", status: ["failed"], workspaceId: "default" });
  expect(fake.requests[4]?.payload).not.toHaveProperty("query");
  expect(fake.requests[5]?.payload).toEqual({
    action: "list",
    workspaceId: "default",
    chatKinds: ["home"],
    principalId: "operator",
    limit: 1,
  });
  store.dispose();
});

it("keeps the reader's Home in the sidebar whatever the search or however many newer chats", async () => {
  const row = (taskId: string, extra: Record<string, unknown> = {}) => ({
    taskId,
    workspaceId: "default",
    principalId: "operator",
    status: "completed",
    origin: "web",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    delegated: 0,
    summary: null,
    summaryState: null,
    needs: [],
    ownNeeds: [],
    counts: { admissions: 1, tools: 0 },
    followUps: 0,
    title: taskId,
    ...extra,
  });
  const { client } = fakeClient((_command, payload) => {
    const asked = payload as { chatKinds?: string[]; needs?: string[] };
    if (asked.chatKinds?.includes("home"))
      return {
        ok: true,
        result: { action: "list", rows: [row("home-1", { chatKind: "home", status: "idle", title: "Home" })], truncated: false },
      };
    if (asked.needs !== undefined) return { ok: true, result: { action: "list", rows: [], truncated: false } };
    return { ok: true, result: { action: "list", rows: [row("chat-1")], truncated: false } };
  });
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "home" });
  await store.loadSessions({ query: "chat" });
  expect(store.getSnapshot().directory?.rows.map((listed) => listed.taskId)).toEqual(["home-1", "chat-1"]);
  store.dispose();
});

it("reopens cached terminal tasks from their cursor and retains the prior transcript", async () => {
  let key = 0;
  const { client, fake } = fakeClient();
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => `refresh-${++key}` });
  store.submit("first");
  await settle();
  fake.runs[0]!.options.onEvent(event("text.delta", { blockId: "first", text: "old answer" }));
  fake.runs[0]!.options.onEvent(event("task.completed", { finalText: "old answer" }));
  const cursor = store.getSnapshot().runs[0]!.run.cursor;
  fake.subscribeResponse = { ok: true, result: { replayed: 2 } };
  await Promise.all([store.openTask("task-1"), store.openTask("task-1")]);
  await settle();
  expect(fake.subscribes).toHaveLength(1);
  expect(fake.subscribes[0]!.options.from).toEqual(cursor);
  fake.subscribes[0]!.options.onEvent(event("text.delta", { blockId: "next", text: "external answer" }));
  fake.subscribes[0]!.options.onEvent(event("task.completed", { finalText: "external answer" }));
  expect(store.getSnapshot().runs).toHaveLength(2);
  expect(store.getSnapshot().runs[0]!.run.outcome).toMatchObject({ finalText: "old answer" });
  expect(store.getSnapshot().runs[1]!.run.outcome).toMatchObject({ finalText: "external answer" });
  store.dispose();
});
it("counts cached turns once after reopening with a whole-task history and no replay", async () => {
  let key = 0;
  const { client, fake } = fakeClient();
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => `history-${++key}` });
  const emitCall = (onEvent: RunOptions["onEvent"] | undefined, attemptId: string) => {
    onEvent?.(event("tool.started", { attemptId, blockId: "c", callId: "c", toolName: "web_search", input: {} }));
    onEvent?.(event("tool.completed", { attemptId, callId: "c", toolName: "web_search", output: {}, durationMs: 5 }));
    onEvent?.(event("task.completed", { attemptId, finalText: "done" }));
  };
  store.submit("first");
  await settle();
  emitCall(fake.runs[0]?.options.onEvent, "a");
  fake.subscribeResponse = { ok: true, result: { replayed: 3 } };
  await store.openTask("task-1");
  await settle();
  emitCall(fake.subscribes[0]?.options.onEvent, "b");
  expect(store.getSnapshot().runs).toHaveLength(2);
  const history = {
    partial: false,
    tools: ["a", "b"].map((attemptId) => ({
      kind: "tool",
      key: `${attemptId}:c`,
      attemptId,
      callId: "c",
      toolName: "web_search",
      status: "completed",
      durationMs: 5,
    })),
  };
  fake.answer = () => ({
    ok: true,
    result: {
      found: true,
      task: { workspaceId: "default", status: "completed", finalText: "done" },
      admissions: [{ kind: "start", state: "committed", result: { status: "completed" } }],
      history,
    },
  });
  fake.subscribeResponse = { ok: true, result: { replayed: 0 } };
  await store.openTask("task-1");
  await settle();
  await settle();
  expect(store.getSnapshot().runs.at(-1)?.recordedHistory).toEqual(history);
  const session = sessionsOf(store.getSnapshot().runs)[0];
  if (session === undefined) throw new Error("Missing reopened task");
  expect(sessionStats(session).tools).toBe(2);
  expect(
    sessionToolGroups(session)
      .flatMap((group) => group.cards)
      .map((card) => card.attemptId),
  ).toEqual(["a", "b"]);
  store.dispose();
});
it("refreshes a cached record-only task when it now waits for a question", async () => {
  let key = 0;
  const record = {
    found: true,
    task: { workspaceId: "default", origin: "schedule", status: "completed", finalText: "old" },
    admissions: [{ kind: "start", state: "committed", result: { status: "completed", finalText: "old" } }],
  };
  const { client, fake } = fakeClient(() => ({ ok: true, result: record }));
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => `cached-${++key}` });
  await store.openTask("task-1");
  await settle();
  await settle();
  fake.answer = () => ({
    ok: true,
    result: {
      ...record,
      task: { ...record.task, status: "waiting" },
      admissions: [
        {
          kind: "start",
          state: "committed",
          result: {
            status: "waiting",
            waitInterrupt: { wait: { waitId: "w", deadlineAt: "2099-01-01T00:00:00Z" }, question: "Which one?" },
          },
        },
      ],
    },
  });
  await store.openTask("task-1");
  await settle();
  await settle();
  expect(fake.subscribes).toHaveLength(2);
  expect(store.getSnapshot().runs.at(-1)?.run.waiting?.question).toBe("Which one?");
  expect(store.getSnapshot().continuing).toBeUndefined();
  // No conversation here, yet the question is answerable: by its task.
  const id = store.getSnapshot().runs.at(-1)?.id ?? "";
  fake.answer = (command) =>
    command === "approvals" ? { ok: true, result: { taskId: "task-1", waitId: "w", answers: [] } } : { ok: true, result: record };
  store.answerQuestion(id, "the first one");
  await settle();
  expect(fake.requests.at(-1)).toEqual({
    command: "approvals",
    payload: { action: "answer", workspaceId: "default", taskId: "task-1", answer: "the first one", waitId: "w" },
  });
  expect(store.getSnapshot().runs.at(-1)?.answer).toMatchObject({ status: "recorded", text: "the first one" });
  store.dispose();
});
it("reports an answer by task as uncertain, not failed, when its retry after a timeout finds it already recorded", async () => {
  const record = {
    found: true,
    task: { workspaceId: "default", origin: "schedule", status: "waiting", finalText: null },
    admissions: [
      {
        kind: "start",
        state: "committed",
        result: { status: "waiting", waitInterrupt: { wait: { waitId: "w", deadlineAt: "2099-01-01T00:00:00Z" }, question: "Which one?" } },
      },
    ],
  };
  let answers = 0;
  const { client } = fakeClient((command) =>
    command === "approvals"
      ? ++answers === 1
        ? { ok: false, error: { code: CLIENT_TIMEOUT, message: "slow" } }
        : { ok: false, error: { code: "CONFLICT", message: "This question was already answered, or has closed." } }
      : { ok: true, result: record },
  );
  const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "k" });
  await store.openTask("task-1");
  await settle();
  await settle();
  store.answerQuestion(store.getSnapshot().runs.at(-1)?.id ?? "", "the first one");
  await settle();
  await settle();
  expect(answers).toBe(2);
  expect(store.getSnapshot().runs.at(-1)?.answer).toMatchObject({ status: "uncertain" });
  store.dispose();
});

describe("a root chat's workers' questions", () => {
  const AT = "2026-10-04T10:00:00.000Z";
  const question = (waitId: string, taskId: string, text: string) => ({
    kind: "question",
    needId: `question:${waitId}`,
    taskId,
    askedAt: AT,
    deadlineAt: "2099-01-01T00:00:00.000Z",
    question: {
      taskId,
      workspaceId: "default",
      principalId: "operator",
      workerLabel: `agent of ${taskId}`,
      waitId,
      question: text,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      askedAt: AT,
      deliveries: [],
    },
  });
  const record = {
    found: true,
    task: { workspaceId: "default", origin: "ipc", status: "completed" },
    admissions: [
      {
        kind: "start",
        operationKey: "conversation",
        intent: { prompt: "research it" },
        state: "committed",
        result: { status: "completed", finalText: "on it" },
      },
    ],
  };
  const owner = (open: () => unknown[]) =>
    fakeClient((command, payload) => {
      if (command === "tasks") return { ok: true, result: record };
      if (command === "approvals" && (payload as { action: string }).action === "needs")
        return { ok: true, result: { needs: open(), handoffs: [], truncated: false } };
      if (command === "approvals")
        return {
          ok: true,
          result: {
            taskId: (payload as { taskId: string }).taskId,
            waitId: (payload as { waitId: string }).waitId,
            answers: [],
            other: "x",
          },
        };
      return { ok: true, result: {} };
    });

  it("answers the one open question by typing — at the worker's wait, never as a turn of the root — and keeps a receipt", async () => {
    let key = 0;
    let open = [question("wait-1", "worker-1", "Which source?")];
    const { client, fake } = owner(() => open);
    const store = createCanvasStore(client, { ...options, mintKey: () => `worker-${++key}` });
    await store.openTask("task-1");
    await settle();
    await store.loadWorkerNeeds("task-1");
    expect(fake.requests.find((request) => request.command === "approvals")?.payload).toEqual({
      action: "needs",
      workspaceId: "default",
      rootTaskId: "task-1",
    });
    expect(store.getSnapshot().next).toEqual({ kind: "answer", taskId: "worker-1", waitId: "wait-1", rootTaskId: "task-1" });
    open = [];
    store.submit("the docs");
    await settle();
    await settle();
    const answers = fake.requests.filter((request) => (request.payload as { action?: string }).action === "answer");
    expect(answers.map((request) => request.payload)).toEqual([
      { action: "answer", workspaceId: "default", taskId: "worker-1", answer: "the docs", waitId: "wait-1" },
    ]);
    expect(fake.requests.some((request) => request.command === "reply")).toBe(false);
    expect(fake.runs).toEqual([]);
    // Closed since: its answer from here is its receipt, and the next prompt continues the chat.
    expect(store.getSnapshot().workers?.["task-1"]).toMatchObject({
      questions: [],
      answers: { "wait-1": { status: "recorded", text: "the docs" } },
    });
    expect(store.getSnapshot().next).toEqual({ kind: "continue", taskId: "task-1" });
    store.dispose();
  });

  it("sends a typed line as a message when two questions are open, and each is answered from its card", async () => {
    let key = 0;
    const { client, fake } = owner(() => [question("wait-1", "worker-1", "Which source?"), question("wait-2", "worker-2", "How deep?")]);
    const store = createCanvasStore(client, { ...options, mintKey: () => `two-${++key}` });
    await store.openTask("task-1");
    await settle();
    await store.loadWorkerNeeds("task-1");
    expect(store.getSnapshot().next).toEqual({ kind: "continue", taskId: "task-1" });
    store.submit("and also check prices");
    await settle();
    await settle();
    expect(fake.requests.find((request) => request.command === "reply")?.payload).toMatchObject({
      conversationId: "conversation",
      text: "and also check prices",
    });
    expect(fake.requests.some((request) => (request.payload as { action?: string }).action === "answer")).toBe(false);
    store.answerWorker("task-1", "wait-2", "one level");
    await settle();
    expect(fake.requests.find((request) => (request.payload as { action?: string }).action === "answer")?.payload).toMatchObject({
      taskId: "worker-2",
      waitId: "wait-2",
      answer: "one level",
    });
    store.dispose();
  });

  it("reads nothing more from an older owner that cannot list a root's workers' questions — one that drops the root and lists the workspace, or refuses it — and drops the root's own question", async () => {
    let key = 0;
    // An older owner strips `rootTaskId` and answers for the whole workspace, without `handoffs`.
    const { client, fake } = fakeClient((command) => {
      if (command === "tasks") return { ok: true, result: record };
      if (command === "approvals")
        return { ok: true, result: { needs: [question("wait-9", "other-chat", "Someone else's?")], truncated: false } };
      return { ok: true, result: {} };
    });
    const store = createCanvasStore(client, { ...options, mintKey: () => `old-${++key}` });
    await store.openTask("task-1");
    await settle();
    await store.loadWorkerNeeds("task-1");
    await store.loadWorkerNeeds("task-1");
    expect(store.getSnapshot().workers).toBeUndefined();
    expect(fake.requests.filter((request) => request.command === "approvals")).toHaveLength(1);
    expect(store.getSnapshot().next).toEqual({ kind: "continue", taskId: "task-1" });
    store.submit("carry on");
    await settle();
    await settle();
    expect(fake.requests.find((request) => request.command === "reply")?.payload).toMatchObject({ text: "carry on" });
    store.dispose();

    const refusing = fakeClient((command) =>
      command === "approvals" ? { ok: false, error: { code: "INVALID_INPUT", message: "Unrecognized key" } } : { ok: true, result: record },
    );
    const again = createCanvasStore(refusing.client, { ...options, mintKey: () => `refused-${++key}` });
    await again.loadWorkerNeeds("task-1");
    await again.loadWorkerNeeds("task-1");
    expect(refusing.fake.requests.filter((request) => request.command === "approvals")).toHaveLength(1);
    again.dispose();

    // A current owner's listing that names the root itself: not a worker's.
    const { client: own } = owner(() => [question("wait-own", "task-1", "The root's own?")]);
    const third = createCanvasStore(own, { ...options, mintKey: () => `own-${++key}` });
    await third.loadWorkerNeeds("task-1");
    expect(third.getSnapshot().workers?.["task-1"]?.questions).toEqual([]);
    third.dispose();
  });

  it("queues a typed line behind the chat's own question when a worker asks too, and never routes to a chat not on screen", async () => {
    let key = 0;
    const { client, fake } = owner(() => [question("wait-1", "worker-1", "Which source?")]);
    const store = createCanvasStore(client, { ...options, mintKey: () => `both-${++key}` });
    store.submit("research it");
    fake.runs[0]?.options.onEvent(
      event("task.waiting", {
        on: "the operator",
        wait: { waitId: "w-own", deadlineAt: "2099-01-01T00:00:00Z" },
        question: "Which market?",
      }),
    );
    await settle();
    expect(store.getSnapshot().next).toEqual({ kind: "answer", taskId: "task-1" });
    await store.loadWorkerNeeds("task-1");
    expect(store.getSnapshot().next).toEqual({ kind: "queue", taskId: "task-1" });
    // Another chat's worker, read earlier, is not this chat's.
    await store.loadWorkerNeeds("other-chat");
    expect(store.getSnapshot().next).toEqual({ kind: "queue", taskId: "task-1" });
    store.dispose();

    // Home has a worker's question, but the chat on screen is another: a typed line answers nothing there.
    const homeRecord = {
      found: true,
      task: { workspaceId: "default", origin: "web", chatKind: "home", principalId: "operator", status: "completed" },
      admissions: [],
    };
    const second = fakeClient((command, payload) => {
      if (command === "tasks") return { ok: true, result: homeRecord };
      if (command === "approvals")
        return { ok: true, result: { needs: [question("wait-h", "home-worker", "Home's worker asks")], handoffs: [], truncated: false } };
      return { ok: true, result: payload };
    });
    const away = createCanvasStore(second.client, { ...options, mintKey: () => `away-${++key}` });
    away.setHome(true);
    await away.openTask("home-task");
    await settle();
    await away.loadWorkerNeeds("home-task");
    expect(away.getSnapshot().next).toMatchObject({ kind: "answer", waitId: "wait-h", rootTaskId: "home-task" });
    // A chat of its own, refused at admission, is on screen now; the next message goes to Home, as a message.
    away.newTask();
    second.fake.queueRun({ ok: false, error: { code: "INVALID_INPUT", message: "refused" } });
    away.submit("plan the trip");
    await settle();
    expect(away.getSnapshot().next).toEqual({ kind: "home" });
    away.dispose();
  });

  it("offers an answer of unknown fate again once a read still lists its question", async () => {
    let key = 0;
    const { client, fake } = owner(() => [question("wait-1", "worker-1", "Which source?")]);
    const answer = fake.answer;
    fake.answer = (command, payload) =>
      (payload as { action?: string }).action === "answer"
        ? { ok: false, error: { code: CLIENT_TIMEOUT, message: "no answer in time" } }
        : answer(command, payload);
    const store = createCanvasStore(client, { ...options, mintKey: () => `unsure-${++key}` });
    await store.openTask("task-1");
    await settle();
    await store.loadWorkerNeeds("task-1");
    store.submit("the docs");
    for (let index = 0; index < 6; index += 1) await settle();
    expect(store.getSnapshot().workers?.["task-1"]?.answers["wait-1"]).toMatchObject({
      status: "failed",
      message: "The answer was not recorded.",
    });
    expect(store.getSnapshot().next).toEqual({ kind: "answer", taskId: "worker-1", waitId: "wait-1", rootTaskId: "task-1" });
    fake.answer = answer;
    store.answerWorker("task-1", "wait-1", "the docs");
    await settle();
    expect(fake.requests.filter((request) => (request.payload as { action?: string }).action === "answer")).toHaveLength(3);
    store.dispose();
  });

  it("lists no worker in the sidebar, while its root's row counts its need and its questions are read again", async () => {
    const at = "2026-09-19T12:00:00.000Z";
    const root = {
      taskId: "root",
      workspaceId: "default",
      status: "completed",
      origin: "ipc",
      createdAt: at,
      updatedAt: at,
      needs: ["question"],
      ownNeeds: [],
      descendantNeeds: ["question"],
      counts: { admissions: 1, tools: 0 },
    };
    const worker = {
      taskId: "worker-1",
      workspaceId: "default",
      status: "input-required",
      origin: "agent",
      createdAt: at,
      updatedAt: at,
      needs: ["question"],
      ownNeeds: ["question"],
      counts: { admissions: 1, tools: 0 },
      rootTaskId: "root",
    };
    const { client, fake } = fakeClient((command, payload) => {
      if (command === "approvals")
        return { ok: true, result: { needs: [question("wait-1", "worker-1", "Which source?")], handoffs: [], truncated: false } };
      return { ok: true, result: { action: "list", rows: "needs" in (payload as object) ? [root, worker] : [root], truncated: false } };
    });
    const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "list" });
    await store.loadWorkerNeeds("root");
    const reads = () => fake.requests.filter((request) => request.command === "approvals").length;
    expect(reads()).toBe(1);
    await store.loadSessions();
    await settle();
    expect(store.getSnapshot().directory?.rows.map((row) => [row.taskId, row.needs])).toEqual([["root", ["question"]]]);
    expect(store.getSnapshot().directory?.needs.map((row) => row.taskId)).toEqual(["root"]);
    // The root's workers wait: read again with the list.
    expect(reads()).toBe(2);
    store.dispose();
  });
});

describe("a worker's approval", () => {
  const at = "2026-10-04T00:00:00.000Z";
  const approval = {
    approvalId: "approval-1",
    taskId: "worker-1",
    toolId: "sandbox.run",
    callId: "call-1",
    steps: 2,
    createdAt: at,
    workspaceId: "default",
    principalId: "operator",
    taskStatus: "waiting",
    allowedScopes: ["once"],
  };
  const need = { kind: "approval", needId: "approval:approval-1", taskId: "worker-1", askedAt: at, approval };
  const row = (descendantNeeds: string[]) => ({
    taskId: "root",
    workspaceId: "default",
    status: "completed",
    origin: "ipc",
    createdAt: at,
    updatedAt: at,
    needs: descendantNeeds,
    ownNeeds: [],
    descendantNeeds,
    counts: { admissions: 1, tools: 0 },
  });

  it("reaches its root chat, is read again with the list, and is decided at the worker's task", async () => {
    let open = true;
    const { client, fake } = fakeClient((command, payload) => {
      const asked = payload as { action?: string };
      if (command === "approvals" && asked.action === "needs")
        return { ok: true, result: { needs: open ? [need] : [], handoffs: [], truncated: false } };
      if (command === "approve") {
        open = false;
        return { ok: true, result: {} };
      }
      return { ok: true, result: { action: "list", rows: [row(open ? ["approval"] : [])], truncated: false } };
    });
    const store = createCanvasStore(client, { workspaceId: "default", principal: "operator", mintKey: () => "list" });
    await store.loadWorkerNeeds("root");
    expect(store.getSnapshot().workers?.["root"]?.approvals?.map((held) => held.approvalId)).toEqual(["approval-1"]);
    const reads = () => fake.requests.filter((request) => (request.payload as { action?: string }).action === "needs").length;
    await store.loadSessions();
    await settle();
    expect(reads()).toBe(2);
    store.decideWorkerRound("root", { key: "worker-1:2", taskId: "worker-1", steps: 2 }, { approved: true, scope: "once" });
    await settle();
    await settle();
    const decided = fake.requests.find((request) => request.command === "approve");
    expect(decided?.payload).toMatchObject({ taskId: "worker-1", expectedSteps: 2 });
    expect(store.getSnapshot().workers?.["root"]?.approvals).toEqual([]);
    store.dispose();
  });
});

describe("plugins' slash commands", () => {
  it("runs a listed command on the owner and shows its answer, and sends nothing to a model", async () => {
    const { client, fake } = fakeClient((command, payload) => {
      if (command !== "plugin-commands") return { ok: true, result: {} };
      return (payload as { action: string }).action === "list"
        ? { ok: true, result: { commands: [{ name: "tally", pluginId: "acme.tally", description: "Counts." }] } }
        : { ok: true, result: { text: "3 tool calls" } };
    });
    const store = createCanvasStore(client, options);
    fake.setState("ready");
    await settle();
    store.submit("/tally now");
    await settle();
    expect(fake.requests.filter((request) => request.command === "plugin-commands").map((request) => request.payload)).toEqual([
      { action: "list" },
      { action: "run", workspaceId: "default", name: "tally", args: "now" },
    ]);
    expect(fake.runs).toEqual([]);
    expect(store.getSnapshot().commandAnswer).toEqual({ name: "tally", text: "3 tool calls" });
    store.submit("/unknown-word");
    expect(fake.runs).toHaveLength(1);
  });

  it("offers the listed commands on the snapshot, and runs one against the chat in view", async () => {
    const { client, fake } = fakeClient((command, payload) => {
      if (command !== "plugin-commands") return { ok: true, result: {} };
      return (payload as { action: string }).action === "list"
        ? { ok: true, result: { commands: [{ name: "tally", pluginId: "acme.tally", description: "Counts." }] } }
        : { ok: true, result: { text: "3 tool calls" } };
    });
    const store = createCanvasStore(client, options);
    fake.setState("ready");
    await settle();
    expect(store.getSnapshot().pluginCommands).toEqual([{ name: "tally", pluginId: "acme.tally", description: "Counts." }]);
    store.submit("/tally", { viewing: "task-7" });
    store.submit("/tally", { viewing: undefined });
    await settle();
    expect(
      fake.requests
        .filter((request) => request.command === "plugin-commands")
        .map((request) => request.payload)
        .slice(1),
    ).toEqual([
      { action: "run", workspaceId: "default", name: "tally", args: "", taskId: "task-7" },
      { action: "run", workspaceId: "default", name: "tally", args: "" },
    ]);
    expect(fake.runs).toEqual([]);
  });

  it("lays a turn's status lines over the chat's earlier ones, and notes a line it cleared", async () => {
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, options);
    store.submit("count");
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.(event("plugin.status", { pluginId: "acme.tally", line: "1 call" }));
    expect(store.getSnapshot().runs.at(-1)?.pluginStatusSeen).toEqual(["acme.tally"]);
    expect(chatPluginStatus(store.getSnapshot().runs, "task-1")).toEqual({ "acme.tally": "1 call" });
    onEvent?.(event("plugin.status", { pluginId: "acme.tally" }));
    expect(store.getSnapshot().runs.at(-1)?.pluginStatusSeen).toEqual(["acme.tally"]);
    expect(chatPluginStatus(store.getSnapshot().runs, "task-1")).toEqual({});
    store.dispose();
  });

  it("takes a chat's lines off on a reconnect only when no stream follows it, and one plugin's when Settings turns it off", async () => {
    const { client, fake } = fakeClient();
    const store = createCanvasStore(client, options);
    store.submit("count");
    await settle();
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.(event("plugin.status", { pluginId: "acme.tally", line: "1 call" }));
    onEvent?.(event("plugin.status", { pluginId: "acme.todo", line: "2 left" }));
    // Followed through the drop: its stream resumes, and says what it missed.
    fake.setState("reconnecting");
    fake.setState("ready");
    expect(chatPluginStatus(store.getSnapshot().runs, "task-1")).toEqual({ "acme.tally": "1 call", "acme.todo": "2 left" });
    store.dropPluginStatus("acme.todo");
    expect(chatPluginStatus(store.getSnapshot().runs, "task-1")).toEqual({ "acme.tally": "1 call" });
    // The turn ended, so nothing follows the chat: a clear published while the page was away is unseen.
    onEvent?.(event("task.completed", { finalText: "done" }));
    fake.setState("reconnecting");
    fake.setState("ready");
    expect(chatPluginStatus(store.getSnapshot().runs, "task-1")).toEqual({});
    store.dispose();
  });

  it("takes the chat's earlier turns' lines off on a resync of its next turn", async () => {
    const record = {
      task: { status: "completed" },
      admissions: [{ kind: "start", operationKey: "op-0", state: "committed", result: { status: "completed" } }],
    };
    const { client, fake } = fakeClient((command) => (command === "tasks" ? { ok: true, result: record } : { ok: true, result: {} }));
    fake.queueRun({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", conversationId: "ui-1" } });
    const store = createCanvasStore(client, options);
    store.submit("count");
    await settle();
    const onEvent = fake.runs[0]?.options.onEvent;
    onEvent?.(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    onEvent?.(event("plugin.status", { pluginId: "acme.tally", line: "1 call" }));
    onEvent?.(event("task.completed", { finalText: "done" }));
    store.submit("again");
    await settle();
    await settle();
    // The earlier turn's line rides the chat until a later turn changes it.
    expect(chatPluginStatus(store.getSnapshot().runs, "task-1")).toEqual({ "acme.tally": "1 call" });
    fake.subscribes[0]?.options.onEvent({ ...event("resync.required", { reason: "the owner restarted" }), epoch: "epoch-2" });
    expect(chatPluginStatus(store.getSnapshot().runs, "task-1")).toEqual({});
    store.dispose();
  });

  it("sends a suggestion pressed as a prompt, even when it reads as a listed command", async () => {
    const { client, fake } = fakeClient((command, payload) =>
      command === "plugin-commands" && (payload as { action: string }).action === "list"
        ? { ok: true, result: { commands: [{ name: "tally", pluginId: "acme.tally", description: "Counts." }] } }
        : { ok: true, result: {} },
    );
    const store = createCanvasStore(client, options);
    fake.setState("ready");
    await settle();
    store.submit("/tally reset", { asPrompt: true });
    await settle();
    expect(fake.requests.filter((request) => request.command === "plugin-commands").map((request) => request.payload)).toEqual([
      { action: "list" },
    ]);
    expect(fake.runs.map((run) => (run.payload as { prompt: string }).prompt)).toEqual(["/tally reset"]);
    store.dispose();
  });

  it("lists the commands when the page first watches a store made on a connected client, as the page makes it", async () => {
    const { client, fake } = fakeClient((command, payload) =>
      command === "plugin-commands" && (payload as { action: string }).action === "list"
        ? { ok: true, result: { commands: [{ name: "remember", pluginId: "tavi.memory", description: "Remember." }] } }
        : { ok: true, result: { text: "Saved." } },
    );
    // `startPage` connects first, so no `ready` ever reaches this store.
    const store = createCanvasStore(client, options);
    const off = store.subscribe(() => undefined);
    store.subscribe(() => undefined)();
    await settle();
    expect(fake.requests.filter((request) => request.command === "plugin-commands").map((request) => request.payload)).toEqual([
      { action: "list" },
    ]);
    store.submit("/remember I prefer metric units");
    await settle();
    expect(fake.runs).toEqual([]);
    expect(store.getSnapshot().commandAnswer).toEqual({ name: "remember", text: "Saved." });
    off();
    store.dispose();
  });
});
