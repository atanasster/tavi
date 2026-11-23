import {
  MAX_HOOK_CONTEXT_BLOCKS,
  MAX_MOD_HOOKS,
  ModHookMatchSchema,
  PLUGIN_BOUNDS,
  PromptSubmitHookResultSchema,
  TaviError,
  ToolCallHookResultSchema,
  ToolCheckHookResultSchema,
  ToolResultHookResultSchema,
  HeartbeatItemHookResultSchema,
  TurnCompleteHookResultSchema,
  modFailureRuleOf,
  sameOutputShape,
  toolPatternMatches,
  type ModCheckDecision,
  type ModDispatchOutcome,
  type ModEnvelope,
  type ModEvent,
  type ModFailureRule,
  type ModHook,
  type ModHookDeclaration,
  type ModHookInput,
  type ModHookMatch,
  type ModHookResult,
  type ModNext,
  type TurnHooksPort,
  ModCommandResultSchema,
  MOD_COMMANDS_PER_SECOND,
  type ModCommandDeclaration,
  type ModCommandInput,
  type ModCommandResult,
  type PluginCommandView,
} from "@tavi/contracts";
import { errorMessage, isRecord } from "@tavi/contracts/util";

/**
 * The plugins' hooks into the turn: an ordered registry the workflow dispatches through.
 *
 * One registry serves the owner. Composition creates it before the workflow
 * adapter and hands it to the external-plugin loader, so plugins that register
 * after the adapter exists are seen on the next dispatch.
 *
 * Hooks run in plugin id order — the order the host starts plugins — then in
 * registration order; the first is outermost and core is innermost. Every hook
 * can only make an answer stricter than what runs beneath it: a `tool.check`
 * answer is merged with the one beneath, so a hook that skipped `next` cannot
 * loosen the gate either.
 */

/** Why a hook did not answer: thrown, out of its own time, or a shape its event refuses. */
export type TurnHookFailureKind = "throw" | "timeout" | "shape";

export interface TurnHookFailure {
  readonly pluginId: string;
  /** The hook's event, or `command.run` for a slash command. */
  readonly event: ModEvent | "command.run";
  readonly kind: TurnHookFailureKind;
  readonly message: string;
  readonly elapsedMs: number;
  readonly envelope: ModEnvelope;
  readonly tool?: string;
}

/** A hook's answer that changed what core (and the hooks beneath) answered. */
export interface TurnHookDecision {
  readonly pluginId: string;
  readonly event: ModEvent;
  readonly envelope: ModEnvelope;
  readonly tool?: string;
  /** "allow → ask: Deletes files.", "denied: …", "withheld: …", "dropped: …", "changed the output". */
  readonly detail: string;
}

export interface TurnHookRegistryOptions {
  /** A hook's own time per dispatch, `next` not counted. Default `PLUGIN_BOUNDS.hookBudgetMs`. */
  readonly budgetMs?: number;
  /** Failures in `breakerWindowMs` that suspend a plugin's hooks until restart. Default 5 in 10 minutes. */
  readonly breakerLimit?: number;
  readonly breakerWindowMs?: number;
  readonly now?: () => number;
  readonly onFailure?: (failure: TurnHookFailure) => void;
  readonly onDecision?: (decision: TurnHookDecision) => void;
  /** Told once when a plugin's breaker opens. */
  readonly onSuspended?: (pluginId: string) => void;
  /** Command names a front end keeps for itself: a plugin's command of the same name is listed as `<plugin>:<name>`. */
  readonly reservedCommands?: ReadonlySet<string>;
  /** Whether a plugin is built into this build: its command keeps its bare name, and another plugin's of the same name is listed as `<plugin>:<name>`. */
  readonly builtinPlugin?: (pluginId: string) => boolean;
  /**
   * The name a dispatch's decision is credited to (`decidedBy`, and so a
   * rule id `mod:<name>`): a `--dev-plugin`'s apart from an installed plugin
   * of its id. Default: the plugin's id.
   */
  readonly creditOf?: (pluginId: string) => string;
}

interface CommandRegistration {
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly run: (input: ModCommandInput) => ModCommandResult | Promise<ModCommandResult>;
  /** Aborted when it is withdrawn: a run in flight sees its signal fire, and its late answer is dropped. */
  readonly lifetime: AbortController;
}

interface Registration {
  readonly pluginId: string;
  readonly event: ModEvent;
  readonly match: ModHookMatch | undefined;
  readonly failure: ModFailureRule;
  /** The hook, behind its event: `dispatch` hands it only that event's input and `next`. */
  readonly invoke: (input: unknown, next: unknown) => unknown;
  readonly sequence: number;
  withdrawn: boolean;
  /** Aborted when the registration is withdrawn: in-flight hooks see `next.signal` fire. */
  readonly lifetime: AbortController;
  /** Its declaration says its `prompt.submit` context is trusted: its blocks do not taint the turn. */
  readonly contextTrusted: boolean;
}

const CHECK_ORDER: Readonly<Record<ModCheckDecision, number>> = { allow: 0, ask: 1, deny: 2 };

/**
 * The stricter of two gate answers. On a tie the inner one stands when it says
 * why — it decided first, and its words are what its plugin is credited with
 * — else the outer one, which may add a reason.
 */
function stricter(outer: ModHookResult<"tool.check">, inner: ModHookResult<"tool.check">): ModHookResult<"tool.check"> {
  if (outer.decision === inner.decision) return inner.reason !== undefined ? inner : outer;
  return CHECK_ORDER[outer.decision] > CHECK_ORDER[inner.decision] ? outer : inner;
}

/**
 * An outer `tool.result` rewrite over the one beneath: each string the
 * outer hook left as the original keeps the inner hook's rewrite, so an outer
 * hook that builds its answer from `e` does not undo an inner one's masking.
 * Both answers have the original's shape (checked).
 */
function composedOutput(original: unknown, below: unknown, outer: unknown, outerSawBelow: boolean): unknown {
  // A string both rewrote: the outer one's when it saw the inner rewrite (it called `next`, and builds on it), else
  // the inner one's — an outer hook that saw only the original would undo the inner one's masking.
  if (typeof outer === "string") return outer === original || (below !== original && !outerSawBelow) ? below : outer;
  if (Array.isArray(outer) && Array.isArray(original) && Array.isArray(below))
    return outer.map((item, index) => composedOutput(original[index], below[index], item, outerSawBelow));
  if (isRecord(outer) && isRecord(original) && isRecord(below))
    return Object.fromEntries(
      Object.entries(outer).map(([key, item]) => [key, composedOutput(original[key], below[key], item, outerSawBelow)]),
    );
  return outer;
}

/**
 * A plugin's match as the registry keeps it (G-A): parsed, so a list that is
 * no list is refused at registration rather than throwing at each dispatch,
 * and copied and frozen, so the plugin cannot widen it after it was checked.
 */
export function hookMatchOf(pluginId: string, event: ModEvent, match: unknown): ModHookMatch | undefined {
  if (match === undefined) return undefined;
  // A list named as undefined is one the hook leaves to the declaration.
  const named =
    typeof match === "object" && match !== null
      ? Object.fromEntries(Object.entries(match).filter(([, list]) => list !== undefined))
      : match;
  const parsed = ModHookMatchSchema.safeParse(named);
  if (!parsed.success)
    throw new TaviError(
      "INVALID_INPUT",
      `plugin ${pluginId} registered a ${event} hook whose match is not one: ${parsed.error.issues[0]?.message ?? "unknown problem"}`,
    );
  // A match that names no list is no match: the declaration's, whichever it is.
  if (parsed.data.tools === undefined && parsed.data.sources === undefined && parsed.data.channels === undefined) return undefined;
  return deepFrozen(parsed.data);
}

const RESULT_SCHEMAS = {
  "prompt.submit": PromptSubmitHookResultSchema,
  "tool.check": ToolCheckHookResultSchema,
  "tool.call": ToolCallHookResultSchema,
  "tool.result": ToolResultHookResultSchema,
  "turn.complete": TurnCompleteHookResultSchema,
  "heartbeat.item": HeartbeatItemHookResultSchema,
} as const;

class HookTimeout extends Error {
  constructor(budgetMs: number) {
    super(`ran past its ${budgetMs} ms budget`);
  }
}

/**
 * Whether a declared match admits a requested one: each list the request
 * names is within the declared list. A list it leaves out is the declared one.
 */
function withinDeclared(declared: ModHookMatch | undefined, requested: ModHookMatch | undefined): boolean {
  const covers = (
    wide: readonly string[] | undefined,
    narrow: readonly string[] | undefined,
    matches: (pattern: string, value: string) => boolean,
  ): boolean => wide === undefined || narrow === undefined || narrow.every((value) => wide.some((pattern) => matches(pattern, value)));
  return (
    covers(
      declared?.tools,
      requested?.tools,
      (pattern, value) => pattern === value || (!value.includes("*") && toolPatternMatches(pattern, value)),
    ) &&
    covers(declared?.sources, requested?.sources, (pattern, value) => pattern === value) &&
    covers(declared?.channels, requested?.channels, (pattern, value) => pattern === value)
  );
}

/** A match as one string whatever its keys' order, and an empty one as none. */
function canonicalMatch(match: ModHookMatch | undefined): string {
  // Each list as a set: the same tools in another order are the same match.
  const set = (list: readonly string[] | undefined) => (list === undefined ? null : [...new Set(list)].sort());
  return JSON.stringify([set(match?.tools), set(match?.sources), set(match?.channels)]);
}

/** The declaration that admits a hook a plugin registers, or why none does. */
export function declarationFor(
  pluginId: string,
  declared: readonly ModHookDeclaration[],
  event: ModEvent,
  match: ModHookMatch | undefined,
): ModHookDeclaration {
  const admitting = declared.filter((candidate) => candidate.event === event && withinDeclared(candidate.match, match));
  // The declaration the hook names exactly, when one does: an omitted match is the one with none, not the first narrower one.
  const declaration = admitting.find((candidate) => canonicalMatch(candidate.match) === canonicalMatch(match)) ?? admitting[0];
  if (declaration !== undefined) return declaration;
  throw new TaviError(
    "NOT_AUTHORIZED",
    declared.some((candidate) => candidate.event === event)
      ? `plugin ${pluginId} declared its ${event} hook with a narrower match than it registered`
      : `plugin ${pluginId} did not declare a ${event} hook in its manifest's mods block`,
  );
}

export class TurnHookRegistry implements TurnHooksPort {
  readonly #registrations: Registration[] = [];
  readonly #commands: CommandRegistration[] = [];
  readonly #failures = new Map<string, number[]>();
  /** The envelopes each plugin's hooks were handed, with the task each named then: what it may address a status or notice to. */
  readonly #handed = new Map<string, WeakMap<ModEnvelope, string>>();
  readonly #suspended = new Set<string>();
  readonly #creditOf: (pluginId: string) => string;
  /** Commands' own breaker: failing commands turn off the plugin's commands, never its hooks. */
  readonly #commandFailures = new Map<string, number[]>();
  readonly #commandsSuspended = new Set<string>();
  /** Each plugin's own hook time per event, newest last, at most `LATENCY_SAMPLES`. */
  readonly #latency = new Map<string, Map<string, number[]>>();
  /** When each sender last ran commands, for their rate. */
  readonly #commandRuns = new Map<string, number[]>();
  readonly #budgetMs: number;
  readonly #breakerLimit: number;
  readonly #breakerWindowMs: number;
  readonly #now: () => number;
  readonly #options: TurnHookRegistryOptions;
  #sequence = 0;

  constructor(options: TurnHookRegistryOptions = {}) {
    this.#options = options;
    this.#creditOf = options.creditOf ?? ((pluginId) => pluginId);
    this.#budgetMs = options.budgetMs ?? PLUGIN_BOUNDS.hookBudgetMs;
    this.#breakerLimit = options.breakerLimit ?? 5;
    this.#breakerWindowMs = options.breakerWindowMs ?? 10 * 60_000;
    this.#now = options.now ?? (() => performance.now());
  }

  /**
   * Add one hook a plugin declared. Refused when no declared hook of
   * that event admits `match`; the failure rule is the declaration's. Returns
   * the withdrawal. `access` widens what the hook sees; only tavi's own mods
   * are registered with it.
   */
  register<E extends ModEvent>(
    pluginId: string,
    declared: readonly ModHookDeclaration[],
    event: E,
    rawMatch: ModHookMatch | undefined,
    hook: ModHook<E>,
  ): () => void {
    const match = hookMatchOf(pluginId, event, rawMatch);
    const declaration = declarationFor(pluginId, declared, event, match);
    // As many hooks as a manifest may declare (G-D): each has its own budget, so more would multiply a plugin's share of a dispatch.
    if (this.#registrations.filter((registration) => registration.pluginId === pluginId).length >= MAX_MOD_HOOKS) {
      throw new TaviError("NOT_AUTHORIZED", `plugin ${pluginId} registered more than ${MAX_MOD_HOOKS} hooks`);
    }
    const registration: Registration = {
      pluginId,
      event,
      // Only the lists the hook names narrow it: `{ tools: undefined }` keeps the declared tools, never drops them.
      match: deepFrozen({ ...declaration.match, ...match }),
      failure: modFailureRuleOf(declaration),
      invoke: (value, next) => hook(value as ModHookInput<E>, next as ModNext<E>),
      sequence: (this.#sequence += 1),
      withdrawn: false,
      lifetime: new AbortController(),
      contextTrusted: declaration.contextTrusted === true,
    };
    this.#registrations.push(registration);
    this.#registrations.sort((left, right) =>
      left.pluginId === right.pluginId ? left.sequence - right.sequence : left.pluginId < right.pluginId ? -1 : 1,
    );
    return () => this.#withdrawOne(registration);
  }

  /** Withdraw every hook of a plugin (disable, reject, stop); in-flight hooks see their signal abort. */
  withdraw(pluginId: string): void {
    for (const registration of [...this.#registrations]) if (registration.pluginId === pluginId) this.#withdrawOne(registration);
    for (const command of [...this.#commands]) {
      if (command.pluginId !== pluginId) continue;
      this.#commands.splice(this.#commands.indexOf(command), 1);
      command.lifetime.abort(new TaviError("CANCELLED", `plugin ${pluginId} was withdrawn`));
    }
  }

  /**
   * Add a slash command a plugin declared. Refused when the
   * manifest does not declare it; the description is the declaration's.
   * Returns the withdrawal.
   */
  registerCommand(pluginId: string, declared: readonly ModCommandDeclaration[], name: string, run: CommandRegistration["run"]): () => void {
    const declaration = declared.find((command) => command.name === name);
    if (declaration === undefined)
      throw new TaviError("NOT_AUTHORIZED", `plugin ${pluginId} did not declare a /${name} command in its manifest's mods block`);
    // Once each: a second would list the command under its plugin's name and leave it unreachable by its own.
    if (this.#commands.some((command) => command.pluginId === pluginId && command.name === name))
      throw new TaviError("CONFLICT", `plugin ${pluginId} registered its /${name} command twice`);
    const registration: CommandRegistration = {
      pluginId,
      name,
      description: declaration.description,
      run,
      lifetime: new AbortController(),
    };
    this.#commands.push(registration);
    this.#commands.sort((left, right) => (left.pluginId === right.pluginId ? 0 : left.pluginId < right.pluginId ? -1 : 1));
    return () => {
      const index = this.#commands.indexOf(registration);
      if (index !== -1) this.#commands.splice(index, 1);
      registration.lifetime.abort(new TaviError("CANCELLED", `plugin ${pluginId} was withdrawn`));
    };
  }

  /**
   * The commands as typed: its own name, or `<plugin>:<name>` when a front end
   * keeps the name or another plugin has it too — so no command shadows another.
   */
  commands(): readonly PluginCommandView[] {
    return this.#commands.map((command) => ({
      name: this.#typedName(command),
      pluginId: command.pluginId,
      description: command.description,
    }));
  }

  /**
   * Run `/name` (as `commands()` lists it) under the hook budget. A command that
   * fails answers that it failed; `undefined` when no plugin has that name.
   */
  async runCommand(name: string, input: Omit<ModCommandInput, "signal" | "locale">): Promise<ModCommandResult | undefined> {
    const command = this.#commands.find((candidate) => this.#typedName(candidate) === name);
    if (command === undefined) return undefined;
    if (this.#suspended.has(command.pluginId) || this.#commandsSuspended.has(command.pluginId)) {
      return { text: `/${name} from ${command.pluginId} is off: it failed too often and is suspended until the owner restarts.` };
    }
    // At most a few a second for one person on one front end or channel; the rest are refused, never counted as failures.
    const sender = `${input.envelope.workspaceId}\u0000${input.envelope.principalId}\u0000${input.envelope.channel ?? input.envelope.source}`;
    const at = this.#now();
    const recent = (this.#commandRuns.get(sender) ?? []).filter((when) => at - when < 1_000);
    if (recent.length >= MOD_COMMANDS_PER_SECOND) return { text: `Too many commands at once: try /${name} again in a moment.` };
    this.#commandRuns.set(sender, [...recent, at]);
    // Once many senders are tracked, those quiet for a second are forgotten, so the map stays small.
    if (this.#commandRuns.size > 256)
      for (const [key, runs] of this.#commandRuns) if (runs.every((when) => at - when >= 1_000)) this.#commandRuns.delete(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const onWithdrawn = () => controller.abort(command.lifetime.signal.reason);
    let onGone: () => void = () => {};
    command.lifetime.signal.addEventListener("abort", onWithdrawn, { once: true });
    const startedAt = this.#now();
    try {
      const answer = await Promise.race([
        Promise.resolve(command.run({ ...input, locale: input.envelope.locale ?? "en", signal: controller.signal })),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new HookTimeout(this.#budgetMs);
            controller.abort(error);
            reject(error);
          }, this.#budgetMs);
        }),
        // Withdrawn while it runs: answered at once, even by a command that ignores its signal.
        new Promise<never>((_resolve, reject) => {
          onGone = () => reject(command.lifetime.signal.reason);
          command.lifetime.signal.addEventListener("abort", onGone, { once: true });
        }),
      ]);
      if (command.lifetime.signal.aborted) return { text: `/${name}: ${command.pluginId} is no longer running.` };
      const parsed = ModCommandResultSchema.safeParse(answer);
      if (!parsed.success) throw new HookShapeError(`its /${command.name} answer is not { text }`);
      return parsed.data;
    } catch (error) {
      // A command whose plugin stopped while it ran is not its failure.
      if (command.lifetime.signal.aborted) return { text: `/${name}: ${command.pluginId} is no longer running.` };
      const kind: TurnHookFailureKind = error instanceof HookTimeout ? "timeout" : error instanceof HookShapeError ? "shape" : "throw";
      // Counted toward the plugin's command breaker only: a failing command never suspends its hooks.
      this.#reportFailure(
        {
          pluginId: command.pluginId,
          event: "command.run",
          kind,
          message: errorMessage(error),
          elapsedMs: this.#now() - startedAt,
          envelope: input.envelope,
        },
        "commands",
      );
      return { text: `/${name} from ${command.pluginId} failed${kind === "timeout" ? ": it ran out of time" : ""}.` };
    } finally {
      clearTimeout(timer);
      command.lifetime.signal.removeEventListener("abort", onWithdrawn);
      command.lifetime.signal.removeEventListener("abort", onGone);
    }
  }

  #typedName(command: CommandRegistration): string {
    if (this.#options.reservedCommands?.has(command.name) === true) return `${command.pluginId}:${command.name}`;
    const others = this.#commands.filter((other) => other !== command && other.name === command.name);
    if (others.length === 0) return command.name;
    // A built-in's command is never taken from it by a plugin's of the same name.
    const builtin = (pluginId: string): boolean => this.#options.builtinPlugin?.(pluginId) === true;
    return builtin(command.pluginId) && !others.some((other) => builtin(other.pluginId))
      ? command.name
      : `${command.pluginId}:${command.name}`;
  }

  /** The task `envelope` named when this plugin's hooks were handed it — the one it may show a status or notice on — or `undefined`. */
  handedTask(pluginId: string, envelope: ModEnvelope): string | undefined {
    return this.#handed.get(pluginId)?.get(envelope);
  }

  /** Each event's own hook time for `pluginId` over its recent dispatches: median and worst, in whole milliseconds. */
  latencyOf(
    pluginId: string,
  ): readonly { readonly event: string; readonly medianMs: number; readonly worstMs: number; readonly samples: number }[] {
    return [...(this.#latency.get(pluginId) ?? new Map<string, number[]>())].map(([event, times]) => {
      const sorted = [...times].sort((left, right) => left - right);
      return {
        event,
        medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
        worstMs: Math.round(sorted.at(-1) ?? 0),
        samples: sorted.length,
      };
    });
  }

  #timed(pluginId: string, event: string, ms: number): void {
    let events = this.#latency.get(pluginId);
    if (events === undefined) this.#latency.set(pluginId, (events = new Map()));
    const times = events.get(event) ?? [];
    times.push(Math.max(0, ms));
    if (times.length > LATENCY_SAMPLES) times.shift();
    events.set(event, times);
  }

  /** Whether the plugin's breaker is open: its hooks are suspended until the owner restarts. */
  suspended(pluginId: string): boolean {
    return this.#suspended.has(pluginId);
  }

  /** Close the plugin's breaker and forget its failures: new code was loaded in its place (a dev plugin's reload). */
  reset(pluginId: string): void {
    this.#suspended.delete(pluginId);
    this.#failures.delete(pluginId);
    this.#commandsSuspended.delete(pluginId);
    this.#commandFailures.delete(pluginId);
  }

  hasEvent(event: ModEvent): boolean {
    return this.#registrations.some((registration) => !registration.withdrawn && registration.event === event);
  }

  has(event: ModEvent, envelope: ModEnvelope, tool?: string, aliases?: readonly string[]): boolean {
    return this.#registrations.some((registration) => this.#admits(registration, event, envelope, tool, aliases));
  }

  async dispatch<E extends ModEvent>(
    event: E,
    input: ModHookInput<E>,
    core: (input: ModHookInput<E>) => Promise<ModHookResult<E>>,
    signal?: AbortSignal,
  ): Promise<ModDispatchOutcome<E>> {
    const tool = "tool" in input && typeof input.tool === "string" ? input.tool : undefined;
    const aliases = "aliases" in input ? input.aliases : undefined;
    // A turn already cancelled tells no hook.
    if (signal?.aborted === true) throw signal.reason;
    const hooks = this.#registrations.filter((registration) => this.#admits(registration, event, input.envelope, tool, aliases));
    if (hooks.length === 0) return { result: await core(input) };
    // One frozen copy for every hook and core: nothing a hook does to `e` reaches the
    // stored call, the result or another hook. The envelope is kept as it was handed, which `ui.*` checks.
    let original: ModHookInput<E>;
    try {
      original = frozenEventOf(input);
    } catch (error) {
      // An event that cannot be copied as JSON is shown to no hook: each stands for its failure rule, innermost first.
      let result = await core(input);
      let decidedBy: string | undefined;
      for (const registration of [...hooks].reverse()) {
        this.#failed(registration, event, input, "shape", error, 0, tool);
        const stood = this.#standIn(registration, event, input, result, tool, "could not be shown the event");
        if (stood.changed) decidedBy = this.#creditOf(registration.pluginId);
        result = stood.result;
      }
      return { result, ...(decidedBy === undefined ? {} : { decidedBy }) };
    }
    const envelope = original.envelope;
    for (const registration of hooks) {
      let handed = this.#handed.get(registration.pluginId);
      if (handed === undefined) this.#handed.set(registration.pluginId, (handed = new WeakMap()));
      handed.set(envelope, envelope.taskId);
    }
    let decidedBy: string | undefined;
    // Who added which context block, innermost first, as the blocks stand in the answer (prompt.submit).
    const contributed = new Map<number, { readonly pluginId: string; readonly text: string; readonly trusted?: true }[]>();
    // The hooks beneath, and core, always see the original event: a change travels only in an answer.
    const run = async (index: number): Promise<ModHookResult<E>> => {
      const registration = hooks[index];
      if (registration === undefined) return core(original);
      let beneath: ModHookResult<E> | undefined;
      const below = async () => (beneath = await run(index + 1));
      const answer = await this.#runOne(registration, event, original, below, signal, tool);
      if (answer.changed) decidedBy = this.#creditOf(registration.pluginId);
      if (event === "prompt.submit") {
        const own = (answer.result as { readonly context?: readonly string[] }).context ?? [];
        const inherited = contributed.get(index + 1) ?? [];
        const baseBlocks = (beneath as { readonly context?: readonly string[] } | undefined)?.context ?? [];
        // The blocks beneath stay in place with their own name and trust; a hook's declaration covers only
        // the blocks it adds, so a trusted hook cannot make another plugin's block trusted.
        contributed.set(
          index,
          own.map((text, at) =>
            baseBlocks[at] === text && inherited[at] !== undefined
              ? inherited[at]
              : {
                  pluginId: this.#creditOf(registration.pluginId),
                  text,
                  ...(registration.contextTrusted ? { trusted: true as const } : {}),
                },
          ),
        );
      }
      return answer.result;
    };
    const result = await run(0);
    const contextBy = contributed.get(0);
    return {
      result,
      ...(decidedBy === undefined ? {} : { decidedBy }),
      ...(contextBy === undefined || contextBy.length === 0 ? {} : { contextBy }),
    };
  }

  #admits(
    registration: Registration,
    event: ModEvent,
    envelope: ModEnvelope,
    tool: string | undefined,
    aliases: readonly string[] | undefined,
  ): boolean {
    if (registration.withdrawn || registration.event !== event) return false;
    // A heartbeat provider never hooks the turns it asked for: it would see, and could change, its own check.
    if (envelope.heartbeatProvider === registration.pluginId) return false;
    // Nor does an ideas provider hook the prepared step of an idea it wrote: it would read what its receives never granted.
    if (envelope.ideasProvider === registration.pluginId) return false;
    const match = registration.match;
    if (match?.sources !== undefined && !match.sources.includes(envelope.source)) return false;
    if (match?.channels !== undefined && (envelope.channel === undefined || !match.channels.includes(envelope.channel))) return false;
    if (match?.tools !== undefined) {
      if (tool === undefined) return false;
      const names = [tool, ...(aliases ?? [])];
      if (!match.tools.some((pattern) => names.some((name) => toolPatternMatches(pattern, name)))) return false;
    }
    return true;
  }

  #withdrawOne(registration: Registration): void {
    if (registration.withdrawn) return;
    registration.withdrawn = true;
    registration.lifetime.abort(new TaviError("CANCELLED", `plugin ${registration.pluginId} was withdrawn`));
    const index = this.#registrations.indexOf(registration);
    if (index !== -1) this.#registrations.splice(index, 1);
  }

  /**
   * One hook, under its own budget: the clock stops while its `next` runs. A
   * hook that fails stands for its failure rule; a suspended plugin's hook is
   * not run and stands for it too, so a gating hook keeps failing closed.
   */
  async #runOne<E extends ModEvent>(
    registration: Registration,
    event: E,
    input: ModHookInput<E>,
    below: () => Promise<ModHookResult<E>>,
    signal: AbortSignal | undefined,
    tool: string | undefined,
  ): Promise<{ readonly result: ModHookResult<E>; readonly changed: boolean }> {
    let beneath: Promise<ModHookResult<E>> | undefined;
    // An error from beneath (core, or a hook under this one) is not this hook's failure: it is passed on as it came.
    let belowError: { readonly error: unknown } | undefined;
    // Whatever the hook passes to `next`, the hooks beneath see the original event.
    const callBelow = (): Promise<ModHookResult<E>> =>
      (beneath ??= below().catch((error: unknown) => {
        belowError = { error };
        throw error;
      }));
    const settleBelow = (): Promise<ModHookResult<E>> => beneath ?? callBelow();

    // Read afresh each time: a cancel can land while the hook awaits.
    const cancelledNow = (): boolean => signal?.aborted === true;
    // Cancelled while an outer hook ran on: no hook starts on a cancelled turn.
    if (cancelledNow()) throw signal?.reason;
    // Withdrawn after this dispatch began (disabled, rejected, reloaded): it does not run, and the hooks beneath answer.
    if (registration.withdrawn) return { result: await settleBelow(), changed: false };
    if (this.#suspended.has(registration.pluginId)) {
      return this.#standIn(registration, event, input, await settleBelow(), tool, "its hooks are suspended after repeated failures");
    }

    const controller = new AbortController();
    const abort = (reason: unknown) => controller.abort(reason);
    const onOuter = () => abort(signal?.reason);
    const onWithdrawn = () => abort(registration.lifetime.signal.reason);
    signal?.addEventListener("abort", onOuter, { once: true });
    registration.lifetime.signal.addEventListener("abort", onWithdrawn, { once: true });
    // A cancel ends the dispatch at once, whatever the hook is doing; it is never the hook's failure.
    let onCancel: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onCancel = () => reject(signal?.reason);
    });
    // Awaited or raced elsewhere: this only keeps an early rejection from going unhandled.
    cancelled.catch(() => {});
    signal?.addEventListener("abort", onCancel, { once: true });
    // Withdrawn while it runs: its answer, however late, is not applied, and the hooks beneath answer.
    let onGone: () => void = () => {};
    const gone = new Promise<never>((_resolve, reject) => {
      onGone = () => reject(registration.lifetime.signal.reason);
    });
    // Awaited or raced elsewhere: this only keeps an early rejection from going unhandled.
    gone.catch(() => {});
    registration.lifetime.signal.addEventListener("abort", onGone, { once: true });

    let remaining = this.#budgetMs;
    let startedAt = this.#now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expire: (error: HookTimeout) => void = () => {};
    const expired = new Promise<never>((_resolve, reject) => {
      expire = reject;
    });
    // Only the race reads it; a timer that fires after the race settled must not surface as unhandled.
    expired.catch(() => {});
    // How many of its `next` calls are running: the clock stops while any is, once (a hook may call it twice).
    let inNext = 0;
    let settled = false;
    const arm = () => {
      if (settled) return;
      if (timer !== undefined) clearTimeout(timer);
      startedAt = this.#now();
      timer = setTimeout(
        () => {
          const error = new HookTimeout(this.#budgetMs);
          controller.abort(error);
          expire(error);
        },
        Math.max(0, remaining),
      );
    };
    // Stopped once: a clock already stopped (inside `next`, or answered) is not charged again.
    const pause = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      remaining -= this.#now() - startedAt;
    };
    // A result or prompt passed down changed is a rewrite that would be lost: it fails the hook, closed.
    let passedChange = false;
    // Whether it called `next`, and so saw what the hooks beneath answered.
    let calledNext = false;
    const next = Object.assign(
      async (value?: ModHookInput<E>): Promise<ModHookResult<E>> => {
        if (
          (event === "tool.result" || event === "prompt.submit") &&
          value !== undefined &&
          value !== input &&
          jsonOf({ ...value, envelope: undefined }) !== jsonOf({ ...input, envelope: undefined })
        )
          passedChange = true;
        calledNext = true;
        if (inNext++ === 0) pause();
        try {
          return await callBelow();
        } finally {
          if (--inNext === 0) arm();
        }
      },
      { signal: controller.signal },
    ) satisfies ModNext<E>;

    const hookStartedAt = this.#now();
    arm();
    // Withdrawn before it got here: it starts with `next.signal` already aborted.
    if (registration.lifetime.signal.aborted) {
      onWithdrawn();
      onGone();
    }
    try {
      const raw = await Promise.race([Promise.resolve(registration.invoke(input, next)), expired, cancelled, gone]);
      // The hook has answered: what runs beneath from here is not its time.
      pause();
      settled = true;
      if (registration.lifetime.signal.aborted) return { result: await settleBelow(), changed: false };
      if (passedChange)
        throw new HookShapeError(
          `it passed a changed ${event} event to next, which the hooks beneath never see: a change belongs in its answer`,
        );
      const answer = this.#checked(event, input, raw);
      const result = await this.#tightened(event, input, answer, settleBelow, calledNext);
      // A tool.call deny answered without `next` stands over nothing beneath: it is still the hook's decision.
      const base = beneath === undefined ? (event === "tool.call" ? ({} as ModHookResult<E>) : undefined) : await beneath;
      // A hook's own `ask` is its question even without a reason, and even when core asked too: the card then offers `once` alone.
      const ownAsk =
        event === "tool.check" &&
        base !== undefined &&
        raw !== base &&
        result === answer &&
        (answer as ModHookResult<"tool.check">).decision === "ask";
      const changed = base !== undefined && (this.#differs(event, result, base) || ownAsk);
      if (changed) this.#decided(registration, event, input, result, base, tool);
      return { result, changed };
    } catch (error) {
      if (belowError !== undefined && error === belowError.error) throw error;
      // A dispatch abandoned (the turn cancelled) is no hook's failure; neither is a hook stopping because it was withdrawn.
      if (cancelledNow()) throw signal?.reason ?? error;
      if (registration.lifetime.signal.aborted) return { result: await settleBelow(), changed: false };
      const kind: TurnHookFailureKind = error instanceof HookTimeout ? "timeout" : error instanceof HookShapeError ? "shape" : "throw";
      this.#failed(registration, event, input, kind, error, this.#now() - hookStartedAt, tool);
      return this.#standIn(registration, event, input, await settleBelow(), tool, kind === "timeout" ? "ran out of time" : "failed");
    } finally {
      // Its own time, whether it answered, threw or ran out — the slow ones are what latency is for; a cancel is not its time.
      pause();
      if (!cancelledNow()) this.#timed(registration.pluginId, event, this.#budgetMs - remaining);
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onOuter);
      signal?.removeEventListener("abort", onCancel);
      registration.lifetime.signal.removeEventListener("abort", onWithdrawn);
      registration.lifetime.signal.removeEventListener("abort", onGone);
    }
  }

  /**
   * A hook's answer, checked against its event's shape; observers answer
   * nothing. A `tool.result` replacement must keep the output's shape, on a
   * whole output the hook saw.
   */
  #checked<E extends ModEvent>(event: E, input: ModHookInput<E>, raw: unknown): ModHookResult<E> {
    if (!(event in RESULT_SCHEMAS)) return undefined as ModHookResult<E>;
    // A hook that answers nothing has nothing to add: no failure, for the events where nothing is an answer.
    // A gate's (`tool.check`) and a rewriter's (`tool.result`) silence is still a wrong shape: they decide something.
    if (
      raw === undefined &&
      (event === "tool.call" || event === "prompt.submit" || event === "turn.complete" || event === "heartbeat.item")
    )
      return {} as ModHookResult<E>;
    const parsed = RESULT_SCHEMAS[event as keyof typeof RESULT_SCHEMAS].safeParse(raw);
    if (!parsed.success) throw new HookShapeError(`its ${event} answer is not one the event takes`);
    if (event === "tool.result") {
      const shown = input as ModHookInput<"tool.result">;
      const parsedAnswer = parsed.data as ModHookResult<"tool.result">;
      // `{ output: undefined }` names no output: no answer the event takes (G-J), not a silent "unchanged".
      if (isRecord(raw) && "output" in raw && raw["output"] === undefined)
        throw new HookShapeError("its tool.result answer names no output");
      if (!("output" in parsedAnswer) || parsedAnswer.output === undefined)
        return ("withhold" in parsedAnswer ? parsedAnswer : {}) as ModHookResult<E>;
      // A replacement for an output it did not see whole (sensitive, or cut) is no answer the workflow keeps: unchanged.
      if (shown.truncated === true || shown.sensitive === true) return {} as ModHookResult<E>;
      // A copy the plugin holds no reference to (G-B): what is checked and masked is what is kept, whatever it does later.
      let output: unknown;
      try {
        output = JSON.parse(JSON.stringify(parsedAnswer.output)) as unknown;
      } catch {
        throw new HookShapeError("its tool.result answer is not JSON");
      }
      if (!sameOutputShape(shown.output, output)) {
        throw new HookShapeError("its tool.result answer changed the output's shape; only string values may change");
      }
      return { output: deepFrozen(output) } as ModHookResult<E>;
    }
    return parsed.data as ModHookResult<E>;
  }

  /**
   * A gate answer is never looser than the one beneath it: a hook that
   * answered without `next` is merged with what `next` would have answered.
   */
  async #tightened<E extends ModEvent>(
    event: E,
    input: ModHookInput<E>,
    answer: ModHookResult<E>,
    settleBelow: () => Promise<ModHookResult<E>>,
    sawBelow: boolean,
  ): Promise<ModHookResult<E>> {
    if (event === "tool.check") {
      return stricter(answer as ModHookResult<"tool.check">, (await settleBelow()) as ModHookResult<"tool.check">) as ModHookResult<E>;
    }
    if (event === "tool.call") {
      // A deny beneath stands even when this hook answered `{}` for itself.
      const own = answer as ModHookResult<"tool.call">;
      if (own.deny !== undefined) return answer;
      const base = (await settleBelow()) as ModHookResult<"tool.call">;
      return (base.deny === undefined ? own : base) as ModHookResult<E>;
    }
    if (event === "tool.result") {
      // A withhold beneath stands, even under a hook that answered for itself.
      const base = (await settleBelow()) as ModHookResult<"tool.result">;
      if ("withhold" in base) return base as ModHookResult<E>;
      const own = answer as ModHookResult<"tool.result">;
      if ("withhold" in own) return answer;
      // Rewrites compose: an answer with no output keeps the one beneath, and one with an output keeps what it left alone.
      if (!("output" in own) || own.output === undefined) return base as ModHookResult<E>;
      if (!("output" in base) || base.output === undefined) return answer;
      return {
        output: deepFrozen(composedOutput((input as ModHookInput<"tool.result">).output, base.output, own.output, sawBelow)),
      } as ModHookResult<E>;
    }
    if (event === "prompt.submit") {
      // As does a drop beneath.
      const base = (await settleBelow()) as ModHookResult<"prompt.submit">;
      if ("drop" in base) return base as ModHookResult<E>;
      const own = answer as ModHookResult<"prompt.submit">;
      if ("drop" in own) return answer;
      // Blocks compose: those beneath stand, and this hook's new ones follow, within the bound.
      const kept = base.context ?? [];
      const added = (own.context ?? []).filter((block) => !kept.includes(block));
      const context = [...kept, ...added].slice(0, MAX_HOOK_CONTEXT_BLOCKS);
      return (context.length === 0 ? {} : { context }) as ModHookResult<E>;
    }
    if (event === "turn.start" || event === "model.step" || event === "heartbeat.tick") {
      await settleBelow();
      return undefined as ModHookResult<E>;
    }
    if (event === "heartbeat.item") {
      // A drop beneath stands, then a drop of its own; a wait for the summary from either holds: never more urgent.
      const base = (await settleBelow()) as ModHookResult<"heartbeat.item">;
      if ("drop" in base) return base as ModHookResult<E>;
      const own = answer as ModHookResult<"heartbeat.item">;
      if ("drop" in own) return answer;
      return ("urgency" in own || "urgency" in base ? { urgency: "later" } : {}) as ModHookResult<E>;
    }
    if (event === "turn.complete") {
      // Every observer hears the turn end, whether or not an outer one called `next`; its suggestions stand, else those beneath.
      const base = (await settleBelow()) as ModHookResult<"turn.complete">;
      const own = answer as ModHookResult<"turn.complete">;
      return (own?.suggestions !== undefined && own.suggestions.length > 0 ? own : (base ?? own)) as ModHookResult<E>;
    }
    return answer;
  }

  #differs<E extends ModEvent>(event: E, result: ModHookResult<E>, base: ModHookResult<E>): boolean {
    if (event === "tool.check") {
      const own = result as ModHookResult<"tool.check">;
      const below = base as ModHookResult<"tool.check">;
      // An ask with a reason over an ask without one is the hook's own question, with its own words on the card.
      // So is a deny with a reason over one without: the model reads its words. A reason on an allow changes nothing the workflow keeps.
      return own.decision !== below.decision || (own.decision !== "allow" && own.reason !== undefined && below.reason === undefined);
    }
    if (event === "tool.call")
      return (result as ModHookResult<"tool.call">).deny !== undefined && (base as ModHookResult<"tool.call">).deny === undefined;
    if (event === "heartbeat.item") {
      const own = result as ModHookResult<"heartbeat.item">;
      const below = base as ModHookResult<"heartbeat.item">;
      return ("drop" in own && !("drop" in below)) || ("urgency" in own && !("urgency" in below) && !("drop" in below));
    }
    if (event === "tool.result" || event === "prompt.submit") {
      // An answer JSON cannot carry (an uncopyable result beneath a stand-in) is compared by what it is.
      const shown = jsonOf(result),
        below = jsonOf(base);
      return shown === undefined || below === undefined ? result !== base : shown !== below;
    }
    return false;
  }

  /** The answer a failed or suspended hook stands for: its failure rule, merged so it is never looser than `below`. */
  #standIn<E extends ModEvent>(
    registration: Registration,
    event: E,
    input: ModHookInput<E>,
    below: ModHookResult<E>,
    tool: string | undefined,
    why: string,
  ): { readonly result: ModHookResult<E>; readonly changed: boolean } {
    const reason = `${registration.pluginId} ${why}`;
    const stand = (result: ModHookResult<E>) => {
      const changed = this.#differs(event, result, below);
      if (changed) this.#decided(registration, event, input, result, below, tool);
      return { result, changed };
    };
    switch (registration.failure) {
      case "ask":
        return stand(stricter({ decision: "ask", reason }, below as ModHookResult<"tool.check">) as ModHookResult<E>);
      case "deny":
        // `tool.check` and `tool.call` both declare `deny`; each in its own shape.
        return stand(
          (event === "tool.check"
            ? stricter({ decision: "deny", reason }, below as ModHookResult<"tool.check">)
            : { deny: `The call was refused: ${reason}.` }) as ModHookResult<E>,
        );
      case "withhold":
        return stand({ withhold: `The result was withheld: ${reason}.` } as ModHookResult<E>);
      case "drop":
        return stand({ drop: `its prompt hook ${why}` } as ModHookResult<E>);
      case "skip":
        return { result: below, changed: false };
    }
  }

  #decided<E extends ModEvent>(
    registration: Registration,
    event: E,
    input: ModHookInput<E>,
    result: ModHookResult<E>,
    base: ModHookResult<E>,
    tool: string | undefined,
  ): void {
    const detail =
      event === "tool.check"
        ? `${(base as ModHookResult<"tool.check">).decision} → ${(result as ModHookResult<"tool.check">).decision}${(result as ModHookResult<"tool.check">).reason === undefined ? "" : `: ${(result as ModHookResult<"tool.check">).reason}`}`
        : event === "tool.call"
          ? `denied: ${(result as ModHookResult<"tool.call">).deny ?? ""}`
          : event === "tool.result"
            ? "withhold" in (result as object)
              ? `withheld: ${(result as { withhold: string }).withhold}`
              : "changed the output"
            : event === "prompt.submit"
              ? "drop" in (result as object)
                ? `dropped: ${(result as { drop: string }).drop}`
                : "added context"
              : event === "heartbeat.item"
                ? "drop" in (result as object)
                  ? `held back: ${(result as { drop: string }).drop}`
                  : "made it wait for the summary"
                : "answered";
    try {
      this.#options.onDecision?.({
        pluginId: registration.pluginId,
        event,
        envelope: input.envelope,
        ...(tool === undefined ? {} : { tool }),
        detail,
      });
    } catch {
      // An observer of decisions never changes one.
    }
  }

  #failed<E extends ModEvent>(
    registration: Registration,
    event: E,
    input: ModHookInput<E>,
    kind: TurnHookFailureKind,
    error: unknown,
    elapsedMs: number,
    tool: string | undefined,
  ): void {
    const message = errorMessage(error);
    this.#reportFailure({
      pluginId: registration.pluginId,
      event,
      kind,
      message,
      elapsedMs,
      envelope: input.envelope,
      ...(tool === undefined ? {} : { tool }),
    });
  }

  /** Tell of a failure, and count it toward its plugin's breaker: the hooks' own, or for a command its command breaker. */
  #reportFailure(failure: TurnHookFailure, breaker: "hooks" | "commands" = "hooks"): void {
    try {
      this.#options.onFailure?.(failure);
    } catch {
      // Reporting a failure never fails the dispatch.
    }
    const failures = breaker === "hooks" ? this.#failures : this.#commandFailures;
    const suspended = breaker === "hooks" ? this.#suspended : this.#commandsSuspended;
    const now = this.#now();
    const recent = [...(failures.get(failure.pluginId) ?? []), now].filter((at) => now - at <= this.#breakerWindowMs);
    failures.set(failure.pluginId, recent);
    if (recent.length >= this.#breakerLimit && !suspended.has(failure.pluginId)) {
      suspended.add(failure.pluginId);
      // Only the hooks' suspension is the plugin's: its commands being off is said by each command's answer.
      if (breaker === "hooks") {
        try {
          this.#options.onSuspended?.(failure.pluginId);
        } catch {
          // As above.
        }
      }
    }
  }
}

class HookShapeError extends Error {}

/** How many of a plugin's dispatches per event its latency is told over. */
const LATENCY_SAMPLES = 100;

/**
 * A hook event as hooks receive it: a JSON-safe deep copy,
 * frozen, so a hook that writes to it throws instead of changing the call, the
 * result or what another hook sees. The envelope is the one handed, already
 * frozen. Throws for a value JSON cannot carry (a cycle, a `BigInt`).
 */
function frozenEventOf<T extends { readonly envelope: ModEnvelope }>(input: T): T {
  const { envelope, ...rest } = input;
  return Object.freeze({ ...deepFrozen(JSON.parse(JSON.stringify(rest)) as typeof rest), envelope }) as T;
}

function deepFrozen<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFrozen(child);
    Object.freeze(value);
  }
  return value;
}

/** `value` as JSON, or `undefined` when JSON cannot carry it. */
function jsonOf(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
