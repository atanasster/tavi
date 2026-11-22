import type {
  RoutineDeliveryJob,
  RoutineDetail,
  RoutineGrantView,
  RoutineListTrigger,
  RoutineRecord,
  RoutineRun,
  RoutineRunEffortTotals,
  RoutineRunSummary,
  RoutinesPayload,
} from "@tavi/contracts";
import { readChunks } from "../../lib/chunks.js";
import { formatCount } from "../../lib/format.js";
import { formatElapsed } from "../../lib/time.js";
import { translateNow } from "../../lib/i18n.js";
import { ask, mapOutcome, withList, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/**
 * The canvas's side of the owner's `routines` family: one request shape, the
 * answers the routine pages read, and the few pure helpers its views share.
 * An answer the page cannot read is a failed outcome here, never a value a
 * view renders and trips over.
 */

/** A `routines` payload as the page sends it: the owner fills in the principal. */
export type RoutineRequest = Omit<Partial<RoutinesPayload>, "workspaceId" | "principalId"> & Pick<RoutinesPayload, "action">;

/**
 * A run as history lists it: without its snapshot and accounting, and (from an
 * owner on this build) with what it took and its report's headline — optional,
 * so an older owner's rows still read.
 */
export type RunSummary = Omit<RoutineRun, "snapshot" | "data"> &
  Partial<Pick<RoutineRunSummary, "durationMs" | "modelCalls" | "toolCalls" | "tokensKnown" | "headline">>;
/**
 * A `routines list` row: the record, its last run, and (from an owner on
 * this build) when it next fires and its triggers — optional, so an older
 * owner's rows still read.
 */
export type ListedRoutine = RoutineRecord & {
  readonly lastRun: RunSummary | null;
  readonly nextRunAt?: string | null;
  readonly triggers?: readonly RoutineListTrigger[];
  /** Its owner is no longer allowed in the workspace: it no longer runs, and can only be viewed or archived. */
  readonly ownerRevoked?: boolean;
};

export type RoutineOverviewData = RoutineDetail & {
  readonly schedules: readonly { readonly schedule_id: string; readonly next_run_at: string | null; readonly last_run_at: string | null }[];
  readonly state: unknown;
  readonly hostStatus: string;
  /** Its runs of the last seven days, summed; absent from an older owner. */
  readonly lastSevenDays?: RoutineRunEffortTotals;
  /** Present while no run of this revision has published a report: it has not been tried on its own topic yet. */
  readonly topicNotice?: string;
  /** The pins another author wrote (a chat's proposal, an outside archive): a run of this revision starts tainted. */
  readonly foreignSkills?: readonly { readonly skillId: string; readonly version: string; readonly source: "chat" | "archive" }[];
};

export interface RunInspection {
  readonly deliveryHealth?: Readonly<
    Record<string, { readonly failures: number; readonly blockedSince: string | null; readonly notified: boolean }>
  >;
  readonly grant?: RoutineGrantView | null;
  readonly effectivePolicy?: RoutineGrantView | null;
  readonly run: RoutineRun;
  readonly publication: {
    readonly reportArtifactId: string;
    readonly pdfArtifactId: string | null;
    readonly pdfError: string | null;
    readonly headline?: string;
  } | null;
  readonly deliveries: readonly RoutineDeliveryJob[];
  readonly attempts: readonly {
    readonly attempt_id: string;
    readonly generation: number;
    readonly status: string;
    readonly started_at: string;
    readonly ended_at: string | null;
  }[];
}

export interface DeliveryTarget {
  readonly targetId: string;
  readonly label: string;
  readonly authorized: boolean;
}

/** A retained ledger detail: its payload, or the time it was pruned. */
export interface LedgerDetail {
  readonly payload: string | null;
  readonly hash: string;
  readonly prunedAt: string | null;
}

export function routineRequest<T>(client: SettingsClient, workspaceId: string, input: RoutineRequest): Promise<Outcome<T>> {
  return ask<T>(client, "routines", { ...input, workspaceId }, { timeoutMs: null, refused: translateNow("routines.api.refused") });
}

/** A request whose answer carries a list under `field` (`withList`): one without it is a failure to read. */
export async function requestList<T extends object>(
  client: SettingsClient,
  workspaceId: string,
  input: RoutineRequest,
  field: keyof T & string,
  what: string,
): Promise<Outcome<T>> {
  return withList(await routineRequest<T>(client, workspaceId, input), field, what);
}

/**
 * Routine delivery targets (`routines targets`): the operator's, or — naming a
 * routine — that routine's owner's, a person's own from Allowed people included.
 * A reminder said in a chat picks from the operator's too.
 */
export async function listDeliveryTargets(
  client: SettingsClient,
  workspaceId: string,
  routineId?: string,
): Promise<Outcome<{ readonly targets: readonly DeliveryTarget[] }>> {
  // `ask`'s own 30 s deadline, as the reminders page has always waited, not the client's default.
  return withList(
    await ask<{ readonly targets: readonly DeliveryTarget[] }>(
      client,
      "routines",
      { action: "targets", workspaceId, ...(routineId === undefined ? {} : { routineId }) },
      { refused: translateNow("routines.api.refused") },
    ),
    "targets",
    translateNow("routines.api.deliveryTargets"),
  );
}

/** The most routines one list asks for; Schedule says when the list is cut off there. */
export const ROUTINES_LIMIT = 100;

/** How many runs, or revisions, one page of a routine's history asks for. */
export const ROUTINE_PAGE = 20;

/** The workspace's routines (at most `ROUTINES_LIMIT`). */
export function listRoutines(
  client: SettingsClient,
  workspaceId: string,
): Promise<Outcome<{ readonly routines: readonly ListedRoutine[] }>> {
  return requestList(client, workspaceId, { action: "list", limit: ROUTINES_LIMIT }, "routines", translateNow("routines.api.routines"));
}

/**
 * One step of a page action: ask the owner, hand a successful answer to
 * `then`, and end in the note `then` returns (or none), as `useAction` wants.
 */
export async function routineStep<T>(
  client: SettingsClient,
  workspaceId: string,
  input: RoutineRequest,
  then: (value: T) => string | undefined = () => undefined,
): Promise<Outcome<string | undefined>> {
  const answer = await routineRequest<T>(client, workspaceId, input);
  return mapOutcome(answer, (value) => then(value));
}

/** What a run took, as its row says it: its duration once it ended, and its tokens once a provider reported any. */
export function runEffort(run: Pick<RunSummary, "durationMs" | "tokensKnown">): readonly string[] {
  return [
    ...(run.durationMs === undefined || run.durationMs === null ? [] : [formatElapsed(run.durationMs)]),
    ...(run.tokensKnown === undefined || run.tokensKnown === 0
      ? []
      : [translateNow("routines.api.tokens", { tokens: formatCount(run.tokensKnown) })]),
  ];
}

/** A routine's runs over the last seven days, summed in one line. */
export function weekEffort(totals: RoutineRunEffortTotals): string {
  return [
    translateNow("routines.api.runs", { count: totals.runs }),
    ...(totals.durationMs > 0 ? [formatElapsed(totals.durationMs)] : []),
    translateNow("routines.api.modelCalls", { count: totals.modelCalls }),
    translateNow("routines.api.toolCalls", { count: totals.toolCalls }),
    translateNow("routines.api.tokens", { tokens: formatCount(totals.tokensKnown) }),
  ].join(" · ");
}

/** An idempotency key for one create, run or resend; a page without `randomUUID` (not a secure context) makes do with time and chance. */
export const operationKey = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const json = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * A fetched page's own URL as a link target, only when it is a web address:
 * sources come from the open web, and a `javascript:` or `data:` URL there
 * must render as text, never as something to click.
 */
export function webUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** A comma list, or `none`. */
export const listed = (items: readonly string[] | undefined): string =>
  items === undefined || items.length === 0 ? translateNow("routines.api.none") : items.join(", ");

type ArtifactChunk = {
  readonly artifactId: string;
  readonly contentType: string;
  readonly hash: string;
  readonly totalBytes: number;
  readonly offset: number;
  readonly base64: string;
  readonly nextOffset: number | null;
};

/** The largest report the page will assemble. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/**
 * A run's published report, read chunk by chunk and refused unless every chunk
 * belongs to the same artifact, the chunks tile it exactly, and the whole
 * matches its SHA-256.
 */
export async function readArtifact(
  client: SettingsClient,
  workspaceId: string,
  runId: string,
  kind: "json" | "pdf",
): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string }> {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let filled = 0;
  const last = await readChunks(
    (offset) => routineRequest<ArtifactChunk>(client, workspaceId, { action: "artifact", runId, artifactKind: kind, offset }),
    (chunk) => {
      if (chunk.totalBytes > MAX_ARTIFACT_BYTES || chunk.totalBytes < 1) return translateNow("routines.api.reportChanged");
      bytes ??= new Uint8Array(chunk.totalBytes);
      const part = Uint8Array.from(atob(chunk.base64), (character) => character.charCodeAt(0));
      if (
        part.length === 0 ||
        chunk.offset + part.length > bytes.length ||
        (chunk.nextOffset !== null && chunk.nextOffset !== chunk.offset + part.length)
      )
        return translateNow("routines.api.invalidChunk");
      bytes.set(part, chunk.offset);
      filled = chunk.offset + part.length;
      return undefined;
    },
    { changed: translateNow("routines.api.reportChanged") },
  );
  if (!last.ok) throw new Error(last.message);
  if (bytes === undefined || filled !== bytes.length) throw new Error(translateNow("routines.api.incomplete"));
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== last.value.hash) throw new Error(translateNow("routines.api.checksum"));
  return { bytes, type: last.value.contentType };
}
