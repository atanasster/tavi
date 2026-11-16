import { clippedSkillDescription, skillListing } from "./skill-listing.js";
import {
  MEMORY_SEARCH_DEFAULT,
  MEMORY_SEARCH_MAX,
  PREFERENCE_PRECEDENCE,
  TaviError,
  type ActiveSkill,
  type MemorySearchResult,
  type ResolvedPreference,
  type ResolvedProfileEntry,
  type RouterPort,
  type RouterFence,
  type RouterCandidate,
  type RouterDecisionInput,
  type RouterReceipt,
  type ContextProjectionSnapshot,
  type AgentMailboxRepositoryPort,
  type MemoryActor,
  type MemoryServicePort,
  type SkillActor,
  type SkillRepositoryPort,
  type SkillRolloutRepositoryPort,
  type SkillServicePort,
} from "@tavi/contracts";
import { definedOnly, errorMessage, plural } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";

/**
 * Context assembly.
 *
 * `assembleContext` builds the ordered manifest of a model call: the mandatory
 * instructions, the approved skill manifest, resolved preferences (an explicit
 * run-level override outranking everything stored), authorized retrieved
 * evidence and the agent mailbox's count, bounded to a token budget that
 * counts the instructions and the rest together. `workflow/context-block.ts` renders it:
 * the instructions as the system string, the rest as the call's
 * user-role context block (`withContextMessage`), so the
 * system string does not change with what memory finds.
 *
 * Only the mandatory instructions fail hard when they cannot fit.
 * Everything after them degrades and says so: skills, then
 * preferences, are truncated and flagged (`skillsTruncated`,
 * `preferencesTruncated`); evidence and the mailbox are soft-truncated; a
 * memory read that fails sets `memoryUnavailable` instead of failing the call.
 * Model-based compaction of the conversation lives in `workflow/model-summary.ts` (stage 2),
 * not here: this function is given no conversation.
 */

/** A resolved preference in the manifest, with enough provenance to explain why it won. */
export interface ContextPreference {
  readonly key: string;
  readonly value: unknown;
  /** `"run"` for an explicit current-task override; otherwise the winning record's scope kind. */
  readonly source: string;
  readonly conflict: boolean;
  /**
   * The winning record's revision whose value is shown: what a kept context
   * block lists it under, so a forget of that record drops the block. Absent
   * for a run override, which no record holds.
   */
  readonly revisionId?: string;
}

/** One bounded retrieved excerpt, carrying its citation. */
export interface ContextEvidence {
  readonly recordId: string;
  readonly revisionId: string;
  readonly kind: string;
  readonly title?: string;
  /** The whole body up to 300 characters, else a window around the match (`memoryExcerptOf`). */
  readonly snippet: string;
  readonly recordedAt: string;
  /** Another current record says otherwise (the same fact topic or preference key): named in `conflictsWith`. */
  readonly conflict?: boolean;
  readonly conflictsWith?: readonly string[];
  /** A newer approved revision exists than the one matched. */
  readonly superseded?: boolean;
}

/**
 * One delivered mailbox message as it appears in the context's mailbox
 * stage. Deliberately thin — the model sees
 * enough to act on or ask about a message, not the full envelope's
 * delivery/retention bookkeeping.
 */
export interface ContextMailboxMessage {
  readonly messageId: string;
  readonly senderAgentId: string;
  readonly kind: string;
  readonly content?: string;
  /** Set when the message's payload was offloaded (over the 2 KiB inline cap) — retrievable via `agents.read_payload`. */
  readonly artifactId?: string;
  readonly createdAt: string;
}

/** One active skill's manifest, as it appears in the context's skill/tool stage. */
export interface ContextSkill {
  readonly skillId: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
}

export interface ContextManifest {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly instructions: string;
  readonly skills: readonly ContextSkill[];
  /** Advisory references; the full eligible roster above remains exposed. */
  readonly recommendedSkills?: readonly ContextSkill[];
  readonly preferences: readonly ContextPreference[];
  /**
   * True when resolved preferences were cut to fit the budget, or the
   * preference sweep reached its bound. `preferencesOmitted`
   * counts the ones cut here; a bounded sweep's misses are not countable.
   */
  readonly preferencesTruncated: boolean;
  readonly preferencesOmitted: number;
  /** Approved lessons and core `me.*` facts in the "About the person" section. */
  readonly profile?: readonly ContextEvidence[];
  /** True when profile entries were cut to fit the profile sub-budget or remaining context budget. */
  readonly profileTruncated?: boolean;
  readonly profileOmitted?: number;
  /** True when active skills were cut by the listing cap or the budget; `skillsOmitted` counts them. */
  readonly skillsTruncated: boolean;
  readonly skillsOmitted: number;
  /** The line saying what was left out, when anything was: "N more preferences and M skills not shown; …". */
  readonly truncationNote?: string;
  /**
   * True when memory could not be read for this call — a failed preference
   * read, or a search that threw or answered `unavailable`:
   * the prompt says so rather than looking like there is nothing to recall.
   */
  readonly memoryUnavailable: boolean;
  /** Why, for the log line (an error's message, never memory text). */
  readonly memoryUnavailableReason?: string;
  readonly evidence: readonly ContextEvidence[];
  /** True when `evidence` was explicitly ordered by a context router (`projection.evidenceOrder`). */
  readonly evidenceOrderOverridden?: boolean;
  /**
   * Why recall was `partial` (the search's `reducedReason`), when it was: hybrid
   * recall matched some records by words only, or the memory
   * provider failed and the host's own search answered.
   * Evidence is still given; this says it is not the provider's ranking.
   */
  readonly evidenceReducedReason?: string;
  /** True when retrieved evidence was cut to fit the token budget. */
  readonly evidenceTruncated: boolean;
  readonly mailbox: readonly ContextMailboxMessage[];
  /** True when pending mailbox messages were cut to fit the remaining token budget. */
  readonly mailboxTruncated: boolean;
  /** A coarse character/4 estimate; real provider-reported usage is tracked separately. */
  readonly tokenEstimate: number;
}

export interface ContextAssemblerOptions {
  /**
   * The memory service. Absent when memory is off for this call — paused for
   * the workspace or off for the chat: no preferences and no
   * evidence are read, while skills and the mailbox are still assembled.
   */
  readonly memory?: MemoryServicePort;
  /**
   * Approved-skills service. Optional: when omitted, `skills` in the
   * returned manifest is empty, matching the pre-wiring behavior — the same
   * additive-when-present pattern the workflow uses for `memory`.
   */
  readonly skills?: SkillServicePort;
  /** Hard token budget for the whole manifest. Default is generous and meant to be tuned per deployment. */
  readonly maxTokens?: number;
  /** Injectable so tests and future providers can supply a real tokenizer instead of the char/4 heuristic. */
  readonly estimateTokens?: (text: string) => number;
  /**
   * Delivered agent-mailbox messages. Optional,
   * additive-when-present — matches `skills`'s own pattern: omitted means
   * `mailbox` in the returned manifest is empty, not an error.
   */
  readonly mailbox?: AgentMailboxRepositoryPort;
  /** Cap on how many pending messages `listPending` is asked for before the token budget does its own cutting; default 50. */
  readonly mailboxLimit?: number;
  /**
   * Bounded-rollout enforcement.
   * Optional, additive-when-present like `skills`/`mailbox` — omitted
   * means every active skill is included unconditionally. When present, an active skill whose
   * `(workspaceId, skillId, version)` triple is PINNED
   * (`SkillRolloutRepositoryPort.isPinned`) is included ONLY when
   * `input.actor.runId` (the calling task's own id) is on that triple's
   * allowlist — an unauthorized task simply never sees a bounded-rollout
   * skill in its manifest at all, the safest reading of "authorized task
   * set" (omit access, never silently fall back to an older version,
   * since `SkillActivation` itself has no side-by-side dual-version
   * state to fall back to). An UNPINNED triple (the overwhelming common
   * case — no rollout ever pinned) is completely unaffected: `isPinned`
   * returns `false` and the skill is included exactly as before this
   * field existed.
   */
  readonly skillRollout?: SkillRolloutRepositoryPort;
  /**
   * The workspace's skill uses (`listUsage`), read once a call and only when
   * the active skills are past `SKILL_LISTING_MAX`: the listing then leads with
   * the recently used. Absent, or within the cap: by the turn's words alone,
   * and within the cap in `skillId` order.
   */
  readonly skillUsage?: Pick<SkillRepositoryPort, "listUsage">;
}

export interface AssembleContextInput {
  readonly actor: MemoryActor;
  readonly instructions: string;
  /**
   * Explicit current-task instruction overrides, which outrank every stored
   * scope. Not
   * persisted — a run-only choice does not survive the run unless the caller
   * separately proposes it as memory.
   */
  readonly runOverrides?: Readonly<Record<string, unknown>>;
  /** When present, resolved preferences are filtered to these keys plus every run override. */
  readonly preferenceKeys?: readonly string[];
  /** Include the "About the person" profile section (default `true`). */
  readonly includeProfile?: boolean;
  /** When present, retrieves bounded evidence for this query; omitted means no retrieval this turn. */
  readonly query?: string;
  /** How `query`'s terms match (`MemoryServicePort.search`'s `match`); `all` when absent. */
  readonly queryMatch?: "all" | "any";
  /** The text hybrid recall embeds (`MemoryServicePort.search`'s `semantic`); only read with `query`. */
  readonly semantic?: string;
  readonly evidenceLimit?: number;
  /** Apply the post-ranking relevance floor and MMR near-duplicate filter (`MemoryServicePort.search`'s `applyFloor`). */
  readonly applyFloor?: boolean;
  /** The recency and confirmation priors in ranking (`MemoryServicePort.search`'s `rankingPriors`). */
  readonly rankingPriors?: boolean;
  /** Ids already shown in this epoch's context delta (`WorkflowMessage.contextShown`), exempt from the floor and MMR drop. */
  readonly alreadyShownIds?: readonly string[];
  /** Include ended and superseded facts when a temporal query asks about the past (`MemoryServicePort.search`'s `includePast`). */
  readonly includePast?: boolean;
  /** Deterministic temporal range parsed from the query (`MemoryServicePort.search`'s `range`). */
  readonly range?: { readonly from: string; readonly to: string };
  /**
   * The turn and step this context is for (`MemoryServicePort.search`'s
   * `recallKey`): every search of it asks the memory provider once.
   * The routed path sets it from its `turnId` and `step` when absent.
   */
  readonly recallKey?: string;
}

/**
 * The context budget when an adapter sets none.
 *
 * Exported so the no-memory mandatory-prefix check in the workflow uses the
 * same number `assembleContext` would: two defaults would mean a prompt that
 * fits in one path and not the other.
 */
export const DEFAULT_CONTEXT_MAX_TOKENS = 8_000;
const DEFAULT_MAX_TOKENS = DEFAULT_CONTEXT_MAX_TOKENS;
const DEFAULT_MAILBOX_LIMIT = 50;
/** Maximum estimated tokens for the "About the person" profile section. */
export const PROFILE_MAX_TOKENS = 600;
/** Maximum number of entries in the "About the person" profile section. */
export const PROFILE_MAX_ENTRIES = 12;

/** Exported so compaction stage 2 (`workflow/compaction.ts`) single-sources the same heuristic rather than duplicating it. */
export function defaultEstimateTokens(text: string): number {
  // A coarse, provider-agnostic heuristic (~4 chars/token for English text).
  // Real provider-reported usage remains authoritative where available;
  // this only bounds what this function itself assembles.
  return Math.ceil(text.length / 4);
}

export interface ContextProjection {
  readonly evidenceOrder?: readonly { readonly recordId: string; readonly revisionId: string }[];
  readonly recommendedSkills?: readonly { readonly skillId: string; readonly version: string }[];
}

export async function assembleContext(
  options: ContextAssemblerOptions,
  input: AssembleContextInput,
  projection?: ContextProjection,
): Promise<ContextManifest> {
  const estimateTokens = options.estimateTokens ?? defaultEstimateTokens;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  const instructionsTokens = estimateTokens(input.instructions);
  if (instructionsTokens > maxTokens) {
    // Mandatory context that cannot fit is a hard failure, not a silent
    // truncation of the instructions themselves.
    throw new TaviError(
      "INVALID_INPUT",
      `Mandatory instructions (${instructionsTokens} estimated tokens) exceed the context budget (${maxTokens})`,
    );
  }
  let budget = maxTokens - instructionsTokens;

  // Memory trouble never fails the call (invariant 10): a failed read is flagged
  // instead, and the line that says so is charged to the budget once.
  let unavailableReason: string | undefined;
  const unavailable = (error: unknown): void => {
    if (unavailableReason !== undefined) return;
    unavailableReason = memoryUnavailableReason(error);
    budget -= estimateTokens(MEMORY_UNAVAILABLE_LINE);
  };

  // The reads that need nothing from each other run together — the skills, the preferences and
  // profile, and the mailbox. Their results are taken below in the same order as before, so a failure and
  // the budget fall out exactly as they did when the reads ran one after another.
  // Listed by name and a short description, at most `SKILL_LISTING_MAX` of them; `skills.read` loads one, `skills.search` finds the rest.
  const skillUsage = options.skillUsage;
  const memory = options.memory;
  const runId = input.actor.runId;
  const mailboxPort = options.mailbox;
  const [listingRead, preferencesRead, mailboxRead] = await Promise.allSettled([
    (async () =>
      await skillListing(
        options.skills === undefined ? [] : await collectEligibleSkills(options, input),
        input.query,
        skillUsage === undefined ? undefined : async () => await skillUsage.listUsage(input.actor.workspaceId),
      ))(),
    (async () =>
      memory === undefined
        ? undefined
        : await memory.resolvePreferences({
            actor: input.actor,
            ...(input.preferenceKeys === undefined ? {} : { keys: input.preferenceKeys }),
            includeProfile: input.includeProfile !== false,
          }))(),
    (async () =>
      mailboxPort === undefined || runId === undefined
        ? undefined
        : await mailboxPort.listPending(runId, options.mailboxLimit ?? DEFAULT_MAILBOX_LIMIT))(),
  ]);
  const listing = settledValue(listingRead);
  const eligibleSkills = listing.listed.map((skill) =>
    skill.description === undefined ? skill : { ...skill, description: clippedSkillDescription(skill.description) },
  );

  const runOverrides = input.runOverrides ?? {};
  let resolved: readonly ResolvedPreference[] = [];
  let resolvedProfile: readonly ResolvedProfileEntry[] = [];
  let sweepTruncated = false;
  if (preferencesRead.status === "rejected") unavailable(preferencesRead.reason);
  else if (preferencesRead.value !== undefined) {
    resolved = preferencesRead.value.preferences;
    resolvedProfile = preferencesRead.value.profile ?? [];
    sweepTruncated = preferencesRead.value.truncated;
  }
  const allPreferences = orderPreferences(runOverrides, resolved);
  const allProfile: ContextEvidence[] =
    input.includeProfile === false
      ? []
      : resolvedProfile.map((entry) => ({
          recordId: entry.recordId,
          revisionId: entry.revisionId,
          kind: entry.kind,
          ...(entry.title === undefined ? {} : { title: entry.title }),
          snippet: entry.snippet,
          recordedAt: entry.recordedAt,
          ...(entry.conflict ? { conflict: true } : {}),
          ...(entry.conflictsWith === undefined || entry.conflictsWith.length === 0 ? {} : { conflictsWith: entry.conflictsWith }),
        }));

  // Skills, then preferences, then the profile within its own sub-budget (600 tokens, 12 entries),
  // take what fits, each in its own order, and what does not fit is counted and flagged rather than
  // failing the call. The truncation line's own tokens are kept back when anything is cut.
  const skillCosts = eligibleSkills.map((skill) => estimateTokens(JSON.stringify(skill)));
  const preferenceCosts = allPreferences.map(
    (preference) => estimateTokens(JSON.stringify(preference)) + (preference.conflict ? estimateTokens(PREFERENCE_CONFLICT_NOTE) : 0),
  );
  const profileCosts = allProfile.map((entry) => estimateTokens(JSON.stringify(entry)));
  const cappedProfile = allProfile.slice(0, PROFILE_MAX_ENTRIES);
  const cappedProfileCosts = profileCosts.slice(0, PROFILE_MAX_ENTRIES);
  const subBudgetedProfile = takeFitting(cappedProfile, cappedProfileCosts, PROFILE_MAX_TOKENS);
  const subBudgetedProfileCosts = cappedProfileCosts.slice(0, subBudgetedProfile.length);
  const profileCutBySubBudget = allProfile.length > subBudgetedProfile.length;
  const needed = sum(skillCosts) + sum(preferenceCosts) + sum(subBudgetedProfileCosts);
  let room = budget;
  if (needed > budget || sweepTruncated || profileCutBySubBudget || listing.omitted > 0)
    room = Math.max(
      0,
      budget -
        estimateTokens(
          truncationLine(allPreferences.length, sweepTruncated, eligibleSkills.length + listing.omitted, profileOmittedOf(allProfile)),
        ),
    );
  const skills = takeFitting(eligibleSkills, skillCosts, room);
  room -= sum(skillCosts.slice(0, skills.length));
  const preferences = takeFitting(allPreferences, preferenceCosts, room);
  room -= sum(preferenceCosts.slice(0, preferences.length));
  const profile = takeFitting(subBudgetedProfile, subBudgetedProfileCosts, room);
  const skillsOmitted = eligibleSkills.length - skills.length + listing.omitted;
  const preferencesOmitted = allPreferences.length - preferences.length;
  const profileOmitted = allProfile.length - profile.length;
  const profileOmittedKinds = profileOmittedOf(allProfile.slice(profile.length));
  budget -=
    sum(skillCosts.slice(0, skills.length)) +
    sum(preferenceCosts.slice(0, preferences.length)) +
    sum(subBudgetedProfileCosts.slice(0, profile.length));
  const truncationNote = truncationLine(preferencesOmitted, sweepTruncated, skillsOmitted, profileOmittedKinds);
  if (truncationNote !== "") budget = Math.max(0, budget - estimateTokens(truncationNote));

  const recommendedSkills =
    projection?.recommendedSkills === undefined
      ? undefined
      : skills.filter((skill) =>
          projection.recommendedSkills?.some((entry) => entry.skillId === skill.skillId && entry.version === skill.version),
        );
  const recommendationTokens =
    recommendedSkills === undefined || recommendedSkills.length === 0
      ? 0
      : estimateTokens(
          "Suggested skills (advice only; no skill has been loaded or applied): " +
            recommendedSkills.map((skill) => `${skill.skillId}@${skill.version}`).join(", "),
        );
  const evidence: ContextEvidence[] = [];
  let evidenceTruncated = false;
  let evidenceReducedReason: string | undefined;
  // The search runs after them: its limit depends on the profile fitted above.
  if (input.query !== undefined && memory !== undefined) {
    // A hit already rendered in the profile is suppressed from the evidence
    // section, so it takes no evidence slot and no budget: the search asks for
    // that many more. It stays in `evidence` because it matched the turn's
    // query on its own (the floor exempts no profile record), so its turn use
    // is still recorded.
    const profileRecordIds = new Set(profile.map((entry) => entry.recordId));
    const evidenceLimit = input.evidenceLimit ?? MEMORY_SEARCH_DEFAULT;
    const requestLimit =
      profileRecordIds.size === 0 ? input.evidenceLimit : Math.min(MEMORY_SEARCH_MAX, evidenceLimit + profileRecordIds.size);
    let result: MemorySearchResult;
    try {
      result = await memory.search({
        actor: input.actor,
        query: input.query,
        // Turn recall: the owner asks the workspace's memory provider to rank.
        purpose: "turn",
        ...definedOnly({
          match: input.queryMatch,
          limit: requestLimit,
          semantic: input.semantic,
          recallKey: input.recallKey,
          applyFloor: input.applyFloor,
          rankingPriors: input.rankingPriors,
          alreadyShownIds: input.alreadyShownIds,
          includePast: input.includePast,
          range: input.range,
        }),
      });
    } catch (error) {
      unavailable(error);
      result = { hits: [], coverage: "unavailable" };
    }
    // An unreadable index answers `unavailable` rather than throwing: flagged the same way.
    if (result.coverage === "unavailable") unavailable(result.reducedReason ?? "memory search unavailable");
    // A degraded answer is recorded as one, as `unavailable` is (the manifest says so).
    if (result.coverage === "partial") evidenceReducedReason = result.reducedReason ?? "memory recall was partial";
    const order = projection?.evidenceOrder;
    const ordered =
      order === undefined
        ? result.hits
        : [...result.hits].sort((a, b) => {
            const rank = (hit: typeof a) => {
              const index = order.findIndex((entry) => entry.recordId === hit.recordId && entry.revisionId === hit.revisionId);
              return index < 0 ? order.length : index;
            };
            return rank(a) - rank(b);
          });
    let counted = 0;
    for (const hit of ordered) {
      const inProfile = profileRecordIds.has(hit.recordId);
      if (!inProfile && counted >= evidenceLimit) continue;
      const entry: ContextEvidence = {
        recordId: hit.recordId,
        revisionId: hit.revisionId,
        kind: hit.kind,
        ...(hit.title === undefined ? {} : { title: hit.title }),
        snippet: hit.snippet,
        recordedAt: hit.recordedAt,
        ...(hit.conflict ? { conflict: true } : {}),
        ...(hit.conflictsWith === undefined || hit.conflictsWith.length === 0 ? {} : { conflictsWith: hit.conflictsWith }),
        ...(hit.superseded ? { superseded: true } : {}),
      };
      if (inProfile) {
        evidence.push(entry);
        continue;
      }
      const entryTokens = estimateTokens(JSON.stringify(entry));
      if (entryTokens > budget) {
        evidenceTruncated = true;
        break;
      }
      budget -= entryTokens;
      counted += 1;
      evidence.push(entry);
    }
  }

  const mailbox: ContextMailboxMessage[] = [];
  let mailboxTruncated = false;
  // A mailbox read that failed fails the call here, after the search, where it always did.
  const pending = settledValue(mailboxRead);
  if (pending !== undefined) {
    // Soft-truncate with a flag, as `evidence`, skills and preferences above
    // do: "several individually small messages must not overflow the prompt"
    // describes exactly this degradation, not a misconfiguration.
    for (const envelope of pending) {
      const entry: ContextMailboxMessage = {
        messageId: envelope.messageId,
        senderAgentId: envelope.senderAgentId,
        kind: envelope.kind,
        ...(envelope.content === undefined ? {} : { content: envelope.content }),
        ...(envelope.artifactId === undefined ? {} : { artifactId: envelope.artifactId }),
        createdAt: envelope.createdAt,
      };
      const entryTokens = estimateTokens(JSON.stringify(entry));
      if (entryTokens > budget) {
        mailboxTruncated = true;
        break;
      }
      budget -= entryTokens;
      mailbox.push(entry);
    }
  }

  const recommendationsFit = recommendationTokens <= budget;
  if (recommendationsFit) budget -= recommendationTokens;
  const tokenEstimate = maxTokens - budget;
  return {
    principalId: input.actor.principalId,
    workspaceId: input.actor.workspaceId,
    ...(input.actor.agentId === undefined ? {} : { agentId: input.actor.agentId }),
    ...(input.actor.runId === undefined ? {} : { runId: input.actor.runId }),
    instructions: input.instructions,
    skills,
    ...(recommendedSkills === undefined ? {} : { recommendedSkills: recommendationsFit ? recommendedSkills : [] }),
    preferences,
    preferencesTruncated: preferencesOmitted > 0 || sweepTruncated,
    preferencesOmitted,
    ...(profile.length === 0 && profileOmitted === 0
      ? {}
      : {
          profile,
          profileTruncated: profileOmitted > 0,
          profileOmitted,
        }),
    skillsTruncated: skillsOmitted > 0,
    skillsOmitted,
    ...(truncationNote === "" ? {} : { truncationNote }),
    memoryUnavailable: unavailableReason !== undefined,
    ...(unavailableReason === undefined ? {} : { memoryUnavailableReason: unavailableReason }),
    evidence,
    ...(projection?.evidenceOrder === undefined ? {} : { evidenceOrderOverridden: true }),
    ...(evidenceReducedReason === undefined ? {} : { evidenceReducedReason }),
    evidenceTruncated,
    mailbox,
    mailboxTruncated,
    tokenEstimate,
  };
}

/** What a turn's prompt says when memory could not be read for it. */
export const MEMORY_UNAVAILABLE_LINE = "Memory is unavailable for this response.";
/** What a preference line says when another value for its key holds at the same tier. */
export const PREFERENCE_CONFLICT_NOTE = "(conflicts with another value; ask before relying on it)";

/** The reason a failed memory read is flagged with: the error's message, bounded. */
export function memoryUnavailableReason(error: unknown): string {
  return errorMessage(error).slice(0, 200) || "memory unavailable";
}

/** How many profile entries of each kind `omitted` holds: lessons and `me.*` facts are counted apart. */
function profileOmittedOf(omitted: readonly ContextEvidence[]): { readonly lessons: number; readonly facts: number } {
  const lessons = omitted.filter((entry) => entry.kind === "lesson").length;
  return { lessons, facts: omitted.length - lessons };
}

/** The truncation line: what was left out and where to find it, or "" when nothing was. */
function truncationLine(
  preferencesOmitted: number,
  sweepTruncated: boolean,
  skillsOmitted: number,
  profileOmitted: { readonly lessons: number; readonly facts: number } = { lessons: 0, facts: 0 },
): string {
  const parts: string[] = [];
  if (preferencesOmitted > 0)
    parts.push(
      `${preferencesOmitted}${sweepTruncated ? "+" : ""} more preference${preferencesOmitted === 1 && !sweepTruncated ? "" : "s"}`,
    );
  else if (sweepTruncated) parts.push("More preferences");
  if (profileOmitted.lessons > 0)
    parts.push(parts.length === 0 ? plural(profileOmitted.lessons, "more lesson") : plural(profileOmitted.lessons, "lesson"));
  if (profileOmitted.facts > 0)
    parts.push(parts.length === 0 ? plural(profileOmitted.facts, "more fact") : plural(profileOmitted.facts, "fact"));
  if (skillsOmitted > 0) parts.push(parts.length === 0 ? plural(skillsOmitted, "more skill") : plural(skillsOmitted, "skill"));
  if (parts.length === 0) return "";
  // memory.search finds a preference, lesson or fact; skills.search a skill.
  const memory = preferencesOmitted > 0 || sweepTruncated || profileOmitted.lessons + profileOmitted.facts > 0;
  const finders = [...(memory ? ["memory.search"] : []), ...(skillsOmitted > 0 ? ["skills.search"] : [])];
  return `${parts.join(" and ")} not shown; ${finders.join(" and ")} find${finders.length === 1 ? "s" : ""} them.`;
}

/**
 * The order preferences keep their place in when the budget is short:
 * conflicts first (the model must ask before relying on one), then run
 * overrides, then by scope precedence and the newest first.
 */
function orderPreferences(runOverrides: Readonly<Record<string, unknown>>, resolved: readonly ResolvedPreference[]): ContextPreference[] {
  const overrides: ContextPreference[] = Object.entries(runOverrides).map(([key, value]) => ({
    key,
    value,
    source: "run",
    conflict: false,
  }));
  const stored = resolved
    .filter((entry) => !(entry.key in runOverrides)) // the run override already outranks it
    .map((entry) => ({ entry, rank: precedenceOf(entry.winner.scope.kind) }))
    .sort((left, right) => left.rank - right.rank || right.entry.winner.updatedAt.localeCompare(left.entry.winner.updatedAt));
  const conflicts = stored.filter(({ entry }) => entry.conflict);
  const rest = stored.filter(({ entry }) => !entry.conflict);
  const shown = (entry: ResolvedPreference): ContextPreference => ({
    key: entry.key,
    value: entry.value,
    source: entry.winner.scope.kind,
    conflict: entry.conflict,
    ...(entry.winner.currentRevisionId === undefined ? {} : { revisionId: entry.winner.currentRevisionId }),
  });
  return [...conflicts.map(({ entry }) => shown(entry)), ...overrides, ...rest.map(({ entry }) => shown(entry))];
}

function precedenceOf(kind: string): number {
  const index = (PREFERENCE_PRECEDENCE as readonly string[]).indexOf(kind);
  return index < 0 ? PREFERENCE_PRECEDENCE.length : index;
}

/** The leading items whose costs fit in `room`, in order: the first that does not fit ends the list. */
function takeFitting<T>(items: readonly T[], costs: readonly number[], room: number): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const [index, item] of items.entries()) {
    const cost = costs[index] ?? 0;
    if (used + cost > room) break;
    used += cost;
    kept.push(item);
  }
  return kept;
}

/** A settled read's value, or its failure thrown where the read used to be awaited. */
function settledValue<T>(settled: PromiseSettledResult<T>): T {
  if (settled.status === "rejected") throw settled.reason;
  return settled.value;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

async function collectEligibleSkills(options: ContextAssemblerOptions, input: AssembleContextInput): Promise<ContextSkill[]> {
  const skills: ContextSkill[] = [];
  if (options.skills === undefined) return skills;
  // `SkillActor` has no `agentId`/`runId`/`authority` to carry over: every
  // model call in a workspace sees the same active-skill set today,
  // regardless of which agent/run is asking (skills are scoped to the
  // workspace only). A future agent/run-scoped activation model would need
  // to widen `SkillActor` itself before this derivation could follow suit.
  const skillActor: SkillActor = {
    principalId: input.actor.principalId,
    workspaceId: input.actor.workspaceId,
    caller: input.actor.caller,
  };
  const active: readonly ActiveSkill[] = await options.skills.listActive({ actor: skillActor });
  const skillRollout = options.skillRollout;
  // Each skill's rollout check runs alongside the others; the roster keeps `listActive`'s order, and
  // so does a failure: the first failed check in that order is thrown, as when the checks ran in turn.
  const settled = await Promise.allSettled(
    active.map(async (entry) => {
      // Bounded-rollout enforcement: a PINNED triple is included
      // only for a task on its allowlist — see `skillRollout`'s own doc
      // comment above for why "omit entirely" (not "fall back to an
      // older version") is the safe reading. An unpinned triple (no
      // rollout ever pinned for it) is unaffected.
      if (
        skillRollout !== undefined &&
        (await skillRollout.isPinned({ scopeKey: input.actor.workspaceId, skillId: entry.skillId, version: entry.version }))
      ) {
        return (
          input.actor.runId !== undefined &&
          (await skillRollout.isAllowed({
            scopeKey: input.actor.workspaceId,
            skillId: entry.skillId,
            version: entry.version,
            taskId: input.actor.runId,
          }))
        );
      }
      return true;
    }),
  );
  const included = settled.map(settledValue);
  for (const [index, entry] of active.entries()) {
    if (!included[index]) continue;
    skills.push({
      skillId: entry.skillId,
      version: entry.version,
      name: entry.manifest.name,
      ...(entry.manifest.description === undefined ? {} : { description: entry.manifest.description }),
    });
  }
  return skills;
}

export interface ContextRouting {
  readonly service: RouterPort;
  readonly prepared?: PreparedContextAdvice;
  /** Refresh authorized baseline after a later await without sending broadened data. */
  readonly baselineOnly?: boolean;
  readonly fence: RouterFence;
  readonly turnId: string;
  readonly step: number;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean | Promise<boolean>;
  readonly prompt: string;
  readonly onProjection?: (
    data: Pick<
      ContextProjectionSnapshot,
      "configRevision" | "memoryCandidates" | "memoryExposed" | "retrievalCoverage" | "recommendedSkills" | "exposedSkills"
    >,
    isCurrent: () => boolean | Promise<boolean>,
  ) => void;
}

/** The turn step's recall key (`<turnId>:<step>`): the router's many reads of one step ask the memory provider once. */
export function turnRecallKey(turnId: string, step: number): string {
  return `${turnId}:${step}`;
}

function withRecallKey(input: AssembleContextInput, routing: Pick<ContextRouting, "turnId" | "step">): AssembleContextInput {
  return input.recallKey === undefined ? { ...input, recallKey: turnRecallKey(routing.turnId, routing.step) } : input;
}

/** Collect only authorized excerpts and approved, rollout-eligible metadata before any disclosure. */
export async function collectContextRoutingCandidates(options: ContextAssemblerOptions, input: AssembleContextInput) {
  const memory = options.memory;
  const runId = input.actor.runId;
  const mailboxPort = options.mailbox;
  // The four reads are independent of each other, so they run together.
  const [searchRead, preferencesRead, mailboxRead, skillsRead] = await Promise.allSettled([
    (async (): Promise<MemorySearchResult> =>
      input.query === undefined || memory === undefined
        ? { hits: [], coverage: "complete" }
        : await memory.search({
            actor: input.actor,
            query: input.query,
            purpose: "turn",
            ...definedOnly({
              match: input.queryMatch,
              limit: input.evidenceLimit,
              semantic: input.semantic,
              recallKey: input.recallKey,
              applyFloor: input.applyFloor,
              rankingPriors: input.rankingPriors,
              alreadyShownIds: input.alreadyShownIds,
              includePast: input.includePast,
              range: input.range,
            }),
          }))(),
    (async () =>
      memory === undefined
        ? undefined
        : await memory.resolvePreferences({
            actor: input.actor,
            ...(input.preferenceKeys === undefined ? {} : { keys: input.preferenceKeys }),
            includeProfile: input.includeProfile !== false,
          }))(),
    (async () =>
      mailboxPort === undefined || runId === undefined
        ? []
        : await mailboxPort.listPending(runId, options.mailboxLimit ?? DEFAULT_MAILBOX_LIMIT))(),
    collectEligibleSkills(options, input),
  ]);
  // A memory read that fails is no candidate, never a failed call: `assembleContext` flags it.
  const result: MemorySearchResult = searchRead.status === "fulfilled" ? searchRead.value : { hits: [], coverage: "unavailable" };
  const answer = preferencesRead.status === "fulfilled" ? preferencesRead.value : undefined;
  const preferences: readonly ResolvedPreference[] = answer?.preferences ?? [];
  const profile: readonly ResolvedProfileEntry[] = answer?.profile ?? [];
  // A mailbox or skills failure still fails the call, the mailbox's first, as when they were read in turn.
  const mailbox = settledValue(mailboxRead);
  const skills = settledValue(skillsRead);
  return {
    evidence: result.hits.slice(0, 32),
    // These local-only values fence the entire prompt across later awaits.
    allEvidence: result.hits,
    preferences,
    ...(profile.length === 0 ? {} : { profile }),
    mailbox,
    coverage: result.coverage,
    skills,
  };
}

/** What `collectContextRoutingCandidates` read: the candidates a router question and its currency checks share. */
export type ContextRoutingCandidates = Awaited<ReturnType<typeof collectContextRoutingCandidates>>;

export interface PreparedContextAdvice {
  readonly fingerprint: string;
  readonly configRevision: number;
  readonly receipts: readonly RouterReceipt[];
}

/**
 * Ready context questions can share a request with tool relevance advice.
 *
 * `read` is a configuration and candidate read the caller already made for this step, so the
 * questions are built from it instead of reading both again. Each question's `isCurrent` reads the
 * candidates afresh, since the router may ask it more than once; checks asked while one such read is
 * still running (the router asks every question of a batch at once) share it.
 */
export async function prepareContextAdvice(
  options: ContextAssemblerOptions,
  asked: AssembleContextInput,
  routing: ContextRouting,
  read?: { readonly config: Awaited<ReturnType<RouterPort["configuration"]>>; readonly collected: ContextRoutingCandidates },
) {
  const input = withRecallKey(asked, routing);
  const scope = { workspaceId: input.actor.workspaceId, principalId: input.actor.principalId };
  const config = read?.config ?? (await routing.service.configuration(scope));
  const collected = read?.collected ?? (await collectContextRoutingCandidates(options, input));
  const fingerprint = JSON.stringify(collected);
  let reading: Promise<string> | undefined;
  const currentFingerprint = () =>
    (reading ??= collectContextRoutingCandidates(options, input)
      .then((fresh) => JSON.stringify(fresh))
      .finally(() => {
        reading = undefined;
      }));
  const inputs: RouterDecisionInput[] = [];
  for (const feature of ["memory", "skills"] as const) {
    if (!config.settings.enabled || config.settings.modes[feature] === "off") continue;
    const candidates: RouterCandidate[] =
      feature === "memory"
        ? collected.evidence.map((hit) => ({ id: hit.recordId, revision: hit.revisionId, description: hit.snippet.slice(0, 2000) }))
        : collected.skills.map((skill) => ({
            id: skill.skillId,
            revision: skill.version,
            description: `${skill.name}: ${skill.description ?? ""}`.slice(0, 2000),
          }));
    inputs.push({
      scope,
      fence: routing.fence,
      turnId: routing.turnId,
      operationId: sha256Hex(JSON.stringify([routing.turnId, routing.step, feature])),
      feature,
      permissionRevision: sha256Hex(fingerprint),
      prompt: routing.prompt,
      candidates,
      signal: routing.signal,
      isCurrent: async () => (await routing.isCurrent()) && (await currentFingerprint()) === fingerprint,
    });
  }
  return {
    inputs,
    accept: (receipts: readonly RouterReceipt[]): PreparedContextAdvice => ({ fingerprint, configRevision: config.revision, receipts }),
  };
}

/**
 * Async advice precedes deterministic budgeting; every final record is read again after inference.
 *
 * Asking the router here, the candidates are read once before inference (the questions share that
 * read) and once after it (`fresh`). With `routing.prepared` the caller's batch has already asked,
 * so the one read made here is the post-inference read: `prepared.fingerprint` is compared against it
 * and it is `fresh` too. Every currency check of the step compares against that one post-inference
 * read. `assembleContext` keeps its own reads: its search limit differs. Only `onProjection`'s
 * `isCurrent`, which its caller may ask later, reads them again.
 */
export async function assembleRoutedContext(
  options: ContextAssemblerOptions,
  asked: AssembleContextInput,
  routing: ContextRouting,
): Promise<ContextManifest> {
  const input = withRecallKey(asked, routing);
  const scope = { workspaceId: input.actor.workspaceId, principalId: input.actor.principalId };
  const config = await routing.service.configuration(scope);
  const collected = await collectContextRoutingCandidates(options, input);
  const fingerprint = JSON.stringify(collected);
  const answered: { readonly feature: "memory" | "skills"; readonly receipt: RouterReceipt }[] = [];
  let questions: readonly RouterDecisionInput[] | undefined;
  for (const feature of ["memory", "skills"] as const) {
    if (routing.baselineOnly === true || !config.settings.enabled || config.settings.modes[feature] === "off") continue;
    let receipt: RouterReceipt | undefined;
    if (routing.prepared !== undefined) {
      if (routing.prepared.configRevision !== config.revision || routing.prepared.fingerprint !== fingerprint) continue;
      receipt = routing.prepared.receipts.find((entry) => entry.feature === feature);
    } else {
      questions ??= (await prepareContextAdvice(options, input, routing, { config, collected })).inputs;
      const question = questions.find((entry) => entry.feature === feature);
      if (question !== undefined) receipt = await routing.service.decide(question);
    }
    if (receipt === undefined) continue;
    if (!(await routing.isCurrent()) || routing.signal.aborted) throw new TaviError("UNAVAILABLE", "Context routing lost task authority");
    answered.push({ feature, receipt });
  }
  // The post-inference refresh, read once: a record revoked or changed while the router thought drops its advice.
  // Without a question asked here, no inference ran since `collected` was read, so it is that refresh.
  const fresh = questions === undefined ? collected : await collectContextRoutingCandidates(options, input);
  const finalFingerprint = fresh === collected ? fingerprint : JSON.stringify(fresh);
  const current = async () => (await routing.isCurrent()) && finalFingerprint === fingerprint;
  let evidenceOrder: ContextProjection["evidenceOrder"];
  let recommendedSkills: ContextProjection["recommendedSkills"];
  for (const { feature, receipt } of answered) {
    if (!(await current()) || receipt.mode !== "active" || (await routing.service.configuration(scope)).revision !== config.revision)
      continue;
    if (feature === "memory" && receipt.selectedIds.length > 0) {
      evidenceOrder = [
        ...collected.evidence.filter((hit) => hit.conflict || hit.kind === "preference"),
        ...collected.evidence
          .filter((hit) => !hit.conflict && hit.kind !== "preference" && receipt.selectedIds.includes(hit.recordId))
          .sort((a, b) => (receipt.probabilities[b.recordId] ?? 0) - (receipt.probabilities[a.recordId] ?? 0)),
      ];
    }
    if (feature === "skills") {
      const explicit = new Set([...routing.prompt.matchAll(/\$([\p{L}\p{N}_.:/-]+)/gu)].map((match) => match[1]?.toLocaleLowerCase()));
      const requested = collected.skills.filter(
        (skill) => explicit.has(skill.skillId.toLocaleLowerCase()) || explicit.has(skill.name.toLocaleLowerCase()),
      );
      const optional = collected.skills.filter((skill) => !requested.includes(skill) && receipt.selectedIds.includes(skill.skillId));
      recommendedSkills = [...requested, ...optional.slice(0, Math.max(0, 8 - requested.length))];
    }
  }
  // A changed revision invalidates all advice; assembly still uses the fresh authorized baseline.
  const projection =
    (await current()) && (await routing.service.configuration(scope)).revision === config.revision
      ? {
          ...(evidenceOrder === undefined ? {} : { evidenceOrder }),
          ...(recommendedSkills === undefined ? {} : { recommendedSkills }),
        }
      : undefined;
  const manifest = await assembleContext(options, input, projection);
  routing.onProjection?.(
    {
      configRevision: config.revision,
      memoryCandidates: fresh.evidence.map(({ recordId, revisionId }) => ({ recordId, revisionId })),
      memoryExposed: manifest.evidence.map(({ recordId, revisionId }) => ({ recordId, revisionId })),
      retrievalCoverage: fresh.coverage,
      recommendedSkills: (manifest.recommendedSkills ?? []).map(({ skillId, version }) => ({ skillId, version })),
      exposedSkills: manifest.skills.map(({ skillId, version }) => ({ skillId, version })),
    },
    async () =>
      (await routing.isCurrent()) &&
      (await routing.service.configuration(scope)).revision === config.revision &&
      JSON.stringify(await collectContextRoutingCandidates(options, input)) === finalFingerprint,
  );
  return manifest;
}
