import { createHash } from "node:crypto";

import { z } from "zod";

import {
  MAX_MEMORY_BODY_BYTES,
  MAX_MEMORY_KEYWORDS,
  MAX_MEMORY_KEYWORD_CHARS,
  MAX_MEMORY_TITLE_CHARS,
  MAX_PREFERENCE_KEY_CHARS,
  MAX_TOPIC_KEY_CHARS,
  MEMORY_FORGET_UNREACHED,
  MEMORY_PROPOSABLE_KINDS,
  MEMORY_SEARCH_MAX,
  TOOL_LABEL_KEY,
  TaviError,
  UNTRUSTED_UNKNOWN_SOURCE,
  memoryCardTitleOf,
  memoryEndDate,
  memoryProvenanceOf,
  resolveMemoryValidUntil,
  type CallAssessment,
  type InvocationContext,
  type MemoryActor,
  type MemoryRecord,
  type MemoryServicePort,
  type ToolResultLabel,
} from "@tavi/contracts";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import { holdsSecret, sensitiveTopicOf } from "@tavi/agent-host/workflow";
import type { ToolRegistry } from "@tavi/runtime";

import { memoryUnreachedNote } from "./channel-cards.js";

/**
 * The governed agent tool surface for personal memory: a model
 * can suggest facts/preferences/lessons but cannot approve its own proposals.
 *
 * `memory.search`, `memory.get` and `memory.propose` run with the model's own
 * authority. `memory.forget` is the one change a model may ask for: every
 * call is shown to the person on a card of its own (`attendedOnly`,
 * `onceOnly` — no grant, allow rule or unattended run answers it), and the
 * handler acts with `authority: "operator"` only when that call's own
 * approval was the operator's click (`ToolHandler.approvedBy`), never a bound
 * channel member's, a schedule's policy or a blanket approve. Correcting stays
 * the person's own: a model proposes the new words with `updates`, and the
 * card's *Replace* applies them.
 */

export const memoryActorFrom = (context: InvocationContext): MemoryActor => ({
  principalId: context.principalId,
  workspaceId: context.workspaceId,
  runId: context.runId,
  caller: context.caller,
  // A model-invoked tool call is never operator authority — that is the
  // whole point of the propose/approve split this surface exists to keep.
  authority: "model",
  // A spawned worker's model can call `memory.search`/`memory.get` directly
  // instead of relying on `buildSystemPromptText`'s automatic retrieval
  // (`packages/agent-host/src/workflow/prompt.ts`) — both read the SAME checkpointed
  // `InvocationContext`, so both must thread its restriction the same way,
  // or a worker's model bypasses the whole restriction simply by calling
  // this tool instead of waiting for automatic injection —
  // `buildSystemPromptText` is NOT the sole `MemoryActor` construction
  // site).
  ...definedOnly({
    scopeRestricted: context.memoryScopeRestricted,
    allowedRecordIds: context.delegatedMemoryRecordIds,
    chatTaskId: context.chatTaskId,
  }),
  // A side chat reads its parent's notes, as its automatic context does.
  ...(context.parentChatId === undefined ? {} : { parentChatId: context.parentChatId }),
  // The chat's persona's own memory, as its automatic context reads it.
  ...(context.agentDefinitionId === undefined ? {} : { agentId: context.agentDefinitionId }),
  // A group conversation reads and writes only its chat's notes, as its automatic context does.
  ...(context.memoryReach === undefined ? {} : { reach: context.memoryReach }),
});

/** A write from this surface targets the caller's own personal scope, or its chat's notes. Sharing/workspace writes require an explicit human action, not a model-chosen scope. */
function personalScope(context: InvocationContext): { readonly kind: "personal"; readonly principalId: string } {
  return { kind: "personal", principalId: context.principalId };
}

/** This chat's notes: its own run-local scope, kept for the chat's life. */
function chatScope(context: InvocationContext): {
  readonly kind: "run_local";
  readonly principalId: string;
  readonly workspaceId: string;
  readonly runId: string;
} {
  return { kind: "run_local", principalId: context.principalId, workspaceId: context.workspaceId, runId: context.runId };
}

const PARTIAL_MATCH_REASON = "No memory held every word; these hold some of them";
/** What a search that found nothing can honestly say: the index answered, but a miss on these words shows nothing else. */
const MISS_REASON =
  "Nothing matched these words, which does not show nothing is kept: a memory in other words is not found; memory.list shows what is kept";

const MemorySearchInputSchema = z.object({
  query: z.string().min(1).max(512).describe("Search text"),
  limit: z.number().int().positive().max(MEMORY_SEARCH_MAX).optional().describe("Maximum hits to return"),
  includePast: z
    .boolean()
    .optional()
    .describe(
      "When true, also return approved facts whose end date has passed (marked '(ended <date>)') and the last superseded revision of replaced facts (marked '(replaced <date> by <title>)'), for what used to be true.",
    ),
});

const MemoryListInputSchema = z.object({
  kinds: z.array(z.enum(MEMORY_PROPOSABLE_KINDS)).min(1).optional().describe("Only these kinds"),
  offset: z.number().int().nonnegative().optional().describe("The last page's `nextOffset`"),
});

const MemoryGetInputSchema = z.object({
  recordId: z.string().min(1).max(128).describe("The record id from a prior search or propose result"),
});

const MemoryProposeInputSchema = z.object({
  // `summary` is the host's own: a model proposes a preference, a fact or a lesson.
  kind: z.enum(MEMORY_PROPOSABLE_KINDS).describe("What kind of memory this is"),
  title: z.string().max(MAX_MEMORY_TITLE_CHARS).optional(),
  body: z
    .string()
    .max(MAX_MEMORY_BODY_BYTES)
    .describe(
      "The content to remember, as plain text. Write a lesson in the form 'When <situation>, <do this>' so it matches the situation.",
    ),
  preferenceKey: z
    .string()
    .min(1)
    .max(MAX_PREFERENCE_KEY_CHARS)
    .optional()
    .describe("Required when kind is 'preference': a stable namespaced key, e.g. 'ui.theme'"),
  preferenceValue: z
    .string()
    .max(MAX_MEMORY_BODY_BYTES)
    .optional()
    .describe("Required alongside preferenceKey: the preference's value, as a string"),
  topicKey: z
    .string()
    .min(1)
    .max(MAX_TOPIC_KEY_CHARS)
    .optional()
    .describe(
      "A stable key naming what this record is about, e.g. 'alice.city', or starting with 'me.' for a lasting fact " +
        "about the person (me.home_city, me.role, me.employer, me.partner, me.children, me.languages, me.timezone). " +
        "For kind 'fact', records sharing the same topicKey are flagged as contradictory when more than one is approved.",
    ),
  scope: z
    .enum(["everywhere", "chat"])
    .optional()
    .describe(
      "Where it applies once approved: 'everywhere' (the default) for every conversation, or 'chat' for this " +
        "conversation only — a note the person keeps for this chat.",
    ),
  validUntil: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Only for something time-bound: the last day it holds, as YYYY-MM-DD (through that day, in the person's " +
        "zone) or an ISO date-time with its zone. Must be in the future, at most 5 years ahead. A fact ends then " +
        "and is kept as history; a preference or lesson expires.",
    ),
  sensitive: z
    .boolean()
    .optional()
    .describe(
      "True for health, sex life or orientation, religion or beliefs, politics, ethnicity, union membership, money, " +
        "account numbers or ids, a home address or precise location, or other people's private details: kept out of automatic recall and masked for review.",
    ),
  keywords: z
    .array(z.string().trim().min(1).max(MAX_MEMORY_KEYWORD_CHARS))
    .max(MAX_MEMORY_KEYWORDS)
    .optional()
    .describe(
      "Up to 8 search terms for the word index: synonyms, categories, or the entity a pronoun refers to " +
        "(e.g. 'daughter', 'school', 'kid' for 'Emma attends Lincoln Elementary').",
    ),
  updates: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "For kind 'fact' or 'lesson' only: the recordId of a kept record of the same kind this proposal replaces " +
        "(from memory.search). The person's card then offers Replace; a preference replaces by its preferenceKey.",
    ),
});

/** The most `memory.forget` calls one chat may make: past it, the person forgets in Memory. */
const MEMORY_FORGET_PER_TASK_MAX = 5;

const MemoryForgetInputSchema = z.object({
  recordId: z.string().min(1).max(128).describe("The record id, read with memory.get first"),
  reason: z.string().trim().min(1).max(500).describe("Why it is forgotten, in the person's words: 'they moved away'"),
});

/** A record as `memory.get` last read it in a chat: what a forget's card shows. */
interface ShownRecord {
  readonly revisionId: string | undefined;
  readonly title: string | null;
  readonly body: string;
  readonly sensitive: boolean;
  readonly shared: boolean;
}

/** The most records the tools hold for forget cards, across chats: the oldest go first. */
const SHOWN_RECORDS_MAX = 512;

/** What the card binds: the record at the revision it showed, so an edit since refuses the forget. */
function shownHash(recordId: string, shown: ShownRecord): string {
  return createHash("sha256")
    .update(JSON.stringify([recordId, shown.revisionId ?? null, shown.title, shown.body]))
    .digest("hex");
}

/** What the composition hears from the tools: a proposal made, for the turn's memory card. */
export interface MemoryToolHooks {
  /**
   * The workspace's zone, so a date-only `validUntil` holds through that day
   * where the person is. Absent, or a reading that fails: UTC.
   */
  readonly timeZoneOf?: (workspaceId: string) => Promise<string | undefined>;
  /** The clock a `validUntil` is checked against. Absent: the system's. */
  readonly now?: () => string;
  /** Told after each proposal the service filed. Best effort: a throw is swallowed, never the tool's. */
  readonly onProposed?: (context: InvocationContext, record: MemoryRecord) => void;
  /**
   * Told what `memory.search`, `memory.get` and (`kind: "listed"`) `memory.list`
   * returned, for the answer's `memoryUsed`: the revisions, never their text.
   * Best effort, as `onProposed`.
   */
  readonly onRead?: (
    context: InvocationContext,
    read: readonly { readonly recordId: string; readonly revisionId: string }[],
    kind?: "listed",
  ) => void;
  /**
   * The workspace's operator principal: only their own approval of a
   * `memory.forget` call forgets. Absent, or unknown: the chat's principal.
   */
  readonly operatorOf?: (workspaceId: string) => string | undefined;
  /**
   * Before a `memory.forget` (the channel cards' `beforeForget`): the
   * channels whose sent messages cannot be edited, for the answer. The port's
   * own forget edits the cards; a failure here never fails the forget.
   */
  readonly beforeForget?: (recordId: string) => Promise<{ readonly unreached: readonly string[] } | undefined>;
}

/** Tell `hooks.onRead`, never failing the tool. */
function noteRead(
  hooks: MemoryToolHooks,
  context: InvocationContext,
  read: readonly { readonly recordId: string; readonly revisionId: string }[],
  kind?: "listed",
): void {
  if (read.length === 0) return;
  try {
    hooks.onRead?.(context, read, kind);
  } catch {
    // Noting what was read never fails the read.
  }
}

/**
 * What a search's result says of itself: a record it read is the person's, so the chat now holds
 * private data. A search that read none leaves the chat holding what it held.
 */
function readRecords(hits: readonly unknown[]): { readonly [TOOL_LABEL_KEY]?: ToolResultLabel } {
  return hits.length === 0 ? {} : { [TOOL_LABEL_KEY]: { confidentiality: "personal" } };
}

/** Registers the governed read, propose and forget memory tools against `memory`. */
export function registerMemoryTools(registry: ToolRegistry, memory: MemoryServicePort, hooks: MemoryToolHooks = {}): void {
  // What `memory.get` read, by chat and record: the forget card's words, as the assessor
  // (synchronous, no I/O) cannot read the store. In memory only: a restart forgets what was read, not the record.
  const shownRecords = new Map<string, ShownRecord>();
  const shownKey = (context: InvocationContext, recordId: string): string =>
    JSON.stringify([context.workspaceId, context.chatTaskId ?? context.runId, recordId]);
  // `memory.forget` calls run, by chat: past the cap, the assessor refuses before any card.
  const forgetCounts = new Map<string, number>();
  const chatKey = (context: InvocationContext): string => JSON.stringify([context.workspaceId, context.chatTaskId ?? context.runId]);
  /** The record's revision a forget card shows: the one in force, else the newest (a proposal). */
  const readShown = async (actor: MemoryActor, record: MemoryRecord): Promise<ShownRecord> => {
    const { revisions } = await memory.history({ actor, recordId: record.recordId });
    const revision = revisions.find((entry) => entry.revisionId === record.currentRevisionId) ?? revisions[0];
    return {
      revisionId: revision?.revisionId,
      title: revision === undefined ? null : memoryCardTitleOf(revision),
      body: revision?.body ?? "",
      sensitive: record.sensitivity === "sensitive",
      shared: record.scope.kind === "shared_workspace",
    };
  };
  registry.register({
    id: "memory.search",
    // `none`, not `search`: under taint the assessor keeps recall in the host.
    sink: "none",
    // The person's memory raises the chat's confidentiality when a record comes back (`readRecords`), never its integrity.
    version: "1.0.0",
    description:
      'Search what you remember about this person: their own authorized memory. Not for what was said in earlier chats (sessions.search). Returns snippets with citations, never full bodies; falls back to partial matches when no memory holds every word, says `coverage: "partial"` when nothing matched (memory.list shows what is kept, before you say nothing is), marks meaning-only hits (`match: "meaning"`) as loose matches rather than known facts, and with `includePast: true` includes ended and replaced facts for what used to be true.',
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: MemorySearchInputSchema,
    handler: async ({ input, context, signal, operationEnvelope }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "memory.search was cancelled");
      const parsed = MemorySearchInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "memory.search received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      // In a tainted chat the query is the model's, steered by what it read: it stays in the host.
      // No `purpose`, so no memory provider is asked; no `semantic`, so no
      // embedding connection sees it — the built-in's own words-only search, said to be partial.
      if (operationEnvelope?.tainted === true) {
        const own = await memory.search({
          actor: memoryActorFrom(context),
          query: parsed.data.query,
          ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
          ...(parsed.data.includePast === true ? { includePast: true } : {}),
        });
        noteRead(
          hooks,
          context,
          own.hits.map(({ recordId, revisionId }) => ({ recordId, revisionId })),
        );
        if (own.coverage === "unavailable") return { ...own, ...readRecords(own.hits) };
        const said = "this chat read untrusted content, so the search stayed on this device and matched words only";
        const baseReason = own.reducedReason === undefined ? said : `${said}; ${own.reducedReason}`;
        return {
          ...own,
          coverage: "partial" as const,
          reducedReason: (own.match === "any" ? `${baseReason}; ${PARTIAL_MATCH_REASON}` : baseReason).slice(0, 300),
          ...readRecords(own.hits),
        };
      }
      const result = await memory.search({
        actor: memoryActorFrom(context),
        query: parsed.data.query,
        ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
        ...(parsed.data.includePast === true ? { includePast: true } : {}),
        // Tool recall is hybrid under `retrieval: "hybrid"` too: the owner's wrapper embeds the query.
        semantic: parsed.data.query,
        // Tool recall goes through the workspace's memory provider.
        purpose: "tool",
      });
      noteRead(
        hooks,
        context,
        result.hits.map(({ recordId, revisionId }) => ({ recordId, revisionId })),
      );
      if (result.match === "any") {
        return {
          ...result,
          reducedReason: (result.reducedReason === undefined
            ? PARTIAL_MATCH_REASON
            : `${result.reducedReason}; ${PARTIAL_MATCH_REASON}`
          ).slice(0, 300),
          ...readRecords(result.hits),
        };
      }
      if (result.hits.length === 0 && result.coverage === "complete")
        return { ...result, coverage: "partial" as const, reducedReason: MISS_REASON };
      return { ...result, ...readRecords(result.hits) };
    },
  });

  registry.register({
    id: "memory.list",
    sink: "none",
    // As `memory.search`: personal when a record comes back. It takes no words, so a tainted chat has none to steer it with.
    version: "1.0.0",
    description:
      'Everything kept on this person, newest first, with no words to match: preferences, facts and lessons, as snippets with citations. For "what do you know about me" or "from what you know I like": a word search misses a memory in other words. `nextOffset` means more.',
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: MemoryListInputSchema,
    handler: async ({ input, context, signal }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "memory.list was cancelled");
      const parsed = MemoryListInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "memory.list received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      const actor = memoryActorFrom(context);
      const offset = parsed.data.offset ?? 0;
      const kinds = parsed.data.kinds ?? MEMORY_PROPOSABLE_KINDS;
      // A worker's granted records sit outside its scopes, so a listing never meets them: they open the first page.
      const granted = offset === 0 ? (actor.allowedRecordIds ?? []) : [];
      const limit = MEMORY_SEARCH_MAX - granted.length;
      const listed = await memory.list({ actor, kinds, statuses: ["approved"], limit, offset });
      // `eligible` is `search`'s own filters by id: what a search may not show, a listing may not either.
      const eligible = await memory.eligible({ actor, recordIds: [...granted, ...listed.map((record) => record.recordId)] });
      const hits = eligible.filter((hit) => (kinds as readonly string[]).includes(hit.kind));
      // Everything kept comes back, whatever the answer needs: looked through, not used.
      noteRead(
        hooks,
        context,
        hits.map(({ recordId, revisionId }) => ({ recordId, revisionId })),
        "listed",
      );
      return { hits, ...(listed.length === limit ? { nextOffset: offset + limit } : {}), ...readRecords(hits) };
    },
  });

  registry.register({
    id: "memory.get",
    sink: "none",
    // Memory evidence and preferences are the person's: fetching them raises confidentiality, never integrity.
    outputConfidentiality: "personal",
    version: "1.0.0",
    description: "Fetch one memory record by id.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: MemoryGetInputSchema,
    handler: async ({ input, context, signal }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "memory.get was cancelled");
      const parsed = MemoryGetInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "memory.get received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      const actor = memoryActorFrom(context);
      const record = await memory.get({ actor, recordId: parsed.data.recordId });
      // A record read in force names its approved revision; a proposal has none in force, and was used for nothing.
      if (record.currentRevisionId !== undefined)
        noteRead(hooks, context, [{ recordId: record.recordId, revisionId: record.currentRevisionId }]);
      // Held for a `memory.forget` card. Best effort: a failed read only leaves the card unshowable.
      try {
        const key = shownKey(context, record.recordId);
        const shown = await readShown(actor, record);
        shownRecords.delete(key);
        shownRecords.set(key, shown);
        if (shownRecords.size > SHOWN_RECORDS_MAX) {
          const oldest = shownRecords.keys().next().value;
          if (oldest !== undefined) shownRecords.delete(oldest);
        }
      } catch {
        // The record was read; only its card's words were not.
      }
      return record;
    },
  });

  registry.register({
    id: "memory.propose",
    sink: "persist",
    version: "1.0.0",
    description:
      "Suggest a fact, preference or lesson to remember. Stays in review until a person explicitly approves it — " +
      "this call alone never makes anything active. A lesson is a short durable rule (three lines or fewer); a reusable multi-step procedure is a skill (skills.propose).",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: MemoryProposeInputSchema,
    handler: async ({ input, context, signal, operationEnvelope, contextLabel }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "memory.propose was cancelled");
      const parsed = MemoryProposeInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "memory.propose received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      const { kind, title, body, preferenceKey, preferenceValue, topicKey, scope, validUntil, sensitive, keywords, updates } = parsed.data;
      const delegated = context.chatTaskId !== undefined && context.chatTaskId !== context.runId;
      // A group's members' words never become the person's own memory.
      // A group's worker can keep neither, so it is told so once, not sent from one refusal to the other.
      if (context.memoryReach === "chat-only" && delegated) {
        throw new TaviError("NOT_AUTHORIZED", "A worker in a group chat cannot propose memory");
      }
      if (scope !== "chat" && context.memoryReach === "chat-only") {
        throw new TaviError(
          "NOT_AUTHORIZED",
          "Memory isn't used in group chats: propose it with scope 'chat' to keep it as this chat's note",
        );
      }
      // A chat note belongs to the chat the person talks in; a delegated task
      // reads its chat's notes but does not write them.
      if (scope === "chat" && delegated) {
        throw new TaviError("INVALID_INPUT", "A delegated task cannot keep notes for its chat; propose it for everywhere instead");
      }
      if (kind === "preference" && (preferenceKey === undefined || preferenceValue === undefined)) {
        throw new TaviError("INVALID_INPUT", "A preference proposal needs both preferenceKey and preferenceValue");
      }
      if (kind !== "preference" && (preferenceKey !== undefined || preferenceValue !== undefined)) {
        throw new TaviError("INVALID_INPUT", "preferenceKey/preferenceValue are only valid when kind is 'preference'");
      }
      if (updates !== undefined && kind === "preference") {
        throw new TaviError("INVALID_INPUT", "updates is only valid for a fact or lesson; a preference replaces by its preferenceKey");
      }
      // An end date by kind: a fact's ends it (`validTo`), a preference's or lesson's expires it (`expiryAt`).
      let endDate: { readonly validTo: string } | { readonly expiryAt: string } | undefined;
      if (validUntil !== undefined) {
        let timeZone: string | undefined;
        try {
          timeZone = await hooks.timeZoneOf?.(context.workspaceId);
        } catch {
          // An unreadable zone is UTC: the date still holds, a few hours either way.
        }
        const resolved = resolveMemoryValidUntil(validUntil, hooks.now?.() ?? nowTimestamp(), timeZone);
        if (!resolved.ok) throw new TaviError("INVALID_INPUT", resolved.reason);
        endDate = memoryEndDate(kind, resolved.at);
      }
      const texts = [title, body, preferenceKey, preferenceValue, topicKey, ...(keywords ?? [])];
      // A key-shaped secret is never filed: it would sit in memory, and in every card and digest.
      if (holdsSecret(texts)) {
        throw new TaviError(
          "INVALID_INPUT",
          "This looks like it holds a password, key or token, which memory never keeps; propose it without the secret",
        );
      }
      // The person asked for it, so the workspace's `sensitive` setting (automatic capture only) does not drop it;
      // a sensitive topic the model did not mark is marked by the host's list, so it is masked and never recalled automatically.
      const marked = sensitive === true || sensitiveTopicOf(texts) !== undefined;
      // Where the words may have come from: the call's context label when
      // untrusted — a tainted call without one reads as `unknown-source`. Nothing is refused: someone asked for it.
      // It is never auto-approved or kept by *Keep all*, and every review surface says what the chat read.
      const provenance = memoryProvenanceOf(contextLabel ?? (operationEnvelope?.tainted === true ? UNTRUSTED_UNKNOWN_SOURCE : undefined));
      const record = await memory.propose({
        actor: memoryActorFrom(context),
        ...(scope === "chat" ? { scope: chatScope(context), durable: true } : { scope: personalScope(context) }),
        // The chat it was written from, so the chat can list what it taught.
        originTaskId: context.chatTaskId ?? context.runId,
        kind,
        body,
        ...definedOnly({
          title,
          preferenceKey,
          topicKey,
          // The service checks it is a kept record of this kind in force in the same scope.
          supersedesRecordId: updates,
        }),
        ...(keywords === undefined || keywords.length === 0 ? {} : { keywords }),
        ...(kind === "preference" && preferenceValue !== undefined
          ? { preference: { valueType: "string" as const, value: preferenceValue } }
          : {}),
        ...(endDate ?? {}),
        ...(marked ? { sensitivity: "sensitive" as const } : {}),
        ...(provenance === undefined ? {} : { provenance }),
      });
      // The same words already proposed or kept: nothing new was written, so no card either.
      if (record.known !== undefined) {
        const { known: _known, ...existing } = record;
        return {
          ...existing,
          alreadyKnown: true,
          note: "Already known: this is already proposed or remembered, so nothing new was proposed.",
        };
      }
      try {
        hooks.onProposed?.(context, record);
      } catch {
        // The card is the person's view of the proposal, not the proposal: it still stands.
      }
      return record;
    },
  });

  registry.register({
    id: "memory.forget",
    // A tainted turn asks under `tainted-persist`, as any write that lasts.
    sink: "persist",
    version: "1.0.0",
    description:
      "Ask the person to forget one memory record for good, when they say it is wrong or ask you to forget it. " +
      "Read it with memory.get first: the person's card shows its title and text, and only their own approval forgets it. " +
      "To change what a record says instead, use memory.propose with updates.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: MemoryForgetInputSchema,
    assess: (input, context): CallAssessment => {
      const parsed = MemoryForgetInputSchema.safeParse(input);
      const recordId = parsed.success ? parsed.data.recordId : "";
      const refuse = (hardDeny: string): CallAssessment => ({
        display: { title: "Forget a memory", destructive: true },
        subjects: [],
        risk: "high",
        reasons: [],
        hardDeny,
        onceOnly: true,
        attendedOnly: true,
      });
      if (!parsed.success) return refuse("memory.forget received invalid arguments");
      if ((forgetCounts.get(chatKey(context)) ?? 0) >= MEMORY_FORGET_PER_TASK_MAX)
        return refuse(`This chat already asked to forget ${MEMORY_FORGET_PER_TASK_MAX} memories; the person forgets more in Memory`);
      const shown = shownRecords.get(shownKey(context, recordId));
      // Nothing is put in front of the person they cannot see: the card is the record's own words.
      if (shown === undefined) return refuse("Read the record with memory.get first, so the person sees what would be forgotten");
      if (shown.shared) return refuse("Shared workspace memory is changed by an explicit share, not from a chat");
      const title = shown.sensitive ? "a sensitive memory" : (shown.title ?? "a memory");
      const body = shown.sensitive ? "(sensitive: open Memory to read it)" : shown.body;
      return {
        display: {
          title: `Forget “${title}”`.slice(0, 300),
          detail: `${body.slice(0, 1_700)}\n\nWhy: ${parsed.data.reason}`.slice(0, 2_000),
          destructive: true,
        },
        subjects: [recordId],
        risk: "high",
        reasons: ["erases a memory for good"],
        // Only the person decides, once: no grant or rule covers a forget, and no run nobody attends asks it.
        onceOnly: true,
        attendedOnly: true,
        contentHash: shownHash(recordId, shown),
      };
    },
    handler: async ({ input, context, signal, approvedBy, approvedContentHash }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "memory.forget was cancelled");
      const parsed = MemoryForgetInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "memory.forget received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      const { recordId, reason } = parsed.data;
      const counted = chatKey(context);
      const asked = forgetCounts.get(counted) ?? 0;
      if (asked >= MEMORY_FORGET_PER_TASK_MAX) {
        throw new TaviError("NOT_AUTHORIZED", `This chat already asked to forget ${MEMORY_FORGET_PER_TASK_MAX} memories`);
      }
      forgetCounts.set(counted, asked + 1);
      // Operator authority only from the operator's own click on this very call: `approvedBy` is
      // set only for a person who saw it, and the CLI's own decision is `operator`.
      // No operator known for the workspace: nobody's click is the operator's, so nothing is forgotten.
      const operator = hooks.operatorOf?.(context.workspaceId);
      if (operator === undefined || approvedBy === undefined || (approvedBy !== operator && approvedBy !== "operator")) {
        throw new TaviError("NOT_AUTHORIZED", "Only the person's own approval forgets a memory; they can forget it in Memory");
      }
      // Read as the chat may read it, then held to what the card showed.
      const actor: MemoryActor = { ...memoryActorFrom(context), authority: "operator" };
      const record = await memory.get({ actor, recordId });
      if (record.scope.kind === "shared_workspace") {
        throw new TaviError("NOT_AUTHORIZED", "Shared workspace memory is changed by an explicit share, not from a chat");
      }
      if (approvedContentHash === undefined || approvedContentHash !== shownHash(recordId, await readShown(actor, record))) {
        throw new TaviError("REVISION_CONFLICT", "The memory changed since the person was shown it; read it again and ask again");
      }
      let unreached: string | undefined;
      try {
        unreached = memoryUnreachedNote((await hooks.beforeForget?.(recordId))?.unreached ?? []);
      } catch {
        // The note is the answer's, not the forget's: the record still goes.
      }
      const deletion = await memory.forget({ actor, recordId, reason });
      shownRecords.delete(shownKey(context, recordId));
      return { ...deletion, unreached: [MEMORY_FORGET_UNREACHED, ...(unreached === undefined ? [] : [unreached])] };
    },
  });
}
