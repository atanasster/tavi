import type { PluginCommandView } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { approvePayload } from "../tasks-api.js";
import { installArtifacts } from "./artifacts.js";
import { createStoreContext } from "./context.js";
import { installContinuation } from "./continuation.js";
import { installEntries } from "./entries.js";
import { installNotices } from "./notices.js";
import { installPaint } from "./paint.js";
import { installPrompts } from "./prompts.js";
import { installQuestions } from "./questions.js";
import { installRecord } from "./record.js";
import { installReplay } from "./replay.js";
import { installRouting } from "./routing.js";
import { decidableRound, without } from "./runs.js";
import { refusedAs, said } from "./said.js";
import { installSessions } from "./sessions.js";
import { installStream } from "./stream.js";
import type { CanvasClient, CanvasOptions, CanvasStore } from "./types.js";
import { installWorkers } from "./workers.js";

/**
 * The canvas's state: the page's runs, each folded by the
 * client's own `reduceRun` — the reducer the terminal UI renders from — and
 * decided as the terminal decides: a round only once it is seen whole, for the
 * round it is, and a suspension a restart erased from the stream read back
 * from the task's record.
 */
export function createCanvasStore(client: CanvasClient, options: CanvasOptions): CanvasStore {
  const ctx = createStoreContext(client, options);
  installRouting(ctx);
  installPaint(ctx);
  installEntries(ctx);
  installStream(ctx);
  installRecord(ctx);
  installContinuation(ctx);
  installReplay(ctx);
  installNotices(ctx);
  installSessions(ctx);
  installQuestions(ctx);
  installWorkers(ctx);
  installArtifacts(ctx);
  installPrompts(ctx);
  const { recordReleased, artifactLoads, listeners, streams, restoredStreams, queuedPrompts, placeLost, watches, held, reading } = ctx;
  /** Plugins' slash commands, read each time the page connects; an owner without them lists none. */
  const listCommands = (commands: readonly PluginCommandView[]): void => {
    if (!ctx.disposed) ctx.publish({ ...ctx.state, pluginCommands: commands });
  };
  /** Whether the commands were asked for since the store was made: the first watcher asks when no `ready` will. */
  let commandsAsked = false;
  const readCommands = (): void => {
    commandsAsked = true;
    void client
      .request("plugin-commands", { action: "list", workspaceId: options.workspaceId })
      .then((answer) =>
        listCommands(
          answer.ok ? ((answer.result as { readonly commands?: readonly PluginCommandView[] } | undefined)?.commands ?? []) : [],
        ),
      )
      // An owner that cannot list them offers none: a slash word is then a prompt, as before.
      .catch(() => listCommands([]));
  };
  // Whether the page was connected before: a `ready` after it is a reconnect.
  let connectedBefore = client.state === "ready";
  const unsubscribeState = client.onState((connection) => {
    const failure = connection === "closed" && client.failure !== undefined ? errorMessage(client.failure) : undefined;
    ctx.publish({ ...without(ctx.state, "failure"), connection, runs: ctx.state.runs, ...(failure === undefined ? {} : { failure }) });
    if (connection === "ready") {
      // Back after a drop: a chat whose stream resumed is told what it missed
      // (or resynced), but one no stream follows may have had its lines
      // cleared meanwhile — they go, until its next turn sets them again.
      if (connectedBefore) {
        const followed = new Set(ctx.state.runs.flatMap((run) => (streams.has(run.id) ? [ctx.chatOf(run)] : [])));
        ctx.dropStatus((run) => !followed.has(ctx.chatOf(run)));
        // Nor is the place their streams stopped one an owner that may have restarted knows: their next turn follows from now.
        for (const run of ctx.state.runs) if (!streams.has(run.id)) placeLost.add(run.id);
      }
      connectedBefore = true;
      readCommands();
    }
  });
  try {
    const remembered = options.memory?.load();
    if (remembered !== undefined) ctx.restore(remembered);
  } catch {
    // Storage refused: the page starts afresh.
  }

  const api: CanvasStore = {
    loadSessions: ctx.loadSessions,
    openTask: ctx.openTask,
    answerQuestion: ctx.answerQuestion,
    loadWorkerNeeds: ctx.loadWorkerNeeds,
    decideWorkerRound: ctx.decideWorkerRound,
    answerWorker: ctx.answerWorker,
    loadArtifacts: ctx.loadArtifacts,
    reviewArtifacts: ctx.reviewArtifacts,
    getSnapshot: () => ctx.state,
    subscribe(listener) {
      // The page connects before it makes its store (`startPage`), so no `ready` follows for that
      // first connection: the commands are read when the page first watches the store, or `/remember`
      // and every other command would go to the model as a prompt.
      if (!commandsAsked && connectedBefore) readCommands();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dropPluginStatus(pluginId) {
      if (!ctx.disposed) ctx.dropStatus(() => true, pluginId);
    },
    submit: ctx.submit,
    newTask: ctx.newTask,
    replyToNotice: ctx.replyToNotice,
    heartbeatTurn: ctx.heartbeatTurn,
    loadNotices: ctx.loadNotices,
    setHome: ctx.setHome,
    openHome: ctx.openHome,
    loadEarlier: ctx.loadEarlier,
    steerQueued: ctx.steerQueued,
    rewind: ctx.rewind,
    cancelQueued: ctx.cancelQueued,
    decide(id, approved, extra) {
      const entry = ctx.find(id);
      const round = entry === undefined ? undefined : decidableRound(entry);
      if (round === undefined) return;
      if (
        typeof approved !== "boolean" &&
        (approved.length > 64 ||
          approved.length !== round.requests.length ||
          new Set(approved.map((decision) => decision.callId)).size !== approved.length ||
          approved.some((decision) => !round.requests.some((request) => request.callId === decision.callId)))
      )
        return;
      ctx.update(id, (run) => ({ ...without(run, "error"), deciding: round.steps }));
      client
        .request(
          "approve",
          approvePayload(
            { taskId: round.taskId, workspaceId: options.workspaceId, expectedSteps: round.steps, decidedBy: options.principal },
            approved,
            extra,
          ),
        )
        .then((response) => {
          // Settled by the stream's `approval.settled`, not by this answer.
          if (!response.ok) ctx.failed(id, refusedAs(response, said("chat.store.decisionRefused")));
        })
        .catch((error: unknown) => ctx.failed(id, errorMessage(error)));
    },
    setExpanded(id, expanded) {
      ctx.update(id, (run) => ({ ...run, expanded }));
    },
    dispose() {
      if (ctx.disposed) return;
      ctx.disposed = true;
      unsubscribeState();
      ctx.cancelPaint();
      for (const id of [...streams.keys()]) ctx.unfollow(id);
      for (const subscription of restoredStreams) void subscription.close();
      restoredStreams.clear();
      for (const watched of watches.values()) clearTimeout(watched.timer);
      watches.clear();
      queuedPrompts.clear();
      held.clear();
      reading.clear();
      recordReleased.clear();
      artifactLoads.clear();
      listeners.clear();
    },
    abort(id) {
      const entry = ctx.find(id);
      const taskId = entry?.run.taskId;
      if (entry === undefined || taskId === undefined || entry.aborting || entry.run.status !== "running") return;
      ctx.update(id, (run) => ({ ...without(run, "error"), aborting: true }));
      client
        .request("abort", { taskId })
        .then((response) => {
          if (response.ok) return;
          // Nothing running is no failure: the turn had already ended.
          if (response.error?.code === "NOT_RUNNING") ctx.update(id, (run) => ({ ...run, aborting: false }));
          else ctx.failed(id, refusedAs(response, said("chat.store.abortRefused")));
        })
        .catch((error: unknown) => ctx.failed(id, errorMessage(error)));
    },
  };
  return api;
}
