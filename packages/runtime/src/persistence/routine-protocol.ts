import type { RoutineEvaluationStore } from "./routine-evaluation-store.js";
import type { RoutineWorkerConfiguration } from "./routine-configuration.js";
import type { RoutineService } from "../routines/service.js";
import type { RoutineExecutionService } from "../routines/runs.js";
import type { RoutineNewsOptions, RoutineNewsService } from "../routines/news.js";
import type { RoutinePublicationService } from "../routines/publication.js";
import type { RoutineDeliveryService } from "../routines/delivery.js";
import type { RpcOperations } from "./rpc.js";

/** The worker's routine services an operation reaches, by group. */
export interface RoutineWorkerServices {
  readonly quality: RoutineEvaluationStore;
  readonly routines: RoutineService;
  readonly runs: RoutineExecutionService;
  readonly news: RoutineNewsService;
  readonly publication: RoutinePublicationService;
  readonly delivery: RoutineDeliveryService;
}

/**
 * Every routine method the worker serves as it is, by group: one table drives
 * the owner's facades (`routine-facades.ts`) and the worker's dispatch
 * (`routine-handlers.ts`). `publication.publish`, which the worker hands its
 * own delivery service, is sent by hand.
 */
export const ROUTINE_METHODS = {
  quality: ["recover", "pending", "setupNeeded", "cached", "claim", "save", "owner"],
  routines: [
    "get",
    "list",
    "modelsInUse",
    "ownerOf",
    "owners",
    "revisions",
    "deliveryReadiness",
    "create",
    "update",
    "createAgentRevision",
    "finishEvaluation",
    "setStatus",
    "target",
    "standingAnswerFor",
    "putTarget",
    "scheduleOwner",
    "scheduleOwners",
    "consumeOneOff",
    "raiseLegacyModelCalls",
  ],
  runs: [
    "get",
    "history",
    "resolveGrant",
    "assertGrant",
    "assertGrantForRun",
    "recordEgressDenial",
    "grantFor",
    "effectiveGrantPolicy",
    "revokeGrant",
    "claim",
    "request",
    "settleRunWaits",
    "start",
    "assertFence",
    "remainingMs",
    "beginStep",
    "excuseStepWait",
    "bindTask",
    "pruneDueDetails",
    "pruneDueSnapshots",
    "serviceHeartbeat",
    "heartbeat",
    "reserveModel",
    "knownRetired",
    "recordRetirement",
    "settleModel",
    "reserveControlTool",
    "reserveTool",
    "finish",
    "cancel",
    "recoverPreviousOwner",
    "pendingPauses",
    "acknowledgePause",
    "interrupt",
    "stateVersion",
    "pending",
    "append",
    "ledger",
    "detail",
    "verify",
    "pruneDetails",
  ],
  news: ["sources", "capture", "window", "prepareWindow", "pruneEvidence", "select"],
  publication: ["get", "stage", "reclaimForCapacity", "discardOptionalPdf", "recoverStages", "publishedReports", "prune"],
  delivery: [
    "get",
    "list",
    "enqueue",
    "resumeTarget",
    "reconcileReceipts",
    "pendingJobs",
    "claimDelivery",
    "acknowledgeDeliveryPause",
    "settleDelivery",
    "resend",
  ],
} as const satisfies { readonly [G in keyof RoutineWorkerServices]: readonly (keyof RoutineWorkerServices[G] & string)[] };

type Async<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

/** The owner's view of the table's methods: each answers through the worker. */
export type RoutinePort = {
  readonly [G in keyof typeof ROUTINE_METHODS]: {
    [M in (typeof ROUTINE_METHODS)[G][number] & keyof RoutineWorkerServices[G]]: Async<RoutineWorkerServices[G][M]>;
  };
};

/** What a routine operation carries beside its argument tuple. */
export interface RoutineEnvelope {
  readonly toolPermissions?: RoutineWorkerConfiguration["toolPermissions"];
  readonly now?: string;
  readonly ownerEpoch?: string;
  readonly news?: RoutineNewsOptions;
}

type Enveloped<T> = {
  [K in keyof T]: T[K] extends { input: infer I; output: infer O } ? { input: RoutineEnvelope & { args: I }; output: O } : never;
};

export type RoutineOperations = Enveloped<RpcOperations<"routine", RoutinePort>> & {
  "routine.configure": { input: RoutineWorkerConfiguration; output: void };
  "routine.publication.publish": {
    input: {
      args: [
        Parameters<RoutinePublicationService["publish"]>[0],
        Parameters<RoutinePublicationService["publish"]>[1],
        number,
        (string | null)?,
      ];
      now?: string;
    };
    output: ReturnType<RoutinePublicationService["publish"]>;
  };
  "routine.control": {
    input: {
      payload: import("@tavi/contracts").RoutinesPayload;
      now?: string;
      control?: {
        defaultModels: import("@tavi/contracts").RoutineSnapshot["models"] | undefined;
        allowedHosts: readonly string[];
        renderer: { available: boolean; provider: string } | undefined;
        /** The workspace's language, for a routine created from a setup. */
        language?: import("@tavi/contracts/i18n").Locale;
      };
    };
    output: unknown;
  };
  "routine.skillContext": {
    input: { scope: import("@tavi/contracts").RoutineScope; pins: import("@tavi/contracts").RoutineSnapshot["skills"] };
    output: string;
  };
};
