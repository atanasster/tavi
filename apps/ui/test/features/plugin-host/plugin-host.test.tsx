// @vitest-environment jsdom
import { initialRunState, type LiveWatchOptions } from "@tavi/client";
import {
  PLUGIN_UI_HIDDEN_UNWATCH_MS,
  PLUGIN_UI_MAX_MESSAGES_PER_SECOND,
  PLUGIN_UI_THEME_TOKENS,
  type BrowserLiveMessage,
  type PluginUiEntry,
} from "@tavi/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginFrame, PluginFramesCoveredContext, type PluginFrameClient } from "../../../src/features/plugin-host/PluginFrame.js";
import { usePluginContributions } from "../../../src/features/plugin-host/contributions.js";
import { floodedPlugins } from "../../../src/features/plugin-host/floods.js";
import { contributionsForSlot, resolveContributions, type ResolvedContribution } from "../../../src/features/plugin-host/slots.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { chatPluginState, chatPluginStatus } from "../../../src/features/chat/store/runs.js";
import type { CanvasRun } from "../../../src/features/chat/store/types.js";
import { flush, rerender, settledBy, unmountAll } from "../../support/dom.js";

/**
 * The canvas's UI plugin host: which
 * contributions show where, and the host side of the `tavi.ui/1` ABI.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

/** What was asked answered: microtasks only, as tests here fake the clock. */
const { settle, mount } = settledBy(() => flush());

const hash = (digit: string) => digit.repeat(64);
const view = (pluginId: string, kind: "builtin" | "external", contributions: PluginUiEntry["ui"]["contributions"]): PluginUiEntry => ({
  pluginId,
  kind,
  contentHash: hash(pluginId === "tavi.browserview" ? "b" : "a"),
  ui: { abi: "tavi.ui/1", contributions },
});
const browserView = (id = "live") => ({
  id,
  role: "browser-view" as const,
  title: "Browser",
  document: "live.html",
  channels: ["browser.live" as const],
  placements: [
    { slot: "chat.panel.top" as const, show: "while-active" as const, height: { min: 140, default: 220, max: 480 } },
    { slot: "chat.panel.tab" as const },
  ],
  disclosure: "Receives live images.",
});
const extra = { id: "notes", title: "Notes", document: "notes.html", channels: [], placements: [{ slot: "chat.panel.tab" as const }] };
const BUILTIN = view("tavi.browserview", "builtin", [browserView()]);
const ACME = view("acme.view", "external", [browserView(), extra]);

describe("which contributions show where", () => {
  it("fills a role with the built-in, the chosen plugin, or nothing, and keeps role-less ones additive", () => {
    const keys = (settings: Parameters<typeof resolveContributions>[1]) =>
      resolveContributions([BUILTIN, ACME], settings).contributions.map((resolved) => `${resolved.pluginId}/${resolved.contribution.id}`);
    expect(keys({})).toEqual(["tavi.browserview/live", "acme.view/notes"]);
    expect(keys({ uiRoles: { "browser-view": "acme.view" } })).toEqual(["acme.view/live", "acme.view/notes"]);
    expect(keys({ uiRoles: { "browser-view": "off" } })).toEqual(["acme.view/notes"]);
  });

  it("falls back to the built-in, and says so, when the chosen plugin cannot fill the role", () => {
    const gone = resolveContributions([BUILTIN], { uiRoles: { "browser-view": "acme.view" } });
    expect(gone.contributions.map((resolved) => resolved.pluginId)).toEqual(["tavi.browserview"]);
    expect(gone.fallbacks).toEqual([{ role: "browser-view", wanted: "acme.view", using: "tavi.browserview" }]);
    const nothing = resolveContributions([view("acme.view", "external", [extra])], { uiRoles: { "browser-view": "acme.view" } });
    expect(nothing.fallbacks).toEqual([{ role: "browser-view", wanted: "acme.view" }]);
  });

  it("places a contribution where the operator chose, or hides it", () => {
    const { contributions } = resolveContributions([BUILTIN, ACME], {
      uiPlacements: { "tavi.browserview/live": { slots: [{ slot: "chat.panel.tab" }] }, "acme.view/notes": "hidden" },
    });
    expect(contributionsForSlot(contributions, "chat.panel.top")).toEqual([]);
    expect(contributionsForSlot(contributions, "chat.panel.tab").map((resolved) => [resolved.pluginId, resolved.placement])).toEqual([
      ["tavi.browserview", { slot: "chat.panel.tab" }],
    ]);
  });
});

/** A client whose live watches a test drives. */
function fakeLiveClient() {
  const watches: { taskId: string; options: LiveWatchOptions; closed: boolean }[] = [];
  const state = { refuse: false };
  const client: PluginFrameClient = {
    liveWatch: async (taskId, options) => {
      const watch = { taskId, options, closed: false };
      watches.push(watch);
      if (state.refuse) return { response: { ok: false, error: { code: "NOT_FOUND", message: "no task" } } };
      return {
        response: { ok: true },
        watch: {
          get ended() {
            return watch.closed;
          },
          close: async () => void (watch.closed = true),
          control: async () => ({ ok: true }),
        },
      };
    },
  };
  return { client, watches, state };
}

const resolvedOf = (entry: PluginUiEntry, index = 0): ResolvedContribution => {
  const contribution = entry.ui.contributions[index];
  if (contribution === undefined) throw new Error("no contribution");
  return {
    pluginId: entry.pluginId,
    contentHash: entry.contentHash,
    builtin: entry.kind === "builtin",
    contribution,
    placements: contribution.placements,
  };
};

async function frameWith(props: Partial<React.ComponentProps<typeof PluginFrame>> = {}) {
  const live = fakeLiveClient();
  const calls = { heights: [] as number[], navigations: [] as unknown[], shortcuts: [] as string[], badges: [] as unknown[], floods: 0 };
  const element = (visible: boolean, overrides: Partial<React.ComponentProps<typeof PluginFrame>> = {}) => (
    <PluginFrame
      resolved={resolvedOf(ACME)}
      slot="chat.panel.top"
      placement={browserView().placements[0]}
      context={{ workspaceId: "default", taskId: "task-1" }}
      client={live.client}
      visible={visible}
      onRequestHeight={(px) => calls.heights.push(px)}
      onNavigate={(target) => calls.navigations.push(target)}
      onShortcut={(key) => calls.shortcuts.push(key)}
      onBadge={(badge) => calls.badges.push(badge)}
      onFlood={() => (calls.floods += 1)}
      {...props}
      {...overrides}
    />
  );
  const page = await mount(element(true));
  const iframe = page.querySelector("iframe");
  if (iframe === null || iframe.contentWindow === null) throw new Error("no frame");
  const posted: unknown[] = [];
  vi.spyOn(iframe.contentWindow, "postMessage").mockImplementation((message: unknown) => void posted.push(message));
  const send = async (data: unknown, source: MessageEventSource | null = iframe.contentWindow): Promise<void> => {
    await act(async () => window.dispatchEvent(new MessageEvent("message", { data, source })));
    await settle();
  };
  const redraw = async (visible: boolean, overrides: Partial<React.ComponentProps<typeof PluginFrame>> = {}) => {
    await rerender(element(visible, overrides));
    await settle();
  };
  return { iframe, posted, send, live, calls, rerender: redraw };
}

const abi = "tavi.ui/1";
const frameMessage: BrowserLiveMessage = {
  kind: "frame",
  sessionId: "s1",
  mime: "image/jpeg",
  data: "/9j/",
  width: 16,
  height: 9,
  metadata: { deviceWidth: 16, deviceHeight: 9, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 },
  at: "2026-10-03T10:00:00.000Z",
  source: "live",
};

describe("PluginFrame", () => {
  it("frames the approved document in a sandbox that allows scripts and nothing else", async () => {
    const { iframe } = await frameWith();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("allow")).toBe("");
    expect(iframe.getAttribute("src")).toBe(`/plugin-ui/acme.view/${hash("a")}/live.html`);
    expect(iframe.getAttribute("title")).toBe("Browser");
  });

  it("passes the canvas's theme tokens in init: colours, type, spacing, radii and weights, and nothing else", async () => {
    const tokens = {
      "--primary": "164 55% 27%",
      "--text-sm": "12px",
      "--space-2": "8px",
      "--radius-full": "9999px",
      "--weight-semibold": "600",
    };
    for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
    document.documentElement.style.setProperty("--z-popover", "100");
    try {
      const { posted, send } = await frameWith();
      await send({ abi, type: "ready" });
      expect(posted[0]).toMatchObject({ type: "init", theme: { tokens } });
      expect((posted[0] as { theme: { tokens: Record<string, string> } }).theme.tokens).not.toHaveProperty("--z-popover");
      expect(PLUGIN_UI_THEME_TOKENS).toEqual(expect.arrayContaining(Object.keys(tokens)));
    } finally {
      for (const name of [...Object.keys(tokens), "--z-popover"]) document.documentElement.style.removeProperty(name);
    }
  });

  it("answers ready with init, and reads messages only from its own frame, valid and within bounds", async () => {
    const { posted, send, calls } = await frameWith();
    await send({ abi, type: "ready" });
    expect(posted[0]).toMatchObject({
      abi,
      type: "init",
      pluginId: "acme.view",
      contributionId: "live",
      slot: "chat.panel.top",
      context: { workspaceId: "default", taskId: "task-1" },
      channels: ["browser.live"],
      visible: true,
    });
    // A second ready is a new document in the frame (a reload): it is initialised again.
    await send({ abi, type: "ready" });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({ type: "init" });
    await send({ abi, type: "requestHeight", px: 9000 });
    await send({ abi, type: "requestHeight", px: 10 });
    expect(calls.heights).toEqual([480, 140]);
    await send({ abi, type: "requestHeight", px: 300 }, window);
    await send({ abi, type: "navigate", target: { to: "window.open", url: "https://evil.example" } });
    await send({ abi, type: "navigate", target: { to: "tool-call", callId: "call-1" }, padding: "x".repeat(70_000) });
    expect(calls.heights).toEqual([480, 140]);
    expect(calls.navigations).toEqual([]);
    await send({ abi, type: "navigate", target: { to: "tool-call", callId: "call-1" } });
    // A shortcut the reader did not press in the frame is dropped: a plugin cannot press Escape (stop the turn) on its own.
    await send({ abi, type: "shortcut", key: "Escape" });
    expect(calls.shortcuts).toEqual([]);
    document.querySelector("iframe")?.focus();
    await send({ abi, type: "shortcut", key: "Escape" });
    await send({ abi, type: "badge", dot: true });
    expect(calls.navigations).toEqual([{ to: "tool-call", callId: "call-1" }]);
    expect(calls.shortcuts).toEqual(["Escape"]);
    expect(calls.badges).toEqual([{ count: undefined, dot: true }]);
  });

  it("clears a key its plugin's values no longer hold, as after Forget, without another context", async () => {
    const PANEL = view("acme.heartbeat", "external", [
      {
        id: "panel",
        title: "Panel",
        document: "panel.html",
        channels: ["mod.state"],
        placements: [{ slot: "center.heartbeat" }],
        disclosure: "Receives what its checks publish.",
      },
    ]);
    const { posted, send, rerender } = await frameWith({ resolved: resolvedOf(PANEL), modState: { rules: 3, seen: 1 } });
    await send({ abi, type: "ready" });
    await send({ abi, type: "watch", channel: "mod.state" });
    const before = posted.length;
    await rerender(true, { resolved: resolvedOf(PANEL), modState: { rules: 3 } });
    expect(posted.slice(before)).toEqual([{ abi, type: "channel", channel: "mod.state", seq: 3, message: { key: "seen", value: null } }]);
  });

  it("sends what its plugin published on mod.state once watched, then each change, and again for another chat", async () => {
    const MODS = view("acme.mod", "external", [
      {
        id: "plan",
        title: "Plan",
        document: "plan.html",
        channels: ["mod.state"],
        placements: [{ slot: "chat.panel.tab" }],
        disclosure: "Receives its plan.",
      },
    ]);
    const undeclared = await frameWith({ modState: { steps: 1 } });
    await undeclared.send({ abi, type: "ready" });
    await undeclared.send({ abi, type: "watch", channel: "mod.state" });
    expect(undeclared.posted.filter((message) => (message as { type?: string }).type === "channel")).toEqual([]);
    unmountAll();

    const { posted, send, rerender } = await frameWith({ resolved: resolvedOf(MODS), modState: { steps: ["read"] } });
    await send({ abi, type: "ready" });
    await send({ abi, type: "watch", channel: "mod.state" });
    expect(posted.at(-1)).toEqual({ abi, type: "channel", channel: "mod.state", seq: 1, message: { key: "steps", value: ["read"] } });
    await rerender(true, { resolved: resolvedOf(MODS), modState: { steps: ["read", "write"], done: false } });
    expect(posted.slice(-2)).toEqual([
      { abi, type: "channel", channel: "mod.state", seq: 2, message: { key: "steps", value: ["read", "write"] } },
      { abi, type: "channel", channel: "mod.state", seq: 3, message: { key: "done", value: false } },
    ]);
    // Another chat: its context first, then the old chat's key it lacks cleared, then each of its values, once.
    const before = posted.length;
    await rerender(true, {
      resolved: resolvedOf(MODS),
      context: { workspaceId: "default", taskId: "task-2" },
      modState: { steps: ["plan"] },
    });
    expect(posted.slice(before).filter((message) => ["context", "channel"].includes((message as { type?: string }).type ?? ""))).toEqual([
      { abi, type: "context", context: { workspaceId: "default", taskId: "task-2" } },
      { abi, type: "channel", channel: "mod.state", seq: 4, message: { key: "done", value: null } },
      { abi, type: "channel", channel: "mod.state", seq: 5, message: { key: "steps", value: ["plan"] } },
    ]);
    await send({ abi, type: "unwatch", channel: "mod.state" });
    await rerender(true, { resolved: resolvedOf(MODS), context: { workspaceId: "default", taskId: "task-2" }, modState: { steps: [] } });
    expect(posted.filter((message) => (message as { type?: string }).type === "channel")).toHaveLength(5);
  });

  it("merges a chat's turns into what its plugins published, the newest value per key", () => {
    const turn = (taskId: string, pluginState: Record<string, Record<string, unknown>>, continues?: string): CanvasRun => ({
      id: taskId,
      prompt: "",
      ...(continues === undefined ? {} : { continues }),
      run: { ...initialRunState({ taskId }), pluginState },
      roundCalls: {},
      deciding: undefined,
      aborting: false,
    });
    const runs = [
      turn("task-1", { "acme.mod": { plan: ["a"], done: false } }),
      turn("task-9", { "acme.mod": { plan: ["other chat"] } }),
      turn("task-1b", { "acme.mod": { done: true } }, "task-1"),
    ];
    expect(chatPluginState(runs, "task-1")).toEqual({ "acme.mod": { plan: ["a"], done: true } });
    expect(chatPluginState(runs, undefined)).toEqual({});
  });

  it("lays a chat's turns' status lines over the ones before, until a turn clears one", () => {
    const turn = (
      id: string,
      taskId: string,
      pluginStatus: Record<string, string>,
      seen?: readonly string[],
      continues?: string,
    ): CanvasRun => ({
      id,
      prompt: "",
      ...(continues === undefined ? {} : { continues }),
      ...(seen === undefined ? {} : { pluginStatusSeen: seen }),
      run: { ...initialRunState({ taskId }), pluginStatus },
      roundCalls: {},
      deciding: undefined,
      aborting: false,
    });
    const runs = [
      turn("a", "task-1", { "acme.tally": "1 call", "acme.todo": "2 left" }, ["acme.tally", "acme.todo"]),
      turn("b", "task-9", { "acme.tally": "other chat" }, ["acme.tally"]),
      // A turn that said nothing of status keeps both; one that cleared a line drops it.
      turn("c", "task-1", {}, undefined, "task-1"),
      turn("d", "task-1", { "acme.tally": "4 calls" }, ["acme.tally", "acme.todo"], "task-1"),
    ];
    expect(chatPluginStatus(runs.slice(0, 3), "task-1")).toEqual({ "acme.tally": "1 call", "acme.todo": "2 left" });
    expect(chatPluginStatus(runs, "task-1")).toEqual({ "acme.tally": "4 calls" });
    expect(chatPluginStatus(runs, undefined)).toEqual({});
  });

  it("watches only a declared channel, relays its frames with a seq, and passes the plugin's ack on as credit", async () => {
    const plain = await frameWith({ resolved: resolvedOf(ACME, 1) });
    await plain.send({ abi, type: "watch", channel: "browser.live" });
    expect(plain.live.watches).toEqual([]);
    unmountAll();

    const { posted, send, live } = await frameWith();
    await send({ abi, type: "ready" });
    await send({ abi, type: "watch", channel: "browser.live", maxWidth: 800 });
    expect(live.watches.map((watch) => [watch.taskId, watch.options.workspaceId, watch.options.maxWidth])).toEqual([
      ["task-1", "default", 800],
    ]);
    const ack = vi.fn();
    await act(async () => live.watches[0]?.options.onMessage(frameMessage, ack));
    expect(posted.at(-1)).toEqual({ abi, type: "channel", channel: "browser.live", seq: 1, message: frameMessage });
    await send({ abi, type: "ack", seq: 2 });
    expect(ack).not.toHaveBeenCalled();
    await send({ abi, type: "ack", seq: 1 });
    await send({ abi, type: "ack", seq: 1 });
    expect(ack).toHaveBeenCalledTimes(1);
    // Anything but a frame needs no credit: acknowledged at once.
    const newsAck = vi.fn();
    await act(async () =>
      live.watches[0]?.options.onMessage({ kind: "navigated", sessionId: "s1", url: "https://example.com/", epoch: 1 }, newsAck),
    );
    expect(newsAck).toHaveBeenCalledTimes(1);
    expect(posted.at(-1)).toMatchObject({ type: "channel", seq: 2, message: { kind: "navigated" } });
    await send({ abi, type: "unwatch", channel: "browser.live" });
    expect(live.watches[0]?.closed).toBe(true);
  });

  it("moves its watch to a new chat, telling the page, and opens again a watch the owner refused or ended", async () => {
    const { posted, send, live, rerender } = await frameWith();
    await send({ abi, type: "ready" });
    await send({ abi, type: "watch", channel: "browser.live" });
    await rerender(true, { context: { workspaceId: "default", taskId: "task-2" } });
    expect(posted.at(-1)).toEqual({ abi, type: "context", context: { workspaceId: "default", taskId: "task-2" } });
    expect(live.watches.map((watch) => [watch.taskId, watch.closed])).toEqual([
      ["task-1", true],
      ["task-2", false],
    ]);

    // The owner ends it: the next showing opens it again.
    await act(async () => live.watches[1]?.options.onEnd?.(new Error("gone")));
    await rerender(false, { context: { workspaceId: "default", taskId: "task-2" } });
    await rerender(true, { context: { workspaceId: "default", taskId: "task-2" } });
    expect(live.watches).toHaveLength(3);

    // Refused: not held as open, so a later showing tries again.
    live.state.refuse = true;
    await rerender(true, { context: { workspaceId: "default", taskId: "task-3" } });
    expect(live.watches).toHaveLength(4);
    live.state.refuse = false;
    await rerender(false, { context: { workspaceId: "default", taskId: "task-3" } });
    await rerender(true, { context: { workspaceId: "default", taskId: "task-3" } });
    expect(live.watches).toHaveLength(5);
    expect(live.watches[4]?.taskId).toBe("task-3");
  });

  it("tells a hidden page so, ends its watch after the grace, and watches again once shown", async () => {
    vi.useFakeTimers();
    const { posted, send, live, rerender } = await frameWith();
    await send({ abi, type: "ready" });
    await send({ abi, type: "watch", channel: "browser.live" });
    await rerender(false);
    expect(posted.at(-1)).toEqual({ abi, type: "visibility", visible: false });
    expect(live.watches[0]?.closed).toBe(false);
    await act(async () => vi.advanceTimersByTime(PLUGIN_UI_HIDDEN_UNWATCH_MS));
    await settle();
    expect(live.watches[0]?.closed).toBe(true);
    await rerender(true);
    expect(posted.at(-1)).toEqual({ abi, type: "visibility", visible: true });
    expect(live.watches).toHaveLength(2);
    expect(live.watches[1]?.closed).toBe(false);
  });

  it("hides every frame the takeover covers, so each ends its watch instead of streaming behind it", async () => {
    vi.useFakeTimers();
    const live = fakeLiveClient();
    const element = (covered: boolean) => (
      <PluginFramesCoveredContext.Provider value={covered}>
        <PluginFrame
          resolved={resolvedOf(ACME)}
          slot="center.browser"
          context={{ workspaceId: "default", taskId: "task-1", sessionId: "s1" }}
          client={live.client}
          visible
        />
      </PluginFramesCoveredContext.Provider>
    );
    const page = await mount(element(false));
    const iframe = page.querySelector("iframe");
    if (iframe === null || iframe.contentWindow === null) throw new Error("no frame");
    const posted: unknown[] = [];
    vi.spyOn(iframe.contentWindow, "postMessage").mockImplementation((message: unknown) => void posted.push(message));
    for (const data of [
      { abi, type: "ready" },
      { abi, type: "watch", channel: "browser.live" },
    ]) {
      await act(async () => window.dispatchEvent(new MessageEvent("message", { data, source: iframe.contentWindow })));
      await settle();
    }
    expect(live.watches).toHaveLength(1);
    await rerender(element(true));
    expect(posted.at(-1)).toEqual({ abi, type: "visibility", visible: false });
    await act(async () => vi.advanceTimersByTime(PLUGIN_UI_HIDDEN_UNWATCH_MS));
    await settle();
    expect(live.watches[0]?.closed).toBe(true);
    await rerender(element(false));
    await settle();
    expect(live.watches).toHaveLength(2);
  });

  it("tells the page when the browser tab itself is hidden", async () => {
    const { posted, send } = await frameWith();
    await send({ abi, type: "ready" });
    const state = { value: "hidden" };
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state.value });
    try {
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(posted.at(-1)).toEqual({ abi, type: "visibility", visible: false });
      state.value = "visible";
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(posted.at(-1)).toEqual({ abi, type: "visibility", visible: true });
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (descriptor !== undefined) Object.defineProperty(Document.prototype, "visibilityState", descriptor);
    }
  });

  it("pauses a plugin that floods the host, and ends its watch on unmount", async () => {
    const { send, live, calls } = await frameWith();
    await send({ abi, type: "ready" });
    await send({ abi, type: "watch", channel: "browser.live" });
    for (let index = 0; index < PLUGIN_UI_MAX_MESSAGES_PER_SECOND; index += 1)
      await act(async () =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { abi, type: "badge", count: 1 },
            source: document.querySelector("iframe")?.contentWindow ?? null,
          }),
        ),
      );
    await settle();
    expect(calls.floods).toBe(1);
    // Settings → Plugins says which one was paused.
    expect(floodedPlugins().has("acme.view/live")).toBe(true);
    expect(live.watches[0]?.closed).toBe(true);
    await send({ abi, type: "shortcut", key: "Escape" });
    expect(calls.shortcuts).toEqual([]);

    const again = await frameWith();
    await again.send({ abi, type: "ready" });
    await again.send({ abi, type: "watch", channel: "browser.live" });
    unmountAll();
    await Promise.resolve();
    expect(again.live.watches[0]?.closed).toBe(true);
  });
});

describe("usePluginContributions", () => {
  it("reads the contributions again when the plugin change kind moves, and drops a plugin no longer loadable", async () => {
    let entries: PluginUiEntry[] = [BUILTIN, ACME];
    const client: SettingsClient = {
      request: async (command) =>
        command === "plugins"
          ? { ok: true, result: { entries } }
          : {
              ok: true,
              result: {
                workspaceId: "default",
                revision: 1,
                settings: { uiRoles: { "browser-view": "acme.view" } },
                effective: { timezone: "UTC" },
                hostTimezone: "UTC",
              },
            },
    };
    const seen: string[][] = [];
    function Probe({ revision }: { readonly revision: number }) {
      const { contributions, fallbacks } = usePluginContributions(client, "default", true, revision);
      seen.push([
        ...contributions.map((resolved) => `${resolved.pluginId}/${resolved.contribution.id}`),
        ...fallbacks.map((fallback) => `fallback:${fallback.wanted}`),
      ]);
      return null;
    }
    await mount(<Probe revision={0} />);
    expect(seen.at(-1)).toEqual(["acme.view/live", "acme.view/notes"]);
    entries = [BUILTIN];
    await rerender(<Probe revision={1} />);
    await settle();
    expect(seen.at(-1)).toEqual(["tavi.browserview/live", "fallback:acme.view"]);
  });
});
