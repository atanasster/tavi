import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";
import {
  MAX_MEMORY_BODY_BYTES,
  MAX_MEMORY_TITLE_CHARS,
  MAX_PREFERENCE_KEY_CHARS,
  MAX_SEARCH_SNIPPET_CHARS,
  MAX_TOPIC_KEY_CHARS,
  MEMORY_KINDS,
  MEMORY_SUPERSEDES_MAX,
  MEMORY_PROPOSAL_TTL_DAYS,
  MEMORY_SENSITIVITY,
  MEMORY_STATUSES,
  MemoryDeletionSchema,
  MemoryProvenanceSchema,
  MemoryRecordSchema,
  REVISION_STATUSES,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStatus,
} from "./memory.js";
import { MEMORY_PROVIDER_CAPABILITIES, MEMORY_PROVIDER_RECEIVES } from "./memory-provider.js";
import { MEMORY_EGRESS_FIELDS } from "./memory-settings.js";

/**
 * The `memory` owner command: the operator's view
 * of memory for the Command Center's Memory pane and `tavi memory` while an
 * owner runs.
 *
 * Every call acts as the workspace's operator (`authority: "operator"`), so an
 * edit is a revision the operator authored. What the operator sees is fixed by
 * `operatorSeesMemory`: their own personal scopes, the workspace's shared scope
 * and their agent scopes in it. Another person's personal memory is never
 * listed, only counted per person, and run-local memory is never shown.
 *
 * Answers carry ids and counts for evidence, never a source's payload.
 */

/**
 * A scope as the page and the CLI name it: `personal` (the operator's, in every
 * workspace), `workspace` (the operator's in this workspace), `shared` (the
 * workspace's shared scope), `agent:<agent id>` (the operator's memory for one
 * agent in this workspace) or `chat:<task id>` (one chat's notes, listed
 * only when named, never on the page
 * that lists every scope).
 */
export const MemoryScopeTargetSchema = z
  .string()
  .max(6 + 128)
  .regex(/^(?:personal|workspace|shared|agent:\S{1,128}|chat:\S{1,128})$/, {
    message: "expected personal, workspace, shared, agent:<agent id> or chat:<task id>",
  });
export type MemoryScopeTarget = z.infer<typeof MemoryScopeTargetSchema>;

/** Who the operator is, and where: what a target and the visibility rule resolve against. */
export interface MemoryOperator {
  readonly principalId: string;
  readonly workspaceId: string;
}

/** The concrete scope a target writes to. */
export function memoryScopeForTarget(target: MemoryScopeTarget, operator: MemoryOperator): MemoryScope {
  switch (target) {
    case "personal":
      return { kind: "personal", principalId: operator.principalId };
    case "workspace":
      return { kind: "personal_workspace", principalId: operator.principalId, workspaceId: operator.workspaceId };
    case "shared":
      return { kind: "shared_workspace", workspaceId: operator.workspaceId };
    default:
      if (target.startsWith("chat:")) {
        return {
          kind: "run_local",
          principalId: operator.principalId,
          workspaceId: operator.workspaceId,
          runId: target.slice("chat:".length),
        };
      }
      return {
        kind: "personal_agent",
        principalId: operator.principalId,
        agentId: target.slice("agent:".length),
        workspaceId: operator.workspaceId,
      };
  }
}

/** The target a stored scope is shown under: run-local memory is shown only as a chat's notes, `chat:<task id>`. */
export function memoryScopeTarget(scope: MemoryScope): MemoryScopeTarget | undefined {
  switch (scope.kind) {
    case "personal":
      return "personal";
    case "personal_workspace":
      return "workspace";
    case "shared_workspace":
      return "shared";
    case "personal_agent":
      return `agent:${scope.agentId}`;
    case "run_local":
      return `chat:${scope.runId}`;
  }
}

/**
 * Whether the operator reaches `record` as one chat's note when the chat is
 * named: a durable run-local record of the operator's in this workspace.
 * `operatorSeesMemory` still leaves every run-local record off the page that
 * lists every scope.
 */
export function operatorSeesChatNote(record: Pick<MemoryRecord, "scope" | "durable">, operator: MemoryOperator): boolean {
  return (
    record.durable === true &&
    record.scope.kind === "run_local" &&
    record.scope.principalId === operator.principalId &&
    record.scope.workspaceId === operator.workspaceId
  );
}

/**
 * Whether the operator's page shows a record in `scope`: the workspace's shared
 * scope, the operator's personal scopes in this workspace, and the operator's
 * personal scopes that name no workspace. Run-local memory is a task's own
 * scratch space. The runtime's SQL (`OPERATOR_MEMORY` in the memory
 * repository, `store.ts`) states the same rule; the two change together.
 */
export function operatorSeesMemory(scope: MemoryScope, operator: MemoryOperator): boolean {
  switch (scope.kind) {
    case "run_local":
      return false;
    case "shared_workspace":
      return scope.workspaceId === operator.workspaceId;
    case "personal":
      return scope.principalId === operator.principalId;
    case "personal_workspace":
      return scope.principalId === operator.principalId && scope.workspaceId === operator.workspaceId;
    case "personal_agent":
      return scope.principalId === operator.principalId && (scope.workspaceId === undefined || scope.workspaceId === operator.workspaceId);
  }
}

/** The statuses `list` shows unless asked otherwise: what is in force and what waits for review. */
export const MEMORY_IPC_DEFAULT_STATUSES = ["approved", "proposed"] as const satisfies readonly MemoryStatus[];
/** `deleted` is a tombstone: no call lists it. */
const ListableStatusSchema = z.enum(MEMORY_STATUSES).exclude(["deleted"]);

export const MEMORY_IPC_LIST_DEFAULT = 50;
/**
 * A page's bound. Smaller than the service's own (`MEMORY_LIST_PAGE_MAX`)
 * because each row carries a body preview, and the answer must fit one IPC
 * frame.
 */
export const MEMORY_IPC_LIST_MAX = 100;
/** A listed body is cut to this many characters; `get` returns the whole body. */
export const MEMORY_IPC_PREVIEW_CHARS = 500;
/** People counted in `otherPeople` (and in `otherProposals`), most records first. */
export const MEMORY_OTHER_PEOPLE_LIMIT = 50;
/** Revisions summarized by `get`, newest first. */
export const MEMORY_IPC_REVISIONS_MAX = 50;
/** The note an approval or rejection records. */
export const MEMORY_REVIEW_NOTE_MAX_CHARS = 500;

/** Opaque to a page: take it from `nextCursor`. Base64url, like the task list's cursor. */
export const MemoryListCursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * The list cursor names the next page's offset. Its codec lives here because
 * `tavi memory list --offset` sends the offset it was given as a cursor. Plain
 * characters rather than encoded JSON, so a page needs no `Buffer`.
 */
export function encodeMemoryListCursor(offset: number): string {
  return `o${offset.toString(36)}`;
}

/** The offset a cursor names, or `undefined` for one that is not this codec's. */
export function decodeMemoryListCursor(cursor: string): number | undefined {
  const match = /^o([0-9a-z]{1,10})$/.exec(cursor);
  if (match === null) return undefined;
  const offset = Number.parseInt(match[1] as string, 36);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

const BodySchema = z
  .string()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).length <= MAX_MEMORY_BODY_BYTES, {
    message: `a memory body is at most ${MAX_MEMORY_BODY_BYTES} UTF-8 bytes`,
  });
const TitleSchema = z.string().min(1).max(MAX_MEMORY_TITLE_CHARS);
const NoteSchema = z.string().min(1).max(MEMORY_REVIEW_NOTE_MAX_CHARS);
/** A preference value as the operator types it; stored as a string. */
const PreferenceValueTextSchema = z.string().min(1).max(MAX_MEMORY_BODY_BYTES);

export const MemoryPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("list"),
    workspaceId: IdSchema.optional(),
    kinds: z.array(z.enum(MEMORY_KINDS)).min(1).max(MEMORY_KINDS.length).optional(),
    /** Absent: `MEMORY_IPC_DEFAULT_STATUSES`. */
    statuses: z.array(ListableStatusSchema).min(1).max(MEMORY_STATUSES.length).optional(),
    /** Absent: every scope the operator sees. A `chat:<task id>` scope is listed only when named. */
    scopes: z.array(MemoryScopeTargetSchema).min(1).max(32).optional(),
    /** Only records written from this chat: what it taught. */
    originTaskId: IdSchema.optional(),
    /**
     * The records this chat's turns were given, most recently used first,
     * in place of a listing: one page, no cursor; the other filters apply.
     */
    usedInTaskId: IdSchema.optional(),
    /**
     * The records one answer used (the canvas's "Used N memories"), in the order it used
     * them, read from its saved turn's `memoryUsed`, in place of a listing; the other filters apply. Absent
     * `seq`, the chat's newest turn.
     */
    usedInTurn: z.strictObject({ taskId: IdSchema, seq: z.number().int().positive().optional() }).optional(),
    /** Every chat's notes instead of the scopes: the Command Center's list across chats (each names its chat as `chat:<task id>`). */
    chatNotes: z.literal(true).optional(),
    /**
     * *Past* records in place of `statuses` (`memoryRecordIsPast`):
     * ended facts, kept, and expired preferences and lessons, erased
     * `proposalDays` after the sweep marked them (`erasesAt`).
     */
    past: z.literal(true).optional(),
    /**
     * Full-text search instead of a listing: one page of the best matches
     * among approved, current records, with a snippet each. Takes no cursor.
     */
    query: z.string().trim().min(1).max(512).optional(),
    cursor: MemoryListCursorSchema.optional(),
    /** Absent: `MEMORY_IPC_LIST_DEFAULT`. */
    limit: z.number().int().min(1).max(MEMORY_IPC_LIST_MAX).optional(),
  }),
  z.strictObject({
    action: z.literal("get"),
    workspaceId: IdSchema.optional(),
    recordId: IdSchema,
    /** Return a sensitive record's title and body instead of `null`. */
    reveal: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("remember"),
    workspaceId: IdSchema.optional(),
    kind: z.enum(MEMORY_KINDS),
    /** Where the record goes. `shared` is refused: the shared scope is published by an explicit share. */
    scope: MemoryScopeTargetSchema,
    title: TitleSchema.optional(),
    body: BodySchema,
    /** Absent: `normal`. */
    sensitivity: z.enum(MEMORY_SENSITIVITY).optional(),
    /** A preference's key; required for `kind: "preference"` and refused for the others. */
    preferenceKey: z.string().min(1).max(MAX_PREFERENCE_KEY_CHARS).optional(),
    preferenceValue: PreferenceValueTextSchema.optional(),
    /** What the record is about; facts sharing one are flagged as contradicting. */
    topicKey: z.string().min(1).max(MAX_TOPIC_KEY_CHARS).optional(),
    reason: NoteSchema.optional(),
    /** The chat it is remembered from. A `chat:<task id>` scope implies its own task. */
    originTaskId: IdSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("correct"),
    workspaceId: IdSchema.optional(),
    recordId: IdSchema,
    /** The revision the edit was made against; a newer one is `REVISION_CONFLICT`. */
    expectedRevisionId: IdSchema.optional(),
    title: TitleSchema.optional(),
    body: BodySchema.optional(),
    preferenceValue: PreferenceValueTextSchema.optional(),
    /**
     * *Keep longer*: the record's new end date — a date (through that
     * day in the workspace's zone) or a date-time, in the future — or `null`
     * to keep it with no end. It moves the date the record has (a fact's
     * `validTo`, a preference's or lesson's `expiryAt`), else the one its kind
     * takes; an expired record returns to approved.
     */
    until: z.string().min(1).max(64).nullable().optional(),
    reason: NoteSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("approve"),
    workspaceId: IdSchema.optional(),
    recordId: IdSchema,
    expectedRevisionId: IdSchema.optional(),
    note: NoteSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("reject"),
    workspaceId: IdSchema.optional(),
    recordId: IdSchema,
    expectedRevisionId: IdSchema.optional(),
    note: NoteSchema.optional(),
  }),
  z.strictObject({
    /**
     * *Replace*: apply an update proposal to the record in force
     * it updates, as a correction held to that record's revision
     * (`targetRevisionId`, `REVISION_CONFLICT` when it moved), then discard the
     * proposal with the note "applied as a correction". The answer is the
     * corrected record.
     */
    action: z.literal("replace"),
    workspaceId: IdSchema.optional(),
    recordId: IdSchema,
    /** The proposal's revision the person saw. */
    expectedRevisionId: IdSchema.optional(),
    /** The replaced record's revision the person saw. */
    targetRevisionId: IdSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("forget"),
    workspaceId: IdSchema.optional(),
    recordId: IdSchema,
    /** Recorded in the content-free deletion journal. Absent: "forgotten by the operator". */
    reason: NoteSchema.optional(),
  }),
  z.strictObject({ action: z.literal("usage"), workspaceId: IdSchema.optional() }),
  z.strictObject({
    /**
     * A memory card, rendered now from the canonical rows: a
     * `memory` notice of a chat in this workspace. Records the operator does
     * not see are `hidden`, with no text; a forgotten one is `forgotten`.
     */
    action: z.literal("card"),
    workspaceId: IdSchema.optional(),
    noticeId: IdSchema,
  }),
  z.strictObject({
    /**
     * A card's *Keep all* or *Discard all* in the app (the one *Keep all*
     * rule): every waiting record on the card the operator decides. *Keep
     * all* keeps plain proposals only and posts a *Saved · N* receipt card;
     * *Discard all* has no exclusions.
     */
    action: z.literal("card-all"),
    workspaceId: IdSchema.optional(),
    noticeId: IdSchema,
    decision: z.enum(["keep", "discard"]),
  }),
  z.strictObject({
    /**
     * The Center's bulk *Keep* / *Discard* over the
     * proposals it lists, named by id: under the one *Keep all* rule, *keep*
     * keeps the plain ones only — a sensitive proposal, an update, a tidy-up
     * or one another kept value took the key of stays waiting and is counted
     * in `needsLook` — and answers the ids it kept, so the page's *Saved · N*
     * receipt can undo exactly those. *Discard* has no exclusions. A record
     * that no longer waits, or that the operator does not see, is passed over.
     */
    action: z.literal("decide-all"),
    workspaceId: IdSchema.optional(),
    recordIds: z.array(IdSchema).min(1).max(MEMORY_IPC_LIST_MAX),
    decision: z.enum(["keep", "discard"]),
  }),
  z.strictObject({
    /**
     * Move an approved record to another scope: remember it there, with
     * the chat it came from, then forget it here. A chat note becomes memory
     * for every chat, or the other way round.
     */
    action: z.literal("move"),
    workspaceId: IdSchema.optional(),
    recordId: IdSchema,
    to: MemoryScopeTargetSchema,
    expectedRevisionId: IdSchema.optional(),
    reason: NoteSchema.optional(),
  }),
  z.strictObject({
    /**
     * What an answer of a chat used (`/why`, `tavi memory why`): the
     * records its saved turn's `memoryUsed` names, as they are
     * now. Absent `seq`, the chat's newest turn.
     */
    action: z.literal("why"),
    workspaceId: IdSchema.optional(),
    taskId: IdSchema,
    seq: z.number().int().positive().optional(),
  }),
  z.strictObject({
    /** The workspace's memory provider: selected, serving, its egress and every provider installed here. */
    action: z.literal("provider"),
    workspaceId: IdSchema.optional(),
  }),
  z.strictObject({
    /**
     * Select the workspace's memory provider (`tavi memory set-provider`):
     * an installed one's id, or `builtin`. Its egress starts off.
     * Choosing an external provider needs its disclosure accepted
     * (`confirmed`), else `APPROVAL_REQUIRED` naming it.
     */
    action: z.literal("set-provider"),
    workspaceId: IdSchema.optional(),
    providerId: z.string().min(1).max(128),
    /** The workspace settings' revision the person read; absent, the one just read. */
    expectedRevision: z.number().int().nonnegative().optional(),
    confirmed: z.literal(true).optional(),
  }),
  z.strictObject({
    /**
     * One egress switch of the workspace's provider (`tavi memory egress`).
     * Turning one on needs its disclosure accepted (`confirmed`);
     * `personal` is refused while `records` is off.
     */
    action: z.literal("egress"),
    workspaceId: IdSchema.optional(),
    field: z.enum(MEMORY_EGRESS_FIELDS),
    on: z.boolean(),
    expectedRevision: z.number().int().nonnegative().optional(),
    confirmed: z.literal(true).optional(),
  }),
  z.strictObject({
    /**
     * One pass of hybrid recall's vector backfill now (`tavi memory reindex`,
     * an operator convenience): what the minute's allowance lets it embed,
     * then the workspace's counts. The CLI repeats it until nothing is left.
     */
    action: z.literal("reindex"),
    workspaceId: IdSchema.optional(),
  }),
  z.strictObject({
    /** The idle review now (`tavi memory review-now`): every eligible chat, or the one named, without the idle wait. */
    action: z.literal("review-now"),
    workspaceId: IdSchema.optional(),
    taskId: IdSchema.optional(),
  }),
  z.strictObject({
    /** Consolidation now (`tavi memory consolidate-now`): each person, or the one named, without the weekly schedule. */
    action: z.literal("consolidate-now"),
    workspaceId: IdSchema.optional(),
    principalId: IdSchema.optional(),
  }),
]);
export type MemoryPayload = z.infer<typeof MemoryPayloadSchema>;
export type MemoryIpcAction = MemoryPayload["action"];

/**
 * One record as the operator's page shows it: the record, where it lives, and
 * its current title and body. A sensitive record's title and body are `null`,
 * and its `topicKey`, `preferenceKey` and `confidenceBasis` absent, with
 * `redacted: true` unless the call revealed it; a listed body is at most
 * `MEMORY_IPC_PREVIEW_CHARS` long, with `truncated: true` when cut.
 */
/**
 * Another record a proposal is related to, named for the person:
 * its id, its title as a card shows it (`null` when it has none to show, or is
 * sensitive), and, for the record an update would replace, the revision a
 * *Replace* is held to.
 */
export const MemoryRelatedSchema = z.strictObject({
  recordId: IdSchema,
  title: z.string().max(MAX_MEMORY_TITLE_CHARS).nullable(),
  currentRevisionId: IdSchema.optional(),
});
export type MemoryRelated = z.infer<typeof MemoryRelatedSchema>;

/** The "before" of a tidy-up: one shown excerpt of a superseded input, at most. */
export const MEMORY_SUPERSEDED_EXCERPT_CHARS = 300;

/**
 * A record a tidy-up proposal supersedes, as the Center shows
 * its "before": the input at the revision the proposal was drafted from, its
 * title and excerpt there (`null` when it has none to show, is sensitive, or
 * was forgotten since), and `stale` once it is no longer approved at that
 * revision — approving the tidy-up then fails, and it is run again.
 */
export const MemorySupersededSchema = z.strictObject({
  recordId: IdSchema,
  revisionId: IdSchema,
  title: z.string().max(MAX_MEMORY_TITLE_CHARS).nullable(),
  excerpt: z.string().max(MEMORY_SUPERSEDED_EXCERPT_CHARS).nullable(),
  stale: z.boolean(),
});
export type MemorySuperseded = z.infer<typeof MemorySupersededSchema>;

export const MemoryItemSchema = MemoryRecordSchema.extend({
  target: MemoryScopeTargetSchema,
  title: z.string().max(MAX_MEMORY_TITLE_CHARS).nullable(),
  body: z.string().nullable(),
  redacted: z.boolean(),
  truncated: z.boolean(),
  /** A proposal only: when it expires unreviewed (`MEMORY_PROPOSAL_TTL_DAYS` after it was proposed). */
  expiresAt: TimestampSchema.optional(),
  /** An expired record that had been approved: when the sweep erases it, `proposalDays` after it marked it. */
  erasesAt: TimestampSchema.optional(),
  /** A search hit only: the matched text; absent for a redacted record. */
  snippet: z.string().max(MAX_SEARCH_SNIPPET_CHARS).optional(),
  /** Evidence the current revision cites, as a count: sources are never sent. */
  sourceCount: z.number().int().nonnegative(),
  /** A chat's use only (`usedInTaskId`): when the chat's turns were last given it. */
  usedAt: TimestampSchema.optional(),
  /**
   * A proposal that is an **update**: the record in force that
   * holds its preference key, or its fact's topic key. It is decided by
   * *Replace* (or, a fact, *Keep both*), never by a bulk keep.
   */
  updates: MemoryRelatedSchema.optional(),
  /** A proposed fact akin to a kept fact in its scope: decided by *Replace* or *Keep both*, never by *Keep all*. */
  mayUpdate: MemoryRelatedSchema.optional(),
  /** A proposal whose body is a near match of a record in force in its scope: that record. */
  similarTo: MemoryRelatedSchema.optional(),
  /**
   * A tidy-up: the records it replaces, each with its "before".
   * Like an update it is decided one at a time, never by a bulk keep.
   */
  supersedes: z.array(MemorySupersededSchema).max(MEMORY_SUPERSEDES_MAX).optional(),
  /**
   * Where the shown revision's words may have come from, when untrusted: a
   * proposal made after the chat read a
   * page, or a tidy-up of one. It "needs a look": never kept by *Keep all*.
   * Kept on an approved record, for `tavi memory show`.
   */
  provenance: MemoryProvenanceSchema.optional(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

/**
 * What one answer's `memoryUsed` said beyond the records an answer lists:
 * `recorded: false` for a turn saved before answers recorded it; how many records it used
 * (`used`, those past the 20 named included), how many of the named are gone or not the
 * reader's now (`forgotten`), how many of the rest a listing's filters left out (`hidden`,
 * `usedInTurn` only), and how many preferences applied. `listed` says the same of what
 * `memory.list` showed the answer and it did not otherwise use; absent when there is none.
 */
export const MemoryUsedSummarySchema = z.strictObject({
  recorded: z.boolean(),
  used: z.number().int().nonnegative(),
  forgotten: z.number().int().nonnegative(),
  hidden: z.number().int().nonnegative().optional(),
  preferences: z.number().int().nonnegative(),
  listed: z
    .strictObject({
      count: z.number().int().positive(),
      forgotten: z.number().int().nonnegative(),
      hidden: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type MemoryUsedSummary = z.infer<typeof MemoryUsedSummarySchema>;

export const MemoryListAnswerSchema = z.strictObject({
  records: z.array(MemoryItemSchema).max(MEMORY_IPC_LIST_MAX),
  /** The next page, sent back with the same filters; absent on the last page and for a search. */
  nextCursor: MemoryListCursorSchema.optional(),
  /**
   * Other people's personal records that match the kinds and statuses asked
   * for, as a count per person: their memory is theirs, so it is never listed.
   */
  otherPeople: z.array(z.strictObject({ principalId: IdSchema, count: z.number().int().positive() })).max(MEMORY_OTHER_PEOPLE_LIMIT),
  /**
   * Other people's proposals nobody reviewed yet, of the kinds asked for, as a
   * count per person whatever statuses were asked for: counted, never listed,
   * so the page can say they wait. Optional so an older owner's answer still parses.
   */
  otherProposals: z
    .array(z.strictObject({ principalId: IdSchema, count: z.number().int().positive() }))
    .max(MEMORY_OTHER_PEOPLE_LIMIT)
    .optional(),
  /** A search only: `unavailable` when the index could not be read, distinct from no matches. */
  coverage: z.enum(["complete", "unavailable"]).optional(),
  /**
   * A search only: `all` when each record holds every word, `any`
   * when none did and the search ran again for records holding some of them —
   * partial matches, which the page and the CLI label as such.
   */
  match: z.enum(["all", "any"]).optional(),
  /** `usedInTurn` only: what `memory.list` showed the turn, apart from the `records` it used. */
  listed: z.array(MemoryItemSchema).max(MEMORY_IPC_LIST_MAX).optional(),
  /** `usedInTurn` only: what the turn recorded beyond the records listed (`MemoryUsedSummarySchema`). */
  used: MemoryUsedSummarySchema.optional(),
});
export type MemoryListAnswer = z.infer<typeof MemoryListAnswerSchema>;

/** What a search answered with partial matches says above them (`MemoryListAnswer.match: "any"`). */
export const MEMORY_PARTIAL_MATCHES = "No exact match; showing partial matches";

/** One revision in `get`'s history: who wrote it and when, never its body. */
export const MemoryRevisionSummarySchema = z.strictObject({
  revisionId: IdSchema,
  revisionNumber: z.number().int().positive(),
  status: z.enum(REVISION_STATUSES),
  author: z.string().min(1).max(128),
  recordedAt: TimestampSchema,
  validFrom: TimestampSchema.optional(),
  validTo: TimestampSchema.optional(),
  sourceCount: z.number().int().nonnegative(),
});
export type MemoryRevisionSummary = z.infer<typeof MemoryRevisionSummarySchema>;

export const MemoryGetAnswerSchema = z.strictObject({
  record: MemoryItemSchema,
  /** Newest first, at most `MEMORY_IPC_REVISIONS_MAX`. */
  revisions: z.array(MemoryRevisionSummarySchema).max(MEMORY_IPC_REVISIONS_MAX),
  revisionCount: z.number().int().nonnegative(),
  /** Approvals and rejections, newest first. */
  reviews: z
    .array(
      z.strictObject({
        decision: z.enum(["approved", "rejected"]),
        reviewerPrincipalId: IdSchema,
        decidedAt: TimestampSchema,
        revisionId: IdSchema,
        reason: z.string().max(500).optional(),
      }),
    )
    .max(MEMORY_IPC_REVISIONS_MAX),
});
export type MemoryGetAnswer = z.infer<typeof MemoryGetAnswerSchema>;

/** Stored records and body bytes in the scopes the operator sees. */
export const MemoryUsageAnswerSchema = z.strictObject({
  records: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /**
   * The operator's own quota, as the memory service applies it to a record
   * the operator writes: the records and bytes charged to it (the operator's
   * personal scopes, which is less than everything counted above) and its
   * limits. Optional so an older owner's answer still parses.
   */
  quota: z
    .strictObject({
      records: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      maxRecords: z.number().int().positive(),
      maxBytes: z.number().int().positive(),
    })
    .optional(),
});
export type MemoryUsageAnswer = z.infer<typeof MemoryUsageAnswerSchema>;

/** `decide-all`: what the Center's bulk *Keep* or *Discard* came to — the ids kept, how many discarded, and how many need a look. */
export const MemoryDecideAllAnswerSchema = z.strictObject({
  kept: z.array(IdSchema).max(MEMORY_IPC_LIST_MAX),
  discarded: z.number().int().nonnegative(),
  needsLook: z.number().int().nonnegative(),
});
export type MemoryDecideAllAnswer = z.infer<typeof MemoryDecideAllAnswerSchema>;

/**
 * `why`: the turn asked about and the records its answer used, as far as the
 * person sees them now (a record forgotten since is left out). The records come
 * from the saved turn's `memoryUsed`, `listed` holds those it only looked
 * through with `memory.list`; `used` summarizes the rest. No `seq` when the
 * chat has no turn yet.
 */
export const MemoryWhyAnswerSchema = z.strictObject({
  taskId: IdSchema,
  seq: z.number().int().positive().optional(),
  answeredAt: TimestampSchema.optional(),
  records: z.array(MemoryItemSchema).max(MEMORY_IPC_LIST_MAX),
  listed: z.array(MemoryItemSchema).max(MEMORY_IPC_LIST_MAX).optional(),
  /** Absent from an older owner. */
  used: MemoryUsedSummarySchema.optional(),
});
export type MemoryWhyAnswer = z.infer<typeof MemoryWhyAnswerSchema>;

/** One memory provider installed here, as `provider` describes it. */
export const MemoryProviderInfoSchema = z.strictObject({
  id: z.string().min(1).max(128),
  kind: z.enum(["builtin", "plugin"]),
  index: z.enum(["own", "host"]),
  capabilities: z.array(z.enum(MEMORY_PROVIDER_CAPABILITIES)).max(MEMORY_PROVIDER_CAPABILITIES.length),
  receives: z.array(z.enum(MEMORY_PROVIDER_RECEIVES)).max(MEMORY_PROVIDER_RECEIVES.length),
  /** What choosing it means (`describeMemoryDeclaration`); absent for the built-in, which sends nothing anywhere. */
  disclosure: z.string().max(2_000).optional(),
  ready: z.boolean().optional(),
  indexed: z.number().int().nonnegative().optional(),
});
export type MemoryProviderInfo = z.infer<typeof MemoryProviderInfoSchema>;

/** `provider`, `set-provider` and `egress` answer the workspace's provider as it now is. */
export const MemoryProviderAnswerSchema = z.strictObject({
  workspaceId: IdSchema,
  /** The workspace settings' revision, for the next change's compare-and-set. */
  revision: z.number().int().nonnegative(),
  /** The provider the workspace selected. */
  selected: z.string().min(1).max(128),
  /**
   * The provider that serves it now: the selected one, or the built-in while that one is unavailable; `none` while
   * none is installed (the built-in disabled, none chosen), when recall is the host's own search.
   */
  serving: z.string().min(1).max(128),
  /** Why the selected provider does not serve (the fallback's notice), when it does not. */
  fallback: z.string().max(500).optional(),
  egress: z.strictObject({ records: z.boolean(), conversation: z.boolean(), includePersonal: z.boolean() }),
  /** The personal-memory disclosure (`memoryPersonalDisclosure`) for the selected provider. */
  personalDisclosure: z.string().max(1_000),
  providers: z.array(MemoryProviderInfoSchema).max(64),
  /** Forgotten records still to be removed from a provider that could not take the removal yet. */
  pendingRemovals: z.number().int().nonnegative(),
  /** Said once by a change: e.g. that the old provider's own index is the plugin's to clear. */
  note: z.string().max(500).optional(),
});
export type MemoryProviderAnswer = z.infer<typeof MemoryProviderAnswerSchema>;

/** `reindex`'s answer: one backfill pass, and the workspace's vectors after it. */
export const MemoryReindexAnswerSchema = z.strictObject({
  workspaceId: IdSchema,
  retrieval: z.enum(["lexical", "hybrid"]),
  /** The bound embedding model (`<connection>/<model>`), or null with none bound. */
  model: z.string().max(512).nullable(),
  /** This pass: texts embedded, texts whose call failed. */
  embedded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** The minute's allowance (600 texts) ran out with texts due: try again in `retryInMs`. */
  limited: z.boolean(),
  retryInMs: z.number().int().nonnegative().optional(),
  /** A failed embedding call holds the backfill back on this model for an hour. */
  backingOff: z.boolean(),
  /** Why nothing can be embedded here, when nothing can (paused, no model, a remote disclosure not accepted). */
  blocked: z.string().max(300).optional(),
  indexed: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  failedTotal: z.number().int().nonnegative(),
});
export type MemoryReindexAnswer = z.infer<typeof MemoryReindexAnswerSchema>;

/** `review-now`'s answer: each chat looked at, and what it filed. */
export const MemoryReviewNowAnswerSchema = z.strictObject({
  workspaceId: IdSchema,
  /** False while memory is paused or capture is off: no chat is reviewed. */
  capturing: z.boolean(),
  chats: z
    .array(
      z.strictObject({
        taskId: IdSchema,
        outcome: z.enum(["reviewed", "not-due", "waiting", "capped", "no-model", "capture-off", "failed", "not-eligible"]),
        filed: z.array(IdSchema).max(64),
        reason: z.string().max(300).optional(),
      }),
    )
    .max(1000),
});
export type MemoryReviewNowAnswer = z.infer<typeof MemoryReviewNowAnswerSchema>;

/** `consolidate-now`'s answer: `consolidation` off (nothing ran), or each person's run and the tidy-ups it filed. */
export const MemoryConsolidateNowAnswerSchema = z.strictObject({
  workspaceId: IdSchema,
  consolidation: z.enum(["off", "weekly"]),
  /** False while memory is paused: nothing runs. */
  enabled: z.boolean(),
  people: z
    .array(
      z.strictObject({
        principalId: IdSchema,
        outcome: z.enum(["ran", "nothing", "no-chat", "already", "failed"]),
        filed: z.array(IdSchema).max(64),
        drafts: z.number().int().nonnegative(),
        reason: z.string().max(300).optional(),
      }),
    )
    .max(1000),
});
export type MemoryConsolidateNowAnswer = z.infer<typeof MemoryConsolidateNowAnswerSchema>;

/** `forget` answers the content-free deletion receipt. */
export const MemoryForgetAnswerSchema = MemoryDeletionSchema;
export type MemoryForgetAnswer = z.infer<typeof MemoryForgetAnswerSchema>;

/** `remember`, `correct`, `approve` and `reject` answer the record as it now is. */
export type MemoryWriteAnswer = MemoryItem;

/**
 * When a proposal proposed at `recordedAt` expires unreviewed, `days` after it
 * (the workspace's `memory.limits.proposalDays`); its own earlier
 * expiry or end date wins (a fact "until Friday" left undecided past
 * Friday lapses, never kept into *Past*).
 */
export function memoryProposalExpiresAt(
  record: Pick<MemoryRecord, "recordedAt" | "expiryAt" | "validTo">,
  days: number = MEMORY_PROPOSAL_TTL_DAYS,
): string {
  const ttl = new Date(Date.parse(record.recordedAt) + days * 86_400_000).toISOString();
  return [record.expiryAt, record.validTo].reduce<string>(
    (earliest, date) => (date !== undefined && date < earliest ? date : earliest),
    ttl,
  );
}

/** When the sweep erases an expired record that had been approved: `days` after it marked it (its `updatedAt`). */
export function memoryErasesAt(record: Pick<MemoryRecord, "updatedAt">, days: number = MEMORY_PROPOSAL_TTL_DAYS): string {
  return new Date(Date.parse(record.updatedAt) + days * 86_400_000).toISOString();
}

/**
 * The memory service's `operatorView`, validated as this: the scopes
 * the operator sees that hold any record, and the per-person counts of other
 * people's personal records.
 */
export const MemoryViewInputSchema = z.strictObject({
  workspaceId: IdSchema,
  principalId: IdSchema,
  kinds: z.array(z.enum(MEMORY_KINDS)).max(MEMORY_KINDS.length).optional(),
  statuses: z.array(ListableStatusSchema).max(MEMORY_STATUSES.length).optional(),
});
export type MemoryViewInput = z.infer<typeof MemoryViewInputSchema>;

/** The memory service's `principals`, validated as this: every person with personal memory in the given statuses. */
export const MemoryPrincipalsInputSchema = z.strictObject({
  workspaceId: IdSchema,
  statuses: z.array(ListableStatusSchema).min(1).max(MEMORY_STATUSES.length),
});
export type MemoryPrincipalsInput = z.infer<typeof MemoryPrincipalsInputSchema>;

export interface MemoryView {
  /** Every scope the operator sees that holds a record, whatever its status. */
  readonly scopes: readonly { readonly scopeKey: string; readonly target: MemoryScopeTarget }[];
  readonly otherPeople: MemoryListAnswer["otherPeople"];
  readonly otherProposals: NonNullable<MemoryListAnswer["otherProposals"]>;
}
