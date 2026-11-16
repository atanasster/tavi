import { unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { TaviError } from "@tavi/contracts";
import { NoFollowReadError, flushDirectory, processStartTime, readNoFollowSync, writeJsonAtomic } from "@tavi/node-kit";
import { machineIdentity } from "./machine-identity.js";

export const OWNER_PROCESS_FILE = "owner.process.json";
// The machine is identified by a stable machine identity; the hostname, which
// macOS changes with the network, is kept for the operator's benefit.
// Version 3 adds the process's start time: a pid alone is reused, and a record naming a reused pid
// must not hold the directory. A version-2 record, from an owner before that, is read without it.
const ownerRecordSchema = z.strictObject({
  version: z.union([z.literal(2), z.literal(3)]),
  pid: z.number().int().positive(),
  started: z.string().min(1).optional(),
  machine: z.string().min(1),
  host: z.string().min(1),
  sessionId: z.string().min(1),
});
type OwnerRecord = z.infer<typeof ownerRecordSchema>;

function isThisMachine(record: OwnerRecord): boolean {
  return record.machine === machineIdentity();
}

/**
 * Whether the live process at the record's pid is another than the one it
 * recorded: its start time is known and differs. A record without one, or a
 * process whose start cannot be read, is taken as the same process.
 */
function pidReused(record: OwnerRecord): boolean {
  if (record.started === undefined) return false;
  const started = processStartTime(record.pid);
  return started !== undefined && started !== record.started;
}

function readOwnerRecord(directory: string): OwnerRecord | undefined {
  const invalid = (error: unknown): TaviError =>
    new TaviError(
      "CONFLICT",
      `The previous owner process record is invalid; once no owner is running, remove ${join(directory, OWNER_PROCESS_FILE)} to take over`,
      { cause: error },
    );
  let bytes: Buffer | undefined;
  try {
    bytes = readNoFollowSync(join(directory, OWNER_PROCESS_FILE));
  } catch (error) {
    if (error instanceof NoFollowReadError && error.reason === "not-file") throw invalid(error);
    throw new TaviError("CONFLICT", "Cannot establish the previous owner process identity", { cause: error });
  }
  if (bytes === undefined) return undefined;
  try {
    return ownerRecordSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw invalid(error);
  }
}

/**
 * The session prefix `tavi serve` names its owner with, so a command that finds
 * the directory held before the owner publishes where it answers can tell an
 * owner that is starting (and will answer) from one that never will.
 */
export const SERVE_SESSION_PREFIX = "serve-";

/**
 * The process its record names as holding `directory`, while that process is
 * alive on this machine: a hint for a message or for waiting on a starting
 * owner, never the authority on ownership (the lock is). Undefined when there
 * is no record, it cannot be read, or its process is gone.
 */
export function liveOwnerProcess(directory: string): { readonly pid: number; readonly sessionId: string } | undefined {
  try {
    const record = readOwnerRecord(directory);
    if (record === undefined || !isThisMachine(record)) return undefined;
    process.kill(record.pid, 0);
    if (pidReused(record)) return undefined;
    return { pid: record.pid, sessionId: record.sessionId };
  } catch {
    return undefined;
  }
}

/** Called while holding the SQLite ownership lock, before changing application state. */
export function assertPreviousOwnerStopped(directory: string): void {
  const previous = readOwnerRecord(directory);
  if (previous === undefined) return;
  if (!isThisMachine(previous)) {
    throw new TaviError(
      "CONFLICT",
      `The previous owner (pid ${previous.pid} on host ${previous.host}) belongs to another machine; termination cannot be established. ` +
        `Once that process has stopped, remove ${join(directory, OWNER_PROCESS_FILE)} to take over.`,
    );
  }
  try {
    process.kill(previous.pid, 0);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ESRCH") return;
    // EPERM: alive, and another account's; the owner ran as this one, so its pid was given again (when its start time says so).
    if (code === "EPERM" && pidReused(previous)) return;
    throw new TaviError("CONFLICT", "Cannot establish that the previous owner process stopped", { cause: error });
  }
  // Alive, but another process than the owner that wrote the record: the owner stopped and its pid was given again.
  if (pidReused(previous)) return;
  throw new TaviError(
    "CONFLICT",
    `The previous owner process (${previous.pid}) is still alive; a released worker lock does not permit takeover`,
  );
}

export function publishOwnerProcess(directory: string, sessionId: string): void {
  const started = processStartTime(process.pid);
  const record: OwnerRecord = {
    version: 3,
    pid: process.pid,
    ...(started === undefined ? {} : { started }),
    machine: machineIdentity(),
    host: hostname(),
    sessionId,
  };
  const path = join(directory, OWNER_PROCESS_FILE);
  try {
    writeJsonAtomic(path, record, { durable: true });
  } catch (error) {
    // Readiness has not been published, so this acquisition cannot have started work. A throw from the directory
    // flush comes after the rename, so this session's record may already be in place: withdraw it.
    let published: OwnerRecord | undefined;
    try {
      published = readOwnerRecord(directory);
    } catch {
      published = undefined;
    }
    if (published?.sessionId === sessionId && published.pid === process.pid) {
      try {
        unlinkSync(path);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT"))
          throw new AggregateError([error, cleanupError], "Ownership record publication and cleanup failed");
      }
    }
    throw error;
  }
}

export function removeOwnerProcess(directory: string, sessionId: string): void {
  const record = readOwnerRecord(directory);
  if (record === undefined) return;
  if (record.pid !== process.pid || !isThisMachine(record) || record.sessionId !== sessionId)
    throw new TaviError("CONFLICT", "Ownership process identity changed before release");
  unlinkSync(join(directory, OWNER_PROCESS_FILE));
  flushDirectory(directory);
}
