import { TaviError, type BrowserLivePayload, type BrowserLiveWatchAnswer } from "@tavi/contracts";
import type { IpcConnection, LiveHub } from "@tavi/runtime";

/**
 * `browser-live`: watch a chat's browser
 * sessions live, give credit back for a frame, stop watching. Authorised as
 * `browser` is: the workspace must be one this owner serves, and the task
 * must belong to it (the hub's task tree refuses one that does not). A watch
 * belongs to the connection that opened it; `ack` and `unwatch` name only
 * that connection's own.
 *
 * Takeover: `take`, `input`, `select`, `dialog`, `release`, `decline`,
 * `upload` and `upload-cancel` name a session of one of this connection's
 * watches, and the source accepts all but `take` and `decline` only from the
 * watch in control. Every IPC connection is a local
 * operator front end (`tavi ui`'s bridge, or the CLI) holding the owner's
 * token — a messaging channel never has one — so they are the operator's, and
 * not approval-gated: the operator is the principal. The bridge further keeps
 * each tab to its own watches. An input's events, and the files an upload
 * carries, are applied and dropped: they are not logged, stored or echoed in
 * an error.
 */
export interface BrowserLiveDependencies {
  readonly hub: LiveHub;
  /** Whether this owner serves the workspace. */
  readonly knownWorkspace: (workspaceId: string) => boolean;
  /** Who a hand-back is recorded as: the front end that asked (`operatorActor`). */
  readonly actor?: string;
}

export async function browserLiveCommand(
  deps: BrowserLiveDependencies,
  payload: BrowserLivePayload,
  connection: IpcConnection,
  requestId: string,
): Promise<{ readonly ok: true; readonly result: BrowserLiveWatchAnswer | { readonly ok: true } }> {
  switch (payload.action) {
    case "watch": {
      const workspaceId = payload.workspaceId;
      if (!deps.knownWorkspace(workspaceId)) {
        throw new TaviError("NOT_FOUND", `workspace ${workspaceId} is not configured on this owner`, { details: { workspaceId } });
      }
      const answer = await deps.hub.watch({
        connection,
        requestId,
        workspaceId,
        taskId: payload.taskId,
        sessionId: payload.sessionId,
        maxWidth: payload.maxWidth,
      });
      return { ok: true, result: answer };
    }
    case "ack":
      deps.hub.ack(connection, payload.subscriptionId, payload.seq);
      return { ok: true, result: { ok: true } };
    case "unwatch":
      deps.hub.unwatch(connection, payload.subscriptionId);
      return { ok: true, result: { ok: true } };
    case "take":
    case "input":
    case "select":
    case "dialog":
    case "release":
    case "decline":
    case "upload":
    case "upload-cancel":
      await deps.hub.control(connection, payload, deps.actor);
      return { ok: true, result: { ok: true } };
  }
}
