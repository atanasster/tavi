// @vitest-environment jsdom
import type { PluginUiEntry } from "@tavi/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "../../../src/features/chat-panel/ChatPanel.js";
import { isPluginPanelTab, pluginPanelTab } from "../../../src/features/chat-panel/tabs.js";
import { ChatPanelTop, TOP_SLOT_LINGER_MS, useOpenBrowserSession } from "../../../src/features/plugin-host/ChatPanelTop.js";
import { PluginPanelTab } from "../../../src/features/plugin-host/PluginPanelTab.js";
import type { PluginFrameClient } from "../../../src/features/plugin-host/PluginFrame.js";
import { contributionsForSlot, resolveContributions } from "../../../src/features/plugin-host/slots.js";
import { parseRoute, routePath } from "../../../src/features/shell/route.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { mount, rerender, unmountAll } from "../../support/dom.js";

/**
 * UI plugins in the chat panel: a
 * contributed tab after the built-in five, and the `chat.panel.top` slot.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountAll();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.useRealTimers();
});

const entry: PluginUiEntry = {
  pluginId: "acme.view",
  kind: "external",
  contentHash: "a".repeat(64),
  ui: {
    abi: "tavi.ui/1",
    contributions: [
      {
        id: "live",
        title: "Browser",
        document: "live.html",
        icon: "icon.svg",
        channels: ["browser.live"],
        disclosure: "Images.",
        placements: [
          { slot: "chat.panel.top", show: "while-active", height: { min: 140, default: 200, max: 400 } },
          { slot: "chat.panel.tab" },
        ],
      },
      { id: "pinned", title: "Pinned", document: "pinned.html", channels: [], placements: [{ slot: "chat.panel.top", show: "always" }] },
    ],
  },
};
const { contributions } = resolveContributions([entry], {});
const top = contributionsForSlot(contributions, "chat.panel.top");
const live: PluginFrameClient = { liveWatch: async () => ({ response: { ok: true } }) };

describe("a contributed tab", () => {
  it("is shown after the built-in five, by its title and icon, with its badge, and reached by the arrow keys", async () => {
    const onTab = vi.fn();
    const tab = pluginPanelTab("acme.view/live");
    const page = await mount(
      <ChatPanel
        open
        tab="details"
        title="Chat"
        onOpen={() => undefined}
        onTab={onTab}
        render={(shown) => <p>{shown}</p>}
        pluginTabs={[{ tab, label: "Browser", icon: "/plugin-ui/acme.view/x/icon.svg", badge: "dot" }]}
      />,
    );
    const tabs = [...page.querySelectorAll('[role="tab"]')].map((element) => element.getAttribute("aria-label"));
    // The badge is in the name: a screen reader hears "Browser, changed".
    expect(tabs).toEqual(["Activity", "Schedule", "Memory", "Instructions", "Details", "Browser, changed"]);
    const browser = page.querySelector('[role="tab"][aria-label="Browser, changed"]');
    expect(browser?.querySelector("img")?.getAttribute("src")).toBe("/plugin-ui/acme.view/x/icon.svg");
    expect(browser?.querySelector(".chat-panel-dot")).not.toBeNull();
    await act(async () =>
      page.querySelector('[role="tablist"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(onTab).toHaveBeenCalledWith(tab);

    await rerender(
      <ChatPanel
        open
        tab={tab}
        title="Chat"
        onOpen={() => undefined}
        onTab={onTab}
        render={(shown) => <p>{shown}</p>}
        pluginTabs={[{ tab, label: "Browser" }]}
      />,
    );
    expect(page.querySelector(".chat-panel-section")?.textContent).toBe("Browser");
    expect(page.querySelector(".chat-panel-body")?.textContent).toBe(tab);
    // Its plugin was disabled: the panel falls back to Activity.
    await rerender(<ChatPanel open tab={tab} title="Chat" onOpen={() => undefined} onTab={onTab} render={(shown) => <p>{shown}</p>} />);
    expect(page.querySelector(".chat-panel-section")?.textContent).toBe("Activity");
  });

  it("is in the rail too, and has its own address", async () => {
    const page = await mount(
      <ChatPanel
        open={false}
        tab="activity"
        title="Chat"
        onOpen={() => undefined}
        onTab={() => undefined}
        render={() => null}
        pluginTabs={[{ tab: pluginPanelTab("acme.view/live"), label: "Browser" }]}
      />,
    );
    expect(page.querySelector('.chat-panel-rail button[aria-label="Browser"]')).not.toBeNull();
    const route = parseRoute("/tasks/task-1/plugin:acme.view/live");
    expect(route).toMatchObject({ route: "chat", taskId: "task-1", panel: "plugin:acme.view/live" });
    expect(routePath(route)).toBe("/tasks/task-1/plugin:acme.view/live");
    expect(isPluginPanelTab("plugin:../x")).toBe(false);
    expect(parseRoute("/tasks/task-1/plugin:ACME/live").panel).toBeUndefined();
  });
});

describe("the chat.panel.top slot", () => {
  it("shows a while-active contribution only while the chat is active and for a moment after, and an always one at any time", async () => {
    vi.useFakeTimers();
    const element = (active: boolean) => (
      <ChatPanelTop
        items={top}
        client={live}
        context={{ workspaceId: "default", taskId: "t1" }}
        active={{ running: active, browser: active }}
        sheet="full"
      />
    );
    const page = await mount(element(false));
    const titles = () => [...page.querySelectorAll(".chat-panel-top-title")].map((node) => node.textContent);
    expect(titles()).toEqual(["Pinned"]);
    await rerender(element(true));
    expect(titles()).toEqual(["Browser", "Pinned"]);
    expect(page.querySelector('iframe[title="Browser"]')?.getAttribute("style")).toContain("height: 200px");
    await rerender(element(false));
    expect(titles()).toEqual(["Browser", "Pinned"]);
    await act(async () => vi.advanceTimersByTime(TOP_SLOT_LINGER_MS));
    expect(titles()).toEqual(["Pinned"]);
  });

  it("keeps a while-active browser view to the chat's browser, and any other contribution to the chat's run", async () => {
    const titles = (page: HTMLElement) =>
      [...page.querySelectorAll(".chat-panel-top-item iframe")].map((frame) => frame.getAttribute("title"));
    const plainLive = top.filter((item) => item.contribution.id === "live");
    const asView = plainLive.map((item) => ({ ...item, contribution: { ...item.contribution, role: "browser-view" as const } }));
    const running = { running: true, browser: false };
    const plain = await mount(
      <ChatPanelTop items={plainLive} client={live} context={{ workspaceId: "default", taskId: "t1" }} active={running} sheet="full" />,
    );
    expect(titles(plain)).toHaveLength(1);
    unmountAll();
    const view = await mount(
      <ChatPanelTop items={asView} client={live} context={{ workspaceId: "default", taskId: "t1" }} active={running} sheet="full" />,
    );
    expect(titles(view)).toHaveLength(0);
  });

  it("collapses and resizes within the placement's bounds, remembered for the browser tab", async () => {
    const element = (
      <ChatPanelTop
        items={top.slice(0, 1)}
        client={live}
        context={{ workspaceId: "default", taskId: "t1" }}
        active={{ running: true, browser: true }}
        sheet="full"
      />
    );
    const page = await mount(element);
    const handle = page.querySelector('[role="separator"]') as HTMLElement;
    for (let step = 0; step < 20; step += 1)
      await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    const hide = page.querySelector('button[aria-label="Hide Browser"]') as HTMLButtonElement;
    await act(async () => hide.click());
    expect(page.querySelector("iframe")?.hidden).toBe(true);
    expect(page.querySelector('button[aria-label="Show Browser"]')?.getAttribute("aria-expanded")).toBe("false");
    unmountAll();
    const again = await mount(element);
    expect(again.querySelector("iframe")?.hidden).toBe(true);
    expect(JSON.parse(window.sessionStorage.getItem("tavi.chatpanel.top.acme.view/live") ?? "{}")).toEqual({
      collapsed: true,
      height: 400,
    });
  });

  it("is hidden on the phone sheet at half height", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("720px"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    try {
      const page = await mount(
        <ChatPanelTop
          items={top.slice(0, 1)}
          client={live}
          context={{ workspaceId: "default", taskId: "t1" }}
          active={{ running: true, browser: true }}
          sheet="half"
        />,
      );
      expect(page.querySelector(".chat-panel-top-item")?.className).toContain("sheet-hidden");
      expect(page.querySelector("iframe")?.hidden).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("useOpenBrowserSession", () => {
  it("asks for the open sessions of the chat's task tree only while the chat runs", async () => {
    const asked: unknown[] = [];
    let items: unknown[] = [];
    const client: SettingsClient = { request: async (_command, payload) => (asked.push(payload), { ok: true, result: { items } }) };
    const seen: (string | undefined)[] = [];
    function Probe({ running, revision }: { readonly running: boolean; readonly revision: number }) {
      seen.push(useOpenBrowserSession(client, "default", "t1", running, revision));
      return null;
    }
    await mount(<Probe running={false} revision={0} />);
    expect(asked).toEqual([]);
    items = [
      {
        sessionId: "s1",
        taskId: "t2",
        principalId: "operator",
        openedAt: "2026-10-03T10:00:00.000Z",
        closedAt: null,
        closeReason: null,
        live: true,
        lastUrl: null,
        host: null,
        lastTitle: null,
        pages: 0,
        durationMs: 0,
      },
    ];
    await rerender(<Probe running revision={0} />);
    for (let tick = 0; tick < 4; tick += 1)
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    expect(asked).toEqual([{ action: "list", workspaceId: "default", taskId: "t1", tree: true, open: true, limit: 1 }]);
    expect(seen.at(-1)).toBe("s1");
    items = [];
    await rerender(<Probe running revision={1} />);
    for (let tick = 0; tick < 4; tick += 1)
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    expect(seen.at(-1)).toBeUndefined();
  });
});

describe("the top slot's takeover", () => {
  it("offers the host's own Take control on the browser view only, and shows itself expanded when the agent asks for a person", async () => {
    const viewTop = top.map((item) =>
      item.contribution.id === "live" ? { ...item, contribution: { ...item.contribution, role: "browser-view" as const } } : item,
    );
    const taken = vi.fn();
    window.sessionStorage.setItem(`tavi.chatpanel.top.${viewTop[0]?.pluginId}/live`, JSON.stringify({ collapsed: true }));
    const element = (attention: boolean) => (
      <ChatPanelTop
        items={viewTop}
        client={live}
        context={{ workspaceId: "default", taskId: "t1" }}
        active={{ running: false, browser: false }}
        sheet="full"
        onTakeOver={taken}
        attention={attention}
      />
    );
    const page = await mount(element(false));
    // Not active, not asked: only the always-shown one.
    expect([...page.querySelectorAll(".chat-panel-top-title")].map((node) => node.textContent)).toEqual(["Pinned"]);
    await rerender(element(true));
    const browserItem = page.querySelector('section[aria-label="Browser"]');
    expect(browserItem?.className).toContain("needs-you");
    expect(browserItem?.className).not.toContain("collapsed");
    const takeButtons = [...page.querySelectorAll("button")].filter((button) => button.textContent === "Take control");
    expect(takeButtons).toHaveLength(1);
    await act(async () => takeButtons[0]?.click());
    expect(taken).toHaveBeenCalledOnce();
    window.sessionStorage.clear();
  });

  it("shows itself expanded when it opens with the agent already asking for a person", async () => {
    const viewTop = top.map((item) =>
      item.contribution.id === "live" ? { ...item, contribution: { ...item.contribution, role: "browser-view" as const } } : item,
    );
    window.sessionStorage.setItem(`tavi.chatpanel.top.${viewTop[0]?.pluginId}/live`, JSON.stringify({ collapsed: true }));
    const page = await mount(
      <ChatPanelTop
        items={viewTop}
        client={live}
        context={{ workspaceId: "default", taskId: "t1" }}
        active={{ running: false, browser: false }}
        sheet="full"
        onTakeOver={() => undefined}
        attention
      />,
    );
    const browserItem = page.querySelector('section[aria-label="Browser"]');
    expect(browserItem?.className).toContain("needs-you");
    expect(browserItem?.className).not.toContain("collapsed");
    window.sessionStorage.clear();
  });
});

describe("the browser tab's Expand", () => {
  const tabs = contributionsForSlot(contributions, "chat.panel.tab");
  const browser = { ...tabs[0]!, contribution: { ...tabs[0]!.contribution, role: "browser-view" as const } };
  const element = (expanded: boolean, onExpanded: (expanded: boolean) => void, item: (typeof tabs)[number] = browser) => (
    <PluginPanelTab
      item={item}
      client={live}
      context={{ workspaceId: "default", taskId: "t1" }}
      visible
      expanded={expanded}
      onExpanded={onExpanded}
      attention={false}
      onNavigate={() => undefined}
      onShortcut={() => undefined}
      onBadge={() => undefined}
    />
  );

  it("shows the same frame large over the page, and shrinks it from its button or the backdrop", async () => {
    let expanded = false;
    const onExpanded = vi.fn((next: boolean) => {
      expanded = next;
    });
    const page = await mount(element(expanded, onExpanded));
    const frame = page.querySelector("iframe");
    expect(page.querySelector(".chat-panel-plugin-tab.expanded")).toBeNull();
    await act(async () => page.querySelector<HTMLButtonElement>('button[aria-label="Expand the browser view"]')?.click());
    expect(onExpanded).toHaveBeenLastCalledWith(true);
    const behind = document.body.appendChild(document.createElement("p"));
    await rerender(element(expanded, onExpanded));
    const large = page.querySelector(".chat-panel-plugin-tab.expanded");
    expect(large?.getAttribute("role")).toBe("dialog");
    expect(large?.getAttribute("aria-label")).toBe("Browser");
    expect(large?.getAttribute("aria-modal")).toBe("true");
    // Focus is inside the view, and Tab from its last stop wraps to its first.
    expect(large?.contains(document.activeElement)).toBe(true);
    const shrink = page.querySelector<HTMLButtonElement>('button[aria-label="Shrink the browser view"]');
    page.querySelector("iframe")?.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true, bubbles: true });
    await act(async () => page.querySelector("iframe")?.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(shrink);
    // A Tab inside the plugin's frame never reaches the page: the guards either side send focus round.
    const [before, after] = [...(large?.querySelectorAll<HTMLElement>(".focus-guard") ?? [])];
    await act(async () => after?.focus());
    expect(document.activeElement).toBe(shrink);
    await act(async () => before?.focus());
    expect(document.activeElement).toBe(page.querySelector("iframe"));
    // The page behind is inert while it is large; the backdrop that shrinks it on a press is not.
    expect(behind.hasAttribute("inert")).toBe(true);
    expect(page.querySelector(".chat-panel-plugin-backdrop")?.hasAttribute("inert")).toBe(false);
    // Forward Tab from the view itself (where focus lands as it opens) goes to its first stop.
    (large as HTMLElement | null)?.focus();
    const fromView = new KeyboardEvent("keydown", { key: "Tab", cancelable: true, bubbles: true });
    await act(async () => large?.dispatchEvent(fromView));
    expect(fromView.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(shrink);
    // A modal over it (the takeover) owns Escape: the view stays large.
    const over = document.body.appendChild(document.createElement("div"));
    over.setAttribute("aria-modal", "true");
    const calls = onExpanded.mock.calls.length;
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true })));
    expect(onExpanded.mock.calls.length).toBe(calls);
    over.remove();
    // Moved by style alone: the frame, and its stream, are the ones it had.
    expect(page.querySelector("iframe")).toBe(frame);
    await act(async () => page.querySelector<HTMLButtonElement>('button[aria-label="Shrink the browser view"]')?.click());
    expect(onExpanded).toHaveBeenLastCalledWith(false);
    await rerender(element(false, onExpanded));
    expect(behind.hasAttribute("inert")).toBe(false);
    behind.remove();
    await rerender(element(true, onExpanded));
    await act(async () => page.querySelector<HTMLElement>(".chat-panel-plugin-backdrop")?.click());
    expect(onExpanded).toHaveBeenCalledTimes(3);
    // Escape shrinks it, ahead of a tooltip's own capture, and is handled so nothing behind acts on it.
    document.addEventListener("keydown", (event) => event.stopPropagation(), { capture: true, once: true });
    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    await act(async () => document.body.dispatchEvent(escape));
    expect(onExpanded).toHaveBeenCalledTimes(4);
    expect(escape.defaultPrevented).toBe(true);
  });

  it("is the browser view's alone", async () => {
    const page = await mount(element(true, () => undefined, tabs[0]!));
    expect(page.querySelector('button[aria-label="Expand the browser view"]')).toBeNull();
    expect(page.querySelector(".chat-panel-plugin-tab.expanded")).toBeNull();
  });
});
