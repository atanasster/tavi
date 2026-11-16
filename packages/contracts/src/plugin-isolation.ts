import { TaviError } from "./errors.js";
import type { ModEnvelope, ModEvent } from "./mods.js";
import type { PluginIsolation, PluginManifest } from "./plugin-registry.js";

/**
 * Plugin isolation: a
 * third-party plugin's code in a confined worker, not the owner's address
 * space. `@tavi/plugin-worker` implements it; `external-plugins.ts` sees only
 * this port, and `apps/cli/src/features/sandbox/host.ts` builds it.
 *
 * What crosses is data: a tool's input and result, a hook's snapshot, a
 * command's arguments. A plugin that hands the owner live objects (a channel
 * connector, a search, fetch or model factory, a router, heartbeat or memory
 * provider) cannot be a worker: `workerRefusal` says why, and its approval
 * must keep it in-process.
 */

/** Why `manifest`'s plugin cannot run as a worker, or `undefined` when it can. */
export function workerRefusal(manifest: PluginManifest): string | undefined {
  if (manifest.mcp !== undefined) return "it is an MCP server, which runs out of process already";
  if (manifest.entry === undefined) return "it runs no code in the owner";
  const live = [
    ...(manifest.channels.length > 0 ? ["messaging channels"] : []),
    ...(manifest.capabilities.length > 0 ? ["search, fetch or model providers"] : []),
    ...(manifest.router !== undefined ? ["a routing provider"] : []),
    // A heartbeat provider is a live object; a signal source is not: a worker answers its collect.
    ...(manifest.heartbeat !== undefined ? ["a heartbeat provider"] : []),
    ...(manifest.memory !== undefined ? ["a memory provider"] : []),
    ...(manifest.ideas !== undefined ? ["an ideas provider"] : []),
    ...(manifest.onboarding !== undefined ? ["an onboarding flow"] : []),
  ];
  return live.length === 0 ? undefined : `it supplies ${live.join(", ")}, which the owner uses as live objects a worker cannot hand over`;
}

/** What a worker registered at its start, checked by the owner against the approved manifest. */
export interface PluginWorkerRegistrations {
  readonly tools: readonly { readonly name: string; readonly inputJsonSchema: Record<string, unknown>; readonly beforeCall: boolean }[];
  /** In registration order; a hook is addressed by its index. Its match is the worker's, unchecked until the owner parses it. */
  readonly hooks: readonly { readonly event: ModEvent; readonly match?: unknown }[];
  readonly commands: readonly string[];
  /** Heartbeat signal sources, by id; `retracts: false` as the source said it. */
  readonly signalSources: readonly { readonly id: string; readonly retracts?: false }[];
}

/** A worker's signal source's collection, as the owner asks for it: the heartbeat's scope, without its signal. */
export interface PluginWorkerCollectInput {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly now: string;
  readonly timezone: string;
}

/** What a worker asks of the owner: its state, a raw secret it declared, its log and its status lines. */
export interface PluginWorkerServices {
  loadState(): Promise<Record<string, unknown>>;
  putState(namespace: string, value: unknown): Promise<void>;
  /** The value of a credential setting in the manifest's `rawSecrets`; any other key is refused. */
  rawSecret(key: string): Promise<string | null>;
  log(level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void;
  ui(kind: "status" | "notice" | "publish", envelope: ModEnvelope, text?: string, key?: string, value?: unknown): void;
}

/**
 * Who a plugin tool's call is for and whether anyone attends it: the
 * handler's third argument.
 * `unattended` is a run nobody attends (a schedule's, a heartbeat's), so a
 * source whose terms allow only calls a person makes can refuse in code.
 */
export interface PluginToolCallContext {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly unattended: boolean;
}

/** A worker as the owner sees it. */
export interface PluginWorkerStatus {
  readonly state: "running" | "idle" | "backing-off" | "failed" | "stopped";
  readonly restarts: number;
  readonly lastError?: string;
}

export interface PluginWorkerHandle {
  readonly registrations: PluginWorkerRegistrations;
  /** `context` is the call's, handed to the tool's handler as its third argument. */
  callTool(
    name: string,
    input: unknown,
    signal: AbortSignal,
    effect: "read" | "write" | "external",
    context?: PluginToolCallContext,
  ): Promise<unknown>;
  beforeCall(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ readonly proceed?: boolean; readonly deny?: boolean; readonly reason?: string } | undefined>;
  /** One collection of the worker's signal source `id`: its signals, list or batch, untrusted. */
  collect(id: string, input: PluginWorkerCollectInput, signal: AbortSignal): Promise<unknown>;
  /** Hook `index` on `input`; `next` runs the rest of the chain in the owner, when the hook asks. */
  hook(index: number, input: unknown, next: (input?: unknown) => Promise<unknown>, signal: AbortSignal): Promise<unknown>;
  command(
    name: string,
    input: { readonly envelope: ModEnvelope; readonly args: string },
    signal: AbortSignal,
  ): Promise<{ readonly text: string }>;
  status(): PluginWorkerStatus;
  stop(): Promise<void>;
}

/** One approved plugin version to start as a worker. */
export interface PluginWorkerLaunch {
  readonly pluginId: string;
  readonly version: string;
  readonly contentHash: string;
  readonly directory: string;
  readonly entryPath: string;
  readonly manifest: PluginManifest;
  /** Settings, credential ones holding their reference. */
  readonly config: Readonly<Record<string, unknown>>;
  /** The values of its credential settings outside `rawSecrets`, by key: given to the worker's proxy only. */
  readonly maskedSecrets: Readonly<Record<string, string>>;
  /** Its own read-write folder and `cwd` (`<data>/plugins/<id>/home`). */
  readonly home: string;
}

export interface PluginIsolationPort {
  /** Starts the worker and waits for its registrations; rejects with why it could not start. */
  start(launch: PluginWorkerLaunch, services: PluginWorkerServices): Promise<PluginWorkerHandle>;
}

/** An approval's isolation choices (`tavi plugins approve --in-process`). */
export interface PluginApprovalChoice {
  readonly inProcess?: boolean;
}

/**
 * Where an approval runs `manifest`'s code: a worker whenever it can
 * be one and the approver did not opt out; in-process only by name.
 * `undefined` for a version that runs no owner code.
 */
export function approvedIsolation(manifest: PluginManifest, choice: PluginApprovalChoice): PluginIsolation | undefined {
  if (manifest.mcp !== undefined || manifest.entry === undefined) return undefined;
  const refusal = workerRefusal(manifest);
  const asked = choice.inProcess === true;
  if (refusal === undefined && manifest.isolation !== "in-process" && !asked) return "process";
  const why = refusal ?? (manifest.isolation === "in-process" ? "its manifest asks to run in-process" : undefined);
  if (!asked) {
    throw new TaviError(
      "CONFLICT",
      `${manifest.id} cannot run as a confined worker: ${why ?? "it was not asked to"}; approve it with --in-process to run it in the owner's process, unsandboxed`,
      { details: { pluginId: manifest.id, isolation: "in-process" } },
    );
  }
  return "in-process";
}
