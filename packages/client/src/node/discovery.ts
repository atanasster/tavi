import { existsSync, lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

import { IPC_DISCOVERY_FILE, IPC_RUNTIME_DIRECTORY, IPC_TOKEN_FILE, IpcDiscoverySchema, TaviError } from "@tavi/contracts";

import type { OwnerAddress } from "../client.js";

/** Where an owner of `dataDirectory` publishes its discovery record and its cookie; the endpoint is read from the record. */
export function ownerFiles(dataDirectory: string): { readonly discoveryPath: string; readonly tokenPath: string } {
  const runtime = join(dataDirectory, IPC_RUNTIME_DIRECTORY);
  return { discoveryPath: join(runtime, IPC_DISCOVERY_FILE), tokenPath: join(runtime, IPC_TOKEN_FILE) };
}

/**
 * Read the owner of `dataDirectory` from what it published: its
 * discovery record and its cookie, or `undefined` when either is absent or the
 * record is not one — a half-written or hand-edited file, or one the owner
 * removes while it is being read, reads as no owner, and the next attempt
 * reads it again.
 *
 * Refuses, as the owner's own reader does, what would let another user steer
 * this client: a symlink anywhere on the path, a publication directory other
 * users can reach (a planted record could point the cookie at their socket), or
 * a cookie other users can read. Whether a path is private is read from its
 * mode bits; on Windows, which has none, the caller passes `privacyProblem`
 * (the access-list check this package cannot make), and without it every
 * publication is refused there.
 */
export function readOwner(dataDirectory: string, options: ReadOwnerOptions = {}): OwnerAddress | undefined {
  const problem = options.privacyProblem ?? modeProblem;
  const directory = join(dataDirectory, IPC_RUNTIME_DIRECTORY);
  const { discoveryPath, tokenPath } = ownerFiles(dataDirectory);
  // Before existence: a dangling symlink reports as absent while still being
  // a redirection the owner never made.
  for (const path of [directory, discoveryPath, tokenPath]) refuseSymlink(path);
  if (!existsSync(discoveryPath) || !existsSync(tokenPath)) return undefined;
  // Each read tolerates the file vanishing under it: an owner stopping removes
  // its record, then its cookie, and one starting rewrites the cookie.
  if (
    absentOnVanish(() => refuseShared(directory, problem, `is accessible to other users; ${expectation("a private directory (0700)")}`)) ===
    undefined
  ) {
    return undefined;
  }
  if (absentOnVanish(() => refuseShared(tokenPath, problem, `is readable by other users; ${expectation("0600")}`)) === undefined) {
    return undefined;
  }

  const text = absentOnVanish(() => readFileSync(discoveryPath, "utf8"));
  if (text === undefined) return undefined;
  let discovery;
  try {
    const parsed = IpcDiscoverySchema.safeParse(JSON.parse(text));
    if (!parsed.success) return undefined;
    discovery = parsed.data;
  } catch {
    return undefined;
  }
  const token = absentOnVanish(() => readFileSync(tokenPath, "utf8").trim());
  if (token === undefined || token === "") return undefined;
  return {
    endpoint: discovery.endpoint,
    sessionId: discovery.sessionId,
    protocolVersion: discovery.protocolVersion,
    token,
  };
}

/** `read()`'s value, or `undefined` when the file it reads has gone; any other failure is thrown. */
function absentOnVanish<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** As the owner's own reader refuses one (`INVALID_INPUT`); an absent path is no redirection. */
function refuseSymlink(path: string): void {
  let symbolic: boolean;
  try {
    symbolic = lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (symbolic) throw new TaviError("INVALID_INPUT", `Refusing a symlinked IPC path at ${path}`);
}

/** How `readOwner` judges the publication. */
export interface ReadOwnerOptions {
  /**
   * What lets other accounts reach `path` (`mode 644`), or undefined when it
   * is private. By default its mode bits; on Windows the caller passes the
   * access-list check (`@tavi/node-kit`'s `privacyProblem`).
   */
  readonly privacyProblem?: (path: string, stats: Stats) => string | undefined;
}

/** What a refusal expected: the mode off Windows; there, which has none, the access list's rule. */
function expectation(mode: string): string {
  return process.platform === "win32" ? "expected access for this account, SYSTEM and Administrators only" : `expected ${mode}`;
}

/** The mode-bit rule: what a Windows `stat` (always `0o666`) can never pass. */
function modeProblem(_path: string, stats: Stats): string | undefined {
  const mode = stats.mode & 0o777;
  return (mode & 0o077) === 0 ? undefined : `mode ${mode.toString(8)}`;
}

/** Throws when others can reach `path`; returns `true` (for `absentOnVanish`) otherwise. */
function refuseShared(path: string, privacyProblem: (path: string, stats: Stats) => string | undefined, refusal: string): true {
  const stats = statSync(path);
  const shared = privacyProblem(path, stats);
  if (shared !== undefined) {
    throw new TaviError("NOT_AUTHORIZED", `${path} ${refusal} (${shared})`, {
      details: { mode: (stats.mode & 0o777).toString(8) },
    });
  }
  return true;
}
