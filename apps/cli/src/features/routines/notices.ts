import type {
  MessagingServicePort,
  RoutineDeliveryTarget,
  RoutinePauseCause,
  RoutineRun,
  RoutineRunNoticeCause,
  RoutineScope,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

/**
 * A routine's notices: it paused on its own, one of its delivery targets
 * paused, or a run expired before it could finish — what is wrong in a
 * person's routine that nobody would otherwise hear of.
 *
 * Each is sent once per cause to the routine's own delivery target, and posted
 * into the person's Home when there is none, or when the channel did not
 * accept it: a broken channel never swallows the notice about itself. Nothing
 * goes anywhere a person did not already configure. The words are Tavi's, with
 * only the routine's and the target's names in them.
 */
export interface RoutineNoticeDependencies {
  readonly routines: {
    readonly get: (scope: RoutineScope, routineId: string) => Promise<{ readonly routine: { readonly name: string } }>;
    /** Throws for a target that is gone, disabled or no longer authorized: no notice goes there. */
    readonly target: (scope: RoutineScope, targetId: string) => Promise<RoutineDeliveryTarget>;
  };
  readonly messaging: Pick<MessagingServicePort, "send" | "buildDestination">;
  /** Into the person's Home, once per `sourceKey`; false when they have no Home. */
  readonly postHome: (input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sourceKey: string;
    readonly title: string;
    readonly summary: string;
  }) => Promise<boolean>;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

export interface RoutineNotices {
  /** The routine paused, or `run` expired. False when it could not be told yet and is worth trying again. */
  runPaused(run: RoutineRun, cause: RoutineRunNoticeCause): Promise<boolean>;
  /** Delivery to `targetId` paused. False when it could not be told yet and is worth trying again. */
  deliveryPaused(run: RoutineRun, targetId: string, cause: RoutinePauseCause): Promise<boolean>;
}

/** Where a routine is resumed. */
const RESUME_HINT = "Resume it in Center → Schedule, or ask Tavi in chat to resume it.";

/** A run's scope alone: the routine services read a scope strictly. */
const scopeOf = (run: RoutineRun): RoutineScope => ({ workspaceId: run.workspaceId, principalId: run.principalId });

export function createRoutineNotices(deps: RoutineNoticeDependencies): RoutineNotices {
  const nameOf = async (run: RoutineRun): Promise<string> => {
    try {
      return (await deps.routines.get(scopeOf(run), run.routineId)).routine.name;
    } catch {
      return run.snapshot.agent.name;
    }
  };

  /** The target's label, or its id when it is no longer readable. */
  const labelOf = async (run: RoutineRun, targetId: string): Promise<string> => {
    try {
      return (await deps.routines.target(scopeOf(run), targetId)).label;
    } catch {
      return targetId;
    }
  };

  /**
   * Notices whose send already failed once: a notice kept untold is tried
   * again each sweep, and the outbox replays the same outcome, so the failure
   * is logged only the first time.
   */
  const failedSends = new Set<string>();

  const logSendFailure = (effectId: string, message: string, fields: Record<string, unknown>): void => {
    if (failedSends.has(effectId)) return;
    failedSends.add(effectId);
    deps.log(message, fields);
  };

  /**
   * Send to the first of the routine's targets that can still be sent to,
   * other than `skip`; true only when the channel accepted it. Undefined when
   * there was no such target.
   */
  const sendToTarget = async (run: RoutineRun, effectId: string, text: string, skip?: string): Promise<boolean | undefined> => {
    for (const targetId of run.snapshot.delivery.targetIds) {
      if (targetId === skip) continue;
      let target: RoutineDeliveryTarget;
      try {
        target = await deps.routines.target(scopeOf(run), targetId);
      } catch {
        continue;
      }
      const destination = deps.messaging.buildDestination(target.connectionId, { to: target.chatId });
      if (destination === undefined) return false;
      try {
        const outcome = await deps.messaging.send({
          effectId,
          workspaceId: run.workspaceId,
          connectionId: target.connectionId,
          destination,
          parts: [{ kind: "text", content: text }],
        });
        if (outcome.status === "accepted") return true;
        logSendFailure(effectId, "a routine notice was not accepted by its channel; posting it to Home", {
          routineId: run.routineId,
          targetId,
          status: outcome.status,
        });
      } catch (error) {
        logSendFailure(effectId, "a routine notice could not be sent; posting it to Home", {
          routineId: run.routineId,
          targetId,
          error: errorMessage(error),
        });
      }
      return false;
    }
    return undefined;
  };

  /**
   * Told when the channel accepted it or it is in Home; also done when there
   * was neither a target to send to nor a Home to post into, since trying
   * again changes nothing.
   */
  const tell = async (
    run: RoutineRun,
    input: { readonly key: string; readonly title: string; readonly text: string; readonly skipTarget?: string },
  ): Promise<boolean> => {
    const sent = await sendToTarget(run, input.key, input.text, input.skipTarget);
    if (sent === true) return true;
    try {
      const posted = await deps.postHome({
        workspaceId: run.workspaceId,
        principalId: run.principalId,
        sourceKey: input.key,
        title: input.title,
        summary: input.text,
      });
      return posted || sent === undefined;
    } catch (error) {
      deps.log("a routine notice could not be posted to Home", { routineId: run.routineId, error: errorMessage(error) });
      return false;
    }
  };

  return {
    async runPaused(run, cause) {
      const name = await nameOf(run);
      const execution = run.snapshot.execution;
      const text =
        cause === "expired"
          ? `Routine “${name}”: its run due ${run.scheduledFor ?? run.claimedAt} expired before it could finish (the owner was asleep, stopped or busy), so it made no report. The next scheduled run tries again.`
          : cause === "credential-grace"
            ? `Routine “${name}” paused: its model or search credential has been rejected for over ${execution.credentialGraceHours} hours. Fix the key in Settings, then resume it. ${RESUME_HINT}`
            : `Routine “${name}” paused after ${execution.failureThreshold} failed runs in a row; its run history says why. ${RESUME_HINT}`;
      return tell(run, {
        key: `routine-notice:${run.runId}:${cause}`,
        title: cause === "expired" ? `Routine “${name}” run expired` : `Routine “${name}” paused`,
        text,
      });
    },

    async deliveryPaused(run, targetId, cause) {
      const name = await nameOf(run);
      const label = await labelOf(run, targetId);
      const why =
        cause === "credential-grace"
          ? `its channel's credentials have been missing for over ${run.snapshot.execution.credentialGraceHours} hours`
          : `${run.snapshot.execution.failureThreshold} sends failed in a row`;
      const fix =
        cause === "credential-grace"
          ? "Reconnect the channel and delivery resumes on its own"
          : "Fix the channel, then resume delivery on the run's deliveries in Center → Schedule, or resume the routine";
      return tell(run, {
        key: `routine-notice:${run.runId}:delivery:${targetId}:${cause}`,
        title: `Routine “${name}” delivery paused`,
        text: `Routine “${name}”: delivery to “${label}” paused because ${why}. Research keeps running and reports stay in the app. ${fix}.`,
        // The target that paused is the one channel this notice cannot rely on.
        skipTarget: targetId,
      });
    },
  };
}
