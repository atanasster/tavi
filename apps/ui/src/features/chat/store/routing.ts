import { turnEnded } from "@tavi/client/browser";
import type { StoreContext } from "./context.js";
import { BUSY_STATUSES, isCancelled } from "./runs.js";
import type { CanvasRun, NextPrompt } from "./types.js";
import { openWorkerQuestions } from "./workers.js";

/** Where a prompt typed now goes: an answer, a queue, the next turn, Home, or a chat of its own. */
export function installRouting(ctx: StoreContext): void {
  /** The finished task the next prompt continues: by its conversation, or by the task itself. */
  const continuable = (): string | undefined => {
    if (ctx.settled === undefined) return undefined;
    // A task read back as going again (waiting on a question, say) is not finished, and a cancelled one is over: no reply goes into either.
    // An entry that started no turn (a prompt not sent, one still queued) says nothing of where it stands.
    const latest = ctx.state.runs.findLast((run) => run.run.taskId === ctx.settled && run.run.status !== "idle");
    if (latest !== undefined && isCancelled(latest.run)) return undefined;
    return latest === undefined || turnEnded(latest.run.status) ? ctx.settled : undefined;
  };
  /**
   * The chat whose turn is still going — running, waiting on an approval or
   * a review, or on the reader in the browser (a handoff, an account's sign-in)
   * — as the page's last entry shows it: a prompt typed now is queued behind
   * that turn rather than starting a task of its own or going to Home.
   */
  const busyTask = (): string | undefined => {
    const last = ctx.state.runs.at(-1);
    if (last === undefined) return undefined;
    if (last.queued === true) return last.continues;
    if (last.run.taskId === undefined) return undefined;
    const inBrowser = last.run.status === "waiting" && (last.run.waiting?.handoff !== undefined || last.run.waiting?.connect !== undefined);
    return BUSY_STATUSES.has(last.run.status) || inBrowser ? last.run.taskId : undefined;
  };
  const continuingTask = (): string | undefined => (ctx.fresh ? undefined : continuable());
  /** Home's turn still going (or a prompt already queued behind it): a prompt for Home queues behind it. */
  const busyHome = (): string | undefined => {
    const home = ctx.state.home;
    if (home === undefined) return undefined;
    return ctx.state.runs.some(
      (run) =>
        (run.queued === true && run.continues === home) ||
        (run.queued !== true && run.run.taskId === home && BUSY_STATUSES.has(run.run.status)),
    )
      ? home
      : undefined;
  };
  /** The run waiting on a question that a prompt typed now answers. Prompts queued behind it do not hide it. */
  const asked = (): CanvasRun | undefined => {
    const last = ctx.state.runs.findLast((run) => run.queued !== true);
    return !ctx.fresh &&
      last?.run.status === "waiting" &&
      last.run.waiting?.question !== undefined &&
      last.run.waiting.handoff === undefined &&
      last.run.waiting.connect === undefined
      ? last
      : undefined;
  };
  /**
   * Where a prompt typed now goes: the one decision `submit` acts on and the
   * composer names. A typed line answers a question only when exactly one is
   * open in the chat — its own or one of its workers'; with more, it is
   * a message, queued behind a chat that waits on its own question, and each
   * question is answered in its card.
   */
  const nextPrompt = (): NextPrompt => {
    // In a Home opened before its first message, no other chat's question is on screen to answer.
    const question = ctx.homeDraft && ctx.homeOn && !ctx.fresh ? undefined : asked();
    const base = question === undefined ? messageRoute() : undefined;
    // Only the chat on screen's workers, and only when the message would go to that chat:
    // a card the reader cannot see is never what a typed line answers.
    const screen = onScreen();
    const target =
      question?.run.taskId ?? (base === undefined || base.kind === "new" ? undefined : base.kind === "home" ? ctx.state.home : base.taskId);
    const root = target !== undefined && target === screen ? target : undefined;
    const workers = root === undefined ? [] : openWorkerQuestions(ctx.state.workers?.[root]);
    const asking = question?.run.taskId;
    if (question !== undefined && (workers.length === 0 || asking === undefined)) return { kind: "answer", taskId: asking };
    if (asking !== undefined) return { kind: "queue", taskId: asking };
    const only = workers.length === 1 ? workers[0] : undefined;
    if (only !== undefined && root !== undefined) return { kind: "answer", taskId: only.taskId, waitId: only.waitId, rootTaskId: root };
    // Every question returned above, so `base` was routed.
    return base ?? messageRoute();
  };
  /** The chat the page shows: its last entry's, a queued one's by the chat it waits behind. */
  const onScreen = (): string | undefined => {
    if (ctx.fresh) return undefined;
    const last = ctx.state.runs.at(-1);
    return last === undefined ? undefined : last.queued === true ? last.continues : (last.run.taskId ?? last.continues);
  };
  /** Where a message goes when it answers nothing. */
  const messageRoute = (): NextPrompt => {
    // Home opened before it has a task: whatever chat the page last showed, the prompt starts Home.
    if (ctx.homeDraft && ctx.homeOn && !ctx.fresh) {
      const home = busyHome();
      return home === undefined ? { kind: "home" } : { kind: "queue", taskId: home };
    }
    const busy = ctx.fresh ? undefined : busyTask();
    if (busy !== undefined) return { kind: "queue", taskId: busy };
    const taskId = continuingTask();
    if (taskId !== undefined) return { kind: "continue", taskId };
    // With Home on, a prompt that starts nothing of its own goes into Home; one after New side chat starts a chat.
    if (ctx.fresh && ctx.sideParent !== undefined) return { kind: "new", side: true };
    if (!ctx.homeOn || ctx.fresh) return { kind: "new" };
    const home = busyHome();
    return home === undefined ? { kind: "home" } : { kind: "queue", taskId: home };
  };
  Object.assign(ctx, { continuable, nextPrompt, onScreen, asked } satisfies Partial<StoreContext>);
}
