import type { ReactNode } from "react";

import type { ReminderFireView, ReminderView } from "@tavi/contracts";

import { useLoaded } from "../../hooks/use-loaded.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { DAY_MS, dayTime, todayIn } from "../../lib/time.js";
import { StatusBadge } from "../../ui/Parts.js";
import { AppLink } from "../shell/AppLink.js";
import { reminderPath, taskPath } from "../shell/route.js";
import { eventLine, whenText } from "./reminder-model.js";
import { chatTitle } from "./reminders-api.js";
import { withParts } from "../../ui/with-parts.js";
import { useWorkspace } from "../shell/Workspace.js";

/** A chat's name (`chatTitle`, read once per page), or undefined until it answers, when there is none, or without a chat. */
export function useChatTitle(client: SettingsClient, taskId: string | undefined): string | undefined {
  const { data } = useLoaded(
    async () => ({ ok: true, value: taskId === undefined ? undefined : await chatTitle(client, taskId) }) as const,
    [client, taskId],
    { enabled: taskId !== undefined },
  );
  return data;
}
/** "Added from <chat title>", linking to the chat the agent was asked in. */
export function AddedFrom({
  reminder,
  onFollow,
  lead,
}: {
  readonly reminder: Pick<ReminderView, "createdBy" | "originTaskId">;
  readonly onFollow: (taskId: string) => Promise<void>;
  /** What goes before it on a line it shares (" · "), only when it shows. */
  readonly lead?: string | undefined;
}) {
  const t = useT();
  const { client } = useWorkspace();
  const taskId = reminder.originTaskId;
  const title = useChatTitle(client, taskId);
  if (reminder.createdBy !== "agent" || taskId === undefined) return null;
  return (
    <>
      {lead}
      <span className="reminder-origin meta">
        {withParts(t("center.reminderRows.addedFrom"), {
          chat: (
            <AppLink href={taskPath(taskId)} onFollow={() => void onFollow(taskId)}>
              {title ?? t("center.reminderRows.aChat")}
            </AppLink>
          ),
        })}
      </span>
    </>
  );
}
/** A link to a reminder's page inside Schedule. */
export function ReminderLink({
  reminderId,
  onOpen,
  className,
  children,
}: {
  readonly reminderId: string;
  readonly onOpen: (reminderId: string) => void;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <AppLink className={className} href={reminderPath(reminderId)} onFollow={() => onOpen(reminderId)}>
      {children}
    </AppLink>
  );
}
/** The person a reminder is for, when more than one person has reminders (`lead`: what stands before "for"). */
export function ReminderPerson({
  principalId,
  people,
  show,
  lead = "",
}: {
  readonly principalId: string;
  readonly people: Readonly<Record<string, string>> | undefined;
  readonly show: boolean;
  readonly lead?: string;
}) {
  const t = useT();
  if (!show) return null;
  return (
    <span className="reminder-person meta">
      {lead}
      {t("center.reminderRows.forPerson", { person: people?.[principalId] ?? principalId })}
    </span>
  );
}
/** A reminder row's title in Schedule: its kind, its link, and its status unless it is active. */
function ReminderTitle({ reminder, onOpen }: { readonly reminder: ReminderView; readonly onOpen: (reminderId: string) => void }) {
  const t = useT();
  return (
    <span className="schedule-recurring-title">
      <span className="schedule-kind eyebrow schedule-kind-reminder">{t("center.reminderRows.reminder")}</span>
      <ReminderLink className="item-title reminder-title button-link" reminderId={reminder.reminderId} onOpen={onOpen}>
        {reminder.text}
      </ReminderLink>
      {reminder.status === "active" ? null : <StatusBadge status={reminder.status} />}
    </span>
  );
}
/** A one-off reminder whose fires lie beyond Coming up: an event with its notices, or a once. */
export function LaterReminderRow({
  reminder,
  timeZone,
  people,
  showPerson,
  onOpen,
  onFollow,
}: {
  readonly reminder: ReminderView;
  readonly timeZone: string | undefined;
  readonly people: Readonly<Record<string, string>> | undefined;
  readonly showPerson: boolean;
  readonly onOpen: (reminderId: string) => void;
  readonly onFollow: (taskId: string) => Promise<void>;
}) {
  const when = reminder.when;
  const line =
    when.kind === "event"
      ? eventLine(
          when.at,
          reminder.upcoming.map((fire) => fire.at),
          timeZone,
        )
      : reminder.nextFireAt === null
        ? whenText(when, timeZone)
        : translateNow("center.reminderRows.once", { at: dayTime(reminder.nextFireAt, timeZone, todayIn(timeZone)) });
  return (
    <li className="schedule-recurring schedule-recurring-reminder">
      <div className="schedule-recurring-main">
        <ReminderTitle reminder={reminder} onOpen={onOpen} />
        <span className="item-meta meta-sm">
          <span className="schedule-cadence">{line}</span>
        </span>
        <span className="item-meta meta-sm reminder-meta">
          <ReminderPerson principalId={reminder.principalId} people={people} show={showPerson} />
          <AddedFrom reminder={reminder} onFollow={onFollow} />
        </span>
      </div>
    </li>
  );
}
/** One entry of Done / missed: a finished or cancelled reminder, or a fire that was missed. */
export type DoneEntry =
  | { readonly kind: "reminder"; readonly reminder: ReminderView; readonly at: string }
  | { readonly kind: "missed"; readonly fire: ReminderFireView; readonly at: string };
/** How far back Done / missed looks. */
const DONE_WINDOW_DAYS = 30;
/** Done and cancelled reminders, and missed fires, of the last 30 days, newest first. */
export function doneEntries(finished: readonly ReminderView[], fires: readonly ReminderFireView[], now: number): readonly DoneEntry[] {
  const since = now - DONE_WINDOW_DAYS * DAY_MS;
  const entries: DoneEntry[] = [
    ...finished
      .filter((reminder) => reminder.status === "done" || reminder.status === "cancelled")
      .map((reminder) => ({
        kind: "reminder" as const,
        reminder,
        at: reminder.status === "done" ? (reminder.lastFiredAt ?? reminder.updatedAt) : reminder.updatedAt,
      })),
    ...fires.filter((fire) => fire.outcome === "missed").map((fire) => ({ kind: "missed" as const, fire, at: fire.fireAt })),
  ];
  return entries.filter((entry) => Date.parse(entry.at) >= since).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
/** Done / missed, collapsed at the end of Schedule. */
export function DoneReminders({
  entries,
  timeZone,
  onOpen,
}: {
  readonly entries: readonly DoneEntry[];
  readonly timeZone: string | undefined;
  readonly onOpen: (reminderId: string) => void;
}) {
  const t = useT();
  if (entries.length === 0) return null;
  return (
    <details className="reminder-done">
      <summary className="center-subhead disclosure">
        {t("center.reminderRows.doneMissed")}{" "}
        <span>{t("center.reminderRows.doneCount", { count: entries.length, days: DONE_WINDOW_DAYS })}</span>
      </summary>
      <ul className="schedule-recurring-list card-flat list-reset">
        {entries.map((entry) =>
          entry.kind === "reminder" ? (
            <li key={`r:${entry.reminder.reminderId}`} className="schedule-recurring reminder-done-item">
              <div className="schedule-recurring-main">
                <ReminderLink className="item-title reminder-title button-link" reminderId={entry.reminder.reminderId} onOpen={onOpen}>
                  {entry.reminder.text}
                </ReminderLink>
                <span className="item-meta meta-sm">
                  {entry.reminder.status === "done"
                    ? entry.reminder.lastFiredAt === null
                      ? t("center.reminderRows.done")
                      : t("center.reminderRows.fired", { at: dayTime(entry.reminder.lastFiredAt, timeZone) })
                    : t("center.reminderRows.cancelled", { at: dayTime(entry.reminder.updatedAt, timeZone) })}
                </span>
              </div>
              <StatusBadge status={entry.reminder.status} />
            </li>
          ) : (
            <li key={`m:${entry.fire.reminderId}@${entry.fire.fireAt}`} className="schedule-recurring reminder-done-item">
              <div className="schedule-recurring-main">
                <ReminderLink className="item-title reminder-title button-link" reminderId={entry.fire.reminderId} onOpen={onOpen}>
                  {entry.fire.text}
                </ReminderLink>
                <span className="item-meta meta-sm">{t("center.reminderRows.missedAt", { at: dayTime(entry.fire.fireAt, timeZone) })}</span>
              </div>
              <span className="badge badge-bad">{t("center.reminderRows.missed")}</span>
            </li>
          ),
        )}
      </ul>
    </details>
  );
}
