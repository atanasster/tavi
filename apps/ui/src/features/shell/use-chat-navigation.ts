import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { ChatNotice } from "@tavi/contracts";

import { isPhone } from "../../hooks/page.js";
import type { HeartbeatItemView } from "../center/HeartbeatItem.js";
import type { ChatPanelTab } from "../chat-panel/tabs.js";
import type { CanvasRun, CanvasStore } from "../chat/store/types.js";
import type { BrowserToolTarget } from "../chat/use-scroll-to-browser-tool.js";
import type { OpenWorker } from "../workers/WorkerView.js";
import { NO_SCHEDULE_PAGE, type CenterSection, type Navigate, type Route, type SettingsView } from "./route.js";
import type { Session } from "./shell.js";
import type { PanelPlace } from "./use-panel-layout.js";

/** The chat views the shell switches between. */
export type ChatPane = "transcript" | "trajectory" | "changes" | "agents";

/**
 * The ways the shell goes from one place to another: a new chat, a chat
 * another route names, a worker beside its chat, a Center section, and an
 * idea's prompt put in a new chat's composer.
 */
export function useChatNavigation({
  store,
  runs,
  route,
  view,
  current,
  homeChat,
  navigate,
  setDraft,
  setPane,
  setPanel,
  setSeededIdea,
}: {
  readonly store: CanvasStore;
  readonly runs: readonly CanvasRun[];
  readonly route: Route;
  readonly view: SettingsView;
  readonly current: Session | undefined;
  readonly homeChat: boolean;
  readonly navigate: Navigate;
  readonly setDraft: Dispatch<SetStateAction<ReadonlySet<string> | undefined>>;
  readonly setPane: Dispatch<SetStateAction<ChatPane>>;
  readonly setPanel: Dispatch<SetStateAction<PanelPlace>>;
  readonly setSeededIdea: Dispatch<SetStateAction<string | undefined>>;
}) {
  /** A new chat, of `parent` or of its own: it starts from no idea (*Try it* names its own after this). */
  const startChat = (parent: string | undefined, options?: { readonly private?: true; readonly own?: true }) => {
    setSeededIdea(undefined);
    store.newTask(parent, options);
    setDraft(new Set(runs.map((run) => run.id)));
    setPane("transcript");
    navigate((page) => ({ ...page, route: "chat", taskId: undefined }));
  };
  /**
   * The one way to a new (side) chat: the sidebar's +, the rail's, and the
   * sheet's chord all come here. The chat on screen — Home or another — is the
   * side chat's parent; with none, it is a chat of its own.
   */
  const newSession = () => startChat(route === "chat" ? current?.taskId : undefined);
  /**
   * *Start a fresh chat* (the taint chip's remedy): a chat of its own, with no
   * parent, so it begins without what the chat on screen read.
   */
  const newFreshSession = () => startChat(undefined);
  /** *New chat* (Home on): a chat of its own, never a side chat of what is on screen, whatever draft was open before. */
  const newOwnSession = () => startChat(undefined, { own: true });
  /** *New private chat*: a chat of its own whose memory is off for good. */
  const newPrivateSession = () => startChat(undefined, { private: true });
  /** Home from the chat list before its first message: an empty page whose prompt starts it. */
  const openHome = (): void => {
    setSeededIdea(undefined);
    store.openHome();
    setDraft(new Set(runs.map((run) => run.id)));
    setPane("transcript");
    navigate((page) => ({ ...page, route: "chat", taskId: undefined }));
  };
  /** Reply to a notice: a side chat of the chat it was posted into, seeded with its run's output. */
  const replyToNotice = (notice: ChatNotice): void => {
    store.replyToNotice(notice);
    setDraft(new Set(runs.map((run) => run.id)));
    setPane("transcript");
    navigate((page) => ({ ...page, route: "chat", taskId: undefined }));
  };
  const select = (taskId: string) => {
    setDraft(undefined);
    navigate((page) => ({ ...page, route: "chat", taskId }));
  };
  /**
   * A turn about a heartbeat item: in Home, or a
   * new chat with Home off — never a side chat — shown in the chat.
   */
  const heartbeatTurn = (input: { readonly prompt: string; readonly itemId: string; readonly action: "do" | "chat" }): void => {
    store.heartbeatTurn({ ...input, toHome: homeChat });
    setDraft(new Set(runs.map((run) => run.id)));
    setPane("transcript");
    navigate((page) => ({ ...page, route: "chat", taskId: undefined }));
  };
  const doHeartbeatItem = (item: HeartbeatItemView): void =>
    heartbeatTurn({ prompt: `Do it: ${item.title}`, itemId: item.itemId, action: "do" });
  const chatAboutHeartbeatItem = (item: HeartbeatItemView): void =>
    heartbeatTurn({ prompt: `Chat about this: ${item.title}`, itemId: item.itemId, action: "chat" });
  /** A task another route names (a routine's run, a schedule's fire, an Activity row), opened in the chat. */
  const follow = async (taskId: string): Promise<void> => {
    await store.openTask(taskId);
    navigate((current) => ({ ...current, route: "chat", taskId }));
    setPane("transcript");
  };
  /** A chat a transcript card links to (a past-chat search's), opened in place; stable, so a card does not re-render for it. */
  const followRef = useRef(follow);
  followRef.current = follow;
  const openChat = useCallback((taskId: string): void => void followRef.current(taskId), []);
  /** A task another route names, opened in the chat with its panel on `tab`. */
  const followWithPanel = async (taskId: string, tab: ChatPanelTab): Promise<void> => {
    await store.openTask(taskId);
    setPanel({ open: true, tab });
    navigate((current) => ({ ...current, route: "chat", taskId, panel: tab }));
    setPane("transcript");
  };
  /**
   * A worker's view-only transcript, beside the chat it was opened from: never a
   * chat of its own, so it is not routed, listed or opened
   * in the store, and it shows only while that chat is the one on screen.
   */
  const [worker, setWorker] = useState<OpenWorker>();
  /** A delegated worker named elsewhere (Center Activity): its root chat, with the worker beside it. */
  const followWorker = async (rootTaskId: string, opened: { readonly taskId: string; readonly label: string }): Promise<void> => {
    await follow(rootTaskId);
    setWorker({ ...opened, chatTaskId: rootTaskId });
  };
  /** A browser session's task, the transcript brought to the call that opened it when the owner recorded one. */
  const [toolTarget, setToolTarget] = useState<BrowserToolTarget>();
  const followBrowserSession = async (taskId: string, callId: string | undefined): Promise<void> => {
    setToolTarget(callId === undefined ? undefined : { taskId, callId, since: Date.now() });
    await follow(taskId);
  };
  /** The "Always allow" rule a Center link named, for Settings → Permissions to point out once. */
  const [ruleFocus, setRuleFocus] = useState<string>();
  // Permissions reads it as it opens; after that it is spent, so a later visit points out nothing.
  useEffect(() => {
    if (ruleFocus !== undefined && route === "settings" && view === "permissions") setRuleFocus(undefined);
  }, [ruleFocus, route, view]);
  /** A Center section from its nav or rail: the section itself, never a routine last open in it. */
  const openSection = (section: CenterSection): void =>
    navigate((current) => ({ ...current, route: "center", section, ...NO_SCHEDULE_PAGE }));
  /** Schedule's lists (no routine), a routine's page, or one of its runs. */
  const openRoutine = (routineId: string | undefined, runId?: string): void =>
    navigate((current) => ({ ...current, route: "center", section: "schedule", ...NO_SCHEDULE_PAGE, routineId, runId }));
  /** A reminder's page inside Schedule. */
  const openReminder = (reminderId: string): void =>
    navigate((current) => ({ ...current, route: "center", section: "schedule", ...NO_SCHEDULE_PAGE, reminderId }));
  /** A plain schedule's page inside Schedule. */
  const openSchedule = (scheduleId: string): void =>
    navigate((current) => ({ ...current, route: "center", section: "schedule", ...NO_SCHEDULE_PAGE, scheduleId }));
  /** An idea's prompt, put in a new chat's composer by *Try it* and never sent by it; keyed so the same idea twice lands twice. */
  const [composerSeed, setComposerSeed] = useState<{ readonly text: string; readonly key: number }>();
  const tryIdeaPrompt = (prompt: string, ideaId: string | undefined): void => {
    // A chat of its own: not a side chat of a draft left open with +, nor a reply to a notice.
    store.newTask(undefined, { own: true });
    setDraft(new Set(runs.map((run) => run.id)));
    setPane("transcript");
    // On a phone the panel is a sheet over the chat: it would hide the composer the prompt was put in.
    if (isPhone()) setPanel((now) => (now.open ? { ...now, open: false } : now));
    navigate((page) => ({ ...page, route: "chat", taskId: undefined }));
    setSeededIdea(ideaId);
    setComposerSeed((before) => ({ text: prompt, key: (before?.key ?? 0) + 1 }));
  };
  return {
    newSession,
    newFreshSession,
    newPrivateSession,
    newOwnSession,
    openHome,
    replyToNotice,
    select,
    doHeartbeatItem,
    chatAboutHeartbeatItem,
    follow,
    openChat,
    followWithPanel,
    worker,
    setWorker,
    followWorker,
    toolTarget,
    setToolTarget,
    followBrowserSession,
    ruleFocus,
    setRuleFocus,
    openSection,
    openRoutine,
    openReminder,
    openSchedule,
    composerSeed,
    setComposerSeed,
    tryIdeaPrompt,
  };
}
