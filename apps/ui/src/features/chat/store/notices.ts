import { type ChatNotice, NoticeListResultSchema, NOTICES_LIST_DEFAULT } from "@tavi/contracts";

import type { StoreContext } from "./context.js";
import type { CanvasStore } from "./types.js";
import { WORKER_ROOTS_KEPT } from "./workers.js";

/** How many of one chat's notices the page holds: the newest, read over many polls and pages. */
const NOTICES_KEPT = 200;

/**
 * A chat's notices after a read, oldest first. A
 * notice is kept by its id, so a poll's newest few never evict an older one
 * the page read before — an epoch divider among earlier turns, a page's.
 * `window`: the read answered a chat's newest `limit` (`tasks notices`), so a
 * notice it should have named and did not — inside the span it covers — was
 * erased (`forget`) and goes; a transcript page's notices only add.
 */
export function mergeNotices(
  previous: readonly ChatNotice[],
  incoming: readonly ChatNotice[],
  window?: { readonly limit: number },
): readonly ChatNotice[] {
  const named = new Set(incoming.map((notice) => notice.noticeId));
  const floor = window === undefined ? undefined : incoming.length < window.limit ? "" : (incoming[0]?.createdAt ?? "");
  const kept = previous.filter((notice) => !named.has(notice.noticeId) && (floor === undefined || notice.createdAt < floor));
  return [...kept, ...incoming]
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => (a.notice.createdAt < b.notice.createdAt ? -1 : a.notice.createdAt > b.notice.createdAt ? 1 : a.index - b.index))
    .map(({ notice }) => notice)
    .slice(-NOTICES_KEPT);
}

/** A chat's notices, read and merged. */
export function installNotices(ctx: StoreContext): void {
  const { client, options } = ctx;
  /** An owner from before notices refused `tasks notices`: not asked again. */
  let noticesUnsupported = false;
  const noticeReads = new Map<string, number>();
  /** Merge a read of chat `taskId`'s notices into what the page holds (`mergeNotices`); publishes only a change. */
  const putNotices = (taskId: string, incoming: readonly ChatNotice[], window?: { readonly limit: number }): void => {
    const previous = ctx.state.notices?.[taskId];
    const merged = mergeNotices(previous ?? [], incoming, window);
    const same =
      previous !== undefined &&
      previous.length === merged.length &&
      previous.every(
        (notice, index) =>
          notice.noticeId === merged[index]?.noticeId &&
          notice.createdAt === merged[index]?.createdAt &&
          notice.summary === merged[index]?.summary &&
          notice.artifactId === merged[index]?.artifactId,
      );
    if (same) return;
    const kept = Object.entries(ctx.state.notices ?? {})
      .filter(([chat]) => chat !== taskId)
      .slice(-(WORKER_ROOTS_KEPT - 1));
    ctx.publish({ ...ctx.state, notices: { ...Object.fromEntries(kept), [taskId]: merged } });
  };
  const loadNotices: CanvasStore["loadNotices"] = async (taskId) => {
    if (noticesUnsupported || ctx.disposed) return;
    const generation = (noticeReads.get(taskId) ?? 0) + 1;
    noticeReads.set(taskId, generation);
    let answer;
    try {
      answer = await client.request("tasks", { action: "notices", workspaceId: options.workspaceId, taskId });
    } catch {
      return;
    }
    if (ctx.disposed || noticeReads.get(taskId) !== generation) return;
    if (!answer.ok) {
      if (answer.error?.code === "INVALID_INPUT") noticesUnsupported = true;
      return;
    }
    const listed = NoticeListResultSchema.safeParse(answer.result);
    if (!listed.success) return;
    putNotices(taskId, listed.data.notices, { limit: NOTICES_LIST_DEFAULT });
  };
  Object.assign(ctx, { putNotices, loadNotices } satisfies Partial<StoreContext>);
}
