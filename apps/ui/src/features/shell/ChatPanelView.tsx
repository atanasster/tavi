import { pluginUiUrl, type ArtifactListRow } from "@tavi/contracts";
import { Suspense } from "react";

import { Activity, revealTurn, revealWaiting, waitingOf } from "../chat-panel/Activity.js";
import type { useChatSummary } from "../chat-panel/badges.js";
import { ChatPanel } from "../chat-panel/ChatPanel.js";
import { isPluginPanelTab, pluginPanelTab } from "../chat-panel/tabs.js";
import type { CanvasStore } from "../chat/store/types.js";
import type { useChatModel } from "../chat/use-chat-model.js";
import { ChatPanelTop } from "../plugin-host/ChatPanelTop.js";
import { PluginPanelTab } from "../plugin-host/PluginPanelTab.js";
import { contributionKey } from "../plugin-host/slots.js";
import type { usePluginSlots } from "../plugin-host/use-plugin-slots.js";
import type { usePageRoute } from "./route.js";
import { headerStatusLabel, TASK_STATUS_LABELS, type shellState } from "./shell.js";
import { workersWait } from "../workers/WorkerNeeds.js";
import type { useChatNavigation, ChatPane } from "./use-chat-navigation.js";
import type { useOwnerFeatures } from "./use-owner-features.js";
import type { useTakeoverState } from "../takeover/use-takeover-state.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { lazyModule } from "../../ui/lazy-module.js";
import { Pending } from "../../ui/Parts.js";
import { ViewBoundary } from "../../ui/ViewBoundary.js";

import { useWorkspace } from "./Workspace.js";

// The tabs other than Activity (the one a chat opens on) are each their own chunk, fetched the first time one is shown.
const scheduleTab = lazyModule(() => import("../chat-panel/Schedule.js").then((module) => module.Schedule));
const detailsTab = lazyModule(() => import("../chat-panel/Details.js").then((module) => module.Details));
const memoryTab = lazyModule(() => import("../chat-panel/Memory.js").then((module) => module.Memory));
const instructionsTab = lazyModule(() => import("../chat-panel/Instructions.js").then((module) => module.Instructions));
const ChatSchedule = scheduleTab.Route;
const Details = detailsTab.Route;
const ChatMemory = memoryTab.Route;
const Instructions = instructionsTab.Route;
const tabs = [scheduleTab, detailsTab, memoryTab, instructionsTab];

/**
 * Settles once every panel tab the chat fetches on first view is in, so a
 * test that opens one reads it synchronously instead of waiting out a suspense.
 */
export function panelTabsReady(): Promise<void> {
  return Promise.all(tabs.map((tab) => tab.ready())).then(() => undefined);
}

/** Forgets every panel tab chunk whose fetch failed, so the next render fetches it again. */
function retryPanelTabs(): void {
  for (const tab of tabs) tab.retry();
}

/**
 * The chat's panel beside the chat route: its tabs (activity, schedule,
 * details, memory, instructions and the plugins' own), their badges, the
 * plugins' strip on top, and the chat's name renamed in place.
 */
export function ChatPanelView({
  state,
  store,
  current,
  panel,
  setPanel,
  setPanelWidth,
  nav,
  plugins,
  takeOverHere,
  asking,
  browserExpanded,
  setBrowserExpanded,
  chatSummary,
  chatEditable,
  rename,
  instructionsChanged,
  currentWorkers,
  answerWorker,
  toTranscript,
  artifact,
  client,
  shownModel,
  setPane,
  memoryProposals,
  chatLive,
  chatChanged,
  draftInstructions,
  setDraftInstructions,
  sections,
  offersReminders,
  navigate,
}: {
  readonly state: ReturnType<CanvasStore["getSnapshot"]>;
  readonly store: CanvasStore;
  readonly current: ReturnType<typeof shellState>["current"];
  readonly panel: Parameters<typeof usePluginSlots>[0]["panel"];
  readonly setPanel: Parameters<typeof usePluginSlots>[0]["setPanel"];
  readonly setPanelWidth: (width: number) => void;
  readonly nav: ReturnType<typeof useChatNavigation>;
  readonly plugins: ReturnType<typeof usePluginSlots>;
  readonly takeOverHere: ReturnType<typeof useTakeoverState>["takeOverHere"];
  readonly asking: Parameters<typeof useTakeoverState>[0]["asking"];
  readonly browserExpanded: boolean;
  readonly setBrowserExpanded: (expanded: boolean) => void;
  readonly chatSummary: ReturnType<typeof useChatSummary>;
  readonly chatEditable: boolean;
  readonly rename: (title: string | null) => Promise<string | undefined>;
  readonly instructionsChanged: boolean;
  readonly currentWorkers: Parameters<typeof waitingOf>[2];
  readonly answerWorker: (waitId: string, text: string) => void;
  /** Show the transcript, then act on it once it is drawn. */
  readonly toTranscript: (then: () => void) => void;
  readonly artifact: ArtifactListRow | undefined;
  readonly client: SettingsClient;
  readonly shownModel: ReturnType<typeof useChatModel>["shownModel"];
  readonly setPane: (pane: ChatPane) => void;
  readonly memoryProposals: number | undefined;
  /** What changes when a turn of the open chat ends or the workspace's memory changes. */
  readonly chatLive: string;
  readonly chatChanged: () => void;
  readonly draftInstructions: string;
  readonly setDraftInstructions: (draft: string) => void;
  readonly sections: ReturnType<typeof useOwnerFeatures>["sections"];
  readonly offersReminders: boolean;
  readonly navigate: ReturnType<typeof usePageRoute>["navigate"];
}) {
  const { workspaceId } = useWorkspace();
  const { follow, openSection, openReminder, openRoutine, openSchedule } = nav;
  const {
    liveClient,
    tabItems,
    shownTopItems,
    pluginBadges,
    setPluginBadges,
    chatActive,
    pluginNavigate,
    pluginShortcut,
    pluginContext,
    modStates,
  } = plugins;
  return (
    <ChatPanel
      open={panel.open}
      tab={panel.tab}
      // Home's own title as the shell says it, in the page's language; a rename as the reader wrote it.
      title={
        current?.taskId !== undefined && current.taskId === state.home && !chatSummary.renamed
          ? current.title
          : (chatSummary.title ?? current?.title)
      }
      status={
        current === undefined
          ? undefined
          : workersWait(currentWorkers)
            ? TASK_STATUS_LABELS["input-required"]
            : headerStatusLabel(current.status, current.taskId !== undefined && current.taskId === state.home)
      }
      onRename={chatEditable && current?.taskId !== undefined ? rename : undefined}
      renamed={chatSummary.renamed}
      titleKey={current?.key}
      badges={{
        ...chatSummary.badges,
        ...(instructionsChanged ? { instructions: "dot" as const } : {}),
        activity: current === undefined ? 0 : waitingOf(current, true, currentWorkers).length,
      }}
      onOpen={(open) => setPanel((now) => ({ ...now, open }))}
      onTab={(tab) => setPanel((now) => ({ ...now, tab }))}
      onWidthChange={setPanelWidth}
      pluginTabs={
        liveClient === undefined
          ? []
          : tabItems.map((item) => {
              const key = contributionKey(item);
              const badge = pluginBadges[key];
              return {
                tab: pluginPanelTab(key),
                label: item.contribution.title,
                ...(item.contribution.icon === undefined ? {} : { icon: pluginUiUrl(item, item.contribution.icon) }),
                ...(badge === undefined ? {} : { badge }),
              };
            })
      }
      top={
        liveClient === undefined || shownTopItems.length === 0
          ? undefined
          : (sheet) => (
              <ChatPanelTop
                items={shownTopItems}
                client={liveClient}
                context={pluginContext}
                modStates={modStates}
                active={chatActive}
                sheet={sheet}
                onNavigate={pluginNavigate}
                onShortcut={pluginShortcut}
                attention={asking?.handoff !== undefined}
                {...(takeOverHere === undefined ? {} : { onTakeOver: takeOverHere })}
              />
            )
      }
      render={(tab) => (
        <ViewBoundary resetKey={`${current?.key ?? ""}:${tab}`} what="panel" onRetry={retryPanelTabs}>
          <Suspense fallback={<Pending />}>
            {isPluginPanelTab(tab) ? (
              (() => {
                const item = tabItems.find((candidate) => pluginPanelTab(contributionKey(candidate)) === tab);
                return item === undefined || liveClient === undefined ? null : (
                  <PluginPanelTab
                    item={item}
                    client={liveClient}
                    context={pluginContext}
                    visible={panel.open}
                    expanded={browserExpanded}
                    onExpanded={setBrowserExpanded}
                    onTakeOver={takeOverHere}
                    attention={asking?.handoff !== undefined}
                    onNavigate={(target) => pluginNavigate(item.pluginId, target)}
                    onShortcut={pluginShortcut}
                    onBadge={(badge) =>
                      setPluginBadges((now) => ({ ...now, [contributionKey(item)]: badge.dot === true ? "dot" : (badge.count ?? 0) }))
                    }
                    modState={modStates[item.pluginId]}
                  />
                );
              })()
            ) : tab === "activity" ? (
              <Activity
                key={current?.key}
                session={current}
                workspaceId={workspaceId}
                onTurn={(turn) => toTranscript(() => revealTurn(document, turn))}
                onWaiting={() => toTranscript(() => revealWaiting(document))}
                onOpenTask={(taskId) => void follow(taskId)}
                onCenter={sections.includes("activity") ? () => openSection("activity") : undefined}
                onAnswer={store.answerQuestion}
                workers={currentWorkers}
                onAnswerWorker={answerWorker}
                connected={state.connection === "ready"}
              />
            ) : tab === "schedule" ? (
              <ChatSchedule
                key={current?.key}
                session={current}
                reminders={offersReminders}
                repeat={sections.includes("schedule")}
                onOpenReminder={openReminder}
                onOpenRoutine={(routineId) => openRoutine(routineId)}
                onOpenSchedule={sections.includes("schedule") ? openSchedule : undefined}
                onCenter={sections.includes("schedule") ? () => openSection("schedule") : undefined}
              />
            ) : tab === "details" ? (
              <Details
                key={current?.key}
                artifact={artifact?.runId === current?.taskId && artifact?.workspaceId === workspaceId ? artifact : undefined}
                session={current}
                client={client}
                modelTarget={shownModel}
                onChanges={() => setPane("changes")}
                onBrowser={sections.includes("browser") ? () => openSection("browser") : undefined}
              />
            ) : tab === "memory" ? (
              <ChatMemory
                key={current?.key}
                session={current}
                editable={chatEditable}
                proposals={memoryProposals}
                version={chatLive}
                onChanged={chatChanged}
                onCenter={sections.includes("identity") ? () => openSection("identity") : undefined}
              />
            ) : (
              <Instructions
                key={current?.key}
                session={current}
                editable={chatEditable}
                draft={draftInstructions}
                onDraft={setDraftInstructions}
                onSettings={() => navigate((now) => ({ ...now, route: "settings", view: "system-prompt" }))}
                onSoul={sections.includes("identity") ? () => openSection("identity") : undefined}
                onOpenTask={(taskId) => void follow(taskId)}
                onSaved={chatChanged}
                version={chatLive}
              />
            )}
          </Suspense>
        </ViewBoundary>
      )}
    />
  );
}
