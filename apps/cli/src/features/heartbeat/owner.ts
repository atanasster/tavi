import {
  BUILTIN_HEARTBEAT_PROVIDER_ID,
  DEFAULT_WORKSPACE_ID,
  HEARTBEAT_ABI,
  withWatchedHosts,
  describeHeartbeatDeclaration,
  HEARTBEAT_LIMITS,
  HEARTBEAT_RECEIVES,
  type HeartbeatReceive,
  type HeartbeatToolChoice,
  HEARTBEAT_HISTORY_DEFAULT,
  HEARTBEAT_LOG_DEFAULT,
  HeartbeatConfigSchema,
  TaviError,
  defaultHeartbeatConfig,
  heartbeatIntervalProblem,
  heartbeatItemView,
  heartbeatStateView,
  memoryCardTitleOf,
  operatorSeesMemory,
  HEARTBEAT_RECENT_DEFAULT,
  hostTimeZone,
  nextHeartbeatAt,
  startOfLocalDay,
  type HeartbeatConfig,
  type HeartbeatForgetAnswer,
  type HeartbeatGetAnswer,
  type HeartbeatHistoryAnswer,
  type HeartbeatHistoryRemoved,
  type HeartbeatInstructionsAnswer,
  type HeartbeatItemAnswer,
  type HeartbeatLedgerRow,
  type HeartbeatLogAnswer,
  type HeartbeatOptions,
  type HeartbeatPayload,
  type HeartbeatRecentAnswer,
  type HeartbeatRunNowAnswer,
  type HeartbeatState,
  type PersistencePort,
  hostOfUrl,
  joinLabels,
  joinMemoryProvenance,
  memoryProvenanceUntrusted,
  type MemoryProvenance,
  untrustedLabel,
  type ContentLabel,
} from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { z } from "zod";

import type { HeartbeatProviderStates } from "@tavi/agent-host/heartbeat-host";

import type { IpcAnswer } from "../../shared/ipc-decisions.js";

/** An installed provider as the heartbeat command describes it. */
interface HeartbeatInstalledProvider {
  readonly id: string;
  readonly kind: "builtin" | "plugin";
  readonly receives: readonly HeartbeatReceive[];
  readonly usesTurns: boolean;
  readonly maxTickSeconds: number;
}

/**
 * `heartbeat`: the operator's heartbeat
 * in a workspace — read, changed by compare-and-set on its revision, paused
 * and resumed, checked now, its log, items and instructions history, and
 * *Forget heartbeat history*. Only the operator has a heartbeat in v1: any
 * other principal is refused. Intervals must be among this owner's choices.
 */
export interface HeartbeatCommandDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "heartbeats" | "workspaceSettings"> & {
    /** The memory rows an item's "because you said …" names are read from; absent, it names none. */
    readonly memory?: Pick<PersistencePort["repositories"]["memory"], "getRecord" | "getRevision">;
  };
  /** The operator principal a workspace is served for, or undefined for one this owner does not serve. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly options: HeartbeatOptions;
  /** The providers installed here; none offline, where no provider runs. */
  readonly providers: () => readonly HeartbeatInstalledProvider[];
  /** The read-only plugin tools a person may add to its checks; none offline. */
  readonly toolChoices?: () => readonly HeartbeatToolChoice[];
  /** The signal sources installed here; none offline. */
  readonly sources?: () => readonly { readonly id: string; readonly kind: "builtin" | "plugin"; readonly label?: string }[];
  /** What providers published for their panels; absent offline, where none runs. */
  readonly providerStates?: Pick<HeartbeatProviderStates, "get" | "forget">;
  /** The running host, for Check now; undefined where none runs. */
  readonly host: () =>
    | {
        checkNow(
          workspaceId: string,
          principalId: string,
        ): Promise<{ readonly status: "started" | "queued" } | { readonly status: "refused"; readonly reason: string }>;
      }
    | undefined;
  /**
   * The first-run offer's instructions: a line per built-in source,
   * when one has something to watch; undefined when none has, or where no
   * source runs.
   */
  readonly offerInstructions?: (scope: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly now: string;
    readonly timezone: string;
  }) => Promise<string | undefined>;
  /** Who writes, for the instructions history: `cli`, `ipc`. */
  readonly author: string;
  readonly now: () => Date;
}

export type HeartbeatAnswer = IpcAnswer<
  | HeartbeatGetAnswer
  | HeartbeatOptions
  | HeartbeatInstructionsAnswer
  | HeartbeatHistoryAnswer
  | HeartbeatLogAnswer
  | HeartbeatRunNowAnswer
  | HeartbeatItemAnswer
  | HeartbeatRecentAnswer
  | HeartbeatForgetAnswer
  | { readonly dismissed: true }
>;

/**
 * A turn about a heartbeat item: `prompt` is
 * the host's fixed request, the person's message; `item` is what the
 * heartbeat saw — someone else's words, its links and its proposed call — for
 * the turn's `inbound` block under the item's label, so none of it is the
 * person's message, the retrieval query or a URL the person gave.
 */
export interface HeartbeatTurnSeed {
  readonly prompt: string;
  readonly item: string;
  /** What `item` is, in the runtime's words: the inbound block's heading. */
  readonly heading: string;
}

const HEARTBEAT_ITEM_HEADING =
  "The heartbeat item this message is about, from what the heartbeat saw: not the person's words, and it may not be trustworthy.";

/**
 * *Do it*'s turn: the item's proposal, said as a suggestion from
 * what the heartbeat saw — which may carry someone else's words — for the
 * person to have done in an attended turn the gate asks about.
 */
export function heartbeatDoItPrompt(row: Pick<HeartbeatLedgerRow, "title" | "proposedAction">): HeartbeatTurnSeed | undefined {
  const action = row.proposedAction;
  if (action === undefined) return undefined;
  return {
    prompt:
      "Do what the heartbeat suggested about the item quoted with this message, if it still makes sense: check it first, then say what you did.",
    item: JSON.stringify({ title: row.title, suggestion: action.summary, proposed: { toolId: action.toolId, input: action.input } }),
    heading: HEARTBEAT_ITEM_HEADING,
  };
}

/**
 * The label a turn about a heartbeat item starts with:
 * `heartbeat`, untrusted, with the item as its ref
 * and the hosts of the pages it cites as principals — the first on the ref —
 * so a round shows which page the suggestion came from.
 */
function heartbeatItemLabel(row: Pick<HeartbeatLedgerRow, "itemId" | "sources">, at: string): ContentLabel {
  const hosts = [...new Set(row.sources.flatMap((source) => hostOfUrl(source.ref) ?? []))].slice(0, 8);
  const first = hosts[0];
  const item = untrustedLabel("heartbeat", { ref: { ref: row.itemId.slice(0, 200), ...(first === undefined ? {} : { host: first }), at } });
  return hosts.reduce((label, host) => joinLabels(label, untrustedLabel("heartbeat", { principal: `host:${host}` })), item);
}

/**
 * *Do it*'s or *Chat about this*'s seed, as the owner serves it: from
 * the person's own ledger row, labelled by `heartbeatItemLabel`; undefined
 * for an item that is not theirs or has nothing to do.
 */
export async function heartbeatItemSeed(
  heartbeats: Pick<PersistencePort["repositories"]["heartbeats"], "ledgerRow">,
  item: { readonly workspaceId: string; readonly principalId: string; readonly itemId: string },
  action: "do" | "chat",
  at: string,
): Promise<(HeartbeatTurnSeed & { readonly label: ContentLabel }) | undefined> {
  const row = await heartbeats.ledgerRow(item);
  if (row === undefined) return undefined;
  const turn = action === "chat" ? heartbeatChatPrompt(row) : heartbeatDoItPrompt(row);
  return turn === undefined ? undefined : { ...turn, label: heartbeatItemLabel(row, at) };
}

/** *Chat about this*'s turn: the item quoted, from the owner's ledger, for the person to ask about. */
export function heartbeatChatPrompt(row: Pick<HeartbeatLedgerRow, "title" | "body" | "sources">): HeartbeatTurnSeed {
  const first = (row.body ?? "").split("\n")[0] ?? "";
  return {
    prompt: "Tell me more about the heartbeat item quoted with this message.",
    item: JSON.stringify({
      title: row.title,
      ...(first === "" ? {} : { body: first }),
      sources: row.sources.map((source) => source.label),
    }),
    heading: HEARTBEAT_ITEM_HEADING,
  };
}

/** *Forget heartbeat history*: the provider's panel goes too, and today's spend (in the workspace's timezone) stays counted. */
export async function forgetHeartbeatHistory(
  deps: {
    readonly heartbeats: Pick<PersistencePort["repositories"]["heartbeats"], "forget">;
    readonly workspaceSettings: Pick<PersistencePort["repositories"]["workspaceSettings"], "get">;
    readonly providerStates?: Pick<HeartbeatProviderStates, "forget"> | undefined;
  },
  at: { readonly workspaceId: string; readonly principalId: string; readonly now: Date },
): Promise<HeartbeatHistoryRemoved> {
  deps.providerStates?.forget(at.workspaceId, at.principalId);
  const timezone = (await deps.workspaceSettings.get(at.workspaceId)).settings.timezone ?? hostTimeZone();
  return await deps.heartbeats.forget({
    workspaceId: at.workspaceId,
    principalId: at.principalId,
    now: at.now.toISOString(),
    keepUsageSince: startOfLocalDay(at.now, timezone).toISOString(),
  });
}

/** Place a heartbeat's next check again in the workspace's (new) timezone: its hours are local, so a zone change moves them. */
export async function rescheduleHeartbeat(
  heartbeats: Pick<PersistencePort["repositories"]["heartbeats"], "get" | "setNextTick">,
  at: { readonly workspaceId: string; readonly principalId: string; readonly timezone: string; readonly now: Date },
): Promise<void> {
  const state = await heartbeats.get(at.workspaceId, at.principalId);
  if (state === undefined || !state.config.enabled) return;
  await heartbeats.setNextTick({
    workspaceId: at.workspaceId,
    principalId: at.principalId,
    nextTickAt: nextHeartbeatAt(state.config, at.timezone, at.now, at.principalId).toISOString(),
    now: at.now.toISOString(),
  });
}

/**
 * Save a changed heartbeat as the next revision: compare-and-set on the
 * revision the writer named (else the current one), the intervals held to
 * this owner's choices, and the next tick placed when it is on. Shared by
 * the `heartbeat` command and the agent's `heartbeat.propose`.
 */
export async function saveHeartbeatChange(
  deps: {
    readonly heartbeats: PersistencePort["repositories"]["heartbeats"];
    readonly options: HeartbeatOptions;
    readonly author: string;
    readonly provenance?: MemoryProvenance | undefined;
  },
  at: { readonly workspaceId: string; readonly principalId: string; readonly timezone: string; readonly now: Date },
  change: (config: HeartbeatConfig) => HeartbeatConfig,
  expected: number | undefined,
): Promise<HeartbeatState> {
  const current = await deps.heartbeats.get(at.workspaceId, at.principalId);
  const currentRevision = current?.config.revision ?? 0;
  if (expected !== undefined && expected !== currentRevision) {
    throw new TaviError(
      "CONFLICT",
      `The heartbeat changed since revision ${expected} (it is at ${currentRevision}); read it again and retry`,
    );
  }
  const base = current?.config ?? { ...defaultHeartbeatConfig(), revision: 1 };
  // A page newly watched is a host it may read: the person approves both in this one change.
  const { provenance: _kept, ...changed } = change(base);
  // Its provenance: a chat's proposal under taint joins in; the person rewriting the instructions clears it.
  const provenance =
    deps.author !== "chat" && changed.instructions !== base.instructions
      ? undefined
      : joinMemoryProvenance(base.provenance, memoryProvenanceUntrusted(deps.provenance) ? deps.provenance : undefined);
  const next = withWatchedHosts(base.instructions, provenance === undefined ? changed : { ...changed, provenance });
  const parsed = HeartbeatConfigSchema.safeParse(next);
  if (!parsed.success) throw new TaviError("INVALID_INPUT", zodIssues(parsed.error, "config").join("; "));
  // A daily token limit below one check's worst case would let no check run, and pause it every day as if spent.
  const tokens = parsed.data.budget.tokensPerDay;
  if (tokens < HEARTBEAT_LIMITS.minTokensPerDay && tokens !== base.budget.tokensPerDay) {
    throw new TaviError(
      "INVALID_INPUT",
      `The daily token limit must be at least ${HEARTBEAT_LIMITS.minTokensPerDay.toLocaleString("en-US")}: each check reserves its worst case before it runs`,
    );
  }
  const problem = heartbeatIntervalProblem(parsed.data, deps.options);
  if (problem !== undefined) throw new TaviError("INVALID_INPUT", problem.charAt(0).toUpperCase() + problem.slice(1));
  const nextTickAt = parsed.data.enabled ? nextHeartbeatAt(parsed.data, at.timezone, at.now, at.principalId).toISOString() : undefined;
  return await deps.heartbeats.save({
    workspaceId: at.workspaceId,
    principalId: at.principalId,
    config: parsed.data,
    expectedRevision: currentRevision,
    author: deps.author,
    now: at.now.toISOString(),
    ...(nextTickAt === undefined ? {} : { nextTickAt }),
  });
}

/** The states each item op may change; feedback is given in any. */
const ITEM_OP_FROM: Readonly<Record<string, readonly HeartbeatLedgerRow["state"][] | undefined>> = {
  // A snooze that has run out leaves the item snoozed until it is told again: it may be snoozed afresh (one still running may not).
  snooze: ["told", "snoozed"],
  mute: ["told", "snoozed"],
  unsnooze: ["snoozed"],
  unmute: ["muted"],
};

export async function heartbeatCommand(deps: HeartbeatCommandDependencies, payload: HeartbeatPayload): Promise<HeartbeatAnswer> {
  try {
    const workspaceId = payload.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const operator = deps.principalOf(workspaceId);
    if (operator === undefined)
      throw new TaviError("NOT_FOUND", `workspace ${workspaceId} is not configured on this owner`, { details: { workspaceId } });
    const principalId = payload.principalId ?? operator;
    if (principalId !== operator) throw new TaviError("NOT_AUTHORIZED", "Only the workspace operator has a heartbeat in this version");
    const heartbeats = deps.repositories.heartbeats;
    const now = deps.now();
    const stamp = now.toISOString();
    const scope = { workspaceId, principalId };
    const timezone = (await deps.repositories.workspaceSettings.get(workspaceId)).settings.timezone ?? hostTimeZone();

    const view = async (state?: HeartbeatState, offering = false): Promise<HeartbeatGetAnswer> => {
      const current = state ?? (await heartbeats.get(workspaceId, principalId));
      // Offered once: only before anything was saved (turned on, configured or *Not now*), and only when there is something to watch.
      const offered = offering && current === undefined ? await deps.offerInstructions?.({ ...scope, now: stamp, timezone }) : undefined;
      const published = current === undefined ? undefined : deps.providerStates?.get(workspaceId, principalId, current.config.providerId);
      return {
        workspaceId,
        principalId,
        ...(current === undefined ? {} : { state: heartbeatStateView(current) }),
        config: current?.config ?? { ...defaultHeartbeatConfig() },
        revision: current?.config.revision ?? 0,
        options: deps.options,
        timezone,
        hostRunning: deps.host() !== undefined,
        providers: deps.providers().map((provider) => provider.id),
        providerDetails: deps.providers().map((provider) => ({
          id: provider.id,
          kind: provider.kind,
          receives: provider.receives,
          ...(provider.kind === "plugin"
            ? {
                disclosure: describeHeartbeatDeclaration({
                  abi: HEARTBEAT_ABI,
                  receives: [...provider.receives],
                  usesTurns: provider.usesTurns,
                  maxTickSeconds: provider.maxTickSeconds,
                }),
              }
            : {}),
        })),
        ...(offered === undefined ? {} : { offer: { instructions: offered } }),
        toolChoices: deps.toolChoices?.() ?? [],
        sources: deps.sources?.() ?? [],
        ...(published === undefined ? {} : { providerState: published }),
      };
    };
    /** The heartbeat, or `NOT_FOUND` for one never saved: there is nothing to pause, check or forget. */
    const existing = async (): Promise<HeartbeatState> => {
      const state = await heartbeats.get(workspaceId, principalId);
      if (state === undefined) throw new TaviError("NOT_FOUND", "There is no heartbeat yet; turn it on first (tavi heartbeat on)");
      return state;
    };
    const write = (change: (config: HeartbeatConfig) => HeartbeatConfig, expected: number | undefined): Promise<HeartbeatState> =>
      saveHeartbeatChange({ heartbeats, options: deps.options, author: deps.author }, { ...scope, timezone, now }, change, expected);
    const revisionOf = (value: { readonly revision?: number | undefined }): number | undefined => value.revision;
    /**
     * An egress switch is only for what the selected plugin provider declared:
     * one turned on for anything else would, unseen, hand a later version that
     * declares it that data from its first check.
     */
    const undeclaredEgress = async (fields: readonly HeartbeatReceive[]): Promise<void> => {
      const providerId = (await heartbeats.get(workspaceId, principalId))?.config.providerId;
      if (providerId === undefined || providerId === BUILTIN_HEARTBEAT_PROVIDER_ID || providerId === "off" || fields.length === 0) return;
      const provider = deps.providers().find((candidate) => candidate.id === providerId);
      // Not loaded here: what it declares cannot be read, so nothing is turned on for it.
      if (provider === undefined)
        throw new TaviError("INVALID_INPUT", `The provider ${providerId} is not loaded here; turn its switches on where it runs`);
      const missing = provider.kind !== "plugin" ? [] : fields.filter((field) => !provider.receives.includes(field));
      if (missing.length > 0)
        throw new TaviError("INVALID_INPUT", `The provider ${providerId} does not ask to receive ${missing.join(", ")}`);
    };

    switch (payload.action) {
      case "get":
        return { ok: true, result: await view(undefined, payload.offer === true) };
      case "options":
        return { ok: true, result: deps.options };
      case "set": {
        // Only the settings named: a field the change leaves out keeps its value, and one named `null` is cleared.
        const named = Object.fromEntries(
          Object.entries(payload.changes).filter(([, value]) => value !== undefined && value !== null),
        ) as Partial<HeartbeatConfig>;
        const cleared = new Set(
          Object.entries(payload.changes)
            .filter(([, value]) => value === null)
            .map(([key]) => key),
        );
        if (named.providerEgress !== undefined)
          await undeclaredEgress(HEARTBEAT_RECEIVES.filter((field) => named.providerEgress?.[field] === true));
        // Extra tools are a loaded plugin's read-only tools only: never a built-in, which the allowlist already decides.
        // Only those the change adds are checked: one saved before whose plugin is not loaded now is kept, and skipped at run time.
        const choices = deps.toolChoices?.();
        return {
          ok: true,
          result: await view(
            await write((config) => {
              const unknown =
                choices === undefined
                  ? []
                  : (named.extraTools ?? []).filter(
                      (toolId) => !config.extraTools.includes(toolId) && !choices.some((choice) => choice.id === toolId),
                    );
              if (unknown.length > 0)
                throw new TaviError("INVALID_INPUT", `Not a plugin's read-only tool the heartbeat may use: ${unknown.join(", ")}`);
              const kept = Object.fromEntries(Object.entries(config).filter(([key]) => !cleared.has(key))) as HeartbeatConfig;
              return { ...kept, ...named };
            }, revisionOf(payload)),
          ),
        };
      }
      case "instructions": {
        const state = await heartbeats.get(workspaceId, principalId);
        return { ok: true, result: { text: state?.config.instructions ?? "", revision: state?.config.revision ?? 0 } };
      }
      case "set-instructions":
        return { ok: true, result: await view(await write((config) => ({ ...config, instructions: payload.text }), revisionOf(payload))) };
      case "history":
        return {
          ok: true,
          result: { history: await heartbeats.instructionsHistory({ ...scope, limit: payload.limit ?? HEARTBEAT_HISTORY_DEFAULT }) },
        };
      case "run-now": {
        await existing();
        const host = deps.host();
        if (host === undefined)
          throw new TaviError("UNAVAILABLE", "Check now needs an owner running the heartbeat (tavi serve, with tavi.heartbeat enabled)");
        const answer = await host.checkNow(workspaceId, principalId);
        if (answer.status === "refused") throw new TaviError("CONFLICT", answer.reason);
        return { ok: true, result: { status: answer.status } };
      }
      case "pause": {
        const paused = (await existing()).config.paused;
        // A timed pause over the heartbeat's own (repeated failures, the budget, a missing provider) would end that one when
        // it runs out: the person resumes it first.
        if (
          payload.forMs !== undefined &&
          paused !== undefined &&
          paused.reason !== "user" &&
          (paused.until === undefined || Date.parse(paused.until) > now.getTime())
        ) {
          throw new TaviError("CONFLICT", `The heartbeat is paused (${paused.reason}); resume it before pausing it for a while`);
        }
        await heartbeats.setPaused({
          ...scope,
          paused: {
            reason: "user",
            ...(payload.forMs === undefined ? {} : { until: new Date(now.getTime() + payload.forMs).toISOString() }),
          },
          now: stamp,
        });
        return { ok: true, result: await view() };
      }
      case "resume": {
        // Any pause ends when the person acts: their own, the budget's, failures', a missing provider's.
        const state = await existing();
        await heartbeats.setPaused({ ...scope, paused: null, now: stamp });
        if (state.config.enabled) await rescheduleHeartbeat(heartbeats, { ...scope, timezone, now });
        return { ok: true, result: await view() };
      }
      case "log":
        return {
          ok: true,
          result: {
            ticks: await heartbeats.listTicks({
              ...scope,
              limit: payload.limit ?? HEARTBEAT_LOG_DEFAULT,
              ...(payload.since === undefined ? {} : { since: payload.since }),
            }),
          },
        };
      case "items": {
        // Each op applies only to an item in a state it can change (as a channel's buttons): undo only undoes, and a
        // settled item (resolved, held back, already muted) is answered as it is, never snoozed back to life.
        const from = ITEM_OP_FROM[payload.op];
        const current = from === undefined ? undefined : await heartbeats.ledgerRow({ ...scope, itemId: payload.itemId });
        // A snooze still running is not cut short by a stale card's Snooze: only one that has run out is snoozed afresh.
        const stillSnoozed =
          payload.op === "snooze" &&
          current?.state === "snoozed" &&
          current.snoozedUntil !== undefined &&
          Date.parse(current.snoozedUntil) > now.getTime();
        const item =
          current !== undefined && from !== undefined && (!from.includes(current.state) || stillSnoozed)
            ? current
            : payload.op === "feedback"
              ? await heartbeats.setItemFeedback({ ...scope, itemId: payload.itemId, feedback: payload.feedback ?? null, now: stamp })
              : await heartbeats.setItemState({
                  ...scope,
                  itemId: payload.itemId,
                  // Un-snoozed or un-muted, it is told again as before.
                  state: payload.op === "snooze" ? "snoozed" : payload.op === "mute" ? "muted" : "told",
                  ...(payload.op === "snooze"
                    ? { snoozedUntil: new Date(now.getTime() + (payload.minutes ?? 60) * 60_000).toISOString() }
                    : {}),
                  now: stamp,
                });
        if (item === undefined) throw new TaviError("NOT_FOUND", `Heartbeat item ${payload.itemId} does not exist`);
        return { ok: true, result: { item: heartbeatItemView(item) } };
      }
      case "item": {
        const item = await heartbeatItemRow(heartbeats, { ...scope, itemId: payload.itemId });
        const because = await heartbeatItemBecause(deps.repositories, scope, item);
        return { ok: true, result: { item: heartbeatItemView(item), ...(because.length === 0 ? {} : { because }) } };
      }
      case "recent":
        // What a mod held back was never told: it is on the log's record, not among what the heartbeat said.
        return {
          ok: true,
          result: {
            items: (await heartbeats.recentItems({ ...scope, limit: payload.limit ?? HEARTBEAT_RECENT_DEFAULT, told: true })).map(
              heartbeatItemView,
            ),
          },
        };
      case "mute":
        return {
          ok: true,
          result: await view(
            await write(
              (config) => ({ ...config, mutes: config.mutes.includes(payload.prefix) ? config.mutes : [...config.mutes, payload.prefix] }),
              revisionOf(payload),
            ),
          ),
        };
      case "unmute":
        return {
          ok: true,
          result: await view(
            await write((config) => ({ ...config, mutes: config.mutes.filter((mute) => mute !== payload.prefix) }), revisionOf(payload)),
          ),
        };
      case "set-provider": {
        const providerId = payload.providerId === "builtin" ? BUILTIN_HEARTBEAT_PROVIDER_ID : payload.providerId;
        // On an owner, which knows what is installed, a provider that is not (a typo) is refused rather than saved to pause on.
        const installed = deps.providers();
        if (
          installed.length > 0 &&
          providerId !== "off" &&
          providerId !== BUILTIN_HEARTBEAT_PROVIDER_ID &&
          !installed.some((provider) => provider.id === providerId)
        ) {
          throw new TaviError(
            "INVALID_INPUT",
            `No heartbeat provider ${providerId} is installed here (${installed.map((provider) => provider.id).join(", ")}, or off)`,
          );
        }
        const before = await heartbeats.get(workspaceId, principalId);
        // What the old provider was allowed to receive is not the new one's: its egress starts off again.
        const saved = await write(
          (config) =>
            config.providerId === providerId ? config : { ...config, providerId, providerEgress: defaultHeartbeatConfig().providerEgress },
          revisionOf(payload),
        );
        // A new provider starts without the old one's notes.
        if (before !== undefined && before.config.providerId !== providerId) await heartbeats.setMemo({ ...scope, memo: null, now: stamp });
        // Choosing a provider, the same one too (its plugin is back), is the person acting on a provider pause.
        if (saved.config.paused?.reason === "provider") await heartbeats.setPaused({ ...scope, paused: null, now: stamp });
        return { ok: true, result: await view() };
      }
      case "egress":
        if (payload.on) await undeclaredEgress([payload.field]);
        return {
          ok: true,
          result: await view(
            await write(
              (config) => ({ ...config, providerEgress: { ...config.providerEgress, [payload.field]: payload.on } }),
              revisionOf(payload),
            ),
          ),
        };
      case "forget":
        await existing();
        return {
          ok: true,
          result: {
            removed: await forgetHeartbeatHistory(
              { heartbeats, workspaceSettings: deps.repositories.workspaceSettings, providerStates: deps.providerStates },
              { ...scope, now },
            ),
          },
        };
      case "offer":
        await heartbeats.dismissOffer({ ...scope, now: stamp });
        return { ok: true, result: { dismissed: true } };
      case "start":
        return {
          ok: true,
          result: await view(await write((config) => ({ ...config, enabled: true, instructions: payload.instructions }), payload.revision)),
        };
    }
  } catch (error) {
    const failure = TaviError.from(error);
    return { ok: false, error: { code: failure.code, message: failure.message } };
  }
}

/** An item of the operator's ledger, or `NOT_FOUND`. */
async function heartbeatItemRow(
  heartbeats: Pick<PersistencePort["repositories"]["heartbeats"], "ledgerRow">,
  input: { readonly workspaceId: string; readonly principalId: string; readonly itemId: string },
): Promise<HeartbeatLedgerRow> {
  const item = await heartbeats.ledgerRow(input);
  if (item === undefined) throw new TaviError("NOT_FOUND", `Heartbeat item ${input.itemId} does not exist`);
  return item;
}

/** The most memories an item's card names. */
const HEARTBEAT_BECAUSE_MAX = 2;

const TickMemorySchema = z.object({ memory: z.array(z.object({ recordId: z.string().min(1), revisionId: z.string().min(1) })) });

/**
 * What an item's card says it was told because of: the titles of
 * the memories the check that last told it was given, at most
 * `HEARTBEAT_BECAUSE_MAX`, read from the check's recorded `(recordId,
 * revisionId)` inputs and the memory rows now. The check is the first that ran
 * at or after the item's `lastToldAt` (an item is told before its check is
 * recorded), and only one recorded within the longest tick deadline of it: when
 * that check was swept or never recorded, a later one is not taken for it and
 * the card names nothing. A record forgotten since, a revision gone, a sensitive record, or
 * one not the person's is left out: the card never names what was erased.
 */
export async function heartbeatItemBecause(
  repositories: Pick<PersistencePort["repositories"], "heartbeats"> & {
    readonly memory?: Pick<PersistencePort["repositories"]["memory"], "getRecord" | "getRevision"> | undefined;
  },
  scope: { readonly workspaceId: string; readonly principalId: string },
  item: Pick<HeartbeatLedgerRow, "lastToldAt">,
): Promise<readonly string[]> {
  const memory = repositories.memory;
  if (memory === undefined) return [];
  const [tick] = await repositories.heartbeats.listTicks({ ...scope, since: item.lastToldAt, ranOnly: true, oldestFirst: true, limit: 1 });
  if (tick === undefined || Date.parse(tick.createdAt) - Date.parse(item.lastToldAt) > HEARTBEAT_LIMITS.maxTickSeconds * 1000) return [];
  const inputs = TickMemorySchema.safeParse(tick.inputs);
  if (!inputs.success) return [];
  const titles: string[] = [];
  for (const used of inputs.data.memory) {
    if (titles.length >= HEARTBEAT_BECAUSE_MAX) break;
    const record = await memory.getRecord(used.recordId);
    if (
      record === undefined ||
      record.status === "deleted" ||
      record.sensitivity === "sensitive" ||
      !operatorSeesMemory(record.scope, scope)
    )
      continue;
    const revision = await memory.getRevision(used.revisionId);
    if (revision === undefined || revision.recordId !== record.recordId) continue;
    const title = memoryCardTitleOf(revision);
    if (title !== null && !titles.includes(title)) titles.push(title);
  }
  return titles;
}
