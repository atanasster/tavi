import { z } from "zod";

import {
  CONTENT_LABEL_LIMITS,
  IntegritySchema,
  LabelRefSchema,
  SourceKindSchema,
  joinLabels,
  normalizeLabel,
  type ContentLabel,
} from "./content-label.js";
import { IdSchema, TimestampSchema, WorkspaceIdSchema } from "./ids.js";
import { canvasCoreEnglish, type CanvasCoreT } from "./locales/core-canvas.js";
// Acyclic: provenance-display.ts has only type imports besides content-label.ts.
import { desktopAppOf, desktopSourceWords, neutralizedText, PROVENANCE_TITLE_CHARS, sourceWords } from "./provenance-display.js";

/**
 * Personal memory, evidence and approved skills.
 *
 * This module is the platform-neutral contract: scope, records, revisions,
 * reviews, evidence, lineage, the deletion journal and the skill version
 * records.
 *
 * Two rules shape every schema here:
 *
 *  - **ownership is derived from scope, never supplied by a caller.** Absent ids
 *    are absent, never a wildcard;
 *  - **bodies are bounded.** Larger evidence is an authorized artifact reference,
 *    so a memory row can never become an unbounded blob.
 */

export const MEMORY_KINDS = ["preference", "fact", "lesson", "summary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * Lifecycle: `proposed → approved` or `rejected`; an approved record can become
 * `superseded`, `revoked`, `expired` or `deleted`.
 */
export const MEMORY_STATUSES = ["proposed", "approved", "rejected", "superseded", "revoked", "expired", "deleted"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Sensitivity controls prompt assembly; it is not a secret vault. */
export const MEMORY_SENSITIVITY = ["normal", "sensitive"] as const;
export type MemorySensitivity = (typeof MEMORY_SENSITIVITY)[number];

export const PREFERENCE_VALUE_TYPES = ["string", "number", "boolean", "json"] as const;
export type PreferenceValueType = (typeof PREFERENCE_VALUE_TYPES)[number];

/** Bounded record body: 8 KiB inline, larger evidence goes to an artifact. */
export const MAX_MEMORY_BODY_BYTES = 8 * 1024;
export const MAX_MEMORY_TITLE_CHARS = 200;
export const MAX_PREFERENCE_KEY_CHARS = 120;
/** A distinct name since `topicKey` is not preference-specific, structurally tied to the same bound so the two cannot silently diverge. */
export const MAX_TOPIC_KEY_CHARS = MAX_PREFERENCE_KEY_CHARS;
/** At most this many cited source ids per revision (bounded inputs). */
export const MAX_SOURCE_IDS = 64;
/** At most this many write-time keywords per revision, and each keyword's character bound. */
export const MAX_MEMORY_KEYWORDS = 8;
export const MAX_MEMORY_KEYWORD_CHARS = 64;
export const MAX_SEARCH_SNIPPET_CHARS = 2 * 1024;
/** A search hit's excerpt is the whole body up to this many characters. */
export const MEMORY_EXCERPT_WHOLE_BODY_CHARS = 300;
/** Past it, a window of this many tokens around the match (FTS5 `snippet()`'s last argument). */
export const MEMORY_EXCERPT_SNIPPET_TOKENS = 40;

/**
 * A search hit's excerpt: the whole body when it is at most
 * `MEMORY_EXCERPT_WHOLE_BODY_CHARS` characters (code points), else `window` —
 * the index's window around the match — or, with none, the body's start.
 */
export function memoryExcerptOf(body: string, window?: string): string {
  const characters = Array.from(body);
  if (characters.length <= MEMORY_EXCERPT_WHOLE_BODY_CHARS) return body;
  if (window !== undefined && window.trim() !== "") return window.slice(0, MAX_SEARCH_SNIPPET_CHARS);
  return `${characters.slice(0, MEMORY_EXCERPT_WHOLE_BODY_CHARS).join("")}…`;
}

/**
 * The head of a recalled record's prompt line, shared by the turn
 * and the heartbeat: `<title> — <excerpt>`, the title alone when the excerpt is
 * blank, the excerpt alone when there is no title. Whitespace runs collapse to
 * one space so a record's text stays on its own line under the untrusted-data
 * heading.
 */
export function memoryExcerptHead(title: string | undefined, excerpt: string): string {
  const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
  const head = title === undefined ? "" : flat(title);
  const body = flat(excerpt);
  if (head === "") return body;
  return body === "" ? head : `${head} — ${body}`;
}

/** Default and maximum page sizes for list/search. */
export const MEMORY_LIST_PAGE_DEFAULT = 50;
export const MEMORY_LIST_PAGE_MAX = 200;
export const MEMORY_SEARCH_DEFAULT = 10;
export const MEMORY_SEARCH_MAX = 50;

/**
 * An agent's proposal nobody reviews within this many days of being proposed
 * becomes `expired`, so unreviewed proposals do
 * not pile up in the operator's inbox.
 */
export const MEMORY_PROPOSAL_TTL_DAYS = 30;

/**
 * Default retention policy: explicit approved preferences/facts/
 * lessons persist until correction, forgetting or configured expiry; a
 * proposal expires `MEMORY_PROPOSAL_TTL_DAYS` after it was proposed, and a
 * rejected or expired proposal is erased the same number of days after that;
 * run-local memory expires 7 days after it was last touched. A run's actual
 * completion time is not tracked by memory records themselves, so "last
 * touched" (`updatedAt`) is the practical proxy this uses — see
 * `packages/runtime/src/memory/service.ts`'s `sweepExpired` doc comment.
 */
export const DEFAULT_MEMORY_RETENTION_DAYS = { proposedOrRejected: MEMORY_PROPOSAL_TTL_DAYS, runLocal: 7 } as const;

/**
 * The five scopes.
 *
 * A discriminated union rather than nullable columns: `personal` has no
 * workspace, `run_local` requires one, and making that structural is what stops
 * an absent id from being read as "everything".
 */
export const MemoryScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal"), principalId: IdSchema }),
  z.object({
    kind: z.literal("personal_workspace"),
    principalId: IdSchema,
    workspaceId: WorkspaceIdSchema,
  }),
  z.object({
    kind: z.literal("personal_agent"),
    principalId: IdSchema,
    agentId: IdSchema,
    /** The workspace variant further restricts access when present. */
    workspaceId: WorkspaceIdSchema.optional(),
  }),
  z.object({ kind: z.literal("shared_workspace"), workspaceId: WorkspaceIdSchema }),
  z.object({
    kind: z.literal("run_local"),
    principalId: IdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: IdSchema,
  }),
]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MEMORY_SCOPE_KINDS = ["personal", "personal_workspace", "personal_agent", "shared_workspace", "run_local"] as const;
export type MemoryScopeKind = (typeof MEMORY_SCOPE_KINDS)[number];

/**
 * A read key for a chat's notes alone: the
 * `run_local` key of the chat's own task, prefixed, matching only its durable
 * records. A delegated task is given it so it recalls the chat's notes but not
 * the chat's working memory. Never a stored key: records keep their scope's.
 */
export const CHAT_NOTES_KEY_PREFIX = "chat-notes:";

/**
 * A read key for every chat's notes of one person in one workspace: the
 * Command Center's list of chat notes across chats. It names the person and
 * the workspace exactly (an id may hold any character, so a text prefix of
 * their keys could match another's), and the store matches them by column;
 * only the operator's page builds it.
 */
export function allChatNotesKey(principalId: string, workspaceId: string): string {
  return `${CHAT_NOTES_KEY_PREFIX}*${JSON.stringify([principalId, workspaceId])}`;
}

/**
 * The normalized, non-null key a scope is stored and indexed under.
 *
 * Two properties matter and are why this is one function rather than SQL string
 * building at each call site: it is stable (the same scope always produces the
 * same key, so uniqueness is enforceable), and it is order-independent of how the
 * caller wrote the object.
 */
export function memoryScopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case "personal":
      return `personal|p=${scope.principalId}`;
    case "personal_workspace":
      return `personal_workspace|p=${scope.principalId}|w=${scope.workspaceId}`;
    case "personal_agent":
      return scope.workspaceId === undefined
        ? `personal_agent|p=${scope.principalId}|a=${scope.agentId}`
        : `personal_agent|p=${scope.principalId}|a=${scope.agentId}|w=${scope.workspaceId}`;
    case "shared_workspace":
      return `shared_workspace|w=${scope.workspaceId}`;
    case "run_local":
      return `run_local|p=${scope.principalId}|w=${scope.workspaceId}|r=${scope.runId}`;
  }
}

/**
 * Preference precedence, highest first.
 *
 * The order is data so the resolver, the inspection output and the tests share
 * one definition instead of three similar switches.
 */
export const PREFERENCE_PRECEDENCE: readonly MemoryScopeKind[] = [
  "run_local",
  "personal_agent",
  "personal_workspace",
  "personal",
  "shared_workspace",
];

/** A memory record as it exists now: identity, scope, lifecycle and validity. */
export const MemoryRecordSchema = z.object({
  recordId: IdSchema,
  kind: z.enum(MEMORY_KINDS),
  scope: MemoryScopeSchema,
  /** Normalized scope key; derived, never supplied by a caller. */
  scopeKey: z.string().min(1).max(512),
  /**
   * Namespaced stable key for preferences, so one active value per scope and key
   * is enforceable.
   */
  preferenceKey: z.string().min(1).max(MAX_PREFERENCE_KEY_CHARS).optional(),
  /**
   * Caller-supplied, never inferred, stable key naming what this record is
   * "about" — the grouping mechanism contradictory-fact detection is built
   * on (contradictory facts retain provenance and conflict
   * status until resolved). Available to any kind at the schema level;
   * only `kind: "fact"` records are grouped/flagged by it today
   * (`MemoryService.resolveFactConflicts`). Immutable once set — like
   * `preferenceKey`, `correct` never changes it.
   */
  topicKey: z.string().min(1).max(MAX_TOPIC_KEY_CHARS).optional(),
  /** The approved revision currently in force, when the record is approved. */
  currentRevisionId: IdSchema.optional(),
  status: z.enum(MEMORY_STATUSES),
  sensitivity: z.enum(MEMORY_SENSITIVITY),
  /** Validity interval of the current revision; `validTo` absent means open. */
  validFrom: TimestampSchema.optional(),
  validTo: TimestampSchema.optional(),
  expiryAt: TimestampSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  confidenceBasis: z.string().max(200).optional(),
  supersedesRecordId: IdSchema.optional(),
  /** Incremented on forgetting; retrieval validates lineage against it. */
  revocationGeneration: z.number().int().nonnegative(),
  recordedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /**
   * A chat note: a `run_local` record kept for the
   * life of its chat, recalled only in it, and never swept with the run's
   * working memory. Absent on every other record.
   */
  durable: z.literal(true).optional(),
  /** The chat the record was written from, resolved to the chat a delegated task belongs to. */
  originTaskId: IdSchema.optional(),
  /**
   * Made from a chat that used or ran on a local connection: never recalled
   * into a chat on a remote model, nor embedded or tidied by one. Absent on
   * every other record.
   */
  localOrigin: z.literal(true).optional(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

/** How far ahead a model-set end date may reach. */
export const MEMORY_VALID_UNTIL_MAX_YEARS = 5;

/**
 * The most records one proposal may supersede: a consolidation's merge
 * names each input at the revision it read.
 */
export const MEMORY_SUPERSEDES_MAX = 20;

/** The kinds a model may propose: `summary` is the host's own. */
export const MEMORY_PROPOSABLE_KINDS = ["preference", "fact", "lesson"] as const;
export type MemoryProposableKind = (typeof MEMORY_PROPOSABLE_KINDS)[number];

/** Minutes `timeZone` is ahead of UTC at `instant`; UTC for a zone the platform does not know. */
function zoneOffsetMinutes(instant: number, timeZone: string): number {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
  } catch {
    return 0;
  }
  const parts = formatter.formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return Math.round((wall - Math.floor(instant / 60_000) * 60_000) / 60_000);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A model-facing `validUntil` as an instant:
 * an ISO date-time with its zone, or a date, which means *through* that day
 * — the instant the next day begins in `timeZone` (UTC when none is given), so
 * "until Friday" holds all of Friday where the person is. It must be in the
 * future and at most `MEMORY_VALID_UNTIL_MAX_YEARS` ahead of `now`: a fact
 * already over is written in the past tense and needs no end date.
 */
export function resolveMemoryValidUntil(
  validUntil: string,
  now: string,
  timeZone?: string,
): { readonly ok: true; readonly at: string } | { readonly ok: false; readonly reason: string } {
  const text = validUntil.trim();
  let at: number;
  const date = DATE_ONLY.exec(text);
  if (date !== null) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      return { ok: false, reason: `validUntil ${JSON.stringify(text)} is not a date` };
    }
    // The next day's local midnight: the wall time read as UTC, less the zone's offset there (asked twice, for a DST edge).
    const wall = Date.UTC(year, month - 1, day + 1);
    const zone = timeZone ?? "UTC";
    const guess = wall - zoneOffsetMinutes(wall, zone) * 60_000;
    at = wall - zoneOffsetMinutes(guess, zone) * 60_000;
  } else if (DATE_TIME.test(text)) {
    at = Date.parse(text);
  } else {
    return { ok: false, reason: `validUntil ${JSON.stringify(text)} must be a date (YYYY-MM-DD) or an ISO date-time with its zone` };
  }
  const from = Date.parse(now);
  if (Number.isNaN(at)) return { ok: false, reason: `validUntil ${JSON.stringify(text)} is not a date` };
  if (at <= from) return { ok: false, reason: "validUntil must be in the future: something already over needs no end date" };
  const latest = new Date(from);
  latest.setUTCFullYear(latest.getUTCFullYear() + MEMORY_VALID_UNTIL_MAX_YEARS);
  if (at > latest.getTime()) return { ok: false, reason: `validUntil must be at most ${MEMORY_VALID_UNTIL_MAX_YEARS} years ahead` };
  return { ok: true, at: new Date(at).toISOString() };
}

/**
 * Where an end date goes, by kind: a fact
 * *ends* (`validTo`: out of recall, kept as history, never swept once
 * approved); a preference or lesson *expires* (`expiryAt`: swept, then erased
 * `proposalDays` after the sweep marked it). A preference cannot use `validTo`:
 * the one-active-value index counts only rows without one.
 */
export function memoryEndDateField(kind: MemoryKind): "validTo" | "expiryAt" {
  return kind === "fact" ? "validTo" : "expiryAt";
}

/** An end date `at` as the field its kind keeps it in (`memoryEndDateField`). */
export function memoryEndDate(kind: MemoryKind, at: string): { readonly validTo: string } | { readonly expiryAt: string } {
  return memoryEndDateField(kind) === "validTo" ? { validTo: at } : { expiryAt: at };
}

/**
 * Whether a record is *past*: an approved record whose `validTo` or
 * `expiryAt` has passed (an ended fact, or an expiry the sweep has not marked
 * yet), or an expired record that had been approved. A lapsed proposal is not:
 * nothing nobody approved is kept as history.
 */
export function memoryRecordIsPast(
  record: Pick<MemoryRecord, "status" | "validTo" | "expiryAt" | "currentRevisionId">,
  now: string,
): boolean {
  if (record.status === "expired") return record.currentRevisionId !== undefined;
  if (record.status !== "approved") return false;
  return (record.validTo !== undefined && record.validTo <= now) || (record.expiryAt !== undefined && record.expiryAt <= now);
}

/**
 * Whether a record is one dedup and update detection look at:
 * a pending proposal or an approved record, either still in force at `now`. An ended
 * fact or an expired record is history, so the same words said again later
 * are a new record, never "already known" nor a *Replace* of the old one.
 */
export function memoryRecordIsLive(record: Pick<MemoryRecord, "status" | "validTo" | "expiryAt">, now: string): boolean {
  if (record.status !== "proposed" && record.status !== "approved") return false;
  // A proposal past its own end date is stale too: the sweep is about to expire it.
  return !((record.validTo !== undefined && record.validTo <= now) || (record.expiryAt !== undefined && record.expiryAt <= now));
}

/**
 * Text as dedup compares it: Unicode-normalised, case-folded
 * (all scripts, which SQLite's `lower` is not) and with runs of white space
 * folded to one. The content key hashes this, never the text itself.
 */
export function normaliseMemoryText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** The distinct words of `text` (letters and digits, case-folded), for the near-match measure. */
export function memoryTokenSet(text: string): ReadonlySet<string> {
  return new Set(
    normaliseMemoryText(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token !== ""),
  );
}

/** At or above this token-set Jaccard similarity, two bodies are a near match. */
export const MEMORY_NEAR_MATCH_JACCARD = 0.8;
/** At or above this cosine similarity of their vectors, a draft and a record in force are a near match under hybrid. */
export const MEMORY_NEAR_MATCH_COSINE = 0.92;
/**
 * Turn recall's relevance floor: a single-term match in a record's body is
 * kept when the term appears in under this share of the reader's active
 * records in scope.
 */
export const MEMORY_RELEVANCE_FLOOR_RARITY = 0.05;
/** Default cosine floor under hybrid recall when a model has no calibrated floor of its own. */
export const MEMORY_RELEVANCE_FLOOR_COSINE_DEFAULT = 0.3;
/** Per-embedding-model calibrated cosine floors for hybrid turn recall (`connection/model` or model id -> floor). */
export const MEMORY_RELEVANCE_FLOOR_COSINE_BY_MODEL: Readonly<Record<string, number>> = Object.freeze({});
/** The cosine relevance floor for `modelKey` under hybrid turn recall. */
export function memoryRelevanceCosineFloor(modelKey: string): number {
  return MEMORY_RELEVANCE_FLOOR_COSINE_BY_MODEL[modelKey] ?? MEMORY_RELEVANCE_FLOOR_COSINE_DEFAULT;
}
/** At or above this token-set Jaccard similarity with a higher-ranked hit, a turn-recall hit is dropped as a near-duplicate (MMR). */
export const MEMORY_MMR_JACCARD_THRESHOLD = 0.6;
/** At or above this pairwise vector cosine similarity with a higher-ranked hit under hybrid, a turn-recall hit is dropped as a near-duplicate (MMR). */
export const MEMORY_MMR_COSINE_THRESHOLD = 0.9;
/**
 * Auto-approve's kin: at or above this token-set
 * Jaccard similarity to one of the top lexical hits, a kept record of the
 * same kind and scope holds a proposal back — looser than the near match,
 * since a contradiction ("Lives in Berlin", "Lives in Lisbon") shares most
 * words but one.
 */
export const MEMORY_AUTO_APPROVE_KIN_JACCARD = 0.5;
/** The same by meaning under hybrid: at or above this cosine. */
export const MEMORY_AUTO_APPROVE_KIN_COSINE = 0.8;
/** The top hits, lexical and by meaning, auto-approve's kin reads. */
export const MEMORY_AUTO_APPROVE_KIN_HITS = 5;

/** Token-set Jaccard similarity of two texts, 0 to 1; two texts with no words are not similar. */
export function memoryTextSimilarity(left: string, right: string): number {
  const a = memoryTokenSet(left);
  const b = memoryTokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * What `propose` answers: the record filed, or one already there.
 * `known: "exact"` — the same normalised content is already proposed or
 * current, and nothing was written; `known: "near"` — asked for by automatic
 * capture (`nearMatch: "drop"`), a current record in the scope is a near
 * match, and nothing was written. Absent: a new proposal.
 */
export type MemoryProposeOutcome = MemoryRecord & { readonly known?: "exact" | "near" };

/** A typed preference value attached to a revision. */
export const PreferenceValueSchema = z.object({
  revisionId: IdSchema,
  key: z.string().min(1).max(MAX_PREFERENCE_KEY_CHARS),
  valueType: z.enum(PREFERENCE_VALUE_TYPES),
  value: z.unknown(),
});
export type PreferenceValue = z.infer<typeof PreferenceValueSchema>;

/**
 * Per-revision lifecycle, distinct from the record's `MemoryStatus`.
 *
 * A record carries one current validity interval, so closing the *previous*
 * revision's interval when a correction lands has to live on the revision
 * itself: `superseded` is what makes "when did v1 stop being valid" answerable.
 */
export const REVISION_STATUSES = ["active", "superseded", "revoked"] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

/** The refs a revision's provenance keeps, newest first. */
export const MEMORY_PROVENANCE_REFS_MAX = 8;

/**
 * Where a proposal's words may have come from:
 * the integrity, sources and newest refs of the label of the chat it was
 * proposed in, stamped by `memory.propose` on the revision it files.
 * Only an untrusted label is stamped: absent is a clean chat's, as before.
 * A tidy-up's is the join of its inputs'. It never leaves the host:
 * no provider's `MemorySnapshot` carries it. Display and review only — a
 * record the person kept is trusted when recalled.
 */
export const MemoryProvenanceSchema = z.strictObject({
  integrity: IntegritySchema,
  sources: z.array(SourceKindSchema).max(CONTENT_LABEL_LIMITS.maxSources),
  refs: z.array(LabelRefSchema).max(MEMORY_PROVENANCE_REFS_MAX),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

/** A stored provenance that cannot be read: untrusted, from an unknown source (fails safe). */
export function unreadableMemoryProvenance(): MemoryProvenance {
  return { integrity: "untrusted", sources: ["unknown-source"], refs: [] };
}

/** A provenance as a label (public, no principals): what a reader joins in when it reads stored words with this provenance. */
export function memoryProvenanceLabel(provenance: MemoryProvenance): ContentLabel {
  return {
    integrity: provenance.integrity,
    sources: [...provenance.sources],
    principals: [],
    confidentiality: "public",
    refs: [...provenance.refs],
  };
}

function provenanceFrom(label: ContentLabel): MemoryProvenance {
  const canonical = normalizeLabel(label);
  return { integrity: canonical.integrity, sources: canonical.sources, refs: canonical.refs.slice(0, MEMORY_PROVENANCE_REFS_MAX) };
}

/** What `memory.propose` stamps from its call's context label: the label's provenance when untrusted, else nothing. */
export function memoryProvenanceOf(label: ContentLabel | undefined): MemoryProvenance | undefined {
  if (label === undefined || label.integrity !== "untrusted") return undefined;
  return provenanceFrom(label);
}

/** The join of two provenances (the label join's: untrusted wins, sources and refs unioned, the newest 8 refs kept); absent is the identity. */
export function joinMemoryProvenance(a: MemoryProvenance | undefined, b: MemoryProvenance | undefined): MemoryProvenance | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return provenanceFrom(joinLabels(memoryProvenanceLabel(a), memoryProvenanceLabel(b)));
}

/** Whether a revision's provenance says its words may have come from untrusted content: such a proposal is never auto-approved or kept in bulk. */
export function memoryProvenanceUntrusted(provenance: MemoryProvenance | undefined): boolean {
  return provenance?.integrity === "untrusted";
}

/** The hosts a provenance line names before "and N more". */
const PROVENANCE_HOSTS_SHOWN = 3;

const listed = (parts: readonly string[], t: CanvasCoreT): string =>
  parts.length <= 1
    ? (parts[0] ?? "")
    : t("provenance.sources.last", { sources: parts.slice(0, -1).join(", "), last: parts[parts.length - 1] ?? "" });

/** Which sentence a provenance line is: a routine revision's, a tidy-up's, or a proposal's. */
function provenanceLineKey(options: { readonly tidyUp?: boolean; readonly routine?: boolean }) {
  if (options.routine === true) return "routine.provenance.changed" as const;
  if (options.tidyUp === true) return "memory.provenance.tidyUp" as const;
  return "memory.provenance.proposed" as const;
}

/**
 * What a review surface says of an untrusted provenance: "Proposed
 * after this chat read a web page (example.com, news.org)". What Tavi
 * established comes first — the kinds of source and the hosts it parsed —
 * and a page's own title only after, as "the page calls itself “…”",
 * clipped and stripped of anything that could break the line. `tidyUp`: a
 * tidy-up's line, of the memories it merges. `routine`: a routine
 * revision's line. Undefined for a trusted or absent provenance: there is
 * nothing to say.
 */
export function memoryProvenanceLine(
  provenance: MemoryProvenance | undefined,
  options: { readonly tidyUp?: boolean; readonly routine?: boolean } = {},
  t: CanvasCoreT = canvasCoreEnglish,
): string | undefined {
  if (provenance === undefined || provenance.integrity !== "untrusted") return undefined;
  // What a desktop tool read keeps the `web` source, but is said as an app's screen, naming the app (QA 1893).
  const screens = provenance.refs.filter((ref) => desktopAppOf(ref) !== undefined);
  const pages = provenance.refs.some((ref) => ref.source === "web" && desktopAppOf(ref) === undefined);
  const words = provenance.sources.flatMap((source) =>
    source !== "web" || screens.length === 0
      ? [sourceWords(source, t)]
      : pages
        ? [sourceWords("web", t), desktopSourceWords(t)]
        : [desktopSourceWords(t)],
  );
  const hosts = [
    ...new Set(
      provenance.refs
        .map((ref) => desktopAppOf(ref) ?? (ref.host === undefined ? "" : neutralizedText(ref.host, 80)))
        .filter((host) => host !== ""),
    ),
  ];
  const shownHosts = hosts.slice(0, PROVENANCE_HOSTS_SHOWN);
  const moreHosts = hosts.length - shownHosts.length;
  const hostList = shownHosts.join(", ");
  const where =
    shownHosts.length === 0
      ? ""
      : ` (${moreHosts > 0 ? t("provenance.sources.more", { sources: hostList, more: String(moreHosts) }) : hostList})`;
  const what = words.length === 0 ? sourceWords("unknown-source", t) : listed(words, t);
  const titled = provenance.refs.find((ref) => ref.title !== undefined && neutralizedText(ref.title, PROVENANCE_TITLE_CHARS) !== "");
  const title =
    titled?.title === undefined ? "" : ` — ${t("provenance.claim.page", { title: neutralizedText(titled.title, PROVENANCE_TITLE_CHARS) })}`;
  return t(provenanceLineKey(options), { what, where, title });
}

/** One immutable revision of a record; edits create a new revision. */
export const MemoryRevisionSchema = z.object({
  revisionId: IdSchema,
  recordId: IdSchema,
  revisionNumber: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  title: z.string().max(MAX_MEMORY_TITLE_CHARS).optional(),
  body: z
    .string()
    .optional()
    .refine((value) => value === undefined || new TextEncoder().encode(value).length <= MAX_MEMORY_BODY_BYTES, {
      message: `Memory body exceeds ${MAX_MEMORY_BODY_BYTES} UTF-8 bytes`,
    }),
  /** Authorized artifact reference for evidence larger than an inline body. */
  artifactId: IdSchema.optional(),
  contentHash: z.string().min(1).max(128),
  author: z.string().min(1).max(128),
  sourceIds: z.array(IdSchema).max(MAX_SOURCE_IDS),
  /** Effective/observed time, kept distinct from `recordedAt`. */
  observedAt: TimestampSchema.optional(),
  recordedAt: TimestampSchema,
  sensitivity: z.enum(MEMORY_SENSITIVITY),
  /** This revision's own lifecycle; `active` is the current one for its record. */
  status: z.enum(REVISION_STATUSES),
  supersededByRevisionId: IdSchema.optional(),
  /** This revision's own validity interval, distinct from the record's. */
  validFrom: TimestampSchema.optional(),
  validTo: TimestampSchema.optional(),
  /** The typed preference value this revision carries, when it is one. */
  preference: PreferenceValueSchema.optional(),
  /** Write-time search terms indexed in `keys`, never rendered as record text. */
  keywords: z.array(z.string().trim().min(1).max(MAX_MEMORY_KEYWORD_CHARS)).max(MAX_MEMORY_KEYWORDS).optional(),
  /** Where its words may have come from, when untrusted; never sent to a provider. */
  provenance: MemoryProvenanceSchema.optional(),
});
export type MemoryRevision = z.infer<typeof MemoryRevisionSchema>;

/** Where a piece of remembered content came from, and on what basis. */
export const EvidenceSourceSchema = z.object({
  sourceId: IdSchema,
  scopeKey: z.string().min(1).max(512),
  recordId: IdSchema.optional(),
  revisionId: IdSchema.optional(),
  conversationId: IdSchema.optional(),
  messageId: IdSchema.optional(),
  artifactId: IdSchema.optional(),
  operatorInput: z.boolean(),
  observedAt: TimestampSchema,
  contentHash: z.string().min(1).max(128),
  /** Consent/capture basis; never inferred from the fact that data exists. */
  captureBasis: z.string().min(1).max(64),
  retentionPolicy: z.string().min(1).max(64),
  revocationStatus: z.enum(["active", "revoked"]),
  accessRevokedAt: TimestampSchema.optional(),
  /** Claimed authorship stays distinct from verified identity. */
  claimedAuthor: z.string().max(200).optional(),
});
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

/** A review decision over one exact revision hash. */
export const MemoryReviewSchema = z.object({
  reviewId: IdSchema,
  recordId: IdSchema,
  revisionId: IdSchema,
  revisionHash: z.string().min(1).max(128),
  reviewerPrincipalId: IdSchema,
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(500).optional(),
  decidedAt: TimestampSchema,
});
export type MemoryReview = z.infer<typeof MemoryReviewSchema>;

/** Derivative freshness, tracked separately from lifecycle. */
export const DERIVED_FRESHNESS = ["clean", "dirty", "blocked"] as const;
export type DerivedFreshness = (typeof DERIVED_FRESHNESS)[number];

export const LINEAGE_DEPENDENCY_KINDS = ["contains", "requires", "background"] as const;
export type LineageDependencyKind = (typeof LINEAGE_DEPENDENCY_KINDS)[number];

export const LineageEdgeSchema = z.object({
  edgeId: IdSchema,
  fromRevisionId: IdSchema,
  toRevisionId: IdSchema,
  claimId: IdSchema.optional(),
  dependencyKind: z.enum(LINEAGE_DEPENDENCY_KINDS),
  derivedFreshness: z.enum(DERIVED_FRESHNESS),
  freshnessReason: z.string().max(500).optional(),
  /** Ids of the forgotten/revoked memory records whose content this edge's
   * `contains` dependency must exclude when the derived revision is rebuilt.
   * Not populated for `requires`/`background` edges. */
  affectedSourceIds: z.array(IdSchema).max(64),
  lastValidatedGeneration: z.number().int().nonnegative(),
});
export type LineageEdge = z.infer<typeof LineageEdgeSchema>;

/**
 * The deletion journal.
 *
 * It stores scope and generation so an older backup can be reconciled against the
 * current deletions, and deliberately carries **no body**: erasure history must
 * not resurrect what was erased.
 */
export const MemoryDeletionSchema = z.object({
  deletionId: IdSchema,
  recordId: IdSchema,
  scopeKey: z.string().min(1).max(512),
  deletionGeneration: z.number().int().positive(),
  requestedBy: IdSchema,
  reason: z.string().min(1).max(500),
  requestedAt: TimestampSchema,
  cleanupStatus: z.enum(["pending", "complete"]),
  cleanedAt: TimestampSchema.optional(),
  /**
   * The memory providers this record will be removed from when they next run:
   * ones that held it and could not take the removal now
   * (disabled, not started, failing). The row stays `pending` until each has.
   * Absent when every provider took it, or none held it.
   */
  pendingProviders: z.array(z.string().min(1).max(128)).max(16).optional(),
  /**
   * What the forget could not reach, said in sentences: the
   * chats that quoted or used it and the model requests kept for them
   * (`MEMORY_FORGET_UNREACHED`), and the channels whose earlier card messages
   * cannot be edited. Set by the `memory` command's receipt; absent
   * from the service's own.
   */
  unreached: z.array(z.string().min(1).max(300)).max(4).optional(),
});
export type MemoryDeletion = z.infer<typeof MemoryDeletionSchema>;

/**
 * What every forget's receipt says it cannot reach: a chat's own history
 * that quoted the record, and the model
 * requests kept for turns and heartbeat ticks whose prompt carried it.
 */
export const MEMORY_FORGET_UNREACHED = canvasCoreEnglish("memory.forget.unreached");

/**
 * What a forget's receipt says of the memory providers its removal waits for
 * (`pendingProviders`), on every surface that forgets: the CLI,
 * `/forget`, the Center, a card's *Undo* and a chat forgotten with its
 * memory. Undefined when it waits for none.
 */
export function memoryPendingProvidersNote(
  providers: readonly string[] | undefined,
  t: CanvasCoreT = canvasCoreEnglish,
): string | undefined {
  if (providers === undefined || providers.length === 0) return undefined;
  return t("memory.provider.pending", { count: providers.length, providers: providers.join(", ") });
}

/** The same note for a forgotten chat: what the chat taught is what the providers still hold. */
export function memoryTaughtPendingProvidersNote(
  providers: readonly string[] | undefined,
  t: CanvasCoreT = canvasCoreEnglish,
): string | undefined {
  if (providers === undefined || providers.length === 0) return undefined;
  return t("memory.provider.pendingTaught", { count: providers.length, providers: providers.join(", ") });
}

/** The deletion reason of a waiting tidy-up forgotten because a record it merges was forgotten. */
export const MEMORY_MERGE_INPUT_FORGOTTEN = "a record it merges was forgotten";

/**
 * The journal reason of a forget replayed at start: a record a
 * deletion journal row names that a restored backup brought back.
 */
export const MEMORY_RESTORE_RECONCILE_REASON = "reconciled after restore";

/** One search hit: a bounded snippet plus the citation it came from. */
export const MemorySearchHitSchema = z.object({
  recordId: IdSchema,
  revisionId: IdSchema,
  scope: MemoryScopeSchema,
  kind: z.enum(MEMORY_KINDS),
  title: z.string().max(MAX_MEMORY_TITLE_CHARS).optional(),
  snippet: z.string().max(MAX_SEARCH_SNIPPET_CHARS),
  observedAt: TimestampSchema.optional(),
  recordedAt: TimestampSchema,
  /** True when a newer approved revision exists than the one matched. */
  superseded: z.boolean(),
  conflict: z.boolean(),
  /**
   * With `conflict`: the other current records it conflicts with (the same
   * preference key at the same tier, or the same fact topic), so a prompt can
   * name them. Optional so an older owner's answer still parses.
   */
  conflictsWith: z.array(IdSchema).max(8).optional(),
  /**
   * Under hybrid recall, present on a hit that only the vector list found
   * (not the lexical index, nor exact preference/topic key matches): a loose
   * match by meaning rather than by words.
   */
  match: z.enum(["meaning"]).optional(),
});
export type MemorySearchHit = z.infer<typeof MemorySearchHitSchema>;

/** Retrieval coverage, so "no matches" is distinct from "the index failed". */
/** The most characters of the person's newest message hybrid recall embeds. */
export const MEMORY_SEMANTIC_QUERY_MAX_CHARS = 1_200;
/** Reciprocal-rank fusion's constant: a rank r adds 1 / (k + r). */
export const MEMORY_RRF_K = 60;

export const MEMORY_COVERAGE = ["complete", "partial", "unavailable"] as const;
export type MemoryCoverage = (typeof MEMORY_COVERAGE)[number];

export const MemorySearchResultSchema = z.object({
  hits: z.array(MemorySearchHitSchema),
  /**
   * `"complete"` means the index itself was queried successfully — it does
   * not mean every matching record is present in `hits`. A sensitive record
   * (unless `includeSensitive`) or a record citing a now-revoked evidence
   * source is silently excluded from `hits` while `coverage` still reports
   * `"complete"`, the same deliberate simplification in both cases: neither
   * is an index failure, so `"partial"`/`"unavailable"` would misrepresent
   * what actually happened. `"partial"` is hybrid recall's degraded answer:
   * the embedding call failed or timed out, or some
   * eligible record had no vector of the query's model, so those matched by
   * their words only. The `memory.search` tool also answers a search that
   * found nothing `"partial"`: the model reads `"complete"` as "looked
   * everywhere", which a miss on its own words does not show.
   */
  coverage: z.enum(MEMORY_COVERAGE),
  /** Present when coverage is reduced or when an `all` search fell back to partial matches (`match: "any"`). */
  reducedReason: z.string().max(300).optional(),
  /**
   * `any` when a multi-word `all` search found no record holding every word
   * and retried with `match: "any"`.
   */
  match: z.enum(["all", "any"]).optional(),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

/** The tokenizer pinned with the index schema version. */
export const MEMORY_FTS_TOKENIZER = "unicode61 remove_diacritics 2";
/** The porter-stemmed tokenizer for the companion stemmed FTS index. */
export const MEMORY_FTS_STEM_TOKENIZER = "porter unicode61 remove_diacritics 2";
export const MEMORY_FTS_SCHEMA_VERSION = 1;

/** Input options for `MemoryServicePort.search`. */
export interface MemorySearchQuery {
  readonly query: string;
  readonly scope?: MemoryScope;
  readonly limit?: number;
  readonly includeSensitive?: boolean;
  readonly excludeLocalOrigin?: boolean;
  readonly match?: "all" | "any";
  readonly semantic?: string;
  readonly queryVector?: { readonly modelKey: string; readonly vector: readonly number[]; readonly personal?: false };
  readonly purpose?: "turn" | "tool" | "heartbeat";
  readonly recallKey?: string;
  /**
   * Apply the turn-recall relevance floor and MMR near-duplicate drop: drops
   * weak single-term matches (unless the term is rare in the reader's active
   * records in scope, matches a key segment, or matches in the title) and
   * near-duplicate lower-ranked hits. Direct `memory.search` tool and operator
   * calls leave this off.
   */
  readonly applyFloor?: boolean;
  /** The recency and confirmation priors in ranking; on unless `false` (an internal switch, not a setting). */
  readonly rankingPriors?: boolean;
  /**
   * Record or revision ids (`recordId`, `revisionId`, or `memory:<revisionId>`)
   * that the chat's previous context blocks already showed; exempted from the
   * relevance floor.
   */
  readonly alreadyShownIds?: readonly string[];
  /**
   * When true, also return approved facts whose `validTo` has passed (marked
   * `(ended <YYYY-MM-DD>)`) and the latest superseded revision of replaced
   * facts (marked `(replaced <YYYY-MM-DD> by <title>)`). Never includes
   * expired preferences or lessons.
   */
  readonly includePast?: boolean;
  /**
   * Optional deterministic temporal range parsed from the query. Boosts hits
   * whose `observedAt` or validity interval overlaps `[from, to]` in RRF
   * without filtering out non-overlapping hits, and enables `includePast` when
   * `to` lies wholly in the past.
   */
  readonly range?: { readonly from: string; readonly to: string };
}
