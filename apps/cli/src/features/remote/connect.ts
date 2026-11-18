import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";

import { IPC_PROTOCOL_VERSION, IpcDiscoverySchema, type IpcDiscovery } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { REMOTE_MIRROR_FILE, type RemoteMirror, makePrivateDirectory, readRemoteMirrorFile, sleep, writeJsonAtomic } from "@tavi/node-kit";

import type { RemoteCommandOptions } from "./parse.js";

/**
 * `tavi remote connect`: the clients on this computer, attached to an owner
 * on another one.
 *
 * Clients attach to an owner by its data directory: the discovery record
 * (`runtime/ipc.json`) names a Unix socket that must be the directory's own
 * `runtime/ipc.sock`, and the token (`runtime/ipc.token`) authenticates them.
 * This builds a *mirror* directory here holding exactly that: the remote
 * owner's discovery with its endpoint rewritten to a local socket, which SSH
 * forwards to the owner's socket there, and a copy of its token. Nothing else
 * changes for a client. `remote.json` marks the directory, so the runtime
 * never owns it and a client never falls back to it.
 *
 * The remote socket is reached through a symbolic link in a private temporary
 * directory there, because OpenSSH reads spaces and colons in a forwarded
 * path as separators (`~/Library/Application Support/…`). The owner's
 * discovery is read again every `POLL_MS`: a restarted owner publishes a new
 * session and token, which are copied here; a stopped one is withdrawn here
 * too, so a client says it cannot reach it rather than trying a dead token.
 */

/** How often the remote owner's discovery is read again. */
const POLL_MS = 2_000;
/** How long to wait before signing in again after the connection drops. */
const RECONNECT_MS = 5_000;
/** How long `ssh` may take to sign in, a typed password included. */
const SIGN_IN_TIMEOUT_MS = 120_000;
/** The longest Unix socket path macOS binds (`sun_path` is 104 bytes, with its NUL). */
const SOCKET_PATH_MAX = 103;
/** What `ssh -M` appends to its control path while it binds it (`.` and 16 random characters). */
const CONTROL_PATH_SUFFIX = 17;
/** Where the remote owner's discovery and token begin in what the poll reads. */
const SEPARATOR = "--tavi-remote-token--";

export interface RemoteIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** A command run on the remote computer: its exit code and what it printed. */
export interface RemoteResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One signed-in connection to the remote computer. */
export interface RemoteConnection {
  /** Run `script` in the remote user's shell. */
  run(script: string): Promise<RemoteResult>;
  /** Forward `localSocket` here to `remoteSocket` there, for as long as the connection lasts. */
  forward(localSocket: string, remoteSocket: string): Promise<void>;
  /** Settles, with why, when the connection ends. */
  readonly ended: Promise<string>;
  close(): Promise<void>;
}

/** Signs in to `target`. The default is OpenSSH; a test passes one of its own. */
export type RemoteConnector = (target: string, controlPath: string, sshOptions: readonly string[]) => Promise<RemoteConnection>;

export interface RemoteConnectDeps {
  readonly connector?: RemoteConnector;
  /** Resolves when the person asks to stop (Ctrl-C). */
  readonly stopped: Promise<void>;
  readonly home?: string;
  readonly pollMs?: number;
  readonly reconnectMs?: number;
}

/** The mirror's files. */
export interface MirrorPaths {
  readonly directory: string;
  readonly runtime: string;
  readonly discovery: string;
  readonly token: string;
  readonly socket: string;
  readonly control: string;
  readonly pid: string;
  readonly marker: string;
}

export function mirrorPaths(directory: string): MirrorPaths {
  const runtime = join(directory, "runtime");
  return {
    directory,
    runtime,
    discovery: join(runtime, "ipc.json"),
    token: join(runtime, "ipc.token"),
    socket: join(runtime, "ipc.sock"),
    // Short: ssh binds it with 17 more characters, under the 104-byte limit of a socket path.
    control: join(runtime, "ssh"),
    pid: join(runtime, "connect.pid"),
    marker: join(directory, REMOTE_MIRROR_FILE),
  };
}

/** The default mirror for `target`: `~/.tavi-remote/<host>`, short and free of spaces, as a forwarded socket's path must be. */
export function defaultMirrorDirectory(target: string, home: string = homedir()): string {
  const host = target
    .slice(target.lastIndexOf("@") + 1)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 48);
  return join(home, ".tavi-remote", host === "" ? "remote" : host);
}

/** A string as one word of a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The owner's data directory on the remote computer, from what its shell
 * says: `--remote-data-dir` (`~` its user's home), else Tavi's default there.
 */
export function remoteDataDirectoryOf(
  probe: { readonly home: string; readonly system: string; readonly xdgDataHome: string },
  named?: string,
): string {
  if (named !== undefined) {
    if (named === "~") return probe.home;
    if (named.startsWith("~/")) return posix.join(probe.home, named.slice(2));
    if (!posix.isAbsolute(named)) throw new Error(`--remote-data-dir must be absolute or start with ~/; got ${named}`);
    return posix.normalize(named);
  }
  if (posix.isAbsolute(probe.xdgDataHome)) return posix.join(probe.xdgDataHome, "tavi");
  if (probe.system === "Darwin") return posix.join(probe.home, "Library", "Application Support", "tavi");
  return posix.join(probe.home, ".local", "share", "tavi");
}

/** Why `directory` cannot be the mirror for `target`, or undefined when it can. */
export function mirrorRefusal(directory: string, target: string): string | undefined {
  if (/[\s:]/.test(directory))
    return `${directory} has a space or a colon in its path, which ssh cannot forward a socket to; pick another --data-dir`;
  const paths = mirrorPaths(directory);
  const longest = Math.max(Buffer.byteLength(paths.socket), Buffer.byteLength(paths.control) + CONTROL_PATH_SUFFIX);
  if (longest > SOCKET_PATH_MAX)
    return `${directory} is too long a path for a socket (${longest} bytes; at most ${SOCKET_PATH_MAX}); pick a shorter --data-dir`;
  if (!existsSync(directory)) return undefined;
  let mirror: RemoteMirror | undefined;
  try {
    mirror = readRemoteMirrorFile(directory);
  } catch (error) {
    return errorMessage(error);
  }
  if (mirror !== undefined) {
    return mirror.target === target ? undefined : `${directory} mirrors ${mirror.target}, not ${target}; pick another --data-dir`;
  }
  const entries = readdirSync(directory).filter((entry) => entry !== "runtime");
  return entries.length === 0
    ? undefined
    : `${directory} is not empty and not a remote mirror (it may be a data directory of its own); pick another --data-dir`;
}

/** The pid of a `tavi remote connect` already keeping this mirror, if one is alive. */
function liveConnector(paths: MirrorPaths): number | undefined {
  if (!existsSync(paths.pid)) return undefined;
  const pid = Number(readFileSync(paths.pid, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

/** Withdraw the owner from the mirror: clients then report it unreachable. */
function withdraw(paths: MirrorPaths): void {
  rmSync(paths.discovery, { force: true });
  rmSync(paths.token, { force: true });
}

/** What the remote owner publishes: its discovery and token, or undefined when none is running. */
export function parsePublished(stdout: string): { readonly discovery: IpcDiscovery; readonly token: string } | undefined {
  const at = stdout.indexOf(`\n${SEPARATOR}\n`);
  if (at < 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(stdout.slice(0, at));
  } catch {
    return undefined;
  }
  const discovery = IpcDiscoverySchema.safeParse(json);
  const token = stdout.slice(at + SEPARATOR.length + 2).trim();
  if (!discovery.success || token === "" || /\s/.test(token)) return undefined;
  return { discovery: discovery.data, token };
}

/** Copy the remote owner's publication into the mirror, its endpoint the forwarded socket. Token first: a client reads discovery, then the token. */
function publish(paths: MirrorPaths, published: { readonly discovery: IpcDiscovery; readonly token: string }): void {
  writeFileSync(paths.token, published.token, { mode: 0o600 });
  chmodSync(paths.token, 0o600);
  writeJsonAtomic(paths.discovery, { ...published.discovery, endpoint: paths.socket }, { mode: 0o600 });
}

/** The shell script that prints the owner's discovery, the separator and its token; exit 3 when none is published. */
export function publishedScript(remoteDataDirectory: string): string {
  const runtime = shellQuote(posix.join(remoteDataDirectory, "runtime"));
  return `cd ${runtime} 2>/dev/null && [ -f ipc.json ] && [ -f ipc.token ] || exit 3; cat ipc.json && printf '\\n%s\\n' ${shellQuote(SEPARATOR)} && cat ipc.token`;
}

/** `tavi remote connect`: keep the mirror connected until stopped. */
export async function remoteConnect(
  options: RemoteCommandOptions,
  io: RemoteIo,
  exit: { readonly ok: number; readonly usage: number; readonly unavailable: number },
  deps: RemoteConnectDeps,
): Promise<number> {
  const directory = resolve(options.mirrorDirectory ?? defaultMirrorDirectory(options.target, deps.home));
  const refusal = mirrorRefusal(directory, options.target);
  if (refusal !== undefined) {
    io.stderr(`tavi remote connect: ${refusal}\n`);
    return exit.usage;
  }
  const paths = mirrorPaths(directory);
  makePrivateDirectory(directory);
  makePrivateDirectory(paths.runtime);
  const running = liveConnector(paths);
  if (running !== undefined) {
    io.stderr(`tavi remote connect: another \`tavi remote connect\` (pid ${running}) already keeps ${directory}\n`);
    return exit.unavailable;
  }
  writeFileSync(paths.pid, String(process.pid), { mode: 0o600 });
  const connector = deps.connector ?? openSshConnector;
  const pollMs = deps.pollMs ?? POLL_MS;
  let stopping = false;
  void deps.stopped.then(() => {
    stopping = true;
  });
  let firstConnection = true;
  try {
    while (!stopping) {
      withdraw(paths);
      let connection: RemoteConnection;
      try {
        connection = await Promise.race([
          connector(options.target, paths.control, options.sshOptions),
          deps.stopped.then(() => {
            throw new Error("stopped");
          }),
        ]);
      } catch (error) {
        if (stopping) break;
        io.stderr(`tavi remote connect: cannot sign in to ${options.target}: ${errorMessage(error)}\n`);
        if (firstConnection) return exit.unavailable;
        await Promise.race([sleep(deps.reconnectMs ?? RECONNECT_MS), deps.stopped]);
        continue;
      }
      try {
        let outcome: "ended" | "refused";
        try {
          outcome = await keepConnected(connection, options, paths, io, deps, pollMs, firstConnection);
        } catch (error) {
          io.stderr(`tavi remote connect: ${errorMessage(error)}\n`);
          outcome = firstConnection ? "refused" : "ended";
        }
        if (outcome === "refused") return exit.unavailable;
      } finally {
        withdraw(paths);
        await connection.close().catch(() => undefined);
      }
      firstConnection = false;
      if (stopping) break;
      io.stderr(
        `tavi remote connect: the connection to ${options.target} ended; signing in again in ${(deps.reconnectMs ?? RECONNECT_MS) / 1000} s\n`,
      );
      await Promise.race([sleep(deps.reconnectMs ?? RECONNECT_MS), deps.stopped]);
    }
    io.stdout(`Disconnected from ${options.target}.\n`);
    return exit.ok;
  } finally {
    withdraw(paths);
    rmSync(paths.socket, { force: true });
    rmSync(paths.pid, { force: true });
  }
}

/** One connection's life: set up the forward, then follow the owner's publication until the connection ends or the person stops. */
async function keepConnected(
  connection: RemoteConnection,
  options: RemoteCommandOptions,
  paths: MirrorPaths,
  io: RemoteIo,
  deps: RemoteConnectDeps,
  pollMs: number,
  first: boolean,
): Promise<"ended" | "refused"> {
  const probe = await connection.run(`printf '%s\\n' "$HOME" "$(uname -s 2>/dev/null)" "\${XDG_DATA_HOME:-}"`);
  const [home = "", system = "", xdgDataHome = ""] = probe.stdout.split("\n");
  if (probe.code !== 0 || !posix.isAbsolute(home)) {
    io.stderr(`tavi remote connect: ${options.target} did not answer as a POSIX shell (${probe.stderr.trim() || `exit ${probe.code}`})\n`);
    return "refused";
  }
  if (!["Darwin", "Linux"].includes(system) && !system.endsWith("BSD")) {
    io.stderr(
      `tavi remote connect: ${options.target} runs ${system || "an unknown system"}; only an owner on macOS or Linux can be reached\n`,
    );
    return "refused";
  }
  let remoteDataDirectory: string;
  try {
    remoteDataDirectory = remoteDataDirectoryOf({ home, system, xdgDataHome }, options.remoteDataDirectory);
  } catch (error) {
    io.stderr(`tavi remote connect: ${errorMessage(error)}\n`);
    return "refused";
  }
  const marker: RemoteMirror = { version: 1, target: options.target, remoteDataDirectory, remoteHome: home };
  writeJsonAtomic(paths.marker, marker, { mode: 0o600, indent: 2, trailingNewline: true });

  // A private directory there, with a link to the owner's socket under a path ssh can forward.
  const remoteSocket = posix.join(remoteDataDirectory, "runtime", "ipc.sock");
  const linked = await connection.run(
    `umask 077; d=$(mktemp -d "\${TMPDIR:-/tmp}/tavi-remote.XXXXXXXX") || exit 1; ln -s ${shellQuote(remoteSocket)} "$d/ipc.sock" || exit 1; printf '%s' "$d"`,
  );
  const link = linked.stdout.trim();
  if (linked.code !== 0 || !posix.isAbsolute(link) || /[\s:]/.test(link)) {
    io.stderr(
      `tavi remote connect: could not make a private directory on ${options.target} (${linked.stderr.trim() || link || `exit ${linked.code}`})\n`,
    );
    return "refused";
  }
  try {
    rmSync(paths.socket, { force: true });
    await connection.forward(paths.socket, posix.join(link, "ipc.sock"));
    let session: string | undefined;
    let token: string | undefined;
    let said: "none" | "owner" | undefined;
    let connectedOnce = false;
    let ended = false;
    void connection.ended.then(() => {
      ended = true;
    });
    let stopping = false;
    void deps.stopped.then(() => {
      stopping = true;
    });
    const script = publishedScript(remoteDataDirectory);
    while (!ended && !stopping) {
      const read = await connection.run(script);
      if (ended || stopping) break;
      const published = read.code === 0 ? parsePublished(read.stdout) : undefined;
      if (published === undefined) {
        if (session !== undefined || said !== "none") {
          withdraw(paths);
          session = undefined;
          token = undefined;
          io.stdout(
            `${first && said === undefined ? `Signed in to ${options.target}. ` : ""}No owner is running in ${remoteDataDirectory} there; waiting for \`tavi serve\`…\n`,
          );
          said = "none";
        }
      } else if (published.discovery.sessionId !== session || published.token !== token) {
        publish(paths, published);
        session = published.discovery.sessionId;
        token = published.token;
        if (published.discovery.protocolVersion !== IPC_PROTOCOL_VERSION) {
          io.stderr(
            `tavi remote connect: the owner on ${options.target} speaks IPC protocol ${published.discovery.protocolVersion} and this tavi speaks ${IPC_PROTOCOL_VERSION}; ` +
              "clients here will refuse it until both run the same version\n",
          );
        }
        io.stdout(
          connectedOnce
            ? `The owner on ${options.target} is running again (session ${session}); clients here follow it.\n`
            : `Connected to the owner on ${options.target} (${remoteDataDirectory}, session ${session}).\n` +
                `Use it from this computer with --data-dir ${paths.directory}, or TAVI_DATA_DIR=${paths.directory}:\n` +
                `  tavi chat --data-dir ${paths.directory}\n` +
                `Ctrl-C disconnects.\n`,
        );
        said = "owner";
        connectedOnce = true;
      }
      await Promise.race([sleep(pollMs), connection.ended, deps.stopped]);
    }
    return "ended";
  } finally {
    await connection.run(`rm -rf ${shellQuote(link)}`).catch(() => undefined);
  }
}

/** Run `ssh` with `args`, collecting what it prints (at most 1 MiB of each stream). */
function runSsh(args: readonly string[]): Promise<RemoteResult> {
  return new Promise((resolveRun) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const cap = 1 << 20;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < cap) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < cap) stderr += chunk;
    });
    child.on("error", (error) => resolveRun({ code: 255, stdout, stderr: errorMessage(error) }));
    child.on("close", (code) => resolveRun({ code: code ?? 255, stdout, stderr }));
  });
}

/**
 * OpenSSH: one master connection (`-M`), signed in with the person's own
 * config, keys and agent (a password prompt reaches this terminal), and every
 * later command and the forward multiplexed over its control socket.
 */
const openSshConnector: RemoteConnector = async (target, controlPath, sshOptions) => {
  rmSync(controlPath, { force: true });
  const options = sshOptions.flatMap((option) => ["-o", option]);
  const master: ChildProcess = spawn(
    "ssh",
    [
      "-M",
      "-S",
      controlPath,
      "-N",
      "-o",
      "ControlPersist=no",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "StreamLocalBindUnlink=yes",
      ...options,
      "--",
      target,
    ],
    { stdio: ["inherit", "ignore", "pipe"] },
  );
  let stderr = "";
  master.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  const ended = new Promise<string>((resolveEnded) => {
    master.on("error", (error) => resolveEnded(errorMessage(error)));
    master.on("exit", (code, signal) => resolveEnded(stderr.trim() || `ssh exited (${signal ?? code})`));
  });
  let over = false;
  void ended.then(() => {
    over = true;
  });
  const control = ["-S", controlPath, ...options];
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  for (;;) {
    if (over) throw new Error(await ended);
    if (existsSync(controlPath) && (await runSsh([...control, "-O", "check", "--", target])).code === 0) break;
    if (Date.now() > deadline) {
      master.kill();
      throw new Error(`no answer within ${SIGN_IN_TIMEOUT_MS / 1000} s`);
    }
    await sleep(250);
  }
  return {
    run: (script) => runSsh([...control, "-o", "BatchMode=yes", "--", target, script]),
    forward: async (localSocket, remoteSocket) => {
      const result = await runSsh([...control, "-O", "forward", "-L", `${localSocket}:${remoteSocket}`, "--", target]);
      if (result.code !== 0) throw new Error(`ssh could not forward the owner's socket: ${result.stderr.trim() || `exit ${result.code}`}`);
    },
    ended,
    close: async () => {
      if (!over) await runSsh([...control, "-O", "exit", "--", target]);
      master.kill();
      rmSync(controlPath, { force: true });
    },
  };
};
