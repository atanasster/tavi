import {
  type ToolDefinition,
  type ContextProjectionSnapshot,
  type ConversationFold,
  type ModelCallSite,
  type PromptLayout,
  type ModelToolDescriptor,
  TaviError,
  type WorkflowMessage,
  type AgentStateData,
} from "@tavi/contracts";
import type { PreparedContextAdvice } from "../../../context/context.js";
import { compactSupersededObservations } from "../../compaction.js";
import { withoutMemoryBlocks, type ContextDelta } from "../../context-block.js";
import { modelSummariesAsData } from "../../model-summary.js";
import type { SystemPromptResult, buildSystemPromptText } from "../../prompt.js";
import { threadIdOf } from "../../run-config.js";
import type { WorkflowScope } from "../../scope.js";
import type { PromptMessage } from "../../tool-hooks.js";
import type { ToolOffer } from "./offer.js";
import type { RunnableConfig } from "@langchain/core/runnables";

/** The ledger's site for a task's model calls by its origin, where the origin alone decides it. */
const ORIGIN_SITES: Partial<Record<string, ModelCallSite>> = { heartbeat: "heartbeat", ideas: "ideas", agent: "worker" };

/** `ORIGIN_SITES`' site for a task's origin, if any. */
export function originSite(origin: string | null | undefined): ModelCallSite | undefined {
  return origin === null || origin === undefined ? undefined : ORIGIN_SITES[origin];
}

/** The ledger's site for a chat turn's call by its place in the turn. */
export function turnStepSite(finalStep: boolean, turnStepsSoFar: number): ModelCallSite {
  if (finalStep) return "final-step";
  return turnStepsSoFar === 0 ? "chat-step1" : "chat-stepN";
}

/** The model a call went to, as `promptCacheModel` names it. */
export function cacheModelKey(target: { readonly connectionId: string; readonly model: string }): string {
  return `${target.connectionId}/${target.model}`;
}

/** `unknownWindowTriggerTokens` for a target, `undefined` when it is not set or fails. */
export async function unknownWindowTriggerFor(
  options: WorkflowScope["options"],
  target: { readonly connectionId: string; readonly model: string },
): Promise<number | undefined> {
  try {
    return await options.unknownWindowTriggerTokens?.(target);
  } catch {
    return undefined;
  }
}

/**
 * One model step: what its parts share, built once when the step passes its guards. Its mutable fields
 * (the fold, the model chain, the conversation for this call, `epochBegins`, `foldedPersons`,
 * `forgottenPersons`, `memoryCheckFailed` and `pendingFlush`) change as the step folds and routes, and
 * are read only through it.
 */
export interface ModelStep {
  readonly scope: WorkflowScope;
  readonly config: RunnableConfig;
  readonly admission: ReturnType<WorkflowScope["observers"]["get"]>;
  readonly authorizedModels: ReturnType<WorkflowScope["authorizeModels"]>;
  readonly steered: Awaited<ReturnType<WorkflowScope["takeSteers"]>>;
  readonly steerMessages: PromptMessage[];
  readonly current: AgentStateData;
  readonly facts: ReturnType<WorkflowScope["stepFactsOf"]>;
  readonly latestUser: string | undefined;
  readonly newTurn: boolean;
  readonly layout: PromptLayout;
  readonly turnStepsSoFar: number;
  /** What every return that took a model step writes of the turn. */
  readonly turnAdvance: {
    readonly turnSteps: number;
    readonly turnMessageId?: string;
    readonly turnToolCalls?: number;
    readonly turnSteers?: string[];
  };
  readonly taskMaxSteps: number;
  /** A chat with no saved route runs the default as configured when its turn began. */
  modelChain: Awaited<ReturnType<WorkflowScope["turnBaseline"]>>;
  /**
   * Whether this step's turn begins a new epoch (a rollover on its first step): under `v2` the epoch's
   * discovered and routed tools go with the old one. A rollover later in a turn keeps them until it ends.
   */
  epochBegins: boolean;
  fold: ConversationFold | undefined;
  conversationForThisCall: AgentStateData["conversation"];
  /** Under `v2`, the person messages a stage-2 fold left behind, their blocks cleared (`personsBehindFold`). */
  foldedPersons: readonly WorkflowMessage[];
  /**
   * Under `v2`, the person messages whose kept block showed a memory since forgotten (or deleted, or revoked),
   * their blocks cleared: dropped from this call and written back so the checkpoint no longer holds the text.
   * The turn's own block is then written afresh (`contextDelta`), showing again what else they carried.
   */
  forgottenPersons: readonly WorkflowMessage[];
  /**
   * Under `v2`, whether what is forgotten could not be read this call: every kept block that showed memory is
   * left out, so the turn's block is rebuilt against that reduced view, and it is not kept (as after a failed
   * call), or once the store answers again the restored blocks and it would both show the same content.
   */
  memoryCheckFailed: boolean;
  /**
   * The span this step's rollover folds, for the flush, which runs
   * once the turn's route is known — a pinned or routed model, not the
   * default — and still before the step writes the fold.
   */
  pendingFlush: { readonly conversation: readonly WorkflowMessage[]; readonly removeIds: readonly string[] } | undefined;
}

/**
 * The step's model call: what the parts from its system prompt on share, built once with that prompt.
 * The attempt, the prompt and its routed context, the tool descriptors and the block sent change as the
 * call is routed, retried and failed over, and are read only through it.
 */
export interface ModelCall {
  readonly step: ModelStep;
  readonly executionPolicy: Awaited<ReturnType<ModelStep["facts"]["policy"]>>;
  readonly finalStep: boolean;
  readonly documentFound: ToolOffer["documentFound"];
  readonly discoveredNow: ToolOffer["discoveredNow"];
  readonly toolScope: ToolOffer["toolScope"];
  readonly timezone: ToolOffer["timezone"];
  readonly offeredTools: readonly ToolDefinition[];
  /** The tools a routed shortlist offered, kept for the epoch's next turn (`routedToolIds`) under `v2`. */
  readonly routedNow: readonly string[] | undefined;
  readonly preparedContextAdvice: PreparedContextAdvice | undefined;
  readonly toolCatalogFingerprint: string | undefined;
  readonly toolConfigRevision: number | undefined;
  readonly turnOrigin: Awaited<ReturnType<ModelStep["facts"]["origin"]>>;
  readonly turnMemory: WorkflowScope["options"]["memory"];
  readonly memoryTurnedOff: boolean;
  readonly turnPerson: WorkflowMessage | undefined;
  readonly contextKept: boolean;
  readonly turnChannels: string | undefined;
  readonly mandatoryPrefix: string;
  readonly stepFacts: string;
  readonly contextLimits: Parameters<typeof buildSystemPromptText>[4];
  readonly contextBudget: number;
  attemptId: string;
  toolDisclosureRequired: boolean;
  systemPromptResult: SystemPromptResult;
  systemPromptText: string;
  refreshRoutedContext: ((baselineOnly: boolean) => Promise<void>) | undefined;
  contextIsCurrent: (() => boolean | Promise<boolean>) | undefined;
  contextProjection: Omit<ContextProjectionSnapshot, "taskId" | "attemptId" | "createdAt"> | undefined;
  descriptors: ModelToolDescriptor[];
  /** The block this call's turn person message carries under `v2`, when this call writes it: persisted with the step. */
  sentDelta: ContextDelta | undefined;
}

/** The chain's target at `index`: a turn's baseline names at least one, so none is a configuration that cannot run. */
export function targetAt(step: ModelStep, index: number) {
  const target = step.modelChain[index];
  if (target === undefined) throw new TaviError("NOT_CONFIGURED", "no model target is configured for this chat");
  return target;
}

async function waiting(step: ModelStep, index: number): Promise<boolean> {
  const { targetWaiting } = step.scope;
  return targetWaiting(targetAt(step, index));
}

export async function firstReady(step: ModelStep, after = -1): Promise<number> {
  for (let index = after + 1; index < step.modelChain.length; index++) if (!(await waiting(step, index))) return index;
  return after === -1 ? 0 : -1;
}

/** The turn's query options: now, in the workspace's timezone when it has one. */
export function turnQueryOptions(step: ModelStep, timezone: string | undefined) {
  const { now } = step.scope;
  return { now: now(), ...(timezone === undefined ? {} : { timeZone: timezone }) };
}

/**
 * The conversation as this call shows it to the model, read afresh (a rollover may change it): observations a later
 * one supersedes compacted, summaries as data, and under `v2` with memory turned off no kept block that showed memory.
 * The estimates and the request alike count this view.
 */
export function callView(ctx: ModelCall): readonly WorkflowMessage[] {
  const { step, memoryTurnedOff } = ctx;
  const { layout } = step;
  const { supersededObservationStride } = step.scope;
  return withoutMemoryBlocks(
    modelSummariesAsData(compactSupersededObservations(step.conversationForThisCall, supersededObservationStride)),
    layout === "v2" && memoryTurnedOff,
  );
}

// Memory that could not be read is said in the prompt and logged once per turn.
export function noteMemoryUnavailable(step: ModelStep, result: SystemPromptResult): void {
  const { config, current } = step;
  const { options, turnBaselines } = step.scope;
  if (result.memoryUnavailable === undefined) return;
  const turn = turnBaselines.get(threadIdOf(config));
  if (turn?.memoryUnavailableLogged === true) return;
  if (turn !== undefined) turn.memoryUnavailableLogged = true;
  options.onDiagnostic?.("memory could not be read for a turn; its prompt says memory is unavailable", {
    taskId: current.runId,
    error: result.memoryUnavailable,
  });
}
