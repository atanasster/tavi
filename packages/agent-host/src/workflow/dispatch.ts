import { z } from "zod";
import {
  type ToolHandler,
  type ToolEffect,
  effectiveEffect,
  labelledResult,
  toolResultLabel,
  isUntrusted,
  isTrustedPublic,
  TRUSTED_PUBLIC,
  trustedLabel,
  type ContentLabel,
  type AccessPolicyPort,
  type ArtifactRepositoryPort,
  type AskUserInputSchema,
  ASK_USER_CONTEXT_MAX_CHARS,
  ASK_USER_HEADER_MAX_CHARS,
  ASK_USER_OPTION_DESCRIPTION_MAX_CHARS,
  ASK_USER_OPTION_LABEL_MAX_CHARS,
  ASK_USER_QUESTION_MAX_CHARS,
  type EffectRepositoryPort,
  type InvocationContext,
  type TaskExecutionPolicy,
  TaviError,
  DEFAULT_TOOL_TIMEOUT_MS,
  type PendingRound,
  type ToolRegistryPort,
  type WorkflowMessage,
  type WorkflowInvocationResult,
  type WorkflowResumeDecision,
  TURN_STOPPED_MESSAGE,
  type ProviderOperationEnvelope,
  WorkflowWaitSuspend,
  containsRedactionPlaceholder,
  isRefusedEarly,
  zodIssues,
} from "@tavi/contracts";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import { toModelError } from "../models/models.js";
import {
  scrubToolOutput,
  isWithheldReceipt,
  type DispatchHooks,
  oneAtATime,
  callDeniedByHooks,
  resultThroughHooks,
  rewrittenLabel,
  scrubFailure,
  storedLabel,
} from "./tool-hooks.js";
import { archiveToolOutput, collectPendingReviewArtifactIds } from "./tool-output.js";

export const CallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

/**
 * An `ask_user` call's words with `disarm` applied:
 * the question, its context, its header and every option, each cut back to
 * its schema bound, since a defanged address is a little longer. A seam for
 * an MCP elicitation's question.
 */
export function disarmedQuestion(
  input: z.infer<typeof AskUserInputSchema>,
  disarm: (text: string) => string,
): z.infer<typeof AskUserInputSchema> {
  const cut = (text: string, max: number): string => disarm(text).slice(0, max);
  return {
    ...input,
    question: cut(input.question, ASK_USER_QUESTION_MAX_CHARS),
    ...(input.context === undefined ? {} : { context: cut(input.context, ASK_USER_CONTEXT_MAX_CHARS) }),
    ...(input.header === undefined ? {} : { header: cut(input.header, ASK_USER_HEADER_MAX_CHARS) }),
    ...(input.options === undefined
      ? {}
      : {
          options: input.options.map((option) => ({
            ...option,
            label: cut(option.label, ASK_USER_OPTION_LABEL_MAX_CHARS),
            ...(option.description === undefined ? {} : { description: cut(option.description, ASK_USER_OPTION_DESCRIPTION_MAX_CHARS) }),
          })),
        }),
  };
}

/** A refusal's label: trusted, at the tool's declared confidentiality (a refusal can still name the person's setup). */
function refusalLabel(definition: { readonly outputConfidentiality?: ContentLabel["confidentiality"] | undefined }): {
  readonly label: ContentLabel;
} {
  const confidentiality = definition.outputConfidentiality ?? "public";
  return { label: confidentiality === "public" ? TRUSTED_PUBLIC : trustedLabel(confidentiality) };
}

/**
 * The label of a thrown handler's failure (QA 1894): trusted (`refusalLabel`) only for a built-in's refusal marked as
 * Tavi's own words, raised before it reached anything outside (`refusedEarly`), wrapping nothing (a `cause` may carry
 * another error's text, which can be remote); none otherwise, so the message is read by its tool's declaration and an
 * `untrustedOutput` tool's failure taints (fail closed). A handler's unmarked error, whatever its code, may quote what it
 * read: a browser ref's label, a Gmail label's name, a server's answer. Never for an MCP or external plugin's tool, whose
 * errors relay a server's or a plugin's words. Tavi's own refusals before the handler runs (permissions, argument
 * validation) are clean too: see `refusalLabel`.
 */
function thrownLabel(
  definition: {
    readonly builtIn?: true | undefined;
    readonly outputSource?: ContentLabel["sources"][number] | undefined;
    readonly outputConfidentiality?: ContentLabel["confidentiality"] | undefined;
  },
  error: unknown,
): { readonly label?: ContentLabel } {
  const early =
    definition.builtIn === true &&
    definition.outputSource !== "mcp" &&
    definition.outputSource !== "plugin" &&
    isRefusedEarly(error) &&
    error.cause === undefined;
  return early ? refusalLabel(definition) : {};
}

/** Exported for direct testing of dispatch outcomes (e.g. sensitivity tagging) that don't survive conversion to `ModelMessage`. */
export async function dispatchTool(
  registry: ToolRegistryPort,
  access: AccessPolicyPort,
  effects: EffectRepositoryPort,
  call: z.infer<typeof CallSchema>,
  context: InvocationContext,
  scope: {
    readonly taskId: string;
    readonly admissionId: string;
    /** The round this dispatch belongs to; part of the effect key. */
    readonly steps: number;
    readonly approvalId?: string;
    /** A person authorized this call (see `ToolHandler`'s `operatorApproved`). */
    readonly operatorApproved?: boolean;
    /** Who approved this very call in its round, and the content digest they were shown (see `ToolHandler`'s `approvedBy`). */
    readonly approvedBy?: string;
    readonly approvedContentHash?: string;
    /** The subjects the call's gate verdict was decided by (see `ToolHandler`'s `assessedSubjects`). */
    readonly assessedSubjects?: readonly string[] | undefined;
    /** The hosts the call's gate verdict held it to (see `ToolHandler`'s `assessedHosts`). */
    readonly assessedHosts?: readonly string[] | undefined;
    readonly expectedBindingHash?: string | undefined;
    /** The gate verdict's rule or grant, recorded on the provider operations this call starts. */
    readonly ruleId?: string | undefined;
    /** The effect the gate verdict raised the call to (`GateVerdict.effect`): a raised read is ledgered as what it is. */
    readonly effect?: ToolEffect | undefined;
    readonly tainted?: boolean;
    /** A tainted call's outbound-text disarm (see `ToolHandler`'s `disarmUrls`). */
    readonly disarmUrls?: (text: string) => string;
    /** Mask credential shapes in the output before it is archived or recorded. Absent: on. */
    readonly redact?: boolean;
    /** Plugins' `tool.call` and `tool.result` hooks for this call, when any may see it. */
    readonly hooks?: DispatchHooks;
    /** The clock a result's label refs are stamped with. Absent: the wall clock. */
    readonly now?: () => string;
    /** The conversation's context label as the call runs (see `ToolHandler`'s `contextLabel`). */
    readonly contextLabel?: ContentLabel;
    /** The task's policy, and its question to the person when it may ask one (see `ToolHandler`'s `ask`). */
    readonly executionPolicy?: TaskExecutionPolicy;
    readonly ask?: NonNullable<Parameters<ToolHandler>[0]["ask"]>;
  },
  signal: AbortSignal | undefined,
  artifacts: ArtifactRepositoryPort | undefined,
): Promise<WorkflowMessage> {
  const definition = registry.get(call.name);
  const base = { id: `tool-${call.id}`, role: "tool" as const, toolCallId: call.id, toolName: call.name };

  if (definition === undefined) {
    // A name the model made up or misspelt. No near names are offered: the registry holds tools this task may
    // not be shown, and the tools it was offered are its list.
    return {
      ...base,
      text: "",
      output: {
        error: "UNKNOWN_TOOL",
        toolName: call.name,
        hint: "call one of the tools you were offered (tools.search finds more where it is offered)",
      },
      isError: true,
    };
  }

  // Authorization precedes argument validation and dispatch: a caller must not be
  // able to learn a tool's accepted input shape without permission to call it.
  const missing = access.missingPermissions(context, definition.requiredPermissions);
  if (missing.length > 0) {
    return {
      ...base,
      text: "",
      output: { error: "NOT_AUTHORIZED", missingPermissions: missing },
      isError: true,
      // Tavi's own refusal, before the tool ran: nothing outside was read.
      ...refusalLabel(definition),
    };
  }

  const validation = validateToolInput(registry, call.name, call.input);
  if (validation.ok === false) {
    return { ...base, text: "", output: invalidInputOutput(validation.issues), isError: true, ...refusalLabel(definition) };
  }

  const questions: QuestionInputs = {
    taskId: scope.taskId,
    ...(scope.executionPolicy === undefined ? {} : { executionPolicy: scope.executionPolicy }),
    ...(scope.ask === undefined ? {} : { ask: scope.ask }),
  };
  const operationEnvelope: ProviderOperationEnvelope = {
    taskId: scope.taskId,
    accountingRef: call.id,
    ...(scope.ruleId === undefined ? {} : { ruleId: scope.ruleId }),
    ...(scope.tainted === undefined ? {} : { tainted: scope.tainted }),
  };
  if (definition.resolveBinding !== undefined) {
    try {
      const resolved = await definition.resolveBinding(validation.value, context);
      if (resolved.bindingHash !== scope.expectedBindingHash) throw new Error("Provider binding changed after authorization");
    } catch {
      return {
        ...base,
        text: "",
        output: { error: "NOT_AUTHORIZED", detail: "Provider binding changed or was withdrawn; authorize a new call" },
        isError: true,
        ...refusalLabel(definition),
      };
    }
  }

  // A read-only tool has no external effect, so it is not ledgered. Everything
  // else is recorded before it is attempted.
  if (effectiveEffect(definition.effect, scope.effect) === "read-only") {
    // Nothing is ledgered for a read: a replay asks its hooks again, and they answer as they did.
    const denied = await callDeniedByHooks(scope.hooks, call, definition.id);
    if (denied !== undefined) return { ...base, text: "", output: denied, isError: true };
    return runHandler(
      definition,
      base,
      validation.value,
      context,
      signal,
      artifacts,
      scope.expectedBindingHash,
      operationEnvelope,
      scope.redact ?? true,
      scope.hooks,
      call,
      scope.now,
      scope.contextLabel,
      questions,
    );
  }

  // The key deliberately excludes the admission: the same task replaying the same
  // logical tool call is the same effect, however many admissions observed it
  // (a replay must find the existing ledger entry).
  //
  // It does include the round. A provider may reuse one `call.id`
  // across turns, and without the round the second turn's call would find the
  // first turn's receipt and be answered "already done" instead of dispatching —
  // the same defect the approval row's round qualification fixes.
  //
  // The format is fixed: reformatting it would orphan every receipt already
  // recorded, and an orphaned receipt is a re-attempted external effect — the
  // one outcome the ledger exists to prevent.
  const effectKey = roundEffectKey(scope.taskId, call.id, definition.id, scope.steps);
  // Plugins' `tool.call` hooks run before the ledger records the call as begun: a crash or a cancel
  // inside a hook then leaves no effect that looks attempted, and a replay of a known effect never asks them again.
  // One call at a time from reading the ledger to beginning the effect: two admissions racing the same
  // call would both ask its hooks, and the loser's deny would stand in the audit though the winner's outcome does.
  const { denied, begun } = await oneAtATime(effects, effectKey, async () => {
    const known = await effects.get(effectKey);
    const denied = known === undefined ? await callDeniedByHooks(scope.hooks, call, definition.id) : undefined;
    const begun = await effects.begin({
      effectKey,
      taskId: scope.taskId,
      admissionId: scope.admissionId,
      toolId: definition.id,
      inputs: validation.value,
      approvalId: scope.approvalId ?? null,
      now: { execution: true },
    });
    return { denied, begun };
  });

  // A call the tool still holds open on its question (an older MCP server's) is taken up again: its effect
  // is still `pending` because the call has not ended, and this run gets its result.
  const resumingHeld = !begun.created && begun.effect.state === "pending" && definition.holdsCall?.(scope.taskId, call.id) === true;
  if (!begun.created && !resumingHeld) {
    // The effect is already known. A recorded outcome is returned as a receipt;
    // an unresolved one is surfaced as uncertain rather than re-attempted, since
    // exactly-once external effects are never promised.
    if (begun.effect.state === "accepted" || begun.effect.state === "rejected") {
      // The label the result entered with, kept with its receipt; an effect from before labels reads as its tool's declaration.
      const label = begun.effect.label ?? toolResultLabel(definition, call, { untrusted: false }, (scope.now ?? nowTimestamp)());
      return {
        ...base,
        text: "",
        output: { replayed: true, state: begun.effect.state, receipt: begun.effect.receipt },
        isError: begun.effect.state === "rejected" || isWithheldReceipt(begun.effect.receipt),
        ...(definition.sensitivity === "sensitive" ? { sensitivity: "sensitive" as const } : {}),
        ...(isUntrusted(label) && definition.untrustedOutput !== true ? { untrusted: true as const } : {}),
        ...(isTrustedPublic(label) ? {} : { label }),
      };
    }
    return {
      ...base,
      text: "",
      output: {
        error: "EFFECT_UNCERTAIN",
        effectKey,
        state: begun.effect.state,
        note: "a previous attempt has no recorded outcome and must be reconciled",
      },
      isError: true,
      ...(definition.sensitivity === "sensitive" ? { sensitivity: "sensitive" as const } : {}),
    };
  }

  // A plugin's deny is the call's recorded outcome, so a replay returns it rather than asking again.
  if (denied !== undefined && !resumingHeld) {
    await effects.resolve({ effectKey, state: "rejected", receipt: denied, now: { execution: true } });
    return { ...base, text: "", output: denied, isError: true };
  }

  let output: unknown;
  try {
    output = await withinToolTimeout(definition, signal, (bounded) =>
      definition.handler({
        input: validation.value,
        context,
        callId: call.id,
        effectKey,
        signal: bounded,
        ...(scope.operatorApproved === true ? { operatorApproved: true } : {}),
        ...definedOnly({
          approvedBy: scope.approvedBy,
          approvedContentHash: scope.approvedContentHash,
          assessedSubjects: scope.assessedSubjects,
          assessedHosts: scope.assessedHosts,
          expectedBindingHash: scope.expectedBindingHash,
          disarmUrls: scope.disarmUrls,
          contextLabel: scope.contextLabel,
        }),
        operationEnvelope,
        ...questions,
      }),
    );
  } catch (error) {
    // A question the call waits on; the task suspends on it. A call that ended on it reached no outcome, so
    // the ledger forgets it and it runs again once the question is answered; one the tool holds open stays `pending`,
    // for its next run to take up — or to be reported uncertain if the hold is lost meanwhile.
    if (error instanceof WorkflowWaitSuspend) {
      if (error.held !== true) await effects.abandon(effectKey);
      throw error;
    }
    // An error can echo what the call sent — a URL, a header — so it is masked like a result.
    const { detail, redacted } = scrubFailure(toModelError(error).message, scope.redact ?? true, error);
    // A sign-in error is raised before any request is sent, or by the server refusing it: nothing ran, so the
    // call is rejected, not uncertain, and runs again once signed in. An attended one shows the chat a
    // Connect button.
    const signIn = signInFailure(error);
    if (signIn !== undefined) {
      await effects.resolve({ effectKey, state: "rejected", error: detail, now: { execution: true } });
      return {
        ...base,
        text: "",
        output: failureOutput(signIn, detail, error),
        isError: true,
        ...(redacted === undefined ? {} : { redacted }),
        ...thrownLabel(definition, error),
      };
    }
    // A thrown handler may or may not have reached the provider, so the outcome
    // is recorded as uncertain rather than rejected.
    await effects.resolve({
      effectKey,
      state: "uncertain",
      error: detail,
      now: { execution: true },
    });
    return {
      ...base,
      text: "",
      // Its outcome is unknown: a retry, under a new call id, could do it twice (send twice, pay twice).
      output: failureOutput(undefined, detail, error, { uncertain: true }),
      isError: true,
      ...(redacted === undefined ? {} : { redacted }),
      ...thrownLabel(definition, error),
    };
  }
  // A result the handler marked untrusted taints like an `untrustedOutput` tool's,
  // and its label is the tool's declaration raised by what the handler said of this result.
  const marked = labelledResult(output);
  const declared = toolResultLabel(
    definition,
    call,
    { untrusted: marked.untrusted, label: marked.label, secret: containsRedactionPlaceholder(marked.output) },
    (scope.now ?? nowTimestamp)(),
  );
  // Masked, then shown to plugins' result hooks, before anything keeps it — the archive,
  // the receipt, the message, the events — so a replay returns what they settled.
  const scrubbed = scrubToolOutput(marked.output, scope.redact ?? true);
  let masked: Awaited<ReturnType<typeof resultThroughHooks>>;
  try {
    masked = await resultThroughHooks(scope.hooks, call, definition.id, scrubbed, scope.redact ?? true);
  } catch (error) {
    if (scope.hooks?.signal?.aborted !== true) {
      // Not a cancel: as any failure to keep a result after the call ran.
      const { detail, redacted } = scrubFailure(toModelError(error).message, scope.redact ?? true, error);
      await effects.resolve({ effectKey, state: "uncertain", error: detail, now: { execution: true } });
      return {
        ...base,
        text: "",
        output: { error: "TOOL_FAILED", detail },
        isError: true,
        ...(redacted === undefined ? {} : { redacted }),
      };
    }
    // Cancelled while its result hooks ran: the call did run, so its masked result is the receipt, and the cancel goes on.
    await effects.resolve({
      effectKey,
      state: "accepted",
      receipt: await archiveToolOutput(artifacts, context, scrubbed.value, storedLabel(scope.contextLabel, declared)),
      label: declared,
      now: { execution: true },
    });
    throw error;
  }
  const label = rewrittenLabel(declared, masked);
  try {
    // Computed once and reused for the receipt and the message: calling
    // `archiveToolOutput` twice would archive the same bulky result as two
    // separate artifacts for one tool call.
    const bounded = await archiveToolOutput(artifacts, context, masked.value, storedLabel(scope.contextLabel, label));
    // The message first: a result whose pending artifacts cannot be read is not kept, and its outcome stays uncertain.
    const message = await keptResultMessage(artifacts, context.workspaceId, base, definition, { marked, masked, label, bounded });
    await effects.resolve({
      effectKey,
      state: "accepted",
      receipt: bounded,
      // Kept with the receipt, so a replay is labelled as this result was.
      label,
      now: { execution: true },
    });
    return message;
  } catch (error) {
    // Keeping the result failed after the call ran: its outcome is uncertain, as a thrown handler's is.
    const { detail, redacted } = scrubFailure(toModelError(error).message, scope.redact ?? true, error);
    await effects.resolve({ effectKey, state: "uncertain", error: detail, now: { execution: true } });
    return { ...base, text: "", output: { error: "TOOL_FAILED", detail }, isError: true, ...(redacted === undefined ? {} : { redacted }) };
  }
}

/**
 * A kept result's message: its archived output, the pending artifacts it named — read as the tool returned it, since
 * an archived result would hide them — and its sensitivity, redactions, taint and label.
 */
async function keptResultMessage(
  artifacts: ArtifactRepositoryPort | undefined,
  workspaceId: string,
  base: { readonly id: string; readonly role: "tool"; readonly toolCallId: string; readonly toolName: string },
  definition: { readonly sensitivity?: "sensitive" | undefined; readonly builtIn?: true | undefined },
  result: {
    readonly marked: ReturnType<typeof labelledResult>;
    readonly masked: Awaited<ReturnType<typeof resultThroughHooks>>;
    readonly label: ContentLabel;
    readonly bounded: unknown;
  },
): Promise<WorkflowMessage> {
  const { marked, masked, label, bounded } = result;
  const pendingReviewArtifactIds = await collectPendingReviewArtifactIds(artifacts, workspaceId, masked.value);
  return {
    ...base,
    text: "",
    output: bounded,
    isError: masked.withheld === true,
    ...(pendingReviewArtifactIds.length > 0 ? { pendingReviewArtifactIds } : {}),
    ...(definition.sensitivity === "sensitive" ? { sensitivity: "sensitive" as const } : {}),
    ...(masked.redacted === undefined ? {} : { redacted: masked.redacted }),
    ...(marked.untrusted ? { untrusted: true as const } : {}),
    ...(isTrustedPublic(label) && (marked.label?.stored === undefined || definition.builtIn !== true) ? {} : { label }),
  };
}

/**
 * A handler's run, held to its tool's timeout (`ToolDefinition.timeoutMs`,
 * `DEFAULT_TOOL_TIMEOUT_MS` when absent, none at `0`): its signal aborts at the
 * deadline, and a handler that does not stop for it is answered `TIMEOUT` all
 * the same, so a hung call cannot hold the turn. A question the handler asks
 * (`WorkflowWaitSuspend`) is never turned into a timeout.
 */
export async function withinToolTimeout<T>(
  definition: { readonly id: string; readonly timeoutMs?: number | undefined },
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const parent = signal ?? new AbortController().signal;
  const limit = definition.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  if (limit === 0) return await run(parent);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException(`${definition.id} ran past ${limit} ms`, "TimeoutError")), limit);
  const running = run(AbortSignal.any([parent, deadline.signal]));
  // The losing side's rejection is still handled, never left unhandled.
  running.catch(() => undefined);
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) =>
        deadline.signal.addEventListener(
          "abort",
          () => {
            // A question the handler raised as the deadline came still suspends the task: given a moment to settle,
            // its suspension wins over the timeout, so the person is never asked a question nothing waits on.
            void Promise.race([running, new Promise((resolve) => setTimeout(resolve, TIMEOUT_SETTLE_MS))]).then(
              () => reject(timedOut(definition.id, limit)),
              (error: unknown) => reject(error instanceof WorkflowWaitSuspend ? error : timedOut(definition.id, limit)),
            );
          },
          { once: true },
        ),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long a call cut off at its deadline is given to settle a question it was raising. */
const TIMEOUT_SETTLE_MS = 1_000;

function timedOut(id: string, limit: number): Error {
  return Object.assign(new Error(`${id} did not answer within ${Math.round(limit / 1000)} s`), { name: "TimeoutError" });
}

/** The failures a later call may get past by itself: a service down for a moment, a timeout. */
const RETRYABLE_FAILURES: ReadonlySet<string> = new Set(["UNAVAILABLE", "TIMEOUT"]);

/**
 * A failed call's output: the Connect card's when a person may sign in, else
 * the failure with its code — the handler's `TaviError` code, `TIMEOUT` for a
 * timeout, `ABORTED` for a call stopped by its run, `TOOL_FAILED` for anything
 * else — and whether a retry could help, so the model neither gives up on a
 * transient failure nor retries a permanent one. A call whose outcome is
 * `uncertain` — it may have reached the provider — is never called retryable:
 * a retry under a new call id could do the same thing twice.
 */
export function failureOutput(
  signIn: ReturnType<typeof signInFailure>,
  detail: string,
  error: unknown,
  options: { readonly uncertain?: boolean } = {},
): Readonly<Record<string, unknown>> {
  if (signIn?.card === true) return { error: "SIGN_IN_REQUIRED", ...signIn.names, detail };
  const code =
    error instanceof TaviError
      ? error.code
      : error instanceof Error && error.name === "TimeoutError"
        ? "TIMEOUT"
        : error instanceof Error && error.name === "AbortError"
          ? "ABORTED"
          : "TOOL_FAILED";
  if (code === "INVALID_INPUT") return { ...invalidInputOutput(detail), retryable: false, hint: "fix the arguments before calling again" };
  if (options.uncertain === true && RETRYABLE_FAILURES.has(code))
    return { error: code, detail, retryable: false, hint: "the call may have run: check whether it did before calling it again" };
  const retryable = RETRYABLE_FAILURES.has(code);
  return { error: code, detail, retryable, ...(retryable ? { hint: "a later retry may succeed" } : {}) };
}

/** An `INVALID_INPUT` output, one shape everywhere: its problems as a list, and as one line. */
export function invalidInputOutput(issues: readonly string[] | string): Readonly<Record<string, unknown>> {
  const list = typeof issues === "string" ? [issues] : [...issues];
  return { error: "INVALID_INPUT", detail: list.join("; "), issues: list };
}

/**
 * A sign-in error, and whether its run asked for the Connect card: an MCP server's (`mcpFailure: "login"`, by its
 * plugin), or a channel account's (`signIn`, by its app and account, as a Gmail mailbox tool's).
 */
function signInFailure(
  error: unknown,
):
  | { readonly names: { readonly pluginId: string } | { readonly appId: string; readonly accountId: string }; readonly card: boolean }
  | undefined {
  if (!(error instanceof TaviError) || error.details === undefined) return undefined;
  const card = error.details["connectCard"] === true;
  if (error.details["mcpFailure"] === "login") {
    const pluginId = error.details["pluginId"];
    return typeof pluginId === "string" ? { names: { pluginId }, card } : undefined;
  }
  if (error.details["signIn"] === true) {
    const appId = error.details["appId"];
    const accountId = error.details["accountId"] ?? error.details["connectionId"];
    return typeof appId === "string" && typeof accountId === "string" ? { names: { appId, accountId }, card } : undefined;
  }
  return undefined;
}

/**
 * The error code for a throw out of the graph.
 *
 * The graph throws the abort reason when the caller's signal fires, so an abort
 * is classified `ABORTED`. Only the abort *itself* is: the signal's own reason,
 * an `AbortError`, or an untyped error once the signal has fired. A typed failure
 * that merely coincides with an aborted signal — a lease fence's `CONFLICT`, an
 * `INTERNAL` defect — keeps its code, because the abort is often a consequence of
 * it (a service manager stopping a fenced owner) rather than its cause.
 */
export function graphFailureCode(error: unknown, signal: AbortSignal | undefined): string {
  const isAbort =
    signal?.aborted === true &&
    (error === signal.reason || (error instanceof Error && error.name === "AbortError") || !(error instanceof TaviError));
  return isAbort ? abortCode(signal) : TaviError.from(error, "MODEL_FAILED").code;
}

/** A turn the person stopped (Stop, `Esc`, `tavi abort`): no failure, in their words, and the chat goes on. */
export const STOPPED_TURN: WorkflowInvocationResult = {
  status: "stopped",
  finalText: TURN_STOPPED_MESSAGE,
  error: { code: "STOPPED", message: TURN_STOPPED_MESSAGE },
};

/** What stopped a turn whose signal fired: the person (`STOPPED`, the reason `tavi abort` and Stop give), or anything else (`ABORTED`). */
export function abortCode(signal: AbortSignal | undefined): "STOPPED" | "ABORTED" {
  return signal?.reason instanceof TaviError && signal.reason.code === "STOPPED" ? "STOPPED" : "ABORTED";
}

/**
 * Why a resume does not fit the round actually pending, or `undefined` when it
 * does. The resume's kind — an approval decision or a review
 * acknowledgement — must match the round's, its `expectedSteps` the round's
 * `steps`, and a `decisions` list the round's calls exactly.
 */
export function roundRefusal(round: PendingRound | undefined, resume: WorkflowResumeDecision, expectedSteps: number): string | undefined {
  // The resume's own kind, stated rather than inferred: a wait outcome — or
  // nothing at all — carrying `expectedSteps` would otherwise be taken for an
  // approval, pass against a pending approval round, and fail the task inside
  // the node for want of decisions.
  const kind =
    resume.reviewAck === true ? "review" : resume.approved !== undefined || resume.decisions !== undefined ? "approval" : undefined;
  if (kind === undefined) return "expectedSteps is only meaningful for an approval or a review resume";
  if (round === undefined || round.kind !== kind) {
    return `the ${kind} round ${expectedSteps} is no longer pending; the task has moved on`;
  }
  if (round.steps !== expectedSteps) {
    return `the ${kind} round ${expectedSteps} is not the one pending (round ${round.steps})`;
  }
  if (round.kind === "approval" && resume.decisions !== undefined) {
    const decided = new Set(resume.decisions.map((decision) => decision.callId));
    const pending = new Set(round.callIds);
    // Each call exactly once: a repeated call id has the same set size as a
    // complete one, and the node would then fail the task on the repeat.
    const complete =
      resume.decisions.length === pending.size && decided.size === pending.size && [...pending].every((callId) => decided.has(callId));
    if (!complete) return `the decisions do not name each call of round ${expectedSteps} exactly once`;
  }
  return undefined;
}

/** The ledger key one dispatch runs under: the task, the call, the tool and the round. */
export function roundEffectKey(taskId: string, callId: string, toolId: string, steps: number): string {
  return `${taskId}:${callId}:${toolId}:${steps}`;
}

/** Hooks never see a call's input or output when its tool says so, or it carries a credential. */
export function sensitiveCall(
  definition: { readonly sensitivity?: "sensitive" | undefined },
  subjects: readonly string[] | undefined,
): boolean {
  return definition.sensitivity === "sensitive" || (subjects ?? []).some((subject) => subject.startsWith("credential:"));
}

/** Run a read-only tool handler; nothing external is at stake. */
async function runHandler(
  definition: {
    readonly handler: (
      input: {
        readonly input: unknown;
        readonly context: InvocationContext;
        readonly signal: AbortSignal;
        readonly expectedBindingHash?: string;
        readonly operationEnvelope?: ProviderOperationEnvelope;
        readonly callId?: string;
      } & QuestionInputs,
    ) => Promise<unknown>;
    readonly sensitivity?: "sensitive" | undefined;
    readonly untrustedOutput?: boolean | undefined;
    readonly outputSource?: ContentLabel["sources"][number] | undefined;
    readonly outputConfidentiality?: ContentLabel["confidentiality"] | undefined;
    readonly builtIn?: true | undefined;
    readonly id: string;
    readonly timeoutMs?: number | undefined;
  },
  base: { readonly id: string; readonly role: "tool"; readonly toolCallId: string; readonly toolName: string },
  input: unknown,
  context: InvocationContext,
  signal: AbortSignal | undefined,
  artifacts: ArtifactRepositoryPort | undefined,
  expectedBindingHash: string | undefined,
  operationEnvelope: ProviderOperationEnvelope | undefined,
  redact: boolean,
  hooks: DispatchHooks | undefined,
  call: { readonly id: string; readonly input: unknown },
  clock: () => string = nowTimestamp,
  contextLabel?: ContentLabel,
  questions: QuestionInputs = {},
): Promise<WorkflowMessage> {
  try {
    const output = await withinToolTimeout(definition, signal, (bounded) =>
      definition.handler({
        input,
        context,
        signal: bounded,
        ...definedOnly({
          expectedBindingHash,
          operationEnvelope,
          contextLabel,
        }),
        callId: call.id,
        ...questions,
      }),
    );
    // A result the handler marked untrusted taints like an `untrustedOutput` tool's,
    // and its label is the tool's declaration raised by what the handler said of this result.
    const marked = labelledResult(output);
    const scrubbed = scrubToolOutput(marked.output, redact);
    const masked = await resultThroughHooks(hooks, call, base.toolName, scrubbed, redact);
    const label = rewrittenLabel(
      toolResultLabel(
        definition,
        call,
        { untrusted: marked.untrusted, label: marked.label, secret: containsRedactionPlaceholder(marked.output) },
        clock(),
      ),
      masked,
    );
    const bounded = await archiveToolOutput(artifacts, context, masked.value, storedLabel(contextLabel, label));
    return await keptResultMessage(artifacts, context.workspaceId, base, definition, { marked, masked, label, bounded });
  } catch (error) {
    // A question the call waits on: the task suspends on it, and the call runs again once it is answered.
    if (error instanceof WorkflowWaitSuspend) throw error;
    const { detail, redacted } = scrubFailure(toModelError(error).message, redact, error);
    // A read that met a lapsed sign-in shows the chat a Connect button too, as a change's does.
    return {
      ...base,
      text: "",
      output: failureOutput(signInFailure(error), detail, error),
      isError: true,
      ...(redacted === undefined ? {} : { redacted }),
      ...thrownLabel(definition, error),
    };
  }
}

/** The most questions one tool call may ask its person: a server that asks without end fails the call. */
export const MAX_TOOL_QUESTIONS = 8;

/** What a handler is given to ask its person a question (`ToolHandler`'s `taskId`, `executionPolicy`, `ask`). */
interface QuestionInputs {
  readonly taskId?: string;
  readonly executionPolicy?: TaskExecutionPolicy;
  readonly ask?: NonNullable<Parameters<ToolHandler>[0]["ask"]>;
}

/**
 * Validate a complete tool call against the canonical Zod schema.
 *
 * Partial or interleaved arguments never reach this point: the transport only
 * emits a call when the model has produced a complete argument object.
 */
export function validateToolInput(
  registry: ToolRegistryPort,
  name: string,
  input: unknown,
): { ok: true; value: unknown } | { ok: false; detail: string; issues: readonly string[] } {
  const schema = registry.inputSchemaOf(name);
  if (schema === undefined) {
    const detail = `no canonical argument schema is registered for ${name}`;
    return { ok: false, detail, issues: [detail] };
  }
  const parsed = z.safeParse(schema, input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = zodIssues(parsed.error, "<root>");
  return { ok: false, detail: issues.join("; "), issues };
}

/**
 * Derive the model-facing JSON Schema from the tool's canonical Zod schema.
 *
 * The same schema validates the completed call locally, so a provider that
 * ignores or approximates the JSON Schema cannot smuggle an invalid input past
 * dispatch.
 */
export function jsonSchemaOf(registry: ToolRegistryPort, id: string): unknown {
  const schema = registry.inputJsonSchemaOf(id);
  if (schema === undefined) {
    throw new TaviError("INTERNAL", `Tool ${id} has no model-facing argument schema`);
  }
  return schema;
}
