/**
 * Argument provenance: where
 * the strings a call carries can be found in the conversation, for display
 * only. Each structured identifier in the input (a URL, an email address, a
 * file path, a hostname) and every other string leaf of at least 16
 * characters is looked up **verbatim** in the newest 100 KB of the
 * checkpointed conversation: a person message gives `person`, which wins over
 * a tool's output; an untrusted message gives where it came from (`page:<host>`,
 * `email:<domain>`, `tool:<id>`); no match gives `unmatched` — "model-written
 * or older than the window", never a claim that the model invented it.
 *
 * It never changes a decision: paraphrase defeats verbatim matching. The
 * window bound and the 16-character floor keep the walk linear and keep
 * common words from matching.
 *
 * Pure: no I/O, no clock. Acyclic: imports only zod, `content-label.ts` and `terminal-text.ts`.
 */
import { z } from "zod";

import { CONTENT_LABEL_LIMITS, SourceKindSchema, type SourceKind } from "./content-label.js";
import { displaySafe } from "./terminal-text.js";
import { clip } from "./util.js";

export const ARG_PROVENANCE_LIMITS = {
  /** The newest conversation text searched, in UTF-16 units. */
  windowChars: 100 * 1024,
  /** A free-text leaf shorter than this is not looked up (an identifier is, from `minIdentifierChars`). */
  minLeafChars: 16,
  minIdentifierChars: 4,
  /** Origins a verdict carries. */
  maxOrigins: 16,
  /** The value as a card shows it. */
  maxValueChars: 120,
  maxPathChars: 120,
  /** How deep, and how many nodes, of a call's input are walked. */
  maxDepth: 8,
  maxNodes: 512,
} as const;

/** Where one of a call's strings was found. */
export const ArgOriginSchema = z.object({
  /** Where in the input: `url`, `body`, `steps[2].text`. */
  path: z.string().max(ARG_PROVENANCE_LIMITS.maxPathChars),
  /** The string, clipped for display. */
  value: z.string().max(ARG_PROVENANCE_LIMITS.maxValueChars),
  /** `person`: a message of the person's; `content`: an untrusted or tool message; `unmatched`: neither in the window. */
  from: z.enum(["person", "content", "unmatched"]),
  /** With `content`: the message's source kind, the host Tavi parsed, the tool that returned it, and the ref. */
  source: SourceKindSchema.optional(),
  host: z.string().max(CONTENT_LABEL_LIMITS.maxHostLength).optional(),
  toolId: z.string().max(128).optional(),
  ref: z.string().max(CONTENT_LABEL_LIMITS.maxRefLength).optional(),
});
export type ArgOrigin = z.infer<typeof ArgOriginSchema>;

/** One message of the window, classified by the reader that built it (the workflow, which knows its labels). */
export interface ProvenanceWindowEntry {
  readonly text: string;
  readonly from: "person" | "content";
  readonly source?: SourceKind | undefined;
  readonly host?: string | undefined;
  readonly toolId?: string | undefined;
  readonly ref?: string | undefined;
}

/**
 * The window: `entries` oldest first, cut to the newest `maxChars` of
 * text — a message that straddles the bound keeps its newest part. Answered
 * newest first.
 */
export function provenanceWindow(
  entries: readonly ProvenanceWindowEntry[],
  maxChars: number = ARG_PROVENANCE_LIMITS.windowChars,
): readonly ProvenanceWindowEntry[] {
  const kept: ProvenanceWindowEntry[] = [];
  let left = maxChars;
  for (let index = entries.length - 1; index >= 0 && left > 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.text === "") continue;
    const text = entry.text.length <= left ? entry.text : entry.text.slice(entry.text.length - left);
    left -= text.length;
    kept.push(text === entry.text ? entry : { ...entry, text });
  }
  return kept;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>`]+/gi;
// Linear: a run is tried once, from its start (the lookbehind), and every quantifier is bounded.
const EMAIL_IN_TEXT = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,63}/g;
const WHOLE_URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const WHOLE_EMAIL = /^[^\s@]{1,64}@[^\s@.]{1,63}(?:\.[^\s@.]{1,63}){1,8}$/;
/** The longest email address (RFC 5321), and the most of a leaf scanned for addresses inside it. */
const MAX_EMAIL_CHARS = 254;
const MAX_SCANNED_CHARS = 16 * 1024;
const WHOLE_PATH = /^(?:~|\.{1,2})?\/[^\0\n]*$|^[A-Za-z]:\\[^\0\n]*$/;
const WHOLE_HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Whether a whole string is a structured identifier: looked up whatever its length (from 4 characters). */
function isIdentifier(text: string): boolean {
  return (
    text.length >= ARG_PROVENANCE_LIMITS.minIdentifierChars &&
    (WHOLE_URL.test(text) ||
      (text.length <= MAX_EMAIL_CHARS && WHOLE_EMAIL.test(text)) ||
      WHOLE_HOST.test(text) ||
      (WHOLE_PATH.test(text) && text.length > 1))
  );
}

/** A character of a credential's body: a value is never cut inside a run of them. */
const TOKEN_CHAR = /[A-Za-z0-9._~+/=-]/;

/**
 * A value clipped to `limit` (`ARG_PROVENANCE_LIMITS.maxValueChars`) with `…`,
 * never inside a run of token characters: the run is dropped whole, so no
 * prefix of a token too short for its mask's pattern survives the cut.
 */
export function clipArgValue(text: string, limit: number = ARG_PROVENANCE_LIMITS.maxValueChars): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  if (TOKEN_CHAR.test(text.charAt(end))) while (end > 0 && TOKEN_CHAR.test(text.charAt(end - 1))) end -= 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * Argument origins masked as `mask` (a credential mask, `redactToolText`)
 * masks text: each value and path masked whole, then clipped to its bound
 * again, so a placeholder longer than what it replaced never breaks the
 * schema. Values were clipped by `clipArgValue`, so a cut token is not there
 * to leak.
 */
export function maskArgOrigins(origins: readonly ArgOrigin[], mask: (text: string) => string): readonly ArgOrigin[] {
  return origins.map((origin) => ({
    ...origin,
    path: clipArgValue(mask(origin.path), ARG_PROVENANCE_LIMITS.maxPathChars),
    value: clipArgValue(mask(origin.value)),
    ...(origin.host === undefined ? {} : { host: clipArgValue(mask(origin.host), CONTENT_LABEL_LIMITS.maxHostLength) }),
    ...(origin.ref === undefined ? {} : { ref: clipArgValue(mask(origin.ref), CONTENT_LABEL_LIMITS.maxRefLength) }),
  }));
}

/**
 * Fields never looked up: Tavi's own handles and checksums — a browser
 * session, an artifact, a memory record, a document's sha256. "art-up-5c14…
 * appears in an attachment" says nothing a person can weigh, and the tool
 * checks each against what the chat holds.
 */
const NOT_LOOKED_UP_KEYS: ReadonlySet<string> = new Set(["sessionId", "artifactId", "recordId", "sha256", "sourceSha256"]);

interface Candidate {
  readonly path: string;
  readonly value: string;
}

/**
 * The strings of `input` worth looking up, identifiers first: a whole leaf
 * that is an identifier; the URLs and email addresses inside a longer leaf;
 * and each other leaf of at least 16 characters. Each value once; at most
 * `maxOrigins`. The walk is bounded in depth and nodes.
 */
function candidatesOf(input: unknown): readonly Candidate[] {
  const identifiers: Candidate[] = [];
  const texts: Candidate[] = [];
  const seen = new Set<string>();
  let nodes = 0;
  const add = (into: Candidate[], path: string, value: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    into.push({ path: clipArgValue(path === "" ? "(input)" : path, ARG_PROVENANCE_LIMITS.maxPathChars), value });
  };
  const walk = (value: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > ARG_PROVENANCE_LIMITS.maxNodes || depth > ARG_PROVENANCE_LIMITS.maxDepth) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (text === "") return;
      if (isIdentifier(text)) {
        add(identifiers, path, text);
        return;
      }
      const scanned = text.slice(0, MAX_SCANNED_CHARS);
      for (const match of scanned.matchAll(URL_IN_TEXT)) add(identifiers, path, match[0].replace(/[.,;:!?)\]]+$/, ""));
      for (const match of scanned.matchAll(EMAIL_IN_TEXT)) add(identifiers, path, match[0]);
      if (text.length >= ARG_PROVENANCE_LIMITS.minLeafChars) add(texts, path, text);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>))
        if (!NOT_LOOKED_UP_KEYS.has(key)) walk(item, path === "" ? key : `${path}.${key}`, depth + 1);
    }
  };
  walk(input, "", 0);
  return [...identifiers, ...texts].slice(0, ARG_PROVENANCE_LIMITS.maxOrigins);
}

/**
 * Where each of a call's strings appears in `window` (newest first, as
 * `provenanceWindow` answers it), verbatim: a person message first, whatever
 * else holds it; then the newest other message; else `unmatched`. At most
 * `maxOrigins` entries, in the order the strings were found.
 */
export function argumentOrigins(input: unknown, window: readonly ProvenanceWindowEntry[]): readonly ArgOrigin[] {
  const candidates = candidatesOf(input);
  if (candidates.length === 0) return [];
  const people = window.filter((entry) => entry.from === "person");
  const content = window.filter((entry) => entry.from === "content");
  return candidates.map((candidate): ArgOrigin => {
    // Shown on the card: what a value or key would hide is marked there, as the rest of the card's text is.
    const value = clipArgValue(displaySafe(candidate.value));
    const path = clipArgValue(displaySafe(candidate.path), ARG_PROVENANCE_LIMITS.maxPathChars);
    if (people.some((entry) => entry.text.includes(candidate.value))) return { path, value, from: "person" };
    const found = content.find((entry) => entry.text.includes(candidate.value));
    if (found === undefined) return { path, value, from: "unmatched" };
    return {
      path,
      value,
      from: "content",
      ...(found.source === undefined ? {} : { source: found.source }),
      ...(found.host === undefined ? {} : { host: clip(found.host, CONTENT_LABEL_LIMITS.maxHostLength) }),
      ...(found.toolId === undefined ? {} : { toolId: clip(found.toolId, 128) }),
      ...(found.ref === undefined ? {} : { ref: clip(found.ref, CONTENT_LABEL_LIMITS.maxRefLength) }),
    };
  });
}

/** An origin as written: `person`, `unmatched`, `page:<host>`, `email:<domain>`, `tool:<id>`, or the source kind. */
export function argOriginToken(origin: ArgOrigin): string {
  if (origin.from !== "content") return origin.from;
  const host = origin.host;
  switch (origin.source) {
    case "web":
    case "heartbeat":
      if (host !== undefined) return `page:${host}`;
      break;
    case "email":
      if (host !== undefined) return `email:${host}`;
      break;
    case "chat-other":
    case "chat-forward":
      if (host !== undefined) return `chat:${host}`;
      break;
    default:
      break;
  }
  if (origin.toolId !== undefined) return `tool:${origin.toolId}`;
  return origin.source ?? "content";
}
