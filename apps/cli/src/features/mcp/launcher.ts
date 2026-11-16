import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  TaviError,
  mcpInterpreterPrefix,
  mcpPackageDirectory,
  type ConfinementPolicy,
  type ConfinementPort,
  type ResourceLimitPort,
  type McpBlock,
  type McpSandboxState,
  type PluginManifest,
} from "@tavi/contracts";
import { sha256Hex, systemChildEnv } from "@tavi/node-kit";

import type { TaviStdioOptions } from "./stdio-transport.js";

/**
 * How a stdio MCP server is started: each sandboxed server under **its own**
 * `srt` CLI process (the owner's `ConfinementPort`), with its own policy
 * file (`<data>/mcp/<id>/srt.json`) and so its own proxy — never the owner's sandbox manager or its `NetworkGate`. The
 * environment is built from scratch; the server's home is its own.
 *
 * A server reaches only its manifest's `network.domains`, through its own
 * srt proxy; one with none reaches nothing. A Node server finds the proxy
 * through `NODE_USE_ENV_PROXY`, which Node honours from 22.21, so a granted
 * network refuses to start on an older Node.
 */

/** Reads under `$HOME` a server may need: the runtime in use, never anything else of the person's. */
const RUNTIME_DIRECTORIES = [".nvm", ".fnm", ".volta", ".asdf", ".local/share/uv", ".local/share/fnm", ".cache/uv"] as const;

export interface LaunchPaths {
  readonly dataDirectory: string;
  /** The person's home; the process's own by default. */
  readonly home?: string;
  /** What a sandboxed server is wrapped in (`features/sandbox/host.ts` builds it). */
  readonly confinement: ConfinementPort;
  /** Each server in a cgroup of its own, sandboxed or not; none when absent. */
  readonly limits?: ResourceLimitPort;
  /** What the confinement denies every child besides home and the data directory (`ownerDenyRead`): never reopened through an interpreter's prefix. */
  readonly ownerDenyRead?: readonly string[];
}

/**
 * A server's placement: each process the transport starts (a retry or a
 * reconnect starts another) in a cgroup of its own, outermost, released (and
 * any escapee killed) when that process exits; an OOM kill is reported as
 * one, not as a bare crash.
 */
function placement(paths: LaunchPaths): Pick<TaviStdioOptions, "place"> {
  const limits = paths.limits;
  if (limits === undefined) return {};
  return {
    place: (argv) => {
      const placed = limits.place(argv, "server");
      const groupId = placed.groupId;
      if (groupId === undefined) return { argv: placed.argv };
      return {
        argv: placed.argv,
        onExit: () => {
          const outcome = limits.outcome(groupId);
          limits.release(groupId);
          return outcome === "oom" ? "it ran out of memory: its cgroup's memory cap ended it" : undefined;
        },
      };
    },
  };
}

/** `<data>/mcp/<id>`: the server's own directory (its home, its srt settings, its run record). */
function serverDirectory(dataDirectory: string, pluginId: string): string {
  return join(dataDirectory, "mcp", pluginId);
}

function serverHome(dataDirectory: string, pluginId: string): string {
  return join(serverDirectory(dataDirectory, pluginId), "home");
}

/** The server's argv with `node` as Tavi's own interpreter and paths resolved inside the plugin directory. */
export function resolveArgv(manifest: PluginManifest, pluginDirectory: string): readonly string[] {
  const block = manifest.mcp as McpBlock;
  const argv = block.command ?? [];
  const packageDirectory = mcpPackageDirectory(manifest);
  const inside = (path: string): string => {
    const resolved = resolve(pluginDirectory, path);
    if (resolved !== pluginDirectory && !resolved.startsWith(`${pluginDirectory}${sep}`))
      throw new TaviError("INVALID_INPUT", `${path} is outside the plugin directory`);
    return resolved;
  };
  const expand = (arg: string): string =>
    arg.startsWith("${package}/") ? inside(join(packageDirectory ?? "", arg.slice("${package}/".length))) : arg;
  return argv.map((arg, index) => {
    if (index === 0) {
      if (block.external === true) return arg;
      if (arg === "node") return process.execPath;
      // The uv-managed interpreter pinned at install; the schema requires it with `python`.
      if (arg === "python") return block.interpreter?.path ?? arg;
      return arg.startsWith("${package}/") ? expand(arg) : inside(arg);
    }
    return expand(arg);
  });
}

/** SHA-256 of an external binary, recorded at approval and checked at each start. */
export function fileSha256(path: string): string {
  return sha256Hex(readFileSync(path));
}

/** Whether this Node honours `NODE_USE_ENV_PROXY` (22.21 and later). */
export function nodeHonoursEnvProxy(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 21);
}

/**
 * The environment a server gets: built from scratch, never the owner's. The manifest's variables may set the locale and
 * its own, never where its home, temporary files and XDG folders are: those
 * stay the server's own, whatever it names (unsandboxed, a `HOME` of the
 * person's would otherwise point it at their files).
 */
export function serverEnvironment(home: string, given: Readonly<Record<string, string>>, network = false): Record<string, string> {
  const locale = process.env["LANG"] ?? "C.UTF-8";
  return {
    LANG: locale,
    LC_ALL: process.env["LC_ALL"] ?? locale,
    // srt sets the proxy variables inside the sandbox; Node reads them only when told to.
    ...(network ? { NODE_USE_ENV_PROXY: "1" } : {}),
    ...given,
    ...systemChildEnv([dirname(process.execPath)], true),
    HOME: home,
    TMPDIR: join(home, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
}

/**
 * One server's policy: `$HOME` and Tavi's data denied but for the
 * server's own files, writes only to its home. The confinement adds Tavi's
 * own node and its helpers. A server the owner named as a video analyser
 * may also read its exchange directory,
 * `<data>/video/mcp/<id>/`, where the owner puts a call's frames: added here,
 * never to the manifest's `filesystem.read` (approved and hashed, and refused
 * inside the data directory), and never writable, so the server cannot plant
 * a link there.
 */
export function serverPolicy(options: {
  readonly pluginDirectory: string;
  readonly home: string;
  readonly dataDirectory: string;
  readonly personHome: string;
  readonly block: McpBlock;
  readonly nested: boolean;
  readonly analyzerExchange?: string;
  readonly ownerDenyRead?: readonly string[];
}): ConfinementPolicy {
  const runtimeReads = RUNTIME_DIRECTORIES.map((name) => join(options.personHome, name)).filter((path) => existsSync(path));
  // A Python server's pinned interpreter: its install, under the same rule as node's.
  const pythonPath = options.block.interpreter?.path;
  const pythonPrefix = pythonPath === undefined ? undefined : mcpInterpreterPrefix(pythonPath);
  // Never a prefix holding a denied root: reopening it would reopen that root.
  const denied = [options.personHome, options.dataDirectory, ...(options.ownerDenyRead ?? [])];
  const python =
    pythonPath === undefined || pythonPrefix === undefined
      ? []
      : [
          pythonPrefix === "/" || denied.some((root) => root === pythonPrefix || root.startsWith(`${pythonPrefix}/`))
            ? dirname(pythonPath)
            : pythonPrefix,
        ];
  return {
    domains: options.block.network?.domains ?? [],
    denyRead: [options.personHome, options.dataDirectory],
    allowRead: [
      options.pluginDirectory,
      options.home,
      ...python,
      ...runtimeReads,
      ...(options.block.filesystem?.read ?? []),
      ...(options.analyzerExchange === undefined ? [] : [options.analyzerExchange]),
    ],
    allowWrite: [options.home, ...(options.block.filesystem?.write ?? [])],
    nested: options.nested,
  };
}

export interface StdioLaunch {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  /** The installed snapshot directory. */
  readonly pluginDirectory: string;
  readonly sandboxState: McpSandboxState;
  /** The block's `env`, its settings and credentials already resolved. */
  readonly env: Readonly<Record<string, string>>;
  /** The external binary's recorded hash, checked before it starts. */
  readonly externalSha256?: string;
  /** Its video analyser exchange directory, when the owner named it in `analyzers.json`: readable by it, made here. */
  readonly analyzerExchange?: string;
}

/**
 * The spawn options for a stdio server: its home created (0700, kept across
 * versions), and its confinement in front unless the state is `none`. The process leads its own group (`TaviStdioTransport`).
 */
export function stdioLaunch(launch: StdioLaunch, paths: LaunchPaths): Omit<TaviStdioOptions, "maxMessageBytes" | "onStderr"> {
  const block = launch.manifest.mcp;
  if (block === undefined || block.transport !== "stdio")
    throw new TaviError("INVALID_INPUT", `${launch.pluginId} is not a stdio MCP server`);
  const directory = serverDirectory(paths.dataDirectory, launch.pluginId);
  const home = serverHome(paths.dataDirectory, launch.pluginId);
  for (const path of [directory, home, join(home, "tmp")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const argv = resolveArgv(launch.manifest, launch.pluginDirectory);
  if (block.external === true) {
    const program = argv[0] as string;
    if (!isAbsolute(program) || !existsSync(program)) throw new TaviError("UNAVAILABLE", `${program} is not there any more`);
    if (launch.externalSha256 !== undefined && fileSha256(program) !== launch.externalSha256)
      throw new TaviError("CONFLICT", `${program} changed since it was approved; it will not start until it is reviewed again`, {
        details: { mcpFailure: "integrity" },
      });
  }
  if (block.external !== true && block.command?.[0] === "python" && block.interpreter !== undefined) {
    const { path, sha256 } = block.interpreter;
    if (!existsSync(path))
      throw new TaviError(
        "UNAVAILABLE",
        `its Python interpreter ${path} is not there any more (uv removed or upgraded it); add the server again with --pypi`,
      );
    if (fileSha256(path) !== sha256)
      throw new TaviError(
        "CONFLICT",
        `its Python interpreter ${path} changed since it was approved; it will not start until it is added again`,
        { details: { mcpFailure: "integrity" } },
      );
  }
  const domains = block.network?.domains ?? [];
  if (domains.length > 0 && block.external !== true && block.command?.[0] === "node" && !nodeHonoursEnvProxy()) {
    throw new TaviError(
      "UNSUPPORTED",
      `${launch.pluginId} is granted ${domains.join(", ")}, which a Node server reaches through its proxy only on Node 22.21 or later; Tavi runs on Node ${process.versions.node}`,
    );
  }
  if (domains.length > 0 && launch.sandboxState === "none")
    throw new TaviError(
      "CONFLICT",
      `${launch.pluginId} is granted ${domains.join(", ")}, which only a sandbox can hold it to; it does not run unsandboxed`,
    );
  const env = serverEnvironment(home, launch.env, domains.length > 0);
  // Its own record: a stopped server's process may still be finishing calls beside its successor.
  const pidFile = join(directory, `run-${randomBytes(4).toString("hex")}.pid`);
  if (launch.sandboxState === "none") {
    return { command: argv[0] as string, args: argv.slice(1), env, cwd: home, pidFile, ...placement(paths) };
  }
  // Made before the sandbox is: srt reads only what exists. The owner's alone (0700); emptied after each call.
  if (launch.analyzerExchange !== undefined) {
    mkdirSync(launch.analyzerExchange, { recursive: true, mode: 0o700 });
    chmodSync(launch.analyzerExchange, 0o700);
  }
  const policy = serverPolicy({
    pluginDirectory: launch.pluginDirectory,
    home,
    dataDirectory: paths.dataDirectory,
    personHome: paths.home ?? homedir(),
    block,
    nested: launch.sandboxState === "nested",
    ...(paths.ownerDenyRead === undefined ? {} : { ownerDenyRead: paths.ownerDenyRead }),
    ...(launch.analyzerExchange === undefined ? {} : { analyzerExchange: launch.analyzerExchange }),
  });
  const wrapped = paths.confinement.wrap({ argv, env, policyFile: join(directory, "srt.json"), policy });
  return { command: wrapped.command, args: wrapped.args, env: { ...wrapped.env }, cwd: home, pidFile, ...placement(paths) };
}
