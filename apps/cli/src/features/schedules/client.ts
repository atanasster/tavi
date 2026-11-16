import { emitError, emitJson, emit } from "../../cli/output.js";
import { EXIT, reportCommandFailure, reportFailure } from "../../cli/exit.js";
import { routineScheduleAction } from "../routines/actions.js";
import { RoutineService } from "@tavi/runtime";
import {
  TaviError,
  formatReminderTime,
  scheduleMaxRunMinutes,
  tokenCountText,
  scheduleNotifyText,
  schedulePausedText,
  schedulePrecheckSentence,
  scheduleWatchSentence,
  scheduleFinished,
  SCHEDULE_FINISHED_TEXT,
  SCHEDULE_EVENT_MAX_TOKENS,
  scheduleWebhookPath,
  type ScheduleRecord,
  type ScheduleShowResult,
  type ScheduleSpec,
  type ScheduleWebhookAnswer,
  type ScheduleEmailTriggerAnswer,
  scheduleEmailTriggerSentence,
  type AgendaAnswer,
} from "@tavi/contracts";
import type { TaviRuntime } from "../../runtime/types.js";
import { runScheduleNow, type FireOutcome } from "@tavi/agent-host/schedule-scheduler";
import {
  agendaNotes,
  agendaText,
  fireLines,
  fireTimeText,
  resolveSchedule,
  scheduleAgenda,
  scheduleShow,
  setScheduleEnabled,
  writeSchedule,
} from "./actions.js";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { attachToRunningTask } from "../run/attached.js";
import { fireFinalText } from "../run/client-events.js";
import { maxTokensWarning, type SchedulesCommandOptions, SCHEDULES_USAGE } from "./parse.js";
import { cadenceReadBack } from "./tools.js";
import { credentialKeyFile } from "../credentials/store.js";
import { scheduleWebhookText, setScheduleWebhook } from "./webhook.js";
import { scheduleEmailTriggerText, setScheduleEmailTrigger } from "./email-trigger.js";
import type { CliIo } from "../../cli/io.js";
import { configOnOwner, expectTargetOf } from "../../cli/owner.js";
import { resolveModelTargetOrReport } from "../../cli/run-target.js";
import { runtimeOptionsForTarget } from "../../cli/runtime-options.js";
import { type ResolvedDataDirectory, withStorePreservingOwnership } from "../../cli/store.js";

/** Same field mapping for attached and offline schedule writes. */
function schedulePayload(options: SchedulesCommandOptions, now = new Date()): import("@tavi/contracts").SchedulesPayload {
  return {
    action: options.action === "run-now" ? "run" : options.action,
    workspaceId: options.workspaceId,
    principalId: options.principalId,
    // `agenda --days N`: the window from now; the owner reads a `from` in its past as its own now.
    ...(options.agendaDays === undefined
      ? {}
      : { from: now.toISOString(), until: new Date(now.getTime() + options.agendaDays * 86_400_000).toISOString() }),
    ...definedOnly({
      limit: options.agendaLimit,
      scheduleId: options.scheduleRef,
      name: options.name,
      prompt: options.prompt,
      at: options.at,
      everyHours: options.everyHours,
      between: options.between,
      monthly: options.monthly,
      yearly: options.yearly,
      once: options.once,
      untilDate: options.until,
      timezone: options.timezone,
    }),
    ...(options.times === undefined ? {} : { times: [...options.times] }),
    ...(options.days === undefined ? {} : { days: options.days === null ? null : [...options.days] }),
    ...(options.missed === undefined ? {} : { missed: options.missed }),
    ...(options.allow === undefined ? {} : { allow: [...options.allow] }),
    ...definedOnly({
      agentId: options.agentId,
      alertConnection: options.alertConnection,
      alertDestination: options.alertDestination,
      humanCheckpoints: options.humanCheckpoints,
      deliverTo: options.deliverTo,
      maxRunMinutes: options.maxRunMinutes,
      maxTokens: options.maxTokens,
      folder: options.folder,
      notify: options.notify,
    }),
    ...definedOnly({ precheck: options.precheck, watch: options.watch, webhook: options.webhook, emailTrigger: options.emailTrigger }),
  };
}

/** `tavi schedules <action>` on a live owner; writes share validation, and `run-now` fires on the owner's own scheduler. */
async function schedulesOnOwner(options: ResolvedDataDirectory<SchedulesCommandOptions>, io: CliIo): Promise<number | undefined> {
  const running = options.action === "run-now";
  return configOnOwner(options.dataDirectory, "schedules", io, {
    label: `tavi schedules ${options.action}`,
    mutates: options.action !== "list" && options.action !== "show" && options.action !== "agenda",
    // A mistyped id, and — for a fire — an owner with no model to run it on:
    // the offline command's usage errors. A removal refused while the schedule
    // fires is "not now" (4), not a mistake.
    codes: { NOT_FOUND: EXIT.usage, NOT_CONFIGURED: EXIT.usage, CONFLICT: options.action === "add" ? EXIT.usage : EXIT.unavailable },
    follows: running ? ["subscribe", "tasks", "approvals", "approve"] : [],
    build: () => {
      if (options.action !== "list" && options.action !== "add" && options.action !== "agenda" && options.scheduleRef === undefined) {
        io.stderr(`schedules ${options.action} needs a schedule id or name\n`);
        return EXIT.usage;
      }
      if (running && options.apiKeyFile !== undefined) {
        io.stderr(
          `An owner is serving ${options.dataDirectory}, and it fires a schedule with its own credentials, so --api-key-file ` +
            "cannot apply. Omit it, or stop `tavi serve` to run the schedule with it.\n",
        );
        return EXIT.usage;
      }
      return {
        ...schedulePayload(options),
        action: running ? "run" : options.action,
        workspaceId: options.workspaceId,
        ...(options.scheduleRef === undefined ? {} : { scheduleId: options.scheduleRef }),
        // An assertion of the owner's default as it resolves now: the owner refuses another target.
        ...(running ? expectTargetOf(options) : {}),
      };
    },
    render: async (result, client) => {
      if (result !== null && typeof result === "object" && "routine" in result) {
        emitJson(io, result);
        return EXIT.ok;
      }
      switch (options.action) {
        case "list": {
          const listed = result as { readonly schedules: readonly Omit<ScheduleRecord, "prompt">[]; readonly truncated: boolean };
          if (options.format === "json") emitJson(io, listed.schedules);
          else for (const schedule of listed.schedules) io.stdout(scheduleLine(schedule));
          if (listed.truncated) io.stderr(`note: the owner lists the first ${listed.schedules.length} schedules\n`);
          return EXIT.ok;
        }
        case "agenda": {
          const agenda = result as AgendaAnswer;
          // A plain schedule's own cadence, from the owner's list; without it each row says its occurrence's.
          let specs = new Map<string, ScheduleSpec>();
          if (options.format === "text" && agenda.items.some((item) => item.kind === "schedule")) {
            const listed = await client.request(
              "schedules",
              { action: "list", workspaceId: options.workspaceId, principalId: options.principalId },
              prefixedId("schedules-agenda-specs"),
            );
            if (listed.ok)
              specs = scheduleSpecs((listed.result as { readonly schedules: readonly Omit<ScheduleRecord, "prompt">[] }).schedules);
          }
          emit(io, options.format, agenda, (answer) => agendaText(answer, specs));
          io.stderr(agendaNotes(agenda));
          return EXIT.ok;
        }
        case "show":
          emit(io, options.format, result as ScheduleShowResult, scheduleShowText);
          return EXIT.ok;
        case "remove":
          emit(io, options.format, result as { readonly removed: string }, scheduleRemovedText);
          return EXIT.ok;
        case "webhook":
          emit(io, options.format, result as ScheduleWebhookAnswer, scheduleWebhookText);
          return EXIT.ok;
        case "email-trigger":
          emit(io, options.format, result as ScheduleEmailTriggerAnswer, scheduleEmailTriggerText);
          return EXIT.ok;
        case "run-now": {
          const fired = result as { readonly taskId?: string; readonly outcome?: FireOutcome };
          // Admitted: followed to its end, as `tavi run --attach` follows it.
          // The fire answers its own rounds, so they are only rendered.
          if (fired.taskId !== undefined) {
            io.stderr(`Fired as task ${fired.taskId}; following it (Ctrl-C detaches, the fire continues).\n`);
            return attachToRunningTask(client, fired.taskId, {
              format: options.format,
              approval: "ask",
              workspaceId: options.workspaceId,
              principalId: options.principalId,
              exit: EXIT,
              io,
              quietMarker: true,
            });
          }
          const outcome = fired.outcome;
          if (options.format === "json") emitJson(io, outcome ?? null);
          else if (outcome?.kind === "ran") {
            io.stdout(`${outcome.status}: ${fireFinalText(outcome.finalText)}\n`);
            if (outcome.notPosted !== undefined) io.stderr(`Not posted to Home: ${outcome.notPosted}.\n`);
          } else if (outcome?.kind === "routine") io.stdout(`Routine run ${outcome.runId}: ${outcome.status}\n`);
          else io.stderr(`not run: ${outcome?.reason ?? "the owner ran nothing"}\n`);
          return outcome?.kind === "ran" && outcome.status === "completed" ? EXIT.ok : EXIT.taskFailed;
        }
        case "add":
        case "update":
          // As the offline write prints it: its cadence, then the same notes.
          emit(io, options.format, result as ScheduleRecord, scheduleWrittenLine);
          io.stderr(scheduleWriteNotes(result as ScheduleRecord));
          io.stderr(maxTokensWarning(options.maxTokens));
          return EXIT.ok;
        default:
          emit(io, options.format, result as ScheduleRecord, scheduleStateLine);
          return EXIT.ok;
      }
    },
  });
}

/**
 * `tavi schedules <action>`.
 *
 * Reads and writes are plain store operations — the same `withStore`/
 * `withStorePreservingOwnership` pair `tavi credentials` uses, so an operator
 * can inspect the schedule table while `serve` owns the directory. `run-now` is
 * the exception: it admits a real run, so it composes a full runtime exactly
 * like `tavi run` and `tavi artifacts --resume` do.
 */
export async function schedulesCommand(options: ResolvedDataDirectory<SchedulesCommandOptions>, io: CliIo): Promise<number> {
  const onOwner = await schedulesOnOwner(options, io);
  if (onOwner !== undefined) return onOwner;
  try {
    // `run-now` admits a real run, which means composing a full runtime — and
    // composing acquires the data directory for itself. Handling it inside the
    // short-lived store block below would have it collide with its own
    // ownership and fail with `alreadyOwned` (exit 5) without ever running.
    // Mirrors `tavi artifacts --resume`, which is routed out of its store path
    // for the same reason.
    if (options.action === "run-now") return await runScheduleNowCommand(options, io);

    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      if (options.action === "agenda") {
        const agenda = await scheduleAgenda(store.asPort().repositories, schedulePayload(options), new Date());
        const specs =
          options.format === "text" ? scheduleSpecs(await schedules.list(options.workspaceId)) : new Map<string, ScheduleSpec>();
        emit(io, options.format, agenda, (answer) => agendaText(answer, specs));
        io.stderr(agendaNotes(agenda));
        return EXIT.ok;
      }
      if (options.action !== "add" && options.action !== "list" && options.action !== "show") {
        const ownedSchedule = await resolveSchedule(schedules, options.workspaceId, options.scheduleRef);
        // Deliberately no `authorizeTarget`: this path has no telegram or
        // messaging configuration to read, and the routine service's contract is
        // that a missing authorizer is never allow-all. That is enough to edit an
        // existing routine — its pinned destinations are *retained*, not
        // re-authorized — and never enough to introduce one, and its readiness
        // report says `unverifiable` rather than a false "unauthorized".
        //
        // `executionAvailable: true` is this command declaring that arming a
        // routine is not the same as executing it: the owner is the executor and
        // re-checks readiness at dispatch, so offline `schedules enable` on a
        // routine-owned schedule resumes the routine instead of failing.
        const routines = new RoutineService(store);
        if (ownedSchedule !== undefined && (await routines.scheduleOwner(ownedSchedule.scheduleId)) !== undefined) {
          emitJson(io, await routineScheduleAction(routines, ownedSchedule, schedulePayload(options)));
          return EXIT.ok;
        }
      }

      if (options.action === "list") {
        const all = await schedules.list(options.workspaceId);
        if (options.format === "json") {
          emitJson(io, all);
          return EXIT.ok;
        }
        for (const schedule of all) io.stdout(scheduleLine(schedule));
        return EXIT.ok;
      }

      if (options.action === "add" || options.action === "update") {
        const created = await writeSchedule(store.asPort().repositories, schedulePayload(options), new Date());
        emit(io, options.format, created, scheduleWrittenLine);
        io.stderr(scheduleWriteNotes(created));
        io.stderr(maxTokensWarning(options.maxTokens));
        return EXIT.ok;
      }

      const schedule = await resolveSchedule(schedules, options.workspaceId, options.scheduleRef);
      if (schedule === undefined) {
        io.stderr(`no schedule ${JSON.stringify(options.scheduleRef)} exists in ${options.dataDirectory}\n`);
        // An unknown schedule is a caller mistake, not a runtime condition.
        return EXIT.usage;
      }

      if (options.action === "show") {
        emit(io, options.format, await scheduleShow(store.asPort().repositories, schedule), scheduleShowText);
        return EXIT.ok;
      }

      if (options.action === "webhook" && options.webhook !== undefined) {
        // Saved here; the listener opens for it at the next `tavi serve`.
        emit(
          io,
          options.format,
          await setScheduleWebhook(
            store.asPort().repositories,
            schedule,
            options.webhook,
            new Date(),
            credentialKeyFile(options.dataDirectory),
          ),
          scheduleWebhookText,
        );
        return EXIT.ok;
      }

      if (options.action === "email-trigger" && options.emailTrigger !== undefined) {
        // Saved here; it listens from the next `tavi serve`.
        emit(
          io,
          options.format,
          await setScheduleEmailTrigger(store.asPort().repositories, schedule, options.emailTrigger, new Date()),
          scheduleEmailTriggerText,
        );
        return EXIT.ok;
      }

      if (options.action === "remove") {
        await schedules.remove(schedule.scheduleId);
        emit(io, options.format, { removed: schedule.scheduleId }, scheduleRemovedText);
        return EXIT.ok;
      }

      if (options.action === "enable" || options.action === "disable") {
        // (text rendering below reports the id, the new state and the next fire:
        // a mutating command that prints an empty line leaves the operator
        // unable to tell whether it did anything, let alone when it will run)
        const updated = await setScheduleEnabled(schedules, schedule, options.action === "enable", new Date());
        emit(io, options.format, updated, scheduleStateLine);
        return EXIT.ok;
      }

      io.stderr(`schedules ${options.action} is not implemented\n`);
      return EXIT.usage;
    });
  } catch (error) {
    if (TaviError.from(error).code === "NOT_FOUND") {
      io.stderr(`${errorMessage(error)}\n`);
      return EXIT.usage;
    }
    return reportCommandFailure(error, io, "schedules command failed");
  }
}

/**
 * `tavi schedules show`'s text. The effective policy is spelled out rather than
 * left implicit in the stored allowlist, so that an operator
 * can see what an unattended run is permitted to do without reading the schema.
 */
function scheduleShowText(policy: ScheduleShowResult): string {
  return [
    `schedule ${policy.scheduleId} (${policy.name})`,
    `  fires       ${cadenceReadBack(policy.spec)}`,
    `  state       ${policy.enabled ? "enabled" : scheduleFinished(policy.spec, new Date()) ? SCHEDULE_FINISHED_TEXT : policy.pausedReason === undefined ? "disabled" : schedulePausedText(policy)}`,
    `  next fire   ${nextRunText(policy)}`,
    // `lastOutcome` is `null` for a schedule that has never run, not
    // `undefined` — testing only for `undefined` printed "never (null)".
    `  last run    ${policy.lastRunAt === null ? "never" : fireTimeText(policy.lastRunAt, policy.timezone)}${policy.lastOutcome === null ? "" : ` (${lastOutcomeText(policy.lastOutcome, policy.timezone)})`}`,
    `  failures    ${policy.consecutiveFailures} consecutive`,
    `  prompt      ${policy.prompt}`,
    `  missed      ${policy.missedRunPolicy}`,
    `  runs as     ${policy.agentId ?? "(the base instructions)"}`,
    `  alert       ${policy.alert === undefined ? "none" : `${policy.alert.connectionId} -> ${policy.alert.destination}`}`,
    `  questions   ${policy.humanCheckpoints === "ask-with-default" ? "may ask in the alert destination, with a default taken if nobody answers before the next fire" : "never asks"}`,
    `  delivers    ${policy.deliverTo === "home" ? "its result into Home, as a notice" : "only what the run sends itself"}`,
    `  notifies    ${scheduleNotifyText(policy.notify)}; failures always`,
    `  run limit   ${scheduleMaxRunMinutes(policy)} minutes of work${policy.maxRunMinutes === undefined ? " (the default)" : ""}, then stopped`,
    `  tokens      ${policy.maxTokens === undefined ? `no ceiling${policy.webhook === undefined && policy.emailTrigger === undefined ? "" : `; ${tokenCountText(SCHEDULE_EVENT_MAX_TOKENS)} for a run a webhook or email starts`}` : `${tokenCountText(policy.maxTokens)} a run, its workers included, then stopped`}`,
    `  folder      ${policy.folder === undefined ? "each run's own" : policy.folder}`,
    `  pre-check   ${schedulePrecheckSentence(policy.precheck)}${policy.precheckState === undefined ? "" : ` (last read ${fireTimeText(policy.precheckState.checkedAt, policy.timezone)})`}`,
    ...(policy.watch === true ? [`  watcher     ${scheduleWatchSentence(policy) ?? ""}`] : []),
    `  email       ${scheduleEmailTriggerSentence(policy.emailTrigger)}`,
    `  webhook     ${policy.webhook === undefined ? "off" : `on at ${policy.webhookUrl ?? scheduleWebhookPath(policy.scheduleId)} (secret made ${fireTimeText(policy.webhook.since, policy.timezone)})`}`,
    "  may call unattended:",
    ...(policy.autoApproveTools.length === 0
      ? ["    (nothing — every gated tool call is denied)"]
      : policy.autoApproveTools.map((pattern) => `    ${pattern}`)),
    `  recent fires (${policy.timezone}):`,
    ...(policy.recentFires.length === 0 ? ["    (none recorded)"] : fireLines(policy.recentFires, policy.timezone, "    ")),
  ].join("\n");
}

/** A stored outcome as the terminal says it: the scheduler's mark for a fire being handed to its run is never a result. */
function lastOutcomeText(outcome: string, timezone: string): string {
  const due = /^dispatching the (\S+) fire$/.exec(outcome)?.[1];
  return due === undefined ? outcome : `running (fire due ${fireTimeText(due, timezone)})`;
}

/**
 * A schedule's next run in its own zone, as its read-back says it ("Wed 28 Oct
 * 07:00"): "-" when it is paused or not armed.
 */
function nextRunText(schedule: Pick<ScheduleRecord, "enabled" | "nextRunAt" | "spec">): string {
  return schedule.enabled && schedule.nextRunAt !== null ? formatReminderTime(new Date(schedule.nextRunAt), schedule.spec.timezone) : "-";
}

/**
 * `tavi schedules list`'s text line for one schedule; the attached list gives
 * each without its prompt. Its cadence and next run are in its zone, as the
 * schedule's read-back says them, with how many fires in a row have failed.
 */
function scheduleLine(schedule: Omit<ScheduleRecord, "prompt">): string {
  return (
    `${schedule.scheduleId}\t${schedule.name}\t${whenText(schedule)}\t` +
    `${schedule.enabled ? "enabled" : scheduleFinished(schedule.spec, new Date()) ? "finished" : schedule.pausedReason === undefined ? "disabled" : `paused:${schedule.pausedReason}`}\tnext=${nextRunText(schedule)}\tfailures=${schedule.consecutiveFailures}\t` +
    `last=${schedule.lastOutcome === null ? "never" : lastOutcomeText(schedule.lastOutcome, schedule.spec.timezone)}\n`
  );
}

/** When a schedule runs, as `list` and `add` say it: a watcher by what it watches, any other by its cadence. */
function whenText(schedule: Pick<ScheduleRecord, "spec" | "precheck" | "watch">): string {
  return (schedule.watch === true ? scheduleWatchSentence(schedule) : undefined) ?? cadenceReadBack(schedule.spec);
}

/** `tavi schedules add|update|watch`'s text (`emit` ends the line): the id, when it runs, its state and its next run. */
function scheduleWrittenLine(value: ScheduleRecord): string {
  return `${value.scheduleId}\t${value.name}\t${whenText(value)}\t${value.enabled ? "enabled" : "disabled"}\tnext=${nextRunText(value)}`;
}

/** Each schedule's spec by its id: what the agenda says a plain schedule's cadence with. */
function scheduleSpecs(schedules: readonly Pick<ScheduleRecord, "scheduleId" | "spec">[]): Map<string, ScheduleSpec> {
  return new Map(schedules.map((schedule) => [schedule.scheduleId, schedule.spec]));
}

/** The notes `schedules add|update` print on stderr, offline or on an owner, after the schedule. */
function scheduleWriteNotes(created: Pick<ScheduleRecord, "name" | "alert" | "autoApproveTools">): string {
  // The allowlist is a tool-name list, not a capability boundary: a
  // `read-only` tool never raises an approval, so it runs whatever this says.
  // Saying so at creation is the only place the operator
  // can still change their mind; a schedule with no allowlist has nothing to say it of.
  const allowlist =
    created.autoApproveTools.length === 0
      ? ""
      : "note: this allowlist governs only the calls that would otherwise need approval. Read-only tools run " +
        "whatever it says, and `sandbox.run` is granted by naming it (or by `--allow '*'`, which is refused " +
        "precisely because it is easy to type without meaning it).\n";
  // With no alert target a failed, missed or refused fire is told in its
  // person's Home instead (AUTOMATION.md), and only logged while Home is off.
  // `schedules show` prints "alert none" only if someone thinks to look.
  return created.alert !== undefined
    ? allowlist
    : `${allowlist}note: ${created.name} has no alert target, so a failed or missed run is posted to your Home as a notice ` +
        "(only logged while Home is off). Add --alert-connection <id> --alert-destination <chat-id> to be told in a chat instead.\n";
}

/** `tavi schedules enable|disable`'s text (`emit` ends the line): the id, the new state and the next run in its zone. */
function scheduleStateLine(value: ScheduleRecord): string {
  return `${value.scheduleId}\t${value.name}\t${value.enabled ? "enabled" : "disabled"}\tnext=${nextRunText(value)}`;
}

/** `tavi schedules remove`'s text. */
function scheduleRemovedText(value: { readonly removed: string }): string {
  return `removed ${value.removed}`;
}

/**
 * `tavi schedules run-now` — admit one run immediately.
 *
 * Deliberately a full runtime composition with `requireModelTransport: true`:
 * this is the operator's way to prove the brief works *before* trusting it to
 * 07:00, which is the entire point of having it. It runs on the same policy the
 * scheduled fire would use, so what it proves is what will happen unattended.
 */
async function runScheduleNowCommand(options: ResolvedDataDirectory<SchedulesCommandOptions>, io: CliIo): Promise<number> {
  const ref = options.scheduleRef;
  if (ref === undefined) {
    io.stderr("schedules run-now needs a schedule id or name\n");
    return EXIT.usage;
  }
  const target = await resolveModelTargetOrReport(
    {
      // The target resolution path never reads `prompt`; the schedule's own
      // prompt is what `runScheduleNow` admits, and it is read from the
      // composed runtime below.
      prompt: "",
      format: options.format,
      workspaceId: options.workspaceId,
      principalId: options.principalId,
      ...definedOnly({
        connectionId: options.connectionId,
        model: options.model,
        apiKeyFile: options.apiKeyFile,
      }),
      dataDirectory: options.dataDirectory,
      // A manual run is the operator acting now; the per-call decisions still
      // come from the schedule's own tool policy below, so this only means the
      // foreground loop is not the thing prompting.
      approval: "approve",
      quiet: false,
      inMemory: false,
    },
    io,
    // A missing model target is a `schedules run-now` mistake, so the usage it
    // prints must be this command's own rather than `tavi run`'s.
    { usage: SCHEDULES_USAGE },
  );
  if (typeof target === "number") return target;

  let runtime: TaviRuntime;
  try {
    // Loaded here, not at the top: every other command this module serves stays off the owner runtime.
    const { composeTaviRuntime } = await import("../../runtime/composition.js");
    runtime = await composeTaviRuntime(
      // `scheduleSweepEnabled: false` is a composition-level override rather
      // than a CLI flag: it exists only so this command's own runtime does not
      // start a scheduler, and an operator has no reason to want that on `run`.
      // The stored connection's endpoint and credential, and the fallback, as
      // `run` composes them: without them a configured target would run
      // against `TAVI_BASE_URL` or the OpenAI default.
      { ...runtimeOptionsForTarget(target), scheduleSweepEnabled: false },
      { requireModelTransport: true },
    );
  } catch (error) {
    return reportFailure(error, io, "runtime composition failed");
  }

  try {
    const workflow = runtime.workflow;
    if (workflow === undefined || !runtime.host.admissionOpen) {
      io.stderr("Runtime admission is closed: the workflow service is unavailable\n");
      return EXIT.unavailable;
    }
    // Resolved from the composed runtime's own store, after that runtime took
    // the directory — resolving it earlier would have meant opening the store
    // twice.
    const schedules = runtime.store.asPort().repositories.schedules;
    const schedule = await resolveSchedule(schedules, options.workspaceId, ref);
    if (schedule === undefined) {
      io.stderr(`no schedule ${JSON.stringify(ref)} exists in ${options.dataDirectory}\n`);
      return EXIT.usage;
    }
    if ((await runtime.routines.scheduleOwner(schedule.scheduleId)) !== undefined) {
      io.stderr("Use the routine run action to preserve its snapshot and policies\n");
      return EXIT.usage;
    }
    const scheduling = runtime.scheduleDependencies;
    if (scheduling === undefined) {
      io.stderr("Runtime admission is closed: the workflow service is unavailable\n");
      return EXIT.unavailable;
    }
    // The owner's own scheduler dependencies — the same the sweep fires on, so
    // `run-now` is the pre-flight proof of what will happen unattended (the
    // delivery check and the disk pre-flight included) — logged to the terminal.
    const result = await runScheduleNow(schedule, {
      ...scheduling,
      log: (event) => {
        if (event.level === "info") emitError(io, event.message);
        else io.stderr(`${event.level}: ${event.message}\n`);
      },
    });
    if (options.format === "json") {
      emitJson(io, result);
    } else if (result.kind === "ran") {
      io.stdout(`${result.status}: ${fireFinalText(result.finalText)}\n`);
      if (result.notPosted !== undefined) io.stderr(`Not posted to Home: ${result.notPosted}.\n`);
    } else if (result.kind === "routine") {
      io.stdout(`Routine run ${result.runId}: ${result.status}\n`);
    } else {
      io.stderr(`not run: ${result.reason}\n`);
    }
    return result.kind === "ran" && result.status === "completed" ? EXIT.ok : EXIT.taskFailed;
  } finally {
    await runtime.close();
  }
}
