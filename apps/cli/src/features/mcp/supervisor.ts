import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Tool } from "@modelcontextprotocol/client";
import { TaviError, WorkflowWaitSuspend } from "@tavi/contracts";
import { clip, definedOnly, errorMessage } from "@tavi/contracts/util";

import { McpConnection, type McpCallOptions, type McpClientEvent, type McpElicit, type McpEndpoint, type McpEraPrior } from "./client.js";
import { inputDigest } from "./logs.js";
import type { McpCallResult } from "./results.js";
import { McpRunRecordSchema, processListing, sweep, type McpRunRecord } from "./stdio-transport.js";

/**
 * The owner's MCP servers: one entry
 * per enabled server, connected on its first call, with its era prior,
 * idle stop, crash backoff, `failed` after five failures in a row, call
 * timeouts and the stuck-call kill, the running and concurrency bounds,
 * orphan reaping and shutdown. Its interface is message-shaped (`call`,
 * `list`, `status`, `stop`, `subscribe`), so it can move into a worker
 * without changing callers. Every promise it makes is caught here.
 */

/** What the supervisor needs to start one server: built by the owner from the plugin and MCP records. */
export interface McpServerSpec {
  readonly pluginId: string;
  readonly version: string;
  readonly transport: "stdio" | "http";
  readonly endpoint: () => Promise<McpEndpoint>;
  readonly prior?: McpEraPrior;
  readonly maxMessageBytes: number;
  readonly concurrency: number;
}

export type McpServerState = "stopped" | "running" | "backing-off" | "failed" | "login-required";

export interface McpServerStatus {
  readonly pluginId: string;
  readonly state: McpServerState;
  readonly failures: number;
  readonly inFlight: number;
  readonly queued: number;
  /** When the next connect may be tried, while backing off. */
  readonly retryAt?: number;
  /** Why it is failed, backing off or waiting for a login. */
  readonly reason?: string;
}

export type McpSupervisorEvent =
  | { readonly kind: "state"; readonly pluginId: string; readonly state: McpServerState; readonly reason?: string }
  | {
      readonly kind: "call";
      readonly pluginId: string;
      readonly tool: string;
      readonly outcome: "ok" | "error" | "uncertain" | "asked";
      readonly ms: number;
      readonly digest?: string;
    }
  | { readonly kind: "client"; readonly pluginId: string; readonly event: McpClientEvent }
  | { readonly kind: "killed"; readonly pluginId: string; readonly reason: string }
  | { readonly kind: "era"; readonly pluginId: string; readonly prior: McpEraPrior };

export interface McpSupervisorOptions {
  /** The spec of an enabled, approved server, or `undefined` when it may not run. */
  readonly spec: (pluginId: string) => Promise<McpServerSpec | undefined>;
  /** A server became `failed`: its tools are withdrawn and a `failed` notice raised. */
  readonly onFailed?: (pluginId: string, reason: string) => void | Promise<void>;
  /** An HTTP server's era changed on a re-probe: the new prior is stored. */
  readonly onEra?: (pluginId: string, version: string, prior: McpEraPrior) => void | Promise<void>;
  readonly dataDirectory: string;
  readonly now?: () => number;
  readonly idleMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  readonly failuresToFail?: number;
  readonly maxRunning?: number;
  readonly queueLimit?: number;
  /** How long a cancelled call's server has to answer a ping before its group is killed. */
  readonly cancelGraceMs?: number;
  readonly connectTimeoutMs?: number;
}

export const SUPERVISOR_DEFAULTS = {
  idleMs: 10 * 60_000,
  backoffBaseMs: 30_000,
  backoffCapMs: 10 * 60_000,
  failuresToFail: 5,
  maxRunning: 8,
  queueLimit: 16,
  cancelGraceMs: 5_000,
} as const;

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface Entry {
  readonly pluginId: string;
  spec: McpServerSpec | undefined;
  connection: McpConnection | undefined;
  /** Bumped by every disconnect, so a connect that a stop overtook is not kept. */
  epoch: number;
  /** The connect in progress, shared by every call that arrives meanwhile. */
  connecting: Promise<McpConnection> | undefined;
  state: McpServerState;
  failures: number;
  retryAt: number | undefined;
  reason: string | undefined;
  inFlight: number;
  readonly waiters: Waiter[];
  /** Controllers of the calls running, so a kill can tell them their outcome is uncertain. */
  readonly calls: Set<AbortController>;
  /** Calls running on each connection, so a stopped server's connection closes once its last call settles. */
  readonly using: Map<McpConnection, number>;
  /** Connections a stop retired while calls ran on them: closed when those calls settle. */
  readonly retired: Set<McpConnection>;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

const isServerFailure = (error: unknown): boolean => error instanceof TaviError && error.details?.["mcpFailure"] === "server";

/** Past a call's own timeout, the SDK's request timeout, so the supervisor's clock always speaks first. */
const SDK_TIMEOUT_SLACK_MS = 60_000;
/** A call whose server may ask questions waits on people: its clock is the supervisor's, paused for each. */
const SDK_TIMEOUT_WITH_QUESTIONS_MS = 24 * 60 * 60 * 1000;

export class McpSupervisor {
  readonly #options: McpSupervisorOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(event: McpSupervisorEvent) => void>();
  readonly #now: () => number;
  #closed = false;

  constructor(options: McpSupervisorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  #setting<K extends keyof typeof SUPERVISOR_DEFAULTS>(key: K): number {
    return (this.#options[key] as number | undefined) ?? SUPERVISOR_DEFAULTS[key];
  }

  /** Every event: state changes, calls (by tool and outcome, never arguments), kills, era changes. */
  subscribe(listener: (event: McpSupervisorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: McpSupervisorEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  #entry(pluginId: string): Entry {
    let entry = this.#entries.get(pluginId);
    if (entry === undefined) {
      entry = {
        pluginId,
        spec: undefined,
        connection: undefined,
        epoch: 0,
        connecting: undefined,
        state: "stopped",
        failures: 0,
        retryAt: undefined,
        reason: undefined,
        inFlight: 0,
        waiters: [],
        calls: new Set(),
        using: new Map(),
        retired: new Set(),
        lastUsed: 0,
        idleTimer: undefined,
      };
      this.#entries.set(pluginId, entry);
    }
    return entry;
  }

  #setState(entry: Entry, state: McpServerState, reason?: string): void {
    entry.state = state;
    entry.reason = reason;
    this.#emit({ kind: "state", pluginId: entry.pluginId, state, ...(reason === undefined ? {} : { reason }) });
  }

  status(pluginId: string): McpServerStatus {
    const entry = this.#entries.get(pluginId);
    if (entry === undefined) return { pluginId, state: "stopped", failures: 0, inFlight: 0, queued: 0 };
    return {
      pluginId,
      state: entry.state,
      failures: entry.failures,
      inFlight: entry.inFlight,
      queued: entry.waiters.length,
      ...(entry.retryAt === undefined ? {} : { retryAt: entry.retryAt }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    };
  }

  statuses(): readonly McpServerStatus[] {
    return [...this.#entries.keys()].map((pluginId) => this.status(pluginId));
  }

  /** Fails fast while a server may not be tried: failed, waiting for a login, or backing off. */
  #admissible(entry: Entry): void {
    if (this.#closed) throw new TaviError("UNAVAILABLE", "the owner is stopping");
    if (entry.state === "failed")
      throw new TaviError(
        "UNAVAILABLE",
        `${entry.pluginId} has failed (${entry.reason ?? "repeated failures"}); probe it again (\`tavi mcp probe ${entry.pluginId}\`) once it is fixed`,
        { details: { mcpFailure: "failed" } },
      );
    if (entry.state === "login-required")
      throw new TaviError("NOT_CONFIGURED", `${entry.pluginId} needs a login: ${entry.reason ?? "its credentials expired"}`);
    if (entry.state === "backing-off" && entry.retryAt !== undefined && this.#now() < entry.retryAt) {
      throw new TaviError(
        "UNAVAILABLE",
        `${entry.pluginId} is restarting after a failure (${entry.reason ?? "it crashed"}); next try in ${String(Math.ceil((entry.retryAt - this.#now()) / 1000))} s`,
        { details: { mcpFailure: "backing-off" } },
      );
    }
  }

  /** A slot under the server's concurrency; later calls queue up to the limit, then fail fast. */
  async #acquire(entry: Entry, concurrency: number, signal: AbortSignal | undefined): Promise<void> {
    if (entry.inFlight < concurrency) {
      entry.inFlight += 1;
      return;
    }
    if (entry.waiters.length >= this.#setting("queueLimit"))
      throw new TaviError(
        "UNAVAILABLE",
        `${entry.pluginId} is busy: ${String(concurrency)} calls run and ${String(entry.waiters.length)} wait`,
        { details: { mcpFailure: "busy" } },
      );
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = (): void => {
        const index = entry.waiters.indexOf(waiter);
        if (index !== -1) entry.waiters.splice(index, 1);
        reject(new TaviError("CANCELLED", "the call was cancelled while it waited"));
      };
      if (signal?.aborted === true) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.waiters.push(waiter);
    });
  }

  /** A finished call's slot passes straight to the first waiter, so no call starting meanwhile can take it. */
  #release(entry: Entry): void {
    entry.lastUsed = this.#now();
    const next = entry.waiters.shift();
    if (next !== undefined) {
      next.resolve();
      return;
    }
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    this.#armIdle(entry);
  }

  /** A stdio server with nothing to do for `idleMs` is stopped. */
  #armIdle(entry: Entry): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    if (entry.spec?.transport !== "stdio" || entry.inFlight > 0) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      // Best effort: an idle server left connected is stopped by the next idle check or at shutdown.
      if (entry.inFlight === 0) void this.#disconnect(entry, "idle").catch(() => undefined);
    }, this.#setting("idleMs"));
    entry.idleTimer.unref();
  }

  /** At most `maxRunning` stdio servers: the least recently used idle one is stopped; all busy fails fast. */
  async #makeRoom(entry: Entry): Promise<void> {
    if (entry.spec?.transport !== "stdio" || entry.connection !== undefined) return;
    const running = [...this.#entries.values()].filter(
      (other) => other !== entry && other.spec?.transport === "stdio" && (other.connection !== undefined || other.connecting !== undefined),
    );
    // A retired connection still finishing its calls is a process running too.
    const retired = [...this.#entries.values()].reduce((count, other) => count + other.retired.size, 0);
    if (running.length + retired < this.#setting("maxRunning")) return;
    const idle = running
      .filter((other) => other.inFlight === 0 && other.connecting === undefined)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (idle === undefined)
      throw new TaviError("UNAVAILABLE", `all ${String(this.#setting("maxRunning"))} MCP servers that may run at once are busy`, {
        details: { mcpFailure: "busy" },
      });
    await this.#disconnect(idle, "making room");
  }

  async #specOf(entry: Entry): Promise<McpServerSpec> {
    if (entry.spec === undefined) {
      const spec = await this.#options.spec(entry.pluginId);
      if (spec === undefined) throw new TaviError("UNAVAILABLE", `${entry.pluginId} is not enabled and approved`);
      entry.spec = spec;
    }
    return entry.spec;
  }

  /** The server's connection: the open one, the connect in progress, or a new connect (one per server at a time). */
  #connection(entry: Entry): Promise<McpConnection> {
    if (entry.connection !== undefined) return Promise.resolve(entry.connection);
    if (entry.connecting === undefined) {
      const connecting = this.#connect(entry);
      entry.connecting = connecting;
      const settle = (): void => {
        if (entry.connecting === connecting) entry.connecting = undefined;
      };
      connecting.then(settle, settle);
    }
    return entry.connecting;
  }

  async #connect(entry: Entry): Promise<McpConnection> {
    const epoch = entry.epoch;
    const spec = await this.#specOf(entry);
    await this.#makeRoom(entry);
    let endpoint: Awaited<ReturnType<McpServerSpec["endpoint"]>>;
    try {
      endpoint = await spec.endpoint();
    } catch (error) {
      // What runs is not what was approved (a changed binary, interpreter or files): refused, and the server
      // failed with its notice at once — never retried in a backoff as if it might come back by itself.
      if (error instanceof TaviError && error.details?.["mcpFailure"] === "integrity")
        await this.markFailed(entry.pluginId, error.message.slice(0, 300));
      throw error;
    }
    // Nothing has started yet (a connection spawns on its first request): a stop meanwhile wins.
    if (entry.epoch !== epoch) throw new TaviError("UNAVAILABLE", `${entry.pluginId} was stopped while it was starting; try again`);
    const connection = new McpConnection({
      endpoint,
      maxMessageBytes: spec.maxMessageBytes,
      ...(spec.prior === undefined ? {} : { prior: spec.prior }),
      ...(this.#options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: this.#options.connectTimeoutMs }),
      onEvent: (event) => this.#emit({ kind: "client", pluginId: entry.pluginId, event }),
    });
    entry.connection = connection;
    if (entry.state !== "running") this.#setState(entry, "running");
    return connection;
  }

  /** A failure of the server itself: a backoff from 30 s doubling to 10 minutes, `failed` after five in a row. */
  async #failed(entry: Entry, error: unknown): Promise<void> {
    // A server waiting for a login is not failing: its calls fail fast with that reason until it signs in.
    if (entry.state === "login-required") return;
    entry.failures += 1;
    const reason = clip(errorMessage(error), 300);
    await this.#disconnect(entry, "failure");
    if (entry.failures >= this.#setting("failuresToFail")) {
      entry.retryAt = undefined;
      this.#setState(entry, "failed", reason);
      try {
        await this.#options.onFailed?.(entry.pluginId, reason);
      } catch {
        // Recording the notice failed: the state stands.
      }
      return;
    }
    const delay = Math.min(this.#setting("backoffBaseMs") * 2 ** (entry.failures - 1), this.#setting("backoffCapMs"));
    entry.retryAt = this.#now() + delay;
    this.#setState(entry, "backing-off", reason);
  }

  async #disconnect(entry: Entry, why: string, kill = false, drain = false): Promise<void> {
    const connection = entry.connection;
    entry.connection = undefined;
    entry.epoch += 1;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    if (connection === undefined) return;
    // Retired, not closed, while calls run on it: they finish on the old server, and the next call starts the new one.
    if (drain && !kill && (entry.using.get(connection) ?? 0) > 0) {
      entry.retired.add(connection);
      if (entry.state === "running") this.#setState(entry, "stopped", why);
      return;
    }
    try {
      if (kill) await connection.kill();
      else await connection.close();
    } catch {
      // Closing is best effort; the transport reaps the group.
    }
    if (entry.state === "running") this.#setState(entry, "stopped", why);
  }

  /** The server's tools, fresh. */
  async list(pluginId: string, signal?: AbortSignal): Promise<readonly Tool[]> {
    const entry = this.#entry(pluginId);
    this.#admissible(entry);
    let connection: McpConnection | undefined;
    try {
      connection = await this.#connection(entry);
      const tools = await connection.listTools(signal);
      this.#succeeded(entry, connection);
      return tools;
    } catch (error) {
      if ((isServerFailure(error) || !(error instanceof TaviError)) && !this.#closedOnPurpose(entry, connection))
        await this.#failed(entry, error);
      throw error;
    }
  }

  /**
   * One read of a server other than a tool call — its prompts or resources
   * — on its connection, started as a call would start it, within
   * `timeoutMs`; a server failure counts as for a listing.
   */
  async read<T>(
    pluginId: string,
    work: (connection: McpConnection, signal: AbortSignal) => Promise<T>,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<T> {
    const entry = this.#entry(pluginId);
    this.#admissible(entry);
    const spec = await this.#specOf(entry);
    // Within the server's concurrency, as a call is, and stopped with the turn that asked.
    await this.#acquire(entry, spec.concurrency, options.signal);
    const late = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = options.signal === undefined ? late : AbortSignal.any([late, options.signal]);
    let connection: McpConnection | undefined;
    try {
      connection = await this.#connection(entry);
      const answer = await work(connection, signal);
      this.#succeeded(entry, connection);
      return answer;
    } catch (error) {
      // A read cut off — late, or cancelled — is not the server failing; nor is its refusal (an error answer).
      if (signal.aborted)
        throw new TaviError(
          late.aborted ? "UNAVAILABLE" : "CANCELLED",
          late.aborted ? "the MCP server did not answer in time" : "cancelled",
        );
      if (isServerFailure(error) && !this.#closedOnPurpose(entry, connection)) await this.#failed(entry, error);
      throw error;
    } finally {
      this.#release(entry);
    }
  }

  /** A call cut off by a stop, an idle close or a re-probe (its connection no longer the entry's) is not the server failing. */
  #closedOnPurpose(entry: Entry, connection: McpConnection | undefined): boolean {
    return connection !== undefined && entry.connection !== connection;
  }

  #succeeded(entry: Entry, connection: McpConnection): void {
    // A call that finished on a connection a stop retired says nothing of the server now: its state, failures and era
    // stay as the stop, a failure or a login left them.
    if (entry.connection !== connection) return;
    entry.failures = 0;
    entry.retryAt = undefined;
    if (entry.state !== "running") this.#setState(entry, "running");
    const prior = connection.prior;
    if (prior !== undefined && entry.spec !== undefined && JSON.stringify(prior) !== JSON.stringify(entry.spec.prior)) {
      entry.spec = { ...entry.spec, prior };
      this.#emit({ kind: "era", pluginId: entry.pluginId, prior });
      // Best effort: an era change is a notice; the supervisor's own state is already updated.
      void Promise.resolve(this.#options.onEra?.(entry.pluginId, entry.spec.version, prior)).catch(() => undefined);
    }
  }

  /**
   * One tool call, under the server's concurrency, with its timeout. A call
   * cancelled or timed out is uncertain; when its server then does not answer
   * a ping within the grace, the server's group is killed, every other call
   * in flight on it is uncertain, and the next call reconnects.
   */
  async call(
    pluginId: string,
    tool: string,
    args: unknown,
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs: number;
      readonly definition?: Tool;
      readonly elicit?: McpElicit;
      readonly onProgress?: McpCallOptions["onProgress"];
    },
  ): Promise<McpCallResult> {
    const entry = this.#entry(pluginId);
    this.#admissible(entry);
    const spec = await this.#specOf(entry);
    await this.#acquire(entry, spec.concurrency, options.signal);
    const started = this.#now();
    const digest = inputDigest(args);
    const controller = new AbortController();
    const timeOut = (): NodeJS.Timeout => {
      const armed = setTimeout(
        () =>
          controller.abort(new TaviError("UNAVAILABLE", `${tool} did not answer within ${String(Math.round(options.timeoutMs / 1000))} s`)),
        options.timeoutMs,
      );
      armed.unref();
      return armed;
    };
    let timer = timeOut();
    // While its person answers a server's question the call is not late: its clock starts again after.
    const ask = options.elicit;
    const elicit: McpElicit | undefined =
      ask === undefined
        ? undefined
        : async (request, era) => {
            clearTimeout(timer);
            try {
              return await ask(request, era);
            } finally {
              if (!controller.signal.aborted) timer = timeOut();
            }
          };
    // The call's clock is this one, paused while a question waits: the SDK's own request timeout (60 s by default,
    // never reset by a question) is set where it cannot fire first.
    const callOptions = {
      signal: controller.signal,
      timeoutMs: elicit === undefined ? options.timeoutMs + SDK_TIMEOUT_SLACK_MS : SDK_TIMEOUT_WITH_QUESTIONS_MS,
      ...definedOnly({
        definition: options.definition,
        elicit,
        onProgress: options.onProgress,
      }),
    };
    const forward = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forward, { once: true });
    entry.calls.add(controller);
    let release = (): void => undefined;
    try {
      let connection: McpConnection;
      try {
        connection = await this.#connection(entry);
      } catch (error) {
        if (!(error instanceof TaviError) || isServerFailure(error)) await this.#failed(entry, error);
        throw error;
      }
      release = this.#using(entry, connection);
      try {
        let result: McpCallResult;
        try {
          result = await connection.callTool(tool, args as Record<string, unknown>, callOptions);
        } catch (error) {
          // An http server refusing its cached era at connect is probed once more, with no prior; a call
          // that may have run is never sent twice, so only a failed connect is retried.
          const spec = entry.spec;
          // A refused credential is not a refused era: the cached era stands.
          if (
            spec?.transport !== "http" ||
            spec.prior === undefined ||
            !(error instanceof TaviError) ||
            error.details?.["where"] !== "connect" ||
            error.details["mcpFailure"] === "auth" ||
            controller.signal.aborted
          )
            throw error;
          const { prior: _stale, ...fresh } = spec;
          entry.spec = fresh;
          await this.#disconnect(entry, "re-probing its era");
          connection = await this.#connection(entry);
          release();
          release = this.#using(entry, connection);
          result = await connection.callTool(tool, args as Record<string, unknown>, callOptions);
        }
        this.#succeeded(entry, connection);
        this.#emit({ kind: "call", pluginId, tool, outcome: "ok", ms: this.#now() - started, digest });
        return result;
      } catch (error) {
        // A question its person has not answered yet: not a failure; the task waits, and the call runs again.
        if (error instanceof WorkflowWaitSuspend) {
          this.#emit({ kind: "call", pluginId, tool, outcome: "asked", ms: this.#now() - started, digest });
          throw error;
        }
        if (controller.signal.aborted) {
          this.#emit({ kind: "call", pluginId, tool, outcome: "uncertain", ms: this.#now() - started, digest });
          // Best effort: the cancelled call is already answered; its connection is retired either way.
          void this.#afterCancel(entry, connection).catch(() => undefined);
          const reason = controller.signal.reason;
          throw reason instanceof TaviError
            ? new TaviError(reason.code, reason.message, { details: { mcpFailure: "uncertain" } })
            : new TaviError("CANCELLED", `${tool} was cancelled; whether it ran is uncertain`, { details: { mcpFailure: "uncertain" } });
        }
        this.#emit({
          kind: "call",
          pluginId,
          tool,
          outcome: isServerFailure(error) ? "uncertain" : "error",
          ms: this.#now() - started,
          digest,
        });
        if (isServerFailure(error) && !this.#closedOnPurpose(entry, connection)) await this.#failed(entry, error);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", forward);
      entry.calls.delete(controller);
      release();
      this.#release(entry);
    }
  }

  /** A call starts on `connection`; the release closes a retired connection once its last call settles. */
  #using(entry: Entry, connection: McpConnection): () => void {
    entry.using.set(connection, (entry.using.get(connection) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (entry.using.get(connection) ?? 1) - 1;
      if (left > 0) {
        entry.using.set(connection, left);
        return;
      }
      entry.using.delete(connection);
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      if (entry.retired.delete(connection)) void connection.close().catch(() => undefined);
    };
  }

  /** After a cancel: a server that does not answer a ping within the grace is killed, and its calls in flight are uncertain. */
  async #afterCancel(entry: Entry, connection: McpConnection): Promise<void> {
    if (await connection.ping(this.#setting("cancelGraceMs"))) return;
    if (entry.connection !== connection) return;
    for (const call of entry.calls)
      call.abort(
        new TaviError("UNAVAILABLE", `${entry.pluginId} was stopped after a call it could not cancel; whether this call ran is uncertain`),
      );
    this.#emit({ kind: "killed", pluginId: entry.pluginId, reason: "a cancelled call did not settle" });
    await this.#disconnect(entry, "a cancelled call did not settle", true);
  }

  /**
   * Stops one server (disable, a version switch, a review): calls in flight finish on it, and it
   * closes when the last does; the next call starts it again, as its spec is then.
   */
  async stop(pluginId: string): Promise<void> {
    const entry = this.#entries.get(pluginId);
    if (entry === undefined) return;
    await this.#disconnect(entry, "stopped", false, true);
    entry.spec = undefined;
    entry.failures = 0;
    entry.retryAt = undefined;
    if (entry.state !== "stopped") this.#setState(entry, "stopped");
  }

  /** A server failed by what it offers (drift past 128 tools): stopped and `failed` at once, with its notice. */
  async markFailed(pluginId: string, reason: string): Promise<void> {
    const entry = this.#entry(pluginId);
    await this.#disconnect(entry, "failed");
    entry.failures = this.#setting("failuresToFail");
    entry.retryAt = undefined;
    this.#setState(entry, "failed", reason);
    try {
      await this.#options.onFailed?.(pluginId, reason);
    } catch {
      // Recording the notice failed: the state stands.
    }
  }

  /** A server that needs a login (an expired grant): its tools fail fast with the reason until it signs in. */
  loginRequired(pluginId: string, reason: string): void {
    const entry = this.#entry(pluginId);
    // Best effort: the call already failed for its sign-in; the next call connects again.
    void this.#disconnect(entry, "login required").catch(() => undefined);
    this.#setState(entry, "login-required", reason);
  }

  /** Every server stopped, last started first; the owner's LIFO teardown calls it. */
  async shutdown(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()].reverse();
    for (const entry of entries) {
      for (const waiter of entry.waiters.splice(0)) waiter.reject(new TaviError("UNAVAILABLE", "the owner is stopping"));
      await this.#disconnect(entry, "owner stopping");
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      for (const connection of [...entry.retired]) await connection.close().catch(() => undefined);
      entry.retired.clear();
    }
  }
}

/**
 * Groups and descendants an earlier owner recorded (`<data>/mcp/<id>/run-<n>.pid`, one per process)
 * and left running (a crash): each killed when its leader still has the start
 * time recorded, then its record removed.
 */
export async function reapOrphans(
  dataDirectory: string,
  log: (line: string) => void = () => undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const root = join(dataDirectory, "mcp");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let reaped = 0;
  const rows = await processListing();
  // With no listing to check them against, the records are kept: none is known to be stale. On Windows
  // (no `ps`) each server ran in a Job Object that closed with the owner that started it: only its records are left.
  if (rows === undefined && platform !== "win32") return 0;
  for (const name of names) {
    // One record per process started (a stopped server's retired process and its successor each have their own).
    const files = (await readdir(join(root, name)).catch(() => [] as string[])).filter((entry) => /^run(?:-[0-9a-f]+)?\.pid$/.test(entry));
    for (const recordFile of files) {
      const file = join(root, name, recordFile);
      if (rows === undefined) {
        await rm(file, { force: true });
        continue;
      }
      let record: McpRunRecord;
      try {
        const parsed = McpRunRecordSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
        if (!parsed.success) {
          // Removed once said: nothing in it can be killed by, and it would be said again at every start.
          log(`removed ${name}'s run record ${recordFile}: it is not one an owner writes`);
          await rm(file, { force: true });
          continue;
        }
        record = parsed.data;
      } catch {
        // Unreadable or half-written: nothing in it can be trusted to kill by.
        continue;
      }
      const leader = rows.find((row) => row.pid === record.pgid);
      const members = rows.filter(
        (row) =>
          row.pgid === record.pgid &&
          record.leaderStart !== "" &&
          (leader === undefined
            ? record.descendants.some((entry) => entry.pid === row.pid && entry.start === row.start)
            : leader.start === record.leaderStart),
      );
      const targets = [
        ...(leader !== undefined && leader.start === record.leaderStart ? [{ pid: leader.pid, start: leader.start }] : []),
        ...members.map((row) => ({ pid: row.pid, start: row.start })),
        ...record.descendants,
      ];
      const killed = await sweep(targets);
      if (killed > 0) {
        reaped += killed;
        log(`reaped ${String(killed)} process(es) of ${name} left by an earlier owner`);
      }
      await rm(file, { force: true });
    }
  }
  return reaped;
}
