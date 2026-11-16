import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { TaviError } from "@tavi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_HELPER_READY_TIMEOUT_MS,
  DESKTOP_HELPER_REQUEST_TIMEOUT_MS,
  type DesktopBridgeTransport,
  resolveDisplayDims,
  SwiftDesktopBridge,
  spawnDesktopHelper,
} from "../src/index.js";

interface HelperRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** One spawned helper: its wire, what it was asked, and controls to make it exit or speak. */
interface FakeHelper {
  readonly requests: HelperRequest[];
  killed: boolean;
  send(message: unknown): void;
  exit(code: number | null): void;
}

/** What the fake helper answers: a result, `{ error }`, or `undefined` to never answer. */
type Responder = (req: HelperRequest, helper: FakeHelper) => { readonly result: unknown } | { readonly error: string } | undefined;

/**
 * In-memory NDJSON helpers over Node `PassThrough` streams, speaking the Swift helper's
 * wire protocol: nothing is written to disk or executed.
 */
function createFakeHelpers(
  options: {
    readonly omitReady?: boolean;
    readonly ready?: Record<string, unknown>;
    readonly respond?: Responder;
    readonly stderr?: string;
  } = {},
) {
  const helpers: FakeHelper[] = [];
  const respond: Responder = options.respond ?? (() => ({ result: { ok: true } }));

  const spawnTransport = (): DesktopBridgeTransport => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let exitListener: ((code: number | null, error?: Error) => void) | undefined;
    let exited = false;

    const helper: FakeHelper = {
      requests: [],
      killed: false,
      send(message) {
        stdout.write(`${JSON.stringify(message)}\n`);
      },
      exit(code) {
        if (exited) return;
        exited = true;
        exitListener?.(code);
      },
    };
    helpers.push(helper);

    if (options.omitReady !== true) {
      queueMicrotask(() => helper.send({ type: "ready", version: 2, ...options.ready }));
    }

    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const raw = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
        const req: HelperRequest = { id: raw.id, method: raw.method, params: raw.params ?? {} };
        helper.requests.push(req);
        const answer = respond(req, helper);
        if (answer === undefined) continue;
        helper.send("error" in answer ? { id: req.id, ok: false, error: answer.error } : { id: req.id, ok: true, result: answer.result });
      }
    });

    return {
      stdout,
      stdin,
      kill() {
        helper.killed = true;
        helper.exit(137);
      },
      onExit(listener) {
        exitListener = listener;
      },
      stderrTail() {
        return options.stderr ?? "";
      },
    };
  };

  return { spawnTransport, helpers };
}

function fakeCapture(maxWidth: number) {
  return {
    data: Buffer.from("fake-jpeg").toString("base64"),
    mediaType: "image/jpeg",
    scale: resolveDisplayDims(1440, 900, maxWidth),
  };
}

// `spawn` stays real unless a test replaces one call: the replacement records the arguments and executes nothing.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SwiftDesktopBridge lifecycle", () => {
  it("fails the start when the helper sends no ready message within 5 s, counting it as an exit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { spawnTransport, helpers } = createFakeHelpers({ omitReady: true });
    const bridge = new SwiftDesktopBridge({ spawnTransport });

    const pending = bridge.apps();
    const settled = expect(pending).rejects.toThrow(`did not become ready within ${DESKTOP_HELPER_READY_TIMEOUT_MS}ms`);
    await vi.advanceTimersByTimeAsync(DESKTOP_HELPER_READY_TIMEOUT_MS - 1);
    expect(helpers[0]?.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(helpers[0]?.killed).toBe(true);
    expect(bridge.restarts).toBe(1);
    await bridge.dispose();
  });

  it("tears down a helper whose request times out after 15 s and starts a fresh one for the next request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { spawnTransport, helpers } = createFakeHelpers({
      respond: (req, helper) => (req.method === "get_tree" && helpers.indexOf(helper) === 0 ? undefined : { result: [] }),
    });
    const bridge = new SwiftDesktopBridge({ spawnTransport });

    const hung = bridge.tree("com.apple.TextEdit");
    const settled = expect(hung).rejects.toThrow(`timed out after ${DESKTOP_HELPER_REQUEST_TIMEOUT_MS}ms`);
    await vi.advanceTimersByTimeAsync(DESKTOP_HELPER_REQUEST_TIMEOUT_MS);
    await settled;
    expect(helpers[0]?.killed).toBe(true);
    expect(bridge.restarts).toBe(1);

    await expect(bridge.apps()).resolves.toEqual([]);
    expect(helpers).toHaveLength(2);
    await bridge.dispose();
  });

  it("counts every exit and fails closed, without spawning, once the restarts are spent", async () => {
    const { spawnTransport, helpers } = createFakeHelpers({
      respond: (_req, helper) => {
        helper.exit(1);
        return undefined;
      },
    });
    const bridge = new SwiftDesktopBridge({ spawnTransport, maxRestarts: 1 });

    await expect(bridge.apps()).rejects.toThrow(/exited \(code 1\)/);
    expect(bridge.restarts).toBe(1);
    await expect(bridge.apps()).rejects.toThrow(/exited \(code 1\)/);
    expect(bridge.restarts).toBe(2);
    await expect(bridge.apps()).rejects.toThrow(/exceeded maximum restarts/);
    expect(helpers).toHaveLength(2);
    await bridge.dispose();
  });

  it("reports a helper that cannot be spawned (ENOENT) as an exit instead of crashing", async () => {
    const missing = "/nonexistent/tavi-desktop-helper-for-test";
    const exitError = await new Promise<Error | undefined>((resolve) => {
      spawnDesktopHelper(missing).onExit((_code, error) => resolve(error));
    });
    expect(exitError).toMatchObject({ code: "ENOENT" });

    const bridge = new SwiftDesktopBridge({ spawnTransport: () => spawnDesktopHelper(missing) });
    await expect(bridge.apps()).rejects.toThrow(/failed to run: .*ENOENT/);
    expect(bridge.restarts).toBe(1);
    await bridge.dispose();
  });

  it("puts the tail of the helper's stderr in the exit error", async () => {
    const { spawnTransport } = createFakeHelpers({
      stderr: "Fatal error: Unexpectedly found nil",
      respond: (_req, helper) => {
        helper.exit(6);
        return undefined;
      },
    });
    const bridge = new SwiftDesktopBridge({ spawnTransport });
    await expect(bridge.apps()).rejects.toThrow("Desktop helper exited (code 6): Fatal error: Unexpectedly found nil");
    await bridge.dispose();
  });

  it("passes the configured abort hotkey to the helper as --abort-hotkey", async () => {
    let spawnedArgs: readonly string[] | undefined;
    vi.mocked(spawn).mockImplementationOnce((_command: string, args?: readonly string[]) => {
      spawnedArgs = args;
      throw new Error("not spawned in tests");
    });
    // An existing executable passes the install check; the replaced spawn never runs it.
    const bridge = new SwiftDesktopBridge({ helperPath: process.execPath, abortHotkey: { key: "f12", modifiers: ["ctrl", "alt"] } });
    await expect(bridge.apps()).rejects.toThrow(/not spawned in tests/);
    expect(spawnedArgs).toEqual(["--abort-hotkey", "ctrl+alt+f12"]);
    await bridge.dispose();
  });

  it("refuses to start with NOT_CONFIGURED when the helper binary is not installed", async () => {
    const bridge = new SwiftDesktopBridge({ helperPath: "/nonexistent/tavi-desktop-helper" });
    const error = await bridge.apps().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(TaviError);
    expect(error).toMatchObject({
      code: "NOT_CONFIGURED",
      message: expect.stringMatching(/^desktop helper not installed: .*build:helper/),
    });
    expect(bridge.restarts).toBe(0);
    await bridge.dispose();
  });

  it("says how to build the helper in the words its owner gives, for an install with no repository (QA-20261110-1905)", async () => {
    const bridge = new SwiftDesktopBridge({
      helperPath: "/nonexistent/tavi-desktop-helper",
      helperMissing: () => "desktop control's helper is not built: run swiftc …",
    });
    await expect(bridge.apps()).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      message: "desktop control's helper is not built: run swiftc …",
    });
    await bridge.dispose();
  });
});

describe("SwiftDesktopBridge abort", () => {
  it("routes the helper's abort event to onAbort and rejects the typing in flight", async () => {
    const onAbort = vi.fn();
    const { spawnTransport, helpers } = createFakeHelpers({
      ready: { abortHotkey: { combo: "cmd+shift+escape", active: true } },
      respond: (req) => (req.method === "type_text" ? undefined : { result: [] }),
    });
    const bridge = new SwiftDesktopBridge({ spawnTransport, onAbort });

    const typing = bridge.act({ kind: "type", text: "a long paragraph" });
    await vi.waitFor(() => expect(helpers[0]?.requests.some((r) => r.method === "type_text")).toBe(true));
    expect(bridge.abortHotkey).toEqual({ combo: "cmd+shift+escape", active: true });

    helpers[0]?.send({ type: "abort" });
    await expect(typing).rejects.toMatchObject({ code: "CANCELLED" });
    expect(onAbort).toHaveBeenCalledTimes(1);
    // The helper survives an abort: the next request goes to the same process.
    await expect(bridge.apps()).resolves.toEqual([]);
    expect(helpers).toHaveLength(1);
    await bridge.dispose();
  });

  it("rejects every pending request on an abort, including those still waiting for their turn", async () => {
    const { spawnTransport, helpers } = createFakeHelpers({
      respond: (req) => (req.method === "type_text" ? undefined : { result: [] }),
    });
    const bridge = new SwiftDesktopBridge({ spawnTransport });

    const typing = bridge.act({ kind: "type", text: "first" });
    const click = bridge.act({ kind: "click", x: 5, y: 5 });
    const listing = bridge.apps();
    await vi.waitFor(() => expect(helpers[0]?.requests.some((r) => r.method === "type_text")).toBe(true));

    helpers[0]?.send({ type: "abort" });
    await expect(typing).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(click).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(listing).rejects.toMatchObject({ code: "CANCELLED" });
    // The queued requests were never sent.
    expect(helpers[0]?.requests.map((r) => r.method)).toEqual(["type_text"]);
    await expect(bridge.apps()).resolves.toEqual([]);
    await bridge.dispose();
  });

  it("reports an abort hotkey the helper could not arm", async () => {
    const { spawnTransport } = createFakeHelpers({
      ready: { abortHotkey: { combo: "cmd+shift+escape", active: false, error: "needs Accessibility permission" } },
      respond: () => ({ result: [] }),
    });
    const bridge = new SwiftDesktopBridge({ spawnTransport });
    await bridge.apps();
    expect(bridge.abortHotkey).toEqual({ combo: "cmd+shift+escape", active: false, error: "needs Accessibility permission" });
    await bridge.dispose();
  });

  it("rejects a request whose signal aborts, and cancels typing in the helper", async () => {
    const { spawnTransport, helpers } = createFakeHelpers({
      respond: (req) => (req.method === "type_text" ? undefined : { result: { cancelled: true } }),
    });
    const bridge = new SwiftDesktopBridge({ spawnTransport });
    const controller = new AbortController();

    const typing = bridge.act({ kind: "type", text: "\u{1F600} and more" }, { signal: controller.signal });
    await vi.waitFor(() => expect(helpers[0]?.requests.some((r) => r.method === "type_text")).toBe(true));
    controller.abort();
    await expect(typing).rejects.toMatchObject({ code: "CANCELLED" });
    await vi.waitFor(() => expect(helpers[0]?.requests.some((r) => r.method === "cancel")).toBe(true));
    // A character outside the BMP reaches the helper whole.
    expect(helpers[0]?.requests.find((r) => r.method === "type_text")?.params["text"]).toBe("\u{1F600} and more");

    await expect(bridge.apps({ signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    await bridge.dispose();
  });
});

describe("SwiftDesktopBridge results", () => {
  it("drops a tree's focused element when it belongs to another app", async () => {
    const textEdit = { bundleId: "com.apple.TextEdit", name: "TextEdit", pid: 201 };
    let focusedApp = { bundleId: "com.apple.Terminal", name: "Terminal", pid: 999 };
    const { spawnTransport } = createFakeHelpers({
      respond: () => ({
        result: {
          app: textEdit,
          nodes: [],
          focused: { app: focusedApp, role: "AXTextArea", title: "Shell", value: "whoami" },
        },
      }),
    });
    const bridge = new SwiftDesktopBridge({ spawnTransport });

    const foreign = await bridge.tree("com.apple.TextEdit");
    expect(foreign.focused).toBeUndefined();

    focusedApp = textEdit;
    const own = await bridge.tree("com.apple.TextEdit");
    expect(own.focused).toMatchObject({ role: "AXTextArea", title: "Shell" });
    await bridge.dispose();
  });

  it("fails a capture that lacks its display size or image data instead of inventing one", async () => {
    let reply: Record<string, unknown> = { data: Buffer.from("fake-jpeg").toString("base64"), mediaType: "image/jpeg" };
    const { spawnTransport, helpers } = createFakeHelpers({ respond: () => ({ result: reply }) });
    const bridge = new SwiftDesktopBridge({ spawnTransport });

    await expect(bridge.capture({ kind: "display" })).rejects.toThrow(/without image data or display size/);
    reply = { ...fakeCapture(1280), data: "" };
    await expect(bridge.capture({ kind: "display" })).rejects.toThrow(/without image data or display size/);

    reply = fakeCapture(800);
    const shot = await bridge.capture({ kind: "display" }, { maxWidth: 800, quality: 55, includeBundleIds: ["com.apple.TextEdit"] });
    expect(shot.scale).toEqual(resolveDisplayDims(1440, 900, 800));
    expect(helpers[0]?.requests.at(-1)?.params).toMatchObject({ quality: 55, includeBundleIds: ["com.apple.TextEdit"] });
    await bridge.dispose();
  });

  it("replaces a lone surrogate before typing, keeping a well-formed pair", async () => {
    const { spawnTransport, helpers } = createFakeHelpers();
    const bridge = new SwiftDesktopBridge({ spawnTransport });
    await bridge.act({ kind: "type", text: "a\uD800b\uDC00c\u{1F600}" });
    expect(helpers[0]?.requests.find((r) => r.method === "type_text")?.params["text"]).toBe("a\uFFFDb\uFFFDc\u{1F600}");
    await bridge.dispose();
  });

  it("sends requests to the helper one at a time, in call order", async () => {
    const { spawnTransport, helpers } = createFakeHelpers({ respond: () => undefined });
    const bridge = new SwiftDesktopBridge({ spawnTransport });
    const sent = (): string[] => helpers[0]?.requests.map((r) => r.method) ?? [];
    const answer = (index: number, result: unknown): void => {
      const req = helpers[0]?.requests[index];
      if (req !== undefined) helpers[0]?.send({ id: req.id, ok: true, result });
    };

    const listing = bridge.apps();
    const tree = bridge.tree("com.apple.TextEdit");
    const focused = bridge.focusedElement();
    await vi.waitFor(() => expect(sent()).toEqual(["list_apps"]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toEqual(["list_apps"]);

    answer(0, []);
    await expect(listing).resolves.toEqual([]);
    await vi.waitFor(() => expect(sent()).toEqual(["list_apps", "get_tree"]));
    answer(1, { app: { bundleId: "com.apple.TextEdit", name: "TextEdit", pid: 201 }, nodes: [] });
    await expect(tree).resolves.toMatchObject({ app: { pid: 201 } });
    await vi.waitFor(() => expect(sent()).toEqual(["list_apps", "get_tree", "get_focused_element"]));
    answer(2, null);
    await expect(focused).resolves.toBeUndefined();
    await bridge.dispose();
  });

  it("passes a click's button and modifiers through to the helper", async () => {
    const { spawnTransport, helpers } = createFakeHelpers();
    const bridge = new SwiftDesktopBridge({ spawnTransport });
    await bridge.act({ kind: "click", x: 10, y: 20, button: "middle", modifiers: ["cmd"] });
    await bridge.act({ kind: "mouse_down", x: 10, y: 20, button: "right" });
    expect(helpers[0]?.requests.map((r) => [r.method, r.params["button"], r.params["modifiers"]])).toEqual([
      ["click", "middle", ["cmd"]],
      ["mouse_down", "right", undefined],
    ]);
    await bridge.dispose();
  });
});
