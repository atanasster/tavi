import {
  scheduleMaxRunMinutes,
  scheduleNotifyText,
  schedulePrecheckSentence,
  SCHEDULE_EVENT_MAX_TOKENS,
  tokenCountText,
  type ScheduleFireRecord,
  type ScheduleShowResult,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import { useEffect, useRef } from "react";
import { useLoaded } from "../../hooks/use-loaded.js";
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
    <section className="center-section routine-page schedule-page" aria-label="Schedule">
      <DetailHead
        back="Schedule"
        onBack={onBack}
        headingRef={heading}
        title={
          <>
            {schedule?.name ?? "Schedule"} {state === undefined ? null : <StatusBadge status={state} />}
          </>
        }
        description={schedule === undefined ? undefined : <ScheduleWhen schedule={schedule} zone={zone} />}
      >
        {schedule === undefined || ownedBy !== undefined ? null : (
          <div className="actions">
            <Button variant="primary" disabled={busy} onClick={() => void actions.act({ action: "run", scheduleId }, schedule.name)}>
              Run now
            </Button>
            {state === "finished" ? null : (
              <Button
                disabled={busy}
                onClick={() => void actions.act({ action: schedule.enabled ? "disable" : "enable", scheduleId }, schedule.name)}
              >
                {schedule.enabled ? "Pause" : "Resume"}
              </Button>
            )}
            <Button disabled={busy} onClick={() => actions.edit(scheduleId)}>
              Edit
            </Button>
            <Button disabled={busy} onClick={() => actions.duplicate(scheduleId)}>
              Duplicate
            </Button>
            <Button variant="danger-ghost" disabled={busy} onClick={() => onDelete(schedule)}>
              Delete
            </Button>
          </div>
        )}
      </DetailHead>
      <ActionNote note={actions.note} tone={actions.tone} />
      {schedule === undefined ? (
        missing ? (
          <Notice role="status">This schedule was not found.</Notice>
        ) : (
          <Pending error={shown.error} reload={shown.reload} label="Loading the schedule…" className="notice" status />
        )
      ) : (
        <>
          {ownedBy === undefined ? null : (
            <Notice>
              A routine runs this schedule: change or pause it on{" "}
              <AppLink href={routinePath(ownedBy)} onFollow={() => onOpenRoutine(ownedBy)}>
                the routine's page
              </AppLink>
              .
            </Notice>
          )}
          <Section title="Prompt">
            <p className="schedule-prompt">{schedule.prompt}</p>
          </Section>
          <Section title="Policy">
            <Policy schedule={schedule} zone={zone} />
          </Section>
          {ownedBy === undefined ? (
            <Section title="Webhook">
              <Webhook schedule={schedule} zone={zone} changed={reload} />
            </Section>
          ) : null}
          {ownedBy === undefined ? (
            <Section title="Email trigger">
              <EmailTrigger schedule={schedule} zone={zone} changed={reload} />
            </Section>
          ) : null}
          <Section title="Fires">
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
  const next = schedule.nextRunAt;
  // A watcher says what it watches, as its row in Recurring does; a schedule run by its time, its cadence.
  return (
    <>
      <span className="schedule-cadence">{watchText(schedule) ?? specText(schedule.spec)}</span> ·{" "}
      {schedule.enabled ? (next === null ? "Not armed" : `Next ${dayTime(next, zone, todayIn(zone))}`) : pausedText(schedule)}
    </>
  );
}

/**
 * What a fire may do unattended, what happens when it is missed or runs long, and where its words go. Its alert chat
 * and its agent are named as their pickers name them, read only when it has one.
 */
function Policy({ schedule, zone }: { readonly schedule: ScheduleShowResult; readonly zone: string | undefined }) {
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
        (targets.loading ? "…" : "A chat not among your delivery targets"));
  const agentName =
    schedule.agentId === undefined
      ? "The base instructions"
      : (agents.data?.agents.find((agent) => agent.agentId === schedule.agentId)?.name ??
        (agents.loading ? "…" : "An agent that is no longer listed"));
  return (
    <Summary
      items={[
        [
          "Allowed unattended",
          allow.length === 0 ? (
            "Nothing: every call that needs approval is refused. Read-only tools still run."
          ) : (
            <>
              {allow.map((pattern, index) => (
                <span key={pattern}>
                  {index === 0 ? null : ", "}
                  <code>{pattern}</code>
                </span>
              ))}
              . Read-only tools also run.
            </>
          ),
        ],
        ["Missed run", schedule.missedRunPolicy === "skip" ? "Skipped." : "Runs once if it is missed by up to 6 hours, then skipped."],
        [
          "Run limit",
          `Stopped after ${plural(scheduleMaxRunMinutes(schedule), "minute")} of work${schedule.maxRunMinutes === undefined ? " (the default)" : ""}.`,
        ],
        [
          "Token ceiling",
          schedule.maxTokens === undefined
            ? schedule.webhook === undefined && schedule.emailTrigger === undefined
              ? "None."
              : `None, but a run a webhook or email starts is stopped past ${tokenCountText(SCHEDULE_EVENT_MAX_TOKENS)}.`
            : `Stopped once a run, its workers included, uses more than ${tokenCountText(schedule.maxTokens)}.`,
        ],
        ["Delivers", schedule.deliverTo === "home" ? "Its result into Home." : "Only what each run sends itself."],
        ["Tells you", `${capitalised(scheduleNotifyText(schedule.notify))}. Failures are always told.`],
        watching !== undefined && ["Watcher", `${watching}.`],
        [
          "Pre-check",
          schedule.precheck === undefined
            ? "None: every run goes ahead."
            : `${capitalised(schedulePrecheckSentence(schedule.precheck))}; otherwise nothing runs and no model is called.${
                schedule.precheckState === undefined ? "" : ` Last read ${dayTime(schedule.precheckState.checkedAt, zone, todayIn(zone))}.`
              }`,
        ],
        ["Alerts", alertLabel ?? "Your Home: a failed or missed run is posted there as a notice (only logged while Home is off)."],
        ["Runs as", agentName],
        [
          "Questions",
          schedule.humanCheckpoints === "ask-with-default"
            ? "May ask in the alert destination, with a default it takes if nobody answers before the next run."
            : "Never asks: decides with what it has.",
        ],
        [
          "Last run",
          schedule.lastRunAt === null
            ? // Any run that starts moves it; an outcome with none is a fire missed or skipped, or one kept before that.
              schedule.lastOutcome === null
              ? "Never"
              : `None on its schedule yet · ${outcomeSentence(schedule.lastOutcome, zone)}`
            : `${dayTime(schedule.lastRunAt, zone, todayIn(zone))}${
                schedule.consecutiveFailures > 0 ? ` · ${plural(schedule.consecutiveFailures, "failure")} in a row` : ""
              }`,
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
  if (fires === undefined) {
    return error ? <LoadError error={error} reload={reload} /> : <Pending label="Loading its fires…" className="notice" status />;
  }
  if (fires.length === 0) return <Empty className="center-empty">It has not fired yet.</Empty>;
  const today = todayIn(zone);
  return (
    <ol className="schedule-fires list-reset">
      {fires.map((fire) => (
        <li key={`${fire.fireTime}:${fire.reasonCode}:${fire.retryCount ?? 0}:${fire.at}`}>
          <time dateTime={fire.fireTime}>{dayTime(fire.fireTime, zone, today)}</time>
          <StatusBadge status={fireState(fire)} />
          <span className="schedule-fire-text">
            {fire.retryCount === undefined ? null : <span className="meta-sm">Retry {fire.retryCount} · </span>}
            {outcomeSentence(fire.outcome, zone)}
          </span>
          {fire.taskId === null ? null : (
            <AppLink className="meta-sm" href={taskPath(fire.taskId)} onFollow={() => openTask(fire.taskId as string)}>
              Open its task
            </AppLink>
          )}
        </li>
      ))}
    </ol>
  );
}
