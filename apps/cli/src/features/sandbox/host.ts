import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import type { ConfinementPort, PluginIsolationPort, ResourceLimitPort, SandboxHostPort, SandboxPort } from "@tavi/contracts";
import { createPluginIsolation } from "@tavi/plugin-worker";
import { createResourceLimits, sweepStaleGroups, type LimitsOptions } from "@tavi/plugin-limits";

// Each workload's default caps, for doctor.
export { WORKLOAD_DEFAULTS } from "@tavi/plugin-limits";
import { createRuntimeSandbox, runtimeSharedWritePaths, type RuntimeSandboxOptions } from "@tavi/plugin-sandbox/runtime";
import { createSandboxHost, type SandboxHostOptions } from "@tavi/plugin-sandbox/host";

// Where `tavi sandbox setup` puts its bubblewrap; the host's facts come through `SandboxHostPort.facts()`.
export { TAVI_BWRAP } from "@tavi/plugin-sandbox/host";
import { createSrtConfinement } from "@tavi/plugin-sandbox/srt-cli";
import { writeJsonAtomic, wslDenyRoots, wslVersion, type WslVersion } from "@tavi/node-kit";
import { OWNER_TEMPORARY_STAGING, ownerStagingDirectory } from "@tavi/runtime";

/**
 * Where the owner puts the sandbox modules together: the engine (`SandboxPort`), child
 * confinement (`ConfinementPort`) and host detection (`SandboxHostPort`).
 * This module alone names `@tavi/plugin-sandbox`; every other owner file sees
 * the ports, and composition takes an override for each, as `features/pdf/host.ts`
 * does for the PDF modules.
 */

/**
 * The engine `sandbox.run` and `plugins.validate` run commands through, at
 * the tier host detection settles. Without a host given, Linux shares
 * one default host detection and limits (a short command's validate); macOS
 * needs none.
 */
export function createOwnerSandbox(
  options: Pick<
    RuntimeSandboxOptions,
    "host" | "nested" | "pinnedOff" | "stateDirectory" | "limits" | "caDirectory" | "onWarning" | "parentProxy" | "inspectTls"
  > = {},
): SandboxPort {
  // On Linux every engine needs host detection to run at all: `plugins.validate` runs share one.
  const linux = process.platform === "linux";
  return createRuntimeSandbox({
    ...options,
    ...(options.host === undefined && linux
      ? { host: (defaultHost ??= createSandboxHost({ dataDirectory: join(ownerStagingDirectory(), "sandbox-probe") })) }
      : {}),
    ...(options.limits === undefined && linux ? { limits: (defaultLimits ??= createResourceLimits()) } : {}),
  });
}

/**
 * The host detection and limits an engine made outside composition shares (a
 * CLI command's `plugins.validate`). Inside `serve` those callers
 * are handed composition's engine instead; one made here is closed by its
 * maker, so srt is reset when the command is done (`withOwnerSandbox`).
 */
let defaultHost: SandboxHostPort | undefined;
let defaultLimits: ResourceLimitPort | undefined;

let confinement: ConfinementPort | undefined;

/**
 * `sandbox`, or an engine of the caller's own for `work` when it has none
 * (a CLI command outside `serve`), closed when `work` settles: an engine
 * left open keeps srt's proxies alive and stops `serve`'s shutdown resetting
 * srt.
 */
export async function withOwnerSandbox<T>(
  sandbox: SandboxPort | undefined,
  work: (sandbox: SandboxPort) => Promise<T>,
  make: () => SandboxPort = createOwnerSandbox,
): Promise<T> {
  if (sandbox !== undefined) return await work(sandbox);
  const owned = make();
  try {
    return await work(owned);
  } finally {
    await owned.close?.();
  }
}

/** The folders the owner reads for its chats, beside its data directory. */
export interface OwnerReadRoots {
  readonly dataDirectory: string;
  /** `serve --fs-root`. */
  readonly fsRoots?: readonly string[];
  /** `serve --dev-plugin`. */
  readonly devPlugins?: readonly string[];
  /** `serve --sandbox-read`. */
  readonly sandboxRead?: readonly string[];
}

/**
 * What no confined child (a plugin worker, an MCP server, a PDF, OCR or video
 * child, the browser) reads, but where its own policy opens a folder inside:
 * the person's home, the data directory, and every folder the owner was given
 * for its chats; on WSL also every Windows drive (the Windows profile with it),
 * at `/mnt` or wherever `/etc/wsl.conf` mounts them, and the interop folder
 * (`wslDenyRoots`). srt reads by deny list, so a folder outside `$HOME` the owner was
 * given must be named here, or every child could read it.
 */
export function ownerDenyRead(
  roots: OwnerReadRoots,
  home: string = homedir(),
  wsl: WslVersion | undefined = wslVersion(),
  wslRoots: () => readonly string[] = () => wslDenyRoots(),
): readonly string[] {
  return [
    ...new Set(
      [
        home,
        roots.dataDirectory,
        ...(roots.fsRoots ?? []),
        ...(roots.devPlugins ?? []),
        ...(roots.sandboxRead ?? []),
        ...(wsl === undefined ? [] : wslRoots()),
      ].map((path) => resolvePath(path)),
    ),
  ];
}

/** Where `serve` records the folders it was given for chats, for a command run without it (`tavi mcp add`'s probe). */
function readRootsFile(dataDirectory: string): string {
  return join(dataDirectory, "sandbox", "read-roots.json");
}

/** `serve`'s folders for chats, recorded (0600) where a command run without it reads them. */
export function saveOwnerReadRoots(roots: OwnerReadRoots): void {
  mkdirSync(join(roots.dataDirectory, "sandbox"), { recursive: true, mode: 0o700 });
  writeJsonAtomic(
    readRootsFile(roots.dataDirectory),
    { fsRoots: roots.fsRoots ?? [], devPlugins: roots.devPlugins ?? [], sandboxRead: roots.sandboxRead ?? [] },
    { mode: 0o600 },
  );
}

/** The folders the last `serve` on `dataDirectory` was given for chats; none when it recorded none. */
export function readOwnerReadRoots(dataDirectory: string): OwnerReadRoots {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(readRootsFile(dataDirectory), "utf8"));
  } catch {
    return { dataDirectory };
  }
  const paths = (key: string): readonly string[] => {
    const value = (saved as Record<string, unknown> | null)?.[key];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && isAbsolute(entry)) : [];
  };
  return { dataDirectory, fsRoots: paths("fsRoots"), devPlugins: paths("devPlugins"), sandboxRead: paths("sandboxRead") };
}

/**
 * Where folders given for chats usually lie outside `$HOME`: denied to a
 * command run without `serve` on a data directory no `serve` has recorded its
 * folders in yet (one from before the record), rather than left readable.
 */
const UNRECORDED_ROOT_DENIES = ["/Volumes", "/media", "/mnt", "/Users/Shared", "/srv"] as const;

/** The owner's confinement for a command run without `serve`: denying what the last `serve` recorded, or the usual places when none did. */
export function offlineOwnerConfinement(dataDirectory: string): ConfinementPort {
  const recorded = existsSync(readRootsFile(dataDirectory));
  return denyingRead(ownerConfinement(), [
    ...ownerDenyRead(readOwnerReadRoots(dataDirectory)),
    ...(recorded ? [] : UNRECORDED_ROOT_DENIES),
  ]);
}

/** `inner`, with `denyRead` added to every launch's policy. */
export function denyingRead(inner: ConfinementPort, denyRead: readonly string[]): ConfinementPort {
  if (denyRead.length === 0) return inner;
  return {
    wrap: (launch) =>
      inner.wrap({ ...launch, policy: { ...launch.policy, denyRead: [...new Set([...launch.policy.denyRead, ...denyRead])] } }),
  };
}

/**
 * The confinement MCP stdio servers, the PDF engine's and the video
 * analysers' children are wrapped in: one srt process per child, none of
 * which reads the owner's staging — its directory, and the names it stages
 * under in the system temporary directory. Composition adds `ownerDenyRead`
 * (`denyingRead`).
 */
export function ownerConfinement(): ConfinementPort {
  return (confinement ??= createSrtConfinement({ alwaysDenyRead: ownerStagingDenies() }));
}

/** The owner's staging, and the names it stages under in the system temporary directory: never readable by a confined child. */
function ownerStagingDenies(): readonly string[] {
  return [ownerStagingDirectory(), ...OWNER_TEMPORARY_STAGING.map((name) => join(tmpdir(), name))];
}

/**
 * Where third-party plugins approved `process` run: a
 * confined Node worker each, in the owner's limits, reading its own version
 * folder and home and nothing else of `ownerDenyRead` (`$HOME`, the data
 * directory and the folders given for chats), reaching
 * only its manifest's domains, its credentials masked toward their exact
 * hosts with the data directory's proxy CA.
 */
export function createOwnerPluginIsolation(
  options: OwnerReadRoots & { readonly limits?: ResourceLimitPort; readonly nested?: boolean; readonly confinement?: ConfinementPort },
): PluginIsolationPort {
  return createPluginIsolation({
    confinement:
      options.confinement ??
      createSrtConfinement({ alwaysDenyRead: ownerStagingDenies(), caDirectory: join(options.dataDirectory, "sandbox-ca") }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    denyRead: ownerDenyRead(options),
    ...(options.nested === true ? { nested: true } : {}),
    policyDirectory: join(options.dataDirectory, "plugins", ".worker-policies"),
  });
}

/**
 * The engine's own shared write paths, which every `sandbox.run` policy
 * closes (the engine closes them again; the shell's policy lists them so the
 * person's home is covered as the policy spells it).
 */
export function sandboxSharedWritePaths(home: string): readonly string[] {
  return runtimeSharedWritePaths(home);
}

/**
 * Resource limits: every sandbox in a cgroup of its own under the
 * service's delegated subtree, else a `systemd-run --user` scope, else none.
 * At an owner's start, what a killed predecessor left in `sbx/` is swept.
 */
export function createOwnerLimits(options: Pick<LimitsOptions, "defaults"> & { readonly sweep?: boolean } = {}): ResourceLimitPort {
  if (options.sweep === true && process.platform === "linux") sweepStaleGroups();
  const limits = createResourceLimits(options.defaults === undefined ? {} : { defaults: options.defaults });
  // serve sets its cgroup up before it starts any child: a group holding processes cannot hand controllers on.
  if (options.sweep === true) limits.capabilities();
  return limits;
}

/**
 * Host detection: facts, the cause table and one live probe of the compiled
 * `sandbox.run` policy (`@tavi/plugin-sandbox/host`). `current()` is
 * `checking` until the first `check()` settles, and a failure older than ten
 * minutes is probed again in the background.
 */
export function createOwnerSandboxHost(
  paths: { readonly dataDirectory: string; readonly home?: string },
  options: Omit<SandboxHostOptions, "dataDirectory" | "home"> = {},
): SandboxHostPort {
  return createSandboxHost({ ...paths, ...options });
}
