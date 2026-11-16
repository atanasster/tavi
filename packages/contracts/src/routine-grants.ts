import { z } from "zod";
import { RoutineNetworkModeSchema, type RoutineNetworkMode } from "./routine-egress.js";

/**
 * Durable per-run authority for a scheduled routine.
 *
 * R0 spike 1 recorded FAIL for unattended parent→worker grant propagation: the
 * prototype read authority from the adapter instance that happened to build the
 * worker, so a resumed or re-admitted worker could carry a policy that no longer
 * described its run. A grant is therefore an *immutable snapshot pinned to a run
 * id and persisted with the run*, and every effect re-resolves it from storage
 * rather than trusting the caller's in-memory copy.
 */
export const RoutineGrantSchema = z.strictObject({
  version: z.literal(1),
  grantId: z.string().min(1).max(128),
  /** The run this grant describes. A worker holding a different run's grant is refused. */
  runId: z.string().min(1).max(128),
  routineId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  principalId: z.string().min(1).max(128),
  /** Routine revision whose snapshot the grant was pinned from; must equal the run's. */
  revision: z.number().int().positive(),
  /** `permissions.revision` of that snapshot, so a policy change is visible in the ledger. */
  policyRevision: z.number().int().positive(),
  /**
   * The run's mode. Preview and production runs have separate grants so a
   * preview can never inherit (or spend) a production run's authority.
   */
  mode: z.enum(["production", "preview"]),
  /**
   * The run's pinned `permissions.researchTools`. The effective research set is
   * this ∩ the run's snapshot policy ∩ the adapter's own grantable tools
   * (`web_search`, `http.request`) — a tool listed here that the adapter does not
   * expose is *not* usable, and `effectiveGrantPolicy` reports the effective set
   * rather than this one.
   */
  researchTools: z.array(z.string().min(1).max(128)).max(20),
  /**
   * The run's pinned `permissions.allowedHosts`, read with the operator's own
   * allowlist language (exact, `*.suffix` and `host:port` entries) by the same
   * predicate the HTTP tool uses.
   */
  allowedHosts: z.array(z.string().min(1).max(253)).max(100),
  /**
   * The run's pinned `permissions.networkMode`. Widening is an operator edit
   * recorded here, so the ledger can show which egress policy a fetch ran under.
   */
  networkMode: RoutineNetworkModeSchema,
  /**
   * `ROUTINE_PRIMARY_SOURCE_POLICY.version` when the pinned mode is
   * `primary_sources`, absent otherwise.
   *
   * The curated list is policy, not configuration: editing its hosts changes what
   * an already-admitted run may reach, so the version is pinned into the hashed
   * grant rather than read from the live constant. A reader comparing this with
   * `ROUTINE_PRIMARY_SOURCE_POLICY.version` can then tell that the list moved
   * since the grant was written.
   */
  primarySourcePolicyVersion: z.number().int().positive().optional(),
  /**
   * Destination allowlist, mirroring the revision's `delivery.targetIds` as
   * pinned at admission, and resolved at delivery dispatch. The revision caps
   * this at one target today (a deliberate product narrowing); the bound
   * here deliberately does not repeat that cap, because the delivery loop and
   * the health map are written for many and the grant should never be the reason
   * a supported shape is refused.
   */
  destinationIds: z.array(z.string().min(1).max(128)).max(100),
  createdAt: z.string().datetime(),
});
export type RoutineGrant = z.infer<typeof RoutineGrantSchema>;

/**
 * Why an effect was refused. Every one fails closed; none waits for an approval.
 *
 * The refusals are deliberately distinct rather than one `grant-revoked`: an
 * operator reading the ledger needs to tell "someone revoked this run" from
 * "the workspace's authority changed under a still-pinned grant", and a host the
 * grant never named from a tool it never scoped. There is no
 * `step-outside-grant`: step authority is the run's own pinned snapshot policy,
 * not a separate grant list, so no code path could emit it. There is likewise no
 * `host-narrowed-by-policy`: the grant copies `permissions.allowedHosts` verbatim
 * from the run's immutable snapshot, so a host cannot be inside one list and
 * outside the other, and a code that said otherwise would only ever record a
 * refusal the pinned list had already produced.
 */
export const ROUTINE_GRANT_DENIALS = [
  "grant-absent",
  "grant-mismatch",
  "grant-scope-mismatch",
  "grant-revoked",
  "authority-withdrawn",
  "tool-outside-grant",
  "host-outside-grant",
  "destination-outside-grant",
] as const;
export type RoutineGrantDenial = (typeof ROUTINE_GRANT_DENIALS)[number];

export type RoutineGrantResolution =
  | { readonly allowed: true; readonly grant: RoutineGrant }
  | { readonly allowed: false; readonly code: RoutineGrantDenial; readonly detail: string };

/** The effective, intersected view an operator sees in the run inspector. */
export interface RoutineGrantView {
  readonly grantId: string;
  readonly policyRevision: number;
  readonly revision: number;
  readonly mode: "production" | "preview";
  /** The pinned egress policy (`allowlist` | `primary_sources` | `custom_hosts` | `open_web`). */
  readonly networkMode: RoutineNetworkMode;
  readonly researchTools: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly destinationIds: readonly string[];
  readonly createdAt: string;
  readonly revokedAt: string | null;
  /** Why it was revoked, in the operator's words; `null` while the grant is live. */
  readonly revokedReason: string | null;
  /**
   * Tools the grant pinned that no research path exposes, so they are reported as
   * narrowed rather than as usable. There is no host counterpart: the pinned host
   * list is the run's own snapshot list, so it can never narrow against itself.
   */
  readonly narrowedTools: readonly string[];
  /**
   * `ROUTINE_PRIMARY_SOURCE_POLICY.version` the grant was admitted under, when its
   * mode is `primary_sources`; absent for every other mode. Comparing it with the
   * live constant is how a reader tells that the curated list changed underneath
   * an already-pinned grant.
   */
  readonly primarySourcePolicyVersion?: number;
}
