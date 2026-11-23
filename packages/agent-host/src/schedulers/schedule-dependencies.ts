import type {
  AdmissionResult,
  ArtifactRepositoryPort,
  EffectRepositoryPort,
  ExecutionRepositoryPort,
  MessagingServicePort,
  ProviderFailureClass,
  SchedulePrecheck,
  SchedulePrecheckResult,
  SchedulePrecheckState,
  ScheduleRecord,
  ScheduleRepositoryPort,
  TextRef,
  WorkflowPort,
} from "@tavi/contracts";
import type { CoreT } from "@tavi/contracts/locales/core";

import type { InFlightFireRegistry } from "./in-flight.js";

export interface ScheduleSchedulerDependencies {
  /** Routine-owned rows dispatch before a plain schedule's recurring math or policy. */
  readonly routineDispatch?: (schedule: ScheduleRecord, fireTime: string, manual: boolean) => Promise<FireOutcome | undefined>;
  readonly routineSweep?: () => Promise<void>;
  readonly schedules: ScheduleRepositoryPort;
  readonly executions: ExecutionRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  /**
   * Copies an artifact the fire's policy approved into its chat's folder — a
   * download into `downloads/`. It never
   * throws, and does nothing for an artifact that is not copied.
   */
  readonly materializeArtifact?: (artifactId: string) => Promise<unknown>;
  readonly workflow: WorkflowPort;
  /**
   * Absent when no messaging connector is configured: failure alerts then go to
   * Home (`alertHome`).
   *
   * Narrowed to `send`, the one method the scheduler uses: a real
   * `MessagingServicePort` is still assignable, while a test double needs only the
   * method under test — and it is typed rather than cast, so a change to that
   * method's signature is a compile error instead of silent drift.
   */
  readonly messaging?: Pick<MessagingServicePort, "send">;
  /**
   * The effect ledger, used to tell "the run completed" from "the brief arrived".
   *
   * They are not the same: a run can finish cleanly having never called
   * `messaging.send_to`, which is exactly the silence that is the worst
   * outcome. Without this port the check is skipped and the fire is reported as a
   * plain success.
   */
  readonly effects?: Pick<EffectRepositoryPort, "listForTask">;
  /**
   * What the providers under a run's task reported once its turn ended
   * (`ProviderFailureLog.take`). A run that failed on provider weather
   * (`transient`) and did nothing with an effect has its fire tried again
   * (`SCHEDULE_RETRY_BACKOFF_MINUTES`). Absent: no run is tried again.
   */
  readonly providerFailure?: (taskId: string) => ProviderFailureClass | undefined;
  /**
   * Free bytes on the data directory's filesystem, or `undefined` when the
   * deployment did not provide a probe (tests, an in-memory store).
   *
   * Injected rather than read here so the policy is testable without a full disk,
   * and so this package keeps no filesystem dependency of its own.
   */
  readonly freeBytes?: () => number | undefined;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  readonly log: (event: { readonly level: "info" | "warn" | "error"; readonly message: string; readonly detail?: unknown }) => void;
  /**
   * Where a fire records the task it is deciding, so the owner can refuse an
   * operator's decision for that task's round while the fire lives.
   * Absent in a process that answers no decisions of its own.
   */
  readonly inFlight?: InFlightFireRegistry;
  /**
   * Whether a run's task has yet to hear from a worker it spawned
   * (`AgentCommunicationServicePort.workersOutstanding`): a run whose turn
   * ended so is not over, since it is woken to read the worker's result.
   * Absent: never.
   */
  readonly workersOutstanding?: (taskId: string) => Promise<boolean>;
  /**
   * Whether a held run will not go on by itself: its task is gone, cancelled
   * or failed, or ended with no worker left to hear from. Absent: a hold ends
   * only by its continuation or its `until`.
   */
  readonly runEnded?: (taskId: string) => Promise<boolean>;
  /**
   * How a schedule that pins a host folder (`ScheduleRecord.folder`) gets it: checked before its run's task exists,
   * a refusal failing the fire, saying why, and made that task's primary folder once it does. Absent: a schedule
   * that pins one cannot start a run here.
   */
  readonly folders?: {
    /** The folder's real path, or a refusal naming why it can no longer be used. */
    check(path: string): string;
    /** Make it the run's task's primary folder; a task that already works there is left as it is. */
    begin(schedule: ScheduleRecord, taskId: string, path: string): Promise<void>;
  };
  /**
   * Post a completed run's result into its schedule's person's Home as a
   * notice, for a schedule whose `deliverTo` is `home`; true when it was
   * posted, false with no Home or `chat.home` off. A failed or waiting run is
   * not posted: its alert tells Home instead. Absent: never posted.
   */
  readonly deliverHome?: (schedule: ScheduleRecord, admission: AdmissionResult) => Promise<boolean>;
  /**
   * Post an alert as a notice in the schedule's person's Home, for a schedule
   * with no alert target (a chat-created one cannot have one), no messaging
   * connector to send it on, or a target that refused it or could not be
   * reached; true when it is there. Posted once per
   * `sourceKey`, so an alert raised again for the same cause — a fire kept due
   * on a full disk is refused every sweep — is not posted again. Absent: such
   * an alert is only logged.
   */
  readonly alertHome?: (
    schedule: ScheduleRecord,
    /** `ref`: the alert's words by key, where they are Tavi's: Home says them in its reader's language. */
    alert: { readonly sourceKey: string; readonly text: string; readonly ref?: TextRef },
  ) => Promise<boolean>;
  /** The words an alert to a chat app is said in: its workspace's language. Absent, English. */
  readonly channelWords?: (workspaceId: string) => Promise<CoreT>;
  /**
   * Stop a run that worked past its schedule's `maxRunMinutes`: cancel its
   * task and the workers it spawned, and settle the wait it is suspended on,
   * so neither the workflow nor its lease goes on. Absent: the turn in flight
   * is still aborted, and nothing else is stopped.
   */
  readonly cancelRun?: (schedule: ScheduleRecord, taskId: string, reason: string) => Promise<void>;
  /**
   * Make a schedule's pre-check (`SchedulePrecheck`) against its last reading:
   * read-only, no tool and no model. Never throws for a check that could not be
   * made — it answers `failed`. Absent: no pre-check is made, and every fire runs.
   */
  readonly precheck?: (
    schedule: ScheduleRecord,
    precheck: SchedulePrecheck,
    last: SchedulePrecheckState | undefined,
    signal: AbortSignal,
  ) => Promise<SchedulePrecheckResult>;
  /** Arms a timer, returning what disarms it. Absent: `setTimeout`, not keeping the process alive. */
  readonly setTimer?: (callback: () => void, ms: number) => () => void;
  /**
   * Milliseconds on a monotonic clock, which a run's budget measures its working
   * time by, as its timer counts: neither moves while the machine sleeps, nor
   * when the wall clock is set. Absent: `performance.now()`.
   */
  readonly monotonicMs?: () => number;
}

export type FireOutcome =
  | { readonly kind: "routine"; readonly runId: string; readonly status: import("@tavi/contracts").RoutineRunStatus }
  | {
      readonly kind: "ran";
      readonly taskId: string;
      readonly status: import("@tavi/contracts").AdmissionOutcome["status"];
      readonly finalText: string;
      /** Why a completed run's result for Home was not posted there. */
      readonly notPosted?: string;
    }
  | { readonly kind: "skipped"; readonly reason: "already-claimed" | "overlap" | "missed" | "unchanged" }
  | { readonly kind: "refused"; readonly reason: string };
