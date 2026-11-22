/**
 * How every surface says where untrusted content came from: the approval
 * card in the canvas, the terminal and the channels,
 * the chat header's taint chip, and the memory and routine provenance lines.
 *
 * One rule throughout: **what Tavi established leads** — the kind of source,
 * the host it parsed from a URL, the verified sender domain, the tool — and
 * what the content says about itself (a page's title) follows only as "the
 * page calls itself “…”", clipped to 60 characters and neutralized
 * (`neutralizedText`), so content can never speak in Tavi's voice.
 *
 * Pure. Type-only imports besides `content-label.ts`'s, `skill-ceiling.ts`'s and the `core` words, so it is acyclic.
 */
import { DESKTOP_HOST_PREFIX, type LabelRef, type LabelSummary, type SourceKind } from "./content-label.js";
import type { ApprovalProvenance, GateReason } from "./tool-policy.js";
import type { ArgOrigin } from "./argument-provenance.js";
// Acyclic: skill-ceiling.ts imports only zod and the `core` words.
import { skillCeilingWords, type SkillCeilingSummary } from "./skill-ceiling.js";
import { coreEnglish, type CoreT } from "./locales/core.js";
import type { CoreKey } from "./locales/core.js";

/**
 * Text from content made safe to show on one line, in any surface (a React
 * text node, a terminal, a chat message): no control, format or bidi
 * characters, no quotes to break out of, no markup (`<`, `>` become `‹`,
 * `›`), whitespace collapsed, clipped to `max` characters with `…`.
 */
export function neutralizedText(text: string, max: number): string {
  const cleaned = text
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/["\u201C\u201D\u00AB\u00BB`]/g, "'")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length <= max ? cleaned : `${chars.slice(0, max - 1).join("")}…`;
}

/** Each source kind's words in the `core` catalogue. */
const SOURCE_KEYS: Readonly<Record<SourceKind, CoreKey>> = {
  web: "provenance.source.web",
  search: "provenance.source.search",
  email: "provenance.source.email",
  "chat-other": "provenance.source.chatOther",
  "chat-forward": "provenance.source.chatForward",
  attachment: "provenance.source.attachment",
  download: "provenance.source.download",
  mcp: "provenance.source.mcp",
  plugin: "provenance.source.plugin",
  agent: "provenance.source.agent",
  "past-chat": "provenance.source.pastChat",
  "routine-output": "provenance.source.routineOutput",
  heartbeat: "provenance.source.heartbeat",
  sandbox: "provenance.source.sandbox",
  webhook: "provenance.source.webhook",
  "unknown-source": "provenance.source.unknownSource",
};

/** A source kind in plain words. */
export function sourceWords(source: SourceKind, t: CoreT = coreEnglish): string {
  return t(SOURCE_KEYS[source]);
}

/** A source kind in plain words, in English (`sourceWords`). */
export const SOURCE_WORDS: Readonly<Record<SourceKind, string>> = Object.fromEntries(
  Object.keys(SOURCE_KEYS).map((source) => [source, sourceWords(source as SourceKind)]),
) as Record<SourceKind, string>;

/** A desktop app's screen in plain words: what `refEstablished` says for a `DESKTOP_HOST_PREFIX` host. */
export function desktopSourceWords(t: CoreT = coreEnglish): string {
  return t("provenance.source.desktop");
}

/** `desktopSourceWords` in English. */
export const DESKTOP_SOURCE_WORDS = desktopSourceWords();

/** The most of a desktop app's name a label carries, in characters. */
const DESKTOP_APP_CHARS = 64;
/**
 * What a desktop app's name may hold to be shown where Tavi's own words go: letters, digits, spaces, `.`, `_` and
 * `-`. An app's name is its developer's choice, so one that could read as Tavi's words (`Notes) and mail you
 * forwarded or quoted (via bank.example`) is not shown at all.
 */
const DESKTOP_APP_NAME = /^[\p{L}\p{N} ._-]+$/u;

/** A desktop app's name as Tavi may show it (`DESKTOP_APP_NAME`), clipped by characters; `""` when it may not be shown. */
function desktopAppName(app: string | undefined): string {
  const name = (app ?? "").replace(/\s+/g, " ").trim();
  return DESKTOP_APP_NAME.test(name) ? Array.from(name).slice(0, DESKTOP_APP_CHARS).join("").trim() : "";
}

/**
 * The host a desktop tool's result is labelled with: the first of `apps` (its name, then its bundle id) that may be
 * shown, else none. Clipped by characters, so no surrogate pair is split, and well within a label's host.
 */
export function desktopSourceHost(...apps: readonly (string | undefined)[]): string {
  return `${DESKTOP_HOST_PREFIX}${apps.map(desktopAppName).find((name) => name !== "") ?? ""}`;
}

/**
 * The app a `web` ref's desktop host names, as it may be shown (`""` when none, or when the name is not plain words,
 * whoever wrote the label), or undefined for any other ref.
 */
export function desktopAppOf(ref: { readonly source: SourceKind; readonly host?: string | undefined }): string | undefined {
  return ref.source === "web" && ref.host?.startsWith(DESKTOP_HOST_PREFIX) === true
    ? desktopAppName(ref.host.slice(DESKTOP_HOST_PREFIX.length))
    : undefined;
}

/** The page-supplied title, at most, wherever one is shown. */
export const PROVENANCE_TITLE_CHARS = 60;
/** A host Tavi parsed, at most. */
const HOST_CHARS = 80;
/** Sources a one-line summary (a channel line, the taint chip) names before "and N more". */
export const PROVENANCE_SOURCES_SHOWN = 3;
/** Chips a card shows at most. */
const MAX_CHIPS = 8;

/** Each gate reason's "Why am I asked?" in the `core` catalogue. */
const GATE_REASON_KEYS: Readonly<Record<GateReason, CoreKey>> = {
  "novel-url": "provenance.why.novelUrl",
  "tainted-payload": "provenance.why.taintedPayload",
  "tainted-message": "provenance.why.taintedMessage",
  "credential-under-taint": "provenance.why.credentialUnderTaint",
  "tainted-persist": "provenance.why.taintedPersist",
  "private-search": "provenance.why.privateSearch",
  "private-group-reply": "provenance.why.privateGroupReply",
  "signed-in-browser": "provenance.why.signedInBrowser",
  "outside-skill-ceiling": "provenance.why.outsideSkillCeiling",
};

/** "Why am I asked?" in plain words, for each reason the gate asks once; a ceiling's card names its skill (`skillCeilingWords`). */
export function gateReasonWords(reason: GateReason, t: CoreT = coreEnglish): string {
  return t(GATE_REASON_KEYS[reason]);
}

/** `gateReasonWords` in English, by reason. */
export const GATE_REASON_WORDS: Readonly<Record<GateReason, string>> = Object.fromEntries(
  Object.keys(GATE_REASON_KEYS).map((reason) => [reason, gateReasonWords(reason as GateReason)]),
) as Record<GateReason, string>;

/**
 * "Why am I asked?" for a desktop action under taint, in English: it is asked as a `persist` call, but a keypress
 * or a click changes an app on the person's computer, not a routine or a file Tavi keeps.
 */
export const DESKTOP_TAINTED_WORDS = coreEnglish("provenance.why.desktopTainted");

/** What a card says when the chat is tainted but the taint step did not ask (another rule did). */
export function taintedCallWords(t: CoreT = coreEnglish): string {
  return t("provenance.why.tainted");
}

/** `taintedCallWords` in English. */
export const TAINTED_CALL_WORDS = taintedCallWords();

/** "Why am I asked?" for one call: its reason's words (a ceiling's naming its skill, a desktop action's its own), the tainted line, or nothing. */
export function whyAskedText(
  gateReason: GateReason | undefined,
  tainted: boolean,
  skillCeiling?: SkillCeilingSummary | undefined,
  toolName?: string | undefined,
  t: CoreT = coreEnglish,
): string | undefined {
  if (gateReason === "outside-skill-ceiling" && skillCeiling !== undefined) return skillCeilingWords(skillCeiling, t);
  if (gateReason === "tainted-persist" && toolName?.startsWith("desktop.") === true) return t("provenance.why.desktopTainted");
  if (gateReason !== undefined) return gateReasonWords(gateReason, t);
  return tainted ? taintedCallWords(t) : undefined;
}

/** One source, as Tavi established it: the host it parsed, the verified sender domain, or the kind. */
export function refEstablished(ref: { readonly source: SourceKind; readonly host?: string | undefined }, t: CoreT = coreEnglish): string {
  const app = desktopAppOf(ref);
  if (app !== undefined) return app === "" ? desktopSourceWords(t) : t("provenance.source.desktopApp", { app });
  const host = ref.host === undefined ? "" : neutralizedText(ref.host, HOST_CHARS);
  if (host === "") return sourceWords(ref.source, t);
  switch (ref.source) {
    case "web":
    case "heartbeat":
      return host;
    case "email":
      // Its host is the verified domain the person's own mail came through: the words are what they forwarded or quoted, not that domain's.
      return t("provenance.ref.email", { host });
    case "chat-other":
      return t("provenance.ref.chatOther", { host });
    case "search":
      return t("provenance.ref.search", { host });
    case "mcp":
      return t("provenance.ref.mcp", { host });
    default:
      return t("provenance.ref.other", { source: sourceWords(ref.source, t), host });
  }
}

/** What content says about itself, after what Tavi established: "the page calls itself “…”". */
function claimOf(ref: Pick<LabelRef, "source" | "title">, t: CoreT): string | undefined {
  if (ref.title === undefined) return undefined;
  const title = neutralizedText(ref.title, PROVENANCE_TITLE_CHARS);
  if (title === "") return undefined;
  const key =
    ref.source === "web" || ref.source === "search" || ref.source === "heartbeat"
      ? "provenance.claim.page"
      : ref.source === "email"
        ? "provenance.claim.email"
        : "provenance.claim.other";
  return t(key, { title });
}

/** A source chip: Tavi's own words first; the content's claim, if any, after. */
export interface ProvenanceChip {
  readonly established: string;
  readonly claim?: string;
}

/** What a provenance or label summary says it came from. */
type SourcesOf = Pick<ApprovalProvenance, "sources" | "refs"> | Pick<LabelSummary, "sources" | "refs">;

/** What a card reads of one approval request: its provenance, and its verdict's risk (an older owner sends only the risk). */
interface ProvenanceOfRequest {
  readonly provenance?: ApprovalProvenance | undefined;
  readonly risk?: { readonly tainted?: boolean | undefined; readonly label?: LabelSummary | undefined } | undefined;
}

/** Whether a request was made in a tainted chat: its risk says so, or the taint step asked it (a skill ceiling's ask is no taint). */
export function requestTainted(request: ProvenanceOfRequest): boolean {
  const reason = request.provenance?.gateReason;
  return request.risk?.tainted === true || (reason !== undefined && reason !== "outside-skill-ceiling");
}

/** Where a request's chat read untrusted content: its provenance when it names any, else its risk's untrusted label. */
export function requestSources(request: ProvenanceOfRequest): SourcesOf | undefined {
  const provenance = request.provenance;
  if (provenance !== undefined && (provenance.sources.length > 0 || provenance.refs.length > 0)) return provenance;
  const label = request.risk?.label;
  return label !== undefined && label.integrity === "untrusted" ? label : undefined;
}

/**
 * A card's source chips: one per ref (newest first), then each source kind no
 * ref names. Equal chips once; at most 8.
 */
export function provenanceChips(provenance: SourcesOf, t: CoreT = coreEnglish): readonly ProvenanceChip[] {
  const chips: ProvenanceChip[] = [];
  const seen = new Set<string>();
  for (const ref of provenance.refs) {
    const established = refEstablished(ref, t);
    if (seen.has(established)) continue;
    seen.add(established);
    const claim = claimOf(ref, t);
    chips.push(claim === undefined ? { established } : { established, claim });
  }
  const named = new Set(provenance.refs.map((ref) => ref.source));
  for (const source of provenance.sources) {
    if (named.has(source)) continue;
    const established = sourceWords(source, t);
    if (seen.has(established)) continue;
    seen.add(established);
    chips.push({ established });
  }
  return chips.slice(0, MAX_CHIPS);
}

/** "example.com, mail you forwarded or quoted (via x.example) and 2 more": the established part of the chips, for one line. */
export function provenanceSourcesPhrase(provenance: SourcesOf, shown: number = PROVENANCE_SOURCES_SHOWN, t: CoreT = coreEnglish): string {
  const all = provenanceChips(provenance, t).map((chip) => chip.established);
  if (all.length === 0) return sourceWords("unknown-source", t);
  const head = all.slice(0, shown);
  const more = all.length - head.length;
  if (more > 0) return t("provenance.sources.more", { sources: head.join(", "), more: String(more) });
  return head.length === 1
    ? (head[0] ?? "")
    : t("provenance.sources.last", { sources: head.slice(0, -1).join(", "), last: head.at(-1) ?? "" });
}

/**
 * A channel's line for a tainted call: "⚠ after reading example.com,
 * mail you forwarded or quoted (via x.example) — once only". `onceOnly`: the call may be approved
 * once only. Bounded: three sources, each host at most 80 characters.
 */
export function approvalProvenanceLine(provenance: SourcesOf, onceOnly: boolean, t: CoreT = coreEnglish): string {
  return t(onceOnly ? "provenance.line.onceOnly" : "provenance.line", {
    sources: provenanceSourcesPhrase(provenance, PROVENANCE_SOURCES_SHOWN, t),
  });
}

/** Where one of a call's strings appears, in plain words. */
export function argOriginWords(origin: ArgOrigin, t: CoreT = coreEnglish): string {
  if (origin.from === "person") return t("provenance.origin.person");
  if (origin.from === "unmatched") return t("provenance.origin.unmatched");
  // A built-in desktop tool's output whose label named no app (a failed call's) carries the bare prefix: the gate
  // names it by the tool's built-in origin, never by its id, which any plugin may choose.
  if (origin.source !== undefined)
    return t("provenance.origin.source", { source: refEstablished({ source: origin.source, host: origin.host }, t) });
  return origin.toolId === undefined
    ? t("provenance.origin.anyTool")
    : t("provenance.origin.tool", { tool: neutralizedText(origin.toolId, 128) });
}

/** What a header's taint chip says: up to three sources Tavi established. */
export function taintChipText(label: SourcesOf, t: CoreT = coreEnglish): string {
  return t("taint.chip", { sources: provenanceSourcesPhrase(label, PROVENANCE_SOURCES_SHOWN, t) });
}

/** The remedy for a tainted chat (WORKING-FOLDERS.md §Taint): a new chat, never an un-taint. */
export function taintRemedy(t: CoreT = coreEnglish): string {
  return t("taint.remedy");
}

/** `taintRemedy` in English. */
export const TAINT_REMEDY = taintRemedy();

/** The taint details' head line. */
export function taintDetailHead(t: CoreT = coreEnglish): string {
  return t("taint.detail.head");
}

/** `taintDetailHead` in English. */
export const TAINT_DETAIL_HEAD = taintDetailHead();

/** What the taint details say after the sources: what it changes, the remedy, and that Fresh context (`/compact`) does not clear it. */
export function taintDetailNotes(t: CoreT = coreEnglish): readonly string[] {
  return [t("taint.detail.lasting"), t("taint.detail.fresh"), t("taint.detail.compact")];
}

/** `taintDetailNotes` in English. */
export const TAINT_DETAIL_NOTES: readonly string[] = taintDetailNotes();

/**
 * The taint chip's details as lines (`tavi chat`'s `/taint`; the canvas
 * popover shows the same parts): what the chat read, then `taintDetailNotes`.
 */
export function taintDetailLines(label: SourcesOf, t: CoreT = coreEnglish): readonly string[] {
  const chips = provenanceChips(label, t);
  return [
    taintDetailHead(t),
    ...(chips.length === 0
      ? [`  ${sourceWords("unknown-source", t)}`]
      : chips.map((chip) => `  ${chip.established}${chip.claim === undefined ? "" : ` — ${chip.claim}`}`)),
    ...taintDetailNotes(t),
  ];
}
