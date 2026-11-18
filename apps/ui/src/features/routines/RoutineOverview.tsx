import { useEffect, useRef, useState } from "react";
import { routineProvenanceLine, type RoutineDetail, type RoutineSnapshot } from "@tavi/contracts";

import { LIVE_POLL_MS, usePoll } from "../../hooks/use-poll.js";
import { Confirm } from "../../ui/Confirm.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import {
  operationKey,
  requestList,
  ROUTINE_PAGE,
  routineRequest,
  routineStep,
  weekEffort,
  type RoutineOverviewData,
  type RoutineRequest,
  type RunSummary,
} from "./api.js";
import { mergeBy } from "../../lib/paging.js";
import { ActionNote, DetailHead, LoadState, Notice, Section, StatusBadge, Summary } from "../../ui/Parts.js";
import { when } from "../../lib/time.js";
import { EditRoutine } from "./RoutineForms.js";
import { RunInspector } from "./RunInspector.js";
import { RoutineChecks } from "./RoutineChecks.js";
import { Revisions } from "./RoutineRevisions.js";
import { CodeText, RoutineResearcher, RoutineRuns } from "./RoutineSections.js";
import { evaluationWords, pausedDeliveryTarget, routineStatusView, type StatusNoticeAction } from "./status.js";
import { Button } from "../../ui/Button.js";
import { AppLink } from "../shell/AppLink.js";
import { useWorkspace } from "../shell/Workspace.js";

const ACCEPTED = "Owner accepted the action.";

/** What an action changed, once the owner took it, said of the routine `name`d. */
function changedText(input: RoutineRequest, name: string): string {
  switch (input.action) {
    case "pause":
      return `${name} paused.`;
    case "resume":
      return `${name} resumed.`;
    case "reevaluate":
      return `${name} is being evaluated again.`;
    case "run":
      return "Run started.";
    case "preview":
      return "Preview run started.";
    case "resume_delivery":
      return `${name}'s delivery resumed; its waiting reports are sent again.`;
    case "undo":
      return `${name} restored revision ${input.revision ?? ""} as its newest.`;
    case "archive":
      return `${name} archived.`;
    default:
      return ACCEPTED;
  }
}

type Confirmable = "archive";
const CONFIRM: Readonly<Record<Confirmable, { readonly title: string; readonly message: string }>> = {
  archive: { title: "Archive routine", message: "Archive this routine and stop its future triggers?" },
};

/**
 * One routine's own page: its name, status and main actions up top; then what
 * it is doing (schedule, evaluation, configuration), its runs, its health
 * checks, its researcher and settings, its revisions, and the actions that
 * end it. A run opens as a page of its own, with a way back here. The page
 * (and a run's) is read again as `revision` moves; Run now opens the run it
 * started.
 */
export function RoutineOverview({
  routineId,
  revision = 0,
  runId: openRun,
  onOpenRun,
  onClose,
  onFollow,
  changed,
  timeZone,
}: {
  readonly routineId: string;
  /** Moves when the feed reports a routine change: the page is read again. */
  readonly revision?: number;
  /** The run the address names: shown as its own page instead of the routine's. */
  readonly runId: string | undefined;
  /** Open a run (or, with none, come back to the routine). */
  readonly onOpenRun: (runId: string | undefined) => void;
  readonly onClose: () => void;
  readonly onFollow: (taskId: string) => Promise<void>;
  /** The routine changed: the list re-reads it. */
  readonly changed: () => void;
  /** The workspace's zone, the one times are said in. */
  readonly timeZone: string | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const heading = useRef<HTMLHeadingElement>(null);
  const current = useLoaded(() => routineRequest<RoutineOverviewData>(client, workspaceId, { action: "get", routineId }), [revision], {
    serial: true,
  });
  const history = useLoaded(
    () =>
      requestList<{ readonly runs: readonly RunSummary[] }>(
        client,
        workspaceId,
        { action: "history", routineId, limit: ROUTINE_PAGE },
        "runs",
        "run history",
      ),
    [revision],
  );
  const [olderRuns, setOlderRuns] = useState<readonly RunSummary[]>([]);
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState<Confirmable>();
  // Revisions load themselves; a refresh remounts them so they are read again too.
  const [refreshes, setRefreshes] = useState(0);
  const reload = (): void => {
    setRefreshes((count) => count + 1);
    current.reload();
    history.reload();
    changed();
  };
  const { busy, note, tone, run } = useAction(reload);
  // A run started whose answer named no run: the note points at Runs instead of opening it.
  const [startedUnseen, setStartedUnseen] = useState(false);
  // Asked from the status notice: Health checks readiness again.
  const [readinessAsked, setReadinessAsked] = useState(0);
  const act = (input: RoutineRequest) => {
    setStartedUnseen(false);
    return run(input.action, () =>
      routineStep(client, workspaceId, { routineId, ...input }, () => changedText(input, current.data?.routine.name ?? "The routine")),
    );
  };
  // Moves as the person leaves this routine, or this page for one of its runs.
  const place = useRef(0);
  useEffect(
    () => () => {
      place.current += 1;
    },
    [routineId, openRun],
  );
  /** Run now or a preview: the run it started opens, when the owner's answer names it and the person is still here. */
  const start = (input: RoutineRequest) => {
    setStartedUnseen(false);
    const at = place.current;
    let started: string | undefined;
    let accepted = false;
    return run(input.action, async () => {
      const answer = await routineStep<{ readonly runId?: unknown } | null>(client, workspaceId, { routineId, ...input }, (value) => {
        started = typeof value?.runId === "string" ? value.runId : undefined;
        return changedText(input, current.data?.routine.name ?? "The routine");
      });
      accepted = answer.ok;
      return answer;
    }).then(() => {
      if (!accepted || place.current !== at) return;
      if (started !== undefined) onOpenRun(started);
      else setStartedUnseen(true);
    });
  };

  const value = current.data;
  const activeRevision = value?.routine.activeRevision ?? null;
  const latestRevision = value?.revision.revision;
  // Its runs deliver under the active revision's settings: read it when a newer one is on its way.
  const active = useLoaded<RoutineDetail | undefined>(
    () =>
      activeRevision === null || activeRevision === latestRevision
        ? Promise.resolve({ ok: true, value: undefined })
        : routineRequest<RoutineDetail>(client, workspaceId, { action: "get", routineId, revision: activeRevision }),
    [routineId, activeRevision, latestRevision],
  );
  let activeSnapshot: RoutineSnapshot | undefined;
  if (activeRevision !== null && activeRevision === latestRevision) activeSnapshot = value?.revision.snapshot;
  else if (active.data !== undefined && active.data.revision.revision === activeRevision) activeSnapshot = active.data.revision.snapshot;
  const pausedTarget =
    value === undefined || activeSnapshot === undefined ? undefined : pausedDeliveryTarget(value.state, activeSnapshot.execution);
  const view = value === undefined ? undefined : routineStatusView(value, pausedTarget);
  const noticeAction = (action: StatusNoticeAction) => {
    switch (action.kind) {
      case "link":
        return (
          <AppLink href={action.href} className="button-sm" onFollow={undefined}>
            {action.label}
          </AppLink>
        );
      case "readiness":
        return (
          <Button
            size="sm"
            disabled={busy !== undefined}
            onClick={() => {
              setReadinessAsked((count) => count + 1);
              document.getElementById("section-health")?.scrollIntoView?.({ block: "start" });
            }}
          >
            {action.label}
          </Button>
        );
      case "preview":
        return (
          <Button
            size="sm"
            disabled={busy !== undefined}
            onClick={() => void start({ action: "preview", operationKey: operationKey(), revision: value?.routine.latestRevision })}
          >
            {action.label}
          </Button>
        );
      case "resume-delivery":
        return (
          <Button
            size="sm"
            disabled={busy !== undefined}
            onClick={() => void act({ action: "resume_delivery", targetId: action.targetId })}
          >
            {action.label}
          </Button>
        );
    }
  };
  // While the owner is still evaluating (or waiting on setup), the page re-reads itself: not while it is hidden or the
  // last read is still out, and at once when it shows again.
  const settling = view?.settling === true;
  usePoll(
    () => {
      if (!document.hidden && !current.loading) current.reload();
    },
    LIVE_POLL_MS,
    { enabled: settling, visibility: true },
  );
  // Arriving here (or back from a run) puts focus on the routine's name.
  useEffect(() => heading.current?.focus(), [openRun]);

  const runs = mergeBy([history.data?.runs, olderRuns], (item) => item.runId);
  const loadOlderRuns = () =>
    run("history", () =>
      routineStep<{ readonly runs?: readonly RunSummary[] }>(
        client,
        workspaceId,
        { action: "history", routineId, beforeRunId: runs.at(-1)?.runId, limit: ROUTINE_PAGE },
        (page) => {
          const older = page.runs ?? [];
          setOlderRuns((before) => [...before, ...older]);
          return older.length > 0 ? undefined : "No older runs";
        },
      ),
    );

  const name = value?.routine.name ?? "Routine";
  if (openRun !== undefined) {
    return (
      <RunInspector
        key={openRun}
        routineId={routineId}
        routineName={name}
        runId={openRun}
        timeZone={timeZone}
        onBack={() => onOpenRun(undefined)}
        onFollow={onFollow}
      />
    );
  }

  return (
    <div className="routine-page">
      <DetailHead
        back="Schedule"
        onBack={onClose}
        headingRef={heading}
        title={
          <>
            {name} {value ? <StatusBadge status={value.routine.status} /> : null}
          </>
        }
        description={value ? value.revision.snapshot.objective : undefined}
      >
        {value && view ? (
          <div className="actions">
            {view.pause ? (
              <Button disabled={busy !== undefined} onClick={() => void act({ action: "pause", expectedVersion: value.routine.version })}>
                Pause
              </Button>
            ) : null}
            {view.resume ? (
              <Button disabled={busy !== undefined} onClick={() => void act({ action: "resume", expectedVersion: value.routine.version })}>
                Resume
              </Button>
            ) : null}
            {view.evaluateAgain ? (
              <Button
                disabled={busy !== undefined}
                onClick={() => void act({ action: "reevaluate", expectedVersion: value.routine.version })}
              >
                Evaluate again
              </Button>
            ) : null}
            {view.edit ? <Button onClick={() => setEdit(true)}>Edit routine</Button> : null}
            <Button
              variant="primary"
              disabled={busy !== undefined || !view.run}
              title={view.runBlocked}
              aria-describedby={view.runBlocked === undefined ? undefined : "run-blocked"}
              onClick={() => void start({ action: "run", operationKey: operationKey() })}
            >
              Run now
            </Button>
            {view.runBlocked === undefined ? null : (
              <span id="run-blocked" className="visually-hidden">
                {view.runBlocked}
              </span>
            )}
          </div>
        ) : null}
      </DetailHead>
      {view?.notice ? (
        <div className={`status-notice status-notice-${view.notice.tone}`} role="status">
          <strong>{view.notice.title}.</strong> <CodeText text={view.notice.detail} />
          {view.notice.action === undefined ? null : <div className="status-notice-actions">{noticeAction(view.notice.action)}</div>}
        </div>
      ) : null}
      {/* A model's change made after its chat read untrusted content, until the person edits the routine's words. */}
      {value !== undefined && routineProvenanceLine(value.revision.provenance) !== undefined ? (
        <Notice className="routine-provenance">
          {routineProvenanceLine(value.revision.provenance)}. Check its objective and instructions; editing them yourself clears this note.
        </Notice>
      ) : null}
      <LoadState
        error={current.error || undefined}
        reload={current.reload}
        loading={value === undefined && !current.error}
        label="Loading routine…"
      >
        <ActionNote note={note || undefined} tone={tone} />
        {startedUnseen && busy === undefined ? (
          <p className="notice">
            <Button
              variant="link"
              onClick={() => {
                const latest = document.querySelector<HTMLElement>("[aria-labelledby='section-runs'] .item-title");
                document.getElementById("section-runs")?.scrollIntoView?.({ block: "start" });
                latest?.focus();
              }}
            >
              See it under Runs
            </Button>
          </p>
        ) : null}
      </LoadState>

      {value === undefined ? null : (
        <>
          <Section
            title="Overview"
            actions={
              <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={reload}>
                Refresh details
              </Button>
            }
          >
            <Summary
              items={[
                ["Owner", value.hostStatus],
                ...(value.schedules ?? []).map(
                  (schedule, index) =>
                    [
                      index === 0 ? "Schedule" : `Schedule ${index + 1}`,
                      `Next ${when(schedule.next_run_at, timeZone, "not armed")} · last ${when(schedule.last_run_at, timeZone, "never")}`,
                    ] as const,
                ),
                [
                  "Evaluation",
                  <>
                    <StatusBadge status={value.evaluation.status} /> <EvaluationText evaluation={value.evaluation} />
                  </>,
                ],
                [
                  "Configuration",
                  `Active revision: ${value.routine.activeRevision ?? "none"}; latest configuration: ${value.revision.revision}. Runs keep their original configuration.`,
                ],
                ...(value.lastSevenDays === undefined ? [] : [["Last 7 days", weekEffort(value.lastSevenDays)] as const]),
              ]}
            />
          </Section>

          <RoutineRuns
            history={history}
            runs={runs}
            busy={busy}
            timeZone={timeZone}
            onOpenRun={onOpenRun}
            onLoadOlder={() => void loadOlderRuns()}
          />

          <RoutineChecks routineId={routineId} timeZone={timeZone} auto={view?.checkReadiness === true} asked={readinessAsked} />

          <RoutineResearcher
            value={value}
            busy={busy}
            preview={view?.preview !== false}
            onPreview={() => void start({ action: "preview", operationKey: operationKey(), revision: value.routine.latestRevision })}
          />

          <Revisions
            key={refreshes}
            timeZone={timeZone}
            routineId={routineId}
            busy={busy}
            current={value.revision}
            onRestore={(revision) =>
              act({ action: "undo", revision, expectedVersion: value.routine.version, operationKey: operationKey() })
            }
          />

          {view?.archive ? (
            <section className="danger-zone routine-danger" aria-label="Archive">
              <Button variant="danger-ghost" onClick={() => setConfirm("archive")}>
                Archive routine
              </Button>
            </section>
          ) : null}

          {edit ? (
            <EditRoutine
              value={value}
              timeZone={timeZone}
              onClose={() => setEdit(false)}
              saved={() => {
                setEdit(false);
                reload();
              }}
            />
          ) : null}
          {confirm ? (
            <Confirm
              title={CONFIRM[confirm].title}
              message={CONFIRM[confirm].message}
              action={`Confirm ${confirm}`}
              onConfirm={() => act({ action: confirm, expectedVersion: value.routine.version })}
              onClose={() => setConfirm(undefined)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** A setup check in plain words, the scorer's measurements behind a disclosure. */
function EvaluationText({ evaluation }: { readonly evaluation: RoutineDetail["evaluation"] }) {
  const { summary, measured } = evaluationWords(evaluation);
  return (
    <>
      <CodeText text={summary} />
      {measured === undefined ? null : (
        <details className="routine-evaluation-measured">
          <summary className="disclosure">What it measured</summary>
          {measured}
        </details>
      )}
    </>
  );
}
