import {
  scheduleMaxRunMinutes,
  scheduleNotifyText,
  schedulePrecheckSentence,
  SCHEDULE_EVENT_MAX_TOKENS,
  tokenCountText,
  type ScheduleFireRecord,
  type ScheduleShowResult,
} from "@tavi/contracts";
import { useEffect, useRef } from "react";
import { useLoaded } from "../../hooks/use-loaded.js";
import { translateCore, useT } from "../../lib/i18n.js";
import { dayTime, todayIn } from "../../lib/time.js";
import { Button } from "../../ui/Button.js";
import { Empty } from "../../ui/Empty.js";
import { ActionNote, DetailHead, LoadError, Notice, Pending, Section, StatusBadge, Summary } from "../../ui/Parts.js";
import { AppLink } from "../shell/AppLink.js";
import { routinePath, taskPath } from "../shell/route.js";
import { useWorkspace } from "../shell/Workspace.js";
import { listReminderTargets } from "./reminders-api.js";
import { useScheduleActions } from "./PlainSchedules.js";
import { loadAgents, scheduleHistory, showSchedule } from "./schedules-api.js";
import { fireState, outcomeSentence, pausedText, scheduleState, specText, watchText } from "./schedule-model.js";
import { Webhook, EmailTrigger } from "./ScheduleTriggers.js";
import { withParts } from "../../ui/with-parts.js";

/** How many fires the page lists: the ledger keeps more, `tavi schedules history` reads them. */
const FIRES_SHOWN = 30;

/**
 * `/center/schedule/schedules/<id>`: one plain schedule — what it runs, the
 * policy it runs under, what happened at each of its recent fires, in the
 * workspace zone, and the same actions as its row in Recurring.
 */
export function SchedulePage({
  scheduleId,
  revision = 0,
  timeZone,
  onBack,
  onDelete,
  onFollow,
  onOpenRoutine,
  changed,
}: {
  readonly scheduleId: string;
  /** Moves when the feed reports a change: the schedule and its fires are read again. */
  readonly revision?: number;
  /** The workspace's zone, until the owner's answer names it. */
  readonly timeZone: string | undefined;
  readonly onBack: () => void;
  /** Delete it: back to the lists, where the delete waits for its Undo. */
  readonly onDelete: (schedule: { readonly scheduleId: string; readonly name: string }) => void;
  readonly onFollow: (taskId: string) => Promise<void>;
  /** A schedule a routine owns is managed on the routine's page. */
  readonly onOpenRoutine: (routineId: string) => void;
  /** Something changed here: Schedule's lists are read again. */
  readonly changed: () => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useLoaded(() => showSchedule(client, workspaceId, scheduleId), [revision]);
  const history = useLoaded(() => scheduleHistory(client, workspaceId, scheduleId, FIRES_SHOWN), [revision]);
  const reload = (): void => {
    shown.reload();
    history.reload();
    changed();
  };
  const zone = history.data?.timezone ?? shown.data?.timezone ?? timeZone;
  const actions = useScheduleActions(client, workspaceId, reload, onFollow, zone);
  // Arriving here puts focus on the schedule's name, as a routine's page does.
  useEffect(() => heading.current?.focus(), []);

  const schedule = shown.data;
  const missing = shown.error !== undefined && /does not exist|not found|no schedule/i.test(shown.error);
  const state = schedule === undefined ? undefined : scheduleState(schedule);
  const busy = actions.busy !== undefined;
  const ownedBy = schedule?.routineId;

  return (
    <section className="center-section routine-page schedule-page" aria-label={t("center.schedule.title")}>
      <DetailHead
        back={t("center.schedule.title")}
        onBack={onBack}
        headingRef={heading}
        title={
          <>
            {schedule?.name ?? t("center.schedule.title")} {state === undefined ? null : <StatusBadge status={state} />}
          </>
        }
        description={schedule === undefined ? undefined : <ScheduleWhen schedule={schedule} zone={zone} />}
      >
        {schedule === undefined || ownedBy !== undefined ? null : (
          <div className="actions">
            <Button variant="primary" disabled={busy} onClick={() => void actions.act({ action: "run", scheduleId }, schedule.name)}>
              {t("center.schedulePage.runNow")}
            </Button>
            {state === "finished" ? null : (
              <Button
                disabled={busy}
                onClick={() => void actions.act({ action: schedule.enabled ? "disable" : "enable", scheduleId }, schedule.name)}
              >
                {schedule.enabled ? t("center.schedulePage.pause") : t("center.schedulePage.resume")}
              </Button>
            )}
            <Button disabled={busy} onClick={() => actions.edit(scheduleId)}>
              {t("center.schedulePage.edit")}
            </Button>
            <Button disabled={busy} onClick={() => actions.duplicate(scheduleId)}>
              {t("center.schedulePage.duplicate")}
            </Button>
            <Button variant="danger-ghost" disabled={busy} onClick={() => onDelete(schedule)}>
              {t("center.schedulePage.delete")}
            </Button>
          </div>
        )}
      </DetailHead>
      <ActionNote note={actions.note} tone={actions.tone} />
      {schedule === undefined ? (
        missing ? (
          <Notice role="status">{t("center.schedulePage.notFound")}</Notice>
        ) : (
          <Pending error={shown.error} reload={shown.reload} label={t("center.schedulePage.loading")} className="notice" status />
        )
      ) : (
        <>
          {ownedBy === undefined ? null : (
            <Notice>
              {withParts(t("center.schedulePage.ownedByRoutine"), {
                link: (
                  <AppLink href={routinePath(ownedBy)} onFollow={() => onOpenRoutine(ownedBy)}>
                    {t("center.schedulePage.routinePage")}
                  </AppLink>
                ),
              })}
            </Notice>
          )}
          <Section title={t("center.schedulePage.prompt")}>
            <p className="schedule-prompt">{schedule.prompt}</p>
          </Section>
          <Section title={t("center.schedulePage.policy")}>
            <Policy schedule={schedule} zone={zone} />
          </Section>
          {ownedBy === undefined ? (
            <Section title={t("center.schedulePage.webhook")}>
              <Webhook schedule={schedule} zone={zone} changed={reload} />
            </Section>
          ) : null}
          {ownedBy === undefined ? (
            <Section title={t("center.schedulePage.emailTrigger")}>
              <EmailTrigger schedule={schedule} zone={zone} changed={reload} />
            </Section>
          ) : null}
          <Section title={t("center.schedulePage.fires")}>
            <Fires fires={history.data?.fires} error={history.error} reload={history.reload} zone={zone} openTask={actions.openLast} />
          </Section>
        </>
      )}
      {actions.form}
    </section>
  );
}

/** The line under the name: when it runs, the next run or that it is paused, and the pause switch. */
function ScheduleWhen({ schedule, zone }: { readonly schedule: ScheduleShowResult; readonly zone: string | undefined }) {
  const t = useT();
  const next = schedule.nextRunAt;
  // A watcher says what it watches, as its row in Recurring does; a schedule run by its time, its cadence.
  return (
    <>
      <span className="schedule-cadence">{watchText(schedule) ?? specText(schedule.spec)}</span> ·{" "}
      {schedule.enabled
        ? next === null
          ? t("center.schedulePage.notArmed")
          : t("center.schedulePage.next", { when: dayTime(next, zone, todayIn(zone)) })
        : pausedText(schedule)}
    </>
  );
}

/**
 * What a fire may do unattended, what happens when it is missed or runs long, and where its words go. Its alert chat
 * and its agent are named as their pickers name them, read only when it has one.
 */
function Policy({ schedule, zone }: { readonly schedule: ScheduleShowResult; readonly zone: string | undefined }) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const allow = schedule.autoApproveTools;
  const watching = watchText(schedule);
  const alert = schedule.alert;
  const targets = useLoaded(() => listReminderTargets(client, workspaceId), [client, workspaceId], { enabled: alert !== undefined });
  const agents = useLoaded(() => loadAgents(client, workspaceId), [client, workspaceId], { enabled: schedule.agentId !== undefined });
  const alertLabel =
    alert === undefined
      ? undefined
      : (targets.data?.find((target) => target.connectionId === alert.connectionId && target.chatId === alert.destination)?.label ??
        (targets.loading ? "…" : t("center.schedulePage.unknownChat")));
  const agentName =
    schedule.agentId === undefined
      ? t("center.schedulePage.baseInstructions")
      : (agents.data?.agents.find((agent) => agent.agentId === schedule.agentId)?.name ??
        (agents.loading ? "…" : t("center.schedulePage.unknownAgent")));
  return (
    <Summary
      items={[
        [
          t("center.schedulePage.allowed"),
          allow.length === 0
            ? t("center.schedulePage.allowedNothing")
            : withParts(t("center.schedulePage.allowedTools"), {
                tools: allow.map((pattern, index) => (
                  <span key={pattern}>
                    {index === 0 ? null : ", "}
                    <code>{pattern}</code>
                  </span>
                )),
              }),
        ],
        [
          t("center.schedulePage.missedRun"),
          schedule.missedRunPolicy === "skip" ? t("center.schedulePage.missedSkip") : t("center.schedulePage.missedCatchUp"),
        ],
        [
          t("center.schedulePage.runLimit"),
          schedule.maxRunMinutes === undefined
            ? t("center.schedulePage.runLimitDefault", { count: scheduleMaxRunMinutes(schedule) })
            : t("center.schedulePage.runLimitSet", { count: scheduleMaxRunMinutes(schedule) }),
        ],
        [
          t("center.schedulePage.tokenCeiling"),
          schedule.maxTokens === undefined
            ? schedule.webhook === undefined && schedule.emailTrigger === undefined
              ? t("center.schedulePage.tokenCeilingNone")
              : t("center.schedulePage.tokenCeilingEvents", { tokens: tokenCountText(SCHEDULE_EVENT_MAX_TOKENS, translateCore) })
            : t("center.schedulePage.tokenCeilingSet", { tokens: tokenCountText(schedule.maxTokens, translateCore) }),
        ],
        [
          t("center.schedulePage.delivers"),
          schedule.deliverTo === "home" ? t("center.schedulePage.deliversHome") : t("center.schedulePage.deliversSelf"),
        ],
        [
          t("center.schedulePage.tellsYou"),
          t("center.schedulePage.tellsYouText", { notify: capitalised(scheduleNotifyText(schedule.notify, translateCore)) }),
        ],
        watching !== undefined && [t("center.schedulePage.watcher"), t("center.schedulePage.watcherText", { watching })],
        [
          t("center.schedulePage.precheck"),
          schedule.precheck === undefined
            ? t("center.schedulePage.precheckNone")
            : schedule.precheckState === undefined
              ? t("center.schedulePage.precheckText", { check: capitalised(schedulePrecheckSentence(schedule.precheck, translateCore)) })
              : t("center.schedulePage.precheckTextRead", {
                  check: capitalised(schedulePrecheckSentence(schedule.precheck, translateCore)),
                  when: dayTime(schedule.precheckState.checkedAt, zone, todayIn(zone)),
                }),
        ],
        [t("center.schedulePage.alerts"), alertLabel ?? t("center.schedulePage.alertsHome")],
        [t("center.schedulePage.runsAs"), agentName],
        [
          t("center.schedulePage.questions"),
          schedule.humanCheckpoints === "ask-with-default"
            ? t("center.schedulePage.questionsAsk")
            : t("center.schedulePage.questionsNever"),
        ],
        [
          t("center.schedulePage.lastRun"),
          schedule.lastRunAt === null
            ? // Any run that starts moves it; an outcome with none is a fire missed or skipped, or one kept before that.
              schedule.lastOutcome === null
              ? t("center.schedulePage.never")
              : t("center.schedulePage.noneYet", { outcome: outcomeSentence(schedule.lastOutcome, zone) })
            : schedule.consecutiveFailures > 0
              ? t("center.schedulePage.lastRunFailures", {
                  when: dayTime(schedule.lastRunAt, zone, todayIn(zone)),
                  count: schedule.consecutiveFailures,
                })
              : dayTime(schedule.lastRunAt, zone, todayIn(zone)),
        ],
      ]}
    />
  );
}

/** A phrase as the start of a sentence. */
function capitalised(phrase: string): string {
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
}

/** The fire ledger, newest first: when each fire was for, how it went in a sentence, and its task. */
function Fires({
  fires,
  error,
  reload,
  zone,
  openTask,
}: {
  readonly fires: readonly ScheduleFireRecord[] | undefined;
  readonly error: string | undefined;
  readonly reload: () => void;
  readonly zone: string | undefined;
  readonly openTask: (taskId: string) => void;
}) {
  const t = useT();
  if (fires === undefined) {
    return error ? (
      <LoadError error={error} reload={reload} />
    ) : (
      <Pending label={t("center.schedulePage.loadingFires")} className="notice" status />
    );
  }
  if (fires.length === 0) return <Empty className="center-empty">{t("center.schedulePage.noFires")}</Empty>;
  const today = todayIn(zone);
  return (
    <ol className="schedule-fires list-reset">
      {fires.map((fire) => (
        <li key={`${fire.fireTime}:${fire.reasonCode}:${fire.retryCount ?? 0}:${fire.at}`}>
          <time dateTime={fire.fireTime}>{dayTime(fire.fireTime, zone, today)}</time>
          <StatusBadge status={fireState(fire)} />
          <span className="schedule-fire-text">
            {fire.retryCount === undefined ? null : (
              <span className="meta-sm">{t("center.schedulePage.retry", { count: fire.retryCount })}</span>
            )}
            {outcomeSentence(fire.outcome, zone)}
          </span>
          {fire.taskId === null ? null : (
            <AppLink className="meta-sm" href={taskPath(fire.taskId)} onFollow={() => openTask(fire.taskId as string)}>
              {t("center.schedulePage.openTask")}
            </AppLink>
          )}
        </li>
      ))}
    </ol>
  );
}
