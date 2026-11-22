import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { useT } from "../../lib/i18n.js";
import { mapOutcome } from "../../lib/ipc.js";
import { dayTime } from "../../lib/time.js";
import { Empty } from "../../ui/Empty.js";
import { ActionNote, BackLink, Notice, Pending, StatusBadge } from "../../ui/Parts.js";
import { manyPeople } from "./model.js";
import { eventLine, fireOutcomeText, noticeLabel, repeatText, transitionSaid } from "./reminder-model.js";
import { AddedFrom } from "./ReminderRows.js";
import { getReminder, snoozeReminder, transitionReminder } from "./reminders-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/** `/center/schedule/reminders/<id>`: what it says, when, what comes next, what fired, and its controls. */
export function ReminderPage({
  reminderId,
  revision = 0,
  people,
  onBack,
  onDelete,
  onFollow,
  changed,
}: {
  readonly reminderId: string;
  /** Delete it: back to the lists, where the delete waits for its Undo. */
  readonly onDelete: (reminder: { readonly reminderId: string; readonly text: string }) => void;
  /** Moves when the feed reports a change: the reminder and its fires are read again. */
  readonly revision?: number;
  readonly people: Readonly<Record<string, string>> | undefined;
  readonly onBack: () => void;
  readonly onFollow: (taskId: string) => Promise<void>;
  /** Something changed here: Schedule's lists are read again. */
  readonly changed: () => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const loaded = useLoaded(() => getReminder(client, workspaceId, reminderId), [revision]);
  const reload = loaded.reload;
  const { busy, note, tone, run } = useAction(() => {
    reload();
    changed();
  });
  const answer = loaded.data;
  if (answer === undefined) {
    return (
      <section className="center-section reminder-page" aria-label={t("center.reminderPage.label")}>
        <BackLink label={t("center.reminderPage.back")} onBack={onBack} />
        {loaded.error !== undefined && /does not exist|not found/i.test(loaded.error) ? (
          <Notice role="status">{t("center.reminderPage.notFound")}</Notice>
        ) : (
          <Pending error={loaded.error} reload={reload} label={t("center.reminderPage.loading")} className="notice" status />
        )}
      </section>
    );
  }
  const { reminder, fires } = answer;
  const zone = reminder.timezone;
  const when = reminder.when;
  const unseen = fires.find(
    (fire) => (fire.outcome === "delivered" || fire.outcome === "delivered-in-app") && fire.acknowledgedAt === undefined,
  );
  const transition = (action: "pause" | "resume"): void =>
    void run(action, async () => {
      const done = await transitionReminder(client, workspaceId, reminder.reminderId, action);
      if (!done.ok) return done;
      return { ok: true, value: transitionSaid(action) };
    });
  const snooze = (minutes: 10 | 60): void =>
    void run(`snooze:${minutes}`, async () => {
      const done = await snoozeReminder(client, workspaceId, reminder.reminderId, minutes, unseen?.fireAt);
      return mapOutcome(done, (value) => t("center.reminderPage.snoozedUntil", { at: dayTime(value.followUp.fireAt, zone) }));
    });
  const live = reminder.status === "active" || reminder.status === "paused";
  return (
    <section className="center-section reminder-page" aria-labelledby="reminder-title">
      <BackLink label={t("center.reminderPage.back")} onBack={onBack} />
      <header className="center-head">
        <div>
          <span className="schedule-kind eyebrow schedule-kind-reminder">{t("center.reminderPage.label")}</span>
          <h1 id="reminder-title">{reminder.text}</h1>
          <p className="settings-description">
            <span className="schedule-cadence">
              {when.kind === "event"
                ? t("center.reminderPage.event", {
                    line: eventLine(
                      when.at,
                      reminder.upcoming.map((fire) => fire.at),
                      zone,
                    ),
                  })
                : when.kind === "once"
                  ? t("center.reminderPage.once", { at: dayTime(when.at, zone) })
                  : repeatText(when)}
            </span>{" "}
            · {reminder.timezone} · <StatusBadge status={reminder.status} />
          </p>
          <p className="reminder-meta">
            {reminder.deliverTo.kind === "app" ? t("center.reminderPage.deliveredApp") : t("center.reminderPage.deliveredChat")}
            {people !== undefined && manyPeople(people) ? (
              <> · {t("center.reminderPage.forPerson", { person: people[reminder.principalId] ?? reminder.principalId })}</>
            ) : null}
            {reminder.createdBy === "agent" ? (
              <>
                {" · "}
                <AddedFrom reminder={reminder} onFollow={onFollow} />
              </>
            ) : null}
          </p>
          {reminder.prompt === undefined ? null : (
            <p className="muted">{t("center.reminderPage.alsoStarts", { prompt: reminder.prompt })}</p>
          )}
        </div>
      </header>
      <div className="item-actions reminder-actions">
        {unseen === undefined ? null : (
          <>
            <Button size="sm" disabled={busy !== undefined} onClick={() => snooze(10)}>
              {t("center.reminderPage.snooze10")}
            </Button>
            <Button size="sm" disabled={busy !== undefined} onClick={() => snooze(60)}>
              {t("center.reminderPage.snooze60")}
            </Button>
          </>
        )}
        {reminder.status === "active" ? (
          <Button size="sm" disabled={busy !== undefined} onClick={() => transition("pause")}>
            {t("center.reminderPage.pause")}
          </Button>
        ) : null}
        {reminder.status === "paused" ? (
          <Button size="sm" disabled={busy !== undefined} onClick={() => transition("resume")}>
            {t("center.reminderPage.resume")}
          </Button>
        ) : null}
        {live ? (
          <Button variant="danger-ghost" size="sm" disabled={busy !== undefined} onClick={() => onDelete(reminder)}>
            {t("center.reminderPage.delete")}
          </Button>
        ) : null}
      </div>
      <ActionNote note={note} tone={tone} />
      <h2 className="center-subhead">{t("center.reminderPage.next")}</h2>
      {reminder.upcoming.length === 0 ? (
        <Empty className="center-empty">
          {reminder.status === "paused" ? t("center.reminderPage.pausedNothing") : t("center.reminderPage.nothingLeft")}
        </Empty>
      ) : (
        <ul className="reminder-fires list-reset">
          {reminder.upcoming.map((fire) => (
            <li key={fire.at}>
              <time dateTime={fire.at}>{dayTime(fire.at, zone)}</time>
              {fire.noticeOffset === undefined ? null : <span className="muted"> · {noticeLabel(fire.noticeOffset)}</span>}
            </li>
          ))}
        </ul>
      )}
      <h2 className="center-subhead">{t("center.reminderPage.recentFires")}</h2>
      {fires.length === 0 ? (
        <Empty className="center-empty">{t("center.reminderPage.notFired")}</Empty>
      ) : (
        <ul className="reminder-fires list-reset">
          {fires.map((fire) => (
            <li key={fire.fireAt} className={`reminder-fire reminder-fire-${fire.outcome}`}>
              <time dateTime={fire.fireAt}>{dayTime(fire.fireAt, zone)}</time> ·{" "}
              <span className="reminder-outcome">{fireOutcomeText(fire)}</span>
              {fire.noticeOffset === undefined ? null : <span className="muted"> · {noticeLabel(fire.noticeOffset)}</span>}
              {fire.snoozedUntil === undefined ? null : (
                <span className="muted"> · {t("center.reminderPage.until", { at: dayTime(fire.snoozedUntil, zone) })}</span>
              )}
              {fire.taskId === undefined ? null : (
                <>
                  {" · "}
                  <Button variant="ghost" size="sm" onClick={() => void onFollow(fire.taskId as string)}>
                    {t("center.reminderPage.openTask")}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
