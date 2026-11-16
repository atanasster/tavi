import {
  type AgentDefinition,
  type ChatInstructionsRevision,
  type AgentMailboxRepositoryPort,
  type InvocationContext,
  type MemoryActor,
  type MemoryServicePort,
  type ModelMessage,
  type PromptLayout,
  type SkillRepositoryPort,
  type SkillRolloutRepositoryPort,
  type SkillServicePort,
  type BoundTaskPromptSnapshot,
  TaviError,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import {
  assembleContext,
  assembleRoutedContext,
  MEMORY_UNAVAILABLE_LINE,
  memoryUnavailableReason,
  type ContextManifest,
  type ContextRouting,
} from "../context/context.js";
import { composeSystemPromptLayers, snapshotBase } from "../prompts/system-prompt.js";
import { renderContextManifest } from "./context-block.js";
import type { MemoryRecallSwitches } from "./options.js";
import type { TurnRetrievalQuery } from "./retrieval.js";

/**
 * The instructions a task runs under: the task's selected base prompt, then the
 * persona of the agent definition it named, then the
 * chat's own instructions as the turn pinned them.
 *
 * Delegates to `composeSystemPromptLayers`, the one composition `system-prompt
 * preview` also lists its layers from, so the preview cannot drift from the
 * request. The rules — persona appended, base
 * never trimmed, a blank or absent persona leaving the base byte for byte — are
 * documented there.
 */
export function composeAgentPrompt(
  snapshot: BoundTaskPromptSnapshot,
  definition: AgentDefinition | undefined,
  chat: ChatInstructionsRevision | undefined,
): string {
  return composeSystemPromptLayers({
    base: snapshotBase(snapshot),
    ...(definition === undefined ? {} : { persona: definition }),
    ...(chat === undefined ? {} : { chat: { text: chat.text, revision: chat.revision } }),
  }).text;
}

export interface SystemPromptResult {
  /** The system string: the instructions alone, never memory. */
  readonly text: string;
  /** The rendered manifest, for the call's context block (`withContextMessage`); empty when there is none. */
  readonly context: string;
  /** Why memory could not be read for this call, when it could not: logged once per turn. */
  readonly memoryUnavailable?: string;
  /** The memory revisions the context retrieved as evidence (profile-only entries are excluded unless they also matched the turn's retrieval query). */
  readonly memory: readonly { readonly recordId: string; readonly revisionId: string }[];
  /** How many resolved preferences the context carried: counted, never listed. */
  readonly preferences: number;
  /** The assembled manifest `context` was rendered from, when one was: a delta of it is what `models.promptLayout` `v2` sends. */
  readonly manifest?: ContextManifest;
}

export function contextActor(invocation: InvocationContext): MemoryActor {
  return {
    principalId: invocation.principalId,
    workspaceId: invocation.workspaceId,
    runId: invocation.runId,
    caller: invocation.caller,
    authority: "model",
    // Threaded straight from the checkpointed `invocation`:
    // a spawned worker's own admitted context carries these, set once
    // by `contextFrom`/`spawn()` (`packages/agent-host/src/agents/agent-communication.ts`)
    // and re-derived on every later admission that touches its task.
    ...definedOnly({
      scopeRestricted: invocation.memoryScopeRestricted,
      allowedRecordIds: invocation.delegatedMemoryRecordIds,
      chatTaskId: invocation.chatTaskId,
      parentChatId: invocation.parentChatId,
    }),
    // The chat's persona: its own `personal_agent` memory is read too.
    // The memory service grants that scope only for this principal, and never
    // to a restricted (delegated) actor, so it widens nothing else.
    ...(invocation.agentDefinitionId === undefined ? {} : { agentId: invocation.agentDefinitionId }),
    // A group conversation reads only its chat's notes: the service enforces it.
    ...(invocation.memoryReach === undefined ? {} : { reach: invocation.memoryReach }),
  };
}

/**
 * Build the model node's system prompt text for one call, and the rendered
 * manifest its context block carries (`context`): the system
 * string is `baseSystemPrompt` itself, whatever memory finds.
 *
 * When neither `memory` nor `keepManifest` is given, returns
 * `baseSystemPrompt` with no context, as an adapter without a memory service
 * always did. `keepManifest` is a call whose memory is off — paused for the
 * workspace or off for the chat — on an adapter that has memory: its skills
 * and mailbox are still assembled, with no preference or evidence read.
 *
 * Memory trouble never fails the call (invariant 10):
 * `assembleContext` flags a failed memory read itself, and any other failure
 * here degrades to a context of `MEMORY_UNAVAILABLE_LINE` alone, never
 * silently. The one exception is `INVALID_INPUT`, which `assembleContext`
 * now raises only for mandatory instructions that cannot fit the budget:
 * that propagates and fails the run, since the caller's
 * `maxContextTokens` is too tight for text that must not be dropped. A port
 * that throws `INVALID_INPUT` for an unrelated reason outside the memory
 * reads (a skills or mailbox port) is treated the same way.
 */
export async function buildSystemPromptText(
  memory: MemoryServicePort | undefined,
  skills: SkillServicePort | undefined,
  mailbox: AgentMailboxRepositoryPort | undefined,
  skillRollout: SkillRolloutRepositoryPort | undefined,
  limits: {
    readonly maxTokens: number;
    readonly evidence: number;
    readonly keepManifest?: boolean;
    readonly includeProfile?: boolean;
    readonly recall?: MemoryRecallSwitches;
  },
  baseSystemPrompt: string,
  invocation: InvocationContext,
  query: TurnRetrievalQuery | undefined,
  routing?: ContextRouting,
  /** The turn step's `recallKey`, so this read and the router's ask the memory provider once; a routed read sets its own. */
  recallKey?: string,
  /** The workspace's skill uses: past the listing cap, the recently used skills are listed first. */
  skillUsage?: Pick<SkillRepositoryPort, "listUsage">,
): Promise<SystemPromptResult> {
  if (memory === undefined && limits.keepManifest !== true) return { text: baseSystemPrompt, context: "", memory: [], preferences: 0 };
  const actor = contextActor(invocation);
  try {
    const assemble =
      routing === undefined
        ? assembleContext
        : (options: Parameters<typeof assembleContext>[0], input: Parameters<typeof assembleContext>[1]) =>
            assembleRoutedContext(options, input, routing);
    const manifest = await assemble(
      {
        ...definedOnly({
          memory,
          skills,
          mailbox,
          skillRollout,
          skillUsage,
        }),
        maxTokens: limits.maxTokens,
      },
      {
        actor,
        instructions: baseSystemPrompt,
        ...(limits.includeProfile === false || limits.recall?.profile === false ? { includeProfile: false } : {}),
        // `limits.evidence` of 0 retrieves nothing: no query is run.
        ...(query === undefined || limits.evidence === 0
          ? {}
          : {
              query: query.keywords,
              queryMatch: "any" as const,
              evidenceLimit: limits.evidence,
              applyFloor: limits.recall?.relevanceFloor !== false,
              ...(limits.recall?.rankingPriors === false ? { rankingPriors: false } : {}),
              ...(query.semantic === undefined ? {} : { semantic: query.semantic }),
              ...(query.alreadyShownIds === undefined ? {} : { alreadyShownIds: query.alreadyShownIds }),
              ...(query.range === undefined || limits.recall?.temporalRanking === false
                ? {}
                : {
                    range: { from: query.range.from, to: query.range.to },
                    ...(query.range.pastOnly ? { includePast: true } : {}),
                  }),
            }),
        ...(recallKey === undefined ? {} : { recallKey }),
      },
    );
    return {
      // The manifest goes in the call's context block, not after the instructions.
      text: baseSystemPrompt,
      context: renderContextManifest(manifest),
      memory: manifest.evidence.map(({ recordId, revisionId }) => ({ recordId, revisionId })),
      preferences: manifest.preferences.length,
      manifest,
      ...(manifest.memoryUnavailable ? { memoryUnavailable: manifest.memoryUnavailableReason ?? "memory unavailable" } : {}),
    };
  } catch (error) {
    // Routed context fails as it did: a memory read cannot cause it (`assembleContext` and its
    // candidates flag those), so what is left is the router's or the task's authority.
    if (routing !== undefined) throw error;
    if (error instanceof TaviError && error.code === "INVALID_INPUT") {
      throw error;
    }
    if (memory === undefined) return { text: baseSystemPrompt, context: "", memory: [], preferences: 0 };
    return {
      text: baseSystemPrompt,
      context: MEMORY_UNAVAILABLE_LINE,
      memory: [],
      preferences: 0,
      memoryUnavailable: memoryUnavailableReason(error),
    };
  }
}

/**
 * End a model request with this call's step facts (`renderStepFacts`).
 *
 * Last, so everything before them — system prompt and history — is the prefix
 * the previous call of the turn sent, which a provider's automatic prefix cache
 * can reuse. Appended to a trailing user message rather than sent as a second
 * one, because some chat templates refuse two user turns in a row; after a tool
 * result (every later step) they are a user message of their own. Never a
 * `system` message: the model adapter lifts every system message into the
 * leading instructions, which would put them back in the prefix.
 */
export function withStepFacts(
  messages: readonly ModelMessage[],
  stepFacts: string,
  id: string,
  createdAt: string,
  /**
   * `v2` (`models.promptLayout`): on a trailing user message the facts are its
   * `trailer`, a content part of their own, so the message's own words end
   * where the next call's copy of it ends; `v1` joins them to its text.
   */
  layout: PromptLayout = "v1",
): ModelMessage[] {
  const last = messages.at(-1);
  if (last?.role === "user")
    return [
      ...messages.slice(0, -1),
      layout === "v2" ? { ...last, trailer: stepFacts } : { ...last, text: `${last.text}\n\n${stepFacts}` },
    ];
  return [...messages, { id, role: "user", text: stepFacts, createdAt }];
}
