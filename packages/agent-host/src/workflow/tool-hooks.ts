import {
  CONTENT_LABEL_LIMITS,
  joinLabels,
  untrustedLabel,
  type ContentLabel,
  type EffectRepositoryPort,
  HEARTBEAT_REPORT_TOOL_ID,
  type WorkflowMessage,
  redactToolOutput,
  redactToolText,
  type ToolOutputRedactionKind,
  type TurnHooksPort,
  type ModEnvelope,
  PLUGIN_BOUNDS,
  sameOutputShape,
  browserOutputSensitive,
  maskPluginText,
  type ModHookInput,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

/** A handler's output with credential shapes masked, and the counts when any were. */
export function scrubToolOutput(
  output: unknown,
  redact: boolean,
): { readonly value: unknown; readonly redacted?: WorkflowMessage["redacted"] } {
  if (!redact) return { value: output };
  const masked = redactToolOutput(output);
  return { value: masked.value, ...(Object.keys(masked.masked).length === 0 ? {} : { redacted: masked.masked }) };
}

/** A call's input as hooks see it: the masked copy when `tools.redactResults` is on; the call runs with the real one. */
export function hookInputOf(input: unknown, redact: boolean): unknown {
  return redact ? redactToolOutput(input).value : input;
}

/** The error a withheld result is replaced by; a receipt that holds it is an error on replay too. */
export const WITHHELD_BY_PLUGIN = "WITHHELD_BY_PLUGIN";

export function isWithheldReceipt(receipt: unknown): boolean {
  return typeof receipt === "object" && receipt !== null && (receipt as { readonly error?: unknown }).error === WITHHELD_BY_PLUGIN;
}

/**
 * What plugins' `tool.call` and `tool.result` hooks may see of one call:
 * where and for whom, the tool's rule aliases, and whether it is
 * sensitive — then they see neither its input nor its output.
 */
export interface DispatchHooks {
  readonly port: TurnHooksPort;
  readonly envelope: ModEnvelope;
  /** The run's own: a cancel stops the hooks, and is no failure of theirs. */
  readonly signal?: AbortSignal | undefined;
  /** `tools.redactResults`: hooks are shown the masked copy of a call's input. */
  readonly maskInput?: boolean;
  readonly aliases?: readonly string[];
  readonly sensitive: boolean;
}

function hookCallOf(hooks: DispatchHooks, call: { readonly id: string; readonly input: unknown }, tool: string): ModHookInput<"tool.call"> {
  return {
    envelope: hooks.envelope,
    tool,
    callId: call.id,
    ...(hooks.sensitive ? { sensitive: true as const } : { input: hookInputOf(call.input, hooks.maskInput === true) }),
    ...(hooks.aliases === undefined ? {} : { aliases: hooks.aliases }),
  };
}

/** The effects each ledger is beginning now, by key: the turn a later racer of the same call waits for. */
const beginning = new WeakMap<EffectRepositoryPort, Map<string, Promise<unknown>>>();

/** Run `step` once no other step for the same effect of the same ledger is running. */
export async function oneAtATime<T>(effects: EffectRepositoryPort, effectKey: string, step: () => Promise<T>): Promise<T> {
  let running = beginning.get(effects);
  if (running === undefined) beginning.set(effects, (running = new Map()));
  const before = running.get(effectKey) ?? Promise.resolve();
  const turn = before.then(step, step);
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  running.set(effectKey, settled);
  try {
    return await turn;
  } finally {
    if (running.get(effectKey) === settled) running.delete(effectKey);
  }
}

/** A plugin's refusal of a call the gate let through, as the call's error output; `undefined` when none refused. */
export async function callDeniedByHooks(
  hooks: DispatchHooks | undefined,
  call: { readonly id: string; readonly input: unknown },
  tool: string,
): Promise<{ readonly error: "DENIED_BY_PLUGIN"; readonly plugin: string; readonly reason: string } | undefined> {
  if (hooks === undefined || tool === HEARTBEAT_REPORT_TOOL_ID || !hooks.port.has("tool.call", hooks.envelope, tool, hooks.aliases))
    return undefined;
  const outcome = await hooks.port.dispatch("tool.call", hookCallOf(hooks, call, tool), async () => ({}), hooks.signal);
  const reason = outcome.result.deny;
  return reason === undefined
    ? undefined
    : { error: "DENIED_BY_PLUGIN", plugin: outcome.decidedBy ?? "a plugin", reason: maskPluginText(reason, 500) };
}

function mergedCounts(...counts: (WorkflowMessage["redacted"] | undefined)[]): WorkflowMessage["redacted"] | undefined {
  const merged: Partial<Record<ToolOutputRedactionKind, number>> = {};
  for (const count of counts)
    for (const [kind, n] of Object.entries(count ?? {}) as [ToolOutputRedactionKind, number][]) merged[kind] = (merged[kind] ?? 0) + n;
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * A masked output shown to plugins' `tool.result` hooks: they may
 * withhold it, or replace it with one of the same shape, masked again. A
 * sensitive call's output, and one cut to `PLUGIN_BOUNDS.maxHookOutputBytes`,
 * can only be withheld: a hook that did not see all of it cannot replace it.
 */
export async function resultThroughHooks(
  hooks: DispatchHooks | undefined,
  call: { readonly id: string; readonly input: unknown },
  tool: string,
  masked: { readonly value: unknown; readonly redacted?: WorkflowMessage["redacted"] },
  redact: boolean,
): Promise<{
  readonly value: unknown;
  readonly redacted?: WorkflowMessage["redacted"];
  readonly withheld?: true;
  readonly rewrittenBy?: string;
}> {
  if (hooks === undefined || tool === HEARTBEAT_REPORT_TOOL_ID || !hooks.port.has("tool.result", hooks.envelope, tool, hooks.aliases))
    return masked;
  // A browser tool's output from a page classed sensitive (a password, payment or one-time-code field) is as a sensitive call's.
  if (!hooks.sensitive && tool.startsWith("browser.") && browserOutputSensitive(masked.value)) hooks = { ...hooks, sensitive: true };
  const bytes = new TextEncoder().encode(JSON.stringify(masked.value ?? null));
  const truncated = bytes.byteLength > PLUGIN_BOUNDS.maxHookOutputBytes;
  // Cut by bytes, as the bound is; a character the cut splits is dropped.
  const shown = truncated
    ? new TextDecoder().decode(bytes.subarray(0, PLUGIN_BOUNDS.maxHookOutputBytes)).replace(/\uFFFD$/, "")
    : masked.value;
  const outcome = await hooks.port.dispatch(
    "tool.result",
    {
      ...hookCallOf(hooks, call, tool),
      ...(hooks.sensitive ? {} : { output: shown }),
      isError: false,
      ...(truncated ? { truncated: true as const } : {}),
    },
    async (input) => ({ output: input.output }),
    hooks.signal,
  );
  const answer = outcome.result;
  const withhold = (reason: string) => ({
    value: { error: WITHHELD_BY_PLUGIN, plugin: outcome.decidedBy ?? "a plugin", reason: maskPluginText(reason, 500) },
    withheld: true as const,
  });
  // The reason is the mod's words, read by the model: attributed as a rewrite is.
  if ("withhold" in answer) return { ...withhold(answer.withhold), rewrittenBy: outcome.decidedBy ?? "plugin" };
  // A hook that did not see the whole output cannot replace it; an unchanged answer changes nothing.
  if (hooks.sensitive || truncated || JSON.stringify(answer.output ?? null) === JSON.stringify(masked.value ?? null)) return masked;
  if (!sameOutputShape(masked.value, answer.output)) return withhold("the plugin changed the output's shape");
  const again = scrubToolOutput(answer.output, redact);
  const redacted = mergedCounts(masked.redacted, again.redacted);
  return { value: again.value, ...(redacted === undefined ? {} : { redacted }), rewrittenBy: outcome.decidedBy ?? "plugin" };
}

/**
 * A result a mod's `tool.result` hook rewrote or withheld with its own reason
 * (`rewrittenBy`) holds the mod's words: its label
 * joins the mod's, untrusted, so a trusted tool's result a mod replaced
 * taints. A result the runtime withheld for its own reason keeps the tool's label.
 */
export function rewrittenLabel(label: ContentLabel, settled: { readonly rewrittenBy?: string }): ContentLabel {
  return settled.rewrittenBy === undefined
    ? label
    : joinLabels(
        label,
        untrustedLabel("plugin", { principal: `tool:${settled.rewrittenBy}`.slice(0, CONTENT_LABEL_LIMITS.maxPrincipalLength) }),
      );
}

/** A user-role message an admission or a steer adds to the conversation. */
export type PromptMessage = {
  readonly id: string;
  readonly role: "user";
  readonly text: string;
  readonly createdAt: string;
  readonly label?: ContentLabel;
};

/** How long a turn waits for its `turn.complete` hooks before it ends: what they show lands first. */
export const TURN_COMPLETE_HOOKS_WAIT_MS = 2_000;

/** A handler's error text, masked like its output: an error can echo the URL or header the call sent. */
export function scrubFailure(
  detail: string,
  redact: boolean,
  thrown?: unknown,
): { readonly detail: string; readonly redacted?: WorkflowMessage["redacted"] } {
  if (!redact) return { detail };
  const masked = redactToolText(detail);
  // Counted on the error as thrown when given: `toModelError` has already masked the shapes it knows,
  // so the detail alone would hide what was found.
  const found = thrown === undefined ? masked.masked : redactToolText(errorMessage(thrown)).masked;
  if (found.length === 0) return masked.masked.length === 0 ? { detail } : { detail: masked.text };
  const redacted: Partial<Record<ToolOutputRedactionKind, number>> = {};
  for (const kind of found) redacted[kind] = (redacted[kind] ?? 0) + 1;
  return { detail: masked.text, redacted };
}

/** What an artifact made by a call is stored with: the call's context label joined with its result's. */
export function storedLabel(contextLabel: ContentLabel | undefined, resultLabel: ContentLabel): ContentLabel {
  return contextLabel === undefined ? resultLabel : joinLabels(contextLabel, resultLabel);
}
