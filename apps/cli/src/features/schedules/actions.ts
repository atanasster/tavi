import { alignedColumns } from "../../shared/terminal-text.js";
import { scheduleWebhookUrl } from "./webhook.js";
import {
  DEFAULT_WORKSPACE_ID,
  TaviError,
  hostTimeZone,
  isValidTimeZone,
  resolveAgendaWindow,
  type AgendaAnswer,
  SchedulesPayloadSchema,
  ScheduleSpecSchema,
  MissedRunPolicySchema,
  MISSED_RUN_POLICIES,
  ScheduleToolPatternSchema,
  STALE_WEB_PATTERN_MESSAGE,
  isStaleWebPattern,
  schedulingPatternRefusal,
  type ScheduleHistoryResult,
  type ScheduleRecord,
  type ScheduleRepositoryPort,
  type ScheduleShowResult,
  type SchedulesPayload,
  SCHEDULE_SHOW_FIRES,
  SCHEDULE_PREVIEW_MAX_RUNS,
  SCHEDULE_PREVIEW_RUNS,
  type SchedulePreviewResult,
  type ScheduleToolsResult,
  type PersistencePort,
  type ToolDefinition,
  type ScheduleSpec,
  nextOccurrence,
  parseSchedulePrecheck,
  type SchedulePrecheck,
  describeReminderOffset,
  formatReminderTime,
  parseReminderOffset,
  scheduleFinished,
  scheduleSpecText,
  scheduledMonthWindow,
  scheduledWorkUsage,
  type ScheduledWorkUsage,
  type WorkspaceSettings,
  keyedError,
} from "@tavi/contracts";
import { csvList, definedOnly } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import {
  runScheduleNow,
  type FireOutcome,
  type ScheduleSchedulerDependencies,
  type ScheduleEmailFire,
  type ScheduleWebhookFire,
} from "@tavi/agent-host/schedule-scheduler";

/**
 * The `tavi schedules` actions shared by the offline command and the owner's
 * IPC handler, so an attached caller cannot receive a
 * different answer than an unattached one — the schedule counterpart of
 * `features/models/actions.ts`.
 */

/**
 * A schedule by id, or by its name, within one workspace — as `tavi schedules`
 * accepts either. An id naming another workspace's schedule is not found: the
 * workspace is the scope, whichever way the schedule is named.
 */
export async function resolveSchedule(
  schedules: ScheduleRepositoryPort,
  workspaceId: string,
  ref: string | undefined,
): Promise<ScheduleRecord | undefined> {
  if (ref === undefined) return undefined;
  const byId = await schedules.get(ref);
  if (byId !== undefined && byId.workspaceId === workspaceId) return byId;
  return (await schedules.list(workspaceId)).find((candidate) => candidate.name === ref);
}

/**
 * Enable or disable a schedule.
 *
 * Re-armed from *now* on enable, so a schedule disabled for a month does not
 * wake up owing a month of catch-up runs; cleared on disable, so "next fire"
 * cannot show a time that will not happen. A schedule that has finished (its
 * `once` date or `until` is past) is not enabled: it has no time to arm, until
 * a change of its dates gives it one (`writeSchedule`), which enables it.
 */
export async function setScheduleEnabled(
  schedules: ScheduleRepositoryPort,
  schedule: ScheduleRecord,
  enabled: boolean,
  at: Date,
): Promise<ScheduleRecord> {
  const next = enabled ? nextOccurrence(schedule.spec, at) : undefined;
  if (enabled && next === undefined)
    throw keyedError("INVALID_INPUT", "error.schedule.finished", { name: schedule.name, spec: scheduleSpecText(schedule.spec) });
  await schedules.setEnabled({
    scheduleId: schedule.scheduleId,
    enabled,
    nextRunAt: next?.toISOString() ?? null,
    now: at.toISOString(),
  });
  return (await schedules.get(schedule.scheduleId)) ?? schedule;
}

/**
 * Why a schedule may not list `pattern`: an MCP tool is listed by its exact id, and only when its approved
 * effect is read-only — never through a wildcard, which would cover the
 * server's writes and any tool it adds later.
 */
async function mcpPatternRefusal(mcp: PersistencePort["repositories"]["mcp"], pattern: string): Promise<string | undefined> {
  if (pattern !== "mcp" && !pattern.startsWith("mcp.")) return undefined;
  if (pattern.includes("*"))
    return `--allow ${JSON.stringify(pattern)} is refused: name each read-only MCP tool a schedule may use (\`tavi mcp show <id>\`)`;
  const pluginId = pattern.split(".").slice(0, 2).join(".");
  const tool = (await mcp.listTools(pluginId)).find((candidate) => candidate.toolId === pattern && candidate.state === "approved");
  if (tool === undefined) return `--allow ${JSON.stringify(pattern)} is not an approved MCP tool`;
  if (tool.decision?.effect !== "read-only")
    return `--allow ${JSON.stringify(pattern)} is refused: a schedule may list only read-only MCP tools, and it is ${tool.decision?.effect ?? "undecided"}`;
  return undefined;
}

/** The form-fill tools: a person approves each fill on its own card, so no schedule may list them. */
const FORM_FILL_TOOLS: ReadonlySet<string> = new Set(["pdf.fill", "pdf.overlay"]);

/** Whether `writeSchedule` takes `pattern` in a list without asking the MCP store: an MCP id is checked there. */
function listableWithoutMcp(pattern: string): boolean {
  return (
    pattern !== "*" &&
    ScheduleToolPatternSchema.safeParse(pattern).success &&
    !FORM_FILL_TOOLS.has(pattern) &&
    schedulingPatternRefusal(pattern) === undefined
  );
}

/**
 * `schedules tools`: what the schedule form offers as it is typed — the
 * registered tools a schedule may list by id, and the `prefix.*` families
 * whose every registered tool is read-only, leaving out what `writeSchedule`
 * would refuse, and which of those tools are read-only. An MCP tool is offered
 * only once approved read-only, and never as a family. Nothing is written.
 */
export async function scheduleTools(
  repositories: Pick<PersistencePort["repositories"], "mcp">,
  registered: readonly Pick<ToolDefinition, "id" | "effect">[],
): Promise<ScheduleToolsResult> {
  const tools = new Set<string>();
  const families = new Set<string>();
  const readOnlyTools = new Set<string>();
  const mcpByPlugin = new Map<string, string[]>();
  for (const { id, effect } of registered) {
    if (!listableWithoutMcp(id)) continue;
    if (id === "mcp" || id.startsWith("mcp.")) {
      const pluginId = id.split(".").slice(0, 2).join(".");
      mcpByPlugin.set(pluginId, [...(mcpByPlugin.get(pluginId) ?? []), id]);
      continue;
    }
    tools.add(id);
    if (effect === "read-only") readOnlyTools.add(id);
    const dot = id.indexOf(".");
    if (dot > 0) {
      const prefix = id.slice(0, dot + 1);
      const family = `${prefix}*`;
      const readOnly = registered.every((tool) => !tool.id.startsWith(prefix) || tool.effect === "read-only");
      if (readOnly && listableWithoutMcp(family)) families.add(family);
    }
  }
  for (const [pluginId, ids] of mcpByPlugin) {
    const readOnly = new Set(
      (await repositories.mcp.listTools(pluginId))
        .filter((tool) => tool.state === "approved" && tool.decision?.effect === "read-only")
        .map((tool) => tool.toolId),
    );
    for (const id of ids) {
      if (!readOnly.has(id)) continue;
      tools.add(id);
      readOnlyTools.add(id);
    }
  }
  return { tools: [...tools].sort(), families: [...families].sort(), readOnly: [...readOnlyTools].sort() };
}

/** What a write checks against the owner it is made on. */
export interface ScheduleWriteChecks {
  /** The owner's `--fs-root` rule for a `file-changed` pre-check's file: its real path, or a refusal. Absent: none is saved. */
  readonly precheckFile?: (path: string) => string;
  /** Why the owner's site profiles refuse reading a page or feed pre-check's address unattended; none when they allow it. */
  readonly precheckSite?: (workspaceId: string, url: string) => Promise<string | undefined>;
  /**
   * The owner's rule for a folder the schedule's fires work in, as a routine's pinned folder and a chat's primary
   * are checked (`ChatFolders.checkPrimary`): its real path, or a refusal. Absent: none is saved.
   */
  readonly folder?: (path: string) => string;
}

/** A write's folder: `undefined` when it names none, `null` to remove it, or its real path once the owner's rule holds. */
function writtenFolder(path: string | null | undefined, checks: ScheduleWriteChecks): string | null | undefined {
  if (path === undefined || path === null) return path;
  if (checks.folder === undefined)
    throw new TaviError(
      "UNAVAILABLE",
      "a schedule's folder needs a running owner, whose --fs-root folders it is checked against; start `tavi serve`",
    );
  try {
    return checks.folder(path);
  } catch (error) {
    const refused = TaviError.from(error);
    throw new TaviError(refused.code, `--folder: ${refused.message}`);
  }
}

/**
 * A write's pre-check: `undefined` when it names none, `null` to remove one, or
 * the pre-check checked — a page's or feed's address held to the owner's site
 * profiles, a file's path held to the owner's `--fs-root` rule and stored as
 * its real path.
 */
async function writtenPrecheck(
  text: string | null | undefined,
  workspaceId: string,
  checks: ScheduleWriteChecks,
): Promise<SchedulePrecheck | null | undefined> {
  if (text === undefined) return undefined;
  if (text === null) return null;
  const parsed = parseSchedulePrecheck(text);
  if (!parsed.ok) throw new TaviError("INVALID_INPUT", `--precheck: ${parsed.message}`);
  const precheck = parsed.precheck;
  if (precheck === null) return precheck;
  if (precheck.kind !== "file-changed") {
    const refused = await checks.precheckSite?.(workspaceId, precheck.target);
    if (refused !== undefined) throw new TaviError("NOT_AUTHORIZED", `--precheck: ${refused}`);
    return precheck;
  }
  if (checks.precheckFile === undefined)
    throw new TaviError(
      "UNAVAILABLE",
      "a file-changed pre-check needs a running owner, whose --fs-root folders its file is checked against; start `tavi serve`",
    );
  return { kind: precheck.kind, target: checks.precheckFile(precheck.target) };
}

/** One validation path for CLI and IPC creation/patches. Null clears optional fields. */
export async function writeSchedule(
  repositories: Pick<PersistencePort["repositories"], "schedules" | "agents" | "mcp">,
  input: SchedulesPayload,
  at: Date,
  checks: ScheduleWriteChecks = {},
): Promise<ScheduleRecord> {
  const checked = SchedulesPayloadSchema.safeParse(input);
  if (!checked.success) throw new TaviError("INVALID_INPUT", checked.error.issues.map((issue) => issue.message).join("; "));
  input = checked.data;
  const workspaceId = input.workspaceId ?? "default";
  const existing = input.action === "update" ? await resolveSchedule(repositories.schedules, workspaceId, input.scheduleId) : undefined;
  // Typed on the name, so each refusal below narrows what follows it.
  const invalid: (message: string) => never = (message) => {
    throw new TaviError("INVALID_INPUT", message);
  };
  if (input.action === "update" && !existing)
    throw keyedError("NOT_FOUND", "error.schedule.notFoundIn", { scheduleId: JSON.stringify(input.scheduleId), workspaceId });
  if (existing && input.name !== undefined && input.name !== existing.name) throw keyedError("INVALID_INPUT", "error.schedule.nameFixed");
  const name = existing?.name ?? input.name;
  const prompt = input.prompt ?? existing?.prompt;
  const composed = composeSpec(input, existing?.spec);
  if (
    !name?.trim() ||
    !prompt?.trim() ||
    (composed.at === undefined && composed.times === undefined && composed.everyHours === undefined) ||
    composed.timezone === undefined
  )
    invalid("schedules add needs --name, --at, --timezone and --prompt");
  const parsed = ScheduleSpecSchema.safeParse(composed);
  if (!parsed.success) invalid(`invalid schedule spec: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const spec = parsed.data;
  if (!isValidTimeZone(spec.timezone)) invalid(`${JSON.stringify(spec.timezone)} is not a known IANA timezone`);
  const specChanged = existing === undefined || specFieldsGiven(input);
  // A spec that would never run again is refused when it is written, not found finished at its first fire.
  const firstRun = nextOccurrence(spec, at);
  if (specChanged && firstRun === undefined)
    invalid(`${scheduleSpecText(spec)} has no run left: its ${spec.once === undefined ? "until" : "once"} date is past`);
  // A finished schedule given a run left runs again: that change is what its state asks for.
  const rearm = existing !== undefined && specChanged && !existing.enabled && scheduleFinished(existing.spec, at) && firstRun !== undefined;
  const policy = MissedRunPolicySchema.safeParse(input.missed ?? existing?.missedRunPolicy ?? "run-once-if-missed-within-6h");
  if (!policy.success) invalid(`--missed must be one of ${MISSED_RUN_POLICIES.join(", ")}`);
  const patterns = input.allow === undefined ? [...(existing?.autoApproveTools ?? [])] : input.allow.flatMap((raw) => csvList(raw));
  for (const pattern of patterns)
    if (isStaleWebPattern(pattern)) invalid(`--allow ${JSON.stringify(pattern)} is refused: ${STALE_WEB_PATTERN_MESSAGE}`);
  for (const pattern of patterns)
    if (!ScheduleToolPatternSchema.safeParse(pattern).success)
      invalid(`--allow ${JSON.stringify(pattern)} is not a tool id, a \`prefix.*\` family, or \`*\``);
  if (patterns.length > 128) invalid("At most 128 tool patterns are allowed.");
  // Checked when the list is written; an MCP tool's effect changed since is denied at the fire.
  if (input.allow !== undefined)
    for (const pattern of patterns) {
      const refused = await mcpPatternRefusal(repositories.mcp, pattern);
      if (refused !== undefined) invalid(refused);
    }
  // A form fill is the person's own review of every value: a fire denies it
  // whatever the list says, and naming it is refused here, so a schedule never seems to allow it.
  if (input.allow !== undefined)
    for (const pattern of patterns) {
      if (FORM_FILL_TOOLS.has(pattern))
        invalid(
          `--allow "${pattern}" is refused: a form fill is approved by a person, once, on its own card; a schedule's fire denies it whatever the list says`,
        );
    }
  // A fire that could create or change schedules or routines would schedule work nobody asked for: only the
  // read-only ones may be listed, by id. A list saved before this was refused is denied those calls at the fire.
  if (input.allow !== undefined)
    for (const pattern of patterns) {
      const refused = schedulingPatternRefusal(pattern);
      if (refused !== undefined) invalid(refused);
    }
  if (patterns.includes("*"))
    invalid(
      "`--allow '*'` grants every tool, including `sandbox.run` (arbitrary local command execution) in an unattended run. Name the tools instead, e.g. `--allow reports.*,messaging.send_to` — and add `--allow sandbox.run` explicitly if that is genuinely wanted.",
    );
  const hasAlert = input.alertConnection !== undefined || input.alertDestination !== undefined;
  if (
    hasAlert &&
    ((input.alertConnection == null) !== (input.alertDestination == null) ||
      input.alertConnection === undefined ||
      input.alertDestination === undefined)
  )
    invalid("--alert-connection and --alert-destination must be given together");
  // Given together (checked above): both null clears it, both set names it.
  const alert = hasAlert
    ? input.alertConnection == null || input.alertDestination == null
      ? undefined
      : { connectionId: input.alertConnection, destination: input.alertDestination }
    : existing?.alert;
  const agentId = input.agentId === null ? undefined : (input.agentId ?? existing?.agentId);
  if (agentId !== undefined) {
    const agent = await repositories.agents.get(workspaceId, agentId);
    if (!agent) invalid(`no agent ${JSON.stringify(agentId)} exists in workspace ${workspaceId}; create it with \`tavi agents add\``);
    if (!agent.enabled) invalid(`agent ${JSON.stringify(agentId)} is disabled; enable it with \`tavi agents enable\``);
  }
  const precheck = await writtenPrecheck(input.precheck, workspaceId, checks);
  const folder = writtenFolder(input.folder, checks);
  // A watcher's trigger is its pre-check: one is made only with a pre-check, and removing it stops the watcher.
  if (input.watch === true && (precheck === null || (precheck === undefined && existing?.precheck === undefined)))
    invalid("a watcher runs when its pre-check finds a change: give it --precheck (page-changed, feed-has-new or file-changed)");
  const now = at.toISOString();
  if (existing) {
    await repositories.schedules.update({
      scheduleId: existing.scheduleId,
      ...(input.prompt === undefined ? {} : { prompt }),
      ...(specChanged ? { spec, nextRunAt: existing.enabled ? (firstRun?.toISOString() ?? null) : null } : {}),
      ...(input.allow === undefined ? {} : { autoApproveTools: patterns }),
      ...(input.agentId === undefined ? {} : { agentId: agentId ?? null }),
      ...(hasAlert ? { alert: alert ?? null } : {}),
      ...(input.humanCheckpoints === undefined ? {} : { humanCheckpoints: input.humanCheckpoints }),
      ...(input.deliverTo === undefined ? {} : { deliverTo: input.deliverTo === "none" ? null : input.deliverTo }),
      ...definedOnly({
        maxRunMinutes: input.maxRunMinutes,
        maxTokens: input.maxTokens,
        folder,
        notify: input.notify,
        precheck,
        watch: input.watch,
      }),
      ...(input.missed === undefined ? {} : { missedRunPolicy: policy.data }),
      now,
    });
    if (rearm)
      await repositories.schedules.setEnabled({ scheduleId: existing.scheduleId, enabled: true, nextRunAt: firstRun.toISOString(), now });
    const updated = await repositories.schedules.get(existing.scheduleId);
    if (updated === undefined) throw keyedError("NOT_FOUND", "error.schedule.removedWhileUpdating", { scheduleId: existing.scheduleId });
    return updated;
  }
  return await repositories.schedules.create({
    scheduleId: prefixedId("sched"),
    workspaceId,
    principalId: input.principalId ?? "operator",
    name,
    prompt,
    spec,
    missedRunPolicy: policy.data,
    autoApproveTools: patterns,
    ...definedOnly({
      agentId,
      alert,
      humanCheckpoints: input.humanCheckpoints,
      maxRunMinutes: input.maxRunMinutes,
      maxTokens: input.maxTokens ?? undefined,
      folder: folder ?? undefined,
    }),
    ...(input.notify === undefined || input.notify === "always" ? {} : { notify: input.notify }),
    ...(input.deliverTo === undefined || input.deliverTo === "none" ? {} : { deliverTo: input.deliverTo }),
    ...(precheck == null ? {} : { precheck }),
    ...(precheck != null && input.watch === true ? { watch: true as const } : {}),
    enabled: true,
    nextRunAt: firstRun?.toISOString() ?? null,
    now,
  });
}

/** Whether a write names any part of when a schedule runs. */
function specFieldsGiven(input: SchedulesPayload): boolean {
  return [
    input.at,
    input.times,
    input.everyHours,
    input.between,
    input.timezone,
    input.days,
    input.monthly,
    input.yearly,
    input.once,
    input.untilDate,
  ].some((field) => field !== undefined);
}

/**
 * The spec a write asks for, over the stored one: the times of day (`at`,
 * `times`, or `everyHours` with `between`) are replaced together when any is
 * given, and so are the days (`days`, `monthly`, `yearly`, `once`; `days:
 * null` is every day again). `untilDate` replaces `until` (`null` clears it),
 * and `once` drops it. Unchecked: the schema judges what it makes.
 */
export function composeSpec(input: SchedulesPayload, stored: ScheduleSpec | undefined): Partial<ScheduleSpec> {
  const times =
    input.at !== undefined || input.times !== undefined || input.everyHours !== undefined
      ? {
          ...(input.at === undefined ? {} : { at: input.at }),
          ...(input.times === undefined ? {} : input.times.length === 1 ? { at: input.times[0] } : { times: [...input.times] }),
          ...(input.everyHours === undefined ? {} : { everyHours: input.everyHours }),
          ...(input.between == null ? {} : { between: input.between }),
        }
      : {
          ...(stored?.at === undefined ? {} : { at: stored.at }),
          ...(stored?.times === undefined ? {} : { times: [...stored.times] }),
          ...(stored?.everyHours === undefined ? {} : { everyHours: stored.everyHours }),
          ...(input.between === null
            ? {}
            : (input.between ?? stored?.between) === undefined
              ? {}
              : { between: input.between ?? stored?.between }),
        };
  const daysGiven = input.days !== undefined || input.monthly !== undefined || input.yearly !== undefined || input.once !== undefined;
  const days = daysGiven
    ? {
        ...(input.days == null ? {} : { daysOfWeek: [...input.days] }),
        ...definedOnly({ monthly: input.monthly, yearly: input.yearly, once: input.once }),
      }
    : {
        ...(stored?.daysOfWeek === undefined ? {} : { daysOfWeek: [...stored.daysOfWeek] }),
        ...(stored?.monthly === undefined ? {} : { monthly: stored.monthly }),
        ...(stored?.yearly === undefined ? {} : { yearly: stored.yearly }),
        ...(stored?.once === undefined ? {} : { once: stored.once }),
      };
  const until = input.once !== undefined || input.untilDate === null ? undefined : (input.untilDate ?? stored?.until);
  const timezone = input.timezone ?? stored?.timezone;
  return { ...times, ...(timezone === undefined ? {} : { timezone }), ...days, ...(until === undefined ? {} : { until }) };
}

/**
 * `schedules agenda`: every occurrence in the window, in the workspace's
 * effective zone — the owner's IPC handler and the offline command both
 * answer through this.
 */
export async function scheduleAgenda(
  repositories: Pick<PersistencePort["repositories"], "center" | "workspaceSettings">,
  input: Pick<SchedulesPayload, "workspaceId" | "from" | "until" | "limit">,
  now: Date,
): Promise<AgendaAnswer> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const window = resolveAgendaWindow(input, now);
  if ("error" in window) throw new TaviError("INVALID_INPUT", window.error);
  const timezone = (await repositories.workspaceSettings.get(workspaceId)).settings.timezone ?? hostTimeZone();
  const result = await repositories.center.agenda({ workspaceId, now: now.toISOString(), ...window });
  return { timezone, items: [...result.items], truncated: result.truncated, skipped: [...result.skipped] };
}

/**
 * `schedules preview`: when a cadence that is not saved would run next — the
 * form's live preview. The cadence is given as `add` takes it; no `timezone`
 * reads it in the workspace's effective zone. Its runs come from the engine
 * the scheduler fires by, so the preview and the fires cannot disagree. A
 * cadence the schema refuses is refused in its words.
 */
export async function schedulePreview(
  repositories: Pick<PersistencePort["repositories"], "workspaceSettings">,
  input: SchedulesPayload,
  now: Date,
): Promise<SchedulePreviewResult> {
  const timezone =
    input.timezone ??
    (await repositories.workspaceSettings.get(input.workspaceId ?? DEFAULT_WORKSPACE_ID)).settings.timezone ??
    hostTimeZone();
  if (!isValidTimeZone(timezone))
    throw keyedError("INVALID_INPUT", "error.schedule.unknownTimezone", { timezone: JSON.stringify(timezone) });
  const parsed = ScheduleSpecSchema.safeParse(composeSpec({ ...input, timezone }, undefined));
  if (!parsed.success) {
    throw new TaviError("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const spec = parsed.data;
  const count = Math.min(input.limit ?? SCHEDULE_PREVIEW_RUNS, SCHEDULE_PREVIEW_MAX_RUNS);
  const runs: string[] = [];
  for (let after = now; runs.length < count; ) {
    const next = nextOccurrence(spec, after);
    if (next === undefined) break;
    runs.push(next.toISOString());
    after = next;
  }
  return { timezone, text: scheduleSpecText(spec), runs };
}

/**
 * What a workspace's scheduled work (its schedules' and routines' runs, with
 * their workers) spent this calendar month in the workspace's effective zone,
 * against its `scheduled.monthlyTokenBudget` where one is set: summed from
 * model accounting when asked, never kept on the way.
 */
export async function scheduledWorkThisMonth(
  repositories: Pick<PersistencePort["repositories"], "schedules" | "workspaceSettings">,
  workspaceId: string,
  now: Date,
  /** The workspace's settings when the caller has already read them. */
  known?: WorkspaceSettings,
): Promise<ScheduledWorkUsage> {
  const settings = known ?? (await repositories.workspaceSettings.get(workspaceId)).settings;
  const timezone = settings.timezone ?? hostTimeZone();
  const window = scheduledMonthWindow(now, timezone);
  const spend = await repositories.schedules.scheduledUsage({ workspaceId, since: window.since, until: window.until });
  return scheduledWorkUsage(window, timezone, spend, settings.scheduledMonthlyTokenBudget);
}

/** `schedules show`: the schedule with its most recent fires, read in the workspace's effective zone. */
export async function scheduleShow(
  repositories: Pick<PersistencePort["repositories"], "schedules" | "workspaceSettings"> &
    Partial<Pick<PersistencePort["repositories"], "channelIngress">>,
  schedule: ScheduleRecord,
): Promise<ScheduleShowResult> {
  const timezone = (await repositories.workspaceSettings.get(schedule.workspaceId)).settings.timezone ?? hostTimeZone();
  // Where a call reaches its webhook, while it has one: the public address, or the listener's own on this machine.
  const webhookUrl =
    schedule.webhook === undefined ? undefined : await scheduleWebhookUrl(repositories.channelIngress, schedule.scheduleId);
  return {
    ...schedule,
    timezone,
    recentFires: await repositories.schedules.listFires(schedule.scheduleId, SCHEDULE_SHOW_FIRES),
    ...(webhookUrl === undefined ? {} : { webhookUrl }),
  };
}

/** `schedules history`: the schedule's fires, newest first, at most `limit` (the ledger keeps `SCHEDULE_FIRES_KEPT`). */
export async function scheduleHistory(
  repositories: Pick<PersistencePort["repositories"], "schedules" | "workspaceSettings">,
  schedule: ScheduleRecord,
  limit: number = SCHEDULE_SHOW_FIRES,
): Promise<ScheduleHistoryResult> {
  const timezone = (await repositories.workspaceSettings.get(schedule.workspaceId)).settings.timezone ?? hostTimeZone();
  return {
    scheduleId: schedule.scheduleId,
    name: schedule.name,
    timezone,
    fires: await repositories.schedules.listFires(schedule.scheduleId, limit),
  };
}

/** How `tavi schedules` writes a time in `timeZone`: "Tue, 27/10/2026, 07:00". */
function timeFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** A fire's time in `timezone`: "Tue, 27/10/2026, 07:00". */
export function fireTimeText(at: string, timezone: string): string {
  return timeFormat(timezone).format(new Date(at));
}

/** One line per fire, newest first: when it was for, why it ended so, and its task (no trailing newline). */
export function fireLines(fires: ScheduleShowResult["recentFires"], timezone: string, indent = ""): string[] {
  const format = timeFormat(timezone);
  return fires.map(
    (fire) =>
      `${indent}${format.format(new Date(fire.fireTime))}\t${fire.reasonCode}${fire.retryCount === undefined ? "" : ` (retry ${fire.retryCount})`}\t${fire.outcome}${fire.taskId === null ? "" : `\ttask ${fire.taskId}`}`,
  );
}

/**
 * `tavi schedules agenda`'s text: one line per occurrence in aligned columns —
 * when (`Tue 3 Nov 07:30`, as `list` and `reminders` say a time), what kind,
 * its title, its cadence, then its id (what `cancel` or `remove` takes) — the
 * agenda's zone named once in the heading and left out of a cadence in that
 * zone (no trailing newline). A plain schedule's cadence is its own, as the
 * web app labels it (`Mon–Fri 07:30`, `Mon–Fri every 2 h 08:00–18:00`), when
 * `specs` has it. `--format json` is the form to parse.
 */
export function agendaText(answer: AgendaAnswer, specs: ReadonlyMap<string, ScheduleSpec> = new Map()): string {
  if (answer.items.length === 0) return `Nothing scheduled (${answer.timezone})`;
  const lines = alignedColumns(
    answer.items.map((item) => [
      formatReminderTime(new Date(item.at), answer.timezone),
      item.todo === true ? "to-do" : item.kind,
      item.triggerId === undefined ? item.title : `${item.title} (${item.triggerId})`,
      `${cadenceText(item, answer.timezone, item.kind === "schedule" ? specs.get(item.id) : undefined)}${item.overdue === true ? " · overdue" : ""}`,
      item.id,
    ]),
  );
  return `Agenda (${answer.timezone})\n${lines.join("\n")}`;
}

/**
 * An agenda item's cadence as one column of `agendaText`, in the web app's
 * label words: its schedule's own spec when known, else the occurrence's (a
 * reminder's in its own terms); its zone said only when it is not the agenda's.
 */
function cadenceText(item: AgendaAnswer["items"][number], agendaZone: string, spec: ScheduleSpec | undefined): string {
  const { reminder, cadence } = item;
  if (reminder?.cadence === "event") {
    const offset = reminder.notice === undefined ? undefined : parseReminderOffset(reminder.notice);
    const event = reminder.eventAt === undefined ? "" : ` (event ${formatReminderTime(new Date(reminder.eventAt), agendaZone)})`;
    return `${offset === undefined ? "Notice" : describeReminderOffset(offset)}${event}`;
  }
  let shown = spec;
  if (shown === undefined) {
    if (cadence.kind === "once") return "Once";
    shown = {
      ...(reminder?.times === undefined ? { at: cadence.at } : { times: [...reminder.times] }),
      timezone: cadence.timezone,
      ...(cadence.kind === "daily"
        ? cadence.daysOfWeek === undefined
          ? {}
          : { daysOfWeek: [...cadence.daysOfWeek] }
        : definedOnly({ monthly: cadence.monthly, yearly: cadence.yearly })),
      ...(reminder?.until === undefined ? {} : { until: reminder.until }),
    };
  }
  const label = scheduleSpecText(shown, "label");
  const zoneSuffix = ` · ${agendaZone}`;
  return label.endsWith(zoneSuffix) ? label.slice(0, -zoneSuffix.length) : label;
}

/** Stderr notes for an agenda that is not the whole window: cut at its limit, or missing unreadable rows. */
export function agendaNotes(answer: AgendaAnswer): string {
  return [
    ...(answer.truncated
      ? [`note: the agenda lists the first ${answer.items.length} occurrences; pass --limit (up to 200) or fewer --days for the rest\n`]
      : []),
    ...(answer.skipped.length > 0 ? [`note: left out, their stored schedule cannot be read: ${answer.skipped.join(", ")}\n`] : []),
  ].join("");
}

/** What a manual fire answers: its run's task once admitted, or the outcome of a fire that ran nothing. */
export interface ScheduleFireNow {
  readonly taskId?: string;
  readonly outcome?: FireOutcome;
}

/**
 * Fire a schedule now on the owner's own scheduler dependencies, the delivery
 * check and the disk pre-flight included. Answered as soon as the run is
 * admitted (a caller follows it by task id) or, when the fire ran nothing, with
 * its outcome; the run goes on after the answer. `claim` is the caller's claim on the schedule in the in-flight
 * registry (`claimSchedule`), released once the fire has ended, however it ended. With a webhook's call, the run is
 * that call's; with `watch`, it is a file watcher's check, which runs only when the schedule's pre-check finds a
 * change; with `email`, an email's reader session.
 */
export function fireScheduleNow(
  schedule: ScheduleRecord,
  scheduling: ScheduleSchedulerDependencies,
  claim?: () => void,
  trigger?: ScheduleWebhookFire | "watch" | { readonly email: ScheduleEmailFire },
): Promise<ScheduleFireNow> {
  return new Promise<ScheduleFireNow>((resolve, reject) => {
    let answered = false;
    const answer = (settle: () => void): void => {
      if (answered) return;
      answered = true;
      settle();
    };
    const workflow = scheduling.workflow;
    runScheduleNow(
      schedule,
      {
        ...scheduling,
        workflow: {
          checkpoints: workflow.checkpoints,
          admit: (input, options) =>
            workflow.admit(
              input.kind !== "start"
                ? input
                : {
                    ...input,
                    onAdmitted: async (admitted) => {
                      await input.onAdmitted?.(admitted);
                      answer(() => resolve({ taskId: admitted.taskId }));
                    },
                  },
              options,
            ),
        },
      },
      {
        ...(claim === undefined ? {} : { claim }),
        ...(trigger === undefined
          ? {}
          : trigger === "watch"
            ? { watch: true as const }
            : "email" in trigger
              ? { email: trigger.email }
              : { webhook: trigger }),
      },
    )
      .then(
        (outcome) => answer(() => resolve({ outcome })),
        (error: unknown) => answer(() => reject(error)),
      )
      .finally(() => claim?.());
  });
}
