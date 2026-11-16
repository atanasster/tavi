import {
  wrapUntrusted,
  CONTEXT_MESSAGE_PREFIX,
  MAX_MESSAGE_TEXT_BYTES,
  type ModelMessage,
  type ModelCallSite,
  type WorkflowMessage,
} from "@tavi/contracts";
import { mailboxLine, turnContextDelta, withCacheBreakpoints, withContextMessage, withContextBlockFolded } from "../../context-block.js";
import { EPOCH_MARKER_PATTERN } from "../../epoch.js";
import { withStepFacts } from "../../prompt.js";
import { threadIdOf } from "../../run-config.js";
import type { WorkflowScope } from "../../scope.js";
import { type ModelCall, callView } from "./context.js";

/** What a model call is sent with besides its messages and tools. */
export interface ModelDispatch {
  readonly signal: AbortSignal;
  readonly outputCap: number | undefined;
  readonly site: ModelCallSite;
  readonly cache: ReturnType<NonNullable<WorkflowScope["options"]["cacheFor"]>> | undefined;
}

/** One conversation message as a model request carries it. */
function toModelMessage(ctx: ModelCall, message: WorkflowMessage): ModelMessage {
  const { step } = ctx;
  const { current } = step;
  const { envelopeOfMessage, now } = step.scope;
  // Untrusted content reaches the model in its envelope, at send time only:
  // the checkpoint keeps the raw result. A tool result carries it for the provider conversion
  // to fence; untrusted quoted data (a mailbox, a side chat's background, a mod's context, a summary of a
  // tainted span) is fenced here. An inbound block keeps its own fence, its text already normalised as the
  // envelope's is when it was admitted (`inboundBlockText`).
  const envelope = envelopeOfMessage(current.runId, message);
  const converted: ModelMessage = {
    id: message.id,
    role: message.role,
    text: envelope !== undefined && message.role === "user" ? wrapUntrusted(message.text, envelope, MAX_MESSAGE_TEXT_BYTES) : message.text,
    createdAt: now(),
  };
  if (message.reasoning !== undefined) converted.reasoning = message.reasoning;
  if (message.toolCalls !== undefined) {
    converted.toolCalls = message.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.input,
    }));
  }
  if (message.toolCallId !== undefined && message.toolName !== undefined) {
    // A tool result must reach the model as a result DTO, not as empty
    // text: the SDK converts `toolResults` into provider tool messages.
    converted.toolCallId = message.toolCallId;
    converted.toolName = message.toolName;
    converted.toolResults = [
      {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        output: message.output ?? null,
        isError: message.isError === true,
        ...(envelope === undefined ? {} : { envelope }),
      },
    ];
  }
  return converted;
}

/**
 * The call's messages. `v1`: the manifest and an ordinary chat's epoch summaries as one quoted-data block at
 * the front of the newest person message (folded in), built for this request and never stored, and the step
 * facts joined to the last user message. `v2`: each turn's own block on its person message (`contextText`),
 * this turn's written now if no earlier call of it did, the step facts as a part of their own, and the
 * breakpoints placed where the next call's copy of the request ends.
 */
function requestMessages(ctx: ModelCall, attempt: string): ModelMessage[] {
  const { step, turnPerson, turnChannels, stepFacts } = ctx;
  const { current, layout } = step;
  const { now } = step.scope;
  const system: ModelMessage = { id: `sys-${current.runId}`, role: "system", text: ctx.systemPromptText, createdAt: now() };
  const view = callView(ctx);
  /** A request message with the block its person message keeps, sent before the words under `v2`. */
  const withKeptBlock = (message: WorkflowMessage, model: ModelMessage, block = message.contextText): ModelMessage =>
    layout === "v2" && message.role === "user" && block !== undefined && block !== "" ? { ...model, contextText: block } : model;
  // The turn's person message as this call holds it: a rollover this call made may have folded it away.
  const person = turnPerson === undefined ? undefined : view.find((message) => message.id === turnPerson.id);
  ctx.sentDelta = undefined;
  if (person === undefined)
    return withStepFacts(
      withContextBlockFolded([
        system,
        ...withContextMessage(view, ctx.systemPromptResult.context, `${CONTEXT_MESSAGE_PREFIX}${current.runId}`).map((message) =>
          withKeptBlock(message, toModelMessage(ctx, message)),
        ),
      ]),
      stepFacts,
      `facts-${attempt}`,
      now(),
    );
  ctx.sentDelta = turnContextDelta(view, person, ctx.systemPromptResult.manifest, ctx.systemPromptResult.context, turnChannels);
  const delta = ctx.sentDelta;
  const converted = view
    // An epoch summary is shown once, in the block of the turn after it was written, never as a system message.
    .filter((message) => !(message.role === "system" && EPOCH_MARKER_PATTERN.test(message.text)))
    .map((message) =>
      withKeptBlock(
        message,
        toModelMessage(ctx, message),
        message.id === person.id && delta !== undefined ? delta.text : message.contextText,
      ),
    );
  // The mailbox's count changes as agents report, so it is the call's own fact, not the block's.
  const mailbox = ctx.systemPromptResult.manifest === undefined ? undefined : mailboxLine(ctx.systemPromptResult.manifest);
  const facts = mailbox === undefined ? stepFacts : `${stepFacts}\n- ${mailbox}`;
  return withCacheBreakpoints(withStepFacts([system, ...converted], facts, `facts-${attempt}`, now(), "v2"), person.id, `facts-${attempt}`);
}

/** One model call on `target`, as `attempt`. */
export function callModel(
  ctx: ModelCall,
  dispatch: ModelDispatch,
  target: { readonly connectionId: string; readonly model: string },
  attempt: string,
) {
  const { step } = ctx;
  const { signal, outputCap, site, cache } = dispatch;
  const { config, authorizedModels, current, layout, turnStepsSoFar } = step;
  const { observers } = step.scope;
  return authorizedModels.stream(
    {
      connectionId: target.connectionId,
      model: target.model,
      runId: current.runId,
      attemptId: attempt,
      attemptNumber: current.steps + 1,
      // Which call of the turn, for the ledger's cache-hit measurement.
      step: turnStepsSoFar + 1,
      ...(outputCap === undefined ? {} : { maxOutputTokens: outputCap }),
      messages: requestMessages(ctx, attempt),
      tools: ctx.descriptors,
      // `v2` asks the transport to keep media stable for the prompt cache.
      ...(layout === "v2" ? { promptLayout: "v2" as const } : {}),
      // A heartbeat check reads and reports; every call of its turn thinks briefly, the same each call.
      ...(site === "heartbeat" ? { reasoningEffort: "low" as const } : {}),
    },
    {
      // The caller's signal, never a fabricated one: the CLI's SIGINT handler
      // aborts this controller and the in-flight generation must observe it.
      signal,
      site,
      ...(cache?.ttl === undefined ? {} : { cacheTtl: cache.ttl }),
      ...(cache?.key === undefined ? {} : { cacheKey: cache.key }),
      // Transport events are forwarded to the admission's observer rather than
      // written into graph state: private state channels must never reach a
      // client.
      onEvent: (event) => observers.get(threadIdOf(config))?.onModelEvent?.(event),
    },
  );
}
