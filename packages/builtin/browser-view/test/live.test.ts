// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PluginToHostMessageSchema, PluginUiSchema, type BrowserLiveMessage } from "@tavi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BROWSER_VIEW_MANIFEST } from "../src/manifest.js";
import { addressOf, startViewer } from "../src/live.js";

/**
 * The built-in browser view, driven as the
 * canvas drives it: `tavi.ui/1` messages in, and the messages it sends back.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(join(root, "ui", "live.html"), "utf8");
const abi = "tavi.ui/1";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

function viewer() {
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? "";
  const sent: unknown[] = [];
  stop = startViewer({
    window,
    document,
    host: { postMessage: (message) => void sent.push(message) },
    fromHost: () => true,
    decode: async () => undefined,
  }).stop;
  const post = async (message: Record<string, unknown>): Promise<void> => {
    window.dispatchEvent(new MessageEvent("message", { data: { abi, ...message } }));
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
  };
  let seq = 0;
  const live = (message: BrowserLiveMessage) => post({ type: "channel", channel: "browser.live", seq: (seq += 1), message });
  const $ = (name: string) => document.querySelector(`[data-${name}]`) as HTMLElement;
  return { sent, post, live, $ };
}

const metadata = { deviceWidth: 1000, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 };
const frame = (sessionId: string, data = "/9j/AA", source: "live" | "thumbnail" = "live"): BrowserLiveMessage => ({
  kind: "frame",
  sessionId,
  mime: "image/jpeg",
  data,
  width: 640,
  height: 384,
  metadata,
  at: "2026-10-03T10:00:00.000Z",
  source,
});
const init = {
  type: "init",
  pluginId: "tavi.browserview",
  contributionId: "live",
  slot: "chat.panel.top",
  context: { workspaceId: "default", taskId: "t1" },
  channels: ["browser.live"],
  theme: { tokens: { "--primary": "1 2% 3%" }, colorScheme: "dark" },
  size: { width: 300, height: 200 },
  reducedMotion: false,
  visible: true,
};

describe("the built-in browser view", () => {
  it("is described by a valid ui block, and says ready, then watches its channel with the theme applied", async () => {
    expect(PluginUiSchema.safeParse(BROWSER_VIEW_MANIFEST.ui).success).toBe(true);
    const { sent, post } = viewer();
    expect(sent).toEqual([{ abi, type: "ready" }]);
    await post(init);
    expect(sent[1]).toMatchObject({ abi, type: "watch", channel: "browser.live" });
    for (const message of sent) expect(PluginToHostMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("1 2% 3%");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("shows each frame, then acknowledges it, with the address, title and a Live chip; says each navigation", async () => {
    vi.useFakeTimers();
    const { sent, post, live, $ } = viewer();
    await post(init);
    await live({ kind: "session", sessionId: "s1", taskId: "t1", state: "open", url: "https://example.com/", openedByCallId: "call-1" });
    expect($("letter").textContent).toBe("E");
    await live({ kind: "navigated", sessionId: "s1", url: "https://www.example.com/news", title: "News", epoch: 1 });
    await live(frame("s1"));
    const image = $("frame") as HTMLImageElement;
    expect(image.hidden).toBe(false);
    expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/AA");
    expect(image.alt).toBe("News");
    expect(sent.at(-1)).toEqual({ abi, type: "ack", seq: 3 });
    expect($("chip").textContent).toBe("Live");
    expect($("host").textContent).toBe("www.example.com");
    expect($("path").textContent).toBe("/news");
    vi.advanceTimersByTime(100);
    expect($("announce").textContent).toBe("Now on www.example.com/news, News");
    // Open in transcript goes to the call behind the session.
    ($("transcript") as HTMLButtonElement).click();
    expect(sent.at(-1)).toEqual({ abi, type: "navigate", target: { to: "tool-call", callId: "call-1" } });
  });

  it("asks for wider frames once it is drawn wider (expanded in place), never stays a blurry strip", async () => {
    const { sent, post } = viewer();
    const stage = document.querySelector("[data-stage]") as HTMLElement;
    let drawn = 300;
    Object.defineProperty(stage, "clientWidth", { configurable: true, get: () => drawn });
    await post(init);
    const watches = () => sent.filter((message) => (message as { type?: string }).type === "watch") as { maxWidth: number }[];
    expect(watches()).toHaveLength(1);
    drawn = 310;
    await post({ type: "size", size: { width: 310, height: 200 } });
    // A few pixels are not worth new frames.
    expect(watches()).toHaveLength(1);
    drawn = 900;
    await post({ type: "size", size: { width: 900, height: 600 } });
    expect(watches()).toHaveLength(2);
    expect(watches()[1]?.maxWidth).toBeGreaterThan(watches()[0]?.maxWidth ?? 0);
  });

  it("draws no site letter over a hidden page's notice, nor a digit for an address", async () => {
    const { post, live, $ } = viewer();
    await post(init);
    await live({ kind: "session", sessionId: "s1", taskId: "t1", state: "open", url: "https://shop.example/login" });
    expect($("letter").textContent).toBe("S");
    await live({ kind: "hidden", sessionId: "s1", reason: "password-field" });
    expect($("letter").hidden).toBe(true);
    expect($("notice").hidden).toBe(false);
    stop?.();
    const local = viewer();
    await local.post(init);
    await local.live({ kind: "session", sessionId: "s2", taskId: "t1", state: "open", url: "http://127.0.0.1:8080/" });
    expect(local.$("letter").hidden).toBe(true);
  });

  it("hides a sensitive page's picture, and says so; shows an ended session as ended", async () => {
    vi.useFakeTimers();
    const { post, live, $ } = viewer();
    await post(init);
    await live(frame("s1"));
    await live({ kind: "hidden", sessionId: "s1", reason: "password-field" });
    expect(($("frame") as HTMLImageElement).hidden).toBe(true);
    expect($("chip").textContent).toBe("Hidden — sensitive page");
    expect($("notice").hidden).toBe(false);
    vi.advanceTimersByTime(100);
    expect($("announce").textContent).toBe("The page is hidden: it has a password field.");
    await live({ kind: "ended", sessionId: "s1", reason: "task-ended" });
    expect($("chip").textContent).toBe("Ended");
  });

  it("shows every watcher who acts in the page: the agent, a person asked for, or a person in control", async () => {
    const { post, live, $ } = viewer();
    await post(init);
    await live({ kind: "session", sessionId: "s1", taskId: "t1", state: "open", url: "https://a.example/" });
    await live(frame("s1"));
    expect($("chip").textContent).toBe("Live");
    expect($("stage").dataset["control"]).toBe("agent");
    await live({ kind: "session", sessionId: "s1", taskId: "t1", state: "open", url: "https://a.example/", control: "requested" });
    expect($("chip").textContent).toBe("Needs you");
    // A change of hands comes as `control`, to every watcher.
    await live({ kind: "control", sessionId: "s1", state: "operator", controller: "other" });
    expect($("chip").textContent).toBe("You're in control");
    expect($("stage").dataset["control"]).toBe("operator");
    await live({ kind: "control", sessionId: "s1", state: "agent" });
    expect($("chip").textContent).toBe("Live");
  });

  it("draws an action's box over the frame, mapped through its metadata", async () => {
    const { post, live, $ } = viewer();
    await post(init);
    Object.defineProperty($("stage"), "clientWidth", { configurable: true, value: 500 });
    await live(frame("s1"));
    await live({
      kind: "action",
      sessionId: "s1",
      phase: "started",
      action: "click",
      box: { x: 100, y: 50, width: 200, height: 40 },
      callId: "call-2",
    });
    const box = $("box");
    expect(box.hidden).toBe(false);
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(["50px", "25px", "100px", "20px"]);
    expect($("pulse").hidden).toBe(false);
  });

  it("switches between a chat's sessions, labelling a sub-agent's, and acknowledges an unshown session's frames at once", async () => {
    const { sent, post, live, $ } = viewer();
    await post(init);
    await live({ kind: "session", sessionId: "s1", taskId: "t1", state: "open", url: "https://a.example/" });
    await live({ kind: "session", sessionId: "s2", taskId: "t-worker", state: "open", url: "https://b.example/" });
    await live({ kind: "session", sessionId: "s3", taskId: "t-researcher", state: "open", url: "https://c.example/", agent: "Researcher" });
    const select = $("sessions") as HTMLSelectElement;
    expect($("switcher").hidden).toBe(false);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "a.example",
      "b.example (sub-agent)",
      "c.example (Researcher)",
    ]);
    await live(frame("s2", "/9j/BB"));
    expect(sent.at(-1)).toMatchObject({ type: "ack" });
    expect(($("frame") as HTMLImageElement).getAttribute("src")).toBeNull();
    select.value = "s2";
    select.dispatchEvent(new Event("change"));
    expect(($("frame") as HTMLImageElement).getAttribute("src")).toBe("data:image/jpeg;base64,/9j/BB");
  });

  it("forwards Escape and the panel's shortcut to the canvas, and offers Expand outside the tab", async () => {
    const { sent, post, $ } = viewer();
    await post(init);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", code: "Period", metaKey: true, shiftKey: true }));
    expect(sent.slice(-2)).toEqual([
      { abi, type: "shortcut", key: "Escape" },
      { abi, type: "shortcut", key: "toggle-panel" },
    ]);
    ($("expand") as HTMLButtonElement).click();
    expect(sent.at(-1)).toEqual({ abi, type: "navigate", target: { to: "slot", slot: "chat.panel.tab" } });
    await post({ ...init, slot: "chat.panel.tab" });
    expect($("expand").hidden).toBe(true);
  });

  it("says a session whose task ended is kept, even without an ended message, and drops a title the new page lacks", async () => {
    const { post, live, $ } = viewer();
    await post(init);
    await live({ kind: "session", sessionId: "s1", taskId: "t1", state: "inactive", url: "https://example.com/", title: "Home" });
    expect($("chip").textContent).toBe("Ended");
    expect($("notice").textContent).toBe("Tavi has finished; the page is kept.");
    await live({ kind: "session", sessionId: "s1", taskId: "t1", state: "open", url: "https://example.com/", title: "Home" });
    await live({ kind: "navigated", sessionId: "s1", url: "https://example.com/next", epoch: 2 });
    expect($("title").textContent).toBe("");
  });

  it("keeps a finished task's page on show, with the person in control while they hold it, and a closed one as ended", async () => {
    vi.useFakeTimers();
    const { post, live, $ } = viewer();
    await post(init);
    await live({ kind: "session", sessionId: "s1", taskId: "t1", state: "open", url: "https://shop.example/form" });
    await live(frame("s1"));
    await live({ kind: "session", sessionId: "s1", taskId: "t1", state: "inactive", url: "https://shop.example/form" });
    await live({ kind: "ended", sessionId: "s1", reason: "task-ended" });
    // The filled page stays in view under the notice.
    expect(($("frame") as HTMLImageElement).hidden).toBe(false);
    expect($("notice").hidden).toBe(false);
    expect($("notice").textContent).toBe("Tavi has finished; the page is kept.");
    vi.advanceTimersByTime(100);
    expect($("announce").textContent).toBe("Tavi has finished; the page is kept.");
    // A person takes it: every view says so, and shows the page they act in.
    await live({ kind: "control", sessionId: "s1", state: "operator", controller: "other" });
    expect($("chip").textContent).toBe("You're in control");
    expect($("notice").hidden).toBe(true);
    expect($("stage").dataset["control"]).toBe("operator");
    await live({ kind: "control", sessionId: "s1", state: "agent" });
    expect($("notice").textContent).toBe("Tavi has finished; the page is kept.");
    await live({ kind: "session", sessionId: "s1", taskId: "t1", state: "closed" });
    await live({ kind: "ended", sessionId: "s1", reason: "closed" });
    expect($("chip").textContent).toBe("Ended");
    expect($("notice").textContent).toBe("This browser session has ended.");
    vi.advanceTimersByTime(100);
    expect($("announce").textContent).toBe("The browser session ended.");
  });

  it("names each reason a page is hidden or paused", async () => {
    const { post, live, $ } = viewer();
    await post(init);
    await live({ kind: "hidden", sessionId: "s1", reason: "blocked-host" });
    expect($("notice").textContent).toBe("Hidden: this site is never shown.");
    await live({ kind: "hidden", sessionId: "s1", reason: "payment-field" });
    expect($("notice").textContent).toBe("Hidden: this page has a payment or one-time-code field.");
    await live({ kind: "hidden", sessionId: "s1", reason: "paused" });
    expect($("chip").textContent).toBe("Paused");
    expect($("notice").hidden).toBe(true);
  });

  it("places an action's document box through each frame's scroll, and follows the page as it scrolls", async () => {
    const { post, live, $ } = viewer();
    await post(init);
    Object.defineProperty($("stage"), "clientWidth", { configurable: true, value: 500 });
    await live({ ...frame("s1"), metadata: { ...metadata, scrollOffsetY: 100 } } as BrowserLiveMessage);
    await live({ kind: "action", sessionId: "s1", phase: "started", action: "click", box: { x: 100, y: 150, width: 200, height: 40 } });
    expect([$("box").style.left, $("box").style.top]).toEqual(["50px", "25px"]);
    // The click scrolled the page back to the top: the element is lower on the next frame.
    await live(frame("s1", "/9j/BB"));
    expect([$("box").style.left, $("box").style.top]).toEqual(["50px", "75px"]);
  });

  it("keeps a new action's box although the last one just ended, and forgets everything on a new chat", async () => {
    vi.useFakeTimers();
    const { post, live, $ } = viewer();
    await post(init);
    Object.defineProperty($("stage"), "clientWidth", { configurable: true, value: 500 });
    await live(frame("s1"));
    const box = { x: 0, y: 0, width: 10, height: 10 };
    await live({ kind: "action", sessionId: "s1", phase: "started", action: "type", box });
    await live({ kind: "action", sessionId: "s1", phase: "ended", action: "type", status: "accepted" });
    vi.advanceTimersByTime(300);
    await live({ kind: "action", sessionId: "s1", phase: "started", action: "click", box });
    vi.advanceTimersByTime(500);
    expect($("box").hidden).toBe(false);
    await post({ type: "context", context: { workspaceId: "default", taskId: "t2" } });
    expect($("chip").textContent).toBe("Waiting");
    expect(($("frame") as HTMLImageElement).hidden).toBe(true);
  });

  it("outlines an action waiting for approval apart from one running, and holds it until it runs or is denied", async () => {
    vi.useFakeTimers();
    const { post, live, $ } = viewer();
    await post(init);
    Object.defineProperty($("stage"), "clientWidth", { configurable: true, value: 500 });
    await live(frame("s1"));
    const box = { x: 0, y: 0, width: 10, height: 10 };
    await live({ kind: "action", sessionId: "s1", phase: "pending", action: "submit", box, callId: "call-submit" });
    expect($("box").hidden).toBe(false);
    expect($("box").classList.contains("pending")).toBe(true);
    // Held for as long as the decision takes.
    vi.advanceTimersByTime(60_000);
    expect($("box").hidden).toBe(false);
    await live({ kind: "action", sessionId: "s1", phase: "started", action: "submit", box, callId: "call-submit" });
    expect($("box").classList.contains("pending")).toBe(false);
    await live({ kind: "action", sessionId: "s1", phase: "ended", action: "submit", status: "rejected", callId: "call-submit" });
    vi.advanceTimersByTime(700);
    expect($("box").hidden).toBe(true);
  });

  it("does not show a frame a newer one overtook while it decoded", async () => {
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? "";
    const sent: unknown[] = [];
    const decoding: (() => void)[] = [];
    stop = startViewer({
      window,
      document,
      host: { postMessage: (message) => void sent.push(message) },
      fromHost: () => true,
      decode: () => new Promise((resolve) => decoding.push(resolve)),
    }).stop;
    const post = async (message: Record<string, unknown>) => {
      window.dispatchEvent(new MessageEvent("message", { data: { abi, ...message } }));
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    };
    await post(init);
    await post({ type: "channel", channel: "browser.live", seq: 1, message: frame("s1", "/9j/OLD") });
    await post({ type: "channel", channel: "browser.live", seq: 2, message: frame("s1", "/9j/NEW") });
    decoding.shift()?.();
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    // The old frame's swap was skipped: the newer one is the session's frame now.
    expect((document.querySelector("[data-frame]") as HTMLImageElement).getAttribute("src")).toBeNull();
    expect(sent).toContainEqual({ abi, type: "ack", seq: 1 });
    decoding.shift()?.();
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    expect((document.querySelector("[data-frame]") as HTMLImageElement).getAttribute("src")).toBe("data:image/jpeg;base64,/9j/NEW");
  });

  it("reads an address from a scrubbed URL", () => {
    expect(addressOf("https://example.com/a/b")).toEqual({ host: "example.com", path: "/a/b" });
    expect(addressOf("https://example.com/")).toEqual({ host: "example.com", path: "" });
    expect(addressOf("about:")).toEqual({ host: "", path: "" });
    expect(addressOf(undefined)).toEqual({ host: "", path: "" });
  });

  it("ships a page with nothing inline, under its own CSP", () => {
    expect(page).not.toMatch(/<script\b[^>]*>[^<\s]/);
    expect(page).not.toMatch(/<style\b|\sstyle="|\son[a-z]+="/i);
    expect([...page.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((match) => match[1])).toEqual(["plugin-base.css", "live.css", "live.js"]);
  });
});
