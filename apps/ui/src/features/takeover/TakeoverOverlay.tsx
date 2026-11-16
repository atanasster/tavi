import { Suspense, type MutableRefObject } from "react";

import { refusal } from "../../lib/ipc.js";
import type { CanvasRun, CanvasState, CanvasStore } from "../chat/store/types.js";
import type { LivePluginFrameClient } from "../plugin-host/PluginFrame.js";
import type { Session } from "../shell/shell.js";
import { stopLabel, stopTakenOverTask, type TakeoverTarget } from "./context.js";
import { useWorkspace } from "../shell/Workspace.js";
import { lazyModule } from "../../ui/lazy-module.js";
import { ViewBoundary } from "../../ui/ViewBoundary.js";

/** The takeover (the live page and its input) is its own chunk, fetched the first time one opens. */
const takeoverModule = lazyModule(() => import("./Takeover.js").then((module) => module.Takeover));
const Takeover = takeoverModule.Route;

/** Settles once the takeover is fetched, so a test that opens one reads it synchronously. */
export function takeoverReady(): Promise<void> {
  return takeoverModule.ready().then(() => undefined);
}

/**
 * The takeover's Stop for task `taskId`, by the kind of chat it is: Home by
 * the page's own Home, else as the chats list names it (a task it has not
 * listed — a worker's, or one beyond the list — says "Stop the agent").
 */
function takeoverStopLabel(taskId: string, home: string | undefined, directory: CanvasState["directory"]): string {
  if (taskId === home) return stopLabel("home", true);
  const row = [...(directory?.rows ?? []), ...(directory?.needs ?? [])].find((listed) => listed.taskId === taskId);
  return stopLabel(row?.chatKind, row !== undefined);
}

/** The takeover open over the page: closed, it re-reads the open chat for its hand-back row; Stop stops the task it shows. */
export function TakeoverOverlay({
  takeover,
  setTakeover,
  client,
  request,
  home,
  directory,
  current,
  running,
  store,
  rereadTimer,
}: {
  readonly takeover: TakeoverTarget;
  readonly setTakeover: (takeover: TakeoverTarget | undefined) => void;
  readonly client: LivePluginFrameClient;
  /** The owner, asked to stop a task the page does not run. */
  readonly request: Parameters<typeof stopTakenOverTask>[0];
  readonly home: string | undefined;
  readonly directory: CanvasState["directory"];
  readonly current: Session | undefined;
  /** The open chat's running turn, stopped through the store. */
  readonly running: CanvasRun | undefined;
  readonly store: CanvasStore;
  readonly rereadTimer: MutableRefObject<number | undefined>;
}) {
  const { workspaceId } = useWorkspace();
  return (
    <ViewBoundary resetKey={`${takeover.taskId}:${takeover.sessionId}`} what="panel" onRetry={takeoverModule.retry}>
      <Suspense fallback={null}>
        <Takeover
          key={`${takeover.taskId}:${takeover.sessionId}`}
          client={client}
          taskId={takeover.taskId}
          sessionId={takeover.sessionId}
          {...(takeover.handoff === undefined ? {} : { handoff: takeover.handoff })}
          stopLabel={takeoverStopLabel(takeover.taskId, home, directory)}
          onClose={() => {
            setTakeover(undefined);
            // A finished turn's stream is no longer followed: the open chat is read again for the row a hand-back adds.
            const taskId = takeover.taskId;
            // After the owner had time to publish it (its row follows the hand-back's settling); cleared if the page goes.
            if (current?.taskId === taskId && current.status !== "working" && current.status !== "submitted") {
              if (rereadTimer.current !== undefined) window.clearTimeout(rereadTimer.current);
              rereadTimer.current = window.setTimeout(() => {
                rereadTimer.current = undefined;
                void store.openTask(taskId);
              }, 1_500);
            }
          }}
          // The open chat's running turn through the store, so its run shows it; any other task (a card's, a sub-agent's) by its id.
          // A session a finished turn kept has no turn to stop: cancelling its finished chat is not the person's aim.
          onStopTask={
            takeover.kept === true
              ? undefined
              : async () => {
                  const taskId = takeover.taskId;
                  if (running !== undefined && current?.taskId === taskId && running.run.status === "running") {
                    store.abort(running.id);
                    setTakeover(undefined);
                    return undefined;
                  }
                  const stopped = await stopTakenOverTask(request, { taskId, workspaceId, isHome: store.getSnapshot().home === taskId });
                  if (!stopped.ok) return refusal(stopped, "The agent could not be stopped.");
                  setTakeover(undefined);
                  return undefined;
                }
          }
        />
      </Suspense>
    </ViewBoundary>
  );
}
