import { mkdirSync } from "node:fs";

import { parseSddl, privateAccessProblem, privateDirectorySddl, trustedOwner } from "./security-descriptor.js";
import { currentUserSid, namedSecurity, setNamedAccessList } from "./win32.js";

/**
 * Whether a file or directory is private to this account: one rule, read
 * from mode bits on macOS and Linux and from the owner and access list on
 * Windows (whose `stat` reports `0o666` for every file). On Windows the rule
 * is OpenSSH's: the owner is this account, SYSTEM or Administrators (an
 * elevated process makes files owned by Administrators), and no other
 * trustee has an allow entry.
 */

/**
 * What lets other accounts reach `path`, or undefined when it is private:
 * `mode 644` on macOS and Linux (from `stats`), the owner or access entry at
 * fault on Windows. A Windows descriptor that cannot be read is a problem,
 * never "private".
 */
export function privacyProblem(
  path: string,
  stats: { readonly mode: number },
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") {
    const mode = stats.mode & 0o777;
    return (mode & 0o077) === 0 ? undefined : `mode ${mode.toString(8)}`;
  }
  let self: string;
  let descriptor: ReturnType<typeof parseSddl>;
  try {
    self = currentUserSid();
    descriptor = parseSddl(namedSecurity(path));
  } catch (error) {
    return `its access list could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!trustedOwner(descriptor.owner, self)) return `owned by ${descriptor.owner ?? "no one"}`;
  return privateAccessProblem(descriptor, self, { protectedOnly: false });
}

/**
 * Whether `path` belongs to this account: its uid on macOS and Linux (from
 * `stats`), its owner on Windows (this account, SYSTEM or Administrators).
 */
export function ownedHere(path: string, stats: { readonly uid: number }, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return typeof process.getuid !== "function" || stats.uid === process.getuid();
  try {
    return trustedOwner(parseSddl(namedSecurity(path)).owner, currentUserSid());
  } catch {
    return false;
  }
}

/**
 * Create `path` (and missing parents) private to this account: mode `0700`
 * from the moment it exists on macOS and Linux; on Windows, an access list
 * that inherits nothing and passes the owner, SYSTEM and Administrators to
 * everything made inside it.
 */
export function makePrivateDirectory(path: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (platform === "win32") setNamedAccessList(path, privateDirectorySddl(currentUserSid()));
}

/**
 * How to make `path` private again, for a refusal to name: `chmod`, or on
 * Windows `icacls` with every account named by its SID (`self`: this
 * account's), which reads the same in any shell and any language of Windows.
 */
export function privateRemedy(
  path: string,
  kind: "directory" | "file",
  platform: NodeJS.Platform = process.platform,
  self?: string,
): string {
  if (platform !== "win32") return `chmod ${kind === "directory" ? "700" : "600"} ${path}`;
  const inherit = kind === "directory" ? "(OI)(CI)" : "";
  const owner = self ?? currentUserSid();
  return `icacls "${path}" /inheritance:r /grant:r "*${owner}:${inherit}F" "*S-1-5-18:${inherit}F" "*S-1-5-32-544:${inherit}F"`;
}

/**
 * What a refusal says it expected: the mode (`600`) on macOS and Linux; on
 * Windows, which has none, the access list's rule.
 */
export function privateExpectation(mode: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "expected access for this account, SYSTEM and Administrators only" : `expected ${mode}`;
}
