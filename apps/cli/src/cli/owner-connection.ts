import { realpathSync } from "node:fs";

import { isPipeEndpoint } from "@tavi/node-kit";

import { IPC_RETRYABLE_CONNECT_CODES, TaviError, isProtocolMismatch } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { IpcClient } from "@tavi/runtime/owner-attach";
import type { CliIo } from "./io.js";
import type { EXIT } from "./exit.js";
import { findLiveOwner } from "./live-owner.js";

/**
 * `tavi run` under a live owner, and `tavi run --attach <task-id>`.
 *
 * The owner holds the data directory, so the run is dispatched to it and its
 * stream followed here: the same NDJSON or text the foreground renders — one
 * producer, the owner's admission decorator — with the exit code derived from
 * the event the stream ends on. A subscription replays the task's stream from
 * its beginning, across every admission, so the outcome is read off the last
 * replayed event or a live one — never off a suspension an earlier admission
 * ended with. Ctrl-C detaches rather than aborting: the run belongs to the owner
 * and continues, and the operator is told how to follow it again, stop the turn,
 * or cancel the task.
 *
 * An approval round the owner leaves to the client (`--approval ask`) is asked
 * here, on a terminal, and answered with `approve`; without one it is reported
 * with exit 3, as the foreground reports it. A round the owner answers itself —
 * a `run` under `approve`/`deny`, or a schedule's fire — is only rendered.
 */

export type ExitCodes = typeof EXIT;

/**
 * A connected client to the live owner on `dataDirectory`, or `undefined` when
 * none is running — the one case where opening the directory directly is
 * legitimate.
 *
 * An owner that is present but cannot be used — an unreadable cookie, an owner
 * that does not answer, another protocol, or one that does not implement every
 * command in `commands` — is a typed `UNAVAILABLE`, never a fallback to its
 * database: the owner holds the directory, so the only safe outcomes are
 * attaching or refusing.
 */
export async function connectLiveOwner(dataDirectory: string, commands: readonly string[]): Promise<IpcClient | undefined> {
  const attach = await import("@tavi/runtime/owner-attach");
  // Connect first, probe on failure. A handshake that succeeds on this data
  // directory's own socket, with its current cookie and session, can only have
  // been answered by its live owner, so the ownership probe (a worker start,
  // the bulk of an attached command's cost) is spent only when it fails.
  const published = publishedOwner(attach, dataDirectory);
  let fastFailure: unknown;
  if (published !== undefined) {
    let attached: IpcClient | undefined;
    try {
      attached = await attach.createIpcClient({ ...published, maxAttempts: 1 });
    } catch (error) {
      fastFailure = error;
    }
    if (attached !== undefined) return requireCommands(attached, commands);
  }

  let owner: Awaited<ReturnType<typeof findLiveOwner>>;
  try {
    owner = await findLiveOwner(dataDirectory);
  } catch (error) {
    // An unreadable or unsafe cookie is a designed refusal, not a crash.
    throw new TaviError("UNAVAILABLE", `Cannot attach to the owner on ${dataDirectory}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (owner === undefined) return undefined;

  let client: IpcClient;
  try {
    // A failure another attempt cannot fix, against the very record the probe
    // just confirmed, is reported as it is rather than met a second time: a
    // refused cookie would be presented again, and a hung owner waited out twice.
    if (fastFailure !== undefined && sameRecord(owner, published) && !retryableConnectError(fastFailure)) throw fastFailure;
    // `owner.protocolVersion` is passed rather than dropped: the
    // pre-connect comparison is what turns a version mismatch into the
    // documented remedy, instead of the handshake's deliberately
    // uninformative "closed before authentication".
    client = await attach.createIpcClient(owner);
  } catch (error) {
    // A version mismatch is the owner answering correctly with the wrong
    // version: its message *is* the remedy, so it is reported unwrapped.
    if (isProtocolMismatch(error)) throw error;
    throw new TaviError(
      "UNAVAILABLE",
      `An owner is running on ${dataDirectory} but did not answer at ${owner.endpoint} ` +
        `(${errorMessage(error)}). Refusing to open its ` +
        "database directly: a foreground command must attach to the owner or fail clearly. " +
        "Check whether the owner is healthy, or stop it and retry.",
      { details: { dataDirectory, endpoint: owner.endpoint } },
    );
  }
  return requireCommands(client, commands);
}

type OwnerRecord = NonNullable<Awaited<ReturnType<typeof findLiveOwner>>>;

/**
 * The owner the discovery files name, when they are worth connecting to before
 * the ownership probe: `undefined` sends the caller straight to the probe.
 *
 * Only a record whose endpoint is this directory's own socket qualifies. That
 * socket sits in the private `runtime/` directory, where only an owner holding
 * the directory binds; a record naming any other endpoint (a copied directory
 * still pointing at its original's live owner, say) must not be trusted on a
 * successful handshake alone. On Windows the endpoint is a named pipe with a
 * fresh name each run, not a file in that directory, so nothing ties it to
 * this directory: there every attach goes to the probe. A missing or unsafe
 * cookie also goes to the probe, which is what tidies or reports it.
 */
function publishedOwner(attach: typeof import("@tavi/runtime/owner-attach"), dataDirectory: string): OwnerRecord | undefined {
  const { ipcPaths, readDiscovery, readToken } = attach;
  try {
    const discovery = readDiscovery(dataDirectory);
    // Real paths, so a data directory reached through a symlink still qualifies;
    // a socket that is not there throws, which is the probe's case too.
    if (discovery === undefined || isPipeEndpoint(discovery.endpoint)) return undefined;
    if (realpathSync(discovery.endpoint) !== realpathSync(ipcPaths(dataDirectory).socketPath)) return undefined;
    const token = readToken(dataDirectory);
    if (token === undefined) return undefined;
    return { sessionId: discovery.sessionId, endpoint: discovery.endpoint, token, protocolVersion: discovery.protocolVersion };
  } catch {
    return undefined;
  }
}

function sameRecord(owner: OwnerRecord, published: OwnerRecord | undefined): boolean {
  return (
    published !== undefined &&
    owner.endpoint === published.endpoint &&
    owner.sessionId === published.sessionId &&
    owner.token === published.token &&
    owner.protocolVersion === published.protocolVersion
  );
}

function retryableConnectError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && IPC_RETRYABLE_CONNECT_CODES.includes(code);
}

function requireCommands(client: IpcClient, commands: readonly string[]): IpcClient {
  // Never send a command the owner did not advertise: a narrower
  // owner would otherwise answer `UNSUPPORTED` midway — for an attached run,
  // only after the operator has answered a prompt.
  const missing = commands.filter((command) => !client.features.includes(command));
  if (missing.length > 0) {
    client.close();
    throw new TaviError(
      "UNAVAILABLE",
      `The running owner does not implement ${missing.map((command) => `\`${command}\``).join(", ")} ` +
        `(it advertises: ${client.features.join(", ") || "nothing"}). ` +
        "Restart the service with a build that supports it, or run the command with no owner running.",
    );
  }
  return client;
}

/**
 * `connectLiveOwner`, with an unusable owner reported: a connected client,
 * `undefined` when no owner runs, or the exit code of the reported refusal.
 */
export async function connectOwnerOrReport(
  dataDirectory: string,
  commands: readonly string[],
  io: CliIo,
  exit: ExitCodes,
): Promise<IpcClient | number | undefined> {
  try {
    return await connectLiveOwner(dataDirectory, commands);
  } catch (error) {
    if (error instanceof TaviError && error.code === "UNAVAILABLE") {
      io.stderr(`${error.message}\n`);
      return exit.unavailable;
    }
    throw error;
  }
}
