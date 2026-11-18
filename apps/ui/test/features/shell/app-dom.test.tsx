// @vitest-environment jsdom
import { initialRunState, type RunState } from "@tavi/client/browser";
import { matchChoiceAnswer, type TaskListRow } from "@tavi/contracts";
import axe from "axe-core";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ANNOUNCER_ID } from "../../../src/features/shell/a11y.js";
import { forgetChatBadges } from "../../../src/features/chat-panel/badges.js";
import { App } from "../../../src/App.js";
import { connectSheetReady } from "../../../src/features/apps/ConnectCard.js";
import { chatPartsReady } from "../../../src/features/shell/ChatMain.js";
import { panelTabsReady } from "../../../src/features/shell/ChatPanelView.js";
import { pageRoutesReady } from "../../../src/features/shell/PageRoute.js";
import { takeoverReady } from "../../../src/features/takeover/TakeoverOverlay.js";
import { Bar } from "../../../src/features/shell/Bar.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import type { CanvasRun, CanvasState, CanvasStore } from "../../../src/features/chat/store/types.js";
import { InWorkspace } from "../../support/workspace.js";
import { click, flush, mount, unmountAll } from "../../support/dom.js";

/**
 * The shell, composed. Every part of it is asserted on its
 * own elsewhere; what is asserted here is the seam — the inspector's default,
 * the tab title, the route switch, and the composer's wording when the
 * reader browses one session while another is the one a prompt would act on.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The pages beside the chat, and the chat's parts used later, are lazy chunks: fetched up front, every route renders in one pass.
beforeAll(() => Promise.all([pageRoutesReady(), panelTabsReady(), chatPartsReady(), takeoverReady(), connectSheetReady()]));

afterEach(() => {
  unmountAll();
  document.getElementById(ANNOUNCER_ID)?.remove();
  window.localStorage.clear();
  forgetChatBadges();
});

const run = (id: string, prompt: string, state: Partial<RunState>, extra: Partial<CanvasRun> = {}): CanvasRun => ({
  id,
  prompt,
  run: { ...initialRunState(), ...state },
  roundCalls: {},
  deciding: undefined,
  aborting: false,
  ...extra,
});

/** A store the test publishes into, with the calls it received. */
function fakeStore(initial: CanvasState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const submitted: string[] = [];
  /** What was sent as a prompt whatever its words (`asPrompt`): a suggestion pressed. */
  const asPrompts: string[] = [];
  /** What the shell asked the store to do, in order. */
  const acted: string[] = [];
  /** What the shell told the store of `chat.home`, in order. */
  const homes: boolean[] = [];
  /** The chats the shell asked the store to open. */
  const opened: string[] = [];
  const store: CanvasStore = {
    loadArtifacts: async () => undefined,
    reviewArtifacts: () => undefined,
    answerQuestion: () => undefined,
    loadWorkerNeeds: async () => undefined,
    answerWorker: () => undefined,
    decideWorkerRound: () => undefined,
    loadNotices: async () => undefined,
    replyToNotice: () => undefined,
    heartbeatTurn: () => undefined,
    loadSessions: async () => undefined,
    openTask: async (taskId) => void opened.push(taskId),
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit: (prompt, extra) => {
      submitted.push(prompt);
      if (extra?.asPrompt === true) asPrompts.push(prompt);
    },
    // As the store does: the next prompt now starts a chat of its own.
    newTask: () => {
      acted.push("newTask");
      state = { ...state, next: { kind: "new" } };
      for (const listener of [...listeners]) listener();
    },
    setHome: (on) => void homes.push(on),
    openHome: () => undefined,
    cancelQueued: () => undefined,
    rewind: async () => ({ ok: false as const, message: "" }),
    steerQueued: () => undefined,
    dropPluginStatus: () => undefined,
    loadEarlier: () => undefined,
    decide: (id, approved) => void acted.push(`decide ${id} ${String(approved)}`),
    abort: (id) => void acted.push(`abort ${id}`),
    setExpanded: () => undefined,
    dispose: () => undefined,
  };
  return {
    store,
    submitted,
    asPrompts,
    acted,
    homes,
    opened,
    publish: (next: CanvasState) => {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The chat list's rows for `runs`' tasks, as the owner would list them: the sidebar shows those. */
const listed = (runs: readonly CanvasRun[]): NonNullable<CanvasState["directory"]> => ({
  rows: [
    ...new Map(
      runs.flatMap((entry): [string, TaskListRow][] =>
        entry.run.taskId === undefined
          ? []
          : [
              [
                entry.run.taskId,
                {
                  taskId: entry.run.taskId,
                  workspaceId: "default",
                  status: "completed",
                  origin: "web",
                  title: entry.prompt,
                  createdAt: "2026-10-04T00:00:00Z",
                  updatedAt: "2026-10-04T00:00:00Z",
                  needs: [],
                  counts: { admissions: 1, tools: null },
                },
              ],
            ],
      ),
    ).values(),
  ],
  needs: [],
  needsTruncated: false,
  loading: false,
});

/** An owner that never answers: the model target's read stays open. */
const silent: SettingsClient = { request: () => new Promise<never>(() => undefined) };

/** The region `index.html` carries; the test stands it up as the page does. */
function announcer(): HTMLElement {
  const existing = document.getElementById(ANNOUNCER_ID);
  if (existing !== null) return existing;
  const region = document.createElement("p");
  region.id = ANNOUNCER_ID;
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  document.body.prepend(region);
  return region;
}

/** Every live region in the document, by id — by role as well as by attribute. */
const regions = (): string[] =>
  [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]')].map((node) => node.id);

describe("the shell", () => {
  it("opens with the chat panel shut to its rail, and opens it from there", async () => {
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    expect(page.querySelector(".canvas.with-chat-panel")).toBeNull();
    const toggle = page.querySelector(".chat-panel-rail .chat-panel-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(page.querySelector(".canvas.with-chat-panel")).not.toBeNull();
    expect(page.querySelector(".chat-panel .chat-panel-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(window.localStorage.getItem("tavi.chatpanel.open")).toBe("true");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Activity");
    await click(page.querySelector(".chat-panel .chat-panel-toggle"));
    expect(page.querySelector(".chat-panel-rail")).not.toBeNull();
    expect(document.activeElement).toBe(page.querySelector(".chat-panel-rail .chat-panel-toggle"));
  });

  it("opens the panel on a rail icon's tab, and moves between tabs with the arrow keys", async () => {
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval" })] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    await click(page.querySelector('.chat-panel-rail [aria-label="Details"]'));
    expect(page.querySelector(".chat-panel-status")?.textContent).toBe("needs you");
    const selected = () => page.querySelector('.chat-panel [role="tab"][aria-selected="true"]')?.getAttribute("aria-label");
    expect(selected()).toBe("Details");
    expect(page.querySelector('.chat-panel [role="tabpanel"]')?.textContent).toContain("task-1");
    await act(async () =>
      page.querySelector('.chat-panel [role="tablist"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(selected()).toBe("Activity");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Activity");
    expect(window.localStorage.getItem("tavi.chatpanel.tab")).toBe("activity");
  });

  it("counts what the chat waits on the reader for on the Activity icon, shut or open", async () => {
    const { store } = fakeStore({
      connection: "ready",
      runs: [
        run("ui-1", "p", {
          taskId: "task-1",
          status: "awaiting_approval",
          pending: [
            {
              taskId: "task-1",
              steps: 1,
              requests: [{ callId: "c1", toolName: "files.write", summary: "s", input: {}, approvalId: "a", effect: "read-only" }],
            },
          ],
        }),
      ],
    });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    expect(
      page
        .querySelector('.chat-panel-rail [aria-label="Activity, 1 new"]')
        ?.closest(".chat-panel-rail-item")
        ?.querySelector(".chat-panel-count")?.textContent,
    ).toBe("1");
    await click(page.querySelector(".chat-panel-rail .chat-panel-toggle"));
    expect(page.querySelector('.chat-panel [role="tab"][aria-label="Activity, 1 new"] .chat-panel-count')?.textContent).toBe("1");
    expect(page.querySelector('.chat-panel [role="tab"][aria-label="Details"] .chat-panel-count')).toBeNull();
  });

  it("folds the sessions sidebar when the docked panel would leave the transcript too narrow", async () => {
    const width = window.innerWidth;
    window.localStorage.setItem("tavi.chatpanel.open", "true");
    window.localStorage.setItem("tavi.chatpanel.width", "640");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1300 });
    try {
      const { store } = fakeStore({ connection: "ready", runs: [] });
      const page = await mount(<App store={store} client={silent} workspaceId="default" />);
      expect(page.querySelector(".chat-panel")).not.toBeNull();
      expect(page.querySelector(".sidebar-rail")).not.toBeNull();
      // Opened again, the sidebar stays, and the panel gives way to it.
      await click(page.querySelector(".sidebar-rail .sidebar-toggle"));
      expect(page.querySelector(".sidebar-rail")).toBeNull();
      expect(page.querySelector(".chat-panel")).toBeNull();
      expect(page.querySelector(".chat-panel-rail")).not.toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  });

  it("carries what needs the reader, the view and the chat in the tab title, and clears the count again", async () => {
    const { store, publish } = fakeStore({ connection: "ready", runs: [] });
    await mount(<App store={store} client={silent} workspaceId="default" />);
    // The count first, then the view and the chat in front of the reader.
    expect(document.title).toBe("Chat – tavi");
    await act(async () => publish({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval" })] }));
    expect(document.title).toBe("(1) Chat – p – tavi");
    await act(async () => publish({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "completed" })] }));
    expect(document.title).toBe("Chat – p – tavi");
  });

  it("switches between the chat and the settings route", async () => {
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    expect(page.querySelector(".composer")).not.toBeNull();
    const settings = [...page.querySelectorAll(".bar .view")].find((button) => button.textContent === "Settings");
    await click(settings);
    expect(page.querySelector(".settings-nav")).not.toBeNull();
    expect(page.textContent).toContain("Models");
    expect(page.querySelector(".composer")).toBeNull();
  });

  it("says in the composer that a prompt is queued while a chat is working, browsed or not", async () => {
    const runs = [
      run("ui-1", "the old one", { taskId: "task-1", status: "completed" }),
      run("ui-2", "the running one", { taskId: "task-2", status: "running" }),
    ];
    const { store } = fakeStore({ connection: "ready", runs, directory: listed(runs), next: { kind: "queue", taskId: "task-2" } });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    const placeholder = () => page.querySelector("textarea")?.getAttribute("placeholder")?.split("\n")[0];
    expect(placeholder()).toContain("Queue a message");
    const older = [...page.querySelectorAll(".session")].find((button) => button.textContent?.includes("the old one"));
    await click(older);
    expect(page.querySelector(".task-header")?.textContent).toContain("the old one");
    expect(placeholder()).toContain("Queue a message");
    // No sentence of its own above the composer.
    expect(page.textContent).not.toContain("the next prompt starts a new chat");
  });

  it("shows the working dots only while a turn runs with nothing waiting on the reader", async () => {
    const { store, publish } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "running" })] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    expect(page.querySelector(".run-working")).not.toBeNull();
    const round = {
      taskId: "task-1",
      steps: 1,
      requests: [
        {
          callId: "c1",
          toolName: "web_search",
          summary: "Approve web_search?",
          input: {},
          approvalId: "a-c1",
          effect: "external" as const,
        },
      ],
    };
    await act(async () =>
      publish({
        connection: "ready",
        runs: [run("ui-1", "p", { taskId: "task-1", status: "running", pending: [round] }, { roundCalls: { 1: ["c1"] } })],
      }),
    );
    expect(page.querySelector(".run-working")).toBeNull();
    await act(async () => publish({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "completed" })] }));
    expect(page.querySelector(".run-working")).toBeNull();
  });

  it("announces discrete events through the one region, and never the streamed text", async () => {
    const region = announcer();
    const { store, publish } = fakeStore({ connection: "ready", runs: [] });
    await mount(<App store={store} client={silent} workspaceId="default" />);
    expect(region.textContent).toBe("");
    await act(async () =>
      publish({
        connection: "ready",
        runs: [
          run("ui-1", "p", {
            taskId: "task-1",
            status: "running",
            transcript: [{ kind: "text", key: "t", attemptId: "a", blockId: "b", text: "half an answer" }],
          }),
        ],
      }),
    );
    // The status first, then the standing clauses the reader acts on.
    expect(region.textContent).toBe("Responding.");
    await act(async () =>
      publish({
        connection: "ready",
        runs: [
          run("ui-1", "p", {
            taskId: "task-1",
            status: "waiting",
            waiting: { on: "a reply", deadlineAt: "2026-09-20T00:00:00.000Z", question: "Which folder?" },
          }),
        ],
      }),
    );
    expect(region.textContent).toBe("A question is waiting: Which folder? 1 chat needs you.");
    // The chat has exactly one live region, by role as well as by attribute:
    // several polite queues interleave, and an alert beside them preempts both.
    expect(regions()).toEqual([ANNOUNCER_ID]);
  });

  it("keeps to one live region even with an approval pending and the connection gone", async () => {
    announcer();
    const { store, publish } = fakeStore({ connection: "ready", runs: [] });
    await mount(<App store={store} client={silent} workspaceId="default" />);
    await act(async () =>
      publish({
        connection: "closed",
        failure: "the bridge refused this page's session",
        runs: [
          run("ui-1", "p", {
            taskId: "task-1",
            status: "awaiting_approval",
            pending: [
              {
                taskId: "task-1",
                steps: 1,
                requests: [{ callId: "c1", toolName: "t", summary: "s", input: {}, approvalId: "a", effect: "read-only" }],
              },
            ],
          }),
        ],
      }),
    );
    expect(regions()).toEqual([ANNOUNCER_ID]);
  });

  it("leaves the settings views their own notices, which are not the session's", async () => {
    announcer();
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    await click([...page.querySelectorAll(".bar .view")].find((button) => button.textContent === "Settings"));
    // The one region is still the page's only *session* region. The settings
    // views each announce their own action's result beside the control that
    // caused it, which the announcer's rule — about the streaming transcript —
    // does not cover.
    expect(regions()).toContain(ANNOUNCER_ID);
    const theirs = regions().filter((id) => id !== ANNOUNCER_ID);
    expect(theirs.length, `settings regions: ${theirs.length}`).toBeLessThanOrEqual(2);
  });

  it("does not rewrite the region when the sentence has not changed", async () => {
    const region = announcer();
    const going = (text: string) =>
      run("ui-1", "p", {
        taskId: "task-1",
        status: "running",
        transcript: [{ kind: "text", key: "t", attemptId: "a", blockId: "b", text }],
      });
    const { store, publish } = fakeStore({ connection: "ready", runs: [going("a")] });
    await mount(<App store={store} client={silent} workspaceId="default" />);
    let writes = 0;
    const observer = new MutationObserver(() => (writes += 1));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    // Two more deltas of the same running turn: the sentence is still "Responding."
    await act(async () => publish({ connection: "ready", runs: [going("ab")] }));
    await act(async () => publish({ connection: "ready", runs: [going("abc")] }));
    observer.disconnect();
    expect(writes).toBe(0);
  });

  it("shows the Cmd+/ sheet, promising the chords it binds and only offering the browser's", async () => {
    const { store, acted } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    expect(page.querySelector(".sheet")).toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", metaKey: true, bubbles: true })));
    const sheet = page.querySelector(".sheet");
    expect(sheet).not.toBeNull();
    expect(sheet?.closest("dialog")).not.toBeNull();
    // Keycaps that still read as the chord.
    expect([...(sheet?.querySelectorAll(".chord") ?? [])].map((chord) => chord.textContent)).toEqual(
      expect.arrayContaining(["Cmd+Alt+Enter", "Esc"]),
    );
    // The browser's own keys are buttons here, not promises.
    expect(sheet?.textContent).toContain("New chat");
    expect(sheet?.textContent).not.toContain("Cmd+Shift+O");
    await click([...(sheet?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "New chat"));
    expect(acted).toContain("newTask");
    expect(page.querySelector(".sheet")).toBeNull();
  });

  it("gives the sheet focus, takes Escape for it, and gives focus back", async () => {
    const { store, acted } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "running" })] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    // The header's keyboard icon: reachable without the chord at all (the browser may take Cmd+/). It shows no
    // words, so its name is its own (WCAG 2.5.3 asks nothing of an icon), with the chord in aria-keyshortcuts.
    const help = page.querySelector<HTMLButtonElement>(".bar .bar-keys");
    expect(help).not.toBeNull();
    expect(help?.getAttribute("aria-label")).toBe("Keyboard shortcuts");
    expect(help?.getAttribute("aria-keyshortcuts")).toBe("Meta+/");
    await click(help);
    const dialog = page.querySelector("dialog.modal");
    expect(dialog?.querySelector(".sheet")).not.toBeNull();
    expect(page.querySelector(`#${CSS.escape(dialog?.getAttribute("aria-labelledby") ?? "")}`)?.textContent).toBe("Keyboard");
    // Focus starts on the ×, not on an offered action an Enter would run.
    expect(document.activeElement).toBe(dialog?.querySelector(".modal-head button"));
    // Escape is the dialog's: it does not cancel the turn behind the sheet,
    // and the dialog's `cancel` (what the browser fires for it) closes it.
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(acted).toEqual([]);
    await act(async () => dialog?.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(page.querySelector(".sheet")).toBeNull();
    // Opened again, its own chord closes it too — from the header's × as well.
    await click(help);
    expect(document.activeElement?.closest(".modal-head")).not.toBeNull();
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "/", metaKey: true, bubbles: true })));
    expect(page.querySelector(".sheet")).toBeNull();
    expect(acted).toEqual([]);
    // And with the sheet gone, Escape stops the turn again.
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(acted).toEqual(["abort ui-1"]);
  });

  it("leaves the browser's own chords alone, and an Escape an input method is using", async () => {
    const { store, acted } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "running" })] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    for (const init of [
      { key: "O", metaKey: true, shiftKey: true },
      { key: ".", metaKey: true },
      { key: "M", metaKey: true, shiftKey: true },
      { key: "k", metaKey: true },
    ]) {
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true })));
    }
    expect(acted).toEqual([]);
    expect(page.querySelector(".sheet")).toBeNull();
    // Escape while composing belongs to the candidate window, not to the page.
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
    expect(acted).toEqual([]);
  });

  it("sends the instructions drafted in the panel with a new chat's first message, then clears the draft", async () => {
    window.localStorage.setItem("tavi.chatpanel.open", "true");
    window.localStorage.setItem("tavi.chatpanel.tab", "instructions");
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const sent: unknown[] = [];
    const spied = { ...store, submit: (prompt: string, extra?: { readonly chatInstructions?: string }) => void sent.push([prompt, extra]) };
    const client = { request: () => new Promise<never>(() => undefined), features: ["chat-context"] } as unknown as SettingsClient;
    const page = await mount(<App store={spied} client={client} workspaceId="default" />);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    const draft = page.querySelector(".chat-panel-editor textarea");
    await act(async () => {
      setter?.call(draft, "Answer in French.");
      draft?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const box = page.querySelector(".composer textarea");
    await act(async () => {
      setter?.call(box, "audit the site");
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(page.querySelector(".composer button[type=submit]"));
    expect(sent).toEqual([["audit the site", { chatInstructions: "Answer in French." }]]);
    expect((page.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("offers Chat files on an empty chat, and its first message carries the folders picked there, then clears them", async () => {
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const sent: unknown[] = [];
    const spied = { ...store, submit: (prompt: string, extra?: unknown) => void sent.push([prompt, extra]) };
    const asked: string[] = [];
    const token = "tok0000000000007";
    const client = {
      features: ["folder", "browse"],
      request: async (command: string) => {
        asked.push(command);
        return command === "browse"
          ? { ok: true, result: { entries: [{ token, name: "photos", path: "/home/me/photos", opens: false }], truncated: false } }
          : new Promise<never>(() => undefined);
      },
    } as unknown as SettingsClient;
    const page = await mount(<App store={spied} client={client} workspaceId="default" />);
    const chip = () => page.querySelector<HTMLButtonElement>(".folder-chip");
    expect(chip()?.textContent).toBe("Chat files");
    await click(chip());
    const named = (label: string) =>
      [...page.querySelectorAll("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
    await click(named("Attach a folder…"));
    await flush(4, 0);
    expect(named("Work in this folder: photos")).toBeUndefined();
    await click(named("Attach read-write: photos"));
    expect(chip()?.textContent).toBe("Chat files +1");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    const box = page.querySelector(".composer textarea");
    await act(async () => {
      setter?.call(box, "sort my photos");
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(page.querySelector(".composer button[type=submit]"));
    expect(sent).toEqual([["sort my photos", { folderAttachments: [{ folder: { pick: token }, mode: "rw" }] }]]);
    expect(chip()?.textContent).toBe("Chat files");
    // No chat yet, so nothing was asked of a chat's folder: the picker's browse only.
    expect(asked.filter((command) => command === "folder")).toEqual([]);
  });

  it("keeps the prompt and the draft when the draft is too long to send, and opens it", async () => {
    window.localStorage.setItem("tavi.chatpanel.open", "true");
    window.localStorage.setItem("tavi.chatpanel.tab", "instructions");
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const sent: unknown[] = [];
    const spied = { ...store, submit: (prompt: string) => void sent.push(prompt) };
    const client = { request: () => new Promise<never>(() => undefined), features: ["chat-context"] } as unknown as SettingsClient;
    const page = await mount(<App store={spied} client={client} workspaceId="default" />);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    const draft = page.querySelector(".chat-panel-editor textarea");
    await act(async () => {
      setter?.call(draft, "x".repeat(8_001));
      draft?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const box = page.querySelector(".composer textarea") as HTMLTextAreaElement;
    await act(async () => {
      setter?.call(box, "audit the site");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(page.querySelector(".composer button[type=submit]"));
    expect(sent).toEqual([]);
    expect(box.value).toBe("audit the site");
    expect((page.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement).value).toHaveLength(8_001);
  });

  it("renames the open chat from the panel's header, then reads its name and the sessions again", async () => {
    window.localStorage.setItem("tavi.chatpanel.open", "true");
    const { store, acted } = fakeStore({
      connection: "ready",
      runs: [run("ui-1", "audit the site", { taskId: "task-1", status: "completed" })],
    });
    let title = "Generated title";
    let renamed = false;
    const sent: Record<string, unknown>[] = [];
    const loads: unknown[] = [];
    const watched = { ...store, loadSessions: async (...args: unknown[]) => void loads.push(args) };
    const client = {
      features: ["chat-context"],
      request: async (command: string, payload: Record<string, unknown>) => {
        sent.push({ command, ...payload });
        if (command === "chat-context" && payload["action"] === "rename") {
          title = (payload["title"] as string | null) ?? "Generated title";
          renamed = payload["title"] !== null;
        }
        if (command === "chat-context")
          return { ok: true, result: { taskId: "task-1", revision: 0, current: null, title, ...(renamed ? { renamed: true } : {}) } };
        if (command === "memory") return { ok: true, result: { records: [], otherPeople: [] } };
        return new Promise<never>(() => undefined);
      },
    } as unknown as SettingsClient;
    const page = await mount(<App store={watched} client={client} workspaceId="default" />);
    const settle = (): Promise<void> => flush(4, 0);
    await settle();
    expect(page.querySelector(".chat-panel-title h2")?.textContent).toBe("Generated title");
    await click(page.querySelector('.chat-panel-title [aria-label="Rename this chat"]'));
    const field = page.querySelector(".chat-panel-rename input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(field, "Site audit");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = loads.length;
    await act(async () => (page.querySelector(".chat-panel-rename") as HTMLFormElement).requestSubmit());
    await settle();
    expect(sent.find((entry) => entry["action"] === "rename")).toMatchObject({ taskId: "task-1", title: "Site audit" });
    expect(page.querySelector(".chat-panel-title h2")?.textContent).toBe("Site audit");
    expect(loads.slice(before)).toEqual([[undefined, false, true]]);
    // Escape leaves the name as it was; "Use the generated name" goes back.
    await click(page.querySelector('.chat-panel-title [aria-label="Rename this chat"]'));
    await act(async () =>
      page.querySelector(".chat-panel-rename input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(page.querySelector(".chat-panel-rename")).toBeNull();
    await click(page.querySelector('.chat-panel-title [aria-label="Rename this chat"]'));
    await click([...page.querySelectorAll(".chat-panel-rename button")].find((node) => node.textContent === "Use the generated name"));
    await settle();
    expect(sent.filter((entry) => entry["action"] === "rename").at(-1)).toMatchObject({ title: null });
    expect(page.querySelector(".chat-panel-title h2")?.textContent).toBe("Generated title");
    expect(acted).toEqual([]);
  });

  it("reads the session list again after the panel saves a chat's instructions", async () => {
    window.localStorage.setItem("tavi.chatpanel.open", "true");
    window.localStorage.setItem("tavi.chatpanel.tab", "instructions");
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "audit", { taskId: "task-1", status: "completed" })] });
    const loads: unknown[] = [];
    let revision = 0;
    const watched = { ...store, loadSessions: async (...args: unknown[]) => void loads.push(args) };
    const client = {
      features: ["chat-context"],
      request: async (command: string, payload: Record<string, unknown>) => {
        if (command === "chat-context" && payload["action"] === "set") revision += 1;
        if (command === "chat-context")
          return {
            ok: true,
            result: {
              taskId: "task-1",
              revision,
              current:
                revision === 0
                  ? null
                  : { taskId: "task-1", revision, text: "Be brief.", author: "operator:ui", recordedAt: "2026-10-01T00:00:00.000Z" },
            },
          };
        if (command === "memory") return { ok: true, result: { records: [], otherPeople: [] } };
        return new Promise<never>(() => undefined);
      },
    } as unknown as SettingsClient;
    const page = await mount(<App store={watched} client={client} workspaceId="default" />);
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    const field = page.querySelector(".chat-panel-editor textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(field, "Be brief.");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = loads.length;
    await click([...page.querySelectorAll(".chat-panel-editor button")].find((node) => node.textContent === "Save"));
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    expect(loads.slice(before)).toEqual([[undefined, false, true]]);
  });

  it("reads the session list again after the panel adds a chat note", async () => {
    window.localStorage.setItem("tavi.chatpanel.open", "true");
    window.localStorage.setItem("tavi.chatpanel.tab", "memory");
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "audit", { taskId: "task-1", status: "completed" })] });
    const loads: unknown[] = [];
    const watched = { ...store, loadSessions: async (...args: unknown[]) => void loads.push(args) };
    const added = {
      recordId: "n1",
      kind: "fact",
      scope: { kind: "run_local", principalId: "operator", workspaceId: "default", runId: "task-1" },
      scopeKey: "k",
      currentRevisionId: "r",
      status: "approved",
      sensitivity: "normal",
      revocationGeneration: 0,
      recordedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      target: "chat:task-1",
      title: null,
      body: "Ship Friday",
      redacted: false,
      truncated: false,
      sourceCount: 0,
      durable: true,
    };
    const client = {
      features: ["chat-context"],
      request: async (command: string, payload: Record<string, unknown>) =>
        command === "chat-context"
          ? { ok: true, result: { taskId: "task-1", revision: 0, current: null } }
          : command === "memory" && payload["action"] === "remember"
            ? { ok: true, result: added }
            : command === "memory"
              ? { ok: true, result: { records: [], otherPeople: [] } }
              : new Promise<never>(() => undefined),
    } as unknown as SettingsClient;
    const page = await mount(<App store={watched} client={client} workspaceId="default" />);
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    const input = page.querySelector(".chat-panel-add input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "Ship Friday");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = loads.length;
    await act(async () => (page.querySelector(".chat-panel-add") as HTMLFormElement).requestSubmit());
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    expect(loads.slice(before)).toEqual([[undefined, false, true]]);
  });

  it("drops a rename begun on one chat when another opens", async () => {
    window.localStorage.setItem("tavi.chatpanel.open", "true");
    const runs = [
      run("ui-1", "first chat", { taskId: "task-1", status: "completed" }),
      run("ui-2", "second chat", { taskId: "task-2", status: "completed" }),
    ];
    const fake = fakeStore({ connection: "ready", runs, directory: listed(runs) });
    const client = { features: ["chat-context"], request: () => new Promise<never>(() => undefined) } as unknown as SettingsClient;
    const page = await mount(<App store={fake.store} client={client} workspaceId="default" />);
    await click(page.querySelector('.chat-panel-title [aria-label="Rename this chat"]'));
    expect(page.querySelector(".chat-panel-rename")).not.toBeNull();
    await click([...page.querySelectorAll(".session")].find((button) => button.textContent?.includes("first chat")));
    expect(page.querySelector(".chat-panel-rename")).toBeNull();
  });

  it("asks an owner without chat-context nothing new: its Memory and Instructions tabs stay read-only", async () => {
    window.localStorage.setItem("tavi.chatpanel.open", "true");
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "completed" })] });
    const asked: { command: string; payload: Record<string, unknown> }[] = [];
    const client = {
      features: ["memory", "system-prompt"],
      request: (command: string, payload: Record<string, unknown>) => {
        asked.push({ command, payload });
        return new Promise<never>(() => undefined);
      },
    } as unknown as SettingsClient;
    const page = await mount(<App store={store} client={client} workspaceId="default" />);
    await click(page.querySelector('.chat-panel [role="tab"][aria-label="Memory"]'));
    await click(page.querySelector('.chat-panel [role="tab"][aria-label="Instructions"]'));
    expect(asked.some((entry) => entry.command === "chat-context")).toBe(false);
    expect(asked.some((entry) => entry.payload["taskId"] !== undefined && entry.command === "system-prompt")).toBe(false);
    expect(
      asked.some(
        (entry) => entry.command === "memory" && (entry.payload["scopes"] !== undefined || entry.payload["originTaskId"] !== undefined),
      ),
    ).toBe(false);
    expect(page.querySelector(".chat-panel-editor")).toBeNull();
  });

  it("marks instructions changed since the reader last looked, and counts the notes proposed for it, while the panel is open", async () => {
    window.localStorage.setItem("tavi.chatpanel.open", "true");
    // Last looked at before any instructions: revision 1 is new to the reader.
    window.localStorage.setItem("tavi.chatpanel.seen", JSON.stringify({ "task-1": 0 }));
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "completed" })] });
    const proposed = {
      recordId: "n1",
      kind: "fact",
      scope: { kind: "run_local", principalId: "operator", workspaceId: "default", runId: "task-1" },
      scopeKey: "k",
      status: "proposed",
      sensitivity: "normal",
      revocationGeneration: 0,
      recordedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      target: "chat:task-1",
      title: null,
      body: "note",
      redacted: false,
      truncated: false,
      sourceCount: 0,
      durable: true,
    };
    const client = {
      features: ["chat-context"],
      request: async (command: string, payload: Record<string, unknown>) =>
        command === "chat-context"
          ? {
              ok: true,
              result: {
                taskId: "task-1",
                revision: 1,
                current: {
                  taskId: "task-1",
                  revision: 1,
                  text: "Be brief.",
                  author: "operator:ui",
                  recordedAt: "2026-10-01T00:00:00.000Z",
                },
              },
            }
          : command === "memory" && Array.isArray(payload["scopes"])
            ? { ok: true, result: { records: [proposed], otherPeople: [] } }
            : // What its cards proposed for every chat: the same note, counted once.
              command === "memory" && payload["originTaskId"] === "task-1"
              ? { ok: true, result: { records: [proposed], otherPeople: [] } }
              : new Promise<never>(() => undefined),
    } as unknown as SettingsClient;
    const page = await mount(<App store={store} client={client} workspaceId="default" />);
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    expect(page.querySelector('.chat-panel [aria-label="Instructions, changed"] .chat-panel-dot')).not.toBeNull();
    expect(page.querySelector('.chat-panel [aria-label="Memory, 1 new"] .chat-panel-count')?.textContent).toBe("1");
    // Looking at the tab catches up, and the mark goes.
    await click(page.querySelector('.chat-panel [role="tab"][aria-label="Instructions, changed"]'));
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    expect(page.querySelector('.chat-panel [aria-label="Instructions"] .chat-panel-dot')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("tavi.chatpanel.seen") ?? "{}")).toEqual({ "task-1": 1 });
  });

  it("asks the owner nothing for the chat panel while it is shut, and reads it once it opens", async () => {
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "completed" })] });
    const asked: string[] = [];
    const client = {
      features: ["chat-context"],
      request: async (command: string) => {
        asked.push(command);
        return command === "chat-context"
          ? { ok: true, result: { taskId: "task-1", revision: 0, current: null } }
          : command === "memory"
            ? { ok: true, result: { records: [], otherPeople: [] } }
            : new Promise<never>(() => undefined);
      },
    } as unknown as SettingsClient;
    const page = await mount(<App store={store} client={client} workspaceId="default" />);
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    const panelCalls = () => asked.filter((command) => command === "chat-context" || command === "memory" || command === "system-prompt");
    expect(panelCalls()).toEqual([]);
    await click(page.querySelector(".chat-panel-rail .chat-panel-toggle"));
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    expect(panelCalls()).toContain("chat-context");
  });

  it("only notes where a chat stands the first time it is read, marking nothing", async () => {
    window.localStorage.setItem("tavi.chatpanel.open", "true");
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "completed" })] });
    const client = {
      features: ["chat-context"],
      request: async (command: string) =>
        command === "chat-context"
          ? {
              ok: true,
              result: {
                taskId: "task-1",
                revision: 3,
                current: {
                  taskId: "task-1",
                  revision: 3,
                  text: "Be brief.",
                  author: "operator:cli",
                  recordedAt: "2026-10-01T00:00:00.000Z",
                },
              },
            }
          : command === "memory"
            ? { ok: true, result: { records: [], otherPeople: [] } }
            : new Promise<never>(() => undefined),
    } as unknown as SettingsClient;
    const page = await mount(<App store={store} client={client} workspaceId="default" />);
    for (let index = 0; index < 4; index += 1) await act(async () => undefined);
    expect(page.querySelector('.chat-panel [aria-label="Instructions"] .chat-panel-dot')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("tavi.chatpanel.seen") ?? "{}")).toEqual({ "task-1": 3 });
  });

  it("keeps focus in the composer when the send is a click on Send", async () => {
    const { store, submitted } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    const box = page.querySelector("textarea");
    const send = page.querySelector(".composer button[type=submit]");
    // Always focusable and in the tab order: empty, it is marked unavailable, not disabled.
    expect(send?.hasAttribute("disabled")).toBe(false);
    expect(send?.getAttribute("aria-disabled")).toBe("true");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(box, "tidy the inbox");
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    (send as HTMLElement | null)?.focus();
    expect(document.activeElement).toBe(send);
    await click(send);
    expect(submitted).toEqual(["tidy the inbox"]);
    // The control that was activated did not disable itself out from under the reader.
    expect(document.activeElement).toBe(box);
  });

  it("stops a running turn on Esc, and decides a waiting round only on its awkward chord", async () => {
    const round = {
      taskId: "task-1",
      steps: 1,
      requests: [{ callId: "c1", toolName: "t", summary: "s", input: {}, approvalId: "a", effect: "read-only" }],
    };
    const { store, acted, publish } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "running" })] });
    await mount(<App store={store} client={silent} workspaceId="default" />);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(acted).toEqual(["abort ui-1"]);
    await act(async () =>
      publish({
        connection: "ready",
        runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval", pending: [round] }, { roundCalls: { 1: ["c1"] } })],
      }),
    );
    // Enter alone never approves, nor does Cmd+Enter.
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    expect(acted).toEqual(["abort ui-1"]);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, altKey: true, bubbles: true })));
    expect(acted).toEqual(["abort ui-1", "decide ui-1 true"]);
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", metaKey: true, altKey: true, bubbles: true })),
    );
    expect(acted).toEqual(["abort ui-1", "decide ui-1 true", "decide ui-1 false"]);
  });

  it("hides and shows the sessions on Cmd+Shift+S", async () => {
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    expect(page.querySelector(".sidebar")).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "S", metaKey: true, shiftKey: true, bubbles: true })));
    expect(page.querySelector(".sidebar")).toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, shiftKey: true, bubbles: true })));
    expect(page.querySelector(".sidebar")).not.toBeNull();
  });

  it("keeps focus in the composer across a send and the stream that follows", async () => {
    const { store, publish, submitted } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    const box = page.querySelector("textarea");
    expect(box).not.toBeNull();
    box?.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(box, "tidy the inbox");
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => box?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(submitted).toEqual(["tidy the inbox"]);
    expect(document.activeElement).toBe(box);
    // And a streaming update does not take it away.
    await act(async () =>
      publish({
        connection: "ready",
        runs: [
          run("ui-1", "tidy the inbox", {
            taskId: "task-1",
            status: "running",
            transcript: [{ kind: "text", key: "t", attemptId: "a", blockId: "b", text: "working" }],
          }),
        ],
      }),
    );
    expect(document.activeElement).toBe(box);
  });

  it("labels every turn for a screen reader to search by", async () => {
    const { store } = fakeStore({
      connection: "ready",
      runs: [
        run("ui-1", "tidy the inbox", {
          taskId: "task-1",
          status: "awaiting_approval",
          transcript: [
            { kind: "text", key: "t", attemptId: "a", blockId: "b", text: "an answer" },
            { kind: "tool", key: "c1", attemptId: "a", callId: "c1", toolName: "mail.send", status: "completed" },
          ],
          pending: [
            {
              taskId: "task-1",
              steps: 1,
              requests: [{ callId: "c2", toolName: "files.delete", summary: "delete it", input: {}, approvalId: "a" }],
            },
          ],
        }),
      ],
    });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    const labels = [...page.querySelectorAll(".visually-hidden")].map((node) => node.textContent);
    expect(labels).toContain("you: ");
    expect(labels).toContain("assistant: ");
    expect(labels).toContain("tool: ");
    expect(labels).toContain("permission required: ");
  });

  it("shows what plugins suggest under a finished turn as buttons that send it, and none under a running one", async () => {
    const finished = run("ui-1", "plan the trip", {
      taskId: "task-1",
      status: "completed",
      suggestions: ["Book the hotel", "/tally reset"],
    });
    const { store, submitted, asPrompts, publish } = fakeStore({ connection: "ready", runs: [finished] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    const group = page.querySelector('[role="group"][aria-label="Suggested next"]');
    expect([...(group?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual(["Book the hotel", "/tally reset"]);
    await click(group?.querySelectorAll("button")[1]);
    // A prompt, even one that reads as a plugin's slash command: the store runs no command for it.
    expect(submitted).toEqual(["/tally reset"]);
    expect(asPrompts).toEqual(["/tally reset"]);
    // Offline, they cannot be sent.
    publish({ connection: "reconnecting", runs: [finished] });
    await act(async () => undefined);
    expect(
      [...(page.querySelector('[aria-label="Suggested next"]')?.querySelectorAll("button") ?? [])].every((button) =>
        button.hasAttribute("disabled"),
      ),
    ).toBe(true);
    // A turn still running suggests nothing yet.
    publish({
      connection: "ready",
      runs: [run("ui-1", "plan the trip", { taskId: "task-1", status: "running", suggestions: ["Book the hotel"] })],
    });
    await act(async () => undefined);
    expect(page.querySelector('[aria-label="Suggested next"]')).toBeNull();
  });

  it("keeps a plugin's status line across the chat's turns until a later turn clears it", async () => {
    const first = run(
      "ui-1",
      "plan the trip",
      { taskId: "task-1", status: "completed", pluginStatus: { "acme.tally": "3 calls" } },
      { pluginStatusSeen: ["acme.tally"] },
    );
    const second = run("ui-2", "and then?", { taskId: "task-1", status: "running" }, { continues: "task-1" });
    const { store, publish } = fakeStore({ connection: "ready", runs: [first, second] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    expect(page.querySelector(".task-header")?.textContent).toContain("3 calls");
    // The newer turn cleared it: a `plugin.status` with no line.
    const cleared = run(
      "ui-2",
      "and then?",
      { taskId: "task-1", status: "running" },
      { continues: "task-1", pluginStatusSeen: ["acme.tally"] },
    );
    await act(async () => publish({ connection: "ready", runs: [first, cleared] }));
    expect(page.querySelector(".task-header")?.textContent).not.toContain("3 calls");
  });

  it("lists the plugins' commands while a slash word is typed, and fills the box with the one picked", async () => {
    const commands = [
      { name: "tally", pluginId: "acme.tally", description: "Counts the tool calls." },
      { name: "todo", pluginId: "acme.todo", description: "Shows the plan." },
      { name: "weather", pluginId: "acme.weather", description: "Forecasts." },
    ];
    const { store, submitted } = fakeStore({ connection: "ready", runs: [], pluginCommands: commands });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    const box = page.querySelector<HTMLTextAreaElement>(".composer textarea");
    const typeInto = async (text: string) =>
      act(async () => {
        setter?.call(box, text);
        box?.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const offered = () => [...page.querySelectorAll('[aria-label="Plugin commands"] button')].map((button) => button.textContent);
    expect(page.querySelector('[aria-label="Plugin commands"]')).toBeNull();
    await typeInto("/t");
    expect(offered()).toEqual(["/tally Counts the tool calls.", "/todo Shows the plan."]);
    // A prompt that does not start with a slash, or past the word, lists none.
    await typeInto("tally");
    expect(offered()).toEqual([]);
    await typeInto("/to");
    await click(page.querySelector('[aria-label="Plugin commands"] button'));
    expect(box?.value).toBe("/todo ");
    expect(offered()).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it("keeps the chat the reader picked when another chat's prompt arrives", async () => {
    const first = [run("ui-1", "first", { taskId: "task-1", status: "completed" })];
    const { store, publish } = fakeStore({ connection: "ready", runs: first, directory: listed(first) });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    await click(page.querySelector(".session"));
    expect(page.querySelector(".session.current")?.textContent).toContain("first");
    // A second prompt arrives, in a chat of its own.
    const both = [
      run("ui-1", "first", { taskId: "task-1", status: "running" }),
      run("ui-2", "second", { taskId: "task-2", status: "running" }),
    ];
    await act(async () => publish({ connection: "ready", runs: both, directory: listed(both) }));
    // The reader's choice survives the re-keying rather than jumping to the newest.
    expect(page.querySelector(".session.current")?.textContent).toContain("first");
    expect(page.querySelector(".task-header")?.textContent).toContain("first");
  });
});

describe("shell regressions", () => {
  it("keeps a draft when the approval chord bubbles from its textarea", async () => {
    const round = {
      taskId: "task-1",
      steps: 1,
      requests: [{ callId: "c1", toolName: "t", summary: "s", input: {}, approvalId: "a", effect: "read-only" }],
    };
    const { store, acted, submitted } = fakeStore({
      connection: "ready",
      runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval", pending: [round] }, { roundCalls: { 1: ["c1"] } })],
    });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    const box = page.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, "keep this draft");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, altKey: true, bubbles: true })));
    expect(acted).toEqual(["decide ui-1 true"]);
    expect(submitted).toEqual([]);
    expect(box.value).toBe("keep this draft");
    await click(page.querySelector(".bar .bar-keys"));
    expect(page.querySelector(".sheet")).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, altKey: true, bubbles: true })));
    expect(acted).toEqual(["decide ui-1 true"]);
  });

  it("offers Stop, terminal Retry, and a focusable unavailable Send", async () => {
    const { store, acted, submitted, publish } = fakeStore({
      connection: "ready",
      runs: [run("ui-1", "try again", { taskId: "task-1", status: "running" })],
    });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    expect(page.querySelector(".composer button[type=submit]")?.textContent).toBe("Stop");
    await click(page.querySelector(".composer button[type=submit]"));
    expect(acted).toEqual(["abort ui-1"]);
    await act(async () => publish({ connection: "ready", runs: [run("ui-1", "try again", { taskId: "task-1", status: "failed" })] }));
    expect(page.querySelector(".composer button[type=submit]")?.textContent).toBe("Retry");
    await click(page.querySelector(".composer button[type=submit]"));
    expect(submitted).toEqual(["try again"]);
    // Retried in the same chat, not in a new one.
    expect(acted).not.toContain("newTask");
    await act(async () => publish({ connection: "closed", runs: [] }));
    const send = page.querySelector<HTMLButtonElement>(".composer button[type=submit]")!;
    expect(send.disabled).toBe(false);
    expect(send.getAttribute("aria-disabled")).toBe("true");
  });

  it("says a stopped turn calmly, with no code and no Retry", async () => {
    const { store } = fakeStore({
      connection: "ready",
      runs: [
        run("ui-1", "try again", {
          taskId: "task-1",
          status: "stopped",
          outcome: { kind: "stopped", message: "You stopped this." },
        }),
      ],
    });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    expect(page.querySelector(".composer button[type=submit]")?.textContent).toBe("Send");
    const said = page.textContent ?? "";
    expect(said).toContain("You stopped this.");
    expect(said).not.toContain("STOPPED");
    expect(said).not.toContain("Failed");
    expect(page.querySelector(".failure")).toBeNull();
  });

  it("rereads the target after returning directly from Settings to Chat", async () => {
    let target = "old";
    const client: SettingsClient = {
      request: async (command, payload) => {
        const action = (payload as { action?: string }).action;
        if (action === "roles")
          return { ok: true, result: { resolved: [], bindings: [], workspaceDefault: { target: { connectionId: target } } } };
        if (command === "channels") return { ok: true, result: action === "catalog" ? { channels: [] } : { connections: [] } };
        return { ok: true, result: [] };
      },
    };
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={client} workspaceId="default" />);
    expect(page.querySelector(".model-picker")?.textContent).toContain("old");
    await click([...page.querySelectorAll(".bar .view")].find((button) => button.textContent === "Settings"));
    target = "new";
    await click([...page.querySelectorAll(".bar .view")].find((button) => button.textContent === "Chat"));
    expect(page.querySelector(".model-picker")?.textContent).toContain("new");
  });
});

it("opens history rows, clears unread on view, and archives a chat that needs you out of the list", async () => {
  const row = {
    taskId: "old",
    workspaceId: "default",
    status: "input-required" as const,
    origin: "ipc" as const,
    title: "Old question",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2026-09-20T00:00:00Z",
    needs: ["question" as const],
    counts: { admissions: 1, tools: null },
  };
  const fake = fakeStore({
    connection: "ready",
    runs: [run("live", "Old question", { taskId: "old", status: "waiting" })],
    directory: { rows: [row], needs: [row], needsTruncated: false, loading: false },
  });
  const opened: string[] = [];
  const page = await mount(
    <App
      store={{
        ...fake.store,
        openTask: async (id) => {
          opened.push(id);
        },
      }}
      client={silent}
      workspaceId="default"
    />,
  );
  expect(page.textContent).toContain("Keyword search");
  expect(page.textContent).toContain("Needs you");
  expect(page.querySelector('[aria-label="unread"]')).toBeNull();
  await click(page.querySelector(".session"));
  expect(opened).toEqual(["old"]);
  await click([...page.querySelectorAll(".sidebar button")].find((button) => button.getAttribute("aria-label") === "Archive Old question"));
  expect(page.querySelector(".session")).toBeNull();
  await click([...page.querySelectorAll(".sidebar button")].find((button) => button.textContent === "Archived"));
  expect(page.querySelector(".session")?.textContent).toContain("Old question");
  await click(page.querySelector('[aria-label="Pin Old question"]'));
  expect(page.querySelector('[aria-label="Unpin Old question"]')).not.toBeNull();
  window.localStorage.removeItem("tavi.sessions");
});

it("marks a session that keeps its own instructions or notes", async () => {
  const base = {
    workspaceId: "default",
    status: "completed" as const,
    origin: "ipc" as const,
    createdAt: "2026-09-29T00:00:00Z",
    updatedAt: "2026-09-29T00:00:00Z",
    needs: [],
    counts: { admissions: 1, tools: null },
  };
  const rows = [
    { ...base, taskId: "a", title: "With both", chatInstructions: true as const, chatNotes: 2 },
    { ...base, taskId: "b", title: "Plain" },
  ];
  const fake = fakeStore({ connection: "ready", runs: [], directory: { rows, needs: [], needsTruncated: false, loading: false } });
  const page = await mount(<App store={fake.store} client={silent} workspaceId="default" />);
  const session = (title: string) => [...page.querySelectorAll(".session")].find((node) => node.textContent?.includes(title));
  expect(session("With both")?.querySelector('[aria-label="has its own instructions"]')).not.toBeNull();
  expect(session("With both")?.querySelector('[aria-label="2 chat notes"]')?.textContent).toBe("2");
  expect(session("Plain")?.querySelector(".session-marks")).toBeNull();
});

it("takes the sessions panel's pins and archive from the owner, and writes changes back to it", async () => {
  const row = {
    taskId: "old",
    workspaceId: "default",
    status: "completed" as const,
    origin: "ipc" as const,
    title: "Old task",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2026-09-20T00:00:00Z",
    needs: [],
    counts: { admissions: 1, tools: null },
  };
  const fake = fakeStore({ connection: "ready", runs: [], directory: { rows: [row], needs: [], needsTruncated: false, loading: false } });
  const written: unknown[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      if (command !== "ui-preferences") return new Promise<never>(() => undefined);
      const input = payload as { action: string; preferences?: unknown };
      if (input.action === "set") written.push(input.preferences);
      return {
        ok: true,
        result: {
          preferences: input.action === "set" ? input.preferences : { pins: [], archived: ["old"], seen: { old: "2026-09-20T00:00:00Z" } },
        },
      } as never;
    },
  };
  const page = await mount(<App store={fake.store} client={client} workspaceId="default" />);
  await act(async () => {
    await Promise.resolve();
  });
  // Archived by the owner's record: not in the active list, and not unread.
  expect(page.textContent).toContain("Every chat is archived.");
  await click([...page.querySelectorAll(".sidebar button")].find((button) => button.textContent === "Archived"));
  expect(page.querySelector(".session")?.textContent).toContain("Old task");
  expect(page.querySelector('[aria-label="unread"]')).toBeNull();
  await click(page.querySelector('[aria-label="Unarchive Old task"]'));
  await act(async () => {
    await Promise.resolve();
  });
  expect(written).toEqual([{ pins: [], archived: [], seen: { old: "2026-09-20T00:00:00Z" } }]);
  // The archive view, emptied, says so in its own words.
  expect(page.textContent).toContain("No archived chats.");
  window.localStorage.removeItem("tavi.sessions");
});

it("says the chats list is empty only once the owner answered with nothing, never beside a refusal", async () => {
  const empty = fakeStore({ connection: "ready", runs: [], directory: { rows: [], needs: [], needsTruncated: false, loading: false } });
  const page = await mount(<App store={empty.store} client={silent} workspaceId="default" />);
  expect(page.querySelector(".sidebar")?.textContent).toContain("No chats yet.");
  const refused = fakeStore({
    connection: "ready",
    runs: [],
    directory: { rows: [], needs: [], needsTruncated: false, loading: false, error: "owner unreachable" },
  });
  const other = await mount(<App store={refused.store} client={silent} workspaceId="default" />);
  expect(other.querySelector(".sidebar")?.textContent).toContain("owner unreachable");
  expect(other.querySelector(".sidebar")?.textContent).not.toMatch(/No chats yet|No matching chats|archived\./);
});

it("starts a new chat from the panel: an empty canvas until the next prompt's entry appears", async () => {
  const earlier = [run("live", "Earlier question", { taskId: "old", status: "completed" })];
  const fake = fakeStore({ connection: "ready", runs: earlier, directory: listed(earlier), next: { kind: "continue", taskId: "old" } });
  const page = await mount(<App store={fake.store} client={silent} workspaceId="default" />);
  expect(page.querySelector(".task-header h1")?.textContent).toContain("Earlier question");
  expect(page.querySelector("textarea")?.getAttribute("placeholder")?.split("\n")[0]).toBe("Reply…");
  await click(page.querySelector('[aria-label="New chat"]'));
  expect(fake.acted).toEqual(["newTask"]);
  expect(page.querySelector(".task-header")).toBeNull();
  expect(page.textContent).toContain("Ask Tavi something to start a chat.");
  expect(page.querySelector("textarea")?.getAttribute("placeholder")?.split("\n")[0]).toBe("Start a new chat…");
  expect(page.querySelector(".session.current")).toBeNull();
  // The prompt's own entry ends the draft: the canvas follows it.
  await act(async () =>
    fake.publish({
      connection: "ready",
      runs: [...earlier, run("next", "A new question", { status: "running" })],
      directory: listed(earlier),
    }),
  );
  expect(page.querySelector(".task-header h1")?.textContent).toContain("A new question");
  // Picking a chat ends a draft as well.
  await click(page.querySelector('[aria-label="New chat"]'));
  expect(page.querySelector(".task-header")).toBeNull();
  await click([...page.querySelectorAll(".sidebar .session")].find((button) => button.textContent?.includes("Earlier question")));
  expect(page.querySelector(".task-header h1")?.textContent).toContain("Earlier question");
});

it("starts a new chat after a failed one with Send, not the failure's Retry", async () => {
  const earlier = [run("live", "Earlier question", { taskId: "old", status: "failed" }, { activeMs: 64_000 })];
  const fake = fakeStore({ connection: "ready", runs: earlier, directory: listed(earlier), next: { kind: "continue", taskId: "old" } });
  const page = await mount(<App store={fake.store} client={silent} workspaceId="default" />);
  expect(page.querySelector(".composer button[type=submit]")?.textContent).toBe("Retry");
  await click(page.querySelector('[aria-label="New chat"]'));
  expect(page.querySelector(".composer button[type=submit]")?.textContent).toBe("Send");
});

it("on a phone, starts with the sessions sidebar folded and folds it again once a chat is picked", async () => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("720px"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  try {
    const earlier = [run("live", "Earlier question", { taskId: "old", status: "completed" })];
    const fake = fakeStore({ connection: "ready", runs: earlier, directory: listed(earlier) });
    const page = await mount(<App store={fake.store} client={silent} workspaceId="default" />);
    expect(page.querySelector(".sidebar")).toBeNull();
    await click(page.querySelector(".sidebar-rail .sidebar-toggle"));
    expect(page.querySelector(".sidebar")).not.toBeNull();
    await click([...page.querySelectorAll(".sidebar .session")].find((button) => button.textContent?.includes("Earlier question")));
    expect(page.querySelector(".sidebar")).toBeNull();
    expect(page.querySelector(".task-header h1")?.textContent).toContain("Earlier question");
  } finally {
    window.matchMedia = original;
  }
});

it("asks a worker's question in its root chat's transcript, answers it there, and names the one question in the composer", async () => {
  const earlier = [run("live", "Research the market", { taskId: "root", status: "completed" })];
  const question = {
    taskId: "worker-1",
    workspaceId: "default",
    principalId: "operator",
    workerLabel: "Researcher",
    waitId: "wait-1",
    question: "Which region?",
    deadlineAt: "2099-10-04T00:00:00Z",
    askedAt: "2026-10-04T00:00:00Z",
    deliveries: [],
  };
  const fake = fakeStore({
    connection: "ready",
    runs: earlier,
    directory: listed(earlier),
    workers: { root: { questions: [question], handoffs: [], answers: {} } },
    next: { kind: "answer", taskId: "worker-1", waitId: "wait-1", rootTaskId: "root" },
  });
  const answered: [string, string, string][] = [];
  const loaded: string[] = [];
  fake.store.answerWorker = (rootTaskId, waitId, text) => void answered.push([rootTaskId, waitId, text]);
  fake.store.loadWorkerNeeds = async (rootTaskId) => void loaded.push(rootTaskId);
  const page = await mount(<App store={fake.store} client={silent} workspaceId="default" />);
  expect(loaded).toContain("root");
  expect(page.querySelector("textarea[placeholder]")?.getAttribute("placeholder")?.split("\n")[0]).toBe("Answer the question above…");
  const card = page.querySelector(".runs .worker-needs .need-question");
  expect(card?.textContent).toContain("Researcher");
  expect(card?.textContent).toContain("Which region?");
  const box = card?.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, "Europe");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click([...(card?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.startsWith("Send")));
  expect(answered).toEqual([["root", "wait-1", "Europe"]]);
});

describe("Home", () => {
  const homeRow = {
    taskId: "home-1",
    workspaceId: "default",
    status: "completed" as const,
    origin: "web" as const,
    title: "Home",
    titleSource: "home" as const,
    chatKind: "home" as const,
    principalId: "operator",
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    needs: [],
    counts: { admissions: 1, tools: null },
  };
  /** An owner with `chat.home` set to `on`, holding `homes` as the person's Home. */
  const owner = (on: boolean, homes: readonly (typeof homeRow)[]) => {
    const asked: Record<string, unknown>[] = [];
    const client: SettingsClient = {
      request: async (command, payload) => {
        asked.push({ command, ...(payload as Record<string, unknown>) });
        if (command === "workspace-settings")
          return {
            ok: true,
            result: {
              workspaceId: "default",
              revision: 1,
              settings: {},
              effective: { timezone: "UTC", homeChat: on },
              hostTimezone: "UTC",
            },
          } as never;
        if (command === "tasks" && Array.isArray((payload as { chatKinds?: unknown }).chatKinds))
          return { ok: true, result: { action: "list", rows: homes, truncated: false } } as never;
        return new Promise<never>(() => undefined);
      },
    };
    return { client, asked };
  };
  const settle = (): Promise<void> => flush(4, 0);

  it("opens the person's Home at /, and names Home in the composer", async () => {
    const fake = fakeStore({ connection: "ready", runs: [], next: { kind: "home" } });
    const { client, asked } = owner(true, [homeRow]);
    const page = await mount(<App store={fake.store} client={client} workspaceId="default" principal="operator" />);
    await settle();
    expect(fake.homes.at(-1)).toBe(true);
    expect(asked.find((entry) => entry["command"] === "tasks")).toMatchObject({
      action: "list",
      workspaceId: "default",
      chatKinds: ["home"],
      principalId: "operator",
      limit: 1,
    });
    expect(fake.opened).toEqual(["home-1"]);
    expect(page.querySelector("textarea")?.getAttribute("placeholder")?.split("\n")[0]).toBe("Message Home…");
    // Once open, Home is the chat in view, and the composer still writes to it.
    await act(async () =>
      fake.publish({
        connection: "ready",
        runs: [run("h", "", { taskId: "home-1", status: "completed" }, { restored: true })],
        home: "home-1",
        next: { kind: "continue", taskId: "home-1" },
      }),
    );
    expect(page.querySelector("textarea")?.getAttribute("placeholder")?.split("\n")[0]).toBe("Message Home…");
  });

  it("offers a clean New chat beside New side chat on the folded sidebar too", async () => {
    const fake = fakeStore({ connection: "ready", runs: [], next: { kind: "home" } });
    const page = await mount(<App store={fake.store} client={owner(true, []).client} workspaceId="default" />);
    await settle();
    await click(page.querySelector(".sidebar .sidebar-toggle"));
    expect(page.querySelector('.sidebar-rail [aria-label="New side chat"]')).not.toBeNull();
    await click(page.querySelector('.sidebar-rail [aria-label="New chat"]'));
    expect(fake.acted).toEqual(["newTask"]);
  });

  it("leaves an empty canvas whose first prompt makes Home, and offers one New side chat path", async () => {
    const fake = fakeStore({ connection: "ready", runs: [], next: { kind: "home" } });
    const page = await mount(<App store={fake.store} client={owner(true, []).client} workspaceId="default" />);
    await settle();
    expect(fake.opened).toEqual([]);
    expect(page.querySelector("textarea")?.getAttribute("placeholder")?.split("\n")[0]).toBe("Message Home…");
    // The sidebar's +, and the sheet's chord, say New side chat and do the same thing.
    await click(page.querySelector('[aria-label="New side chat"]'));
    expect(fake.acted).toEqual(["newTask"]);
    // No chat to be a side chat of: an ordinary one, as the empty canvas says.
    expect(page.querySelector("textarea")?.getAttribute("placeholder")?.split("\n")[0]).toBe("Start a new chat…");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", metaKey: true, bubbles: true })));
    await click(
      [...(page.querySelector(".sheet")?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "New side chat"),
    );
    expect(fake.acted).toEqual(["newTask", "newTask"]);
    // The rail's + is the same path.
    await click(page.querySelector('.sidebar-head [aria-label="Hide chats"]'));
    await click(page.querySelector('.sidebar-rail [aria-label="New side chat"]'));
    expect(fake.acted).toEqual(["newTask", "newTask", "newTask"]);
  });

  it("changes nothing while chat.home is off, or unreadable", async () => {
    for (const client of [owner(false, [homeRow]).client, silent]) {
      const fake = fakeStore({ connection: "ready", runs: [] });
      const page = await mount(<App store={fake.store} client={client} workspaceId="default" />);
      await settle();
      expect(fake.opened).toEqual([]);
      expect(fake.homes.every((on) => !on)).toBe(true);
      expect(page.querySelector("textarea")?.getAttribute("placeholder")?.split("\n")[0]).toBe("Start a new chat…");
      expect(page.querySelector('[aria-label="New chat"]')).not.toBeNull();
      unmountAll();
    }
  });
});

it("labels a capped needs count as a workspace lower bound", async () => {
  const state: CanvasState = { connection: "ready", runs: [], directory: { rows: [], needs: [], needsTruncated: true, loading: false } };
  const page = await mount(
    <InWorkspace workspaceId="default">
      <Bar state={state} route="chat" onRoute={() => undefined} needs={128} />
    </InWorkspace>,
  );
  expect(page.querySelector(".needs-count")?.textContent).toBe("128+ chats need you in workspace default");
});

describe("approval decisions", () => {
  const request = (callId: string, effect: string) => ({
    callId,
    toolName: "files.remove",
    summary: `remove ${callId}`,
    input: {},
    approvalId: `a-${callId}`,
    effect,
  });
  it.each(["mutating", "future-effect"])("requires confirmation for %s and prevents the chord bypass", async (effect) => {
    const round = { taskId: "task-1", steps: 1, requests: [request("c1", effect)] };
    const fake = fakeStore({
      connection: "ready",
      runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval", pending: [round] }, { roundCalls: { 1: ["c1"] } })],
    });
    const page = await mount(<App store={fake.store} client={silent} workspaceId="default" />);
    for (let i = 0; i < 2; i++)
      await act(async () =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, altKey: true, bubbles: true })),
      );
    expect(fake.acted).toEqual([]);
    const confirm = [...page.querySelectorAll("button")].find((button) => button.textContent === "Confirm actions")!;
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => confirm.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(fake.acted).toEqual([]);
    await click(confirm);
    expect(fake.acted).toEqual(["decide ui-1 true"]);
    await act(async () =>
      fake.publish({
        connection: "ready",
        runs: [
          run(
            "ui-1",
            "p",
            {
              taskId: "task-1",
              status: "running",
              settled: [{ steps: 1, decisions: [{ callId: "c1", approved: true }], decidedBy: "operator", at: "2026-10-06T01:36:00.000Z" }],
            },
            { approvalHistory: { 1: round } },
          ),
        ],
      }),
    );
    // A decided round leaves the transcript: the chat panel's Activity lists it.
    expect(page.querySelector('[aria-label="permission required"]')).toBeNull();
    expect(page.textContent).not.toContain("Decided by you");
  });
  it("runs an external read on the first approval, with no second confirmation", async () => {
    // A web search is gated by the round; confirming it again made one search
    // three questions. `mutating` keeps the second step (the case above).
    const round = {
      taskId: "task-1",
      steps: 1,
      requests: [
        { ...request("c1", "external"), toolName: "web_search", summary: "Approve web_search?", input: { query: "jev typesafe.ai" } },
      ],
    };
    const fake = fakeStore({
      connection: "ready",
      runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval", pending: [round] }, { roundCalls: { 1: ["c1"] } })],
    });
    const page = await mount(<App store={fake.store} client={silent} workspaceId="default" />);
    // The card says what the call is, not the workflow's placeholder summary.
    expect(page.textContent).toContain("query: jev typesafe.ai");
    expect(page.textContent).not.toContain("Approve web_search?");
    const runButton = [...page.querySelectorAll("button")].find((button) => button.textContent === "Allow once")!;
    await click(runButton);
    expect(page.textContent).not.toContain("Confirm these tool actions");
    expect(fake.acted).toEqual(["decide ui-1 true"]);
  });
  it("shows a call's risk and what it does, and decides with a scope or a reason", async () => {
    const decided: unknown[] = [];
    const scoped = {
      ...request("c1", "external"),
      toolName: "sandbox.run",
      summary: "Run `make test` in the sandbox",
      input: { command: "make", args: ["test"] },
      risk: { level: "high" as const, reasons: ["reaches the network"], tainted: true },
      display: { title: "Run `make test` in the sandbox", command: "make test" },
      allowedScopes: ["once", "session"] as const,
    };
    const round = { taskId: "task-1", steps: 1, requests: [scoped] };
    const fake = fakeStore({
      connection: "ready",
      runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval", pending: [round] }, { roundCalls: { 1: ["c1"] } })],
    });
    const page = await mount(
      <App
        store={{ ...fake.store, decide: (_id, approved, extra) => void decided.push({ approved, ...extra }) }}
        client={silent}
        workspaceId="default"
      />,
    );
    expect(page.querySelector(".risk-high")?.textContent).toBe("high risk");
    expect(page.textContent).toContain("reaches the network");
    // Why it is asked: the taint in plain words, the other flags in one line; the command waits behind Details.
    expect(page.querySelector(".why-asked")?.textContent).toBe(
      "Why am I asked? This chat read content Tavi does not trust, which may be steering this call.",
    );
    expect(page.querySelector(".risk-why")?.textContent).toBe("Flagged: reaches the network");
    expect(page.querySelector(".call-details .call-command")?.textContent).toBe("make test");
    // Tainted: a session is offered, a standing rule is not.
    const buttons = () => [...page.querySelectorAll<HTMLButtonElement>(".round button")];
    expect(buttons().some((button) => button.textContent === "Always allow")).toBe(false);
    // High risk is on the card; approving it is one click, not two.
    await click(buttons().find((button) => button.textContent === "Allow for this chat"));
    expect(decided).toEqual([{ approved: true, scope: "session" }]);
    // The reason is asked for once the person chooses to reject.
    expect(page.querySelector(".reject-reason")).toBeNull();
    // The form opens where the buttons were, and is brought into view whole, above the floating composer.
    const shown = vi.fn(function (this: HTMLElement) {});
    HTMLElement.prototype.scrollIntoView = shown;
    try {
      await click(buttons().find((button) => button.textContent === "Deny…"));
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    expect(shown.mock.contexts.some((element) => (element as HTMLElement).classList.contains("reject-form"))).toBe(true);
    const reason = page.querySelector<HTMLInputElement>(".reject-reason input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(reason, "not on this branch");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(decided).toHaveLength(1);
    await click(buttons().find((button) => button.textContent === "Deny"));
    expect(decided.at(-1)).toEqual({ approved: false, note: "not on this branch" });
  });
  it("approves an assessed change for the task in one click, and keeps the second step for a critical call", async () => {
    const decided: unknown[] = [];
    const assessed = (level: "medium" | "critical") => ({
      ...request("c1", "mutating"),
      toolName: "browser.create_session",
      summary: "Run browser.create_session",
      risk: { level, reasons: [], tainted: false },
      allowedScopes: level === "critical" ? (["once"] as const) : (["once", "session"] as const),
    });
    const round = { taskId: "task-1", steps: 1, requests: [assessed("medium")] };
    const fake = fakeStore({
      connection: "ready",
      runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval", pending: [round] }, { roundCalls: { 1: ["c1"] } })],
    });
    const page = await mount(
      <App
        store={{ ...fake.store, decide: (_id, approved, extra) => void decided.push({ approved, ...extra }) }}
        client={silent}
        workspaceId="default"
      />,
    );
    const session = [...page.querySelectorAll<HTMLButtonElement>(".round button")].find(
      (button) => button.textContent === "Allow for this chat",
    )!;
    expect(session.title).toBe("Runs without asking for the rest of this chat: any browser.create_session call");
    await click(session);
    expect(page.textContent).not.toContain("Confirm these tool actions");
    expect(page.querySelector(".reject-reason")).toBeNull();
    expect(decided).toEqual([{ approved: true, scope: "session" }]);

    await act(async () =>
      fake.publish({
        connection: "ready",
        runs: [
          run(
            "ui-1",
            "p",
            { taskId: "task-1", status: "awaiting_approval", pending: [{ ...round, requests: [assessed("critical")] }] },
            { roundCalls: { 1: ["c1"] } },
          ),
        ],
      }),
    );
    await click(page.querySelector(".approval-trigger"));
    expect(decided).toHaveLength(1);
    expect(page.textContent).toContain("rated critical risk");
    await click([...page.querySelectorAll("button")].find((button) => button.textContent === "Confirm actions"));
    expect(decided.at(-1)).toEqual({ approved: true, scope: "once" });
  });
  it("asks one question about the browser, naming the site: allow for this chat, always allow, or deny", async () => {
    const decided: unknown[] = [];
    const browse = {
      ...request("c1", "mutating"),
      toolName: "browser.create_session",
      summary: "Use the browser to open shop.example.com",
      input: { url: "http://shop.example.com" },
      display: { title: "Use the browser to open shop.example.com", host: "shop.example.com", command: "http://shop.example.com" },
      risk: { level: "medium" as const, reasons: [], tainted: false },
      allowedScopes: ["once", "session", "always"] as const,
      subjects: ["shop.example.com"],
      scopeGroup: "browser.*",
    };
    const round = { taskId: "task-1", steps: 1, requests: [browse] };
    const fake = fakeStore({
      connection: "ready",
      runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval", pending: [round] }, { roundCalls: { 1: ["c1"] } })],
    });
    const page = await mount(
      <App
        store={{ ...fake.store, decide: (_id, approved, extra) => void decided.push({ approved, ...extra }) }}
        client={silent}
        workspaceId="default"
      />,
    );
    expect(page.querySelector(".group-ask")?.textContent).toContain("This chat wants to use the browser");
    expect(page.textContent).toContain("Use the browser to open shop.example.com");
    const buttons = () => [...page.querySelectorAll<HTMLButtonElement>(".round button")].map((button) => button.textContent);
    // It grants the rest of the chat (scope `session`) first — the button the shortcut presses — and says so; once is the second choice.
    expect(buttons()).toEqual(["Allow for this chat", "Allow once", "Always allow", "Deny…"]);
    expect(page.querySelector(".group-ask")?.textContent).toContain("the browser on shop.example.com");
    expect(page.textContent).toContain(
      "Allow for this chat lets it use the browser on shop.example.com without asking again, for the rest of this chat. Opening another site asks again",
    );
    expect(page.textContent).toContain("Always allow never asks again, in any chat");
    // The explanation is behind a closed disclosure under the buttons.
    const explain = page.querySelector<HTMLDetailsElement>(".approval-explain");
    expect(explain?.open).toBe(false);
    expect(explain?.querySelector("summary")?.textContent).toBe("What does this allow?");
    expect(explain?.textContent).toContain("Always allow never asks again, in any chat");
    const press = (label: string) =>
      click([...page.querySelectorAll<HTMLButtonElement>(".round button")].find((button) => button.textContent === label));
    await press("Allow for this chat");
    await press("Allow once");
    await press("Always allow");
    // One click each: no second step, no reason field.
    expect(decided).toEqual([
      { approved: true, scope: "session" },
      { approved: true, scope: "once" },
      { approved: true, scope: "always" },
    ]);
    expect(page.querySelector(".reject-reason")).toBeNull();
    await press("Deny…");
    const reason = page.querySelector<HTMLInputElement>(".reject-reason input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(reason, "not now");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Deny");
    expect(decided.at(-1)).toEqual({ approved: false, note: "not now" });
  });
  it("offers no Always allow for a browser round after the task read web content", async () => {
    const tainted = {
      ...request("c1", "external"),
      toolName: "browser.navigate",
      summary: "Open shop.example.com in the browser",
      display: { title: "Open shop.example.com in the browser" },
      risk: { level: "high" as const, reasons: [], tainted: true },
      allowedScopes: ["once", "session"] as const,
      scopeGroup: "browser.*",
    };
    const fake = fakeStore({
      connection: "ready",
      runs: [
        run(
          "ui-1",
          "p",
          { taskId: "task-1", status: "awaiting_approval", pending: [{ taskId: "task-1", steps: 1, requests: [tainted] }] },
          { roundCalls: { 1: ["c1"] } },
        ),
      ],
    });
    const page = await mount(<App store={fake.store} client={silent} workspaceId="default" />);
    expect([...page.querySelectorAll<HTMLButtonElement>(".round button")].map((button) => button.textContent)).toEqual([
      "Allow for this chat",
      "Allow once",
      "Deny…",
    ]);
    expect(page.textContent).not.toContain("Always allow never asks again");
  });
  it("says a grant in Home lasts until tomorrow, or until the chat rolls over", async () => {
    const decided: unknown[] = [];
    const assessed = {
      ...request("c1", "mutating"),
      toolName: "sandbox.run",
      summary: "Run make",
      risk: { level: "medium" as const, reasons: [], tainted: false },
      allowedScopes: ["once", "session"] as const,
    };
    const browse = {
      ...request("c2", "mutating"),
      toolName: "browser.create_session",
      summary: "Use the browser",
      risk: { level: "medium" as const, reasons: [], tainted: false },
      allowedScopes: ["once", "session"] as const,
      scopeGroup: "browser.*",
    };
    const fake = fakeStore({
      connection: "ready",
      home: "home-1",
      runs: [
        run(
          "ui-1",
          "p",
          { taskId: "home-1", status: "awaiting_approval", pending: [{ taskId: "home-1", steps: 1, requests: [assessed] }] },
          { roundCalls: { 1: ["c1"] } },
        ),
      ],
    });
    const page = await mount(
      <App
        store={{ ...fake.store, decide: (_id, approved, extra) => void decided.push({ approved, ...extra }) }}
        client={silent}
        workspaceId="default"
      />,
    );
    const session = [...page.querySelectorAll<HTMLButtonElement>(".round button")].find(
      (button) => button.textContent === "Allow until tomorrow",
    )!;
    expect(session.title).toBe("Runs without asking in this chat for a day, or until it rolls over: any sandbox.run call");
    await click(session);
    expect(decided).toEqual([{ approved: true, scope: "session" }]);
    await act(async () =>
      fake.publish({
        connection: "ready",
        home: "home-1",
        runs: [
          run(
            "ui-1",
            "p",
            { taskId: "home-1", status: "awaiting_approval", pending: [{ taskId: "home-1", steps: 2, requests: [browse] }] },
            { roundCalls: { 2: ["c2"] } },
          ),
        ],
      }),
    );
    expect([...page.querySelectorAll<HTMLButtonElement>(".round button")].map((button) => button.textContent)).toEqual([
      "Allow until tomorrow",
      "Allow once",
      "Deny…",
    ]);
    expect(page.textContent).toContain("in this chat for a day, or until it rolls over");
  });
  it("applies a scoped approval to the checked calls only", async () => {
    const decided: unknown[] = [];
    const call = (callId: string) => ({ ...request(callId, "external"), allowedScopes: ["once", "session"] as const });
    const round = { taskId: "task-1", steps: 1, requests: [call("c1"), call("c2")] };
    const fake = fakeStore({
      connection: "ready",
      runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval", pending: [round] }, { roundCalls: { 1: ["c1", "c2"] } })],
    });
    const page = await mount(
      <App
        store={{ ...fake.store, decide: (_id, approved, extra) => void decided.push({ approved, ...extra }) }}
        client={silent}
        workspaceId="default"
      />,
    );
    await click(page.querySelectorAll<HTMLInputElement>(".round input[type=checkbox]")[1]);
    await click(
      [...page.querySelectorAll<HTMLButtonElement>(".round button")].find((button) => button.textContent === "Allow for this chat"),
    );
    expect(decided).toEqual([
      {
        approved: [
          { callId: "c1", approved: true },
          { callId: "c2", approved: false },
        ],
        scope: "session",
      },
    ]);
  });
  it("names the rule Always allow saves — the tool and each exact subject — for the checked calls only", async () => {
    const decided: unknown[] = [];
    const call = (callId: string, extra: object) => ({
      ...request(callId, "external"),
      allowedScopes: ["once", "session", "always"] as const,
      ...extra,
    });
    const round = {
      taskId: "task-1",
      steps: 1,
      requests: [
        // The display says one thing; the rule matches the verdict's subjects.
        call("c1", {
          toolName: "shell.exec",
          display: { title: "Run git status", command: "git status --short" },
          subjects: ["git status", "git diff"],
        }),
        call("c2", { toolName: "web_fetch", display: { title: "Fetch", host: "example.com" } }),
        call("c3", { toolName: "files.write", subjects: ["notes/*.md"] }),
      ],
    };
    const fake = fakeStore({
      connection: "ready",
      runs: [
        run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval", pending: [round] }, { roundCalls: { 1: ["c1", "c2", "c3"] } }),
      ],
    });
    const page = await mount(
      <App
        store={{ ...fake.store, decide: (_id, approved, extra) => void decided.push({ approved, ...extra }) }}
        client={silent}
        workspaceId="default"
      />,
    );
    await click(page.querySelectorAll<HTMLInputElement>(".round input[type=checkbox]")[2]);
    const always = [...page.querySelectorAll<HTMLButtonElement>(".round button")].find((button) => button.textContent === "Always allow")!;
    expect(always.title).toBe("Saves a workspace rule allowing exactly: shell.exec git status; shell.exec git diff; any web_fetch call");
    const notice = [...page.querySelectorAll(".round .notice")].find((node) => node.textContent?.startsWith("Always allow"));
    expect([...(notice?.querySelectorAll("code") ?? [])].map((node) => node.textContent)).toEqual([
      "shell.exec git status",
      "shell.exec git diff",
      "any web_fetch call",
    ]);
    expect(notice?.textContent).not.toContain("git status --short");
    expect(notice?.textContent).not.toContain("files.write");
  });
  it("sends the typed reason with each unchecked call on Approve selected", async () => {
    const decided: unknown[] = [];
    const round = { taskId: "task-1", steps: 1, requests: [request("c1", "read-only"), request("c2", "read-only")] };
    const fake = fakeStore({
      connection: "ready",
      runs: [run("ui-1", "p", { taskId: "task-1", status: "awaiting_approval", pending: [round] }, { roundCalls: { 1: ["c1", "c2"] } })],
    });
    const page = await mount(
      <App
        store={{ ...fake.store, decide: (_id, approved, extra) => void decided.push({ approved, ...extra }) }}
        client={silent}
        workspaceId="default"
      />,
    );
    await click(page.querySelectorAll<HTMLInputElement>(".round input[type=checkbox]")[1]);
    const reason = page.querySelector<HTMLInputElement>(".reject-reason input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(reason, " wrong file ");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(page.querySelector(".approval-trigger"));
    expect(decided).toEqual([
      {
        approved: [
          { callId: "c1", approved: true },
          { callId: "c2", approved: false, note: "wrong file" },
        ],
        scope: "once",
      },
    ]);
  });
  it("offers per-call choices only within the protocol bound", async () => {
    const requests = Array.from({ length: 65 }, (_, index) => request(`c${index}`, "read-only"));
    const fake = fakeStore({
      connection: "ready",
      runs: [
        run(
          "ui-1",
          "p",
          { taskId: "task-1", status: "awaiting_approval", pending: [{ taskId: "task-1", steps: 1, requests }] },
          { roundCalls: { 1: requests.map((item) => item.callId) } },
        ),
      ],
    });
    const page = await mount(<App store={fake.store} client={silent} workspaceId="default" />);
    expect(page.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(page.textContent).toContain("More than 64 calls");
    await click(page.querySelector(".approval-trigger"));
    expect(fake.acted).toEqual(["decide ui-1 true"]);
  });
});

it("sends checked and unchecked calls as one complete decision", async () => {
  const requests = ["c1", "c2"].map((callId) => ({
    callId,
    toolName: "files.read",
    summary: callId,
    input: {},
    approvalId: callId,
    effect: "read-only",
  }));
  const fake = fakeStore({
    connection: "ready",
    runs: [
      run(
        "mixed",
        "p",
        { taskId: "task-1", status: "awaiting_approval", pending: [{ taskId: "task-1", steps: 1, requests }] },
        { roundCalls: { 1: ["c1", "c2"] } },
      ),
    ],
  });
  const decisions: unknown[] = [];
  const page = await mount(
    <App
      store={{
        ...fake.store,
        decide: (_id, decision) => {
          decisions.push(decision);
        },
      }}
      client={silent}
      workspaceId="default"
    />,
  );
  await click(page.querySelectorAll('input[type="checkbox"]')[1]);
  await click(page.querySelector(".approval-trigger"));
  expect(decisions).toEqual([
    [
      { callId: "c1", approved: true },
      { callId: "c2", approved: false },
    ],
  ]);
});

it("offers an inline answer and explains why approval disables it and the composer", async () => {
  const waiting = { on: "reply", question: "Which folder?", deadlineAt: "2020-01-01T00:00:00Z" };
  const entry = run("question", "p", { taskId: "task-1", status: "waiting", waiting });
  const fake = fakeStore({ connection: "ready", runs: [entry] });
  const answers: string[] = [];
  const page = await mount(
    <App
      store={{
        ...fake.store,
        answerQuestion: (_id, text) => {
          answers.push(text);
        },
      }}
      client={silent}
      workspaceId="default"
    />,
  );
  const card = () => page.querySelector<HTMLElement>(".need-question")!;
  expect(card().getAttribute("role")).toBe("group");
  expect(card().querySelector("h3")?.textContent).toBe("Which folder?");
  const input = card().querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, "reports");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...card().querySelectorAll<HTMLButtonElement>(".need-footer button")]
      .find((button) => button.textContent?.startsWith("Send"))!
      .click(),
  );
  expect(answers).toEqual(["reports"]);
  // Past its deadline the chip says so, without a countdown.
  expect(card().querySelector(".need-deadline")?.textContent).toMatch(/^Was due /);
  await act(async () =>
    fake.publish({
      connection: "ready",
      runs: [{ ...entry, run: { ...entry.run, pending: [{ taskId: "task-1", steps: 1, requests: [] }] } }],
    }),
  );
  expect(card().querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
  expect(card().querySelector(".need-blocked")?.textContent).toContain("Decide the approval above first.");
  expect(page.querySelector(".composer button[type=submit]")?.getAttribute("aria-disabled")).toBe("true");
});

it("offers a question's options as rows with their descriptions, sends a click after its undo window, and a multi-select as one reply", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const choices = {
      header: "Customer",
      options: [{ label: "Acme" }, { label: "Globex", description: "the big one" }],
      multiSelect: false,
      allowOther: false,
      recommended: 2,
    };
    const waiting = { on: "reply", question: "Which customer?", deadlineAt: "2099-01-01T00:00:00Z", choices };
    const answers: string[] = [];
    const single = run("question", "p", { taskId: "task-1", status: "waiting", waiting });
    const fake = fakeStore({ connection: "ready", runs: [single] });
    const page = await mount(
      <App
        store={{
          ...fake.store,
          answerQuestion: (_id, text) => {
            answers.push(text);
          },
        }}
        client={silent}
        workspaceId="default"
      />,
    );
    // No free-text box where the question does not accept one; descriptions are on the page, not in a tooltip.
    expect(page.querySelector(".need-question form")).toBeNull();
    expect(page.querySelector(".need-option-description")?.textContent).toBe("the big one");
    expect(page.querySelectorAll(".need-option-tag")).toHaveLength(1);
    const option = (label: string) =>
      [...page.querySelectorAll<HTMLButtonElement>("button.need-option")].find(
        (button) => button.querySelector(".need-option-label")?.textContent === label,
      );
    await act(async () => option("Globex")?.click());
    expect(answers).toEqual([]);
    expect(page.querySelector(".need-undo")?.textContent).toContain("Sending Globex");
    // Taken back: nothing is sent.
    await act(async () =>
      [...page.querySelectorAll<HTMLButtonElement>(".need-undo button")].find((button) => button.textContent === "Undo")?.click(),
    );
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(answers).toEqual([]);
    await act(async () => option("Globex")?.click());
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(answers).toEqual(["Globex"]);

    await act(async () =>
      fake.publish({
        connection: "ready",
        runs: [
          { ...single, run: { ...single.run, waiting: { ...waiting, choices: { ...choices, multiSelect: true, allowOther: true } } } },
        ],
      }),
    );
    const boxes = [...page.querySelectorAll<HTMLInputElement>(".need-options input[type=checkbox]")];
    await act(async () => boxes[1]?.click());
    await act(async () => boxes[0]?.click());
    const send = [...page.querySelectorAll<HTMLButtonElement>(".need-footer button")].find(
      (button) => button.textContent === "Send 2 choices",
    );
    await act(async () => send?.click());
    // The options' numbers, in option order: the owner splits on commas, so a
    // label with one would not survive being sent by name.
    expect(answers).toEqual(["Globex", "1, 2"]);
    expect(matchChoiceAnswer(answers[1]!, { ...choices, multiSelect: true, allowOther: true })).toEqual({ answers: ["Acme", "Globex"] });
    const commas = {
      ...choices,
      options: [{ label: "Acme, Inc." }, { label: "Globex" }, { label: "Initech, LLC" }],
      multiSelect: true,
      allowOther: false,
    };
    await act(async () =>
      fake.publish({ connection: "ready", runs: [{ ...single, run: { ...single.run, waiting: { ...waiting, choices: commas } } }] }),
    );
    const commaBoxes = [...page.querySelectorAll<HTMLInputElement>(".need-options input[type=checkbox]")];
    // A new question's boxes start unchecked, not with the last question's picks.
    expect(commaBoxes.map((box) => box.checked)).toEqual([false, false, false]);
    await act(async () => commaBoxes[2]?.click());
    await act(async () => commaBoxes[0]?.click());
    await act(async () =>
      [...page.querySelectorAll<HTMLButtonElement>(".need-footer button")]
        .find((button) => button.textContent === "Send 2 choices")
        ?.click(),
    );
    expect(answers.at(-1)).toBe("1, 3");
    expect(matchChoiceAnswer(answers.at(-1)!, commas)).toEqual({ answers: ["Acme, Inc.", "Initech, LLC"] });
  } finally {
    vi.useRealTimers();
  }
});

it("drops a pick still in its undo window when the question is answered elsewhere, shows who answered, and says the pick was not sent", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  announcer();
  try {
    const choices = { options: [{ label: "Acme" }, { label: "Globex" }], multiSelect: false, allowOther: false };
    const waiting = { on: "reply", question: "Which customer?", deadlineAt: "2099-01-01T00:00:00Z", choices, waitId: "wait:task-1:2:ask" };
    const ask = {
      kind: "tool" as const,
      key: "ask",
      attemptId: "a",
      callId: "ask",
      toolName: "operator.ask_user",
      status: "running" as const,
      input: { question: "Which customer?" },
    };
    const answers: string[] = [];
    const asking = run("question", "p", { taskId: "task-1", status: "waiting", waiting, transcript: [ask] });
    const fake = fakeStore({ connection: "ready", runs: [asking] });
    const page = await mount(
      <App
        store={{
          ...fake.store,
          answerQuestion: (_id, text) => {
            answers.push(text);
          },
        }}
        client={silent}
        workspaceId="default"
      />,
    );
    const option = (label: string) =>
      [...page.querySelectorAll<HTMLButtonElement>("button.need-option")].find(
        (button) => button.querySelector(".need-option-label")?.textContent === label,
      );
    await act(async () => option("Globex")?.click());
    expect(page.querySelector(".need-undo")?.textContent).toContain("Sending Globex");
    // Ana answers in Telegram while the bar runs: the task goes on, and this page's pick is never sent.
    const settled = {
      waitId: waiting.waitId,
      outcome: "answered" as const,
      answers: ["Acme"],
      decidedBy: "Ana",
      via: "telegram-main",
      at: "2026-10-02T14:02:00.000Z",
    };
    await act(async () =>
      fake.publish({
        connection: "ready",
        runs: [
          {
            ...asking,
            run: {
              ...asking.run,
              status: "running",
              waiting: undefined,
              transcript: [{ ...ask, status: "completed" as const }],
              settledWaits: [settled],
            },
          },
        ],
      }),
    );
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(answers).toEqual([]);
    expect(page.querySelector(".need-undo")).toBeNull();
    expect(page.querySelector(".need-receipt")?.textContent).toContain("Ana answered Acme");
    // The pick here was another option: the page says it was not sent.
    const notSent = "Your pick, Globex, was not sent: the question was answered before it went.";
    expect([...page.querySelectorAll("p.notice")].map((line) => line.textContent)).toContain(notSent);
    expect(document.getElementById(ANNOUNCER_ID)?.textContent).toBe(notSent);
    // The task asks again: the note about the last question goes.
    const next = { ...waiting, question: "Which region?", waitId: "wait:task-1:3:ask2" };
    await act(async () =>
      fake.publish({
        connection: "ready",
        runs: [
          {
            ...asking,
            run: {
              ...asking.run,
              waiting: next,
              transcript: [
                { ...ask, status: "completed" as const },
                { ...ask, key: "ask2", callId: "ask2" },
              ],
              settledWaits: [settled],
            },
          },
        ],
      }),
    );
    expect(page.textContent).not.toContain("was not sent");
    // A pick that matches what was answered elsewhere says nothing more than the receipt.
    await act(async () => option("Acme")?.click());
    await act(async () =>
      fake.publish({
        connection: "ready",
        runs: [
          {
            ...asking,
            run: {
              ...asking.run,
              status: "running",
              waiting: undefined,
              transcript: [
                { ...ask, status: "completed" as const },
                { ...ask, key: "ask2", callId: "ask2", status: "completed" as const },
              ],
              settledWaits: [settled, { ...settled, waitId: next.waitId }],
            },
          },
        ],
      }),
    );
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(answers).toEqual([]);
    expect(page.textContent).not.toContain("was not sent");
  } finally {
    vi.useRealTimers();
  }
});

it("shows bounded artifact metadata and offers individual and all-pending review", async () => {
  const requests = ["a", "b"].map((artifactId) => ({ artifactId, toolName: "browser", callId: artifactId }));
  const artifacts = requests.map(({ artifactId }) => ({
    artifactId,
    workspaceId: "default",
    runId: "task-1",
    contentType: "image/png",
    byteSize: 42,
    reviewState: "pending" as const,
    ...(artifactId === "a" ? { fileName: "bill-2026-10.pdf" } : {}),
  }));
  const fake = fakeStore({
    connection: "ready",
    runs: [run("review", "p", { taskId: "task-1", status: "review_required", review: { steps: 2, requests } }, { artifacts })],
  });
  const writes: unknown[] = [];
  const reads: string[] = [];
  const page = await mount(
    <App
      store={{
        ...fake.store,
        loadArtifacts: async (id) => {
          reads.push(id);
        },
        reviewArtifacts: (_id, decisions) => {
          writes.push(decisions);
        },
      }}
      client={silent}
      workspaceId="default"
    />,
  );
  expect(reads).toEqual(["review"]);
  expect(page.querySelector(".review")?.textContent).toContain("image/png, 42 bytes, pending");
  // Named for what it holds, and promising no view of the content that nothing gives.
  expect(page.querySelector(".review h3")?.textContent).toBe("Review held files");
  expect(page.querySelector(".review p")?.textContent).not.toMatch(/Inspect content|archived outputs/);
  // A held file by its own name, its buttons apart from the sentence.
  expect(page.querySelector(".review-item .review-item-what strong")?.textContent).toBe("bill-2026-10.pdf");
  expect(page.querySelector(".review-item-what button")).toBeNull();
  await click([...page.querySelectorAll(".review button")].find((button) => button.textContent === "Approve artifact"));
  await click([...page.querySelectorAll(".review button")].find((button) => button.textContent === "Reject all pending"));
  expect(writes).toEqual([
    [{ artifactId: "a", approved: true }],
    [
      { artifactId: "a", approved: false },
      { artifactId: "b", approved: false },
    ],
  ]);
});

it("refreshes the workspace inbox while the sidebar is hidden, but pauses in a hidden tab", async () => {
  vi.useFakeTimers();
  const original = Object.getOwnPropertyDescriptor(document, "hidden");
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  try {
    const fake = fakeStore({ connection: "ready", runs: [], directory: { rows: [], needs: [], loading: false, needsTruncated: false } });
    let reads = 0;
    const page = await mount(
      <App
        store={{
          ...fake.store,
          loadSessions: async () => {
            reads++;
          },
        }}
        client={silent}
        workspaceId="default"
      />,
    );
    // The panel's own control collapses it to a rail, which is where it comes back from.
    await click(page.querySelector(".sidebar .sidebar-toggle"));
    expect(page.querySelector(".sidebar")).toBeNull();
    expect(page.querySelector(".sidebar-rail .sidebar-toggle")?.getAttribute("aria-expanded")).toBe("false");
    const before = reads;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(before + 1);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(before + 1);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(reads).toBe(before + 2);
  } finally {
    if (original) Object.defineProperty(document, "hidden", original);
    else Reflect.deleteProperty(document, "hidden");
    vi.useRealTimers();
  }
});

it("loads task context only when a trajectory call is expanded", async () => {
  const tool = {
    kind: "tool" as const,
    key: "tool",
    attemptId: "attempt",
    callId: "call",
    toolName: "browser",
    status: "completed" as const,
    input: { query: "retained input" },
    output: { result: "retained output" },
    durationMs: 750,
  };
  const fake = fakeStore({
    connection: "ready",
    runs: [
      run(
        "turn",
        "p",
        { taskId: "task-1", status: "completed", transcript: [tool] },
        { startedAt: "2026-01-01T00:00:00Z", lastAt: "2026-01-01T00:00:01Z" },
      ),
    ],
  });
  const commands: string[] = [];
  // The header's taint chip reads the chat's label alone: that is not the task's context.
  const client: SettingsClient = {
    request: async (command, payload) => {
      if ((payload as { action?: string } | undefined)?.action === "label")
        return { ok: true, result: { taskId: "task-1", contextLabel: null } };
      commands.push(command);
      if (command === "channels") return { ok: true, result: { channels: [], connections: [] } };
      return {
        ok: true,
        result:
          command === "tasks"
            ? { task: { workspaceId: "default", status: "completed" }, admissions: [], executions: [] }
            : { resolved: [], bindings: [] },
      };
    },
  };
  const page = await mount(<App store={fake.store} client={client} workspaceId="default" />);
  await click([...page.querySelectorAll(".subviews button")].find((button) => button.textContent === "Trajectory"));
  expect(commands.filter((command) => command === "tasks")).toHaveLength(0);
  expect(page.querySelector(".trajectory pre")).toBeNull();
  const call = page.querySelector<HTMLDetailsElement>(".trajectory-call")!;
  expect(call.classList.contains("major")).toBe(true);
  await act(async () => {
    call.open = true;
    call.dispatchEvent(new Event("toggle"));
  });
  expect(commands.filter((command) => command === "tasks")).toHaveLength(1);
  expect(call.textContent).toContain("retained input");
  expect(call.textContent).toContain("retained output");
  expect(call.textContent).toContain("The chat's record: completed; 0 admissions, 0 executions.");
});

it("shows decided artifacts in Held files and opens their metadata in the inspector", async () => {
  const first = [run("turn", "p", { taskId: "task-1", status: "completed" })];
  const fake = fakeStore({ connection: "ready", runs: first, directory: listed(first) });
  const payloads: unknown[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      if (command === "artifacts") payloads.push(payload);
      if (command === "channels") return { ok: true, result: { channels: [], connections: [] } };
      return {
        ok: true,
        result:
          command === "artifacts"
            ? {
                rows: [
                  {
                    artifactId: "artifact",
                    workspaceId: "default",
                    runId: "task-1",
                    contentType: "image/png",
                    byteSize: 42,
                    reviewState: "approved",
                  },
                ],
              }
            : { resolved: [], bindings: [] },
      };
    },
  };
  const page = await mount(<App store={fake.store} client={client} workspaceId="default" />);
  const row = (title: string) => [...page.querySelectorAll(".session")].find((button) => button.textContent?.includes(title));
  // The reader picks "p", so a newer chat arriving does not move the view: only the sidebar click below does.
  await click(row("p"));
  await click([...page.querySelectorAll(".subviews button")].find((button) => button.textContent === "Held files"));
  expect(payloads[0]).toMatchObject({ taskId: "task-1", workspaceId: "default", includeDecided: true, limit: 100 });
  // Named for what it lists, and claiming no record of written files it does not keep.
  expect(page.querySelector('[aria-label="Held files"]')?.textContent).toContain("Files this chat's tools saved");
  // A card says what the file is, how big, and whether it was approved — never its raw id and MIME type.
  const card = page.querySelector('[aria-label="Held files"] li button')?.textContent ?? "";
  expect(card).toContain("PNG image");
  expect(card).toContain("42 bytes");
  expect(card).toContain("Approved");
  expect(card).not.toContain("image/png");
  expect(page.querySelector('[aria-label="Held files"]')?.textContent).not.toContain("not recorded");
  await click(page.querySelector('[aria-label="Held files"] li button'));
  expect(page.querySelector('[aria-label="artifact details"]')?.textContent).toContain("Approved");
  const both = [...first, run("other", "another task", { taskId: "task-2", status: "completed" })];
  await act(async () => fake.publish({ connection: "ready", runs: both, directory: listed(both) }));
  // The picked chat holds, and so does its inspector, until the reader switches chats.
  expect(page.querySelector(".session.current")?.textContent).toContain("p");
  expect(page.querySelector('[aria-label="artifact details"]')?.textContent).toContain("Approved");
  expect(row("another task")).toBeDefined();
  await click(row("another task"));
  expect(page.querySelector(".session.current")?.textContent).toContain("another task");
  expect(page.querySelector('[aria-label="artifact details"]')).toBeNull();
  expect(page.querySelector('[aria-label="Held files"] li')).toBeNull();
});

it("opens a worker from the Agents tab as a view-only transcript beside its chat, never as a chat", async () => {
  const runs = [run("turn", "plan the trip", { taskId: "task-1", status: "completed" })];
  const fake = fakeStore({ connection: "ready", runs, directory: listed(runs) });
  // Just now: a completed worker folds away only after 30 s.
  const at = new Date().toISOString();
  const tree = {
    taskId: "task-1",
    workspaceId: "default",
    ancestors: [],
    truncated: false,
    ancestryUnknown: false,
    nodes: [
      { taskId: "task-1", status: "completed", depth: 0, createdAt: at, updatedAt: at },
      {
        taskId: "worker-1",
        parentTaskId: "task-1",
        agentDefinitionId: "researcher",
        status: "completed",
        depth: 1,
        createdAt: at,
        updatedAt: at,
        finalText: "Three flights found.",
      },
    ],
  };
  const client: SettingsClient = {
    request: async (command, payload) => {
      if (command === "agents") return { ok: true, result: tree };
      if (command === "tasks" && (payload as { action?: string }).action === "transcript")
        return {
          ok: true,
          result: {
            entries: [
              {
                taskId: "worker-1",
                seq: 1,
                turn: {
                  admissionKind: "start",
                  prompt: "Find flights",
                  items: [{ kind: "text", text: "Three flights found." }],
                  outcome: { status: "completed", finalText: "Three flights found." },
                },
                createdAt: at,
              },
            ],
          },
        };
      return new Promise<never>(() => undefined);
    },
  };
  const page = await mount(<App store={fake.store} client={client} workspaceId="default" />);
  await click([...page.querySelectorAll(".subviews button")].find((button) => button.textContent === "Agents"));
  expect(page.querySelector(".agent-tree")?.textContent).toContain("Three flights found.");
  const sessions = page.querySelectorAll(".session").length;
  await click([...page.querySelectorAll(".agent-tree button")].find((button) => button.textContent === "researcher — worker-1"));
  const view = page.querySelector('aside[aria-label="Worker researcher — view only"]');
  expect(view?.textContent).toContain("Find flights");
  expect(view?.querySelector("textarea")).toBeNull();
  // The parent stays the chat on screen: nothing opened in the store, no sidebar row, one composer.
  expect(fake.opened).toEqual([]);
  expect(page.querySelectorAll(".session")).toHaveLength(sessions);
  expect(page.querySelectorAll("textarea")).toHaveLength(1);
  expect(page.querySelector(".agent-tree")).not.toBeNull();
  await click([...(view?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Close"));
  expect(page.querySelector(".worker-view")).toBeNull();
});

it("closes a worker's view on Esc without stopping the chat's running turn", async () => {
  const runs = [run("turn", "plan the trip", { taskId: "task-1", status: "running" })];
  const fake = fakeStore({ connection: "ready", runs, directory: listed(runs) });
  const at = new Date().toISOString();
  const tree = {
    taskId: "task-1",
    workspaceId: "default",
    ancestors: [],
    truncated: false,
    ancestryUnknown: false,
    nodes: [
      { taskId: "task-1", status: "running", depth: 0, createdAt: at, updatedAt: at },
      {
        taskId: "worker-1",
        parentTaskId: "task-1",
        agentDefinitionId: "researcher",
        status: "running",
        depth: 1,
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
  const client: SettingsClient = {
    request: async (command) =>
      command === "agents"
        ? { ok: true, result: tree }
        : command === "tasks"
          ? { ok: true, result: { entries: [] } }
          : new Promise<never>(() => undefined),
  };
  const page = await mount(<App store={fake.store} client={client} workspaceId="default" />);
  await click([...page.querySelectorAll(".subviews button")].find((button) => button.textContent === "Agents"));
  await click([...page.querySelectorAll(".agent-tree button")].find((button) => button.textContent === "researcher — worker-1"));
  const heading = page.querySelector(".worker-view h2");
  expect(heading).not.toBeNull();
  await act(async () => heading!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(page.querySelector(".worker-view")).toBeNull();
  expect(fake.acted).toEqual([]);
  // Esc anywhere else still stops the turn, as before.
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(fake.acted).toEqual(["abort turn"]);
});

it("leaves settings-dialog keys to the modal and ignores already handled keys", async () => {
  const fake = fakeStore({ connection: "ready", runs: [run("live", "work", { taskId: "task-1", status: "running" })] });
  const host = await mount(<App store={fake.store} client={silent} workspaceId="default" />);
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  host.append(dialog);
  for (const key of ["Escape", "/", "Backspace", "Enter"]) {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...(key === "Escape" ? {} : { metaKey: true, altKey: key !== "/" }),
    });
    await act(async () => dialog.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  }
  expect(fake.acted).toEqual([]);
  expect(host.querySelector(".sheet")).toBeNull();
  dialog.remove();
  const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  handled.preventDefault();
  await act(async () => window.dispatchEvent(handled));
  expect(fake.acted).toEqual([]);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(fake.acted).toEqual(["abort live"]);
});

describe("UI plugins in the shell", () => {
  const tab = (pluginId: string, id: string, title: string) => ({
    pluginId,
    kind: "external",
    contentHash: (pluginId === "acme.one" ? "1" : "2").repeat(64),
    ui: {
      abi: "tavi.ui/1",
      contributions: [{ id, title, document: `${id}.html`, channels: [], placements: [{ slot: "chat.panel.tab" }] }],
    },
  });
  const pluginClient = (live: boolean, offered = live) =>
    ({
      features: ["plugins", ...(offered ? ["browser-live"] : [])],
      ...(live ? { liveWatch: async () => ({ response: { ok: true } }) } : {}),
      request: async (command: string) => {
        if (command === "plugins")
          return { ok: true, result: { entries: [tab("acme.one", "first", "First"), tab("acme.two", "second", "Second")] } };
        if (command === "workspace-settings")
          return {
            ok: true,
            result: { workspaceId: "default", revision: 0, settings: {}, effective: { timezone: "UTC" }, hostTimezone: "UTC" },
          };
        return new Promise<never>(() => undefined);
      },
    }) as unknown as SettingsClient;
  const settle = (): Promise<void> => flush(6, 1);

  it("shows contributed tabs only with the live client, badges them from their frame, and opens a plugin's own tab when it asks", async () => {
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "completed" })] });
    const without = await mount(<App store={store} client={pluginClient(false)} workspaceId="default" />);
    await settle();
    expect(without.querySelector('.chat-panel-rail [aria-label="First"]')).toBeNull();
    unmountAll();
    // A client that could watch, against an owner that offers no live view: none either.
    const older = await mount(<App store={store} client={pluginClient(true, false)} workspaceId="default" />);
    await settle();
    expect(older.querySelector('.chat-panel-rail [aria-label="First"]')).toBeNull();
    unmountAll();

    const page = await mount(<App store={store} client={pluginClient(true)} workspaceId="default" />);
    await settle();
    await click(page.querySelector('.chat-panel-rail [aria-label="Second"]'));
    await settle();
    const frame = page.querySelector('iframe[data-plugin="acme.two"]') as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`/plugin-ui/acme.two/${"2".repeat(64)}/second.html`);
    const post = async (data: unknown) => {
      await act(async () =>
        window.dispatchEvent(new MessageEvent("message", { data: { abi: "tavi.ui/1", ...(data as object) }, source: frame.contentWindow })),
      );
      await settle();
    };
    await post({ type: "badge", count: 3 });
    expect(page.querySelector('[role="tab"][aria-label="Second, 3 new"] .chat-panel-count')?.textContent).toBe("3");
    // From the Details tab, the second plugin asks for its tab: its own, never the first plugin's.
    await click(page.querySelector('.chat-panel [role="tab"][aria-label="Details"]'));
    await click(page.querySelector('.chat-panel [role="tab"][aria-label^="Second"]'));
    await settle();
    const again = page.querySelector('iframe[data-plugin="acme.two"]') as HTMLIFrameElement;
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { abi: "tavi.ui/1", type: "navigate", target: { to: "slot", slot: "chat.panel.tab" } },
          source: again.contentWindow,
        }),
      ),
    );
    await settle();
    expect(page.querySelector('.chat-panel [role="tab"][aria-selected="true"]')?.getAttribute("aria-label")).toBe("Second, 3 new");
  });
});

describe("the shell, for assistive technology", () => {
  /** WCAG 2.2 AA and best practice; colour contrast is checked from the tokens (`contrast.test.ts`), as jsdom computes no colours. */
  const AXE = {
    runOnly: { type: "tag" as const, values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false } },
  };
  const violations = async (where: Element): Promise<string[]> =>
    (await axe.run(where, AXE)).violations.map(
      (violation) => `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`,
    );

  it("passes axe empty, with a turn and an approval, with the chat panel open, and on Settings", async () => {
    announcer();
    const empty = await mount(<App store={fakeStore({ connection: "ready", runs: [] }).store} client={silent} workspaceId="default" />);
    // With no chat yet, the page still has its one top heading.
    expect(empty.querySelectorAll("h1")).toHaveLength(1);
    expect(await violations(empty)).toEqual([]);
    unmountAll();

    const answered = {
      kind: "text" as const,
      key: "t",
      attemptId: "a",
      blockId: "b",
      text: "Here it is:\n\n```ts\nconst answer = 42; // the answer\n```",
    };
    const tool = {
      kind: "tool" as const,
      key: "c0",
      attemptId: "a",
      callId: "c0",
      toolName: "files.read",
      status: "completed" as const,
      input: { path: "notes.md" },
    };
    const round = {
      taskId: "task-1",
      steps: 1,
      requests: [
        { callId: "c1", toolName: "files.write", summary: "Write notes.md", input: {}, approvalId: "a1", effect: "read-only" as const },
      ],
    };
    const { store } = fakeStore({
      connection: "ready",
      runs: [
        run("ui-1", "Write it down", { taskId: "task-1", status: "awaiting_approval", transcript: [answered, tool], pending: [round] }),
      ],
    });
    const page = await mount(<App store={store} client={silent} workspaceId="default" />);
    // The first stop skips to the content, which can take focus.
    const skip = page.querySelector<HTMLAnchorElement>("a.skip-link");
    expect(skip?.textContent).toBe("Skip to content");
    await click(skip);
    expect(document.activeElement).toBe(page.querySelector("main#main"));
    // A turn is named by its prompt, for moving turn by turn.
    const named = page.querySelector("article.run")?.getAttribute("aria-labelledby");
    expect(named == null ? undefined : document.getElementById(named)?.textContent).toBe("you: Write it down");
    expect(document.title).toBe("(1) Chat – Write it down – tavi");
    expect(await violations(page)).toEqual([]);

    await click(page.querySelector(".chat-panel-rail .chat-panel-toggle"));
    expect(page.querySelector(".chat-panel")).not.toBeNull();
    expect(await violations(page)).toEqual([]);

    await click([...page.querySelectorAll(".bar .view")].find((button) => button.textContent === "Settings"));
    expect(document.title).toMatch(/Settings – Models – tavi$/);
    expect(await violations(page)).toEqual([]);
  });
});
