import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { TaviClient } from "@tavi/client/browser";
import { CHAT_INSTRUCTIONS_MAX, isPlumbingOrigin, type ArtifactListRow } from "@tavi/contracts";

import { useResetOnChange } from "./hooks/use-reset-on-change.js";
import { readThumbnail } from "./features/center/browser-api.js";
import { useCenterFeed } from "./features/center/feed.js";
import { waitingCount } from "./features/center/model.js";
import { useFreshReminders, useReminderNotifications, useUnseenReminders } from "./features/center/ReminderNotifications.js";
import { CHAT_CONTEXT_FEATURE, loadArchive, renameChat, requestFreshContext } from "./features/chat-panel/api.js";
import { useChatSummary } from "./features/chat-panel/badges.js";
import { CHAT_PANEL_BOUNDS, loadChatPanel } from "./features/chat-panel/ChatPanel.js";
import { downloadFolderFile } from "./features/chat-panel/folder-api.js";
import { turnVersion } from "./features/chat-panel/load.js";
import { isChatPanelTab, type ChatPanelTab } from "./features/chat-panel/tabs.js";
import { useInstructionsChanged } from "./features/chat-panel/use-instructions-changed.js";
import { uploadFile, type UploadAttachment } from "./features/chat/attachments.js";
import type { CanvasStore } from "./features/chat/store/types.js";
import { useChatModel } from "./features/chat/use-chat-model.js";
import { useHomeChat, useOpenHome } from "./features/chat/use-home-chat.js";
import { useScrollToBrowserTool } from "./features/chat/use-scroll-to-browser-tool.js";
import { NEED_TOAST_ID, useFaviconDot, useNeedNotifications } from "./features/needs/NeedNotify.js";
import { usePluginSlots } from "./features/plugin-host/use-plugin-slots.js";
import { AppProviders } from "./features/shell/AppProviders.js";
import { ChatMain, type SentExtra } from "./features/shell/ChatMain.js";
import { ChatPanelView } from "./features/shell/ChatPanelView.js";
import { PageRoute, retryPageRoutes } from "./features/shell/PageRoute.js";
import { Bar } from "./features/shell/Bar.js";
import { CENTER_SECTIONS, NO_SCHEDULE_PAGE, ROUTES, SETTINGS_VIEWS, usePageRoute, type PageNavigation } from "./features/shell/route.js";
import { shellState } from "./features/shell/shell.js";
import { useAddressedTask } from "./features/shell/use-addressed-task.js";
import { useChatNavigation, type ChatPane } from "./features/shell/use-chat-navigation.js";
import { useOwnerFeatures } from "./features/shell/use-owner-features.js";
import { usePanelLayout } from "./features/shell/use-panel-layout.js";
import { useTabTitle } from "./features/shell/use-tab-title.js";
import { ShellOverlays } from "./features/shell/ShellOverlays.js";
import { ShellSidebar } from "./features/shell/ShellSidebar.js";
import { usePhoneFold } from "./features/shell/use-phone-fold.js";
import { useChatReads } from "./features/shell/use-chat-reads.js";
import { useSessionsRefresh } from "./features/shell/use-sessions-refresh.js";
import { useConnectCards } from "./features/shell/use-connect-cards.js";
import { useShellAnnouncer } from "./features/shell/use-shell-announcer.js";
import { useShellChords } from "./features/shell/use-shell-chords.js";
import { useTakeoverState } from "./features/takeover/use-takeover-state.js";
import { useFirstRunWelcome } from "./features/welcome/use-first-run-welcome.js";
import type { WorkerRoundDecide } from "./features/workers/WorkerNeeds.js";
import { WorkerTranscript } from "./features/workers/WorkerView.js";
import { isPhone, usePhone } from "./hooks/page.js";
import { loadWidth } from "./hooks/resizable.js";
import { usePoll } from "./hooks/use-poll.js";
import type { SettingsClient } from "./lib/ipc.js";
import { Failure } from "./ui/Parts.js";
import { ViewBoundary } from "./ui/ViewBoundary.js";

/**
 * The shell's primary routes and the views inside Settings. The
 * grammar, and the address bar it is read from, live in `route.ts`; these
 * names are re-exported here because every zone of the shell reads them from
 * the shell.
 */
export type { SettingsView } from "./features/shell/route.js";

/**
 * The canvas, live: sessions sidebar · transcript ·
 * collapsible inspector, over one snapshot of the store, with a footer strip
 * of what the owner's own timestamps can measure. The chat's runs go on while
 * Settings is open. Its route, its Settings view and the session it is reading
 * come from the address, so a refresh lands where the reader was.
 */
export function App({
  store,
  client,
  workspaceId,
  principal,
  navigation,
}: {
  readonly store: CanvasStore;
  readonly client: SettingsClient & Partial<Pick<TaviClient, "features" | "liveWatch" | "subscribe" | "state" | "onState">>;
  readonly workspaceId: string /** Who the page acts as; a decision in the Center is recorded under it, as the store's are. */;
  readonly principal?: string;
  readonly navigation?: PageNavigation;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // The route, the settings view and the session named are the address bar's,
  // not the page's own memory: a refresh lands where the reader was.
  const { page, navigate } = usePageRoute(navigation);
  const route = page.route;
  const view = page.view;
  const selected = page.taskId;
  const routeError = useAddressedTask(page, store, navigate);
  const [panel, setPanel] = useState(() => (page.panel === undefined ? loadChatPanel() : { open: true, tab: page.panel }));
  const [panelWidth, setPanelWidth] = useState(() => loadWidth(CHAT_PANEL_BOUNDS));
  // On a phone the sidebar is a strip above the chat that leaves it no room: it starts folded to its rail.
  const [sidebar, setSidebar] = useState(() => !isPhone());
  /** On a phone, picking a chat folds the sidebar again, so the chat picked has the screen. */
  const foldOnPhone = (): void => {
    if (isPhone()) setSidebar(false);
  };
  // The Center's nav is a short strip of tabs on a phone, with no fold of its own: it stays.
  const phone = usePhone();
  usePhoneFold(phone, sidebar, setSidebar);
  const [sheet, setSheet] = useState(false);
  /** The browser tab shown large, over the page, instead of in the narrow panel. */
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [pane, setPane] = useState<ChatPane>("transcript");
  const [artifact, setArtifact] = useState<ArtifactListRow>();
  // `state` is a fresh object per publish, so the memo is exact: once per repaint.
  const shell = useMemo(() => shellState(state, selected, workspaceId), [state, selected, workspaceId]);
  const homeChat = useHomeChat(client, workspaceId, store);
  const newLabel = homeChat ? "New side chat" : "New chat";
  /**
   * A new chat, asked for and not yet started: the entries the page held
   * when the reader asked. The canvas shows nothing until the prompt that
   * starts it appears as an entry of its own, or the reader picks a chat.
   */
  const [draft, setDraft] = useState<ReadonlySet<string>>();
  const drafting = draft !== undefined && state.runs.every((run) => draft.has(run.id));
  const current = drafting ? undefined : shell.current;
  /** Where the next prompt goes, as the store will send it: what the composer names. */
  const next = state.next ?? { kind: "new" as const };
  const toHome = next.kind === "home";
  /** The idea whose *Try it* or chip filled the empty chat's box: its first message links the chat to it. */
  const [seededIdea, setSeededIdea] = useState<string>();
  const nav = useChatNavigation({
    store,
    runs: state.runs,
    route,
    view,
    current,
    homeChat,
    navigate,
    setDraft,
    setPane,
    setPanel,
    setSeededIdea,
  });
  const {
    newSession,
    newPrivateSession,
    newOwnSession,
    openHome,
    select,
    follow,
    openChat,
    worker,
    setWorker,
    toolTarget,
    setToolTarget,
    openSection,
  } = nav;
  /**
   * The chat on screen as the chat list reads it, for its memory toggle: a chat's own — a worker's
   * memory follows its chat, so it has none — and only once the list holds it, so the mode shown is never a guess.
   * A standalone run and plumbing — a heartbeat check, an idea's prepared step — have no mode, so they have no toggle.
   */
  const memoryRow =
    current?.taskId === undefined
      ? undefined
      : state.directory?.rows.find(
          (row) => row.taskId === current.taskId && row.rootTaskId === undefined && row.chatKind !== "run" && !isPlumbingOrigin(row.origin),
        );
  // A PDF fill's or render's page previews, read as the browser's thumbnails are.
  const readPreview = useCallback((artifactId: string) => readThumbnail(client, workspaceId, artifactId), [client, workspaceId]);
  const currentTaskId = current?.taskId;
  // A filled form, saved from its review panel: the chat on screen's folder.
  const downloadFilled = useCallback(
    async (path: string) =>
      currentTaskId === undefined
        ? "Open the chat this form was filled in to download it."
        : await downloadFolderFile(client, workspaceId, currentTaskId, undefined, path),
    [client, workspaceId, currentTaskId],
  );
  // A chat's connect card: *Continue* is the person's message in the chat on screen.
  const uploadAttachment = useCallback(
    (file: UploadAttachment) => uploadFile(client, workspaceId, file, `up-${crypto.randomUUID().replaceAll("-", "")}`),
    [client, workspaceId],
  );
  const { features, centered, scheduleOnly, sections, section, offersReminders, offersIdeas, offersOnboarding } = useOwnerFeatures(
    client,
    state.connection,
    page.section,
  );
  const feed = useCenterFeed(client, workspaceId, centered);
  /** What moves the agent tree and a worker's view: the feed's task and decision changes; absent with no feed to follow. */
  const workerWatch =
    centered && feed.error === undefined
      ? (feed.revisions.task ?? 0) + (feed.revisions.question ?? 0) + (feed.revisions.approval ?? 0) + (feed.revisions.review ?? 0)
      : undefined;
  /** Schedule alone has no feed to say what changed: its lists are read again every 30 s (a tick, never bumped on entry, is its refetch key). */
  const [scheduleTick, setScheduleTick] = useState(0);
  usePoll(() => setScheduleTick((tick) => tick + 1), SCHEDULE_ONLY_REFRESH_MS, { enabled: scheduleOnly && route === "center" });
  const connectCards = useConnectCards({ client, workspaceId, store, currentTaskId, navigate, offersOnboarding });
  useFirstRunWelcome({ offersOnboarding, connection: state.connection, client, workspaceId, page, navigate });
  const unseen = useUnseenReminders(client, workspaceId, centered && offersReminders, feed.revisions.reminder ?? 0);
  useReminderNotifications(workspaceId, unseen.fires);
  const freshReminders = useFreshReminders(workspaceId, unseen.fires);
  useResetOnChange([current?.key], () => setArtifact(undefined));
  // The large browser view belongs to the tab it grew from: another chat, tab or page puts it back,
  // as the keyboard sheet does, which must not open under it.
  useResetOnChange([current?.key, panel.open, panel.tab, route, sheet], () => setBrowserExpanded(false));
  const openPanel = (tab: ChatPanelTab): void => setPanel({ open: true, tab });
  /** An epoch divider's archive, shown in the chat panel's Details as the Changes view's rows are. */
  const openArchive = async (artifactId: string): Promise<void> => {
    if (current?.taskId === undefined) return;
    const row = await loadArchive(client, workspaceId, current.taskId, artifactId);
    if (row.ok) setArtifact(row.value);
    openPanel("details");
  };
  /** Fresh context: answers why it was not set, or nothing when it was. */
  const freshContext = async (taskId: string): Promise<string | undefined> => {
    const answer = await requestFreshContext(client, workspaceId, taskId);
    return answer.ok ? undefined : answer.message;
  };
  /** Whether the owner offers a chat's own instructions and notes. */
  const chatEditable = features.includes(CHAT_CONTEXT_FEATURE);
  /** Whether the owner offers the `skills` command: Soul & memory then lists the workspace's skills. */
  const offersSkills = features.includes("skills");
  /** What changes when a turn of the open chat ends or the workspace's memory changes: the open panel's tabs read again then. */
  const chatLive = current === undefined || route !== "chat" || !panel.open ? "" : `${turnVersion(current)}|${feed.revisions.memory ?? 0}`;
  const chatSummary = useChatSummary(
    client,
    workspaceId,
    current?.taskId,
    chatEditable,
    route === "chat" && panel.open,
    isChatPanelTab(panel.tab) ? panel.tab : "activity",
    chatLive,
  );
  const plugins = usePluginSlots({
    client,
    workspaceId,
    features,
    revisions: feed.revisions,
    current,
    route,
    panel,
    setPanel,
    runs: state.runs,
    sections,
    openSection,
    setToolTarget,
    setPane,
  });
  const { liveClient, centerBrowser, onboardingFrames, centerHeartbeat, openSession } = plugins;
  /** The open chat's handoff, if its task is waiting on one. */
  const asking = current?.runs.at(-1)?.run.waiting;
  /** What the open chat's workers wait on the reader for, answered here. */
  const currentWorkers = current?.taskId === undefined ? undefined : state.workers?.[current.taskId];
  const decideWorker: WorkerRoundDecide = (round, decision) => {
    if (current?.taskId !== undefined) store.decideWorkerRound(current.taskId, round, decision);
  };
  const answerWorker = (waitId: string, text: string): void => {
    if (current?.taskId !== undefined) store.answerWorker(current.taskId, waitId, text);
  };
  useChatReads(store, current, state);
  const { takeover, setTakeover, rereadTimer, takeoverActions, takeOverHere } = useTakeoverState({
    liveClient,
    workspaceId,
    current,
    asking,
    openSession,
    setPanel,
    handoffs: feed.summary?.counts.handoffs,
  });
  const chatTaskId = current?.taskId;
  const instructionsChanged = useInstructionsChanged(chatTaskId, chatSummary.revision, route, panel.open, panel.tab);
  /** After a change made in the panel: its badges and the session list's marks are read again. */
  const chatChanged = (): void => {
    chatSummary.refresh();
    void store.loadSessions(undefined, false, true);
  };
  /** Name the open chat, then read its name and the session list again; the answer is a refusal's message, or undefined. */
  const rename = async (title: string | null): Promise<string | undefined> => {
    if (current?.taskId === undefined) return undefined;
    const outcome = await renameChat(client, workspaceId, current.taskId, title);
    if (!outcome.ok) return outcome.message;
    chatChanged();
    return undefined;
  };
  /** A new chat's instructions, drafted in the panel before its first message carries them. */
  const [draftInstructions, setDraftInstructions] = useState("");
  // The idea goes with its words, and they live in the chat's composer: leaving the chat drops the box, so the idea too.
  useResetOnChange([route], () => {
    if (route !== "chat") setSeededIdea(undefined);
  });
  const submit = (prompt: string, sent?: SentExtra): boolean => {
    // Only a new chat carries them: a prompt to a chat already open continues it, and Home keeps its own.
    const newChat = current === undefined && !toHome;
    const starting = newChat && draftInstructions.trim() !== "";
    // Too long, the owner would refuse the whole run: say so where they are
    // written, and send nothing — the prompt stays in the box.
    if (starting && draftInstructions.length > CHAT_INSTRUCTIONS_MAX) {
      openPanel("instructions");
      return false;
    }
    const model = newChat ? newChatModel : undefined;
    // The idea that filled the box goes with the message that starts its chat, and only that one.
    const fromIdeaId = newChat ? seededIdea : undefined;
    setSeededIdea(undefined);
    // A plugin's slash command runs against the chat on screen.
    store.submit(prompt, {
      ...(starting ? { chatInstructions: draftInstructions } : {}),
      ...(model === undefined ? {} : { model }),
      ...(sent?.asPrompt === true ? { asPrompt: true } : {}),
      ...(sent?.attachments === undefined ? {} : { attachments: sent.attachments }),
      ...(sent?.attachmentNames === undefined ? {} : { attachmentNames: sent.attachmentNames }),
      ...(sent?.folderAttachments === undefined ? {} : { folderAttachments: sent.folderAttachments }),
      ...(fromIdeaId === undefined ? {} : { fromIdeaId }),
      viewing: current?.taskId,
    });
    if (starting) setDraftInstructions("");
    if (model !== undefined) setNewChatModel(undefined);
    return true;
  };
  /** Show the transcript, then act on it once it is drawn. */
  const toTranscript = (then: () => void): void => {
    setPane("transcript");
    requestAnimationFrame(then);
  };
  usePanelLayout({ page, route, panel, setPanel, panelWidth, sidebar, setSidebar, navigate });
  // A section this owner does not offer is corrected to where the Center lands: Activity, or Schedule alone.
  useEffect(() => {
    if ((centered || scheduleOnly) && route === "center" && page.section !== section)
      navigate((current) => ({ ...current, section, ...NO_SCHEDULE_PAGE }), { replace: true });
  }, [centered, scheduleOnly, route, page.section, section, navigate]);
  useScrollToBrowserTool(toolTarget, route === "chat" ? current : undefined, store, setToolTarget);
  const chatModel = useChatModel(client, workspaceId, current, toHome);
  const { reloadTarget, shownModel, reloadChatModel, newChatModel, setNewChatModel } = chatModel;
  // With the Center offered, what waits is its count — every task's needs, memory proposals and fired reminders — not this page's sessions.
  const waiting = centered ? waitingCount(feed.summary) : shell.needs;
  useTabTitle(waiting, !centered && (state.directory?.needsTruncated ?? false), [
    route === "welcome" ? "Setup" : ROUTES.find((entry) => entry.value === route)?.label,
    route === "settings"
      ? SETTINGS_VIEWS.find((entry) => entry.value === view)?.label
      : route === "center"
        ? CENTER_SECTIONS.find((entry) => entry.value === section)?.label
        : route === "chat"
          ? current?.title
          : undefined,
  ]);
  useFaviconDot(waiting);
  // Setup is a page of its own: no chats beside it, no routes over it, no model strip under it.
  const setup = route === "welcome";
  // What arrives while the page is open says so.
  const offersNeeds = sections.includes("approvals");
  const needsNotice = useNeedNotifications({
    client,
    workspaceId,
    enabled: centered && offersNeeds,
    revision: (feed.revisions.approval ?? 0) + (feed.revisions.question ?? 0) + (feed.revisions.review ?? 0),
    currentTaskId: route === "chat" ? current?.taskId : undefined,
    onOpen: (need) => void follow(need.taskId),
  });
  useSessionsRefresh(store, state);
  useOpenHome({
    homeChat,
    route,
    taskId: page.taskId,
    drafting,
    connection: state.connection,
    workspaceId,
    store,
    client,
    principal,
    navigate,
  });
  const previousRoute = useRef(route);
  useEffect(() => {
    if (previousRoute.current === "settings" && route === "chat") reloadTarget();
    previousRoute.current = route;
  }, [route, reloadTarget]);
  useShellAnnouncer({ state, current, shell, routeError, route, centered, freshReminders, waiting });
  const running = useShellChords({
    current,
    store,
    route,
    sheet,
    setSheet,
    setSidebar,
    setPanel,
    openPanel,
    browserExpanded,
    setBrowserExpanded,
    takeover,
  });
  return (
    <AppProviders
      client={client}
      workspaceId={workspaceId}
      timeZone={feed.summary?.timezone}
      takeover={takeoverActions}
      covered={takeover !== undefined}
      centerBrowser={centerBrowser}
      centerHeartbeat={centerHeartbeat}
      openChat={openChat}
      connectCards={connectCards}
      readPreview={readPreview}
      downloadFilled={downloadFilled}
    >
      <div className={route === "chat" && panel.open ? "canvas with-chat-panel" : setup ? "canvas canvas-setup" : "canvas"}>
        {/* biome-ignore lint/a11y/useValidAnchor: a skip link; it moves focus to #main itself rather than changing the route hash */}
        <a
          className="skip-link"
          href="#main"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById("main")?.focus();
          }}
        >
          Skip to content
        </a>
        {/* The toast sits at the page's end: a way straight to it while it is up. */}
        {needsNotice.offer || needsNotice.toast !== undefined ? (
          <a
            className="skip-link"
            href={`#${NEED_TOAST_ID}`}
            onClick={(event) => {
              event.preventDefault();
              document.getElementById(NEED_TOAST_ID)?.focus();
            }}
          >
            Jump to notification
          </a>
        ) : null}
        <Bar
          state={state}
          route={route}
          onRoute={(next) => navigate((current) => ({ ...current, route: next, ...NO_SCHEDULE_PAGE }))}
          needs={shell.needs}
          center={centered ? { waiting: waitingCount(feed.summary) } : undefined}
          scheduleOnly={scheduleOnly}
          ideas={offersIdeas}
          focused={setup}
          onKeys={() => setSheet((open) => !open)}
        />
        <div className="body">
          <ShellSidebar
            route={route}
            setup={setup}
            sidebar={sidebar}
            setSidebar={setSidebar}
            phone={phone}
            section={section}
            summary={feed.summary}
            sections={sections}
            openSection={openSection}
            state={state}
            store={store}
            homeChat={homeChat}
            principal={principal}
            current={current}
            select={select}
            foldOnPhone={foldOnPhone}
            newSession={newSession}
            newLabel={newLabel}
            newPrivateSession={newPrivateSession}
            openHome={openHome}
            newOwnSession={newOwnSession}
            settingsView={view}
            ideas={offersIdeas}
            onSettingsView={(next) =>
              navigate((current) => ({
                ...current,
                view: next,
                appsTab: undefined,
                appId: undefined,
                appConnect: undefined,
                appsQuery: undefined,
              }))
            }
          />
          <main className="main" id="main" tabIndex={-1}>
            {routeError === undefined ? null : <Failure alert={false}>{routeError}</Failure>}
            <ViewBoundary resetKey={`${route}:${view}`} onRetry={retryPageRoutes}>
              {route === "chat" ? (
                <ChatMain
                  state={state}
                  store={store}
                  current={current}
                  // A new chat's first prompt starts it: there is no failed turn of its own to retry.
                  acting={drafting ? undefined : shell.acting}
                  nav={nav}
                  model={chatModel}
                  pane={pane}
                  setPane={setPane}
                  features={features}
                  sections={sections}
                  offersIdeas={offersIdeas}
                  offersOnboarding={offersOnboarding}
                  homeChat={homeChat}
                  toHome={toHome}
                  memoryRow={memoryRow}
                  memoryRevision={feed.revisions.memory ?? 0}
                  skillRevision={feed.revisions.skill ?? 0}
                  currentWorkers={currentWorkers}
                  answerWorker={answerWorker}
                  decideWorker={decideWorker}
                  workerWatch={workerWatch}
                  submit={submit}
                  uploadAttachment={uploadAttachment}
                  openArchive={openArchive}
                  freshContext={freshContext}
                  setSeededIdea={setSeededIdea}
                  onInspect={(row) => {
                    setArtifact(row);
                    openPanel("details");
                  }}
                  navigate={navigate}
                />
              ) : (
                <PageRoute
                  route={route}
                  page={page}
                  view={view}
                  connected={state.connection === "ready"}
                  nav={nav}
                  navigate={navigate}
                  features={features}
                  sections={sections}
                  section={section}
                  centered={centered}
                  scheduleOnly={scheduleOnly}
                  scheduleTick={scheduleTick}
                  offersIdeas={offersIdeas}
                  offersOnboarding={offersOnboarding}
                  offersReminders={offersReminders}
                  homeChat={homeChat}
                  feed={feed}
                  principal={principal}
                  unseen={unseen}
                  chatEditable={chatEditable}
                  offersSkills={offersSkills}
                  onboardingFrames={onboardingFrames}
                  onModelsChanged={() => {
                    reloadTarget();
                    reloadChatModel();
                    setNewChatModel(undefined);
                  }}
                  client={client}
                  store={store}
                />
              )}
            </ViewBoundary>
          </main>
          {/* A worker's view-only transcript, beside the chat that delegated to it. */}
          {route === "chat" && worker !== undefined && worker.chatTaskId === current?.taskId ? (
            <ViewBoundary resetKey={worker.taskId}>
              <WorkerTranscript
                key={worker.taskId}
                client={client}
                worker={worker}
                revision={workerWatch}
                onClose={() => setWorker(undefined)}
              />
            </ViewBoundary>
          ) : null}
          {/* The chat panel belongs to the chat: the other routes have no session to show. */}
          {route === "chat" ? (
            <ChatPanelView
              state={state}
              store={store}
              current={current}
              panel={panel}
              setPanel={setPanel}
              setPanelWidth={setPanelWidth}
              nav={nav}
              plugins={plugins}
              takeOverHere={takeOverHere}
              asking={asking}
              browserExpanded={browserExpanded}
              setBrowserExpanded={setBrowserExpanded}
              chatSummary={chatSummary}
              chatEditable={chatEditable}
              rename={rename}
              instructionsChanged={instructionsChanged}
              currentWorkers={currentWorkers}
              answerWorker={answerWorker}
              toTranscript={toTranscript}
              artifact={artifact}
              client={client}
              shownModel={shownModel}
              setPane={setPane}
              memoryProposals={feed.summary?.counts.memoryProposals}
              chatLive={chatLive}
              chatChanged={chatChanged}
              draftInstructions={draftInstructions}
              setDraftInstructions={setDraftInstructions}
              sections={sections}
              offersReminders={offersReminders}
              navigate={navigate}
            />
          ) : null}
        </div>
        <ShellOverlays
          sheet={sheet}
          setSheet={setSheet}
          newLabel={newLabel}
          newSession={newSession}
          navigate={navigate}
          needsNotice={needsNotice}
          follow={follow}
          openSection={openSection}
          takeover={takeover}
          setTakeover={setTakeover}
          liveClient={liveClient}
          client={client}
          state={state}
          current={current}
          running={running}
          store={store}
          rereadTimer={rereadTimer}
        />
      </div>
    </AppProviders>
  );
}

/** How often Schedule alone, with no feed to say what changed, reads its lists again. */
export const SCHEDULE_ONLY_REFRESH_MS = 30_000;
