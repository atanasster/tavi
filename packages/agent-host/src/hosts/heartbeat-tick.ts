import {
  HEARTBEAT_LIMITS,
  HEARTBEAT_FETCH_TOOL_ID,
  HEARTBEAT_REPORT_TOOL_ID,
  HEARTBEAT_TOOL_ALLOWLIST,
  HeartbeatItemSchema,
  heartbeatProviderFailure,
  HeartbeatProviderError,
  type HeartbeatItem,
  type HeartbeatReceive,
  type BudgetLeft,
  type HeartbeatSignal,
  type MemoryExcerpt,
  type HeartbeatState,
  type HeartbeatWakeReason,
  type LedgerEntry,
  type ModelUsage,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { HeartbeatProviderEntry, HeartbeatProviderStates } from "./heartbeat-signals.js";

import type { HeartbeatHostDependencies } from "./heartbeat-host.js";

/**
 * One heartbeat tick's body: the provider asked with what it may receive,
 * its turns' requests and results, and the budget a tick is given.
 */

/** What one tick's body answers, recorded as the tick's row. */
export interface HeartbeatTickBodyResult {
  /** `skipped` only for a dev provider's tick cut short by its reload: it neither told nor failed. */
  readonly outcome: "quiet" | "quiet:withheld" | "reported" | "failed" | "skipped";
  readonly kind: "signal" | "deep";
  readonly reason?: string;
  readonly items: readonly HeartbeatItem[];
  readonly taskId?: string;
  readonly tokens?: number;
  readonly cacheReadTokens?: number;
  readonly costUsd?: number | null;
  readonly inputs?: unknown;
  readonly hookDecisions?: unknown;
  readonly memo?: string;
  /** When the provider would like to look again; clamped by the host. */
  readonly nextWakeHint?: string;
  readonly error?: string;
}

export interface HeartbeatTickBodyInput {
  readonly state: HeartbeatState;
  readonly entry: HeartbeatProviderEntry;
  readonly wake: { readonly reason: HeartbeatWakeReason; readonly scheduledAt: string; readonly now: string; readonly timezone: string };
  /** A signal tick sees only its new signals; a deep tick the whole instruction list, and any new signals. */
  readonly kind: "signal" | "deep";
  /** New or changed since the last collection, redacted. */
  readonly signals: readonly HeartbeatSignal[];
  /** Keys seen before and gone now: what retraction acts on. */
  readonly gone: readonly string[];
  /** The tick's memory context, bounded and redacted. */
  readonly memory: readonly MemoryExcerpt[];
  /** What it told lately and what became of it — the person's 👍/👎, mutes, snoozes, resolutions (egress `ledger`). */
  readonly recent: readonly LedgerEntry[];
  /** What is left of today's budget, and the reservation every model call makes first. */
  readonly budget: HeartbeatTickBudget;
  readonly signal: AbortSignal;
}

/** A model call's cost: tokens, and dollars when the model is priced. */
export interface HeartbeatCost {
  readonly tokens: number;
  readonly usd?: number;
}

/**
 * A tick's share of the day's budget. A model call reserves its worst case
 * (remaining steps × the most output, plus the prompt — in tokens, and in
 * dollars when the model is priced) before it runs and is refused past what
 * is left; what it really spent is then counted instead. A reservation is
 * never less than what the call can spend, so neither cap is passed.
 */
export interface HeartbeatTickBudget {
  readonly left: BudgetLeft;
  /** Whether `cost` more fits in what is left; when it does it is held until `spend`. */
  reserve(cost: HeartbeatCost): boolean;
  /** Replace a reservation with what the call really spent. */
  spend(reserved: HeartbeatCost, spent: HeartbeatCost): void;
}

/** A tick's budget over what is left: reservations and spending tracked within the tick, in tokens and dollars. */
export function tickBudget(left: BudgetLeft): HeartbeatTickBudget {
  let tokens = 0;
  let usd = 0;
  return {
    left,
    reserve(cost) {
      if (cost.tokens < 0 || (cost.usd ?? 0) < 0 || tokens + cost.tokens > left.tokens) return false;
      if (left.usd !== undefined && usd + (cost.usd ?? 0) > left.usd) return false;
      tokens += cost.tokens;
      usd += cost.usd ?? 0;
      return true;
    },
    spend(reserved, spent) {
      tokens = Math.max(0, tokens - reserved.tokens) + Math.max(0, spent.tokens);
      usd = Math.max(0, usd - (reserved.usd ?? 0)) + Math.max(0, spent.usd ?? 0);
    },
  };
}

/** One unattended model turn a provider asked for (`host.runTurn`), as the owner runs it. */
export interface HeartbeatTurnRequest {
  readonly state: HeartbeatState;
  /** Deterministic per tick and turn: a re-dispatch replays the admission instead of running twice. */
  readonly operationKey: string;
  readonly prompt: string;
  /** The tools the turn may use, `heartbeat.report` always among them; the owner may narrow them further, never widen. */
  readonly tools: readonly string[];
  readonly model: "fast" | "main";
  /** Whether the turn may draw on the person's memory and history: a built-in provider's always, an external one's only with `memory` egress. */
  readonly personal: boolean;
  /** Whether the provider was handed memory this tick, so the turn's prompt may carry its block: never when withheld, nor when none was found. */
  readonly memoryShown?: boolean;
  /** The tick it belongs to: its turns share the tick's limits (`heartbeat.fetch`'s pages). */
  readonly tickKey: string;
  /** The tick's budget: the turn reserves its worst case before it runs, and spends what it used. */
  readonly budget: HeartbeatTickBudget;
  readonly signal: AbortSignal;
}

/** What a turn left: the items it reported (validated again by the host), its task, its usage, and whether a tool result was withheld. */
export interface HeartbeatTurnResult {
  readonly items: readonly unknown[];
  readonly taskId: string;
  readonly usage: ModelUsage;
  readonly tokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number | null;
  /** A hook withheld a tool result in the turn: a quiet tick is then `quiet:withheld`. */
  readonly withheld: boolean;
  /** The run completed; a turn that did not still counts what it spent, and fails the tick. */
  readonly completed: boolean;
}

/** Validate what a provider or a turn reported: read once as plain JSON, against the host's schema, capped. */
function validItems(answer: unknown): HeartbeatItem[] {
  const raw: unknown = JSON.parse(JSON.stringify(answer ?? []));
  return (Array.isArray(raw) ? raw : []).slice(0, HEARTBEAT_LIMITS.maxItems).flatMap((item) => {
    const parsed = HeartbeatItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Whether a provider's turns may read the person (memory, history, their extra tools): a built-in's always, an external one's only with `memory` egress. */
export function heartbeatTurnPersonal(entry: Pick<HeartbeatProviderEntry, "kind" | "receives">, state: HeartbeatState): boolean {
  return entry.kind === "builtin" || (entry.receives.includes("memory") && state.config.providerEgress.memory);
}

/**
 * The tools a provider's turn may use: what it asked for within
 * the allowlist and the person's `extraTools`, and `heartbeat.report`. An
 * external provider's egress narrows them too: nothing that reads the person
 * — memory, past chats, reminders, projects, reports or an extra tool —
 * unless `memory` is on, and no `heartbeat.fetch` unless `signals` is.
 * `heartbeat.fetch` is offered only when the heartbeat may read some host; the shared `web_fetch`,
 * which reads the operator's own list, never.
 */
export function heartbeatTurnTools(
  entry: Pick<HeartbeatProviderEntry, "kind" | "receives">,
  state: HeartbeatState,
  asked?: readonly string[],
): readonly string[] {
  const external = entry.kind !== "builtin";
  const memoryAllowed = heartbeatTurnPersonal(entry, state);
  const fetchAllowed =
    state.config.fetchHosts.length > 0 && (!external || (entry.receives.includes("signals") && state.config.providerEgress.signals));
  const candidates = [...HEARTBEAT_TOOL_ALLOWLIST, ...state.config.extraTools].filter(
    (id) =>
      id !== HEARTBEAT_REPORT_TOOL_ID &&
      id !== "web_fetch" &&
      (fetchAllowed || id !== HEARTBEAT_FETCH_TOOL_ID) &&
      (memoryAllowed || id === HEARTBEAT_FETCH_TOOL_ID),
  );
  const chosen = asked === undefined ? candidates : candidates.filter((id) => asked.includes(id));
  return [...new Set(chosen), HEARTBEAT_REPORT_TOOL_ID];
}

/**
 * The default tick body: the provider is asked with what it may receive, its
 * turns run through `deps.runTurn`, and what it and its turns reported is
 * validated, merged by key and recorded — never delivered by the provider,
 * which gets back only the keys and urgencies its turns reported.
 */
export function askProvider(
  runTurn: HeartbeatHostDependencies["runTurn"],
  states?: HeartbeatProviderStates,
): (input: HeartbeatTickBodyInput) => Promise<HeartbeatTickBodyResult> {
  return async (input) => {
    const { state, entry, wake, signal } = input;
    const external = entry.kind === "plugin";
    const may = (field: HeartbeatReceive): boolean => !external || (entry.receives.includes(field) && state.config.providerEgress[field]);
    const turns: HeartbeatTurnResult[] = [];
    let started = 0;
    const reported: HeartbeatItem[] = [];
    const host = Object.freeze({
      runTurn: async (request: { readonly prompt: string; readonly tools?: readonly string[]; readonly model?: "fast" | "main" }) => {
        if (!entry.usesTurns) throw new Error("this provider did not declare model turns");
        if (runTurn === undefined) throw new Error("model turns are not available in this owner");
        if (started >= HEARTBEAT_LIMITS.turnsPerTick) throw new Error(`a tick runs at most ${HEARTBEAT_LIMITS.turnsPerTick} model turns`);
        if (signal.aborted) throw new Error("the heartbeat tick was stopped");
        // Counted before anything is awaited, so turns started together still keep the limit and their own keys.
        started += 1;
        const n = started;
        const result = await runTurn({
          state,
          operationKey: `heartbeat:${state.workspaceId}:${state.principalId}:${wake.scheduledAt}:${wake.reason}:${n}`,
          prompt: String(request.prompt),
          tools: heartbeatTurnTools(
            entry,
            state,
            Array.isArray(request.tools) ? request.tools.filter((id): id is string => typeof id === "string") : undefined,
          ),
          model: request.model === "main" ? "main" : "fast",
          personal: heartbeatTurnPersonal(entry, state),
          memoryShown: may("memory") && input.memory.length > 0,
          tickKey: `heartbeat:${state.workspaceId}:${state.principalId}:${wake.scheduledAt}:${wake.reason}`,
          budget: input.budget,
          signal,
        });
        turns.push(result);
        if (!result.completed) throw new HeartbeatProviderError("transport");
        const items = validItems(result.items);
        reported.push(...items);
        return Object.freeze({
          reported: Object.freeze(items.map((item) => Object.freeze({ key: item.key, urgency: item.urgency }))),
          usage: Object.freeze({ ...result.usage }),
        });
      },
      publish: (key: string, value: unknown): void => {
        if (signal.aborted) throw new Error("the heartbeat tick was stopped");
        states?.publish(state, state.config.providerId, key, value);
      },
    });
    const usage = () => ({
      ...(turns[0] === undefined ? {} : { taskId: turns[0].taskId }),
      tokens: turns.reduce((sum, turn) => sum + turn.tokens, 0),
      cacheReadTokens: turns.reduce((sum, turn) => sum + turn.cacheReadTokens, 0),
      costUsd:
        turns.length === 0 || turns.some((turn) => turn.costUsd === null)
          ? null
          : turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
    });
    try {
      const answer = await entry.provider.tick(
        Object.freeze({
          wake: Object.freeze({ ...wake }),
          kind: input.kind,
          ...(may("instructions") ? { instructions: state.config.instructions } : {}),
          signals: Object.freeze(may("signals") ? input.signals.map((signal) => Object.freeze({ ...signal })) : []),
          recent: Object.freeze(may("ledger") ? input.recent.map((entry) => Object.freeze({ ...entry })) : []),
          memory: Object.freeze(may("memory") ? input.memory.map((record) => Object.freeze({ ...record })) : []),
          ...(state.memo === undefined ? {} : { memo: state.memo }),
          limits: Object.freeze({
            maxItems: HEARTBEAT_LIMITS.maxItems,
            deadlineMs: entry.maxTickSeconds * 1000,
            budgetLeft: Object.freeze({ ...input.budget.left }),
          }),
          host,
          signal,
        }),
      );
      // Merged by key: an item the provider returned stands over one its turn reported under the same key.
      const merged = new Map<string, HeartbeatItem>();
      for (const item of [...reported, ...validItems(answer?.items)]) merged.set(item.key, item);
      const items = [...merged.values()].slice(0, HEARTBEAT_LIMITS.maxItems);
      const memo = typeof answer?.memo === "string" ? answer.memo : undefined;
      const nextWakeHint = typeof answer?.nextWakeHint === "string" ? answer.nextWakeHint : undefined;
      const outcome = items.length > 0 ? "reported" : turns.some((turn) => turn.withheld) ? "quiet:withheld" : "quiet";
      return {
        outcome,
        kind: input.kind,
        items,
        ...usage(),
        ...(memo === undefined ? {} : { memo }),
        ...(nextWakeHint === undefined ? {} : { nextWakeHint }),
      };
    } catch (error) {
      return {
        outcome: "failed",
        kind: input.kind,
        items: [],
        ...usage(),
        reason: heartbeatProviderFailure(error),
        error: errorMessage(error, "the provider failed").slice(0, 500),
      };
    }
  };
}
