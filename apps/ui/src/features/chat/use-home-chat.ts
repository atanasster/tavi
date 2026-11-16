import { useEffect, useRef, useState } from "react";

import type { ClientState } from "@tavi/client/browser";

import type { SettingsClient } from "../../lib/ipc.js";
import { workspaceSettingsActions } from "../settings/workspace-api.js";
import type { Navigate, Route } from "../shell/route.js";
import type { CanvasStore } from "./store/types.js";
import { findHome } from "./tasks-api.js";

/**
 * The workspace's `chat.home`, read once per workspace: on, `/` is
 * the person's Home, a prompt that starts nothing of its own goes there, and
 * + starts a side chat. Off — or unreadable — the canvas is as it was.
 */
export function useHomeChat(client: SettingsClient, workspaceId: string, store: CanvasStore): boolean {
  const [homeChat, setHomeChat] = useState(false);
  useEffect(() => {
    let live = true;
    setHomeChat(false);
    void workspaceSettingsActions.load(client, workspaceId).then((answer) => {
      if (live) setHomeChat(answer.ok && answer.value?.effective?.homeChat === true);
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  useEffect(() => store.setHome(homeChat), [store, homeChat]);
  return homeChat;
}

/**
 * `/` is the person's Home while `chat.home` is on: with no chat
 * named, none restored and no side chat asked for, the page opens Home if it
 * exists. Asked once per workspace; with none, the first prompt makes it.
 */
export function useOpenHome({
  homeChat,
  route,
  taskId,
  drafting,
  connection,
  workspaceId,
  store,
  client,
  principal,
  navigate,
}: {
  readonly homeChat: boolean;
  readonly route: Route;
  readonly taskId: string | undefined;
  readonly drafting: boolean;
  readonly connection: ClientState;
  readonly workspaceId: string;
  readonly store: CanvasStore;
  readonly client: SettingsClient;
  readonly principal: string | undefined;
  readonly navigate: Navigate;
}): void {
  const homeAsked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!homeChat || route !== "chat" || taskId !== undefined || drafting || connection !== "ready" || homeAsked.current === workspaceId)
      return;
    if (store.getSnapshot().runs.length > 0) return;
    homeAsked.current = workspaceId;
    void (async () => {
      const home = await findHome(client, workspaceId, principal);
      // The reader may have gone elsewhere, or sent a prompt, while the list was read.
      if (home === undefined || store.getSnapshot().runs.length > 0) return;
      // Named in the address, which opens it as any chat the address names is.
      navigate((now) => (now.route === "chat" && now.taskId === undefined ? { ...now, taskId: home } : now), { replace: true });
    })().catch(() => undefined);
  }, [homeChat, route, taskId, drafting, connection, workspaceId, store, client, principal, navigate]);
}
