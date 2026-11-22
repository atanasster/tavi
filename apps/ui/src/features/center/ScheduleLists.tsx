import type { AgendaAnswer, AgendaItem } from "@tavi/contracts";
import type { ReactNode } from "react";
import { useState } from "react";

import { AppLink } from "../shell/AppLink.js";
import { centerPath, routinePath, schedulePath } from "../shell/route.js";
import { MINUTE_TICK_MS, useNow } from "../../hooks/use-poll.js";
import type { useLoaded } from "../../hooks/use-loaded.js";
import { LoadState, Notice, StatusBadge } from "../../ui/Parts.js";
import { groupByDay, localTime, longDay, relativeDay, todayIn, relativeTime } from "../../lib/time.js";
import { cadenceText } from "./schedule-model.js";
import { agendaReminderText } from "./reminder-model.js";
import { ReminderLink } from "./ReminderRows.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { withParts } from "../../ui/with-parts.js";

/** How many of the week's days Coming up shows before the rest is asked for. */
const DAYS_SHOWN = 2;

/** A list as `useLoaded` holds it. */
type Loaded<T> = ReturnType<typeof useLoaded<T>>;

/**
 * The next seven days, grouped under the workspace zone's days, soonest first;
 * "in 14 h" moves each minute. The first two days with something in them
 * show; the rest of the week waits behind a button, since a few repeating
 * schedules fill a week with the same rows.
 */
export function ComingUp({
  agenda,
  hidden,
  timeZone,
  today: summaryToday,
  quiet,
  onOpenRoutine,
  onOpenReminder,
  onOpenSchedule,
  reminderRow,
  todoIds,
}: {
  readonly agenda: Loaded<AgendaAnswer>;
  /**
   * The open to-dos' ids: a due to-do comes up as the owner's reminder for it, and is said as a to-do, opening the
   * to-do list rather than a reminder page.
   */
  readonly todoIds?: ReadonlySet<string>;
  /** What a delete waiting for its Undo hides, by `kind:id`: its occurrences too. */
  readonly hidden?: ReadonlySet<string>;
  /** The section already says nothing is scheduled: no empty line of its own. */
  readonly quiet: boolean;
  readonly timeZone: string | undefined;
  readonly today: string | undefined;
  readonly onOpenRoutine: (routineId: string) => void;
  readonly onOpenReminder: (reminderId: string) => void;
  readonly onOpenSchedule: (scheduleId: string) => void;
  /** What a reminder's occurrence adds below its cadence: the person, where it was asked. */
  readonly reminderRow: (item: AgendaItem) => ReactNode;
}) {
  const t = useT();
  const now = useNow(MINUTE_TICK_MS);
  const today = summaryToday ?? todayIn(timeZone, now);
  const answer = agenda.data;
  // The agenda is in time order, so an occurrence's day follows the one before it.
  const items = answer?.items.filter((item) => hidden?.has(`${item.kind}:${item.id}`) !== true);
  const days = items === undefined ? [] : groupByDay(items, (item) => item.at, timeZone);
  const [whole, setWhole] = useState(false);
  const shown = whole ? days : days.slice(0, DAYS_SHOWN);
  const rest = days.slice(DAYS_SHOWN).reduce((count, day) => count + day.items.length, 0);
  return (
    <>
      <h2 className="center-subhead">
        {withParts(t("center.scheduleLists.comingUp"), {
          detail: (
            <span>
              {timeZone === undefined ? t("center.scheduleLists.next7Days") : t("center.scheduleLists.next7DaysIn", { zone: timeZone })}
            </span>
          ),
        })}
      </h2>
      <LoadState
        error={agenda.error || undefined}
        reload={agenda.reload}
        loading={agenda.loading && answer === undefined}
        label={t("center.scheduleLists.loading")}
        status
      />
      {answer?.truncated ? <Notice>{t("center.scheduleLists.truncated", { count: answer.items.length })}</Notice> : null}
      {answer !== undefined && answer.skipped.length > 0 ? (
        <p className="muted schedule-skipped">{t("center.scheduleLists.skipped", { names: answer.skipped.join(", ") })}</p>
      ) : null}
      {!quiet && items?.length === 0 ? <Empty className="center-empty">{t("center.scheduleLists.nothing")}</Empty> : null}
      {shown.map((day) => {
        const label = longDay(day.date, today);
        const relative = relativeDay(day.date, today, "future")?.replace(/^./, (first) => first.toUpperCase());
        return (
          <section
            key={day.date}
            className="schedule-day"
            aria-label={relative === undefined ? label : t("center.scheduleLists.dayLabel", { relative, day: label })}
          >
            <h3 className="center-day-head">
              {label}
              {relative === undefined ? null : <span>{relative}</span>}
            </h3>
            <ul className="schedule-timeline list-reset">
              {day.items.map((item) => (
                <AgendaRow
                  key={`${item.kind}:${item.id}:${item.triggerId ?? ""}:${item.at}`}
                  item={item}
                  timeZone={timeZone}
                  today={today}
                  now={now}
                  onOpenRoutine={onOpenRoutine}
                  onOpenReminder={onOpenReminder}
                  onOpenSchedule={onOpenSchedule}
                  todo={item.kind === "reminder" && todoIds?.has(item.id) === true}
                  extra={item.kind === "reminder" ? reminderRow(item) : null}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {rest === 0 ? null : (
        <Button variant="ghost" size="sm" className="schedule-more" aria-expanded={whole} onClick={() => setWhole(!whole)}>
          {whole ? t("center.scheduleLists.showLess") : t("center.scheduleLists.showRest", { count: rest })}
        </Button>
      )}
    </>
  );
}

const KIND_LABELS: Readonly<Record<AgendaItem["kind"], UiKey>> = {
  routine: "center.scheduleLists.kind.routine",
  schedule: "center.scheduleLists.kind.schedule",
  reminder: "center.scheduleLists.kind.reminder",
};

function AgendaRow({
  item,
  timeZone,
  today,
  now,
  onOpenRoutine,
  onOpenReminder,
  onOpenSchedule,
  todo,
  extra,
}: {
  readonly item: AgendaItem;
  /** A due to-do's occurrence: labelled a to-do, opening the to-do list. */
  readonly todo: boolean;
  readonly timeZone: string | undefined;
  readonly today: string;
  readonly now: number;
  readonly onOpenRoutine: (routineId: string) => void;
  readonly onOpenReminder: (reminderId: string) => void;
  readonly onOpenSchedule: (scheduleId: string) => void;
  readonly extra: ReactNode;
}) {
  const t = useT();
  const kind = KIND_LABELS[item.kind];
  return (
    <li className={`schedule-item schedule-item-${item.kind}`}>
      <time dateTime={item.at}>{localTime(item.at, timeZone)}</time>
      <span className="schedule-node" aria-hidden="true">
        <i />
      </span>
      <span className="schedule-what">
        <span className={`schedule-kind eyebrow schedule-kind-${item.kind}`}>
          {todo ? t("center.scheduleLists.kind.todo") : kind === undefined ? item.kind : t(kind)}
        </span>
        {todo ? (
          <AppLink className="schedule-title" href={centerPath("schedule")} onFollow={() => onOpenReminder(item.id)}>
            {item.title}
          </AppLink>
        ) : item.kind === "reminder" ? (
          <ReminderLink className="schedule-title" reminderId={item.id} onOpen={onOpenReminder}>
            {item.title}
          </ReminderLink>
        ) : item.kind === "routine" ? (
          <AppLink className="schedule-title" href={routinePath(item.id)} onFollow={() => onOpenRoutine(item.id)}>
            {item.title}
          </AppLink>
        ) : (
          <AppLink className="schedule-title" href={schedulePath(item.id)} onFollow={() => onOpenSchedule(item.id)}>
            {item.title}
          </AppLink>
        )}
        <span className="schedule-sub meta">
          <span className="schedule-cadence">
            {item.kind === "reminder" ? agendaReminderText(item, timeZone, today) : cadenceText(item.cadence)}
          </span>
          {item.status !== undefined && item.status !== "active" ? (
            <>
              {" "}
              · <StatusBadge status={item.status} />
            </>
          ) : null}
          {extra}
        </span>
      </span>
      {item.overdue === true ? (
        <span className="schedule-overdue meta-sm">{t("center.scheduleLists.overdue")}</span>
      ) : (
        <span className="schedule-rel meta-sm">{relativeTime(item.at, now, timeZone)}</span>
      )}
    </li>
  );
}
