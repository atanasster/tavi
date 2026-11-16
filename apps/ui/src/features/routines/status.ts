import type { RoutineDetail, RoutineEvaluation, RoutineRecord, RoutineSnapshot } from "@tavi/contracts";

import { settingsPath } from "../shell/route.js";

/** What a status notice offers to do about it: a page to go to, a check to run, a paused target to resume, a preview. */
export type StatusNoticeAction =
  | { readonly kind: "link"; readonly label: string; readonly href: string }
  | { readonly kind: "readiness"; readonly label: string }
  | { readonly kind: "preview"; readonly label: string }
  | { readonly kind: "resume-delivery"; readonly label: string; readonly targetId: string };

/** A sentence about the routine's status, in a tone, with the one action that fixes it when there is one. */
interface StatusNotice {
  readonly tone: "info" | "warning" | "bad";
  readonly title: string;
  /** Plain text; a span in backticks is code. */
  readonly detail: string;
  readonly action?: StatusNoticeAction;
}

/**
 * What a routine's page may offer, and what it should say, for the status the
 * owner reports. The rules mirror the owner's own (`RoutineService.setStatus`,
 * `runs.request`, `reevaluate`), so a button is never offered only to be
 * refused, and a status never appears without a sentence saying what it means
 * and what to do about it.
 */
export interface RoutineStatusView {
  readonly pause: boolean;
  readonly resume: boolean;
  readonly run: boolean;
  /** Why Run now is not offered, when it is not. */
  readonly runBlocked?: string;
  readonly evaluateAgain: boolean;
  readonly edit: boolean;
  readonly archive: boolean;
  /** Whether a revision may be previewed: not once the routine's owner is no longer allowed. */
  readonly preview: boolean;
  readonly notice?: StatusNotice;
  /** The owner is still working the routine towards a settled state: re-read it. */
  readonly settling: boolean;
  /** Something blocks it that Health can name: its readiness is checked as the page opens. */
  readonly checkReadiness: boolean;
}

const CHECK_READINESS: StatusNoticeAction = { kind: "readiness", label: "Check readiness" };

/**
 * The delivery target the owner holds paused, if any, from the routine's
 * stored delivery health (`state`, as `get` reports it) and the `execution`
 * settings of its active revision, the ones its runs deliver under: paused
 * after its failure threshold, or once its credentials have been missing past
 * the grace period. Until resumed, its reports are kept and not sent.
 */
export function pausedDeliveryTarget(
  state: unknown,
  execution: Pick<RoutineSnapshot["execution"], "failureThreshold" | "credentialGraceHours">,
  now: number = Date.now(),
): string | undefined {
  const data = (state as { readonly data?: { readonly deliveryHealth?: unknown } } | null | undefined)?.data;
  const health = data?.deliveryHealth;
  if (health === null || typeof health !== "object") return undefined;
  for (const [targetId, entry] of Object.entries(health as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") continue;
    const { failures, blockedSince } = entry as { readonly failures?: unknown; readonly blockedSince?: unknown };
    if (typeof failures === "number" && failures >= execution.failureThreshold) return targetId;
    if (typeof blockedSince === "string" && now - Date.parse(blockedSince) >= execution.credentialGraceHours * 3_600_000) return targetId;
  }
  return undefined;
}

/**
 * Whether a routine may be paused or resumed, from its record alone — what a
 * list row knows. The owner pauses an active or credential-blocked routine,
 * and resumes a paused one that has passed an evaluation.
 */
export function routineToggle(routine: Pick<RoutineRecord, "status" | "activeRevision">): {
  readonly pause: boolean;
  readonly resume: boolean;
} {
  return {
    pause: routine.status === "active" || routine.status === "credential-blocked",
    resume: routine.activeRevision !== null && (routine.status === "paused" || routine.status === "paused-failures"),
  };
}

/**
 * `pausedTarget` is the delivery target the owner holds paused
 * (`pausedDeliveryTarget`): a routine with nothing else to say says that,
 * with the way to resume it. Failing that, one whose revision no run has
 * published a report for yet (`topicNotice`, from `get`) says so, with a
 * preview to try it on its own topic.
 */
export function routineStatusView(detail: RoutineDetail & { readonly topicNotice?: string }, pausedTarget?: string): RoutineStatusView {
  const { routine, evaluation } = detail;
  const status = routine.status;
  const evaluated = routine.activeRevision !== null;
  const candidate = routine.latestRevision !== routine.activeRevision;
  const failed = evaluation.status === "failed";
  const waiting = evaluation.status === "pending" || evaluation.status === "running";
  const archived = status === "archived";

  const runnable = evaluated && (status === "active" || status === "credential-blocked");
  const runBlocked = runnable
    ? undefined
    : archived
      ? "Archived routines cannot run."
      : !evaluated
        ? "Available once the routine has passed its evaluation."
        : status === "completed"
          ? "This routine has no trigger left to run."
          : "Resume the routine to run it.";

  const base = {
    ...routineToggle(routine),
    run: runnable,
    ...(runBlocked === undefined ? {} : { runBlocked }),
    evaluateAgain: !archived && failed,
    edit: !archived,
    archive: !archived,
    preview: true,
    settling: !archived && (status === "evaluating" || status === "setup-needed" || waiting),
    checkReadiness: !archived && (status === "credential-blocked" || status === "setup-needed" || status === "paused-failures"),
  };

  // Its owner is no longer in Allowed people: it no longer runs, and can only be looked at or archived.
  if (detail.ownerRevoked === true) {
    return {
      pause: false,
      resume: false,
      run: false,
      runBlocked: "Its owner is no longer allowed in this workspace.",
      evaluateAgain: false,
      edit: false,
      archive: !archived,
      preview: false,
      settling: false,
      checkReadiness: false,
      notice: {
        tone: "warning",
        title: "Owner no longer allowed",
        detail: `${routine.principalId} was removed from Allowed people, so this routine no longer runs. Archive it, or allow them again to use it.`,
      },
    };
  }

  if (status === "setup-needed") {
    return {
      ...base,
      notice: {
        tone: "warning",
        title: "Setup needed",
        detail:
          evaluation.detail ||
          "The owner could not start this routine's evaluation. Check Health below for what is missing, then restart `tavi serve`.",
        action: CHECK_READINESS,
      },
    };
  }
  if (status === "evaluating" || (!evaluated && waiting)) {
    return {
      ...base,
      notice: {
        tone: "info",
        title: "Evaluating",
        detail: "The owner checks both model roles against a fixed test set before the routine can run. This page updates while it does.",
      },
    };
  }
  if (!evaluated && failed) {
    return {
      ...base,
      notice: {
        tone: "bad",
        title: "Evaluation failed",
        detail: `${evaluation.detail || "The revision did not pass its evaluation."} Evaluate again, or edit the routine to save a new revision.`,
      },
    };
  }
  if (status === "paused-failures") {
    return {
      ...base,
      notice: {
        tone: "warning",
        title: "Paused after repeated failures",
        detail: "Research kept failing, so the owner paused this routine. Check Health below, then Resume.",
        action: CHECK_READINESS,
      },
    };
  }
  if (status === "credential-blocked") {
    return {
      ...base,
      notice: {
        tone: "warning",
        title: "Research is blocked",
        detail:
          "A model or tool credential this routine uses is failing. Fix it in Settings; the routine resumes on its own once research works again.",
        action: { kind: "link", label: "Open credentials", href: settingsPath("credentials") },
      },
    };
  }
  if (status === "completed")
    return { ...base, notice: { tone: "info", title: "Completed", detail: "Its triggers that end have all run their last time." } };
  if (archived)
    return { ...base, notice: { tone: "info", title: "Archived", detail: "This routine no longer runs. Its history is kept." } };
  // An active or paused routine whose newer revision is still on its way.
  if (candidate && evaluated) {
    if (failed) {
      return {
        ...base,
        notice: {
          tone: "bad",
          title: `Revision ${routine.latestRevision} failed its evaluation`,
          detail: `${evaluation.detail || "It did not pass."} Revision ${routine.activeRevision} keeps running.`,
        },
      };
    }
    if (waiting) {
      return {
        ...base,
        notice: evaluation.detail
          ? {
              tone: "warning",
              title: `Revision ${routine.latestRevision} cannot be evaluated yet`,
              detail: `${evaluation.detail} Revision ${routine.activeRevision} keeps running.`,
            }
          : {
              tone: "info",
              title: `Evaluating revision ${routine.latestRevision}`,
              detail: `Revision ${routine.activeRevision} keeps running until it passes.`,
            },
      };
    }
  }
  if (pausedTarget !== undefined && !archived) {
    return {
      ...base,
      notice: {
        tone: "warning",
        title: "Delivery is paused",
        detail:
          "Sending its reports kept failing, or its destination's credentials stayed missing, so the owner stopped sending them. Reports are still written. Resume delivery once the destination works again.",
        action: { kind: "resume-delivery", label: "Resume delivery", targetId: pausedTarget },
      },
    };
  }
  if (detail.topicNotice !== undefined && evaluated && !archived) {
    return {
      ...base,
      notice: {
        tone: "info",
        title: "Not yet tried on its topic",
        detail: untriedDetail(detail.topicNotice),
        action: { kind: "preview", label: "Preview" },
      },
    };
  }
  return base;
}

/** The owner's untried notice without the lead-in the notice's title already says ("Not yet tried on its own topic: …"). */
function untriedDetail(notice: string): string {
  const rest = notice.replace(/^not yet tried on its (?:own )?topic[:.]\s*/i, "");
  return rest === "" || rest === notice ? notice : `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

/** The scorer's own line for a setup check: "Quality passed against corpus v2/… scorer v1: research precision …". */
const MEASURED = /^Quality (?:passed|failed the thresholds|incomplete) against corpus /;

/**
 * A routine's setup check in plain words, for its Overview: what came of it, with why it is incomplete or unsafe when
 * it says so, and the scorer's measurements apart (`measured`) to show behind a disclosure. Any other detail is the
 * owner's own sentence and is said as it came.
 */
export function evaluationWords(evaluation: Pick<RoutineEvaluation, "status" | "detail">): {
  readonly summary: string;
  readonly measured?: string;
} {
  const { status, detail } = evaluation;
  if (!MEASURED.test(detail)) return { summary: detail };
  const why = / (?:Incomplete|Safety failure): .*$/.exec(detail)?.[0].trim();
  const said =
    status === "passed"
      ? "Passed its setup check on a fixed test set."
      : status === "failed"
        ? "Did not pass its setup check on a fixed test set."
        : "Its setup check is not finished.";
  return { summary: why === undefined ? said : `${said} ${why}`, measured: detail };
}
