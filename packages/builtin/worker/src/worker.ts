import { AsyncLocalStorage } from "node:async_hooks";
import { subscribe } from "node:diagnostics_channel";
import type { Socket } from "node:net";

import { z } from "zod";

import {
  FrameReader,
  MAX_STATE_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  snapshot,
  type CallContext,
  type OwnerMessage,
  type WireError,
  type WorkerMessage,
} from "./protocol.js";

/**
 * A plugin worker: run confined by the
 * owner's shim, it imports one approved plugin and gives it the context the
 * owner would, over the protocol on stdin and stdout. What it registers is
 * sent back as data; every call arrives as data and answers as data.
 *
 * stdout carries frames only: the plugin's `console` and any write of its
 * own to stdout become log lines.
 *
 * `process.env` holds no secret here: reading a credential-like variable it
 * does not hold throws, naming `ctx.secret(key)`.
 */

/** A variable that names a credential (the owner's `SECRET_NAME`, in `sandbox-browser-tools.ts`). */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
/** Node's own settings that a name check would take for credentials: `node:tls` reads this one on every connection. */
const RUNTIME_SETTINGS: ReadonlySet<string> = new Set(["NODE_TLS_REJECT_UNAUTHORIZED"]);
/** The environment itself, which `ctx.secret` reads: a masked setting's placeholder may be absent. */
const environment = process.env;
process.env = new Proxy(environment, {
  get(target, key, receiver) {
    if (typeof key === "string" && !(key in target) && SECRET_NAME.test(key) && !RUNTIME_SETTINGS.has(key)) {
      throw new Error(
        `process.env.${key} is not set in a plugin worker: a plugin reads its credential settings with ctx.secret(key), declared in its manifest's config (and in rawSecrets if it must hold the value itself)`,
      );
    }
    return Reflect.get(target, key, receiver) as unknown;
  },
});

const writeOut = process.stdout.write.bind(process.stdout);
const send = (message: WorkerMessage): void => {
  writeOut(encodeFrame(message));
};
const log = (level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void => {
  send({
    t: "log",
    level,
    message: String(message).slice(0, 2_000),
    ...(meta === undefined ? {} : { meta: snapshot(meta) as Record<string, unknown> }),
  });
};
const text = (items: readonly unknown[]): string =>
  items.map((item) => (typeof item === "string" ? item : JSON.stringify(snapshot(item)))).join(" ");
console.log = (...items: unknown[]) => log("info", text(items));
console.info = console.log;
console.debug = (...items: unknown[]) => log("debug", text(items));
console.warn = (...items: unknown[]) => log("warn", text(items));
console.error = (...items: unknown[]) => log("error", text(items));
process.stdout.write = ((chunk: unknown) => {
  log("info", typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
  return true;
}) as typeof process.stdout.write;

/**
 * A call whose tool declares sink `none` runs in this scope, and any
 * request it starts is refused and counted: `fetch` (wrapped here, so a pooled
 * connection is no way round), every `node:http(s)` request
 * (`http.client.request.created`, a kept-alive socket included), and every new
 * socket (`net.client.socket`, under `http2`, `tls`, `net` and a bundled `undici`). Set up
 * here, before the plugin's module is imported, so no reference the plugin
 * takes predates it. A request some other `undici` makes on a connection it
 * pooled is only counted (`undici:request:create`): the call still fails. It
 * stops a mistaken request, not a hostile plugin: work queued outside the
 * call's async context is outside the scope.
 */
const noNetwork = new AsyncLocalStorage<{ requests: number }>();
const refusedRequest = (): Error => new Error("this tool declares no network use (sink none): its request was refused");
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  const scope = noNetwork.getStore();
  if (scope === undefined) return nativeFetch(...args);
  scope.requests += 1;
  throw new TypeError("fetch failed", { cause: refusedRequest() });
}) as typeof fetch;
subscribe("net.client.socket", (message) => {
  const scope = noNetwork.getStore();
  if (scope === undefined) return;
  scope.requests += 1;
  const { socket } = message as { readonly socket: Socket };
  // After the caller has attached its listeners: destroyed here, its error would be unhandled.
  process.nextTick(() => socket.destroy(refusedRequest()));
});
// `node:http(s)` reuses a kept-alive socket with no new one: its request is refused itself.
subscribe("http.client.request.created", (message) => {
  const scope = noNetwork.getStore();
  if (scope === undefined) return;
  scope.requests += 1;
  // Published as the request is made, before a kept-alive socket can write it; it reports its error on a later tick.
  (message as { readonly request: { destroy(error: Error): void } }).request.destroy(refusedRequest());
});
subscribe("undici:request:create", () => {
  const scope = noNetwork.getStore();
  if (scope !== undefined) scope.requests += 1;
});

/** The plugin's own error type (`ctx.TaviError`): its code crosses to the owner. */
class TaviError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, options: { readonly details?: Record<string, unknown> } = {}) {
    super(message);
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

const wireError = (error: unknown): WireError => {
  if (error instanceof TaviError)
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: snapshot(error.details) as Record<string, unknown> }),
    };
  const code =
    typeof (error as { code?: unknown })?.code === "string" && /^[A-Z_]+$/.test((error as { code: string }).code)
      ? (error as { code: string }).code
      : "TOOL_FAILED";
  return { code, message: error instanceof Error ? error.message : String(error) };
};

type Tool = {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  readonly beforeCall?: (input: unknown, options: { readonly signal: AbortSignal }) => unknown;
  readonly handler: (input: unknown, options: { readonly signal: AbortSignal }, context?: CallContext) => unknown;
};
type Hook = (input: unknown, next: ((input?: unknown) => Promise<unknown>) & { readonly signal: AbortSignal }) => unknown;

const tools = new Map<string, Tool>();
const hooks: { readonly event: string; readonly match?: unknown; readonly hook: Hook }[] = [];
const commands = new Map<string, (input: { readonly envelope: unknown; readonly args: string; readonly signal: AbortSignal }) => unknown>();
type SignalSource = { readonly id: string; readonly retracts?: false; readonly collect: (input: Record<string, unknown>) => unknown };
const signalSources = new Map<string, SignalSource>();
const deferred: (() => unknown)[] = [];
const lifetime = new AbortController();
const calls = new Map<number, AbortController>();
const requests = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }>();
let nextRequest = 0;
let registering = true;
let stopModule: (() => unknown) | undefined;

type RequestBody =
  Extract<WorkerMessage, { t: "request" }> extends infer M ? (M extends { readonly id: number } ? Omit<M, "id"> : never) : never;

const request = (message: RequestBody): Promise<unknown> =>
  new Promise((resolve, reject) => {
    nextRequest += 1;
    requests.set(nextRequest, { resolve, reject });
    send({ ...message, id: nextRequest } as WorkerMessage);
  });

const notAsWorker = (what: string) => (): never => {
  throw new TaviError("NOT_AUTHORIZED", `${what} needs the owner's process; this plugin runs as a confined worker`);
};

function contextFor(hello: Extract<OwnerMessage, { t: "hello" }>): Record<string, unknown> {
  const open = (): void => {
    if (!registering) throw new Error("plugin registration is closed");
  };
  return {
    pluginId: hello.pluginId,
    version: hello.version,
    config: Object.freeze({ ...hello.config }),
    z,
    log: {
      debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
      info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
      warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
      error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
    },
    scope: { defer: (cleanup: () => unknown) => void deferred.push(cleanup), signal: lifetime.signal },
    signal: lifetime.signal,
    // A raw secret comes from the owner; any other is the placeholder its proxy replaces toward the declared hosts.
    secret: async (key: string): Promise<string | null> => {
      if (hello.rawSecrets.includes(key)) return (await request({ t: "request", op: "secret", key })) as string | null;
      const variable = hello.maskedEnv[key];
      // A declared credential nobody set is absent, as the owner reads it: the plugin decides what it does without one.
      if (variable === undefined && hello.credentials?.includes(key) === true) return null;
      if (variable === undefined) throw new TaviError("NOT_AUTHORIZED", `${key} is not a credential setting of ${hello.pluginId}`);
      return environment[variable] ?? null;
    },
    state: {
      load: async () => (await request({ t: "request", op: "state.load" })) as Record<string, unknown>,
      put: async (namespace: string, value: unknown) => {
        const stored = snapshot(value);
        if (Buffer.byteLength(JSON.stringify(stored ?? null)) > MAX_STATE_BYTES)
          throw new TaviError("INVALID_INPUT", `a state value is at most ${String(MAX_STATE_BYTES)} bytes of JSON`);
        await request({ t: "request", op: "state.put", namespace, value: stored });
      },
    },
    ui: {
      status: (envelope: unknown, statusText?: string) =>
        send({ t: "ui", kind: "status", envelope: snapshot(envelope), ...(statusText === undefined ? {} : { text: String(statusText) }) }),
      notice: (envelope: unknown, noticeText: string) =>
        send({ t: "ui", kind: "notice", envelope: snapshot(envelope), text: String(noticeText) }),
      publish: (envelope: unknown, key: string, value: unknown) =>
        send({ t: "ui", kind: "publish", envelope: snapshot(envelope), key: String(key), value: snapshot(value) }),
    },
    // A heartbeat signal source: its collect answers the owner's call as data. A heartbeat provider is still the owner's.
    provideSignals: (source: SignalSource) => {
      open();
      if (typeof source?.collect !== "function" || typeof source.id !== "string")
        throw new Error("provideSignals needs a source with an id and a collect function");
      if (signalSources.has(source.id)) throw new Error(`provideSignals was already called for ${source.id}`);
      signalSources.set(source.id, source);
    },
    registerTool: (tool: Tool) => {
      open();
      if (tools.has(tool.name)) throw new Error(`tool ${tool.name} was registered twice`);
      tools.set(tool.name, tool);
    },
    hooks: {
      on: (event: string, matchOrHook: unknown, maybeHook?: Hook) => {
        open();
        const hook = (typeof matchOrHook === "function" ? matchOrHook : maybeHook) as Hook | undefined;
        if (typeof hook !== "function") throw new Error(`hooks.on("${event}") needs a hook function`);
        hooks.push({ event, ...(typeof matchOrHook === "function" ? {} : { match: snapshot(matchOrHook) }), hook });
      },
    },
    commands: {
      register: (command: {
        readonly name: string;
        readonly run: (input: { readonly envelope: unknown; readonly args: string; readonly signal: AbortSignal }) => unknown;
      }) => {
        open();
        if (typeof command?.run !== "function") throw new Error("commands.register needs a run function");
        if (commands.has(command.name)) throw new Error(`command /${command.name} was registered twice`);
        commands.set(command.name, command.run);
      },
    },
    registerSearch: notAsWorker("registerSearch"),
    registerFetch: notAsWorker("registerFetch"),
    registerModel: notAsWorker("registerModel"),
    registerChannel: notAsWorker("registerChannel"),
    provideRouter: notAsWorker("provideRouter"),
    TaviError,
  };
}

async function start(hello: Extract<OwnerMessage, { t: "hello" }>): Promise<void> {
  if (hello.protocol !== PROTOCOL_VERSION)
    throw new TaviError(
      "UNAVAILABLE",
      `the owner speaks worker protocol ${String(hello.protocol)}, this worker ${String(PROTOCOL_VERSION)}`,
    );
  const loaded = (await import(hello.entryUrl)) as Record<string, unknown>;
  const candidate = (typeof loaded["default"] === "object" && loaded["default"] !== null ? loaded["default"] : loaded) as Record<
    string,
    unknown
  >;
  const bound = (name: string) =>
    typeof candidate[name] === "function" ? (candidate[name] as (...args: unknown[]) => unknown).bind(candidate) : undefined;
  const register = bound("register");
  const begin = bound("start");
  stopModule = bound("stop");
  if (register === undefined && begin === undefined) throw new Error("the entry exports neither register nor start");
  const context = contextFor(hello);
  await register?.(context);
  registering = false;
  await begin?.(context);
  send({
    t: "ready",
    protocol: PROTOCOL_VERSION,
    pluginId: hello.pluginId,
    contentHash: hello.contentHash,
    registrations: {
      tools: [...tools.values()].map((tool) => ({
        name: tool.name,
        inputJsonSchema: z.toJSONSchema(tool.inputSchema, { io: "input", target: "draft-7", unrepresentable: "any" }) as Record<
          string,
          unknown
        >,
        beforeCall: typeof tool.beforeCall === "function",
      })),
      hooks: hooks.map(({ event, match }) => ({ event, ...(match === undefined ? {} : { match }) })),
      commands: [...commands.keys()],
      signalSources: [...signalSources.values()].map((source) => ({
        id: source.id,
        ...(source.retracts === false ? { retracts: false as const } : {}),
      })),
    },
  });
}

async function call(message: Extract<OwnerMessage, { t: "call" }>): Promise<unknown> {
  const controller = new AbortController();
  calls.set(message.id, controller);
  const signal = AbortSignal.any([controller.signal, lifetime.signal]);
  try {
    if (message.op === "tool" || message.op === "before") {
      const tool = tools.get(message.name);
      if (tool === undefined) throw new TaviError("NOT_FOUND", `no tool ${message.name}`);
      const parsed = tool.inputSchema.safeParse(message.input);
      if (!parsed.success)
        throw new TaviError("INVALID_INPUT", `${message.name} received invalid arguments`, {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      const run = async (): Promise<unknown> =>
        message.op === "before"
          ? await tool.beforeCall?.(parsed.data, { signal })
          : await tool.handler(parsed.data, { signal }, message.context);
      if (message.noNetwork !== true) return snapshot(await run());
      const scope = { requests: 0 };
      let result: unknown;
      let failure: unknown;
      try {
        result = await noNetwork.run(scope, run);
      } catch (error) {
        failure = error;
      }
      // A request made fails the call whatever the handler did with the refusal.
      if (scope.requests > 0)
        throw new TaviError(
          "NOT_AUTHORIZED",
          `${message.name} declares no network use (sink none) but made ${String(scope.requests)} request${scope.requests === 1 ? "" : "s"}`,
          { details: { requests: scope.requests } },
        );
      if (failure !== undefined) throw failure;
      return snapshot(result);
    }
    if (message.op === "hook") {
      const entry = hooks[message.index];
      if (entry === undefined) throw new TaviError("NOT_FOUND", `no hook ${String(message.index)}`);
      const next = Object.assign(
        (input?: unknown) =>
          request({ t: "request", op: "next", call: message.id, ...(input === undefined ? {} : { input: snapshot(input) }) }),
        { signal },
      );
      return snapshot(await entry.hook(message.input, next));
    }
    if (message.op === "collect") {
      const source = signalSources.get(message.name);
      if (source === undefined) throw new TaviError("NOT_FOUND", `no signal source ${message.name}`);
      return snapshot(await source.collect({ ...message.input, signal }));
    }
    if (message.op === "command") {
      const run = commands.get(message.name);
      if (run === undefined) throw new TaviError("NOT_FOUND", `no command /${message.name}`);
      return snapshot(await run({ envelope: message.input.envelope, args: message.input.args, signal }));
    }
    throw new TaviError("INVALID_INPUT", "an unknown call");
  } finally {
    calls.delete(message.id);
  }
}

async function stop(): Promise<never> {
  lifetime.abort(new TaviError("CANCELLED", "the worker is stopping"));
  try {
    await stopModule?.();
    for (const cleanup of deferred.reverse()) await cleanup();
  } catch (error) {
    log("warn", "stopping the plugin failed", { error: error instanceof Error ? error.message : String(error) });
  }
  process.exit(0);
}

/** A call's answer; one too large to cross is answered as that, never left unanswered (nor ending the worker). */
function reply(
  id: number,
  answer: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: WireError },
): void {
  try {
    send({ t: "reply", id, ...answer });
  } catch (error) {
    send({
      t: "reply",
      id,
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `the answer could not be sent to the owner: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
  }
}

const reader = new FrameReader(
  (raw) => {
    const message = raw as OwnerMessage;
    switch (message.t) {
      case "hello":
        start(message).catch((error: unknown) => {
          send({ t: "failed", error: wireError(error) });
          setTimeout(() => process.exit(1), 50);
        });
        return;
      case "call":
        call(message).then(
          (value) => reply(message.id, { ok: true, value }),
          (error: unknown) => reply(message.id, { ok: false, error: wireError(error) }),
        );
        return;
      case "cancel":
        calls.get(message.id)?.abort(new TaviError("CANCELLED", "the call was cancelled"));
        return;
      case "reply": {
        const pending = requests.get(message.id);
        requests.delete(message.id);
        if (message.ok) pending?.resolve(message.value);
        else pending?.reject(new TaviError(message.error.code, message.error.message));
        return;
      }
      case "stop":
        void stop();
        return;
    }
  },
  (error) => {
    log("error", `the owner's channel broke: ${error.message}`);
    process.exit(1);
  },
);
process.stdin.on("data", (chunk: Buffer) => reader.push(chunk));
// The owner gone is the worker gone.
process.stdin.on("end", () => void stop());
