import { useEffect, useRef, useState } from "react";

import { routineRunDuration } from "@tavi/contracts";

import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { LIVE_POLL_MS, usePoll } from "../../hooks/use-poll.js";
import { attempt } from "../../lib/ipc.js";
import { formatCount } from "../../lib/format.js";
import { useT } from "../../lib/i18n.js";
import { formatElapsed, when } from "../../lib/time.js";
import { ActionNote, DetailHead, Failure, InlineConfirm, LoadState, Section, StatusBadge, Summary } from "../../ui/Parts.js";
import { json, routineRequest, routineStep, runModeLabel, type RunInspection } from "./api.js";
import { Deliveries } from "./RunDeliveries.js";
import { RunRecords } from "./RunRecords.js";
import { ResearchAuthority, RunReport } from "./RunReport.js";
import { RunWaiting, RunQuestions } from "./RunWaiting.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/** A run the owner may still act on: it can be cancelled, and its grant revoked. While it is, the page re-reads itself. */
const LIVE = ["queued", "running", "interrupted"];

/**
 * One run's own page, as it happened: a summary up top with the run's actions,
 * then the report it published and the deliveries that followed, the
 * authority it researched under, its attempts, its timeline (with the actual
 * prompts, while retained) and the evidence it fetched. While the run is live
 * the page reads itself again every few seconds, and once more as it settles.
 */
export function RunInspector({
  routineId,
  routineName,
  runId,
  onBack,
  onFollow,
  timeZone,
}: {
  readonly routineId: string;
  /** The routine's name, for the way back. */
  readonly routineName: string;
  readonly runId: string;
  /** The workspace's zone, the one times are said in. */
  readonly timeZone: string | undefined;
  readonly onBack: () => void;
  readonly onFollow: (taskId: string) => Promise<void>;
}) {
  const { client, workspaceId } = useWorkspace();
  const t = useT();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const inspection = useLoaded(() => routineRequest<RunInspection>(client, workspaceId, { action: "inspect", runId }));
  // The records below load themselves; a refresh remounts them so all three are read again together.
  const [refreshes, setRefreshes] = useState(0);
  const refresh = (): void => {
    inspection.reload();
    setRefreshes((count) => count + 1);
  };
  // A live run's records are read again in place: what is open on them stays open.
  const [polls, setPolls] = useState(0);
  const value = inspection.data;
  const live = value !== undefined && LIVE.includes(value.run.status);
  // Not while the page is hidden or the last read is still out; at once when the page shows again.
  usePoll(
    () => {
      if (document.hidden || inspection.loading) return;
      inspection.reload();
      setPolls((count) => count + 1);
    },
    LIVE_POLL_MS,
    { enabled: live, visibility: true },
  );
  // The read that saw it settle may have raced its last records: read them once more.
  const wasLive = useRef(false);
  useEffect(() => {
    if (wasLive.current && !live) setPolls((count) => count + 1);
    wasLive.current = live;
  }, [live]);
  const { busy, note, tone, run } = useAction(() => {});
  const [cancelling, setCancelling] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  /** The confirm closes: focus goes back to Cancel run, where it was asked, once that is drawn again. */
  const closeCancel = (): void => {
    setCancelling(false);
    requestAnimationFrame(() => cancelButton.current?.focus());
  };
  /** A write to this run: on success, the run is read again. */
  const change = (key: string, request: Parameters<typeof routineStep>[2], done: string) =>
    run(key, async () => {
      const answer = await routineStep(client, workspaceId, request, () => done);
      if (answer.ok) refresh();
      return answer;
    });
  const duration = value ? routineRunDuration(value.run.startedAt, value.run.endedAt) : null;
  const follow = (taskId: string) => run("task", () => attempt(async () => void (await onFollow(taskId))));

  return (
    <div className="routine-page">
      <DetailHead
        back={routineName}
        onBack={onBack}
        headingRef={heading}
        title={
          <>
            {t("routines.inspector.title", { when: value ? when(value.run.startedAt ?? value.run.claimedAt, timeZone) : "" })}{" "}
            {value ? <StatusBadge status={value.run.status} /> : null}
          </>
        }
        description={
          value ? t("routines.inspector.description", { mode: runModeLabel(value.run.mode), revision: value.run.revision }) : undefined
        }
      >
        <div className="actions">
          <Button onClick={refresh}>{t("routines.inspector.refresh")}</Button>
          {value?.run.taskId ? (
            <Button
              onClick={() => {
                if (value.run.taskId) void follow(value.run.taskId);
              }}
            >
              {t("routines.inspector.openTask")}
            </Button>
          ) : null}
          {value !== undefined && LIVE.includes(value.run.status) ? (
            cancelling ? (
              <InlineConfirm
                inline
                focusCancel
                message={t("routines.inspector.cancelConfirm")}
                confirmLabel={t("routines.inspector.cancel")}
                cancelLabel={t("routines.inspector.keepRunning")}
                busy={busy !== undefined}
                onConfirm={() => {
                  closeCancel();
                  void change("cancel", { action: "cancel", runId }, t("routines.inspector.cancelDone"));
                }}
                onCancel={closeCancel}
              />
            ) : (
              <Button ref={cancelButton} variant="destructive" disabled={busy !== undefined} onClick={() => setCancelling(true)}>
                {t("routines.inspector.cancel")}
              </Button>
            )
          ) : null}
        </div>
      </DetailHead>
      <LoadState
        error={inspection.error || undefined}
        reload={inspection.reload}
        loading={value === undefined && !inspection.error}
        label={t("routines.inspector.loading")}
      >
        <ActionNote note={note || undefined} tone={tone} />
      </LoadState>
      {value === undefined ? null : (
        <>
          {/* A failed run says why, in the words of the error it ended on; a run from before that was kept says so. */}
          {value.run.status === "failed" ? (
            <Failure alert={false} className="run-failure">
              {value.run.data.failureDetail === undefined
                ? t("routines.inspector.failedUnknown")
                : t("routines.inspector.failedWhy", { detail: value.run.data.failureDetail })}
            </Failure>
          ) : null}
          {value.run.taskId && LIVE.includes(value.run.status) ? (
            <RunWaiting
              key={refreshes}
              revision={polls}
              taskId={value.run.taskId}
              timeZone={timeZone}
              onOpen={() => void follow(value.run.taskId ?? "")}
            />
          ) : null}
          {value.run.taskId ? (
            <RunQuestions key={`questions-${refreshes}`} revision={polls} routineId={routineId} runId={runId} timeZone={timeZone} />
          ) : null}
          <Section title={t("routines.inspector.summary")}>
            <Summary
              items={[
                [t("routines.inspector.claimed"), when(value.run.claimedAt, timeZone)],
                [t("routines.inspector.started"), when(value.run.startedAt, timeZone, t("routines.inspector.notStarted"))],
                [t("routines.inspector.ended"), when(value.run.endedAt, timeZone, t("routines.inspector.notEnded"))],
                ...(duration === null ? [] : [[t("routines.inspector.duration"), formatElapsed(duration)] as const]),
                [t("routines.inspector.modelCalls"), String(value.run.data.modelCalls)],
                [t("routines.inspector.toolCalls"), String(value.run.data.toolCalls)],
                [
                  t("routines.inspector.knownTokens"),
                  value.run.data.usageComplete
                    ? formatCount(value.run.data.tokensKnown)
                    : t("routines.inspector.incompleteTokens", { tokens: formatCount(value.run.data.tokensKnown) }),
                ],
                ...(value.publication?.headline ? [[t("routines.inspector.headline"), value.publication.headline] as const] : []),
              ]}
            />
            <details>
              <summary className="disclosure">{t("routines.inspector.configuration")}</summary>
              <pre>{json(value.run.snapshot)}</pre>
            </details>
          </Section>

          <RunReport runId={runId} publication={value.publication} busy={busy} run={run} timeZone={timeZone} />
          <Deliveries value={value} busy={busy} change={change} routineId={routineId} timeZone={timeZone} />

          <Section title={t("routines.inspector.authority")}>
            {value.effectivePolicy ? (
              <ResearchAuthority
                policy={value.effectivePolicy}
                revocable={value.effectivePolicy.revokedAt === null && LIVE.includes(value.run.status)}
                busy={busy}
                onRevoke={() =>
                  void change(
                    "revoke-grant",
                    { action: "revoke_grant", runId, reason: t("routines.inspector.revokeReason") },
                    t("routines.inspector.revokeDone"),
                  )
                }
              />
            ) : (
              <p className="muted">{t("routines.inspector.noGrant")}</p>
            )}
          </Section>

          <Section title={t("routines.inspector.attempts")}>
            <ul className="item-list list-reset">
              {(value.attempts ?? []).map((attempt) => (
                <li key={attempt.attempt_id} className="item-row">
                  <div className="item-main">
                    <span className="item-title-text">{t("routines.inspector.generation", { generation: attempt.generation })}</span>
                    <span className="item-meta meta-sm">
                      {when(attempt.started_at, timeZone)} → {when(attempt.ended_at, timeZone, t("routines.inspector.ongoing"))}
                    </span>
                  </div>
                  <StatusBadge status={attempt.status} />
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
      <RunRecords key={refreshes} revision={polls} routineId={routineId} runId={runId} timeZone={timeZone} />
    </div>
  );
}
