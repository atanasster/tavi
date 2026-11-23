import { LOCAL_CHAIN_UNAVAILABLE } from "../features/router/task-routing.js";
import {
  TaviError,
  homeChatOn,
  isTrustedPublic,
  isUntrusted,
  ATTENDED_TASK_POLICY,
  reminderTaskOperationKey,
  type RoutinesPayload,
  type ScheduleRecord,
  isLocalConnectionId,
  noticeWordsOf,
  textRef,
} from "@tavi/contracts";
import { type ScheduleSchedulerDependencies, sendAlert } from "@tavi/agent-host/schedule-scheduler";
import { type createReminderDelivery, operatorTargetsOf } from "../features/reminders/delivery.js";
import { registerReminderTools } from "../features/reminders/tools.js";
import { fireScheduleNow, type ScheduleFireNow } from "../features/schedules/actions.js";
import type { ScheduleEmailFire, ScheduleWebhookFire } from "@tavi/agent-host/schedule-scheduler";
import { createSchedulePrecheck, precheckSiteRefusal } from "../features/schedules/precheck.js";
import { scheduledBudgetNotices } from "../features/schedules/budget-notice.js";
import { createScheduleWebhookHandler, createScheduleWebhookIds } from "../features/schedules/webhook.js";
import { createScheduleEmailTriggers } from "../features/schedules/email-trigger.js";
import { createScheduleWatchers, scheduleWriteCount } from "../features/schedules/watchers.js";
import { credentialKeyFile } from "../features/credentials/store.js";
import { registerScheduleTools } from "../features/schedules/tools.js";
import { registerTodoTools } from "../features/todos/tools.js";
import { freeBytesAt } from "../shared/disk.js";
import { channelWords, workspaceLocaleOf } from "../features/channels/channel-words.js";
import type { RoutinesContext } from "./routines.js";

/** How often the schedule sweep's routine bookkeeping prunes old due details, evidence and run snapshots. */
const ROUTINE_PRUNE_EVERY_MS = 10 * 60_000;

/** How often the sweep sums a budgeted workspace's scheduled work for its monthly notice. */
const SCHEDULED_BUDGET_CHECK_EVERY_MS = 10 * 60_000;

/** The reminder and to-do tools, reminder tasks and targets, and the schedule scheduler's dependencies. */
export function composeSchedules(composed: RoutinesContext) {
  const {
    access,
    chatFolders,
    chatNotices,
    clock,
    duePlanner,
    heartbeatFetchPage,
    ingressGuards,
    localChatModels,
    taskRouting,
    late,
    liveModelReady,
    logger,
    materializeArtifact,
    messaging,
    options,
    persistencePort,
    providerFailures,
    routineControl,
    routineNews,
    routineRuns,
    routines,
    scheduleFires,
    sitePolicy,
    store,
    tools,
    wakeRoutines,
    workflow,
    workspaceZone,
  } = composed;
  /** With Home on and none yet, a schedule's word starts one: a person who only used side chats has nowhere else to read it. */
  const startHome = async ({ workspaceId, principalId }: Pick<ScheduleRecord, "workspaceId" | "principalId">): Promise<void> => {
    const { tasks, workspaceSettings } = persistencePort.repositories;
    if (workflow?.openHome === undefined || !homeChatOn((await workspaceSettings.get(workspaceId)).settings)) return;
    if ((await tasks.homeOf(workspaceId, principalId)) !== undefined) return;
    try {
      const taskId = await workflow.openHome({ workspaceId, principalId });
      await chatNotices.postEarlierChats({ taskId, workspaceId, principalId });
    } catch (error) {
      // Started by the person's own message just now: that Home takes it.
      if (TaviError.from(error).code !== "CONFLICT") throw error;
    }
  };
  /**
   * Whether a schedule is firing, scheduled or by hand, from its claim on — its pre-check and admission included:
   * a change or removal waits for it.
   */
  const scheduleFireInFlight = (scheduleId: string): boolean => scheduleFires.hasSchedule(scheduleId);
  /**
   * Fire a schedule now, one fire per schedule at a time: its claim is checked and taken in the registry the sweep
   * claims in too, before anything is awaited, so a double-clicked "run now", a chat's and the app's together, or
   * one beside a scheduled fire still making its pre-check, fire it once.
   */
  const fireScheduleManually = (
    schedule: ScheduleRecord,
    trigger?: ScheduleWebhookFire | "watch" | { readonly email: ScheduleEmailFire },
  ): Promise<ScheduleFireNow> => {
    if (scheduleDependencies === undefined) return Promise.reject(new TaviError("UNAVAILABLE", "No workflow runs schedules here"));
    const claim = scheduleFires.claimSchedule(schedule.scheduleId, trigger === "watch");
    if (claim === undefined) return Promise.resolve({ outcome: { kind: "skipped", reason: "overlap" } });
    return fireScheduleNow(schedule, scheduleDependencies, claim, trigger);
  };
  // A call to a schedule's webhook, answered on the channels' ingress ahead of the channels: a run-now with what the
  // call carried quoted to the run, under the same in-flight guard.
  const scheduleWebhookIds = createScheduleWebhookIds(persistencePort.repositories.schedules);
  late.scheduleWebhookIds = scheduleWebhookIds;
  /** What both triggers, the webhook's and the email's, are given alike. */
  const triggerShared = {
    inFlight: scheduleFireInFlight,
    actsIn: (workspaceId: string, principalId: string) => access.actsIn(workspaceId, principalId),
    routineOwned: async (scheduleId: string) => (await routines.scheduleOwner(scheduleId)) !== undefined,
    now: () => clock.now(),
    log: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => logger[level](message, fields),
  };
  late.scheduleWebhooks = createScheduleWebhookHandler({
    schedules: persistencePort.repositories.schedules,
    webhookIds: scheduleWebhookIds,
    credentialKeyFile: credentialKeyFile(options.dataDirectory),
    guards: ingressGuards,
    fire: (schedule, webhook) => fireScheduleManually(schedule, webhook),
    ...triggerShared,
  });
  // An email on a connection a schedule's email trigger listens on, from a listed sender the channel authenticated:
  // a run-now in a reader session, with the email quoted to the run, under the same in-flight guard.
  late.scheduleEmailTriggers = createScheduleEmailTriggers({
    schedules: persistencePort.repositories.schedules,
    fire: (schedule, email) => fireScheduleManually(schedule, { email }),
    ...triggerShared,
  });
  /** The `--fs-root` rule a pre-check's file is held to, when a schedule is saved and before each check. */
  const precheckFile = (path: string): string => chatFolders.checkReadableFile(path);
  /** The rule a schedule's working folder is held to, when it is saved and at each fire: a chat's primary folder's. */
  const scheduleFolder = (path: string): string => chatFolders.checkPrimary(path);
  // File watchers' prompt checks: a change to a watched file fires its schedule's pre-check-gated run, under the same
  // in-flight guard. Started by `tavi serve` only (`scheduleWatchersEnabled`).
  const scheduleWatchers = createScheduleWatchers({
    schedules: persistencePort.repositories.schedules,
    checkFile: precheckFile,
    fire: (schedule) => fireScheduleManually(schedule, "watch"),
    alert: async (schedule, alert) => {
      if (scheduleDependencies !== undefined)
        await sendAlert(schedule, { identity: alert.identity, kind: "watch-backoff", text: alert.ref ?? alert.text }, scheduleDependencies);
    },
    actsIn: (workspaceId, principalId) => access.actsIn(workspaceId, principalId),
    // The timer's sync lists the schedules only after a schedule write settled here: an idle tick reads nothing,
    // and wakes the process on the due-work planner's timer, beside the owner's other periodic work.
    changes: scheduleWriteCount(store),
    syncTimer: duePlanner.after,
    now: () => Date.parse(clock.now()),
    log: (level, message, fields) => logger[level](message, fields),
  });
  /** The site profiles a pre-check's page or feed is held to when a schedule is saved, as each check is. */
  const precheckSite = (workspaceId: string, url: string): Promise<string | undefined> =>
    precheckSiteRefusal(sitePolicy, {
      workspaceId,
      taskId: `schedule-precheck-save:${clock.newId("precheck")}`,
      url,
      signal: new AbortController().signal,
    });
  // Schedules from a chat: the CLI's own writes, held to this workspace, never a routine's or one running now.
  registerScheduleTools(tools, {
    repositories: persistencePort.repositories,
    tools: () => tools.list(),
    now: () => new Date(clock.now()),
    routineOwner: (scheduleId) => routines.scheduleOwner(scheduleId),
    routineOwners: (scheduleIds) => routines.scheduleOwners(scheduleIds),
    fireInFlight: scheduleFireInFlight,
    precheckFile,
    precheckSite,
    runNow: fireScheduleManually,
    webhookIds: scheduleWebhookIds,
    workspaceTimezone: workspaceZone.zoneOf,
    workspaceTimezoneSync: workspaceZone.known,
    refreshWorkspaceTimezone: workspaceZone.refresh,
  });
  registerReminderTools(tools, {
    repositories: persistencePort.repositories,
    isLocalConnection: isLocalConnectionId,
    now: () => new Date(clock.now()),
    newId: () => clock.newId("reminder").replace(/^reminder-/, ""),
  });
  // To-dos share the reminders store, and where a due time is said.
  registerTodoTools(tools, {
    repositories: persistencePort.repositories,
    isLocalConnection: isLocalConnectionId,
    now: () => new Date(clock.now()),
    newId: () => clock.newId("todo").replace(/^todo-/, ""),
  });
  /**
   * Start the task a reminder's `prompt` asks for: origin `reminder`,
   * attended, no pre-approved tools, its approvals announced where the
   * reminder is said (the app's own path when it has no conversation).
   * Answered once the task is admitted; the turn runs on without the sweep.
   */
  const startReminderTask = async ({
    reminder,
    fire,
    replyTo,
  }: Parameters<NonNullable<Parameters<typeof createReminderDelivery>[0]["startTask"]>>[0]): Promise<string | undefined> => {
    if (workflow === undefined || reminder.prompt === undefined) return undefined;
    // An owner started with no model admits nothing until one resolves; the delivery says why (`modelReady`).
    if (!(await liveModelReady(reminder.workspaceId))) return undefined;
    // A reminder set in a local chat carries its words: its task runs on that chat's local model, or not at all.
    const origin = reminder.originTaskId;
    const originLocal = origin !== undefined && (await localChatModels.isLocal(reminder.workspaceId, origin));
    const localTarget = originLocal ? await localChatModels.localTargetOf(reminder.workspaceId, origin) : undefined;
    if (originLocal && localTarget === undefined) throw new TaviError("NOT_CONFIGURED", LOCAL_CHAIN_UNAVAILABLE);
    let admitted: (taskId: string) => void = () => {};
    const taskId = new Promise<string>((resolve) => {
      admitted = resolve;
    });
    const turn = workflow.admit({
      context: {
        workspaceId: reminder.workspaceId,
        principalId: reminder.principalId,
        runId: "pending-reminder-admission",
        caller: `reminder:${reminder.reminderId}`,
        ...(replyTo === undefined ? {} : { messagingReplyTo: replyTo }),
        // Made or changed under taint: the task starts with that label, as a
        // heartbeat *Do it* does — the once-only approval approved a call, not a standing instruction.
        // A personal one, though trusted, starts it personal too.
        ...(reminder.label === undefined || isTrustedPublic(reminder.label)
          ? {}
          : { inheritedLabel: reminder.label, ...(isUntrusted(reminder.label) ? { inheritedTaint: true as const } : {}) }),
      },
      kind: "start",
      executionPolicy: ATTENDED_TASK_POLICY,
      operationKey: reminderTaskOperationKey(reminder.reminderId, fire.fireAt),
      prompt: reminder.prompt,
      origin: "reminder",
      // A reminder's task is a run, never a chat.
      chatKind: "run",
      onAdmitted: async (task) => {
        // Saved before its first model call reads the run's route.
        if (localTarget !== undefined)
          await taskRouting.choose?.({ workspaceId: reminder.workspaceId, principalId: reminder.principalId }, task.taskId, localTarget);
        admitted(task.taskId);
      },
    });
    turn.catch((error: unknown) => logger.warn("a reminder's task failed", { reminderId: reminder.reminderId, error }));
    return Promise.race([taskId, turn.then((result) => result.taskId)]);
  };
  // Where a person's reminders may be said, shared by the delivery
  // below and the operator's `reminders` command.
  const reminderTargets = {
    repositories: persistencePort.repositories,
    operatorTargets: async (workspaceId: string, principalId: string) => {
      const payload: RoutinesPayload = { action: "targets", workspaceId, principalId };
      return operatorTargetsOf(await routineControl.execute(payload));
    },
    isLocalConnection: isLocalConnectionId,
  };
  late.reminderTargets = reminderTargets;
  // When the routine prunes last ran (ms): they reclaim old rows, which needs
  // no 30-second cadence.
  let prunedAt: number | undefined;
  // When the monthly budgets were last checked (ms): a sum over the month's calls needs no 30-second cadence.
  let budgetsCheckedAt: number | undefined;
  const noticeScheduledBudgets = scheduledBudgetNotices({
    repositories: persistencePort.repositories,
    workspaceIds: () => access.workspaceIds(),
    principalOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
    postAlert: (input) => chatNotices.postAlert(input),
    log: (message, fields) => logger.info(message, fields),
    warn: (message, fields) => logger.warn(message, fields),
  });
  const scheduleDependencies: ScheduleSchedulerDependencies | undefined =
    workflow === undefined
      ? undefined
      : {
          routineDispatch: async (schedule, fireTime, manual) => {
            if ((await routines.scheduleOwner(schedule.scheduleId)) === undefined) return undefined;
            if (manual) return { kind: "refused" as const, reason: "Use the routine run action" };
            const claimed = await routineRuns.claim(schedule, fireTime);
            // The run is started, not awaited: a routine's research, render and
            // delivery can take its whole deadline, and the sweep that fired it
            // must keep firing every other schedule meanwhile.
            wakeRoutines();
            return claimed === undefined
              ? { kind: "skipped" as const, reason: "already-claimed" as const }
              : {
                  kind: "routine" as const,
                  runId: claimed.runId,
                  status: (await routineRuns.get({ workspaceId: claimed.workspaceId, principalId: claimed.principalId }, claimed.runId))
                    .status,
                };
          },
          // Bookkeeping is awaited; evaluations, runs and deliveries are woken, not
          // awaited, so a long evaluation or run never holds up the schedules.
          routineSweep: async () => {
            await routineRuns.serviceHeartbeat();
            const nowMs = Date.parse(clock.now());
            if (prunedAt === undefined || nowMs - prunedAt >= ROUTINE_PRUNE_EVERY_MS) {
              prunedAt = nowMs;
              await routineRuns.pruneDueDetails();
              await routineRuns.pruneDueSnapshots();
              await routineNews.pruneEvidence(clock.now());
            }
            if (budgetsCheckedAt === undefined || nowMs - budgetsCheckedAt >= SCHEDULED_BUDGET_CHECK_EVERY_MS) {
              budgetsCheckedAt = nowMs;
              try {
                await noticeScheduledBudgets(clock.now());
              } catch (error) {
                logger.warn("scheduled work's monthly budget could not be checked", { error });
              }
            }
            await routineRuns.notifyPauses();
            wakeRoutines();
          },
          schedules: persistencePort.repositories.schedules,
          executions: persistencePort.repositories.executions,
          artifacts: persistencePort.repositories.artifacts,
          materializeArtifact,
          workflow,
          messaging,
          // So a fire can tell "the run completed" from "the brief arrived": a
          // clean run that never sent anything must not be recorded as a
          // success.
          effects: persistencePort.repositories.effects,
          // So a run that failed on provider weather, having done nothing, is tried again.
          providerFailure: (taskId) => providerFailures.take(taskId),
          // The pre-flight that keeps a full disk from also silencing the
          // alert about it (see `disk.ts`).
          freeBytes: () => freeBytesAt(options.dataDirectory),
          now: () => clock.now(),
          newId: (prefix) => clock.newId(prefix),
          // So `approve` can refuse a round a fire is still deciding.
          inFlight: scheduleFires,
          // A fire whose turn ended before a worker it spawned answered is woken to read it, so it is not over yet.
          workersOutstanding: async (taskId) => (await late.agentsService?.workersOutstanding(taskId)) === true,
          // A held run that will not go on frees its schedule.
          runEnded: async (taskId) => {
            const task = await persistencePort.repositories.tasks.get(taskId);
            if (task === undefined || task.status === "cancelled" || task.status === "failed" || task.status === "stopped") return true;
            return task.status === "completed" && (await late.agentsService?.workersOutstanding(taskId)) !== true;
          },
          // A run past its limit is cancelled with the workers it spawned, each wait it is suspended on
          // settled, as `agents.cancel` cancels a task.
          cancelRun: async (schedule, taskId, reason) => {
            const actor = { workspaceId: schedule.workspaceId, principalId: schedule.principalId, caller: `schedule:${schedule.name}` };
            const workers = await persistencePort.repositories.agentDelegations.listRunningInTree(schedule.workspaceId, taskId, 200);
            // Each cancelled on its own: one that cannot be still leaves the rest stopped.
            for (const id of [taskId, ...workers.map((worker) => worker.workerTaskId)]) {
              try {
                if (late.agentsService !== undefined) await late.agentsService.cancel({ actor, taskId: id, reason });
                else await persistencePort.cancelTask({ taskId: id, reason, operator: actor.caller, now: { execution: true } });
              } catch (error) {
                logger.warn("could not cancel a timed-out run's task", { scheduleId: schedule.scheduleId, taskId: id, error });
              }
            }
          },
          // A schedule's pre-check: a page or feed read as a heartbeat's watched page is, from its own host only and
          // where its site profile allows an unattended read; a file only under an --fs-root.
          precheck: createSchedulePrecheck({
            fetchPage: heartbeatFetchPage,
            checkFile: precheckFile,
            sites: sitePolicy,
            now: () => clock.now(),
          }),
          // A schedule that pins a folder works there, checked again at each fire, as a routine's pinned folder is:
          // made the run's task's primary before its first turn; a retried fire's task already there is left so.
          folders: {
            check: scheduleFolder,
            begin: async (schedule, taskId, path) => {
              const scope = { workspaceId: schedule.workspaceId, principalId: schedule.principalId };
              try {
                await chatFolders.begin(scope, taskId, path, { frontEnd: "local" });
              } catch (error) {
                if (TaviError.from(error).code !== "CONFLICT" || (await chatFolders.resolve(scope, taskId)).primary !== path) throw error;
              }
            },
          },
          // A schedule delivered to Home posts its run's result there.
          deliverHome: async (schedule, admission) => {
            await startHome(schedule);
            return await chatNotices.deliverSchedule(schedule, admission);
          },
          // An alert with no target to send it to is posted to Home, once per cause.
          alertHome: async (schedule, alert) => {
            await startHome(schedule);
            return await chatNotices.postAlert({
              workspaceId: schedule.workspaceId,
              principalId: schedule.principalId,
              sourceKey: alert.sourceKey,
              ...noticeWordsOf({
                title: textRef("notice.schedule.alert.title", { name: schedule.name }),
                summary: alert.ref ?? alert.text,
              }),
            });
          },
          // An alert to a chat app is said in its workspace's language.
          channelWords: async (workspaceId) =>
            await channelWords(workspaceLocaleOf(persistencePort.repositories.workspaceSettings), workspaceId, (message, fields) =>
              logger.warn(message, fields),
            ),
          log: (event) => logger[event.level](event.message, event.detail === undefined ? {} : { detail: event.detail }),
        };
  late.scheduleDependencies = scheduleDependencies;
  return {
    reminderTargets,
    scheduleDependencies,
    startReminderTask,
    scheduleFireInFlight,
    fireScheduleManually,
    precheckFile,
    precheckSite,
    scheduleFolder,
    scheduleWatchers,
  };
}

export type SchedulesContext = RoutinesContext & ReturnType<typeof composeSchedules>;
