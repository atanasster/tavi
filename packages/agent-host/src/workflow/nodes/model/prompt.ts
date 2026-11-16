import { isPlumbingOrigin, BROWSER_REQUEST_HANDOFF_TOOL_ID, MAX_TOOL_RESULT_BYTES, TaviError, type WorkflowMessage } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { turnRecallKey, defaultEstimateTokens } from "../../../context/context.js";
import {
  NO_REACHABLE_CHANNELS_LINE,
  renderReachableChannels,
  renderRuntimeFacts,
  renderStepFacts,
  type RuntimeFactsInput,
} from "../../../prompts/system-prompt.js";
import { PDF_TOOLS, TOOL_SEARCH_ID, VIDEO_TOOLS } from "../../../tools/tool-routing.js";
import { turnOpeningPerson } from "../../context-block.js";
import { buildSystemPromptText } from "../../prompt.js";
import { REPEAT_REFUSED_AT, readOnlyToolOf, repeatedToolCall } from "../../repeats.js";
import { turnRetrievalQueryFrom } from "../../retrieval.js";
import { executionLeaseOf } from "../../run-config.js";
import { CHANNEL_REPLY_TOOL } from "../../scope/gate.js";
import { AGENTS_WAIT_TOOL_ID, ASK_USER_TOOL_ID } from "../../waits.js";
import { type ModelStep, type ModelCall, turnQueryOptions, noteMemoryUnavailable } from "./context.js";
import type { ToolOffer } from "./offer.js";
import type { Instructions } from "./instructions.js";

/**
 * The step's system prompt: the runtime and step facts, the memory checks and the prompt built on them. The
 * model call's context is built with it.
 */
export async function buildModelCall(step: ModelStep, instructions: Instructions, offer: ToolOffer, attemptId: string): Promise<ModelCall> {
  const { promptSnapshot, executionPolicy, instructionPrefix } = instructions;
  const { finalStep, factsTools, proposeAuthorized, turnToolIds, linksUncheckable, timezone, offeredTools } = offer;
  const { config, current, facts, latestUser, layout, taskMaxSteps } = step;
  const { approvalFor, maxToolCalls, now, options } = step.scope;
  // A loop the model is in, and on the final step what the task kept to answer from.
  const repeatedCall = repeatedToolCall(step.conversationForThisCall, readOnlyToolOf(options.tools));
  let keptFindings: string | undefined;
  if (finalStep && options.keptFindings !== undefined) {
    try {
      keptFindings = await options.keptFindings(current.invocation.workspaceId, current.runId);
    } catch (error) {
      // The answer goes on without them; the failure is said, not hidden.
      options.onDiagnostic?.("the task's kept findings could not be read for its final step", {
        taskId: current.runId,
        error: errorMessage(error),
      });
    }
  }
  // The workspace's memory settings, read for this call: paused memory is a no-memory
  // call too, and the section's `limits.contextTokens` is the budget (the adapter's `maxContextTokens`
  // only its default), its `limits.evidence` the bound on retrieved records.
  const memorySettings = await facts.memorySettings();
  // `tasks.home`: a task app of the person's own takes their to-dos.
  const tasksHome = await options.tasksHomeServer?.(current.invocation.workspaceId);
  const contextBudget = memorySettings.limits.contextTokens;
  // A chat with memory off, or a private one, is a no-memory call too.
  const chatMemoryOff = (await facts.chatMemory()).mode !== undefined;
  const turnOrigin = await facts.origin();
  // A heartbeat tick, or an idea's prepared step: plumbing, which reads no memory.
  const heartbeatTurn = isPlumbingOrigin(turnOrigin);
  // A schedule's fire is a routine's: no manifest, as a routine's own workflow has none.
  const scheduledTurn = turnOrigin === "schedule";
  // Memory the person turned off (paused, off for this chat, or withheld), as against a plumbing turn's.
  const memoryTurnedOff = !memorySettings.enabled || chatMemoryOff || options.memoryWithheld?.(current.runId) === true;
  const turnMemory = memoryTurnedOff || heartbeatTurn || scheduledTurn ? undefined : options.memory;
  // `models.promptLayout` `v2`: the turn's context block rides on its opening person message, written on the
  // turn's first call (`contextDelta`) and sent unchanged by every later one. A turn with no person message
  // (an agent's wake) keeps the per-call block.
  const turnPerson: WorkflowMessage | undefined = layout === "v2" ? turnOpeningPerson(step.conversationForThisCall, latestUser) : undefined;
  // A later call of the turn reuses the block its first call wrote: no recall, no routed context, again.
  const contextKept = turnPerson?.contextText !== undefined;
  // Under `v2`, the channels the turn can send through, said in its context block instead of the runtime facts.
  const turnChannels =
    layout === "v2" && turnToolIds.has("messaging.send_to") && options.reachableChannels !== undefined
      ? (renderReachableChannels(options.reachableChannels(current.invocation.workspaceId)) ?? NO_REACHABLE_CHANNELS_LINE)
      : undefined;
  const factsInput: RuntimeFactsInput = {
    policy: executionPolicy,
    // Per response, not per task: `maxSteps`/`maxToolCalls` bound the turn.
    // The raw index and ceiling go in; `renderRuntimeFacts` derives how many
    // steps can *follow* this one, which is not `maxSteps - turnSteps`.
    stepIndex: current.turnSteps + 1,
    maxSteps: taskMaxSteps,
    toolCallsRemaining: Math.max(0, maxToolCalls - current.turnToolCalls),
    approvalRequiredFor: [...approvalFor],
    toolsOffered: turnToolIds.size > 0,
    toolSearchOffered: turnToolIds.has(TOOL_SEARCH_ID),
    toolsListedOnFinalStep: layout === "v2" && turnToolIds.size > 0,
    finalStep,
    askUserOffered: turnToolIds.has(ASK_USER_TOOL_ID),
    waitsOffered: turnToolIds.has(AGENTS_WAIT_TOOL_ID),
    browserOffered: [...turnToolIds].some((id) => id.startsWith("browser.")),
    handoffOffered: turnToolIds.has(BROWSER_REQUEST_HANDOFF_TOOL_ID),
    extractOffered: turnToolIds.has("browser.extract"),
    batchOffered: turnToolIds.has("browser.batch"),
    spawnOffered: turnToolIds.has("agents.spawn"),
    checkOffered: turnToolIds.has("findings.check"),
    findOffered: turnToolIds.has("browser.find"),
    visionOffered: turnToolIds.has("browser.vision_act"),
    // Each offered built-in tool's own line, in tool-id order so the prompt's bytes stay put.
    toolGuidance: [...factsTools]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .flatMap((definition) => (definition.promptGuidance === undefined ? [] : [definition.promptGuidance])),
    linksUncheckable,
    // Any PDF tool: each returns the document's words, whose hidden text is data.
    pdfOffered: PDF_TOOLS.some((id) => turnToolIds.has(id)),
    // Any video tool: how frames are read, that angles come only from video.pose, and that no one is identified.
    videoOffered: VIDEO_TOOLS.some((id) => turnToolIds.has(id)),
    ...(repeatedCall === undefined
      ? {}
      : {
          repeatedCall: {
            tool: repeatedCall.tool,
            times: repeatedCall.times,
            refusedNext: repeatedCall.times >= REPEAT_REFUSED_AT,
            ...(repeatedCall.alternate === undefined ? {} : { alternate: repeatedCall.alternate }),
          },
        }),
    ...(keptFindings === undefined ? {} : { keptFindings }),
    ...(tasksHome === undefined ? {} : { tasksHomeServer: tasksHome }),
    outputLimitBytes: MAX_TOOL_RESULT_BYTES,
    // A capability, and a coarse one: an artifact repository is wired exactly
    // when the adapter may archive (without one `archiveToolOutput` can only
    // truncate). Archiving itself is best-effort — the store can refuse to write
    // one — so the rendered sentence is conditional rather than a promise.
    reviewEnabled: options.artifacts !== undefined,
    ...(timezone === undefined ? {} : { localTime: { now: now(), timezone } }),
    // The turn's folder, stamped once at admission: the same bytes for every call of the turn.
    ...(current.invocation.folder === undefined ? {} : { folder: current.invocation.folder }),
    ...(current.invocation.folderUnavailable === undefined ? {} : { folderUnavailable: current.invocation.folderUnavailable }),
    sendToOffered: turnToolIds.has("messaging.send_to"),
    // A schedule's run that tells its person only when there is something is told how to say there is nothing.
    ...(current.invocation.scheduleNotify === undefined ? {} : { quietAllowed: true }),
    // A message-started turn answers on its channel, so it is told to reply with the tool.
    ...(current.invocation.messagingReplyTo === undefined || !turnToolIds.has(CHANNEL_REPLY_TOOL)
      ? {}
      : { replyOffered: current.invocation.messagingReplyTo.audience === "one-to-one" ? "direct" : "shared" }),
    // `v2` says the reachable channels in the turn's context block (`turnChannels`), where a reconnect changes no system text;
    // a turn with no person message (an agent's wake) has no such block, so its runtime facts still say them.
    ...(options.reachableChannels === undefined || (layout === "v2" && turnPerson !== undefined)
      ? {}
      : { channels: options.reachableChannels(current.invocation.workspaceId) }),
    // Memory guidance: the propose part where the chat is offered the tool and the call has
    // memory (never a heartbeat tick's, a routine's or a schedule's fire; a final step's no-tools notice is
    // in its step facts); "not authoritative" wherever memory is enabled
    // for the call — a manifest, or a heartbeat tick's own block when its prompt may carry one — whatever the call found.
    memoryProposeOffered: proposeAuthorized && turnMemory !== undefined,
    memoryInUse:
      turnMemory !== undefined ||
      (heartbeatTurn && options.memory !== undefined && memorySettings.enabled && options.heartbeatMemoryShown?.(current.runId) === true),
  };
  // The turn-stable facts join the system prompt; the per-call ones (step,
  // budget, local time) go after the conversation (`withStepFacts`), so every
  // call of a turn shares one byte-identical prefix a provider can cache.
  const mandatoryPrefix = `${instructionPrefix}\n\n${renderRuntimeFacts(factsInput)}`;
  const stepFacts = renderStepFacts(factsInput);
  // No-memory accounting. `assembleContext` already checks the
  // mandatory prefix whenever memory is configured, for *every* source, so
  // this covers only the path that skips it — and only the ordinary
  // workspace/built-in selections: a no-memory *explicit*
  // adapter prompt (a routine's composed instructions) kept its prior behavior
  // and must keep it now, or this check would begin failing runs that pass
  // today.
  // A heartbeat turn kept from the person's memory is a no-memory turn here too. So is every
  // heartbeat turn, as a routine's is: the host's bounded, redacted and recorded block in its prompt is its
  // only automatic memory, never a manifest retrieved by words its signals steer.
  // The memory settings, the chat's mode and `turnMemory` are read above, before the facts.
  if (turnMemory === undefined && promptSnapshot.source !== "explicit") {
    const budget = contextBudget;
    const estimated = defaultEstimateTokens(mandatoryPrefix);
    if (estimated > budget) {
      // `INVALID_INPUT` specifically: `buildSystemPromptText` rethrows that
      // code and degrades on everything else, so any other code would make
      // this failure silent.
      throw new TaviError("INVALID_INPUT", `Mandatory instructions (${estimated} estimated tokens) exceed the context budget (${budget})`, {
        details: { estimatedTokens: estimated, maxTokens: budget, source: promptSnapshot.source },
      });
    }
  }
  // Memory paused or off for the chat still leaves the skills and the mailbox; a heartbeat
  // turn's prompt carries no manifest at all, and a no-memory explicit prompt keeps
  // its prior, unchecked path.
  const keepManifest =
    turnMemory === undefined &&
    options.memory !== undefined &&
    !heartbeatTurn &&
    !scheduledTurn &&
    options.memoryWithheld?.(current.runId) !== true &&
    promptSnapshot.source !== "explicit";
  const contextLimits = {
    maxTokens: contextBudget,
    evidence: memorySettings.limits.evidence,
    keepManifest,
    ...(options.memoryRecall === undefined ? {} : { recall: options.memoryRecall }),
  };
  const stepLease = executionLeaseOf(config);
  const systemPromptResult = await buildSystemPromptText(
    turnMemory,
    options.skills,
    options.mailbox,
    options.skillRollout,
    contextLimits,
    mandatoryPrefix,
    current.invocation,
    contextKept ? undefined : turnRetrievalQueryFrom(step.conversationForThisCall, turnQueryOptions(step, timezone)),
    undefined,
    // The same key the router's reads of this step derive from its turn and step.
    stepLease === undefined ? undefined : turnRecallKey(stepLease.admissionId, current.steps),
    options.skillUsage,
  );
  noteMemoryUnavailable(step, systemPromptResult);
  return {
    step,
    executionPolicy,
    finalStep,
    documentFound: offer.documentFound,
    discoveredNow: offer.discoveredNow,
    toolScope: offer.toolScope,
    timezone,
    offeredTools,
    routedNow: offer.routedNow,
    preparedContextAdvice: offer.preparedContextAdvice,
    toolCatalogFingerprint: offer.toolCatalogFingerprint,
    toolConfigRevision: offer.toolConfigRevision,
    turnOrigin,
    turnMemory,
    memoryTurnedOff,
    turnPerson,
    contextKept,
    turnChannels,
    mandatoryPrefix,
    stepFacts,
    contextLimits,
    contextBudget,
    attemptId,
    toolDisclosureRequired: offer.toolDisclosureRequired,
    systemPromptResult,
    systemPromptText: systemPromptResult.text,
    refreshRoutedContext: undefined,
    contextIsCurrent: undefined,
    contextProjection: undefined,
    descriptors: [],
    sentDelta: undefined,
  };
}
