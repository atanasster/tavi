import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LIMITS_ENTRY_FAILED,
  LIMITS_ENTRY_FAILED_EXIT,
  MOD_EVENTS,
  TaviError,
  type ConfinementPort,
  type ModEnvelope,
  type PluginIsolationPort,
  type PluginToolCallContext,
  type PluginWorkerCollectInput,
  type PluginWorkerHandle,
  type PluginWorkerLaunch,
  type PluginWorkerRegistrations,
  type PluginWorkerServices,
  type PluginWorkerStatus,
  type ResourceLimitPort,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { z } from "zod";

import { FrameReader, MAX_STATE_BYTES, PROTOCOL_VERSION, encodeFrame, snapshot, type OwnerMessage } from "./protocol.js";
import { requireJob, signalGroup } from "@tavi/child-kit";
import { systemChildEnv } from "@tavi/node-kit";

export { MAX_MESSAGE_BYTES, MAX_STATE_BYTES, PROTOCOL_VERSION } from "./protocol.js";

/**
 * Plugin isolation as a
 * `PluginIsolationPort`: each plugin a Node worker (`worker.mjs`) under the
 * owner's `ConfinementPort` and in its `ResourceLimitPort` group, reached
 * over the protocol in `protocol.ts`.
 *
 * - Reads: its own version folder, its home and the worker; the owner's home
 *   and data directory denied. Writes: its home, its `cwd`. Network: the
 *   manifest's `network.domains`, through its proxy.
 * - A credential setting outside `rawSecrets` reaches it as a placeholder its
 *   proxy replaces toward the manifest's exact hosts.
 * - A crash makes its tools `UNAVAILABLE` for a backoff (1 s doubling to a
 *   minute); a read call in flight is tried again once, any other is reported
 *   uncertain. An OOM kill by its cgroup is `QUOTA_EXCEEDED` (the resource limiter's
 *   `RESOURCE_EXHAUSTED`), never retried. An idle worker (no call for `idleMs`) is stopped and started
 *   again on its next call, which must register exactly what it did before.
 */
export interface PluginIsolationOptions {
  readonly confinement: ConfinementPort;
  readonly limits?: ResourceLimitPort;
  /** Read-denied for every worker: the owner's home and data directory. */
  readonly denyRead: readonly string[];
  readonly nested?: boolean;
  /** An owner-private folder for each worker's confinement policy. */
  readonly policyDirectory: string;
  readonly idleMs?: number;
  /** How long a worker has to register; under the owner's 10 s register deadline by default. */
  readonly startTimeoutMs?: number;
  readonly spawn?: typeof spawn;
  /** The worker entry; default the built `worker.mjs` beside this module. */
  readonly workerEntry?: string;
}

const BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** A worker that ran this long before it crashed starts its backoff over. */
const STABLE_MS = 5 * 60_000;
/** The longest log line or status text the owner keeps from a worker. */
const MAX_TEXT = 2_000;

const WireErrorSchema = z.object({
  code: z.string().max(64),
  message: z.string().max(MAX_TEXT * 4),
  details: z.record(z.string(), z.unknown()).optional(),
});
/** What a worker may send: anything else is a broken protocol, and the worker is stopped. */
const WorkerMessageSchema = z.union([
  z.object({
    t: z.literal("ready"),
    protocol: z.number(),
    pluginId: z.string(),
    contentHash: z.string(),
    registrations: z.object({
      tools: z
        .array(z.object({ name: z.string().max(64), inputJsonSchema: z.record(z.string(), z.unknown()), beforeCall: z.boolean() }))
        .max(64),
      hooks: z.array(z.object({ event: z.enum(MOD_EVENTS), match: z.unknown().optional() })).max(64),
      commands: z.array(z.string().max(64)).max(32),
      signalSources: z.array(z.object({ id: z.string().max(40), retracts: z.literal(false).optional() })).max(8),
    }),
  }),
  z.object({ t: z.literal("failed"), error: WireErrorSchema }),
  z.object({ t: z.literal("reply"), id: z.number().int(), ok: z.literal(true), value: z.unknown() }),
  z.object({ t: z.literal("reply"), id: z.number().int(), ok: z.literal(false), error: WireErrorSchema }),
  z.object({ t: z.literal("request"), id: z.number().int(), op: z.literal("state.load") }),
  z.object({
    t: z.literal("request"),
    id: z.number().int(),
    op: z.literal("state.put"),
    namespace: z.string().max(128),
    value: z.unknown(),
  }),
  z.object({ t: z.literal("request"), id: z.number().int(), op: z.literal("secret"), key: z.string().max(64) }),
  z.object({ t: z.literal("request"), id: z.number().int(), op: z.literal("next"), call: z.number().int(), input: z.unknown().optional() }),
  z.object({
    t: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    t: z.literal("ui"),
    kind: z.enum(["status", "notice", "publish"]),
    envelope: z.unknown(),
    text: z.string().optional(),
    key: z.string().max(64).optional(),
    value: z.unknown().optional(),
  }),
]);

export function workerEntryPath(): string {
  const beside = join(import.meta.dirname, "worker.mjs");
  return existsSync(beside) ? beside : join(import.meta.dirname, "..", "dist", "worker.mjs");
}

/** The exact hosts among a manifest's domains (no pattern, no port): the only ones a masked credential is put in toward. */
export function exactHosts(domains: readonly string[]): readonly string[] {
  return domains.filter((domain) => !domain.includes("*") && !domain.includes(":"));
}

/** The variable a masked credential setting's placeholder lives in. */
export const maskedVariable = (key: string): string => `TAVI_SECRET_${key.toUpperCase()}`;

/** The longest delay a Node timer holds (2^31 − 1 ms, about 24.8 days); a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

export function createPluginIsolation(options: PluginIsolationOptions): PluginIsolationPort {
  return {
    async start(launch, services) {
      const worker = new Worker(launch, services, options);
      await worker.begin();
      return worker.handle();
    },
  };
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  /** Tried again once after a crash: a read tool call, which changes nothing. */
  readonly retry?: () => Promise<unknown>;
  /** The caller's: a retry still waiting out the backoff ends when it aborts. */
  readonly signal: AbortSignal;
}

/** How long after a worker exits its pipes are let go, when something it left behind still holds them. */
const SETTLE_AFTER_EXIT_MS = 2_000;

class Worker {
  readonly #launch: PluginWorkerLaunch;
  readonly #services: PluginWorkerServices;
  readonly #options: PluginIsolationOptions;
  #child: ReturnType<typeof spawn> | undefined;
  #groupId: string | undefined;
  #state: PluginWorkerStatus["state"] = "idle";
  #registrations: PluginWorkerRegistrations | undefined;
  #starting: Promise<void> | undefined;
  #pending = new Map<number, Pending>();
  #nexts = new Map<number, (input?: unknown) => Promise<unknown>>();
  #nextId = 0;
  #restarts = 0;
  #streak = 0;
  #startedAt = 0;
  #backoffUntil = 0;
  #lastError: string | undefined;
  /** Why the owner refused the worker it just started, kept over its exit's own reason. */
  #refusal: string | undefined;
  #stopped: Promise<void> | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  /** When the running child must be started again (its credentials' CA), and whether that time has come. */
  #renewal: ReturnType<typeof setTimeout> | undefined;
  #renewDue = false;
  #stopping = false;

  constructor(launch: PluginWorkerLaunch, services: PluginWorkerServices, options: PluginIsolationOptions) {
    this.#launch = launch;
    this.#services = services;
    this.#options = options;
  }

  async begin(): Promise<void> {
    await this.#ensure();
  }

  handle(): PluginWorkerHandle {
    const registrations = this.#registrations;
    if (registrations === undefined) throw new TaviError("INTERNAL", "the worker has not started");
    return {
      registrations,
      callTool: (name, input, signal, effect, context) =>
        this.#call(
          { op: "tool", name, input, ...this.#noNetwork(name), ...(context === undefined ? {} : { context }) },
          signal,
          effect === "read",
        ),
      beforeCall: async (name, input, signal) =>
        (await this.#call({ op: "before", name, input, ...this.#noNetwork(name) }, signal, true)) as Awaited<
          ReturnType<PluginWorkerHandle["beforeCall"]>
        >,
      // A collection reads: tried again once after a crash, as a read tool call is.
      collect: (id, input, signal) => this.#call({ op: "collect", name: id, input }, signal, true),
      hook: (index, input, next, signal) => this.#call({ op: "hook", index, input }, signal, false, next),
      command: async (name, input, signal) =>
        (await this.#call({ op: "command", name, input }, signal, false)) as { readonly text: string },
      status: () => ({
        state: this.#state,
        restarts: this.#restarts,
        ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      }),
      stop: () => this.#stop("stopped"),
    };
  }

  /** A tool whose approved manifest declares sink `none` is called with `noNetwork`, so its worker refuses any request it makes. */
  #noNetwork(name: string): { readonly noNetwork?: true } {
    return this.#launch.manifest.tools.some((tool) => tool.name === name && tool.sink === "none") ? { noNetwork: true } : {};
  }

  /** Running, or started now; refused once stopped for good, failed, or while a crash's backoff lasts. */
  async #ensure(): Promise<void> {
    // An idle stop still under way finishes first; the worker then starts again.
    if (this.#stopped !== undefined) await this.#stopped;
    if (this.#state === "running") return;
    if (this.#state === "stopped")
      throw new TaviError("UNAVAILABLE", `plugin ${this.#launch.pluginId} was stopped`, { details: { pluginId: this.#launch.pluginId } });
    if (this.#state === "failed")
      throw new TaviError("UNAVAILABLE", `plugin ${this.#launch.pluginId}'s worker failed: ${this.#lastError ?? "unknown"}`);
    const wait = this.#backoffUntil - Date.now();
    if (wait > 0)
      throw new TaviError(
        "UNAVAILABLE",
        `plugin ${this.#launch.pluginId}'s worker stopped (${this.#lastError ?? "unknown"}); it starts again in ${String(Math.ceil(wait / 1_000))} s`,
        { details: { pluginId: this.#launch.pluginId } },
      );
    this.#starting ??= this.#spawn().finally(() => (this.#starting = undefined));
    return this.#starting;
  }

  async #spawn(): Promise<void> {
    const launch = this.#launch;
    const entry = this.#options.workerEntry ?? workerEntryPath();
    const hosts = exactHosts(launch.manifest.network?.domains ?? []);
    const masked = hosts.length === 0 ? [] : Object.keys(launch.maskedSecrets);
    mkdirSync(join(launch.home, ".tmp"), { recursive: true, mode: 0o700 });
    mkdirSync(this.#options.policyDirectory, { recursive: true, mode: 0o700 });
    const env: Record<string, string> = {
      ...systemChildEnv([dirname(process.execPath)], true),
      HOME: launch.home,
      TMPDIR: join(launch.home, ".tmp"),
      // Node reaches the declared hosts only through the proxy, which it uses when told to (22.21+).
      NODE_USE_ENV_PROXY: "1",
      ...(process.env["LANG"] === undefined ? {} : { LANG: process.env["LANG"] }),
      ...Object.fromEntries(masked.map((key) => [maskedVariable(key), launch.maskedSecrets[key] ?? ""])),
    };
    const command = this.#options.confinement.wrap({
      argv: [process.execPath, entry],
      env,
      policyFile: join(this.#options.policyDirectory, `${launch.pluginId}.json`),
      policy: {
        denyRead: [...this.#options.denyRead],
        allowRead: [launch.directory, dirname(entry), launch.home],
        allowWrite: [launch.home],
        domains: [...(launch.manifest.network?.domains ?? [])],
        nested: this.#options.nested === true,
        ...(masked.length === 0 ? {} : { credentials: masked.map((key) => ({ env: maskedVariable(key), hosts: [...hosts] })) }),
      },
    });
    const placed = this.#options.limits?.place([command.command, ...command.args], "worker") ?? {
      argv: [command.command, ...command.args],
    };
    this.#groupId = placed.groupId;
    const [executable, ...args] = placed.argv as [string, ...string[]];
    const child = (this.#options.spawn ?? spawn)(executable, args, {
      cwd: launch.home,
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    // On Windows its own Job Object, so whatever it starts ends with it.
    requireJob(child);
    this.#child = child;
    this.#refusal = undefined;
    // Started again once its CA nears its end: at once when nothing is in flight, else when the last call is answered.
    clearTimeout(this.#renewal);
    this.#renewDue = false;
    if (command.renewBy !== undefined) this.#armRenewal(command.renewBy);
    const startTimeoutMs = this.#options.startTimeoutMs ?? 8_000;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new TaviError("UNAVAILABLE", `plugin ${launch.pluginId}'s worker did not start in ${String(startTimeoutMs / 1_000)} s`)),
        startTimeoutMs,
      );
      const broken = (why: string): void => {
        this.#refusal = `it broke the worker protocol: ${why}`;
        this.#services.log("error", `plugin ${launch.pluginId}'s worker broke the protocol: ${why}`);
        reject(new TaviError("UNAVAILABLE", `plugin ${launch.pluginId}'s worker broke the protocol: ${why}`));
        this.#kill();
      };
      const reader = new FrameReader(
        (raw) => {
          const parsed = WorkerMessageSchema.safeParse(raw);
          if (!parsed.success) return broken(`a message that is not one (${parsed.error.issues[0]?.message ?? "unknown"})`);
          const message = parsed.data;
          if (message.t !== "ready" && message.t !== "failed") return this.#onMessage(message);
          clearTimeout(timer);
          if (message.t === "failed")
            return reject(
              new TaviError(
                message.error.code === "UNAVAILABLE" ? "UNAVAILABLE" : "TOOL_FAILED",
                `plugin ${launch.pluginId} failed to start as a worker: ${message.error.message.slice(0, MAX_TEXT)}`,
              ),
            );
          try {
            this.#accept(message);
            resolve();
          } catch (error) {
            this.#refusal = errorMessage(error);
            reject(error);
            this.#kill();
          }
        },
        (error) => broken(error.message),
      );
      child.stdout?.on("data", (chunk: Buffer) => reader.push(chunk));
      let stderrLines = 0;
      // The limits wrapper's line: the worker could not enter its cgroup, and never ran.
      let unplaced = false;
      child.stderr?.on("data", (chunk: Buffer) => {
        unplaced ||= chunk.includes(LIMITS_ENTRY_FAILED);
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim() === "" || (stderrLines += 1) > 200) continue;
          this.#services.log("warn", line.slice(0, 2_000));
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new TaviError("UNAVAILABLE", `plugin ${launch.pluginId}'s worker could not start: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (code === LIMITS_ENTRY_FAILED_EXIT && unplaced)
          this.#refusal = "it could not enter its resource limits (its cgroup), so it did not run; tavi doctor shows the limits";
        const exit = this.#exited(child, code, signal);
        reject(
          new TaviError(
            exit.oom ? "QUOTA_EXCEEDED" : "UNAVAILABLE",
            `plugin ${launch.pluginId}'s worker exited before it was ready: ${exit.why}`,
          ),
        );
      });
      child.stdin?.on("error", () => undefined);
      // A process the worker left behind may hold its pipes, and then `close` never comes: a while after the
      // worker exits — stopped or crashed — its streams are let go, so its end is seen.
      child.once("exit", () => {
        const settle = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
        }, SETTLE_AFTER_EXIT_MS);
        settle.unref();
        child.once("close", () => clearTimeout(settle));
      });
    });
    this.#write({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      pluginId: launch.pluginId,
      version: launch.version,
      contentHash: launch.contentHash,
      entryUrl: `${pathToFileURL(launch.entryPath).href}?sha256=${launch.contentHash}`,
      config: { ...launch.config },
      rawSecrets: [...(launch.manifest.rawSecrets ?? [])],
      maskedEnv: Object.fromEntries(Object.keys(launch.maskedSecrets).map((key) => [key, maskedVariable(key)])),
      credentials: Object.entries(launch.manifest.config ?? {})
        .filter(([, field]) => field.type === "credential")
        .map(([key]) => key),
    });
    try {
      await ready;
    } catch (error) {
      this.#lastError = errorMessage(error);
      this.#kill();
      throw error;
    }
    this.#state = "running";
    this.#startedAt = Date.now();
    this.#touch();
  }

  /** The worker's registrations, held to what it registered at its first start. */
  #accept(message: Extract<z.infer<typeof WorkerMessageSchema>, { t: "ready" }>): void {
    const launch = this.#launch;
    if (message.protocol !== PROTOCOL_VERSION || message.pluginId !== launch.pluginId || message.contentHash !== launch.contentHash) {
      throw new TaviError(
        "UNAVAILABLE",
        `plugin ${launch.pluginId}'s worker answered for ${message.pluginId} (${message.contentHash.slice(0, 12)}) on protocol ${String(message.protocol)}`,
      );
    }
    const registrations: PluginWorkerRegistrations = {
      tools: message.registrations.tools,
      hooks: message.registrations.hooks.map((hook) => ({ event: hook.event, ...(hook.match === undefined ? {} : { match: hook.match }) })),
      commands: message.registrations.commands,
      signalSources: message.registrations.signalSources.map((source) => ({
        id: source.id,
        ...(source.retracts === false ? { retracts: false as const } : {}),
      })),
    };
    if (this.#registrations !== undefined && JSON.stringify(this.#registrations) !== JSON.stringify(registrations)) {
      this.#state = "failed";
      throw new TaviError("UNAVAILABLE", `plugin ${launch.pluginId}'s worker registered something else when it started again`);
    }
    this.#registrations = registrations;
  }

  #onMessage(message: Exclude<z.infer<typeof WorkerMessageSchema>, { t: "ready" | "failed" }>): void {
    switch (message.t) {
      case "reply": {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        this.#nexts.delete(message.id);
        if (message.ok) pending?.resolve(message.value);
        else pending?.reject(errorOf(message.error, this.#launch.pluginId));
        this.#touch();
        return;
      }
      case "request":
        void this.#answer(message);
        return;
      case "log":
        this.#services.log(message.level, `${this.#launch.pluginId}: ${message.message.slice(0, MAX_TEXT)}`, message.meta);
        return;
      case "ui":
        try {
          this.#services.ui(message.kind, message.envelope as ModEnvelope, message.text?.slice(0, MAX_TEXT), message.key, message.value);
        } catch (error) {
          this.#services.log("warn", `${this.#launch.pluginId}: a status, notice or published value was refused: ${errorMessage(error)}`);
        }
        return;
    }
  }

  async #answer(message: Extract<z.infer<typeof WorkerMessageSchema>, { t: "request" }>): Promise<void> {
    try {
      let value: unknown;
      if (message.op === "state.load") value = await this.#services.loadState();
      else if (message.op === "state.put") {
        if (Buffer.byteLength(JSON.stringify(message.value ?? null)) > MAX_STATE_BYTES)
          throw new TaviError("INVALID_INPUT", `a state value is at most ${String(MAX_STATE_BYTES)} bytes of JSON`);
        await this.#services.putState(message.namespace, message.value);
      } else if (message.op === "secret") {
        if (!(this.#launch.manifest.rawSecrets ?? []).includes(message.key))
          throw new TaviError("NOT_AUTHORIZED", `${message.key} is not in ${this.#launch.pluginId}'s rawSecrets`);
        value = await this.#services.rawSecret(message.key);
      } else {
        const next = this.#nexts.get(message.call);
        if (next === undefined) throw new TaviError("NOT_FOUND", "that hook call has ended");
        value = await next(message.input);
      }
      let frame: Buffer;
      try {
        frame = encodeFrame({ t: "reply", id: message.id, ok: true, value: value ?? null });
      } catch (error) {
        // Too large to cross: the worker is told so, rather than left waiting.
        throw new TaviError("INVALID_INPUT", `the answer could not be sent to the worker: ${errorMessage(error)}`);
      }
      this.#write(frame);
    } catch (error) {
      this.#write({
        t: "reply",
        id: message.id,
        ok: false,
        error: { code: error instanceof TaviError ? error.code : "TOOL_FAILED", message: errorMessage(error) },
      });
    }
  }

  async #call(
    body:
      | {
          readonly op: "tool" | "before";
          readonly name: string;
          readonly input: unknown;
          readonly noNetwork?: true;
          readonly context?: PluginToolCallContext;
        }
      | { readonly op: "collect"; readonly name: string; readonly input: PluginWorkerCollectInput }
      | { readonly op: "hook"; readonly index: number; readonly input: unknown }
      | { readonly op: "command"; readonly name: string; readonly input: { readonly envelope: unknown; readonly args: string } },
    signal: AbortSignal,
    read: boolean,
    next?: (input?: unknown) => Promise<unknown>,
    retried = false,
  ): Promise<unknown> {
    signal.throwIfAborted();
    await this.#ensure();
    signal.throwIfAborted();
    this.#nextId += 1;
    const id = this.#nextId;
    let frame: Buffer;
    try {
      // What crosses is JSON: a hook's event loses its functions and cycles here, never failing the frame.
      frame = encodeFrame({ t: "call", id, ...body, input: snapshot(body.input) } as OwnerMessage);
    } catch (error) {
      // Refused before it is in flight, so the worker's idle timer is untouched.
      throw new TaviError("INVALID_INPUT", `${this.#launch.pluginId}: the call could not be sent to its worker: ${errorMessage(error)}`, {
        details: { pluginId: this.#launch.pluginId },
      });
    }
    // A call in flight holds the worker: no idle stop until it is answered.
    clearTimeout(this.#idle);
    if (next !== undefined) this.#nexts.set(id, next);
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.#pending.delete(id)) return;
        this.#nexts.delete(id);
        this.#write({ t: "cancel", id });
        reject(signal.reason ?? new TaviError("CANCELLED", "the call was cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const settle =
        <T>(finish: (value: T) => void) =>
        (value: T): void => {
          signal.removeEventListener("abort", onAbort);
          finish(value);
        };
      this.#pending.set(id, {
        resolve: settle(resolve),
        reject: settle(reject),
        signal,
        ...(read && !retried ? { retry: () => this.#call(body, signal, read, next, true) } : {}),
      });
      this.#write(frame);
    });
  }

  /** A message, or a frame already encoded, to the worker. */
  #write(message: OwnerMessage | Buffer): void {
    try {
      this.#child?.stdin?.write(Buffer.isBuffer(message) ? message : encodeFrame(message));
    } catch (error) {
      this.#services.log("warn", `${this.#launch.pluginId}: a message to its worker was not sent: ${errorMessage(error)}`);
    }
  }

  /** The renewal at `at` (epoch ms), in steps no timer overflows: Node fires a longer one at once. */
  #armRenewal(at: number): void {
    const left = at - Date.now();
    this.#renewal = setTimeout(
      () => {
        if (at - Date.now() > 0) {
          this.#armRenewal(at);
          return;
        }
        this.#renewDue = true;
        this.#touch();
      },
      Math.min(Math.max(left, 0), MAX_TIMER_MS),
    );
    this.#renewal.unref();
  }

  /** Stopped after `idleMs` with nothing in flight; started again on its next call. */
  #touch(): void {
    clearTimeout(this.#idle);
    if (this.#pending.size > 0 || this.#state !== "running") return;
    if (this.#renewDue) {
      this.#renewDue = false;
      void this.#stop("idle");
      return;
    }
    // A heartbeat signal source is collected on every check, within its 5 s: never stopped for idleness, it never starts cold then.
    if ((this.#registrations?.signalSources.length ?? 0) > 0) return;
    this.#idle = setTimeout(() => {
      if (this.#pending.size === 0 && this.#state === "running") void this.#stop("idle");
    }, this.#options.idleMs ?? 600_000);
    this.#idle.unref();
  }

  /** Why it exited, and whether its cgroup ended it out of memory (read before the group is released). */
  #exited(
    child: ReturnType<typeof spawn>,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): { readonly why: string; readonly oom: boolean } {
    const groupId = this.#groupId;
    const oom = this.#child === child && groupId !== undefined && this.#options.limits?.outcome(groupId) === "oom";
    const why = this.#refusal ?? (oom ? "it ran out of memory: its cgroup's memory cap ended it" : `it exited (${signal ?? String(code)})`);
    if (this.#child !== child) return { why, oom };
    this.#child = undefined;
    if (groupId !== undefined) this.#options.limits?.release(groupId);
    this.#groupId = undefined;
    clearTimeout(this.#idle);
    clearTimeout(this.#renewal);
    const stopping = this.#stopping;
    this.#stopping = false;
    if (!stopping) {
      this.#restarts += 1;
      // A worker that had run a while starts its backoff over: crashes days apart do not add up.
      this.#streak = this.#startedAt > 0 && Date.now() - this.#startedAt > STABLE_MS ? 1 : this.#streak + 1;
      this.#lastError = why;
      if (this.#state !== "failed" && this.#state !== "stopped") {
        this.#state = "backing-off";
        this.#backoffUntil = Date.now() + Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (this.#streak - 1));
      }
      this.#services.log("warn", `plugin ${this.#launch.pluginId}'s worker stopped: ${this.#lastError}`);
    }
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#nexts.clear();
    for (const call of pending) {
      const retry = call.retry;
      // An OOM kill is the call's own outcome, not a crash a read gets past by trying again.
      if (!stopping && !oom && retry !== undefined) {
        // Cancelled while it waits out the backoff: answered now, not when the retry would start.
        const onAbort = (): void => {
          clearTimeout(wait);
          call.reject(call.signal.reason ?? new TaviError("CANCELLED", "the call was cancelled"));
        };
        const wait = setTimeout(
          () => {
            call.signal.removeEventListener("abort", onAbort);
            void retry().then(call.resolve, call.reject);
          },
          Math.max(0, this.#backoffUntil - Date.now()),
        );
        call.signal.addEventListener("abort", onAbort, { once: true });
        continue;
      }
      const details = { pluginId: this.#launch.pluginId, uncertain: true, ...(oom ? { reason: "memory" } : {}) };
      call.reject(
        oom
          ? new TaviError(
              "QUOTA_EXCEEDED",
              `plugin ${this.#launch.pluginId}'s worker ran out of memory during the call (its cgroup's cap); whether it took effect is unknown`,
              { details },
            )
          : new TaviError(
              "UNAVAILABLE",
              `plugin ${this.#launch.pluginId}'s worker stopped during the call; whether it took effect is unknown`,
              { details },
            ),
      );
    }
    return { why, oom };
  }

  #kill(): void {
    const child = this.#child;
    if (child?.pid === undefined) return;
    if (this.#groupId !== undefined) this.#options.limits?.kill(this.#groupId);
    signalGroup(child, "SIGKILL");
  }

  /** `stopped` is for good (withdrawn, rejected, the owner closing); `idle` starts again on the next call. */
  async #stop(state: "idle" | "stopped"): Promise<void> {
    clearTimeout(this.#idle);
    if (state === "stopped") this.#state = "stopped";
    if (this.#stopped !== undefined) return this.#stopped;
    const child = this.#child;
    if (child === undefined) {
      if (this.#state !== "failed") this.#state = state;
      return;
    }
    this.#stopping = true;
    this.#stopped = (async () => {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      this.#write({ t: "stop" });
      const grace = setTimeout(() => this.#kill(), 3_000);
      await closed;
      clearTimeout(grace);
      if (this.#state !== "stopped" && this.#state !== "failed") this.#state = state;
    })().finally(() => (this.#stopped = undefined));
    return this.#stopped;
  }
}

function errorOf(
  error: { readonly code: string; readonly message: string; readonly details?: Record<string, unknown> | undefined },
  pluginId: string,
): TaviError {
  const codes = [
    "INVALID_INPUT",
    "NOT_FOUND",
    "NOT_AUTHORIZED",
    "CONFLICT",
    "UNAVAILABLE",
    "CANCELLED",
    "QUOTA_EXCEEDED",
    "TOOL_FAILED",
  ] as const;
  const code = (codes as readonly string[]).includes(error.code) ? (error.code as (typeof codes)[number]) : "TOOL_FAILED";
  return new TaviError(code, `${pluginId}: ${error.message}`, { details: { pluginId, ...(error.details ?? {}) } });
}
