import { useEffect, useState } from "react";

import { useLoaded } from "../../hooks/use-loaded.js";
import type { Outcome, SettingsClient } from "../../lib/ipc.js";
import {
  CHAT_MODEL_UNAVAILABLE,
  chosenTarget,
  loadChatModel,
  loadTarget,
  modelActions,
  modelPickNote,
  planModelPick,
  type ChatModel,
} from "../settings/models-api.js";
import type { Session } from "../shell/shell.js";
import type { ChatModelTarget } from "./store/types.js";

/**
 * The model the composer names and the strip shows: the open chat's own, a
 * new chat's pick before its first message, else the owner's default; and a
 * pick, which is the chat's own model and the default for new chats.
 */
export function useChatModel(client: SettingsClient, workspaceId: string, current: Session | undefined, toHome: boolean) {
  const chatTaskId = current?.taskId;
  /** The model picked for a new chat before its first message, which carries it as the chat's own. */
  const [newChatModel, setNewChatModel] = useState<ChatModelTarget>();
  // The owner's default as it resolves now: a read, so the strip names it only once it answers.
  const { data: target, reload: reloadTarget } = useLoaded(() => loadTarget(client, workspaceId));
  // The open chat's own model, read again when another chat opens or a turn of it ends — its first may save
  // a route of the router's; `model` undefined on an owner that predates it.
  const endedTurns = current?.runs.filter((run) => run.run.status !== "running" && run.run.status !== "idle").length ?? 0;
  /** The newest read of the open chat's model: replaced only when it changed, so a read at a turn's end that finds the same model draws nothing. */
  const [chatModelRead, setChatModelRead] = useState<{ readonly taskId: string; readonly model: ChatModel | undefined }>();
  const [chatModelAsked, setChatModelAsked] = useState(0);
  const reloadChatModel = (): void => setChatModelAsked((asked) => asked + 1);
  useEffect(() => {
    if (chatTaskId === undefined) return;
    let live = true;
    void loadChatModel(client, workspaceId, chatTaskId).then((read) => {
      // A failed read keeps the last one; a pick then waits, and asks again.
      if (!live || !read.ok) return;
      const next = { taskId: chatTaskId, model: read.value };
      setChatModelRead((previous) => (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, chatTaskId, endedTurns, chatModelAsked]);
  const chatRead = chatTaskId !== undefined && chatModelRead?.taskId === chatTaskId ? chatModelRead : undefined;
  const chatModel = chatRead?.model;
  /** What the picker and the strip name: the open chat's own model — or that it is gone — a new chat's pick, else the default. */
  const chatModelLabel =
    chatModel === undefined ? undefined : (chatModel.target ?? (chatModel.source === "chosen" ? CHAT_MODEL_UNAVAILABLE : undefined));
  const shownModel =
    chatTaskId === undefined
      ? newChatModel === undefined
        ? chosenTarget(target)
        : `${newChatModel.connectionId}/${newChatModel.model}`
      : (chatModelLabel ?? chosenTarget(target));
  /** A pick is the chat's own model — an open chat's from its next turn, a new chat's from its first — and the default for new chats. */
  const pickModel = async (connectionId: string, model: string): Promise<Outcome<string | undefined>> => {
    const pick = planModelPick({
      taskId: chatTaskId,
      newChat: current === undefined && !toHome,
      support: chatRead === undefined ? "unknown" : chatModel === undefined ? "unsupported" : "supported",
    });
    if (pick.kind === "wait") {
      // A read that failed is asked again, so the next pick can go through.
      reloadChatModel();
      return { ok: false, message: pick.message };
    }
    if (pick.kind === "chat") {
      const chosen = await modelActions.setChat(client, workspaceId, pick.taskId, connectionId, model);
      if (!chosen.ok) return chosen;
    }
    // Only the chat being written holds a pick; any other pick replaces one held earlier.
    setNewChatModel(pick.kind === "new-chat" ? { connectionId, model } : undefined);
    const made = await modelActions.setDefault(client, workspaceId, connectionId, model);
    // What a new chat runs now: role main, or the owner's flags, may outrank the default just saved.
    const now = made.ok ? await loadTarget(client, workspaceId) : undefined;
    reloadTarget();
    reloadChatModel();
    return modelPickNote(pick, { connectionId, model }, made, now?.ok === true ? now.value.running : undefined);
  };
  return { target, reloadTarget, shownModel, pickModel, reloadChatModel, newChatModel, setNewChatModel };
}
