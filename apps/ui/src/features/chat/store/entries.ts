import { CLIENT_TIMEOUT, type ClientResponse, initialRunState, type RunState } from "@tavi/client/browser";

import type { StoreContext } from "./context.js";
import { without } from "./runs.js";
import type { CanvasRun } from "./types.js";

/** The page's entries: found, changed, failed, and the task the next prompt continues. */
export function installEntries(ctx: StoreContext): void {
  const { options, conversations } = ctx;
  /** The page's last task, kept for a reload: a failure to keep it only costs that. */
  const remember = (taskId: string): void => {
    const conversationId = conversations.get(taskId);
    if (conversationId === undefined) return;
    try {
      options.memory?.save({ taskId, conversationId });
    } catch {
      // Storage refused: a reload starts afresh, as it did before.
    }
  };
  /** Task `taskId` finished as the page's last prompt: the next prompt continues it — first, a prompt queued behind it. */
  const settles = (id: string, taskId: string): void => {
    if (ctx.sendQueued(taskId)) return;
    if (ctx.state.runs.at(-1)?.id !== id) return;
    ctx.settled = taskId;
    remember(taskId);
    ctx.publish(ctx.state);
  };
  const find = (id: string): CanvasRun | undefined => ctx.state.runs.find((run) => run.id === id);
  const update = (id: string, change: (run: CanvasRun) => CanvasRun, urgent = true): void =>
    ctx.publish({ ...ctx.state, runs: ctx.state.runs.map((run) => (run.id === id ? change(run) : run)) }, urgent);
  const failed = (id: string, error: string): void =>
    update(id, (run) => ({ ...without(run, "notice"), error, deciding: undefined, aborting: false }));
  /** The chat an entry belongs to: its task, or the one it continues. */
  const chatOf = (run: CanvasRun): string | undefined => run.run.taskId ?? run.continues;
  /**
   * Plugins' status lines taken off the entries `which` picks: `pluginId`'s,
   * or every one. For lines the page can no longer trust: a chat's
   * stream is followed only while its turn runs, so a clear published between
   * turns — a plugin disabled, an owner restarted — reaches no stream, and
   * the merged line (`chatPluginStatus`) would stay.
   */
  const dropStatus = (which: (run: CanvasRun) => boolean, pluginId?: string): void => {
    let changed = false;
    const runs = ctx.state.runs.map((run) => {
      const lines = Object.entries(run.run.pluginStatus);
      const kept = pluginId === undefined ? [] : lines.filter(([id]) => id !== pluginId);
      if (kept.length === lines.length || !which(run)) return run;
      changed = true;
      return { ...run, run: { ...run.run, pluginStatus: Object.fromEntries(kept) } };
    });
    if (changed) ctx.publish({ ...ctx.state, runs });
  };
  /** A new entry on the page. */
  const entry = (
    id: string,
    prompt: string,
    extra: {
      readonly continues?: string;
      readonly run?: RunState;
      readonly restored?: boolean;
      readonly queued?: boolean;
      readonly toHome?: boolean;
      readonly carriesFiles?: true;
      readonly fileNames?: readonly string[];
    } = {},
  ): CanvasRun => ({
    id,
    prompt,
    run: initialRunState(),
    roundCalls: {},
    deciding: undefined,
    aborting: false,
    ...extra,
  });
  /**
   * Send, and once more if the first send timed out: a timed-out request may
   * still have been recorded, and the same message id (or wait) is the same
   * message, so the second cannot be a duplicate. Not again once disposed.
   */
  const sendOnceMore = async (
    send: () => Promise<ClientResponse>,
  ): Promise<{ readonly response: ClientResponse; readonly retried: boolean }> => {
    const first = await send();
    if (ctx.disposed || first.ok || first.error?.code !== CLIENT_TIMEOUT) return { response: first, retried: false };
    return { response: await send(), retried: true };
  };
  Object.assign(ctx, { remember, settles, find, update, failed, chatOf, dropStatus, entry, sendOnceMore } satisfies Partial<StoreContext>);
}
