import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type BrowserCaptureScale,
  type DesktopAction,
  type DesktopActionOutcome,
  type DesktopActOptions,
  type DesktopAppInfo,
  type DesktopCaptureOptions,
  type DesktopCaptureResult,
  type DesktopCaptureTarget,
  type DesktopNode,
  type DesktopPort,
  type DesktopResolvedElement,
  type DesktopTreeResult,
  TaviError,
  refusedEarly,
  toLogicalPoint,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

export const DESKTOP_HELPER_READY_TIMEOUT_MS = 5_000;
export const DESKTOP_HELPER_REQUEST_TIMEOUT_MS = 15_000;
export const DESKTOP_MIN_DRAG_STEPS = 12;
export const DESKTOP_DEFAULT_MAX_RESTARTS = 3;
/** How much of the helper's stderr is kept for error messages. */
export const DESKTOP_HELPER_STDERR_TAIL_BYTES = 4_096;
/** The installed helper binary, built by the package's `build:helper` script. */
export const DESKTOP_HELPER_DEFAULT_PATH = fileURLToPath(new URL("../native/tavi-desktop-helper", import.meta.url));

export interface DesktopBridgeTransport {
  readonly stdout: Readable;
  readonly stdin: Writable;
  kill(): void;
  /** Called once, when the helper exits or fails to start (`error` set, as for ENOENT). */
  onExit(listener: (code: number | null, error?: Error) => void): void;
  /** The last few KB of the helper's stderr, for error messages. */
  stderrTail?(): string;
}

/** The abort hotkey the helper's event tap consumes, as the helper's ready message reports it. */
export interface DesktopAbortHotkeyStatus {
  readonly combo?: string;
  readonly active: boolean;
  /** Why the tap is not active: most often the helper lacks Accessibility permission. */
  readonly error?: string;
}

export interface DesktopBridgeOptions {
  readonly helperPath?: string;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Restarts allowed after the first start; one more exit fails the bridge closed. */
  readonly maxRestarts?: number;
  readonly spawnTransport?: () => DesktopBridgeTransport;
  /** The combo the helper consumes as the abort hotkey (default cmd+shift+escape). */
  readonly abortHotkey?: { readonly key: string; readonly modifiers?: readonly string[] };
  /** Called when the operator presses the abort hotkey; typing in flight has already been rejected. */
  readonly onAbort?: () => void;
  /** What to do when the helper at `helperPath` is missing, in its owner's words; absent, how to build it in this repository. */
  readonly helperMissing?: () => string;
}

/** Options every bridge request takes. */
export interface DesktopRequestOptions {
  readonly signal?: AbortSignal;
}

export interface SwiftDesktopCaptureOptions extends DesktopCaptureOptions, DesktopRequestOptions {
  /**
   * The granted apps a display capture shows: the helper captures with an allowlist, so an app
   * not named here (an accessory app, a notification banner, Spotlight) is never in the frame.
   */
  readonly includeBundleIds?: readonly string[];
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

interface HelperSession {
  readonly transport: DesktopBridgeTransport;
  readonly lines: Interface;
  ready: boolean;
  exited: boolean;
  failReady?: (error: Error) => void;
}

interface NdjsonEnvelope {
  readonly type?: string;
  readonly id?: string;
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly abortHotkey?: unknown;
  /** The ready message's `AXIsProcessTrusted()`: whether macOS lets the helper read and drive other apps. */
  readonly accessibility?: unknown;
}

/** The helper's requests macOS answers without the Accessibility permission: the app list, and a capture (Screen Recording). */
const WITHOUT_ACCESSIBILITY: ReadonlySet<string> = new Set(["list_apps", "capture", "cancel"]);

/**
 * Said when the helper has no Accessibility permission: without it macOS hands back an empty tree and drops input
 * events, which read as an app with no window and an element that cannot be resolved.
 */
export const DESKTOP_ACCESSIBILITY_MISSING =
  "desktop control has no Accessibility permission, so it can neither read other apps nor act in them. Grant it to the " +
  "app that started `tavi serve` (your terminal) in System Settings → Privacy & Security → Accessibility, then restart " +
  "`tavi serve` from that terminal. Do not retry until then.";

/** Spawns the helper binary, draining its stderr and reporting a spawn failure (ENOENT, EACCES) as an exit. */
export function spawnDesktopHelper(helperPath: string, args: readonly string[] = []): DesktopBridgeTransport {
  const child = spawn(helperPath, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-DESKTOP_HELPER_STDERR_TAIL_BYTES);
  });
  // A write to a dead helper surfaces through the write callback and the exit.
  child.stdin.on("error", () => {});

  const listeners: Array<(code: number | null, error?: Error) => void> = [];
  let ended: { readonly code: number | null; readonly error?: Error } | undefined;
  const finish = (code: number | null, error?: Error): void => {
    if (ended !== undefined) return;
    ended = error === undefined ? { code } : { code, error };
    for (const listener of listeners) listener(code, error);
  };
  child.once("error", (err) => finish(null, err));
  child.once("exit", (code) => finish(code));

  return {
    stdout: child.stdout,
    stdin: child.stdin,
    kill() {
      child.kill("SIGKILL");
    },
    onExit(listener) {
      if (ended !== undefined) {
        listener(ended.code, ended.error);
        return;
      }
      listeners.push(listener);
    },
    stderrTail() {
      return stderr.trim();
    },
  };
}

function helperInstalled(helperPath: string): boolean {
  try {
    accessSync(helperPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function cancelledError(message: string): TaviError {
  return new TaviError("CANCELLED", message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw cancelledError("Desktop request was cancelled. Do not retry.");
  }
}

/** Replaces lone UTF-16 surrogates, which the helper's JSON decoder rejects; a well-formed pair passes unchanged. */
function wellFormedText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** Waits for the request ahead to finish; a signal that aborts meanwhile gives up the wait. */
function waitForTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return previous;
  return new Promise<void>((resolve, reject) => {
    const onSignal = (): void => reject(cancelledError("Desktop request was cancelled. Do not retry."));
    signal.addEventListener("abort", onSignal, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", onSignal);
      resolve();
    });
  });
}

function parseHotkeyStatus(raw: unknown): DesktopAbortHotkeyStatus | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  return {
    active: obj["active"] === true,
    ...(typeof obj["combo"] === "string" ? { combo: obj["combo"] } : {}),
    ...(typeof obj["error"] === "string" ? { error: obj["error"] } : {}),
  };
}

/** Whether a `focused` element's app record names the tree's app: by pid, else bundle id, else name. */
function sameDesktopApp(raw: Record<string, unknown>, app: DesktopAppInfo): boolean {
  const pid = typeof raw["pid"] === "number" ? raw["pid"] : 0;
  if (pid > 0 && app.pid > 0) return pid === app.pid;
  const bundleId = typeof raw["bundleId"] === "string" ? raw["bundleId"].toLowerCase() : "";
  if (bundleId.length > 0 && app.bundleId.length > 0) return bundleId === app.bundleId.toLowerCase();
  const name = typeof raw["name"] === "string" ? raw["name"] : "";
  return name.length > 0 && name === app.name;
}

/**
 * Computes downscaled image dimensions preserving aspect ratio, and returns a
 * `BrowserCaptureScale` suitable for clamped `toLogicalPoint` inverse mapping.
 */
export function resolveDisplayDims(logicalWidth: number, logicalHeight: number, maxWidth = 1280): BrowserCaptureScale {
  const lw = Math.max(1, Math.round(logicalWidth));
  const lh = Math.max(1, Math.round(logicalHeight));
  const targetWidth = Math.min(lw, Math.max(160, Math.round(maxWidth)));
  const targetHeight = Math.max(1, Math.round((lh * targetWidth) / lw));
  return {
    logicalWidth: lw,
    logicalHeight: lh,
    imageWidth: targetWidth,
    imageHeight: targetHeight,
  };
}

function normalizeDesktopNode(raw: unknown, counter: { value: number }): DesktopNode {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const ref = typeof obj["ref"] === "string" && obj["ref"].length > 0 ? obj["ref"] : `ax-${counter.value}`;
  counter.value += 1;
  const role = typeof obj["role"] === "string" && obj["role"].length > 0 ? obj["role"] : "AXUnknown";
  const subrole = typeof obj["subrole"] === "string" && obj["subrole"].length > 0 ? obj["subrole"] : undefined;
  const title = typeof obj["title"] === "string" && obj["title"].length > 0 ? obj["title"] : undefined;
  const isSecure = role === "AXSecureTextField" || subrole === "AXSecureTextField";
  const value = !isSecure && typeof obj["value"] === "string" && obj["value"].length > 0 ? obj["value"].slice(0, 240) : undefined;
  const description = typeof obj["description"] === "string" && obj["description"].length > 0 ? obj["description"] : undefined;

  let bounds: DesktopNode["bounds"];
  if (typeof obj["bounds"] === "object" && obj["bounds"] !== null) {
    const b = obj["bounds"] as Record<string, unknown>;
    if (typeof b["x"] === "number" && typeof b["y"] === "number" && typeof b["width"] === "number" && typeof b["height"] === "number") {
      bounds = { x: b["x"], y: b["y"], width: b["width"], height: b["height"] };
    }
  }
  const enabled = typeof obj["enabled"] === "boolean" ? obj["enabled"] : undefined;
  const focused = typeof obj["focused"] === "boolean" ? obj["focused"] : undefined;
  const rawChildren = Array.isArray(obj["children"]) ? obj["children"] : undefined;
  const children =
    rawChildren !== undefined && rawChildren.length > 0 ? rawChildren.map((child) => normalizeDesktopNode(child, counter)) : undefined;

  return {
    ref,
    role,
    ...(subrole === undefined ? {} : { subrole }),
    ...(title === undefined ? {} : { title }),
    ...(value === undefined ? {} : { value }),
    ...(description === undefined ? {} : { description }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(focused === undefined ? {} : { focused }),
    ...(children === undefined ? {} : { children }),
  };
}

function normalizeResolvedElement(raw: unknown): DesktopResolvedElement | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const appObj = typeof obj["app"] === "object" && obj["app"] !== null ? (obj["app"] as Record<string, unknown>) : undefined;
  if (appObj === undefined) return undefined;
  const bundleId = typeof appObj["bundleId"] === "string" ? appObj["bundleId"] : "";
  const name = typeof appObj["name"] === "string" ? appObj["name"] : "";
  const pid = typeof appObj["pid"] === "number" ? appObj["pid"] : 0;
  if (bundleId.length === 0 && name.length === 0) return undefined;

  const role = typeof obj["role"] === "string" && obj["role"].length > 0 ? obj["role"] : "AXUnknown";
  const subrole = typeof obj["subrole"] === "string" && obj["subrole"].length > 0 ? obj["subrole"] : undefined;
  const windowTitle = typeof obj["windowTitle"] === "string" && obj["windowTitle"].length > 0 ? obj["windowTitle"] : undefined;
  const title = typeof obj["title"] === "string" && obj["title"].length > 0 ? obj["title"] : undefined;
  const isSecure = role === "AXSecureTextField" || subrole === "AXSecureTextField";
  const value = !isSecure && typeof obj["value"] === "string" ? obj["value"] : undefined;
  const description = typeof obj["description"] === "string" ? obj["description"] : undefined;

  let bounds: DesktopResolvedElement["bounds"];
  if (typeof obj["bounds"] === "object" && obj["bounds"] !== null) {
    const b = obj["bounds"] as Record<string, unknown>;
    if (typeof b["x"] === "number" && typeof b["y"] === "number" && typeof b["width"] === "number" && typeof b["height"] === "number") {
      bounds = { x: b["x"], y: b["y"], width: b["width"], height: b["height"] };
    }
  }

  return {
    app: {
      bundleId,
      name,
      pid,
      ...(typeof appObj["active"] === "boolean" ? { active: appObj["active"] } : {}),
    },
    role,
    ...(windowTitle === undefined ? {} : { windowTitle }),
    ...(subrole === undefined ? {} : { subrole }),
    ...(title === undefined ? {} : { title }),
    ...(value === undefined ? {} : { value }),
    ...(description === undefined ? {} : { description }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(typeof obj["enabled"] === "boolean" ? { enabled: obj["enabled"] } : {}),
    ...(typeof obj["focused"] === "boolean" ? { focused: obj["focused"] } : {}),
  };
}

/**
 * NDJSON stdio bridge to the macOS Swift helper with ready handshake (5 s timeout),
 * request correlation IDs, a 15 s request timeout that restarts the helper, and a
 * bounded restart policy that fails closed once every allowed restart is spent.
 */
export class SwiftDesktopBridge implements DesktopPort {
  private readonly readyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly spawnTransport: () => DesktopBridgeTransport;
  /** The binary the default transport spawns; `undefined` when the caller supplies the transport. */
  private readonly helperPath: string | undefined;
  private readonly onAbort: (() => void) | undefined;
  private readonly helperMissing: (() => string) | undefined;

  private session: HelperSession | undefined;
  private readyPromise: Promise<void> | undefined;
  private requestCounter = 0;
  /** Moved by every abort: a request still waiting for its turn when it moves is rejected unsent. */
  private abortEpoch = 0;
  /** Settles when the last request in line is done; requests go to the helper one at a time, in call order. */
  private requestTail: Promise<void> = Promise.resolve();
  private restartCount = 0;
  private disposed = false;
  private hotkeyStatus: DesktopAbortHotkeyStatus | undefined;
  /** The last ready message's Accessibility trust; `undefined` before the helper has started (or from an older helper). */
  private accessibilityTrusted: boolean | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly refBounds = new Map<
    string,
    { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  >();

  constructor(options: DesktopBridgeOptions = {}) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? DESKTOP_HELPER_READY_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DESKTOP_HELPER_REQUEST_TIMEOUT_MS;
    this.maxRestarts = options.maxRestarts ?? DESKTOP_DEFAULT_MAX_RESTARTS;
    this.onAbort = options.onAbort;
    this.helperMissing = options.helperMissing;
    if (options.spawnTransport !== undefined) {
      this.helperPath = undefined;
      this.spawnTransport = options.spawnTransport;
    } else {
      const helperPath = options.helperPath ?? DESKTOP_HELPER_DEFAULT_PATH;
      const hotkey = options.abortHotkey;
      const args = hotkey === undefined ? [] : ["--abort-hotkey", [...(hotkey.modifiers ?? []), hotkey.key].join("+")];
      this.helperPath = helperPath;
      this.spawnTransport = () => spawnDesktopHelper(helperPath, args);
    }
  }

  /** Helper exits (crashes, timeouts, failed starts) counted against `maxRestarts`. */
  public get restarts(): number {
    return this.restartCount;
  }

  /** Whether macOS trusts the helper for Accessibility, from the last ready message; `undefined` before it has started. */
  public get accessibility(): boolean | undefined {
    return this.accessibilityTrusted;
  }

  /** The abort hotkey's state from the last ready message; `undefined` before the helper has started. */
  public get abortHotkey(): DesktopAbortHotkeyStatus | undefined {
    return this.hotkeyStatus;
  }

  private ensureStarted(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new TaviError("UNAVAILABLE", "Desktop bridge is disposed. Do not retry."));
    }
    if (this.readyPromise !== undefined) {
      return this.readyPromise;
    }
    if (this.restartCount > this.maxRestarts) {
      return Promise.reject(new TaviError("UNAVAILABLE", "Desktop helper exceeded maximum restarts. Do not retry."));
    }
    if (this.helperPath !== undefined && !helperInstalled(this.helperPath)) {
      return Promise.reject(
        refusedEarly(
          "NOT_CONFIGURED",
          this.helperMissing?.() ??
            `desktop helper not installed: ${this.helperPath} is missing or not executable. Build it with ` +
              "`pnpm --filter @tavi/plugin-desktop build:helper` (needs the Xcode command line tools) and copy " +
              "native/tavi-desktop-helper to that path.",
        ),
      );
    }
    const ready = this.startSession();
    // A spawn that threw leaves no session: the next request tries again.
    if (this.session !== undefined) this.readyPromise = ready;
    return ready;
  }

  private startSession(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let transport: DesktopBridgeTransport;
      try {
        transport = this.spawnTransport();
      } catch (err) {
        this.restartCount += 1;
        reject(new TaviError("UNAVAILABLE", `Failed to spawn desktop helper: ${errorMessage(err)}`));
        return;
      }

      const session: HelperSession = {
        transport,
        lines: createInterface({ input: transport.stdout, crlfDelay: Number.POSITIVE_INFINITY }),
        ready: false,
        exited: false,
      };
      this.session = session;

      const timer = setTimeout(() => {
        this.endSession(session, new TaviError("UNAVAILABLE", `Desktop helper did not become ready within ${this.readyTimeoutMs}ms`));
      }, this.readyTimeoutMs);
      timer.unref?.();
      session.failReady = (error) => {
        clearTimeout(timer);
        reject(error);
      };

      session.lines.on("line", (line) => {
        if (session.exited) return;
        const msg = this.parseLine(line);
        if (msg === undefined) return;
        if (msg.type === "ready" && !session.ready) {
          session.ready = true;
          clearTimeout(timer);
          this.hotkeyStatus = parseHotkeyStatus(msg.abortHotkey);
          this.accessibilityTrusted = typeof msg.accessibility === "boolean" ? msg.accessibility : undefined;
          resolve();
          return;
        }
        this.handleMessage(msg);
      });

      transport.onExit((code, error) => {
        const tail = transport.stderrTail?.() ?? "";
        const reason = error === undefined ? `exited (code ${code ?? "null"})` : `failed to run: ${error.message}`;
        this.endSession(session, new TaviError("UNAVAILABLE", `Desktop helper ${reason}${tail.length > 0 ? `: ${tail}` : ""}`), false);
      });
    });
  }

  private parseLine(line: string): NdjsonEnvelope | undefined {
    const trimmed = line.trim();
    if (trimmed.length === 0) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null ? (parsed as NdjsonEnvelope) : undefined;
    } catch {
      return undefined;
    }
  }

  private handleMessage(msg: NdjsonEnvelope): void {
    if (msg.type === "abort") {
      this.cancelAll(cancelledError("Desktop action aborted by operator hotkey. Do not retry."));
      try {
        this.onAbort?.();
      } catch {
        // An abort handler's failure never stops the bridge.
      }
      return;
    }
    if (typeof msg.id !== "string") return;
    const entry = this.pending.get(msg.id);
    if (entry === undefined) return;
    if (msg.ok === false || typeof msg.error === "string") {
      entry.reject(new TaviError("INVALID_INPUT", msg.error ?? "Desktop helper request failed"));
    } else {
      entry.resolve(msg.result);
    }
  }

  /**
   * Ends a helper session once, whatever ended it (an exit, a spawn error, a ready or request
   * timeout, disposal): it counts against the restart cap unless the bridge is disposed, fails
   * every pending request, and kills the process when it is still running.
   */
  private endSession(session: HelperSession, error: Error, kill = true): void {
    if (session.exited) return;
    session.exited = true;
    session.lines.close();
    if (this.session === session) {
      this.session = undefined;
      this.readyPromise = undefined;
    }
    if (!this.disposed) {
      this.restartCount += 1;
    }
    session.failReady?.(error);
    this.failAllPending(error);
    if (kill) {
      try {
        session.transport.kill();
      } catch {
        // Ignore kill errors during teardown.
      }
    }
  }

  private failAllPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.reject(error);
    }
  }

  /** Rejects the request in flight and every request still waiting for its turn. */
  private cancelAll(error: Error): void {
    this.abortEpoch += 1;
    this.failAllPending(error);
  }

  /**
   * Moves the helper's abort generation: typing stops between characters and requests it already
   * queued are refused unrun. Handled on arrival, never queued.
   */
  private sendCancel(): void {
    const session = this.session;
    if (session === undefined || !session.ready || session.exited) return;
    this.requestCounter += 1;
    session.transport.stdin.write(`${JSON.stringify({ id: `cancel-${this.requestCounter}`, method: "cancel" })}\n`, () => {});
  }

  public async request<T = unknown>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: DesktopRequestOptions = {},
  ): Promise<T> {
    const { signal } = options;
    throwIfAborted(signal);
    const epoch = this.abortEpoch;
    const previous = this.requestTail;
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The next request waits for this one and for everything before it, even if this one gives up its turn early.
    this.requestTail = previous.then(() => done);
    try {
      await waitForTurn(previous, signal);
      if (epoch !== this.abortEpoch) {
        throw cancelledError(`Desktop helper request '${method}' was cancelled by an abort before it ran. Do not retry.`);
      }
      return await this.send<T>(method, params, signal);
    } finally {
      release();
    }
  }

  private async send<T>(method: string, params: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined): Promise<T> {
    await this.ensureStarted();
    throwIfAborted(signal);
    // Refused before anything is read or sent: a chat that met this read nothing, and stays untainted.
    if (this.accessibilityTrusted === false && !WITHOUT_ACCESSIBILITY.has(method)) {
      throw refusedEarly("NOT_CONFIGURED", DESKTOP_ACCESSIBILITY_MISSING);
    }

    const session = this.session;
    if (session === undefined || session.exited) {
      throw new TaviError("UNAVAILABLE", "Desktop helper transport is unavailable");
    }

    this.requestCounter += 1;
    const id = `req-${this.requestCounter}`;

    return await new Promise<T>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onSignal);
        this.pending.delete(id);
      };
      const entry: PendingRequest = {
        method,
        resolve: (val) => {
          cleanup();
          resolve(val as T);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      const onSignal = (): void => {
        if (!this.pending.has(id)) return;
        entry.reject(cancelledError(`Desktop helper request '${method}' was cancelled. Do not retry.`));
        // The helper may still be running it (typing, most of all): stop it there too.
        this.sendCancel();
      };
      // A helper that does not answer in time is wedged: tear it down, and the next request starts a fresh one.
      const timer = setTimeout(() => {
        entry.reject(new TaviError("UNAVAILABLE", `Desktop helper request '${method}' (${id}) timed out after ${this.requestTimeoutMs}ms`));
        this.endSession(session, new TaviError("UNAVAILABLE", `Desktop helper restarted after request '${method}' (${id}) timed out`));
      }, this.requestTimeoutMs);
      timer.unref?.();

      this.pending.set(id, entry);
      signal?.addEventListener("abort", onSignal, { once: true });

      const payload = `${JSON.stringify({ id, method, params })}\n`;
      session.transport.stdin.write(payload, (writeErr) => {
        if (writeErr !== undefined && writeErr !== null) {
          entry.reject(new TaviError("UNAVAILABLE", `Failed writing to desktop helper: ${writeErr.message}`));
        }
      });
    });
  }

  public async apps(options: DesktopRequestOptions = {}): Promise<readonly DesktopAppInfo[]> {
    const raw = await this.request<unknown>("list_apps", {}, options);
    if (!Array.isArray(raw)) return [];
    const list: DesktopAppInfo[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      const bundleId = typeof obj["bundleId"] === "string" ? obj["bundleId"] : "";
      const name = typeof obj["name"] === "string" ? obj["name"] : "";
      const pid = typeof obj["pid"] === "number" ? obj["pid"] : 0;
      if (bundleId.length === 0 && name.length === 0) continue;
      list.push({
        bundleId,
        name,
        pid,
        ...(typeof obj["active"] === "boolean" ? { active: obj["active"] } : {}),
        ...(typeof obj["hidden"] === "boolean" ? { hidden: obj["hidden"] } : {}),
        ...(typeof obj["windowTitle"] === "string" ? { windowTitle: obj["windowTitle"] } : {}),
      });
    }
    return list;
  }

  public async tree(app: string, options: DesktopRequestOptions = {}): Promise<DesktopTreeResult> {
    const raw = await this.request<Record<string, unknown>>("get_tree", { app }, options);
    const counter = { value: 0 };
    const rawNodes = Array.isArray(raw?.["nodes"]) ? raw["nodes"] : [];
    const nodes = rawNodes.map((n) => normalizeDesktopNode(n, counter));

    this.refBounds.clear();
    const indexBounds = (list: readonly DesktopNode[]): void => {
      for (const node of list) {
        if (node.bounds !== undefined) {
          this.refBounds.set(node.ref, node.bounds);
        }
        if (node.children !== undefined) {
          indexBounds(node.children);
        }
      }
    };
    indexBounds(nodes);

    const appObj = typeof raw?.["app"] === "object" && raw["app"] !== null ? (raw["app"] as Record<string, unknown>) : {};
    const appInfo: DesktopAppInfo = {
      bundleId: typeof appObj["bundleId"] === "string" ? appObj["bundleId"] : app,
      name: typeof appObj["name"] === "string" ? appObj["name"] : app,
      pid: typeof appObj["pid"] === "number" ? appObj["pid"] : 0,
      ...(typeof appObj["active"] === "boolean" ? { active: appObj["active"] } : {}),
    };
    const windowTitle = typeof raw?.["windowTitle"] === "string" ? raw["windowTitle"] : undefined;
    const rawFocused =
      typeof raw?.["focused"] === "object" && raw["focused"] !== null ? (raw["focused"] as Record<string, unknown>) : undefined;
    // A focused element that names another app is not this tree's focus: drop it.
    const focusedApp =
      typeof rawFocused?.["app"] === "object" && rawFocused["app"] !== null ? (rawFocused["app"] as Record<string, unknown>) : undefined;
    const focusedObj = focusedApp !== undefined && !sameDesktopApp(focusedApp, appInfo) ? undefined : rawFocused;
    const focusedRole = typeof focusedObj?.["role"] === "string" ? focusedObj["role"] : undefined;
    const focusedSubrole = typeof focusedObj?.["subrole"] === "string" ? focusedObj["subrole"] : undefined;
    const isSecure = focusedRole === "AXSecureTextField" || focusedSubrole === "AXSecureTextField";

    return {
      app: appInfo,
      ...(windowTitle === undefined ? {} : { windowTitle }),
      ...(focusedRole === undefined
        ? {}
        : {
            focused: {
              role: focusedRole,
              ...(typeof focusedObj?.["ref"] === "string" ? { ref: focusedObj["ref"] } : {}),
              ...(focusedSubrole === undefined ? {} : { subrole: focusedSubrole }),
              ...(typeof focusedObj?.["title"] === "string" ? { title: focusedObj["title"] } : {}),
              ...(!isSecure && typeof focusedObj?.["value"] === "string" ? { value: focusedObj["value"] } : {}),
            },
          }),
      nodes,
    };
  }

  public async elementAtPoint(x: number, y: number, options: DesktopRequestOptions = {}): Promise<DesktopResolvedElement | undefined> {
    const raw = await this.request<unknown>("get_element_at_point", { x: Math.round(x), y: Math.round(y) }, options);
    return normalizeResolvedElement(raw);
  }

  public async focusedElement(options: DesktopRequestOptions = {}): Promise<DesktopResolvedElement | undefined> {
    const raw = await this.request<unknown>("get_focused_element", {}, options);
    return normalizeResolvedElement(raw);
  }

  public resolveRefCenter(ref: string): { readonly x: number; readonly y: number } | undefined {
    const box = this.refBounds.get(ref);
    if (box === undefined) return undefined;
    return {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    };
  }

  public async capture(target: DesktopCaptureTarget, options: SwiftDesktopCaptureOptions = {}): Promise<DesktopCaptureResult> {
    const maxWidth = options.maxWidth ?? 1280;
    const raw = await this.request<Record<string, unknown>>(
      "capture",
      {
        target,
        maxWidth,
        quality: options.quality ?? 72,
        includeBundleIds: options.includeBundleIds ?? [],
        excludeBundleIds: options.excludeBundleIds ?? [],
      },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const data = typeof raw?.["data"] === "string" ? raw["data"] : "";
    const scaleObj = typeof raw?.["scale"] === "object" && raw["scale"] !== null ? (raw["scale"] as Record<string, unknown>) : {};
    const logicalWidth = scaleObj["logicalWidth"];
    const logicalHeight = scaleObj["logicalHeight"];
    // Coordinates are mapped through the scale: a capture without its real size is refused, never guessed.
    if (
      data.length === 0 ||
      typeof logicalWidth !== "number" ||
      typeof logicalHeight !== "number" ||
      logicalWidth <= 0 ||
      logicalHeight <= 0
    ) {
      throw new TaviError("UNAVAILABLE", "Desktop helper returned a capture without image data or display size. Do not retry.");
    }
    const mediaType = raw["mediaType"] === "image/png" ? "image/png" : "image/jpeg";
    const scale =
      typeof scaleObj["imageWidth"] === "number" && typeof scaleObj["imageHeight"] === "number"
        ? {
            logicalWidth,
            logicalHeight,
            imageWidth: scaleObj["imageWidth"],
            imageHeight: scaleObj["imageHeight"],
          }
        : resolveDisplayDims(logicalWidth, logicalHeight, maxWidth);
    const app = normalizeResolvedElement({ app: raw["app"] })?.app;

    return {
      data,
      mediaType,
      scale,
      ...(app === undefined ? {} : { app }),
    };
  }

  public async act(action: DesktopAction, options: DesktopActOptions = {}): Promise<DesktopActionOutcome> {
    const requestOptions: DesktopRequestOptions = options.signal === undefined ? {} : { signal: options.signal };
    switch (action.kind) {
      case "click": {
        const pt = action.ref !== undefined ? this.resolveRefCenter(action.ref) : { x: action.x ?? 0, y: action.y ?? 0 };
        if (pt === undefined) {
          return { status: "rejected", detail: `Unknown or unpositioned desktop ref '${action.ref}'. Do not retry.` };
        }
        await this.request(
          "click",
          {
            x: pt.x,
            y: pt.y,
            button: action.button ?? "left",
            clickCount: action.triple === true ? 3 : action.double === true ? 2 : 1,
            modifiers: action.modifiers ?? [],
            ...(action.ref === undefined ? {} : { ref: action.ref }),
          },
          requestOptions,
        );
        return { status: "accepted" };
      }
      case "move": {
        const pt = action.ref !== undefined ? this.resolveRefCenter(action.ref) : { x: action.x ?? 0, y: action.y ?? 0 };
        if (pt === undefined) {
          return { status: "rejected", detail: `Unknown or unpositioned desktop ref '${action.ref}'. Do not retry.` };
        }
        await this.request("move", { x: pt.x, y: pt.y }, requestOptions);
        return { status: "accepted" };
      }
      case "mouse_down":
      case "mouse_up": {
        await this.request(action.kind, { x: action.x ?? 0, y: action.y ?? 0, button: action.button ?? "left" }, requestOptions);
        return { status: "accepted" };
      }
      case "type": {
        if (action.ref !== undefined) {
          const pt = this.resolveRefCenter(action.ref);
          if (pt === undefined) {
            return { status: "rejected", detail: `Unknown or unpositioned desktop ref '${action.ref}'. Do not retry.` };
          }
          await this.request("click", { x: pt.x, y: pt.y, button: "left", clickCount: 1, ref: action.ref }, requestOptions);
        }
        await this.request(
          "type_text",
          {
            text: wellFormedText(action.text),
            encoding: "unicode",
            useClipboard: false,
          },
          requestOptions,
        );
        return { status: "accepted" };
      }
      case "press": {
        await this.request(
          "press_key",
          {
            key: action.key,
            modifiers: action.modifiers ?? [],
            releaseModifiersInDefer: true,
          },
          requestOptions,
        );
        return { status: "accepted" };
      }
      case "key_down":
      case "key_up": {
        await this.request(action.kind, { key: action.key }, requestOptions);
        return { status: "accepted" };
      }
      case "scroll": {
        const pt = action.ref !== undefined ? this.resolveRefCenter(action.ref) : { x: action.x ?? 0, y: action.y ?? 0 };
        await this.request(
          "scroll",
          {
            x: pt?.x ?? 0,
            y: pt?.y ?? 0,
            dx: action.dx,
            dy: action.dy,
          },
          requestOptions,
        );
        return { status: "accepted" };
      }
      case "drag": {
        await this.request(
          "drag",
          {
            fromX: action.x,
            fromY: action.y,
            toX: action.toX,
            toY: action.toY,
            steps: DESKTOP_MIN_DRAG_STEPS,
          },
          requestOptions,
        );
        return { status: "accepted" };
      }
      case "wait": {
        const ms = Math.min(5_000, Math.max(0, Math.round(action.ms)));
        const signal = options.signal;
        throwIfAborted(signal);
        await new Promise<void>((resolve, reject) => {
          const onSignal = (): void => {
            clearTimeout(timer);
            reject(cancelledError("Desktop wait was cancelled. Do not retry."));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onSignal);
            resolve();
          }, ms);
          signal?.addEventListener("abort", onSignal, { once: true });
        });
        return { status: "accepted" };
      }
    }
  }

  public async abort(): Promise<void> {
    this.sendCancel();
    this.cancelAll(cancelledError("Desktop action aborted by operator hotkey"));
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    const session = this.session;
    if (session !== undefined) {
      this.endSession(session, new TaviError("UNAVAILABLE", "Desktop bridge disposed"));
    }
    this.readyPromise = undefined;
    this.failAllPending(new TaviError("UNAVAILABLE", "Desktop bridge disposed"));
  }
}

export { toLogicalPoint };
