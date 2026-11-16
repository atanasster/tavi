import type {
  AgentsListResult,
  ScheduleHistoryResult,
  ScheduleShowResult,
  SchedulesListResult,
  SchedulesPayload,
  ScheduleToolsResult,
  ScheduleWebhookAnswer,
  ScheduleWebhookMode,
  ScheduleEmailTriggerAnswer,
  ChannelConnectionView,
  ChannelsCatalogAnswer,
  ChannelsListAnswer,
} from "@tavi/contracts";
import { ask, withList, type Outcome, type SettingsClient } from "../../lib/ipc.js";

export function scheduleRequest<T>(client: SettingsClient, payload: SchedulesPayload): Promise<Outcome<T>> {
  return ask<T>(client, "schedules", { ...payload }, { refused: "Schedule action refused." });
}

/** The workspace's agents for the picker; an answer without a list (an owner without agents) is none. */
export async function loadAgents(client: SettingsClient, workspaceId: string): Promise<Outcome<AgentsListResult>> {
  const answer = await ask<Partial<AgentsListResult> | null | undefined>(
    client,
    "agents",
    { action: "list", workspaceId },
    { timeoutMs: null, refused: "Agents unavailable" },
  );
  if (!answer.ok) return answer;
  const result = answer.value;
  return {
    ok: true,
    value: Array.isArray(result?.agents)
      ? { agents: result.agents, truncated: result.truncated === true }
      : { agents: [], truncated: false },
  };
}

/**
 * The tools a schedule may list, for the form's suggestions, and which are
 * read-only: none read-only from an owner that does not say. A refusal (an
 * older owner, or one offline) is the read's failure; the form then suggests
 * nothing, since suggestions only help typing.
 */
export async function loadScheduleTools(client: SettingsClient, workspaceId: string): Promise<Outcome<ScheduleToolsResult>> {
  const answer = await scheduleRequest<Partial<ScheduleToolsResult> | null | undefined>(client, { action: "tools", workspaceId });
  if (!answer.ok) return answer;
  const strings = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    ok: true,
    value: { tools: strings(answer.value?.tools), families: strings(answer.value?.families), readOnly: strings(answer.value?.readOnly) },
  };
}

/** The workspace's schedules, as `schedules list` answers (routine-owned ones included; callers filter), with this month's scheduled work when `withUsage`. */
export async function listSchedules(client: SettingsClient, workspaceId: string, withUsage = false): Promise<Outcome<SchedulesListResult>> {
  return withList(
    await scheduleRequest<SchedulesListResult>(client, { action: "list", workspaceId, ...(withUsage ? { withUsage } : {}) }),
    "schedules",
    "schedules",
  );
}

/** One schedule with its prompt, its latest fires and the workspace zone, as `schedules show` answers. */
export async function showSchedule(client: SettingsClient, workspaceId: string, scheduleId: string): Promise<Outcome<ScheduleShowResult>> {
  return scheduleRequest<ScheduleShowResult>(client, { action: "show", workspaceId, scheduleId });
}

/** Turn a schedule's webhook on, off, or rotate its secret: the answer carries a new secret once, and never again. */
export function setScheduleWebhook(
  client: SettingsClient,
  workspaceId: string,
  scheduleId: string,
  webhook: ScheduleWebhookMode,
): Promise<Outcome<ScheduleWebhookAnswer>> {
  return scheduleRequest<ScheduleWebhookAnswer>(client, { action: "webhook", workspaceId, scheduleId, webhook });
}

/** Turn a schedule's email trigger on, listening as given, or off. */
export function setScheduleEmailTrigger(
  client: SettingsClient,
  workspaceId: string,
  scheduleId: string,
  emailTrigger: NonNullable<SchedulesPayload["emailTrigger"]>,
): Promise<Outcome<ScheduleEmailTriggerAnswer>> {
  return scheduleRequest<ScheduleEmailTriggerAnswer>(client, { action: "email-trigger", workspaceId, scheduleId, emailTrigger });
}

/** The workspace's connections an email trigger may listen on: those whose channel authenticates each sender (email). */
export async function emailTriggerConnections(
  client: SettingsClient,
  workspaceId: string,
): Promise<Outcome<readonly ChannelConnectionView[]>> {
  const [catalog, list] = await Promise.all([
    ask<ChannelsCatalogAnswer>(client, "channels", { action: "catalog" }),
    ask<ChannelsListAnswer>(client, "channels", { action: "list", workspaceId }),
  ]);
  if (!catalog.ok) return catalog;
  if (!list.ok) return list;
  const checked = new Set(
    catalog.value.channels.filter((channel) => channel.sender.authentication === "per-message").map((channel) => channel.providerId),
  );
  return { ok: true, value: list.value.connections.filter((connection) => checked.has(connection.providerId)) };
}

/** Delete a schedule for good: its fire ledger and task links go with it. */
export function removeSchedule(client: SettingsClient, workspaceId: string, scheduleId: string): Promise<Outcome<unknown>> {
  return scheduleRequest(client, { action: "remove", workspaceId, scheduleId });
}

/** Pause (`disable`) or resume (`enable`) a schedule: the owner's answer alone, for a caller that says what happened itself. */
export function switchSchedule(
  client: SettingsClient,
  workspaceId: string,
  scheduleId: string,
  action: "enable" | "disable",
): Promise<Outcome<unknown>> {
  return scheduleRequest(client, { action, workspaceId, scheduleId });
}

/** A schedule's fire ledger, newest first, as `schedules history` answers: at most `limit` fires. */
export async function scheduleHistory(
  client: SettingsClient,
  workspaceId: string,
  scheduleId: string,
  limit: number,
): Promise<Outcome<ScheduleHistoryResult>> {
  return withList(
    await scheduleRequest<ScheduleHistoryResult>(client, { action: "history", workspaceId, scheduleId, limit }),
    "fires",
    "fires",
  );
}

/** A listed schedule: the record without its prompt, which `show` gives. */
export type ListedSchedule = SchedulesListResult["schedules"][number];
