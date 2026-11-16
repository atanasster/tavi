import type { StoreContext } from "./context.js";
import type { CanvasScheduler, CanvasState } from "./types.js";

/** How long ordinary updates coalesce before a repaint, when no frame comes (a hidden tab). */
const FLUSH_COALESCE_MS = 250;

/**
 * The longest an unbroken stream may go without a repaint. Checked when a
 * delta arrives, not on a timer of its own: it is the delta reaching the
 * ceiling that repaints, so a stream that has stopped waits for the frame or
 * the coalescing timer instead.
 */
const FLUSH_CEILING_MS = 500;

/** The browser's own pacing: a frame, a timer, and the wall clock. */
const browserScheduler: CanvasScheduler = {
  frame: (callback) => {
    if (typeof requestAnimationFrame !== "function") {
      const handle = setTimeout(callback, 0);
      return () => clearTimeout(handle);
    }
    const handle = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(handle);
  },
  timer: (ms, callback) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
  now: () => Date.now(),
};

/** The page's repaints: at once for what the reader acts on, batched for a stream's flow. */
export function installPaint(ctx: StoreContext): void {
  const { options, listeners } = ctx;
  const scheduler = options.scheduler ?? browserScheduler;
  /**
   * The repaint the deltas so far are waiting for: when it was deferred, and
   * how to call off the frame and the timer racing to serve it.
   */
  let deferredSince: number | undefined;
  let cancelFrame: (() => void) | undefined;
  let cancelTimer: (() => void) | undefined;
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One listener's failure is not the others': they still hear of this state.
      }
    }
  };
  /** Repaint now, and call off whatever was going to. */
  const flushNow = (): void => {
    deferredSince = undefined;
    cancelFrame?.();
    cancelFrame = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
    notify();
  };
  /** Serve a deferred repaint, if one is waiting. */
  const flush = (): void => {
    if (deferredSince !== undefined) flushNow();
  };
  /**
   * Repaint at the next frame — or in `FLUSH_COALESCE_MS`, whichever comes
   * first, since a hidden tab is given no frames — and at once if the stream
   * has held the page back for `FLUSH_CEILING_MS` already.
   */
  const defer = (): void => {
    if (deferredSince !== undefined) {
      if (scheduler.now() - deferredSince >= FLUSH_CEILING_MS) flush();
      return;
    }
    deferredSince = scheduler.now();
    cancelFrame = scheduler.frame(flush);
    cancelTimer = scheduler.timer(FLUSH_COALESCE_MS, flush);
  };
  /**
   * The new state, and a repaint: at once for anything the reader acts on or
   * is asked for, and batched for the ordinary flow of a stream. The
   * snapshot itself is always current — only the listeners wait.
   */
  const publish = (next: CanvasState, urgent = true): void => {
    if (ctx.disposed) return;
    const {
      continuing: _continuing,
      declined: _declined,
      next: _next,
      replyingTo: _replyingTo,
      privateDraft: _privateDraft,
      ...rest
    } = next;
    const task = ctx.continuable();
    ctx.state = task === undefined ? rest : ctx.fresh ? { ...rest, declined: task } : { ...rest, continuing: task };
    ctx.state = {
      ...ctx.state,
      next: ctx.nextPrompt(),
      ...(ctx.fresh && ctx.sideNotice !== undefined && ctx.sideNotice.taskId === ctx.sideParent ? { replyingTo: ctx.sideNotice } : {}),
      ...(ctx.fresh && ctx.freshPrivate ? { privateDraft: true as const } : {}),
    };
    if (urgent) {
      flushNow();
      return;
    }
    defer();
  };
  /** Call off a deferred repaint. */
  const cancelPaint = (): void => {
    cancelFrame?.();
    cancelFrame = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
    deferredSince = undefined;
  };
  Object.assign(ctx, { publish, cancelPaint } satisfies Partial<StoreContext>);
}
