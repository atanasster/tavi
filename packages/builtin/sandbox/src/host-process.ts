import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { Socket } from "node:net";
import { createInterface } from "node:readline";

import { LinuxSandboxProfileError, SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { errorMessage } from "@tavi/contracts/util";
import { sleep } from "@tavi/node-kit";

import { shellQuote } from "./paths.js";
import {
  decideRequest,
  dialedHost,
  granted,
  hostProcessConfig,
  neverDialed,
  privateRefused,
  resolvesInward,
  type ArmedCredential,
  type HostProcessEvent,
  type HostProcessRequest,
} from "./egress.js";

/**
 * The Tavi srt host process: one
 * Node child per network run, so each run has its own srt proxy and its own
 * allowlist — srt's is process-global. The owner starts it with the
 * compiled policy on fd 3, `TMPDIR` under the service's runtime directory (so
 * srt's bridge sockets live outside the denied temporary directory)
 * and `cwd` at the run's primary writable root (srt's own mandatory-deny scan
 * covers it).
 *
 * Every connection the sandboxed command asks for is decided here, by the
 * run's grants, through srt's ask callback (srt's allowlist is left empty and
 * not strict), so each one, allowed or denied, is reported to the owner on fd
 * 3 for the audit. srt still checks its deny list first, and the resolved-
 * address guard still applies to what is dialed.
 *
 * The command's own stdio is this process's; the last fd 3 line is its exit.
 * `reset()` runs before this process exits.
 */

// fd 3 is one duplex channel (Node's extra stdio pipes are socketpairs): the request in, events out.
// A confined long-lived child (`--request <file>`, `ConfinementPort`) has none: its request is a file, and nobody reads events.
const requestFile = process.argv[2] === "--request" ? process.argv[3] : undefined;
const control = requestFile === undefined ? new Socket({ fd: 3, readable: true, writable: true }) : undefined;
const send = (event: HostProcessEvent): void => {
  control?.write(`${JSON.stringify(event)}\n`);
};
/** Ends the channel, if there is one, then this process. */
const exit = (code: number): void => {
  if (control === undefined) process.exit(code);
  else control.end(() => process.exit(code));
};

async function readRequest(): Promise<HostProcessRequest> {
  if (requestFile !== undefined) {
    // What follows the file is the child's own arguments, added by whoever started this (Playwright's flags).
    const request = JSON.parse(readFileSync(requestFile, "utf8")) as HostProcessRequest;
    const extra = process.argv.slice(4).map(shellQuote);
    return extra.length === 0 ? request : { ...request, line: `${request.line} ${extra.join(" ")}` };
  }
  const lines = createInterface({ input: control as Socket });
  const first = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    lines.once("close", () => reject(new Error("no request on fd 3")));
  });
  lines.close();
  return JSON.parse(first) as HostProcessRequest;
}

async function main(): Promise<void> {
  const request = await readRequest();
  started = true;
  const config = configOf(request);
  await SandboxManager.initialize(
    config,
    async ({ host, port }) => {
      // srt hands the host as the client spelled it but dials its canonical form (`127.1` is 127.0.0.1): both checks are on that.
      const dialed = dialedHost(host) ?? host;
      // A request with no port matches only a grant without one.
      const allowed =
        port !== undefined &&
        !neverDialed(host) &&
        !(request.privateAddresses !== undefined && privateRefused(host, port, request.privateAddresses.except)) &&
        granted(request.grants, dialed, port) &&
        // Through a parent proxy srt never sees the address a name resolves to: it is checked here instead.
        (request.parentProxy === undefined || !(await resolvesInward(dialed, port, request.privateAddresses?.except ?? [])));
      send({ type: "request", host: dialed, port: port ?? 0, allowed });
      return allowed;
    },
    // macOS: Seatbelt's refusals are read from the system log, so a networked run reports its file refusals too.
    process.platform === "darwin",
  );
  armCredentials(request);
  // srt masks a variable from this process's own environment when it wraps the command, so the real values are put
  // there now: after `initialize`, so the helpers it started (socat's bridges) never inherit them.
  for (const [name, value] of Object.entries(request.credentials?.secrets ?? {})) process.env[name] = value;
  const commandId = `host-${String(process.pid)}`;
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(request.line, undefined, undefined, undefined, request.cwd, { commandId });
  if (stopping) throw new Error("stopped before the command started");
  // The wrapper's environment is this process's, which holds the credentials' real values: never passed on.
  const wrapperEnv = Object.fromEntries(Object.entries(env).filter(([name]) => request.credentials?.secrets[name] === undefined));
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: request.cwd,
    env: request.inheritEnv ? { ...wrapperEnv, ...request.env } : { ...request.env },
    stdio: request.marker === true ? ["inherit", "inherit", "inherit", "ignore", 4] : "inherit",
  });
  running = child;
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("error", (error) => {
      send({ type: "error", message: error.message });
      resolve([127, null]);
    });
    child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  // The system log hands a refusal made just before the command exited a little after it: waited for, on macOS.
  if (process.platform === "darwin") await sleep(50);
  for (const violation of SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId))
    send({ type: "violation", line: violation.line });
  SandboxManager.cleanupAfterCommand();
  send({ type: "exit", code, signal });
  await SandboxManager.reset();
  exit(code ?? 1);
}

// srt 0.0.79 cancels the copy of a request body its filter did not read, and Node then throws from the cancelled
// stream when the client's next bytes arrive ("Controller is already closed"): that request is already refused or
// forwarded, so the run goes on. Anything else uncaught still ends the run, reported.
process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
  if (error.code === "ERR_INVALID_STATE" && /Controller is already closed/.test(error.message)) return;
  process.stderr.write(`tavi srt host: ${error.message}\n`);
  send({ type: "error", message: error.message });
  exit(70);
});

// A SIGTERM (the owner's cancellation ladder signals the group; a launcher closing a confined child signals this process
// alone) is passed to the command, and this process still reports its exit and runs `cleanupAfterCommand()` and `reset()`
// (bubblewrap's placeholders, srt's proxies) before it exits. srt's own handler only resets, so a command signalled through
// this process alone ran on. Before the command starts, `main` stops at its next step and its `catch` resets; before srt
// starts there is nothing to clean.
let started = false;
let stopping = false;
let running: ChildProcess | undefined;
process.on("SIGTERM", () => {
  stopping = true;
  if (!started) exit(143);
  running?.kill("SIGTERM");
});

let armed: readonly ArmedCredential[] = [];

/** The run's srt config (`hostProcessConfig`), its requests to credential hosts judged by `decideRequest`. */
function configOf(request: HostProcessRequest): SandboxRuntimeConfig {
  return hostProcessConfig(request, async (incoming: Request) => {
    const decision = await decideRequest(incoming, armed);
    if (decision.injected.length > 0) {
      const url = new URL(incoming.url);
      send({
        type: "inject",
        host: url.hostname,
        port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
        credentials: decision.injected,
      });
    }
    return decision.reason === undefined ? { action: decision.action } : { action: decision.action, reason: decision.reason };
  });
}

/** Each credential with the placeholder srt gives the command (`register` is idempotent on the name). */
function armCredentials(request: HostProcessRequest): void {
  const credentials = request.credentials;
  if (credentials === undefined) return;
  const registry = SandboxManager.getSentinelRegistry();
  armed = credentials.entries.map((credential) => ({
    ...credential,
    sentinel: registry.register(credential.env, credentials.secrets[credential.env] ?? "", credential.hosts),
  }));
}

// A run that never started still answers and exits: the owner would otherwise wait out the run's timeout.
main().catch(async (error: unknown) => {
  const message = errorMessage(error);
  process.stderr.write(`tavi srt host: ${message}\n`);
  send({ type: "error", message, ...(error instanceof LinuxSandboxProfileError ? { profileError: error.code } : {}) });
  // Best effort: the process exits next; its sandbox state goes with it.
  await SandboxManager.reset().catch(() => undefined);
  exit(70);
});
