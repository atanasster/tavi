import {
  CENTER_APPS_LIMIT,
  CENTER_SUMMARY_DEFAULT_DAYS,
  CENTER_WATCH_DEFAULT_TIMEOUT_MS,
  CENTER_WATCH_INTERVAL_MS,
  DEFAULT_WORKSPACE_ID,
  TaviError,
  hostTimeZone,
  localeOf,
  type CenterPayload,
  type CenterSummaryAnswer,
  type CenterWatchAnswer,
  type MemoryServicePort,
  type PersistencePort,
} from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";

import { refusalFrom, type IpcAnswer } from "../shared/ipc-decisions.js";

/**
 * `center`: the Command Center's first paint and
 * its change feed. Read-only, so a page may call it through the bridge.
 */
export interface CenterDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "center" | "workspaceSettings">;
  /** The owner's memory service: the rail's proposal count is its `counts`; the center repository reads no memory. */
  readonly memory: Pick<MemoryServicePort, "counts">;
  /** The operator principal a workspace is served for, or undefined for one this owner does not serve. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly now: () => Date;
  /**
   * Aborted when the request's connection closes or the owner starts to shut
   * down: a watch then answers at once rather than holding either up.
   */
  readonly signal?: AbortSignal;
  /**
   * The workspace's Connected apps repairs, worst first; absent, the
   * summary carries none and a page falls back to `reconnect` and `servers`.
   */
  readonly appRepairs?: (workspaceId: string) => Promise<NonNullable<CenterSummaryAnswer["apps"]> | undefined>;
  /** The owner's health warnings (`features/doctor/health.ts`): sustained growth, none while healthy. */
  readonly healthWarnings?: () => readonly string[];
  /**
   * The store's write signal (`DatabaseClient.onWrite`): a waiting watch reads
   * the fingerprints again when something is written — the Center's versions
   * move by triggers and direct bumps inside writes — rather than every second.
   * Absent, it reads every `intervalMs`.
   */
  readonly onWrite?: (listener: (operation: string) => void) => () => void;
  /** The least wait between fingerprint reads (with no write signal, the wait); a test shortens it. */
  readonly intervalMs?: number;
}

/** With a write signal, how long a waiting watch goes without reading when nothing is written: a change made outside this owner's store. */
const CENTER_WATCH_FALLBACK_MS = 15_000;

export type CenterAnswer = IpcAnswer<CenterSummaryAnswer | CenterWatchAnswer>;

export async function centerCommand(deps: CenterDependencies, payload: CenterPayload): Promise<CenterAnswer> {
  try {
    const workspaceId = payload.workspaceId ?? DEFAULT_WORKSPACE_ID;
    // As `workspace-settings`: a workspace this owner does not serve would
    // otherwise answer an empty, plausible-looking summary.
    const principalId = deps.principalOf(workspaceId);
    if (principalId === undefined) {
      throw new TaviError("NOT_FOUND", `workspace ${workspaceId} is not configured on this owner`, { details: { workspaceId } });
    }
    const center = deps.repositories.center;
    if (payload.action === "watch" && payload.cursor !== undefined && deps.onWrite !== undefined) {
      return { ok: true, result: await watchWrites(deps, deps.onWrite, workspaceId, principalId, payload.cursor, payload.timeoutMs) };
    }
    if (payload.action === "summary") {
      // The effective zone, resolved per call as the runtime facts resolve it,
      // so a `tavi config set workspace.timezone` moves "today" at once.
      const { settings } = await deps.repositories.workspaceSettings.get(workspaceId);
      const timezone = settings.timezone ?? hostTimeZone();
      const { proposed } = await deps.memory.counts({ actor: { principalId, workspaceId, caller: "center", authority: "operator" } });
      const result = await center.summary({
        workspaceId,
        principalId,
        timezone,
        days: payload.days ?? CENTER_SUMMARY_DEFAULT_DAYS,
        now: deps.now().toISOString(),
        memoryProposals: proposed,
      });
      const apps = await deps.appRepairs?.(workspaceId);
      const health = deps.healthWarnings?.() ?? [];
      return {
        ok: true,
        result: {
          ...result,
          locale: localeOf(settings),
          ...(apps === undefined ? {} : { apps: apps.slice(0, CENTER_APPS_LIMIT) }),
          ...(health.length === 0 ? {} : { health: [...health] }),
        },
      };
    }
    const first = await center.changes({ workspaceId, principalId, ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }) });
    if (payload.cursor === undefined || first.changed.length > 0) return { ok: true, result: first };
    // Each read is one short worker call, and the wait between reads is a
    // timer, so a waiting watch holds neither the worker nor the other
    // requests on its connection.
    // Elapsed time, not the owner's clock: the wait is a transport bound.
    const deadline = performance.now() + (payload.timeoutMs ?? CENTER_WATCH_DEFAULT_TIMEOUT_MS);
    const interval = deps.intervalMs ?? CENTER_WATCH_INTERVAL_MS;
    const aborted = (): boolean => deps.signal?.aborted === true;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || aborted()) break;
      await sleep(Math.min(interval, remaining), deps.signal, { onAbort: "resolve" });
      if (aborted()) break;
      const next = await center.changes({ workspaceId, principalId, cursor: payload.cursor });
      if (next.changed.length > 0) return { ok: true, result: next };
    }
    // Nothing changed: the cursor sent is still current.
    return { ok: true, result: { cursor: payload.cursor, changed: [] } };
  } catch (error) {
    return refusalFrom(error);
  }
}

/**
 * A watch woken by writes: subscribed before its first read, so a write that
 * lands between two reads is never missed. Each read is one short worker call,
 * so a waiting watch holds neither the worker nor the other requests on its
 * connection; reads are at least `intervalMs` apart while writes keep coming.
 */
async function watchWrites(
  deps: CenterDependencies,
  onWrite: NonNullable<CenterDependencies["onWrite"]>,
  workspaceId: string,
  principalId: string,
  cursor: string,
  timeoutMs: number | undefined,
): Promise<CenterWatchAnswer> {
  const center = deps.repositories.center;
  // Elapsed time, not the owner's clock: the wait is a transport bound.
  const deadline = performance.now() + (timeoutMs ?? CENTER_WATCH_DEFAULT_TIMEOUT_MS);
  const spacing = deps.intervalMs ?? CENTER_WATCH_INTERVAL_MS;
  const aborted = (): boolean => deps.signal?.aborted === true;
  let written = false;
  let wake: (() => void) | undefined;
  const release = onWrite(() => {
    written = true;
    wake?.();
  });
  try {
    for (;;) {
      written = false;
      const readAt = performance.now();
      const next = await center.changes({ workspaceId, principalId, cursor });
      if (next.changed.length > 0) return next;
      if (!written) {
        const wait = Math.min(CENTER_WATCH_FALLBACK_MS, deadline - performance.now());
        if (wait > 0 && !aborted()) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              clearTimeout(timer);
              deps.signal?.removeEventListener("abort", done);
              wake = undefined;
              resolve();
            };
            const timer = setTimeout(done, wait);
            deps.signal?.addEventListener("abort", done);
            wake = done;
          });
        }
      }
      const remaining = deadline - performance.now();
      // A timer can fire a fraction of a millisecond short of its time: that is the deadline, not a reason to read again.
      if (remaining < 1 || aborted()) break;
      const early = readAt + spacing - performance.now();
      if (early > 0) await sleep(Math.min(early, remaining), deps.signal, { onAbort: "resolve" });
      if (aborted() || deadline - performance.now() <= 0) break;
    }
  } finally {
    release();
  }
  // Nothing changed: the cursor sent is still current.
  return { cursor, changed: [] };
}
