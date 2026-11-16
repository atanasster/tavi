import { randomBytes } from "node:crypto";

import { Win32Error, namedSecurity, currentUserSid, setNamedAccessList } from "./win32.js";
import { ownerOnlySddl, parseSddl, privateAccessProblem, trustedOwner } from "./security-descriptor.js";

/**
 * The owner's endpoint: a Unix socket file on macOS and Linux, a named pipe
 * on Windows. A pipe has no file to hold a mode, so its access list is set
 * after the bind and checked before a client sends its cookie.
 */

/** Whether `endpoint` names a Windows named pipe (`\\.\pipe\…`) rather than a socket file. */
export function isPipeEndpoint(endpoint: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(endpoint);
}

/** A fresh pipe name for one owner's run: random, so no other process can bind it first by guessing. */
export function newPipeEndpoint(): string {
  return `\\\\.\\pipe\\tavi-${randomBytes(16).toString("hex")}`;
}

/**
 * An endpoint refused as unsafe: its access list could not be set or
 * confirmed, or another account owns it. `code` is set when the pipe was
 * only not there (`ENOENT`) or had no free instance (`EBUSY`), as a connect
 * would have said, so a client waits for a restarting owner as it would for a socket.
 */
export class EndpointRefusedError extends Error {
  readonly code?: string;

  constructor(message: string, options?: ErrorOptions & { readonly code?: string }) {
    super(message, options);
    this.name = "EndpointRefusedError";
    if (options?.code !== undefined) this.code = options.code;
  }
}

/** Windows's "no such pipe" and "all pipe instances are busy", as the codes a connect gives for them. */
const PIPE_NOT_READY: Readonly<Record<number, string>> = { 2: "ENOENT", 231: "EBUSY" };

/**
 * Give the pipe Node has just bound at `endpoint` the owner's private access
 * list (the owner, SYSTEM and Administrators; network logons denied), then
 * read it back: throws unless what Windows holds is that list. Until this
 * returns, the server must take no connection (`createIpcServer`'s `admitting`).
 */
export function protectPipe(endpoint: string): void {
  try {
    const self = currentUserSid();
    setNamedAccessList(endpoint, ownerOnlySddl(self));
    const problem = privateAccessProblem(parseSddl(namedSecurity(endpoint)), self, { denyNetwork: true });
    if (problem !== undefined) throw new EndpointRefusedError(`the owner's pipe ${endpoint} is not private: ${problem}`);
  } catch (error) {
    if (error instanceof EndpointRefusedError) throw error;
    throw new EndpointRefusedError(`the owner's pipe ${endpoint} could not be made private`, { cause: error });
  }
}

/**
 * Before a client sends its cookie: the pipe at `endpoint` must be owned by
 * this account (or SYSTEM or Administrators), so a pipe another user bound
 * under the published name is never handed the token. Nothing to check for a
 * socket file, whose private directory already says who bound it. Reading the
 * pipe's owner opens it as a client would (Experiment 2 is to confirm), so the
 * owner sees one more short connection, which it closes unauthenticated.
 */
export function assertPipeOwnedHere(endpoint: string): void {
  if (process.platform !== "win32" || !isPipeEndpoint(endpoint)) return;
  let owner: string | undefined;
  let self: string;
  try {
    self = currentUserSid();
    owner = parseSddl(namedSecurity(endpoint)).owner;
  } catch (error) {
    const code = error instanceof Win32Error ? PIPE_NOT_READY[error.winCode] : undefined;
    throw new EndpointRefusedError(`the owner's pipe ${endpoint} could not be checked`, {
      cause: error,
      ...(code === undefined ? {} : { code }),
    });
  }
  if (!trustedOwner(owner, self)) throw new EndpointRefusedError(`the pipe ${endpoint} belongs to another account (${owner ?? "none"})`);
}
