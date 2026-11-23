import { chatCaptureProviderOf } from "../features/memory/providers.js";
import { BROWSER_ENGINE_PLUGIN_ID } from "../features/plugins/catalog.js";
import { forgetChatHistory, forgetMemoryTaught } from "../features/tasks/history-owner.js";
import { cancelOpenedPurges, rememberAccounts, type ChannelPurgeDependencies } from "../features/channels/purge.js";
import {
  CHECKPOINTS_KEPT,
  SHIPPED_TOOL_RULES,
  hostTimeZone,
  localeOf,
  maxOutputTokensOf,
  promptLayoutOf,
  toolDeferralOf,
  parallelReadsOf,
  tasksHomeOf,
  tasksHomeServer,
  IDEA_PREPARE_MAX_STEPS,
  IDEA_TURN_MAX_OUTPUT_TOKENS,
  MAX_LIVE_REVISION_IDS,
  type AdmitInput,
  type ScheduleRecord,
  type WorkflowPort,
} from "@tavi/contracts";
import { maskedRoundRequest, withRunEvents } from "../features/run/run-events.js";
import { handOnSteers } from "../server/reply.js";
import { admitScheduledWorker, continueScheduledTask } from "@tavi/agent-host/schedule-scheduler";
import { errorMessage } from "@tavi/contracts/util";
import { messagingTurnsOf } from "../features/memory/idle-review.js";
import { HEARTBEAT_TURN_MAX_OUTPUT_TOKENS, HEARTBEAT_TURN_MAX_STEPS } from "../features/heartbeat/turns.js";
import { noticesLabelOf, withChatNotices } from "../features/tasks/notices.js";
import { createWorkflowAdapter, type MemoryRecallSwitches } from "@tavi/agent-host/workflow";
import { createLocalCredentialStore, serializeCredentialAction } from "../features/credentials/store.js";
import { BROWSER_WORKER_MAX_STEPS, browserWorkerUses, withBuiltinAgents } from "../features/agents/builtin.js";
import { keptFindingsDigest } from "../features/tools/findings.js";
import { createRoleTarget } from "../features/models/role-target.js";
import { withRoutineCheckpoints } from "../features/routines/workflow.js";
import { chatMemoryOf, heldChannelOf, heldConnectionOf, memoryReachOf, toolPolicyOrigin } from "./chat-scope.js";
import type { AskingContext } from "./asking.js";

/** Stage 2's trigger for a local model whose window the catalog does not know: many run with a few thousand tokens. */
const LOCAL_UNKNOWN_WINDOW_TRIGGER_TOKENS = 6_000;

/** The workflow adapter, with run events and routine checkpoints, and channel purging. */
export function composeWorkflow(composed: AskingContext) {
  const {
    localChatModels,
    browserOffered,
    disabledBuiltins,
    FRESH_CONTEXT_MARK,
    SCHEDULE_QUESTION_RESERVE_MS,
    abortRegistry,
    access,
    admissions,
    askUserDelivery,
    askingTask,
    browserHandoffs,
    builtinWorkerOf,
    channelApprovals,
    channelReplyRelay,
    channels,
    chatFolders,
    chatGrants,
    chatNotices,
    checkpointSaver,
    clock,
    folderSpace,
    hasModelTransport,
    heartbeatReports,
    injectionScan,
    late,
    localMessaging,
    logger,
    mcpHost,
    memory,
    hybridRef,
    memoryCards,
    memoryProviders,
    memoryReads,
    memorySettings,
    messaging,
    messagingProfileFor,
    modelAccounting,
    modelAdapter,
    modelConnectionLocality,
    options,
    ownerSession,
    pendingBrowserActions,
    persistencePort,
    preparedProviders,
    reachableChannels,
    recordGateObservation,
    redactToolResults,
    redactionOn,
    resolvedPlugins,
    router,
    routerRepository,
    routineCheckpoints,
    runEventBus,
    scheduleFires,
    scratchAtTurnEnd,
    skills,
    store,
    taintMode,
    taskRouting,
    taskTree,
    tellConnect,
    tools,
    turnFolder,
    turnHooks,
    readMemos,
  } = composed;
  const rawWorkflow = hasModelTransport
    ? createWorkflowAdapter({
        taskRouting,
        routing: { service: router, repository: routerRepository },
        ...(options.explicitModelSelection === undefined ? {} : { explicitModelSelection: options.explicitModelSelection }),
        ...(options.explicitModelTarget === undefined ? {} : { explicitModelTarget: options.explicitModelTarget }),
        checkpointSaver,
        models: modelAdapter,
        tools,
        redactToolResults,
        taintMode,
        injectionScan,
        recordGateObservation,
        turnHooks,
        heartbeatProviderOf: (taskId) => heartbeatReports.providerOf(taskId),
        ideasProviderOf: (taskId) => preparedProviders.get(taskId),
        memoryWithheld: (taskId) => heartbeatReports.memoryWithheld(taskId),
        heartbeatMemoryShown: (taskId) => heartbeatReports.memoryShown(taskId),
        access,
        tasks: persistencePort.repositories.tasks,
        executions: persistencePort.repositories.executions,
        effects: persistencePort.repositories.effects,
        approvals: persistencePort.repositories.approvals,
        cancellations: persistencePort.repositories.cancellations,
        receipts: persistencePort.repositories.receipts,
        memory,
        skills,
        mailbox: persistencePort.repositories.agentMailbox,
        skillRollout: persistencePort.repositories.skillRollout,
        // Read only when the active skills are past the listing cap: then the recently used are listed.
        skillUsage: persistencePort.repositories.skills,
        agents: () => late.agentsService,
        ...(browserHandoffs === undefined ? {} : { browserHandoff: () => browserHandoffs.port }),
        artifacts: persistencePort.repositories.artifacts,
        // A Home's grants, and a conversation's, end with its epoch:
        // what a chat that never ends keeps grows no further than its epoch.
        onEpochRollover: async (taskId, rollover) => {
          await chatGrants.onEpochRollover(taskId);
          // What the folded span made in scratch goes with it: a chat's own `.tmp/`, never a worker's root's.
          const rolled = await persistencePort.repositories.tasks.get(taskId);
          if (rolled !== undefined && rolled.chatKind !== "worker" && rolled.origin !== "agent") {
            await folderSpace
              .emptyScratch(chatFolders.managedPath(rolled.workspaceId, taskId))
              .catch((error: unknown) =>
                logger.warn("a chat's scratch could not be emptied at its epoch rollover", { taskId, error: errorMessage(error) }),
              );
          }
          // The divider the canvas draws where the chat rolled over, linking its archive.
          await chatNotices.postEpoch(taskId, rollover);
        },
        // Every turn leaves its thread the newest CHECKPOINTS_KEPT checkpoints:
        // a resume reads only the newest, so a chat's rows are
        // bounded by that, not by its epoch.
        pruneCheckpoints: async (threadId) => {
          await store.checkpoints.pruneThread({ threadId, keep: CHECKPOINTS_KEPT });
        },
        // The memory eval runs recall's quality steps on and off: a comma list of
        // `floor`, `profile`, `priors` and `dates` in TAVI_EVAL_MEMORY_RECALL_OFF switches those off.
        ...memoryRecallFromEnv(process.env["TAVI_EVAL_MEMORY_RECALL_OFF"]),
        // Before a rollover folds a span, what it held worth remembering is
        // proposed for review: one bounded call, shown in the chat as
        // one memory card per epoch.
        epochMemoryFlush: {
          // The workspace's memory provider drafts, as the idle review's does: an external one only with `conversation`
          // on, and never for a chat on a local connection (invariant 27; unknown is local), whose span the built-in drafts.
          provider: (invocation) =>
            chatCaptureProviderOf(memoryProviders, invocation.workspaceId, async () =>
              hybridRef.current === undefined
                ? true
                : await hybridRef.current.chatIsLocal(invocation.workspaceId, invocation.chatTaskId ?? invocation.runId),
            ),
          onProposed: (taskId, epoch, recordIds) => memoryCards.onFlushed(taskId, epoch, recordIds),
        },
        // The stage-2 summary on `compaction`, the flush on `extraction`, on a bound role — never a remote one for a chat on a local connection.
        roleTarget: createRoleTarget({
          roleBindings: (workspaceId) => persistencePort.repositories.modelConfig.listRoleBindings(workspaceId),
          attempts: (taskId) => modelAccounting.summaries(taskId),
          locality: modelConnectionLocality,
        }),
        // An epoch is flushed at most once across restarts: its durable mark is claimed first (invariant 17).
        memoryMarks: { claim: (input) => persistencePort.repositories.transcripts.claimMemoryMark(input) },
        // A folded turn that came in from a messaging channel is not flushed, as the idle review passes it by (invariant 6).
        messagingTurns: (taskId, admissionIds) => messagingTurnsOf(persistencePort.repositories.transcripts, taskId, admissionIds),
        // Fresh context: `chat-context {action: "compact"}` asks; the chat's next message takes it.
        takeFreshContext: async (taskId) =>
          await persistencePort.repositories.transcripts.takeMemoryMark({ taskId, ...FRESH_CONTEXT_MARK }),
        // Rewind: `chat-context {action: "rewind"}` holds the turn; the chat's next admission cuts back to before it.
        rewinds: {
          marker: async (taskId) => await persistencePort.repositories.transcripts.rewindMarker(taskId),
          clear: async (taskId, admissionIds) => {
            await persistencePort.repositories.transcripts.clearRewind(taskId, admissionIds);
          },
        },
        // Steering: what a person sent into a running turn, taken before its next model call.
        steers: {
          open: async (taskId) => await persistencePort.repositories.transcripts.openSteers(taskId),
          claim: async (taskId, admissionId, steerIds) =>
            await persistencePort.repositories.transcripts.claimSteers(taskId, admissionId, steerIds),
          settle: async (taskId, heldIds) => {
            await persistencePort.repositories.transcripts.settleSteers(taskId, heldIds);
          },
        },
        // Compaction follows the window the catalog records for the model.
        contextWindowOf: async (target) =>
          (await persistencePort.repositories.modelConfig.listCatalog(target.connectionId)).find((entry) => entry.modelId === target.model)
            ?.contextWindow,
        // With none recorded, a local model (or one of unknown locality) folds where every release folded an
        // unknown window; the default is sized for hosted models.
        unknownWindowTriggerTokens: async (target) =>
          (await modelConnectionLocality(target.connectionId)) === "remote" ? undefined : LOCAL_UNKNOWN_WINDOW_TRIGGER_TOKENS,
        // One process owns this data directory, so the session identity is
        // stable for the lifetime of the runtime.
        ownerSession,
        connectionId: options.defaultConnectionId,
        model: options.defaultModel,
        ...(options.modelFallback === undefined || options.modelFallback.length === 0 ? {} : { fallback: options.modelFallback }),
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
        // The editable workspace base. Consulted only when this adapter was built *without* an
        // explicit `systemPrompt`, so the routine adapters — built by spreading
        // these options and then setting their own pinned prompt — keep it
        // authoritative. `options.systemPrompt` above is the embedding seam, not
        // an ordinary workspace path.
        // Named personas. Wired unconditionally: a task
        // that names no agent behaves exactly as before, and one that does gets
        // its persona appended to the base instructions.
        // With the built-in agents (the browser worker) behind the workspace's own.
        agentDefinitions: withBuiltinAgents(
          persistencePort.repositories.agents,
          // The browser worker while the browser is on and its Chromium installed, as the browser's tools are offered.
          disabledBuiltins.has(BROWSER_ENGINE_PLUGIN_ID) ? false : (browserOffered ?? true),
        ),
        // The built-in browser worker's profile: its tools and its steps a turn —
        // only while the workspace has no `browser` definition of its own.
        // A heartbeat turn takes at most its own few steps.
        maxStepsFor: async (taskId) => {
          const origin = await readMemos.taskOrigin(taskId);
          if (origin === "heartbeat") return HEARTBEAT_TURN_MAX_STEPS;
          // An idea's prepared step: a short read-only look.
          if (origin === "ideas") return IDEA_PREPARE_MAX_STEPS;
          return (await builtinWorkerOf(taskId)) ? BROWSER_WORKER_MAX_STEPS : undefined;
        },
        // A heartbeat's or an idea's own cap; any other task's is the workspace's `models.maxOutputTokens`, read per call.
        maxOutputTokensFor: async (taskId, workspaceId) => {
          const origin = await readMemos.taskOrigin(taskId);
          if (origin === "heartbeat") return HEARTBEAT_TURN_MAX_OUTPUT_TOKENS;
          if (origin === "ideas") return IDEA_TURN_MAX_OUTPUT_TOKENS;
          return maxOutputTokensOf((await readMemos.workspaceSettings.get(workspaceId)).settings);
        },
        // A heartbeat turn's ticks share one cache key, and one whose next check falls within the hour keeps its
        // tools and system text cached that long.
        cacheFor: (taskId) => heartbeatReports.cacheOf(taskId),
        toolsForTask: async (taskId) => {
          if (!(await builtinWorkerOf(taskId))) return undefined;
          // An approved plugin's tools that declare browserWorker, read from the manifests that run.
          const plugins = new Set(
            resolvedPlugins.flatMap((plugin) =>
              plugin.ok
                ? plugin.record.manifest.tools
                    .filter((tool) => tool.browserWorker === true)
                    .map((tool) => `${plugin.record.pluginId}.${tool.name}`)
                : [],
            ),
          );
          return (toolId: string) => browserWorkerUses(toolId, plugins);
        },
        // Each MCP server behind search gets a line in `tools.search`'s description, for whom it is offered.
        toolSearchLines: (context) => mcpHost.bridge.searchLines(context),
        // The final step answers from what the task and its workers kept.
        keptFindings: (workspaceId, taskId) =>
          keptFindingsDigest({ findings: persistencePort.repositories.findings, taskTree }, workspaceId, taskId),
        // Each chat's own instructions, joined after the persona at the revision
        // the turn was admitted under.
        chatInstructions: persistencePort.repositories.chatInstructions,
        // The memories each chat's turns were given, for its panel's "Used here".
        memoryUse: persistencePort.repositories.memoryUse,
        // `v2`: which memories a chat's kept context blocks showed are forgotten, so those blocks are dropped.
        forgottenMemory: async (_workspaceId, revisionIds) => {
          const ids = revisionIds.slice(0, MAX_LIVE_REVISION_IDS);
          const live = new Set(await persistencePort.repositories.memory.liveRevisionIds(ids));
          // Past the bound none can be told live: each is treated as forgotten, never sent unchecked.
          return new Set(revisionIds.filter((id) => !live.has(id)));
        },
        // The workspace zone the runtime facts state the current local time in.
        // Read per call, so a `tavi config set`
        // reaches the next model call of a running task; unset is the host zone.
        workspaceTimezone: async (workspaceId) => (await readMemos.workspaceSettings.get(workspaceId)).settings.timezone ?? hostTimeZone(),
        // `workspace.locale`, read per call as the zone is: the runtime facts ask for replies in it.
        workspaceLocale: async (workspaceId) => localeOf((await readMemos.workspaceSettings.get(workspaceId)).settings),
        // The workspace's `models.promptLayout`, read per call as the zone is.
        promptLayout: async (workspaceId) => promptLayoutOf((await readMemos.workspaceSettings.get(workspaceId)).settings),
        // `models.toolDeferral`: `auto` defers a chat's rarely used built-ins unless it runs on a local model.
        toolDeferral: async (workspaceId, taskId) => {
          const setting = toolDeferralOf((await readMemos.workspaceSettings.get(workspaceId)).settings);
          return setting === "auto" ? !(await localChatModels.runsLocal(workspaceId, taskId)) : setting === "on";
        },
        // `tools.parallelReads`, read only for a step with independent reads to run together.
        parallelReads: async (workspaceId) => parallelReadsOf((await readMemos.workspaceSettings.get(workspaceId)).settings),
        // `tasks.home`, read per call as the zone is: a task app of the person's own takes their to-dos.
        tasksHomeServer: async (workspaceId) => tasksHomeServer(tasksHomeOf((await readMemos.workspaceSettings.get(workspaceId)).settings)),
        reachableChannels,
        askUser: askUserDelivery,
        tellConnect,
        // A schedule's question is decided, and its task carried on, before its
        // next fire: a cap already past refuses the question.
        askUserDeadlineCap: async (taskId) => {
          const asking = await askingTask(taskId);
          const next = asking?.checkpoints === true ? asking.schedule?.nextRunAt : undefined;
          return next === null || next === undefined ? undefined : new Date(Date.parse(next) - SCHEDULE_QUESTION_RESERVE_MS).toISOString();
        },
        ...(options.approvalRequiredFor === undefined ? {} : { approvalRequiredFor: options.approvalRequiredFor }),
        ...(options.approvalExemptTools === undefined ? {} : { approvalExemptTools: options.approvalExemptTools }),
        // Shipped defaults first, then the workspace's own rules; deny and ask
        // are evaluated before allow, so an operator rule always overrides a
        // shipped allow.
        toolPolicy: {
          rules: async (workspaceId, invocation) => [
            ...SHIPPED_TOOL_RULES,
            ...(await messagingProfileFor(invocation)),
            ...(await persistencePort.repositories.toolPolicy.listRules(workspaceId)),
          ],
          // In a chat that never ends a grant lasts a day, or its epoch.
          sessionGrants: (taskId) => chatGrants.sessionGrants(taskId),
          grantSession: (grant) => chatGrants.grantSession(grant),
          // Idempotent by id: a resumed node re-applying its decision finds its rule.
          addRule: async (rule) => {
            if ((await persistencePort.repositories.toolPolicy.getRule(rule.workspaceId, rule.ruleId)) === undefined)
              await persistencePort.repositories.toolPolicy.putRule(rule);
          },
        },
        // A delegated worker is held to its root's origin: a chat task cannot
        // leave the messaging profile by spawning an agent.
        // Only a worker's or a reminder's origin needs its chain read; any other is the task's own, which never changes.
        taskOrigin: async (taskId) => {
          const own = await readMemos.taskOrigin(taskId);
          return own === "agent" || own === "reminder" ? await toolPolicyOrigin(persistencePort.repositories, taskId) : own;
        },
        // A turn sent from a messaging conversation is held to the messaging
        // profile too, whatever started its chat, and so is every worker such
        // a turn spawned.
        turnChannel: (invocation) => heldChannelOf(readMemos, invocation),
        turnConnection: (invocation) => heldConnectionOf(readMemos, invocation),
        // A worker is held to its spawning turn's front end, whoever admits its turns.
        // A group conversation, its topics and their workers read only their chat's notes.
        memoryReach: (taskId, known) => memoryReachOf(persistencePort.repositories, taskId, known),
        // The workspace's memory section, per model call: paused, capture off, and the limits.
        memorySettings,
        // The chat's own memory mode, per model call: off or private reads and captures nothing.
        chatMemory: (taskId, known) => chatMemoryOf(persistencePort.repositories, taskId, known),
        turnFrontEnd: async (invocation) => (await readMemos.agentDelegations.getByWorkerTaskId(invocation.runId))?.frontEnd,
        // The chat's working folder, once per admission: a worker's is its root chat's, a held turn's the managed folder only.
        turnFolder,
        // Its `.tmp/` is emptied when the chat's own turn ends.
        onTurnEnded: scratchAtTurnEnd,
        announceRound: async (round) => {
          // A channel's card, and the live view's outline, show the round as clients see it: masked.
          const shown = (await redactionOn(round.invocation.workspaceId).catch(() => true))
            ? { ...round, requests: round.requests.map(maskedRoundRequest) }
            : round;
          // The live view outlines a write action waiting on this round.
          pendingBrowserActions.announced(shown);
          return channelApprovals.announceRound(shown);
        },
        announceReview: (review) => channelApprovals.announceReview(review),
        onRoundSettled: (settlement) => {
          pendingBrowserActions.settled(settlement);
          return channelApprovals.onRoundSettled(settlement);
        },
        onRoundToolResults: async (report) => channelApprovals.recordToolResults(report),
        ...(options.maxContextTokens === undefined ? {} : { maxContextTokens: options.maxContextTokens }),
        newId: (prefix) => clock.newId(prefix),
        now: () => clock.now(),
        onDiagnostic: (message, fields) => logger.warn(message, fields),
      })
    : undefined;

  /**
   * The port every admitting path receives.
   *
   * Wrapped **before** anything is handed it, so the scheduler, the wait sweep,
   * agent communication and messaging all publish through the bus. Wrapping at
   * the return instead left those five sites emitting nothing, silently — they
   * are the majority of the ten places that admit.
   */
  /** Worker results being announced after their worker's admission: awaited before the store closes. */
  const pendingAnnounces = new Set<Promise<void>>();
  const withEvents =
    rawWorkflow === undefined
      ? undefined
      : withRunEvents(
          withChatNotices(rawWorkflow, {
            transcripts: persistencePort.repositories.transcripts,
            // A notice in Home carries the label of the run or side chat it is about.
            noticesLabel: async (notices) =>
              await noticesLabelOf(notices, {
                tasks: persistencePort.repositories.tasks,
                contextLabel:
                  rawWorkflow.checkpoints.contextLabel === undefined
                    ? undefined
                    : async (threadId) => await rawWorkflow.checkpoints.contextLabel?.(threadId),
              }),
            log: (message, fields) => logger.warn(message, fields),
          }),
          {
            bus: runEventBus,
            delegations: readMemos.agentDelegations,
            // A round's inputs reach clients masked, as `tool.started`'s do.
            maskInputs: redactionOn,
            aborts: abortRegistry,
            admissions,
            onDiagnostic: (message, fields) => logger.warn(message, fields),
            // Each turn's saved history, with the memory its tools read.
            transcripts: persistencePort.repositories.transcripts,
            memoryReads,
            // Each memory proposal is judged by the admission that made it.
            onAdmissionClaimed: (taskId, admissionId) => memoryCards.onAdmissionClaimed(taskId, admissionId),
            now: () => clock.now(),
            // A worker's result goes to the task that spawned it.
            // A run's or side chat's settle posts its notice.
            onTaskEnded: async (taskId, admissionId, outcome) => {
              // A one-to-one chat's answer the turn did not send itself, first, so a card follows it (features/channels/reply-relay.ts).
              await channelReplyRelay.onTaskEnded(taskId, admissionId, outcome);
              // What the turn proposed, as one card after it; best effort.
              await memoryCards.onTaskEnded(taskId, admissionId);
              try {
                await chatNotices.onTaskEnded(taskId);
              } catch (error) {
                logger.warn("a settled task's notice could not be posted", { taskId, reason: errorMessage(error) });
              }
              // After the worker's admission, not inside it:
              // the announce may resume or wake the parent, whose whole turn
              // would otherwise run within the worker's. Exactly once still:
              // the envelope's id is the ending's, and a lost one is announced
              // at the next start.
              const agents = late.agentsService;
              if (agents === undefined) return;
              // Tracked, so the store is not closed under it (`tavi.persistence`'s stop awaits these).
              const announced: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
                .then(() => agents.announceWorkerResult(taskId))
                .catch((error: unknown) => {
                  logger.warn("a finished worker's result could not be announced", { taskId, reason: errorMessage(error) });
                })
                .finally(() => pendingAnnounces.delete(announced));
              pendingAnnounces.add(announced);
            },
            // A steer the turn did not take before it ended is the chat's next turn.
            // A worker's result that came while the turn ran, or while it waited, is read now.
            onAdmissionEnded: async (taskId) => {
              await handOnSteers(
                {
                  repositories: persistencePort.repositories,
                  localMessaging,
                  now: () => clock.now(),
                  log: (level, message, fields) => logger[level](message, fields),
                },
                taskId,
              );
              await late.agentsService?.wakeIfOwed(taskId);
            },
          },
        );
  // A routine root waiting on a checkpoint question is resumed by the
  // run that holds it, on the routine's own adapter: every settler comes through here.
  const routed =
    withEvents === undefined ? undefined : withRoutineCheckpoints(withEvents, routineCheckpoints, persistencePort.repositories.tasks);
  /**
   * The schedule whose run a worker belongs to, while that run is the
   * schedule's — its fire or its continuation in flight, or its wait held:
   * a new worker by the chat it is delegated from, a worker's later turn by
   * its delegation's root.
   */
  const scheduledWorkerOf = async (
    input: AdmitInput,
  ): Promise<{ readonly schedule: ScheduleRecord; readonly rootTaskId: string } | undefined> => {
    const rootTaskId =
      input.taskId === undefined
        ? input.chatKind === "worker"
          ? input.context.chatTaskId
          : undefined
        : input.kind === "deadline"
          ? (await persistencePort.repositories.agentDelegations.getByWorkerTaskId(input.taskId))?.rootTaskId
          : undefined;
    const scheduleId = rootTaskId === undefined ? undefined : scheduleFires.scheduleOf(rootTaskId);
    if (rootTaskId === undefined || scheduleId === undefined) return undefined;
    const schedule = await persistencePort.repositories.schedules.get(scheduleId);
    return schedule === undefined ? undefined : { schedule, rootTaskId };
  };
  // A schedule's task carried on past its question or its worker, or woken to
  // read a worker's result, decides its rounds by the schedule's tool policy,
  // as its fire would have, and so do the workers its run spawns.
  const workflow: WorkflowPort | undefined =
    routed === undefined
      ? undefined
      : {
          checkpoints: routed.checkpoints,
          ...(routed.openHome === undefined ? {} : { openHome: routed.openHome }),
          admit: async (input, invokeOptions) => {
            const scheduling = late.scheduleDependencies;
            if (scheduling === undefined) return routed.admit(input, invokeOptions);
            // A resume, or a wake to read its workers' results while its run is the schedule's.
            const carriedOn =
              input.kind === "deadline" ||
              (input.kind === "reply" && input.taskId !== undefined && scheduleFires.scheduleOf(input.taskId) !== undefined);
            const asking = carriedOn && input.taskId !== undefined ? await askingTask(input.taskId) : undefined;
            if (asking?.schedule !== undefined) {
              return continueScheduledTask(asking.schedule, input, { ...scheduling, workflow: routed }, { runKey: asking.runKey });
            }
            const worker = await scheduledWorkerOf(input);
            if (worker !== undefined) {
              return admitScheduledWorker(worker.schedule, input, { ...scheduling, workflow: routed }, invokeOptions, {
                rootTaskId: worker.rootTaskId,
              });
            }
            return routed.admit(input, invokeOptions);
          },
        };
  late.workflow = workflow;
  // Decisions from a chat go through the wrapped workflow, so every attached
  // client hears `approval.settled` exactly as for any other front end.
  late.workflowForChannels = workflow;

  /**
   * A removed connection's purge: each of its conversation tasks forgotten as `forget
   * --with-memory` does, as its own person, then every checkpoint of its
   * thread (a `forget` keeps the newest few to go on from); run by the
   * retention sweep once its grace has passed.
   */
  const rememberOpenAccounts = async (): Promise<void> =>
    await rememberAccounts(
      { get: (key) => store.getMeta(key), set: (key, value) => store.setMeta(key, value, clock.now()) },
      channels.configured().filter((record) => messaging.statusOf(record.connectionId) !== undefined),
      (connectionId) => messaging.statusOf(connectionId)?.accountRef,
    );
  // Each purging connection that opened cancels its account's scheduled purges: one re-added
  // while it could not open, offline or failing at save, or a reinstalled channel plugin's, opens here.
  const cancelOpenPurges = async (log: Pick<typeof logger, "info" | "warn">): Promise<readonly string[]> => {
    const cancelled = await cancelOpenedPurges(
      channelPurging,
      channels.configured(),
      (connectionId) => messaging.statusOf(connectionId)?.accountRef,
    ).catch((error: unknown) => {
      log.warn("opened connections' purges could not be checked", { error });
      return [];
    });
    if (cancelled.length > 0) log.info("connections that opened cancelled their accounts' purges", { cancelled });
    return cancelled;
  };
  const channelPurging: ChannelPurgeDependencies = {
    repositories: persistencePort.repositories,
    forgetTask: async (taskId) => {
      const now = clock.now();
      const { erased } = await forgetChatHistory(
        {
          repositories: persistencePort.repositories,
          dropRetainedEvents: (id, before) => void runEventBus.dropRetained(id, before),
        },
        taskId,
        now,
      );
      const task = await persistencePort.repositories.tasks.get(taskId);
      if (task === undefined) return { turns: erased.forgotten, notes: 0 };
      const taught = await forgetMemoryTaught(
        memory,
        { principalId: task.principalId, workspaceId: task.workspaceId, caller: "retention", authority: "operator" },
        taskId,
        now,
        true,
      );
      await store.checkpoints.deleteThread(task.threadId);
      return { turns: erased.forgotten, notes: taught.proposals + taught.memories };
    },
    eraseArtifacts: async (artifactIds) => await store.eraseArtifacts(artifactIds),
    removeConnection: async (record) => {
      await persistencePort.repositories.messagingConnections.remove(record.connectionId, clock.now());
      await serializeCredentialAction(options.dataDirectory, async () => {
        const credentials = createLocalCredentialStore(options.dataDirectory);
        for (const reference of Object.values(record.credentialRefs)) await credentials.deleteSecret(reference);
      });
    },
    log: (level, message, fields) => logger[level](message, fields),
    now: () => clock.now(),
  };
  return { cancelOpenPurges, channelPurging, pendingAnnounces, rememberOpenAccounts, workflow };
}

export type WorkflowContext = AskingContext & ReturnType<typeof composeWorkflow>;

/** `WorkflowOptions.memoryRecall` from the eval's switch list; nothing when it names none. */
function memoryRecallFromEnv(value: string | undefined): { readonly memoryRecall?: MemoryRecallSwitches } {
  const off = new Set((value ?? "").split(",").map((entry) => entry.trim()));
  const recall: MemoryRecallSwitches = {
    ...(off.has("floor") ? { relevanceFloor: false } : {}),
    ...(off.has("profile") ? { profile: false } : {}),
    ...(off.has("priors") ? { rankingPriors: false } : {}),
    ...(off.has("dates") ? { temporalRanking: false } : {}),
  };
  return Object.keys(recall).length === 0 ? {} : { memoryRecall: recall };
}
