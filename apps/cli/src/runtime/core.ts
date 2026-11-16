import { readWebProviderConfiguration } from "../features/search/provider-config.js";
import {
  resolveFetchBinding,
  devAuditId,
  RoutineService,
  RoutineExecutionService,
  ToolRegistry,
  TurnHookRegistry,
  createClock,
  createLogger,
} from "@tavi/runtime";
import { CHAT_COMMAND_NAMES } from "../tui/commands.js";
import { TaviError, type InvocationContext, type PluginHookEventRecord, maskPluginText, type ModEnvelope } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { MemoryCommandPlace } from "../features/memory/slash.js";
import { registerFixtureCaptureTool, registerFixtureEchoTool } from "../features/tools/fixture.js";
import { freeBytesAt } from "../shared/disk.js";
import type { CompositionBase } from "./context.js";
import type { WakePlanner } from "@tavi/agent-host/schedule-scheduler";
import { createDuePlanner, type DueSweepKind } from "./wakeups.js";

/** The slash words a channel keeps for itself (`/start` is Telegram's own): a plugin's command of the same name is `<plugin>:<name>`. */
const CHANNEL_COMMAND_NAMES: readonly string[] = ["new", "reset", "start"];

/** The clock, the logger, the due-work planner, the tool registry, the turn hooks and the routine services every other part builds on. */
export function composeCore(composed: CompositionBase) {
  const { late, options, ownershipSessionId, store } = composed;
  const clock = createClock();
  const webProviders = readWebProviderConfiguration(options.dataDirectory);
  for (const workspaceId of Object.keys(webProviders.workspaces))
    if (!options.workspaces.some((workspace) => workspace.workspaceId === workspaceId))
      throw new TaviError("NOT_CONFIGURED", `Web provider selection names unknown workspace ${workspaceId}`);
  const fetchSelection = (context: InvocationContext) => webProviders.workspaces[context.workspaceId]?.fetch;
  const fetchGeneration = async (context: InvocationContext) => {
    const execution = late.fetchExecution;
    if (execution === undefined) throw new TaviError("UNAVAILABLE", "Fetch execution boundary is unavailable");
    return (
      await resolveFetchBinding(
        {
          networkMode: "open_web",
          execution,
          ...(late.builtinFetchResolver === undefined ? {} : { provider: late.builtinFetchResolver }),
          selection: fetchSelection,
        },
        { url: "https://binding.invalid/" },
        context,
      )
    ).bindingHash;
  };
  const routines = new RoutineService(store, {
    toolPermissions: () => Object.fromEntries(tools.list().map((tool) => [tool.id, tool.requiredPermissions])),
  });
  const logger = createLogger(options.logger ?? {});
  // Reminders, schedules, agent waits, approval rounds and heartbeats are swept when their stored deadline comes or
  // something is written, and the owner's other periodic work ticks on the same timer: see `wakeups.ts`.
  const duePlanner: WakePlanner<DueSweepKind> = createDuePlanner({
    store,
    now: () => clock.now(),
    log: (message, fields) => logger.warn(message, fields),
  });
  const routineRuns = new RoutineExecutionService(routines, {
    get publicFetch() {
      return late.fetchExecution === undefined
        ? {}
        : {
            execution: late.fetchExecution,
            selection: fetchSelection,
            bindingGeneration: fetchGeneration,
            ...(late.builtinFetchResolver === undefined ? {} : { provider: late.builtinFetchResolver }),
          };
    },
    ownerEpoch: ownershipSessionId,
    dispatch: async (run, fence) => {
      if (late.routineDispatch === undefined) throw new TaviError("UNAVAILABLE", "Routine pipeline is unavailable");
      await late.routineDispatch(run, fence);
    },
    // Kept pending until the notices are composed.
    onPaused: async (run, cause) => (await late.routineNotices?.runPaused(run, cause)) ?? false,
    freeBytes: () => freeBytesAt(options.dataDirectory),
    // An authority refusal is never silently unrecorded: the ledger is the
    // artifact a routine's decisions are audited from.
    onLedgerGap: ({ runId, code, error }) =>
      logger.warn("routine grant denial could not be recorded in the ledger", { runId, code, error: errorMessage(error) }),
    onDrainError: ({ runId, error }) =>
      logger.warn("routine run could not be started or settled; left for recovery", { runId, error: errorMessage(error) }),
  });

  // The execution owner is the data-directory owner: one identity per process,
  // so the recorded lock holder and the execution ownership agree.
  const ownerSession = ownershipSessionId;
  const tools = new ToolRegistry();
  // Where a channel's command was typed — a direct chat, a group or an email thread — by the
  // envelope it runs under: the memory commands take only a direct chat (invariant 11).
  const memoryCommandPlaces = new WeakMap<ModEnvelope, MemoryCommandPlace>();
  // Plugins' hooks into the turn: created before the
  // workflow adapter and filled as plugins register, so it is read per dispatch.
  const turnHooks = new TurnHookRegistry({
    // What `tavi chat` and the channels keep for themselves: a plugin's command of the same name is `<plugin>:<name>`.
    reservedCommands: new Set([...CHAT_COMMAND_NAMES, ...CHANNEL_COMMAND_NAMES]),
    // Read when a command is named, after the built-ins are known.
    builtinPlugin: (pluginId) => late.builtinPluginIds.has(pluginId),
    // A dev plugin's decisions are its own: `mod:dev:<id>` on a card, a verdict and the ledger, never the installed plugin's rule.
    creditOf: (pluginId) => creditOf(pluginId),
    onFailure: (failure) => {
      logger.warn(`plugin ${failure.pluginId}: its ${failure.event} hook failed (${failure.kind}): ${maskPluginText(failure.message)}`, {
        pluginId: failure.pluginId,
        event: failure.event,
        kind: failure.kind,
        elapsedMs: Math.round(failure.elapsedMs),
        taskId: failure.envelope.taskId,
      });
      void recordHookEvent({
        pluginId: failure.pluginId,
        kind: "failure",
        event: failure.event,
        ...(failure.tool === undefined ? {} : { tool: failure.tool }),
        taskId: failure.envelope.taskId,
        workspaceId: failure.envelope.workspaceId,
        detail: `${failure.kind}: ${failure.message}`,
      });
    },
    onDecision: (decision) => {
      void recordHookEvent({
        pluginId: decision.pluginId,
        kind: "decision",
        event: decision.event,
        ...(decision.tool === undefined ? {} : { tool: decision.tool }),
        taskId: decision.envelope.taskId,
        workspaceId: decision.envelope.workspaceId,
        ...(decision.event === "tool.check" ? { ruleId: `mod:${creditOf(decision.pluginId)}` } : {}),
        detail: decision.detail,
      });
    },
    onSuspended: (pluginId) =>
      logger.warn(`plugin ${pluginId}: its hooks failed too often and are suspended until the owner restarts`, { pluginId }),
  });
  /** The name a plugin's hooks are credited and audited under: a dev plugin's apart from an installed plugin's of its id. */
  const creditOf = (pluginId: string): string => (late.devPluginIds.has(pluginId) ? devAuditId(pluginId) : pluginId);
  /** One audit row of a hook; a write that fails is logged, never the turn's failure. */
  const recordHookEvent = async (record: Omit<PluginHookEventRecord, "at">): Promise<void> => {
    try {
      // A hook's own words (its reason, its error) may quote what it saw.
      // A dev plugin's rows are kept apart from an installed plugin's of its id: its code was never approved.
      const pluginId = creditOf(record.pluginId);
      await late.persistencePort.repositories.plugins.appendHookEvent({
        ...record,
        pluginId,
        detail: maskPluginText(record.detail, 500),
        at: clock.now(),
      });
    } catch (error) {
      logger.warn("a plugin hook event could not be recorded", { pluginId: record.pluginId, error: errorMessage(error) });
    }
  };
  // Registered only for a suite that opts in; a real deployment's model-facing
  // surface has no fixture tool on it.
  if (options.devFixtureTools === true) {
    registerFixtureEchoTool(tools, clock);
    registerFixtureCaptureTool(tools, () => late.persistencePort.repositories.artifacts);
  }
  return {
    clock,
    duePlanner,
    fetchGeneration,
    fetchSelection,
    logger,
    memoryCommandPlaces,
    ownerSession,
    routineRuns,
    routines,
    tools,
    turnHooks,
    webProviders,
  };
}

export type CoreContext = CompositionBase & ReturnType<typeof composeCore>;
