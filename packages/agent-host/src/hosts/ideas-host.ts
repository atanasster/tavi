import {
  IDEA_FRESH_AFTER_SETUP_MS,
  IDEA_ACCEPTANCE_WINDOW_MS,
  IDEA_ASKING_CAPABILITIES,
  IDEA_DIGEST_BARE_REPLY_MS,
  IDEA_DIGEST_MAX,
  IDEA_DIGEST_REPLY_MS,
  IDEA_BASIS_EXCERPT_MAX,
  IDEA_MAX_ACTIVE,
  IDEA_PREPARABLE_CAPABILITIES,
  IDEA_PREPARE_DAILY_TOKENS,
  IDEA_PREPARE_AGAIN_MS,
  IDEA_PREPARE_PER_DAY,
  IDEA_PREPARE_RUN_RESERVE_TOKENS,
  IDEA_REFRESH_PER_HOUR,
  IDEA_RETENTION_MS,
  IDEA_RUN_REASON_MAX,
  IDEA_TURN_INPUT_MAX,
  IDEA_TURN_MAX_OUTPUT_TOKENS,
  IDEA_TURNS_PER_RUN,
  IDEA_VOLUME_HIGH,
  IDEA_VOLUME_LOW,
  IDEA_VOLUME_MIN,
  IDEA_VOLUME_MIN_SHOWN,
  IdeaDraftSchema,
  heartbeatWindowAt,
  localDateTime,
  nextHeartbeatWindow,
  startOfLocalDay,
  ideaPlainText,
  ideasProviderFailure,
  IdeasProviderError,
  type AsyncPersistenceRepositories,
  type IdeaBasis,
  type IdeaCapability,
  type IdeaDraft,
  type Idea,
  type IdeaRun,
  type IdeaSettings,
  type IdeaTaskExcerpt,
  type IdeasGenerateRequest,
  type IdeasProvider,
  type IdeasReceive,
  type MemoryExcerpt,
  type StoreIdeaInput,
  TaviError,
} from "@tavi/contracts";
import { clip as clipTo } from "@tavi/contracts/util";
import { zodIssues } from "@tavi/contracts/zod-util";
import { sha256Hex } from "@tavi/node-kit";

/**
 * The ideas host: everything around the provider that writes ideas, so a
 * provider can be replaced without weakening a rule. Per run it gates on the
 * settings and the selected provider, gives that provider only what its
 * manifest asks for *and* the person allows, stops it at its deadline, and
 * validates every idea it proposes — schema, the capability census, a basis it
 * was actually given (with the excerpt rewritten from that source), approvals
 * as the capability implies — before the store applies the ledger and the cap.
 */

/** How a provider was installed: built in, or by an approved plugin with its manifest's declaration. */
export interface IdeasProviderEntry {
  readonly provider: IdeasProvider;
  readonly kind: "builtin" | "plugin";
  readonly receives: readonly IdeasReceive[];
  readonly maxRunSeconds: number;
  /** Whether its manifest declares `usesTurns`: only then is it offered `host.runTurn`. */
  readonly usesTurns?: boolean;
  /** What the person was told at approval about where their data goes. */
  readonly disclosure?: string;
  /** Its plugin's lifetime: aborted when the plugin stops, which stops a run it is answering. */
  readonly signal?: AbortSignal;
}

/** The providers that may write ideas, by plugin id; withdrawn when their plugin stops. */
export class IdeasProviderRegistry {
  readonly #entries = new Map<string, IdeasProviderEntry>();

  install(id: string, entry: IdeasProviderEntry): () => void {
    this.#entries.set(id, entry);
    return () => {
      if (this.#entries.get(id) === entry) this.#entries.delete(id);
    };
  }

  get(id: string): IdeasProviderEntry | undefined {
    return this.#entries.get(id);
  }

  /** Every installed provider, with its id and whether it says it is ready. */
  list(): readonly (IdeasProviderEntry & { readonly id: string; readonly ready: boolean })[] {
    return [...this.#entries.entries()].map(([id, entry]) => {
      // Ready only when it says exactly so; a status that throws, answers late (a promise) or says anything else is not.
      let ready = true;
      try {
        const status: unknown = entry.provider.status?.();
        ready = status === undefined || (status as { ready?: unknown } | null)?.ready === true;
      } catch {
        ready = false;
      }
      return { ...entry, id, ready };
    });
  }
}

export interface IdeasHostDependencies {
  readonly repositories: Pick<AsyncPersistenceRepositories, "ideas">;
  readonly providers: IdeasProviderRegistry;
  /** What Tavi can do in the workspace now. */
  readonly census: (workspaceId: string) => Promise<readonly IdeaCapability[]>;
  /** Approved, normal-sensitivity records of the operator's own scopes. */
  readonly memory: (workspaceId: string) => Promise<readonly MemoryExcerpt[]>;
  /** Recent chats with their summaries. */
  readonly tasks: (workspaceId: string) => Promise<readonly IdeaTaskExcerpt[]>;
  /**
   * Whether the workspace's memory is on. Paused, recall stops everywhere
   * (memory invariant 13, docs/MEMORY.md): no provider reads memory, chats, or the words
   * typed into them. Absent, it is on.
   */
  readonly memoryOn?: (workspaceId: string) => Promise<boolean>;
  readonly timezone: (workspaceId: string) => Promise<string>;
  /**
   * When setup was finished: until a scheduled
   * run since has generated (for at most `IDEA_FRESH_AFTER_SETUP_MS`), the
   * scheduled run always asks the provider, so the morning after setup has
   * ideas grounded in what was just connected, never "unchanged". Absent, or
   * undefined, nothing is promised.
   */
  readonly freshSince?: (workspaceId: string) => Promise<string | undefined>;
  /**
   * One tool-less turn on the workspace's fast model, and the tokens it spent.
   * Absent, no provider is offered `host.runTurn`. It throws
   * `UNAVAILABLE` when the workspace has no fast model.
   */
  readonly turn?: (
    scope: { readonly workspaceId: string; readonly runId: string },
    input: IdeasTurnInput,
    signal: AbortSignal,
  ) => Promise<{ readonly text: string; readonly tokens: number }>;
  /**
   * An idea's first step run ahead of time: an unattended,
   * read-only run of its prompt, and its answer. Absent, nothing is prepared;
   * undefined when it could not be.
   */
  readonly prepare?: (
    scope: { readonly workspaceId: string },
    idea: Idea,
    signal: AbortSignal,
  ) => Promise<{ readonly taskId: string; readonly text: string } | undefined>;
  /**
   * The weekly digest's send: `text` to the operator's own
   * authorized chat on connection `connectionId`, once per `effectId`.
   * `skipped` when there is no such chat or it cannot be sent to now.
   */
  readonly sendDigest?: (input: {
    readonly workspaceId: string;
    readonly connectionId: string;
    readonly text: string;
    readonly effectId: string;
  }) => Promise<{ readonly status: "sent"; readonly chatId: string } | { readonly status: "skipped" }>;
  /** The workspaces the daily schedule visits. Absent, nothing is scheduled. */
  readonly workspaces?: () => Promise<readonly string[]>;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
}

/** What a provider's turn sends, held to the host's limits. */
export interface IdeasTurnInput {
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
}

const plain = ideaPlainText;

/** The excerpt a basis shows, written by the host from what the provider was given. */
const clip = (text: string): string => {
  const flat = plain(text);
  return flat.length <= IDEA_BASIS_EXCERPT_MAX ? flat : `${flat.slice(0, IDEA_BASIS_EXCERPT_MAX - 1)}…`;
};

export interface IdeasValidation {
  readonly accepted: readonly StoreIdeaInput[];
  readonly dropped: number;
  /** Why the first few ideas that broke a rule were dropped, each once, in words a provider's author reads. */
  readonly reasons: readonly string[];
}

/** At most this many distinct drop reasons are kept on a run. */
const IDEA_DROP_REASONS_MAX = 3;

/**
 * Hold a provider's answer to the contract: an idea outside the
 * schema, using a capability the census lacks, or citing a basis the provider
 * was not given (or the person excluded) is dropped, counted, never repaired.
 * What passes has its excerpts rewritten from the source and `approval` set
 * for every capability that asks; a repeated key keeps its first, and the best
 * `IDEA_MAX_ACTIVE` are kept.
 */
export interface ProposalSources {
  readonly census: ReadonlySet<IdeaCapability>;
  readonly memory: ReadonlyMap<string, string>;
  readonly tasks: ReadonlyMap<string, string>;
  readonly brief?: string;
  readonly excluded: ReadonlySet<string>;
}

/**
 * What a provider was given, copied before it runs: validation reads this,
 * never the request, so a provider that changes what it was handed changes
 * nothing that is checked or quoted.
 */
export function proposalSources(request: Omit<IdeasGenerateRequest, "signal">, excluded: Iterable<string>): ProposalSources {
  return {
    census: new Set(request.capabilities),
    memory: new Map((request.memory ?? []).map((record) => [record.recordId, record.text])),
    tasks: new Map((request.tasks ?? []).map((task) => [task.taskId, task.title])),
    ...(request.brief === undefined ? {} : { brief: request.brief }),
    excluded: new Set(excluded),
  };
}

export function validateProposals(answer: unknown, sources: ProposalSources, newId: () => string): IdeasValidation {
  const proposals: unknown[] = Array.isArray((answer as { ideas?: unknown } | null)?.ideas) ? (answer as { ideas: unknown[] }).ideas : [];
  const { census, memory, tasks, excluded } = sources;
  const sourced = (basis: IdeaBasis): IdeaBasis | undefined => {
    if (excluded.has(basis.ref)) return undefined;
    switch (basis.kind) {
      case "memory": {
        const text = memory.get(basis.ref);
        return text === undefined ? undefined : { kind: "memory", ref: basis.ref, excerpt: clip(text) };
      }
      case "task": {
        const title = tasks.get(basis.ref);
        return title === undefined ? undefined : { kind: "task", ref: basis.ref, excerpt: clip(title) };
      }
      case "brief":
        return sources.brief === undefined || sources.brief.trim() === ""
          ? undefined
          : { kind: "brief", ref: "brief", excerpt: clip(sources.brief) };
      case "general":
        return { kind: "general", ref: basis.ref };
    }
  };
  let dropped = 0;
  const reasons: string[] = [];
  const drop = (reason: string): void => {
    dropped += 1;
    if (reasons.length < IDEA_DROP_REASONS_MAX && !reasons.includes(reason)) reasons.push(reason);
  };
  const seen = new Set<string>();
  const kept: { readonly draft: IdeaDraft; readonly score: number }[] = [];
  for (const [index, proposal] of proposals.entries()) {
    const parsed = IdeaDraftSchema.safeParse((proposal as { idea?: unknown } | null)?.idea);
    const rawScore = (proposal as { score?: unknown } | null)?.score;
    const which = `idea ${String(index + 1)}`;
    if (!parsed.success) {
      drop(`${which}: ${zodIssues(parsed.error, "idea").slice(0, 2).join("; ")}`);
      continue;
    }
    if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
      drop(`${which} (${parsed.data.key}): its score is not a number`);
      continue;
    }
    const idea = parsed.data;
    const basis = idea.basis.map(sourced);
    const named = `${which} (${idea.key})`;
    const missing = idea.uses.find((use) => !census.has(use.capability));
    if (seen.has(idea.key)) {
      drop(`${named}: its key repeats an earlier idea's`);
      continue;
    }
    if (missing !== undefined) {
      drop(`${named}: it uses ${missing.capability}, which this workspace does not have`);
      continue;
    }
    if (basis.some((entry) => entry === undefined)) {
      drop(`${named}: it cites a basis the provider was not given`);
      continue;
    }
    seen.add(idea.key);
    kept.push({
      draft: {
        ...idea,
        basis: basis.filter((entry): entry is IdeaBasis => entry !== undefined),
        uses: idea.uses.map((use) => ({
          capability: use.capability,
          approval: use.approval || IDEA_ASKING_CAPABILITIES.includes(use.capability),
        })),
      },
      score: Math.min(1, Math.max(0, rawScore)),
    });
  }
  const best = [...kept].sort((a, b) => b.score - a.score).slice(0, IDEA_MAX_ACTIVE);
  return {
    accepted: best.map((entry) => ({ id: `idea-${newId()}`, draft: entry.draft, score: entry.score })),
    dropped: dropped + kept.length - best.length,
    reasons,
  };
}

/**
 * What a run's inputs hash covers: the provider and everything it is given
 * — but the active ideas, which are the last run's own output and
 * would make every run look new.
 */
function inputsHash(providerId: string, request: Omit<IdeasGenerateRequest, "signal">): string {
  const { now: _now, ledger, ...rest } = request;
  const steering = ledger === undefined ? undefined : (({ active: _active, ...said }) => said)(ledger);
  return sha256Hex(JSON.stringify({ providerId, ...rest, steering }));
}

/** A provider's own error text, as a run's reason shows it: one plain line, whatever was thrown. */
function errorText(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
    const text = typeof message === "string" ? plain(message).slice(0, 200) : "";
    return text === "" ? "unknown error" : text;
  } catch {
    return "unknown error";
  }
}

/** A copy no provider can change: every array and object in it frozen. */
function deepFrozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFrozen(inner);
    Object.freeze(value);
  }
  return value;
}

/** At most this many proposals are read from one answer; the rest are counted as dropped unread. */
export const IDEAS_PROPOSALS_READ_MAX = 4 * IDEA_MAX_ACTIVE;

/**
 * Auto-volume: with fewer than one in ten shown ideas tried over the
 * last week, ask for half as many (not under `IDEA_VOLUME_MIN`); with more
 * than four in ten, twice as many (up to `IDEA_MAX_ACTIVE`). Too few shown
 * says nothing, and the volume stays.
 */
export function nextIdeasVolume(volume: number, acceptance: { readonly shown: number; readonly tried: number }): number {
  if (acceptance.shown < IDEA_VOLUME_MIN_SHOWN) return volume;
  const rate = acceptance.tried / acceptance.shown;
  if (rate < IDEA_VOLUME_LOW) return Math.max(IDEA_VOLUME_MIN, Math.floor(volume / 2));
  if (rate > IDEA_VOLUME_HIGH) return Math.min(IDEA_MAX_ACTIVE, volume * 2);
  return volume;
}

/** A run that has been started in the store, with what it was started under. */
export interface IdeasRunStart {
  readonly runId: string;
  readonly trigger: IdeaRun["trigger"];
  readonly settings: IdeaSettings;
  readonly brief: string;
}

/**
 * Start a run: recorded `running` at once, so a second start (here or from
 * another process) is refused, and a refresh past `IDEA_REFRESH_PER_HOUR` is
 * refused in the same transaction that counts them.
 */
export async function beginIdeasRun(deps: IdeasHostDependencies, workspaceId: string, trigger: IdeaRun["trigger"]): Promise<IdeasRunStart> {
  const { settings, brief } = await deps.repositories.ideas.settings(workspaceId);
  const runId = `irun-${deps.newId()}`;
  await deps.repositories.ideas.startRun({
    runId,
    workspaceId,
    trigger,
    providerId: settings.provider,
    now: deps.now().toISOString(),
    ...(trigger === "refresh" ? { refreshesPerHour: IDEA_REFRESH_PER_HOUR } : {}),
  });
  return { runId, trigger, settings, brief };
}

/**
 * Start `work` and wait for it, or for `signal` to abort, removing the listener
 * either way. An already-aborted signal refuses before `work` starts, so no
 * call is left running with nothing to hear how it ends.
 */
async function untilAborted<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new IdeasProviderError("transport");
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        stop = () => reject(signal.reason instanceof Error ? signal.reason : new IdeasProviderError("transport"));
        signal.addEventListener("abort", stop, { once: true });
      }),
    ]);
  } finally {
    if (stop !== undefined) signal.removeEventListener("abort", stop);
  }
}

/**
 * Complete a started run, recorded whatever happens: `skipped` (off, its
 * provider missing, or switched while it ran), `unchanged` (a scheduled run
 * whose inputs match the last one's), `generated`, or `failed`. It never
 * leaves the run `running`: if even recording the failure fails, it tries once
 * more with no detail.
 */
export async function completeIdeasRun(deps: IdeasHostDependencies, workspaceId: string, start: IdeasRunStart): Promise<IdeaRun> {
  const ideas = deps.repositories.ideas;
  const stamp = () => deps.now().toISOString();
  const { runId, trigger, settings, brief } = start;
  let finished: IdeaRun | undefined;
  // What this run's turns spent, recorded however it ends: the day's budget counts it.
  let tokens = 0;
  const finish = async (
    outcome: "generated" | "unchanged" | "skipped" | "failed",
    fields: { readonly reason?: string; readonly inputsHash?: string; readonly generated?: number; readonly dropped?: number } = {},
  ) => (finished = await ideas.finishRun({ runId, outcome, ...fields, ...(tokens > 0 ? { tokens } : {}), now: stamp() }));
  const entry = deps.providers.get(settings.provider);
  try {
    // What is past retention goes on every run: expired ideas, finished runs, ranking feedback.
    await ideas.prune(new Date(deps.now().getTime() - IDEA_RETENTION_MS).toISOString(), stamp());
    if (!settings.enabled) return await finish("skipped", { reason: "Ideas are off" });
    if (entry === undefined)
      return await finish("skipped", { reason: `The ideas provider ${settings.provider} is not installed or not running` });
    // The daily run moves the volume with what the person took up this week; a refresh keeps it.
    let volume = settings.volume;
    // At most once a week, on the take-up since it last moved: one poor week is one step, not one a day.
    const weekAgo = deps.now().getTime() - IDEA_ACCEPTANCE_WINDOW_MS;
    if (trigger === "schedule" && (settings.volumeAt === undefined || Date.parse(settings.volumeAt) <= weekAgo)) {
      const next = nextIdeasVolume(volume, await ideas.acceptance(workspaceId, new Date(weekAgo).toISOString()));
      if (next !== volume) {
        // A patch: only the volume is this run's to change, merged into whatever the person saved meanwhile.
        await ideas.saveSettings({ workspaceId, patch: { volume: next, volumeAt: stamp() }, now: stamp() });
        volume = next;
      }
    }
    const receives = new Set(entry.receives);
    const recalls = (await deps.memoryOn?.(workspaceId)) ?? true;
    const allowed = (what: IdeasReceive): boolean =>
      receives.has(what) && (what === "ledger" || (settings.sources[what] && (recalls || what === "brief")));
    const now = stamp();
    const [capabilities, memory, tasks, timezone, ledger, active] = await Promise.all([
      deps.census(workspaceId),
      allowed("memory") ? deps.memory(workspaceId) : undefined,
      allowed("tasks") ? deps.tasks(workspaceId) : undefined,
      deps.timezone(workspaceId),
      allowed("ledger") ? ideas.ledger(workspaceId, now) : undefined,
      allowed("ledger") ? ideas.list({ workspaceId, now }) : undefined,
    ]);
    const deadlineMs = entry.maxRunSeconds * 1_000;
    // *Don't use this* withholds the source itself, not only ideas citing it: the provider never reads it.
    const excluded = new Set((await ideas.ledger(workspaceId, now)).excludedBasis);
    const usesBrief = allowed("brief") && brief.trim() !== "" && !excluded.has("brief");
    const data: Omit<IdeasGenerateRequest, "signal"> = deepFrozen(
      structuredClone({
        workspaceId,
        now,
        timezone,
        capabilities: [...capabilities],
        ...(memory === undefined ? {} : { memory: memory.filter((record) => !excluded.has(record.recordId)) }),
        ...(tasks === undefined ? {} : { tasks: tasks.filter((task) => !excluded.has(task.taskId)) }),
        ...(usesBrief ? { brief } : {}),
        // The prompts the person edited are their own words, as their chats are: only with `tasks`.
        ...(ledger === undefined
          ? {}
          : {
              ledger: {
                ...ledger,
                examples: allowed("tasks") ? ledger.examples : [],
                active: (active ?? []).map((idea) => ({ key: idea.key, category: idea.category })),
              },
            }),
        limits: { maxIdeas: volume, deadlineMs },
      }),
    );
    const sources = proposalSources(data, excluded);
    const hash = inputsHash(settings.provider, data);
    // The daily run prepares the day's first steps, new answers for the same ideas too; a refresh does not spend that
    // budget. The run is recorded first: a failure there is logged, never the run's.
    const thenPrepare = async (done: IdeaRun): Promise<IdeaRun> => {
      if (trigger === "schedule")
        await prepareIdeas(deps, workspaceId).catch((error: unknown) =>
          deps.log?.("the day's first steps could not be prepared", { workspaceId, reason: errorText(error) }),
        );
      return done;
    };
    // Nothing changed since the last look: no provider is asked, and what it offered stays offered — unless
    // nothing is left, when it is asked again rather than leave the tab empty for good.
    const fresh =
      trigger === "schedule"
        ? await deps.freshSince?.(workspaceId).catch((error: unknown) => {
            deps.log?.("when setup was finished could not be read; the usual rule applies", { workspaceId, reason: errorText(error) });
            return undefined;
          })
        : undefined;
    const promised =
      fresh !== undefined &&
      deps.now().getTime() - Date.parse(fresh) < IDEA_FRESH_AFTER_SETUP_MS &&
      !(await ideas.generatedSince(workspaceId, fresh));
    if (
      trigger === "schedule" &&
      !promised &&
      hash === (await ideas.lastInputsHash(workspaceId)) &&
      (await ideas.keepOffered(workspaceId, stamp())) > 0
    ) {
      return await thenPrepare(await finish("unchanged", { inputsHash: hash }));
    }
    // The deadline, and the plugin's own lifetime, abort the request; each listener is removed when the run ends.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`the ideas provider took longer than ${entry.maxRunSeconds}s`)), deadlineMs);
    const lifetimeStopped = (): void =>
      controller.abort(entry.signal?.reason instanceof Error ? entry.signal.reason : new IdeasProviderError("transport"));
    if (entry.signal?.aborted === true) lifetimeStopped();
    else entry.signal?.addEventListener("abort", lifetimeStopped, { once: true });
    // The day's spend is the providers' turns and the prepared steps together: one budget.
    const spentToday = async (): Promise<number> => {
      const since = startOfLocalDay(deps.now(), timezone).toISOString();
      const [turned, prepared] = await Promise.all([ideas.spentSince(workspaceId, since), ideas.preparedSince(workspaceId, since)]);
      return turned.tokens + prepared.tokens;
    };
    const turns =
      entry.usesTurns === true && deps.turn !== undefined
        ? turnHost(deps.turn, spentToday, { workspaceId, runId }, settings.dailyTokens, controller.signal, {
            spent: () => tokens,
            add: (spent) => (tokens += spent),
          })
        : undefined;
    const request: IdeasGenerateRequest = Object.freeze({
      ...data,
      ...(turns === undefined ? {} : { host: turns.host }),
      signal: controller.signal,
    });
    let answer: unknown;
    try {
      answer = await untilAborted(async () => await entry.provider.generate(request), controller.signal);
    } finally {
      clearTimeout(timer);
      entry.signal?.removeEventListener("abort", lifetimeStopped);
      // What a turn stopped with the provider spent is recorded with the run, not lost when it ends after it.
      if (controller.signal.aborted) await turns?.settled(IDEA_TURN_SETTLE_MS);
    }
    const proposals = (answer as { ideas?: unknown } | null)?.ideas;
    if (answer === null || typeof answer !== "object" || !Array.isArray(proposals))
      throw Object.assign(new IdeasProviderError("invalid"), { message: "the provider answered something other than { ideas: [...] }" });
    const read = proposals.slice(0, IDEAS_PROPOSALS_READ_MAX);
    const validated = validateProposals({ ideas: read }, sources, deps.newId);
    // The volume is how many this run keeps, the best first; the rest count as dropped.
    const accepted = validated.accepted.slice(0, volume);
    const dropped = validated.dropped + (validated.accepted.length - accepted.length);
    let stored;
    try {
      stored = await ideas.store({
        workspaceId,
        runId,
        providerId: settings.provider,
        whileSelected: true,
        ideas: accepted,
        now: stamp(),
        usedSources: [
          ...(data.memory === undefined ? [] : ["memory" as const]),
          ...(data.tasks === undefined ? [] : ["tasks" as const]),
          ...(usesBrief ? ["brief" as const] : []),
        ],
        ...(usesBrief ? { briefRead: brief } : {}),
      });
    } catch (error) {
      // Switched, turned off, or a source switched off while the provider ran: what it wrote is not kept. Any other refusal is a failure.
      if (
        error instanceof TaviError &&
        error.code === "CONFLICT" &&
        (error.details as { notSelected?: unknown } | undefined)?.notSelected === true
      )
        return await finish("skipped", { reason: errorText(error) });
      throw error;
    }
    // Ideas of this run the cap expired at once count as dropped, as those never stored do.
    const own = new Set(accepted.map((idea) => idea.id));
    const evicted = stored.evicted.filter((ideaId) => own.has(ideaId)).length;
    // What broke a rule is said where a provider's author looks: the run's reason, and the owner's log.
    for (const reason of validated.reasons)
      deps.log?.("an ideas provider's idea was left out", { workspaceId, providerId: settings.provider, reason });
    const leftOut = validated.reasons.length === 0 ? undefined : `Left out: ${validated.reasons.join("; ")}`;
    return await thenPrepare(
      await finish("generated", {
        inputsHash: hash,
        generated: stored.stored.length,
        dropped: dropped + (proposals.length - read.length) + stored.refused.length + evicted,
        ...(leftOut === undefined ? {} : { reason: clipTo(leftOut, IDEA_RUN_REASON_MAX) }),
      }),
    );
  } catch (error) {
    const failure = ideasProviderFailure(error);
    deps.log?.("an ideas run failed", { workspaceId, providerId: settings.provider, failure, reason: errorText(error) });
    return await finish("failed", { reason: `The ideas provider ${settings.provider} failed (${failure}): ${errorText(error)}` });
  } finally {
    // Best effort: the run's failure is already its caller's; a record that cannot be written stays as it was.
    if (finished === undefined)
      await ideas
        .finishRun({
          runId,
          outcome: "failed",
          reason: "The run could not record how it ended",
          ...(tokens > 0 ? { tokens } : {}),
          now: stamp(),
        })
        .catch(() => undefined);
  }
}

/** How long a run stopped at its deadline waits for its model turns to end and say what they spent. */
const IDEA_TURN_SETTLE_MS = 5_000;

/**
 * `host.runTurn` for one run: at most `IDEA_TURNS_PER_RUN` turns, each
 * refused as `budget` unless what the day's runs spent, this one's included,
 * leaves room for its longest answer. The text is the provider's to validate;
 * every idea it proposes from it is validated as any other.
 */
function turnHost(
  turn: NonNullable<IdeasHostDependencies["turn"]>,
  spentToday: () => Promise<number>,
  scope: { readonly workspaceId: string; readonly runId: string },
  dailyTokens: number,
  signal: AbortSignal,
  run: { readonly spent: () => number; readonly add: (tokens: number) => void },
): { readonly host: NonNullable<IdeasGenerateRequest["host"]>; readonly settled: (withinMs: number) => Promise<void> } {
  let turns = 0;
  /** The longest answers of the turns under way: held against the day until each ends, so turns asked at once cannot all fit. */
  let reserved = 0;
  /** The turns under way, so the run waits for what a stopped turn spent before it records its tokens. */
  const inFlight = new Set<Promise<unknown>>();
  /** What a turn spent, read from its answer or from the error it failed with. */
  const record = (value: unknown): void => {
    const used = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
    if (used > 0) run.add(used);
  };
  const host = Object.freeze({
    runTurn: async (input: {
      readonly system: string;
      readonly user: string;
      readonly maxOutputTokens?: number;
    }): Promise<{ readonly text: string }> => {
      const system: unknown = input?.system;
      const user: unknown = input?.user;
      const asked: unknown = input?.maxOutputTokens;
      if (
        typeof system !== "string" ||
        typeof user !== "string" ||
        system.length > IDEA_TURN_INPUT_MAX ||
        user.length > IDEA_TURN_INPUT_MAX ||
        user.trim() === ""
      ) {
        throw Object.assign(new IdeasProviderError("invalid"), {
          message: `a turn takes a system and a user text of at most ${IDEA_TURN_INPUT_MAX} characters each`,
        });
      }
      const maxOutputTokens =
        typeof asked === "number" && Number.isInteger(asked) && asked > 0
          ? Math.min(asked, IDEA_TURN_MAX_OUTPUT_TOKENS)
          : IDEA_TURN_MAX_OUTPUT_TOKENS;
      if (signal.aborted) throw new IdeasProviderError("transport");
      turns += 1;
      if (turns > IDEA_TURNS_PER_RUN)
        throw Object.assign(new IdeasProviderError("budget"), { message: `a run takes at most ${IDEA_TURNS_PER_RUN} model turns` });
      // A turn is refused before it starts when the day's budget has no room for its longest answer, nor for those of
      // the turns under way: reserved before the day's spend is read, so two asked at once see each other.
      reserved += maxOutputTokens;
      let answer: { readonly text: string; readonly tokens: number };
      try {
        if ((await spentToday()) + run.spent() + reserved > dailyTokens)
          throw Object.assign(new IdeasProviderError("budget"), { message: "today's ideas budget is spent" });
        // Awaited as it is, not raced against the signal: the host's own turn hears the signal, and what a failed
        // or stopped turn spent still counts against the day (it throws with `tokens`).
        const pending = turn(scope, { system, user, maxOutputTokens }, signal);
        inFlight.add(pending);
        try {
          answer = await pending;
        } catch (error) {
          record((error as { tokens?: unknown } | null)?.tokens);
          throw error;
        } finally {
          inFlight.delete(pending);
        }
      } finally {
        reserved -= maxOutputTokens;
      }
      record(answer.tokens);
      return { text: answer.text };
    },
  });
  // A provider stopped by its deadline leaves its turn to hear the same signal and end; until it does, what it spent is unknown.
  const settled = async (withinMs: number): Promise<void> => {
    if (inFlight.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, withinMs);
      }),
    ]);
    clearTimeout(timer);
  };
  return { host, settled };
}

/** The digest's words: the ideas numbered, and how to start one. Titles only — never what an idea quoted. */
export function ideasDigestText(ideas: readonly Pick<Idea, "title">[]): string {
  return [
    "Ideas for you this week:",
    ...ideas.map((idea, index) => `${index + 1}. ${idea.title}`),
    "",
    `Reply ${ideas.map((_, index) => index + 1).join(", ")} to start one, or see more in Tavi's Ideas tab.`,
  ].join("\n");
}

/**
 * The weekly digest: on the chosen weekday, inside the hours,
 * once a local day at most, the best offered ideas (at most
 * `IDEA_DIGEST_MAX`) go to the chosen channel. Off unless set; nothing goes
 * while Ideas is off or there is nothing to offer. Recorded only once sent,
 * so a skipped send is tried at the next look.
 */
export async function sendIdeasDigest(deps: IdeasHostDependencies, workspaceId: string): Promise<"sent" | "skipped" | "not-due"> {
  const send = deps.sendDigest;
  const ideas = deps.repositories.ideas;
  const { settings } = await ideas.settings(workspaceId);
  const digest = settings.digest;
  if (send === undefined || digest === undefined || !settings.enabled) return "not-due";
  const timezone = await deps.timezone(workspaceId);
  const now = deps.now();
  const local = localDateTime(now, timezone);
  const today = `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  // Once a week at most, whatever was set since: a weekday moved, or the digest turned off and on, waits out the week.
  const lastSent = settings.digestSent === undefined ? undefined : Date.parse(`${settings.digestSent.on}T00:00:00Z`);
  const sentThisWeek = lastSent !== undefined && Date.parse(`${today}T00:00:00Z`) - lastSent < 7 * 86_400_000;
  if (weekday !== digest.weekday || sentThisWeek || heartbeatWindowAt({ activeHours: settings.hours }, timezone, now) === undefined)
    return "not-due";
  const offered = (await offeredIdeas(deps, workspaceId, settings)).slice(0, IDEA_DIGEST_MAX);
  if (offered.length === 0) return "not-due";
  // A key per day, connection and refusal: a send the channel refused is tried again under a new one, while a send
  // that went out before a crash, unrecorded, is the same send again (the outbox keeps it once).
  const refused = settings.digestTries?.on === today ? settings.digestTries.refused : 0;
  const sent = await send({
    workspaceId,
    connectionId: digest.channel,
    text: ideasDigestText(offered),
    effectId: `ideas-digest:${workspaceId}:${today}:${digest.channel}:${refused}`,
  });
  if (sent.status !== "sent") {
    await ideas.saveSettings({ workspaceId, patch: { digestTries: { on: today, refused: refused + 1 } }, now: now.toISOString() });
    return "skipped";
  }
  await ideas.saveSettings({
    workspaceId,
    patch: {
      digestSent: {
        on: today,
        at: now.toISOString(),
        connectionId: digest.channel,
        chatId: sent.chatId,
        ideaIds: offered.map((idea) => idea.id),
      },
    },
    now: now.toISOString(),
  });
  return "sent";
}

/** A digest pick: `try 2` (a week), or a bare `2` (a day), within the digest's count. */
const DIGEST_PICK = new RegExp(`^\\s*(try\\s+)?([1-${IDEA_DIGEST_MAX}])\\s*[.!]?\\s*$`, "iu");

/**
 * The idea one reply to the weekly digest picks: in the very chat it
 * went to, the first pick only, `try 2` within a week and a bare `2` within a
 * day of it — so a later number in that chat answers whatever was asked
 * since. Undefined for anything else, or an idea no longer offered.
 */
export async function ideaOfDigestReply(
  deps: Pick<IdeasHostDependencies, "repositories" | "now"> & Partial<Pick<IdeasHostDependencies, "census">>,
  input: {
    readonly workspaceId: string;
    readonly connectionId: string | undefined;
    readonly chatId: string | undefined;
    readonly text: string;
  },
): Promise<Idea | undefined> {
  const picked = DIGEST_PICK.exec(input.text);
  if (picked === null || input.connectionId === undefined || input.chatId === undefined) return undefined;
  const { settings } = await deps.repositories.ideas.settings(input.workspaceId);
  const sent = settings.digestSent;
  // Ideas off, or the digest turned off or moved: a number is only a message.
  if (!settings.enabled || settings.digest?.channel !== input.connectionId) return undefined;
  if (sent === undefined || sent.picked === true || sent.connectionId !== input.connectionId || sent.chatId !== input.chatId)
    return undefined;
  const age = deps.now().getTime() - Date.parse(sent.at);
  if (age < 0 || age > (picked[1] === undefined ? IDEA_DIGEST_BARE_REPLY_MS : IDEA_DIGEST_REPLY_MS)) return undefined;
  const ideaId = sent.ideaIds[Number(picked[2]) - 1];
  // Still offered as the tab offers it: not hidden since by a mute, a dismissal, a capability gone, or another provider.
  return (await offeredIdeas(deps, input.workspaceId, settings, ["active", "tried"])).find((idea) => idea.id === ideaId);
}

/** A digest's pick was taken: no later reply picks again. */
export async function digestPicked(deps: Pick<IdeasHostDependencies, "repositories" | "now">, workspaceId: string): Promise<void> {
  const current = (await deps.repositories.ideas.settings(workspaceId)).settings;
  if (current.digestSent === undefined) return;
  await deps.repositories.ideas.saveSettings({
    workspaceId,
    patch: { digestSent: { ...current.digestSent, picked: true } },
    now: deps.now().toISOString(),
  });
}

/**
 * The ideas the workspace offers now, best first, as the tab shows them
 * (`shown` in the owner's command): of the selected provider, not hidden by a
 * mute, a dismissal, a snooze or a source set aside, and with every
 * capability still here — what the digest lists, a reply picks, and
 * a prepared step runs.
 */
export async function offeredIdeas(
  deps: Pick<IdeasHostDependencies, "repositories" | "now"> & Partial<Pick<IdeasHostDependencies, "census">>,
  workspaceId: string,
  settings: IdeaSettings,
  statuses: readonly Idea["status"][] = ["active"],
): Promise<readonly Idea[]> {
  const now = deps.now().toISOString();
  const ideas = deps.repositories.ideas;
  const [listed, ledger, census] = await Promise.all([
    ideas.list({ workspaceId, now, includeInactive: statuses.some((status) => status !== "active") }),
    ideas.ledger(workspaceId, now),
    deps.census?.(workspaceId),
  ]);
  const here = census === undefined ? undefined : new Set(census);
  const hidden = new Set([...ledger.dismissedKeys, ...ledger.snoozedKeys]);
  const muted = new Set<string>(ledger.mutedCategories);
  const excluded = new Set(ledger.excludedBasis);
  return listed.filter(
    (idea) =>
      statuses.includes(idea.status) &&
      idea.providerId === settings.provider &&
      !hidden.has(idea.key) &&
      !muted.has(idea.category) &&
      !idea.basis.some((basis) => excluded.has(basis.ref)) &&
      (here === undefined || idea.uses.every((use) => here.has(use.capability))),
  );
}

/** How long one prepared step may run. */
export const IDEAS_PREPARE_TIMEOUT_MS = 120_000;

/**
 * Whether an idea's first step may be run ahead of time:
 * offered, not prepared in the last `IDEA_PREPARE_AGAIN_MS` (so the day's run
 * renews yesterday's answer before it goes stale), resting on nothing of the
 * person's (every basis `general`, so its prompt carries no memory, chat or
 * brief out to a search provider unattended — and no model filled in a part
 * from a note), no [part] left to fill, and every use one of
 * `IDEA_PREPARABLE_CAPABILITIES` with none that asks first.
 */
export function preparable(idea: Idea, now: Date): boolean {
  const recent = idea.prepared !== undefined && now.getTime() - Date.parse(idea.prepared.at) < IDEA_PREPARE_AGAIN_MS;
  return (
    idea.status === "active" &&
    !recent &&
    idea.basis.every((basis) => basis.kind === "general") &&
    /^[^[\]]*$/u.test(idea.prompt) &&
    idea.uses.every((use) => !use.approval && (IDEA_PREPARABLE_CAPABILITIES as readonly string[]).includes(use.capability))
  );
}

/**
 * The day's prepared steps: the best preparable ideas, one at a
 * time, until `IDEA_PREPARE_PER_DAY` ran today or the day's
 * `IDEA_PREPARE_DAILY_TOKENS` are spent — both counted from the runs
 * themselves. One that fails is logged and the next is tried.
 */
export async function prepareIdeas(deps: IdeasHostDependencies, workspaceId: string): Promise<number> {
  const prepare = deps.prepare;
  if (prepare === undefined) return 0;
  const ideas = deps.repositories.ideas;
  const now = deps.now();
  const since = startOfLocalDay(now, await deps.timezone(workspaceId)).toISOString();
  const { settings } = await ideas.settings(workspaceId);
  // A `general` basis is the provider's own word. Taken without asking only from one that cannot have put the person's
  // notes in an idea's words: the built-in one, whose general ideas keep the catalogue's wording, or one that reads
  // nothing of theirs. Another prepares only once the operator turns `prepareExternal` on: a note could ride an
  // unattended search out.
  const entry = deps.providers.get(settings.provider);
  if (
    entry === undefined ||
    (entry.kind !== "builtin" && entry.receives.some((what) => what !== "ledger") && settings.prepareExternal !== true)
  )
    return 0;
  let prepared = 0;
  for (const idea of (await offeredIdeas(deps, workspaceId, settings)).filter((candidate) => preparable(candidate, now))) {
    const spent = await ideas.preparedSince(workspaceId, since);
    // One pool with the providers' turns: never more than the person's own daily budget for Ideas (set to 0, nothing is
    // prepared), and of it at most `IDEA_PREPARE_DAILY_TOKENS` on prepared steps.
    const turns = (await ideas.spentSince(workspaceId, since)).tokens;
    // A run starts only when the day has room for its worst case: no run carries the day past its tokens.
    const room = Math.min(IDEA_PREPARE_DAILY_TOKENS - spent.tokens, settings.dailyTokens - spent.tokens - turns);
    if (spent.count >= IDEA_PREPARE_PER_DAY || IDEA_PREPARE_RUN_RESERVE_TOKENS > room) break;
    try {
      const result = await prepare({ workspaceId }, idea, AbortSignal.timeout(IDEAS_PREPARE_TIMEOUT_MS));
      if (result === undefined) continue;
      if (
        (await ideas.prepared({
          workspaceId,
          ideaId: idea.id,
          taskId: result.taskId,
          text: result.text,
          ranFor: { prompt: idea.prompt, uses: idea.uses },
          now: deps.now().toISOString(),
        })) !== undefined
      )
        prepared += 1;
    } catch (error) {
      deps.log?.("an idea's first step could not be prepared", { workspaceId, ideaId: idea.id, reason: errorText(error) });
    }
  }
  return prepared;
}

/** How often the host looks for workspaces whose daily run is due. */
export const IDEAS_SCHEDULE_EVERY_MS = 15 * 60_000;

/** Start and complete one run. */
export async function runIdeas(deps: IdeasHostDependencies, workspaceId: string, trigger: IdeaRun["trigger"]): Promise<IdeaRun> {
  return await completeIdeasRun(deps, workspaceId, await beginIdeasRun(deps, workspaceId, trigger));
}

/**
 * Runs on request, one at a time per workspace. A refresh is answered only
 * once its run has been started in the store: `started`; `queued` when a run
 * here is under way, and this one follows it, however many were asked for
 * meanwhile; `busy` when the store holds a run from elsewhere (another
 * process's, or one an owner lost less than `IDEA_RUN_STALE_MS` ago), and
 * nothing starts. Past the hour's limit the refresh is refused
 * (`QUOTA_EXCEEDED`), counted in the transaction that starts it.
 *
 * Once started, it also runs each workspace once per window of the
 * workspace's hours — once a day: a scheduled run whose inputs match the last
 * one's asks no provider, and every run prunes what is past retention.
 */
export class IdeasHost {
  readonly #deps: IdeasHostDependencies;
  readonly #running = new Map<string, Promise<void>>();
  readonly #queued = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  /** When the schedule's first look falls, and how often it looks: a due run starts at the next look, not at once. */
  #looks: { readonly first: number; readonly every: number } | undefined;
  #ticking: Promise<void> | undefined;

  constructor(deps: IdeasHostDependencies) {
    this.#deps = deps;
  }

  async refresh(workspaceId: string): Promise<"started" | "queued" | "busy"> {
    // Off, a look would only be recorded skipped — and count toward the hour's refreshes.
    if (!(await this.#deps.repositories.ideas.settings(workspaceId)).settings.enabled)
      throw new TaviError("UNAVAILABLE", "Ideas are off: turn them on with tavi ideas on");
    if (this.#running.has(workspaceId)) {
      await this.#withinQuota(workspaceId);
      this.#queued.add(workspaceId);
      return "queued";
    }
    let start: IdeasRunStart;
    try {
      start = await beginIdeasRun(this.#deps, workspaceId, "refresh");
    } catch (error) {
      if (error instanceof TaviError && error.code === "CONFLICT") {
        // Started here meanwhile: this refresh follows it; otherwise the run is another process's.
        if (this.#running.has(workspaceId)) {
          await this.#withinQuota(workspaceId);
          this.#queued.add(workspaceId);
          return "queued";
        }
        return "busy";
      }
      throw error;
    }
    this.#track(workspaceId, completeIdeasRun(this.#deps, workspaceId, start));
    return "started";
  }

  /** Look for due workspaces every `everyMs`; the first look is after one interval, not at startup. */
  start(everyMs = IDEAS_SCHEDULE_EVERY_MS): void {
    if (this.#timer !== undefined || this.#deps.workspaces === undefined) return;
    this.#looks = { first: this.#deps.now().getTime() + everyMs, every: everyMs };
    this.#timer = setInterval(() => {
      // A look still under way when the next is due is not doubled.
      this.#ticking ??= this.schedule().finally(() => (this.#ticking = undefined));
    }, everyMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#looks = undefined;
  }

  /** The schedule's first look at or after `at`: when a run due by then starts. */
  #lookAt(at: Date): string {
    const looks = this.#looks;
    if (looks === undefined || at.getTime() <= looks.first) return new Date(Math.max(at.getTime(), looks?.first ?? 0)).toISOString();
    return new Date(looks.first + Math.ceil((at.getTime() - looks.first) / looks.every) * looks.every).toISOString();
  }

  /**
   * When the workspace's scheduled run next starts: the schedule's next look, inside its hours with
   * none run in them yet; otherwise its first look in its next hours. Undefined while the schedule is not running or Ideas is off.
   */
  async nextAt(workspaceId: string): Promise<string | undefined> {
    if (this.#timer === undefined) return undefined;
    const deps = this.#deps;
    const [{ settings }, timezone] = await Promise.all([deps.repositories.ideas.settings(workspaceId), deps.timezone(workspaceId)]);
    if (!settings.enabled) return undefined;
    const now = deps.now();
    const hours = { activeHours: settings.hours };
    const window = heartbeatWindowAt(hours, timezone, now);
    if (window === undefined) return this.#lookAt(nextHeartbeatWindow(hours, timezone, now).start);
    return this.#lookAt((await this.#ranIn(workspaceId, window.start)) ? nextHeartbeatWindow(hours, timezone, window.start).start : now);
  }

  /**
   * A refresh that will follow the run under way is refused now when the hour's refreshes are spent, as starting
   * it would be: once queued, the person was told it runs, and a refusal then would reach only the log.
   */
  async #withinQuota(workspaceId: string): Promise<void> {
    if (this.#queued.has(workspaceId)) return;
    const asked = await this.#deps.repositories.ideas.refreshesSince(
      workspaceId,
      new Date(this.#deps.now().getTime() - 60 * 60_000).toISOString(),
    );
    if (asked >= IDEA_REFRESH_PER_HOUR)
      throw new TaviError(
        "QUOTA_EXCEEDED",
        `Ideas were refreshed ${asked} times in the last hour; at most ${IDEA_REFRESH_PER_HOUR} are allowed`,
      );
  }

  async #digest(workspaceId: string): Promise<void> {
    try {
      await sendIdeasDigest(this.#deps, workspaceId);
    } catch (error) {
      this.#deps.log?.("the ideas digest could not be sent; it is tried at the next look", { workspaceId, reason: errorText(error) });
    }
  }

  /** Whether a scheduled run started in the window that began at `start`: one run a window, so hours that cross midnight run once. */
  async #ranIn(workspaceId: string, start: Date): Promise<boolean> {
    const last = await this.#deps.repositories.ideas.lastRun(workspaceId, "schedule");
    return last !== undefined && Date.parse(last.startedAt) >= start.getTime();
  }

  /**
   * Start the scheduled run of every workspace that is due: inside its hours,
   * with no scheduled run since this window of them began, and none under way here.
   * A run held elsewhere (`CONFLICT`) is left to the next look.
   */
  async schedule(): Promise<void> {
    const deps = this.#deps;
    for (const workspaceId of (await deps.workspaces?.()) ?? []) {
      if (this.#running.has(workspaceId)) continue;
      try {
        const [{ settings }, timezone] = await Promise.all([deps.repositories.ideas.settings(workspaceId), deps.timezone(workspaceId)]);
        const window = heartbeatWindowAt({ activeHours: settings.hours }, timezone, deps.now());
        // The weekly digest, when due: after the day's run has had its chance to freshen what it lists.
        if (window !== undefined && (await this.#ranIn(workspaceId, window.start))) await this.#digest(workspaceId);
        if (window === undefined || (await this.#ranIn(workspaceId, window.start))) continue;
        const start = await beginIdeasRun(deps, workspaceId, "schedule");
        this.#track(workspaceId, completeIdeasRun(deps, workspaceId, start));
      } catch (error) {
        if (error instanceof TaviError && error.code === "CONFLICT") continue;
        deps.log?.("a scheduled ideas run could not start", { workspaceId, reason: errorText(error) });
      }
    }
  }

  /** Settles once no run or scheduling look is under way: tests and the owner's shutdown wait on it. */
  async idle(): Promise<void> {
    while (this.#running.size > 0 || this.#ticking !== undefined)
      await Promise.allSettled([...this.#running.values(), ...(this.#ticking === undefined ? [] : [this.#ticking])]);
  }

  #track(workspaceId: string, run: Promise<IdeaRun>): void {
    const tracked = run
      .then(
        () => undefined,
        (error: unknown) => this.#deps.log?.("an ideas run could not be recorded", { workspaceId, reason: errorText(error) }),
      )
      .finally(() => {
        this.#running.delete(workspaceId);
        // The queued refresh: begun now, so a limit or a run from elsewhere is said in the log, not lost silently.
        if (this.#queued.delete(workspaceId)) {
          this.#track(
            workspaceId,
            beginIdeasRun(this.#deps, workspaceId, "refresh").then((start) => completeIdeasRun(this.#deps, workspaceId, start)),
          );
        }
      });
    this.#running.set(workspaceId, tracked);
  }
}
