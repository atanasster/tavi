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
 * Pure. Type-only imports besides `content-label.ts`'s and `skill-ceiling.ts`'s, so it is acyclic.
 */
import { DESKTOP_HOST_PREFIX, type LabelRef, type LabelSummary, type SourceKind } from "./content-label.js";
import type { ApprovalProvenance, GateReason } from "./tool-policy.js";
import type { ArgOrigin } from "./argument-provenance.js";
// Acyclic: skill-ceiling.ts imports only zod.
import { skillCeilingWords, type SkillCeilingSummary } from "./skill-ceiling.js";

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

/** A source kind in plain words. */
export const SOURCE_WORDS: Readonly<Record<SourceKind, string>> = {
  web: "a web page",
  search: "search results",
  email: "an email",
  "chat-other": "someone else's message",
  "chat-forward": "a forwarded message",
  attachment: "an attachment",
  download: "a download",
  mcp: "an MCP tool's output",
  plugin: "a plugin's output",
  agent: "a worker's answer",
  "past-chat": "a past chat",
  "routine-output": "a routine's output",
  heartbeat: "a heartbeat signal",
  sandbox: "sandbox output",
  webhook: "a webhook call",
  "unknown-source": "untrusted content",
};

/** A desktop app's screen in plain words: what `refEstablished` says for a `DESKTOP_HOST_PREFIX` host. */
export const DESKTOP_SOURCE_WORDS = "a desktop app's screen";

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

/** "Why am I asked?" in plain words, for each reason the gate asks once; a ceiling's card names its skill (`skillCeilingWords`). */
export const GATE_REASON_WORDS: Readonly<Record<GateReason, string>> = {
  "novel-url":
    "This chat read content Tavi does not trust, and this call opens an address you did not give and Tavi cannot vouch for: a model wrote it, or a page showed it after the model typed on that page. A page can steer the model into putting your data in an address.",
  "tainted-payload":
    "This chat read content Tavi does not trust, and this call acts on a site as the model chose: it sends, types, uploads or downloads. A page can steer the model into sending your data or fetching what it wants.",
  "tainted-message":
    "This chat read content Tavi does not trust, and this call sends a message. A page can steer the model into writing to someone on your behalf.",
  "credential-under-taint": "This chat read content Tavi does not trust, and this call uses one of your saved credentials.",
  "tainted-persist":
    "This chat read content Tavi does not trust, and this call changes something that lasts beyond this chat (a routine, a reminder, a rule, a file).",
  "private-search":
    "This chat read content Tavi does not trust and also holds private data, and this call sends a search query that could carry it out.",
  "private-group-reply":
    "This chat read content Tavi does not trust and also holds private data, and this reply goes where other people read it.",
  "signed-in-browser":
    "This chat read content Tavi does not trust, and this call opens the browser with your profile: the sites you are signed in to, as you. A page can steer the model into acting in your accounts.",
  "outside-skill-ceiling":
    "A skill this chat loaded lists the tools it uses (allowed-tools), and this call is not one of them. Approve it only if you expect the skill to need it.",
};

/**
 * "Why am I asked?" for a desktop action under taint: it is asked as a `persist` call, but a keypress or a click
 * changes an app on the person's computer, not a routine or a file Tavi keeps.
 */
export const DESKTOP_TAINTED_WORDS =
  "This chat read content Tavi does not trust, and this call acts in an app on your computer: it clicks, types or presses keys. What the model read can steer it into acting on your behalf.";

/** What a card says when the chat is tainted but the taint step did not ask (another rule did). */
export const TAINTED_CALL_WORDS = "This chat read content Tavi does not trust, which may be steering this call.";

/** "Why am I asked?" for one call: its reason's words (a ceiling's naming its skill, a desktop action's its own), the tainted line, or nothing. */
export function whyAskedText(
  gateReason: GateReason | undefined,
  tainted: boolean,
  skillCeiling?: SkillCeilingSummary | undefined,
  toolName?: string | undefined,
): string | undefined {
  if (gateReason === "outside-skill-ceiling" && skillCeiling !== undefined) return skillCeilingWords(skillCeiling);
  if (gateReason === "tainted-persist" && toolName?.startsWith("desktop.") === true) return DESKTOP_TAINTED_WORDS;
  if (gateReason !== undefined) return GATE_REASON_WORDS[gateReason];
  return tainted ? TAINTED_CALL_WORDS : undefined;
}

/** One source, as Tavi established it: the host it parsed, the verified sender domain, or the kind. */
export function refEstablished(ref: { readonly source: SourceKind; readonly host?: string | undefined }): string {
  const app = desktopAppOf(ref);
  if (app !== undefined) return app === "" ? DESKTOP_SOURCE_WORDS : `${DESKTOP_SOURCE_WORDS} (${app})`;
  const host = ref.host === undefined ? "" : neutralizedText(ref.host, HOST_CHARS);
  if (host === "") return SOURCE_WORDS[ref.source];
  switch (ref.source) {
    case "web":
    case "heartbeat":
      return host;
    case "email":
      // Its host is the verified domain the person's own mail came through: the words are what they forwarded or quoted, not that domain's.
      return `mail you forwarded or quoted (via ${host})`;
    case "chat-other":
      return `a message from ${host}`;
    case "search":
      return `search results from ${host}`;
    case "mcp":
      return `the MCP server ${host}`;
    default:
      return `${SOURCE_WORDS[ref.source]} (${host})`;
  }
}

/** What content says about itself, after what Tavi established: "the page calls itself “…”". */
function claimOf(ref: Pick<LabelRef, "source" | "title">): string | undefined {
  if (ref.title === undefined) return undefined;
  const title = neutralizedText(ref.title, PROVENANCE_TITLE_CHARS);
  if (title === "") return undefined;
  const who =
    ref.source === "web" || ref.source === "search" || ref.source === "heartbeat"
      ? "the page"
      : ref.source === "email"
        ? "the email"
        : "it";
  return `${who} calls itself “${title}”`;
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
export function provenanceChips(provenance: SourcesOf): readonly ProvenanceChip[] {
  const chips: ProvenanceChip[] = [];
  const seen = new Set<string>();
  for (const ref of provenance.refs) {
    const established = refEstablished(ref);
    if (seen.has(established)) continue;
    seen.add(established);
    const claim = claimOf(ref);
    chips.push(claim === undefined ? { established } : { established, claim });
  }
  const named = new Set(provenance.refs.map((ref) => ref.source));
  for (const source of provenance.sources) {
    if (named.has(source)) continue;
    const established = SOURCE_WORDS[source];
    if (seen.has(established)) continue;
    seen.add(established);
    chips.push({ established });
  }
  return chips.slice(0, MAX_CHIPS);
}

/** "example.com, mail you forwarded or quoted (via x.example) and 2 more": the established part of the chips, for one line. */
export function provenanceSourcesPhrase(provenance: SourcesOf, shown: number = PROVENANCE_SOURCES_SHOWN): string {
  const all = provenanceChips(provenance).map((chip) => chip.established);
  if (all.length === 0) return SOURCE_WORDS["unknown-source"];
  const head = all.slice(0, shown);
  const more = all.length - head.length;
  if (more > 0) return `${head.join(", ")} and ${more} more`;
  return head.length === 1 ? (head[0] ?? "") : `${head.slice(0, -1).join(", ")} and ${head.at(-1) ?? ""}`;
}

/**
 * A channel's line for a tainted call: "⚠ after reading example.com,
 * mail you forwarded or quoted (via x.example) — once only". `onceOnly`: the call may be approved
 * once only. Bounded: three sources, each host at most 80 characters.
 */
export function approvalProvenanceLine(provenance: SourcesOf, onceOnly: boolean): string {
  return `⚠ after reading ${provenanceSourcesPhrase(provenance)}${onceOnly ? " — once only" : ""}`;
}

/** Where one of a call's strings appears, in plain words. */
export function argOriginWords(origin: ArgOrigin): string {
  if (origin.from === "person") return "from your message";
  if (origin.from === "unmatched") return "not in this chat's recent text (written by the model, or older)";
  // A built-in desktop tool's output whose label named no app (a failed call's) carries the bare prefix: the gate
  // names it by the tool's built-in origin, never by its id, which any plugin may choose.
  if (origin.source !== undefined) return `appears in ${refEstablished({ source: origin.source, host: origin.host })}`;
  return origin.toolId === undefined ? "appears in a tool's output" : `appears in ${neutralizedText(origin.toolId, 128)}'s output`;
}

/** What a header's taint chip says: up to three sources Tavi established. */
export function taintChipText(label: SourcesOf): string {
  return `Read ${provenanceSourcesPhrase(label)}`;
}

/** The remedy for a tainted chat (WORKING-FOLDERS.md §Taint): a new chat, never an un-taint. */
export const TAINT_REMEDY = "Start a fresh chat";

/** The taint details' head line. */
export const TAINT_DETAIL_HEAD = "This chat read content Tavi does not trust:";

/** What the taint details say after the sources: what it changes, the remedy, and that Fresh context (`/compact`) does not clear it. */
export const TAINT_DETAIL_NOTES: readonly string[] = [
  "Until the chat ends, a call that sends data out, uses a credential or changes something lasting asks you once.",
  `${TAINT_REMEDY} to work without it: a new chat starts clean.`,
  "Fresh context (/compact) does not clear it: the summary is written from the same content.",
];

/**
 * The taint chip's details as lines (`tavi chat`'s `/taint`; the canvas
 * popover shows the same parts): what the chat read, then `TAINT_DETAIL_NOTES`.
 */
export function taintDetailLines(label: SourcesOf): readonly string[] {
  const chips = provenanceChips(label);
  return [
    TAINT_DETAIL_HEAD,
    ...(chips.length === 0
      ? [`  ${SOURCE_WORDS["unknown-source"]}`]
      : chips.map((chip) => `  ${chip.established}${chip.claim === undefined ? "" : ` — ${chip.claim}`}`)),
    ...TAINT_DETAIL_NOTES,
  ];
}
