import { z } from "zod";
const id = z.string().min(1).max(128);
const instant = z.string().datetime();
const url = z
  .string()
  .url()
  .max(2048)
  .regex(/^https:\/\//);
export const RoutineNewsSourceSchema = z
  .strictObject({
    version: z.literal(1),
    sourceId: id,
    runId: id,
    workspaceId: id,
    originalUrl: url,
    finalUrl: url,
    canonicalUrl: url,
    publisher: z.string().min(1).max(253),
    title: z.string().max(300),
    state: z.enum(["fetched", "snippet", "failed"]),
    retrievedAt: instant,
    prunedAt: instant.nullable().optional(),
    publishedAt: instant.nullable(),
    updatedAt: instant.nullable(),
    excerpt: z.string().max(16_000),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    byteSize: z.number().int().nonnegative().nullable(),
    redirects: z.array(url).max(5),
    /**
     * How the destination was authorized, as provenance rather than a claim:
     * `allowlist` means the name was on the operator's list (`http.request`);
     * `public` means the *address* was classified and pinned (`web_fetch`).
     * Absent on older rows, which is why it is optional.
     */
    addressClass: z.enum(["allowlist", "public"]).nullable().optional(),
    /**
     * Why a `failed` source is not evidence: the response was an HTTP error, or
     * its content was truncated. Absent on older rows and on other failures.
     */
    failureReason: z.enum(["http_status", "truncated"]).optional(),
    /**
     * The plugin read whose result named it: `plugin:<toolId>`, for a
     * source an external plugin's granted read returned in `routineSources`.
     * Absent on a source Tavi's own tools fetched.
     */
    adapter: z
      .string()
      .regex(/^plugin:[a-z][a-z0-9._-]{0,127}$/)
      .optional(),
  })
  .refine(
    (source) => source.state !== "fetched" || (source.contentHash !== null && source.byteSize !== null),
    "fetched evidence requires a content hash and byte count",
  );
export type RoutineNewsSource = z.infer<typeof RoutineNewsSourceSchema>;
export const RoutineNewsCandidateSchema = z.strictObject({
  title: z.string().min(1).max(160),
  releaseIdentity: z.string().min(2).max(128),
  eventKind: z.enum(["release", "update", "evaluation", "availability"]),
  claims: z
    .array(z.strictObject({ text: z.string().min(10).max(800), sourceId: id }))
    .min(1)
    .max(3),
});
export const RoutineNewsSelectionSchema = z.strictObject({ stories: z.array(RoutineNewsCandidateSchema).max(20) });
export type RoutineNewsSelection = z.infer<typeof RoutineNewsSelectionSchema>;
export interface RoutineNewsStory extends z.infer<typeof RoutineNewsCandidateSchema> {
  readonly storyId: string;
  readonly dedupKey: string;
  readonly sourceIds: readonly string[];
  readonly caveats: readonly string[];
  readonly independentlyCorroborated: boolean;
}
/** At most this many stories a routine already reported are named to its next run's research and synthesis. */
export const ROUTINE_REPORTED_LIMIT = 30;
/** A story a routine already reported, as its next run is told of it: words its sources gave, so untrusted. */
export interface RoutineReportedStory {
  readonly title: string;
  readonly releaseIdentity: string;
}
/**
 * One reported story in a routine's dedup memory (`state.dedup`). `title` and `releaseIdentity` are absent on
 * rows written before they were kept, which still suppress a repeat by `key` and are simply not named to a run.
 */
export interface RoutineDedupEntry extends Partial<RoutineReportedStory> {
  readonly key: string;
  readonly at: string;
}
/** A run's coverage window, pinned on the run when its research begins. */
export interface RoutineNewsWindow {
  readonly from: string;
  readonly to: string;
  readonly hours: number;
  readonly gaps: string[];
  /**
   * The routine's most recently reported stories still inside its dedup window, oldest first and at most
   * `ROUTINE_REPORTED_LIMIT`. Absent on a window pinned before it was kept, or when nothing was reported.
   */
  readonly reported?: readonly RoutineReportedStory[];
}
export interface RoutineNewsReport {
  readonly version: 1;
  readonly runId: string;
  readonly routineId: string;
  readonly revision: number;
  readonly generatedAt: string;
  readonly mode: "production" | "preview";
  readonly title: string;
  readonly stories: readonly RoutineNewsStory[];
  readonly sources: readonly RoutineNewsSource[];
  readonly coverage: {
    readonly from: string;
    readonly to: string;
    readonly searched: number;
    readonly fetched: number;
    readonly failed: number;
    readonly widened: boolean;
    readonly gaps: readonly string[];
  };
  readonly quiet: boolean;
  readonly suppressed: boolean;
  readonly degraded: boolean;
  readonly rejected: number;
  readonly duplicates: number;
  /**
   * Why a proposed story was not published. Optional so a report written
   * before this field existed still parses, and present whenever something was
   * suppressed — an unexplained omission is what an operator cannot act on.
   */
  readonly suppressions?: readonly { readonly releaseIdentity: string; readonly reason: string }[];
}
export type RoutineDeliveryStatus =
  | "pending"
  | "deferred"
  | "dispatching"
  | "accepted"
  | "failed"
  | "uncertain"
  | "suppressed"
  | "cancelled"
  | "expired";
export interface RoutineDeliveryJob {
  readonly jobId: string;
  readonly runId: string;
  readonly effectId: string;
  readonly status: RoutineDeliveryStatus;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly data: {
    readonly artifactId: string;
    readonly hash: string;
    readonly targetId: string;
    readonly target: import("./routines.js").RoutineDeliveryTarget;
    readonly generation: number /** Sent as text in place of the PDF, when the run published none. */;
    readonly text?: string;
    readonly providerMessageIds?: readonly string[];
    readonly error?: string;
    readonly resendOf?: string;
  };
}
