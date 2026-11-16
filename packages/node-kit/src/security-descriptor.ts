/**
 * Windows security descriptors as SDDL text, read and checked without calling
 * Windows, so the rule each check applies is tested on every platform. The
 * calls that set and read them are in `win32.ts`.
 */

/** Well-known trustees by their SDDL alias. */
const ALIASES: Readonly<Record<string, string>> = {
  SY: "S-1-5-18",
  BA: "S-1-5-32-544",
  NU: "S-1-5-2",
  WD: "S-1-1-0",
  AU: "S-1-5-11",
  BU: "S-1-5-32-545",
  AN: "S-1-5-7",
};

export const LOCAL_SYSTEM_SID = "S-1-5-18";
export const ADMINISTRATORS_SID = "S-1-5-32-544";
export const NETWORK_SID = "S-1-5-2";

/** A trustee as its SID: an alias (`SY`) as the SID it stands for, a SID as itself. */
export function trusteeSid(trustee: string): string {
  return ALIASES[trustee.toUpperCase()] ?? trustee.toUpperCase();
}

export interface AccessEntry {
  /** `A` allow, `D` deny; other kinds as written. */
  readonly kind: string;
  readonly flags: string;
  readonly rights: string;
  /** The trustee as its SID. */
  readonly trustee: string;
}

export interface SecurityDescriptor {
  /** The owner as its SID, when the text holds one. */
  readonly owner?: string;
  /** The access list's flags: `P` protected (inherits nothing), `AI`, `AR`. */
  readonly daclFlags: string;
  /** Undefined when the text holds no access list. */
  readonly dacl?: readonly AccessEntry[];
}

/** The owner (`O:`) and access list (`D:`) of an SDDL string; the group and audit list are skipped. */
export function parseSddl(sddl: string): SecurityDescriptor {
  const sections = new Map<string, string>();
  for (const match of sddl.matchAll(/([OGDS]):((?:\([^)]*\)|[^():])*?)(?=[OGDS]:|$)/g)) {
    const [, key = "", value = ""] = match;
    sections.set(key, value);
  }
  const owner = sections.get("O");
  const daclText = sections.get("D");
  if (daclText === undefined) return { ...(owner === undefined ? {} : { owner: trusteeSid(owner) }), daclFlags: "" };
  const open = daclText.indexOf("(");
  const daclFlags = open === -1 ? daclText : daclText.slice(0, open);
  const dacl = [...daclText.matchAll(/\(([^)]*)\)/g)].map(([, body = ""]) => {
    // kind;flags;rights;object;inherited object;trustee
    const [kind = "", flags = "", rights = "", , , trustee = ""] = body.split(";");
    return { kind, flags, rights, trustee: trusteeSid(trustee) };
  });
  return { ...(owner === undefined ? {} : { owner: trusteeSid(owner) }), daclFlags, dacl };
}

/**
 * The access list an owner's private object carries: inherits nothing; the
 * owner, SYSTEM and Administrators may do anything; any network logon is denied.
 */
export function ownerOnlySddl(ownerSid: string): string {
  return `D:P(D;;GA;;;NU)(A;;GA;;;${ownerSid})(A;;GA;;;SY)(A;;GA;;;BA)`;
}

/**
 * The access list Tavi gives the data directory it creates: inherits
 * nothing, and passes to everything made inside it the owner, SYSTEM and
 * Administrators, and no one else.
 */
export function privateDirectorySddl(ownerSid: string): string {
  return `D:P(A;OICI;FA;;;${ownerSid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
}

/**
 * The trustees that name `self` in SDDL: its SID, and for the machine's
 * built-in Administrator (relative id 500) the alias `LA`, which Windows writes
 * for that account in place of its SID.
 */
function selfTrustees(self: string): ReadonlySet<string> {
  const sid = trusteeSid(self);
  return new Set(/^S-1-5-21-[\d-]+-500$/.test(sid) ? [sid, "LA"] : [sid]);
}

/** Whether `owner` may own a private object of `self`'s: `self`, or SYSTEM or Administrators, who own the machine. */
export function trustedOwner(owner: string | undefined, self: string): boolean {
  if (owner === undefined) return false;
  const sid = trusteeSid(owner);
  return selfTrustees(self).has(sid) || sid === LOCAL_SYSTEM_SID || sid === ADMINISTRATORS_SID;
}

/**
 * What is wrong with `descriptor` as a private object of `self`'s, or
 * undefined: its access list must allow no trustee but `self`, SYSTEM and
 * Administrators; with `protectedOnly` (the default) it must also inherit
 * nothing, and with `denyNetwork` deny network logons. A file under a private
 * directory is checked without `protectedOnly`: what it inherits is listed in
 * its own access list, and is held to the same rule.
 */
export function privateAccessProblem(
  descriptor: SecurityDescriptor,
  self: string,
  options: { readonly denyNetwork?: boolean; readonly protectedOnly?: boolean } = {},
): string | undefined {
  if (descriptor.dacl === undefined) return "it has no access list, so everyone may open it";
  if (options.protectedOnly !== false && !descriptor.daclFlags.toUpperCase().includes("P"))
    return "its access list inherits entries from its parent";
  const allowed = new Set([...selfTrustees(self), LOCAL_SYSTEM_SID, ADMINISTRATORS_SID]);
  const stranger = descriptor.dacl.find((entry) => entry.kind.toUpperCase() !== "D" && !allowed.has(entry.trustee));
  if (stranger !== undefined) return `its access list lets ${stranger.trustee} in`;
  if (options.denyNetwork === true && !descriptor.dacl.some((entry) => entry.kind.toUpperCase() === "D" && entry.trustee === NETWORK_SID))
    return "its access list does not refuse network logons";
  return undefined;
}
