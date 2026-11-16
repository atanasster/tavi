import { Suspense } from "react";

import type { useCenterFeed } from "../center/feed.js";
import type { useUnseenReminders } from "../center/ReminderNotifications.js";
import type { CanvasStore } from "../chat/store/types.js";
import type { usePluginSlots } from "../plugin-host/use-plugin-slots.js";
import type { usePageRoute } from "./route.js";
import type { useChatNavigation } from "./use-chat-navigation.js";
import type { useOwnerFeatures } from "./use-owner-features.js";
import { reloadAfterReset } from "../startup/reset.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { lazyModule } from "../../ui/lazy-module.js";
import { Notice, Pending } from "../../ui/Parts.js";

import { useWorkspace } from "./Workspace.js";

const centerPage = lazyModule(() => import("../center/Center.js").then((module) => module.CenterPage));
const schedule = lazyModule(() => import("../center/Schedule.js").then((module) => module.Schedule));
const ideasPage = lazyModule(() => import("../ideas/IdeasPage.js").then((module) => module.IdeasPage));
const settings = lazyModule(() => import("../settings/SettingsPage.js").then((module) => module.Settings));
const welcome = lazyModule(() => import("../welcome/Welcome.js").then((module) => module.Welcome));
const CenterPage = centerPage.Route;
const Schedule = schedule.Route;
const IdeasPage = ideasPage.Route;
const Settings = settings.Route;
const Welcome = welcome.Route;

/** Each page is its own chunk, fetched the first time it is shown (`lazyModule`). */
const pages = [centerPage, schedule, ideasPage, settings, welcome];

/**
 * Settles once every page `PageRoute` draws is fetched, so a test that
 * renders one reads it synchronously instead of waiting out a suspense.
 */
export function pageRoutesReady(): Promise<void> {
  return Promise.all(pages.map((page) => page.ready())).then(() => undefined);
}

/** Forgets every page chunk whose fetch failed, so the next render fetches it again. */
export function retryPageRoutes(): void {
  for (const page of pages) page.retry();
}

/**
 * The shell's routes other than the chat: Ideas, setup (Welcome), the
 * Command Center (or Schedule alone, on an owner that offers only that) and
 * Settings, each with the words for an owner that does not offer it.
 */
export function PageRoute({
  route,
  page,
  view,
  connected,
  nav,
  navigate,
  features,
  sections,
  section,
  centered,
  scheduleOnly,
  scheduleTick,
  offersIdeas,
  offersOnboarding,
  offersReminders,
  homeChat,
  feed,
  principal,
  unseen,
  chatEditable,
  offersSkills,
  onboardingFrames,
  onModelsChanged,
  client,
  store,
}: {
  readonly route: Exclude<ReturnType<typeof usePageRoute>["page"]["route"], "chat">;
  readonly page: ReturnType<typeof usePageRoute>["page"];
  readonly view: ReturnType<typeof usePageRoute>["page"]["view"];
  /** The owner is reachable: an unoffered route says it is not offered, not that it is waiting. */
  readonly connected: boolean;
  readonly nav: ReturnType<typeof useChatNavigation>;
  readonly navigate: ReturnType<typeof usePageRoute>["navigate"];
  readonly features: readonly string[];
  readonly sections: ReturnType<typeof useOwnerFeatures>["sections"];
  readonly section: ReturnType<typeof useOwnerFeatures>["section"];
  readonly centered: boolean;
  readonly scheduleOnly: boolean;
  /** Schedule alone's refetch key. */
  readonly scheduleTick: number;
  readonly offersIdeas: boolean;
  readonly offersOnboarding: boolean;
  readonly offersReminders: boolean;
  readonly homeChat: boolean;
  readonly feed: ReturnType<typeof useCenterFeed>;
  readonly principal: string | undefined;
  readonly unseen: ReturnType<typeof useUnseenReminders>;
  readonly chatEditable: boolean;
  /** Whether the owner offers the `skills` command. */
  readonly offersSkills: boolean;
  readonly onboardingFrames: ReturnType<typeof usePluginSlots>["onboardingFrames"];
  /** The models changed in Settings or setup: the chat's model is read again. */
  readonly onModelsChanged: () => void;
  readonly client: Parameters<typeof reloadAfterReset>[0] & SettingsClient;
  readonly store: CanvasStore;
}) {
  const { workspaceId } = useWorkspace();
  const {
    tryIdeaPrompt,
    follow,
    openSection,
    openRoutine,
    openReminder,
    openSchedule,
    followWithPanel,
    followWorker,
    followBrowserSession,
    ruleFocus,
    setRuleFocus,
    doHeartbeatItem,
    chatAboutHeartbeatItem,
  } = nav;
  return (
    <Suspense fallback={<Pending />}>
      {route === "ideas" ? (
        offersIdeas ? (
          <IdeasPage
            key={workspaceId}
            onTry={tryIdeaPrompt}
            onModels={() => navigate((current) => ({ ...current, route: "settings", view: "models" }))}
            onSettings={() => navigate((current) => ({ ...current, route: "settings", view: "ideas" }))}
            onOpenTask={(taskId) => void follow(taskId)}
            onOpenMemory={sections.includes("identity") ? () => openSection("identity") : undefined}
          />
        ) : (
          <Notice className="center-unavailable">
            {connected ? "This owner does not offer Ideas. Restart `tavi serve` with this build to use them." : "Waiting for the owner…"}
          </Notice>
        )
      ) : route === "welcome" ? (
        offersOnboarding ? (
          <Welcome
            key={workspaceId}
            client={client}
            workspaceId={workspaceId}
            stepId={page.stepId}
            all={page.welcomeAll === true}
            onStep={(stepId, options) => navigate((current) => ({ ...current, route: "welcome", stepId }), options)}
            onLeave={() =>
              navigate((current) => ({ ...current, route: "chat", taskId: undefined, stepId: undefined, welcomeAll: undefined }))
            }
            onSettings={(next) =>
              navigate((current) => ({ ...current, route: "settings", view: next, stepId: undefined, welcomeAll: undefined }))
            }
            onModelsChanged={onModelsChanged}
            onTry={tryIdeaPrompt}
            frames={onboardingFrames}
            memory={features.includes("memory")}
          />
        ) : (
          <Notice className="center-unavailable">
            {connected
              ? "This owner does not offer setup here. Run `tavi onboard` in a terminal, or restart `tavi serve` with this build."
              : "Waiting for the owner…"}
          </Notice>
        )
      ) : route === "center" ? (
        centered ? (
          <CenterPage
            homeChat={homeChat}
            onDoHeartbeatItem={doHeartbeatItem}
            onChatAboutHeartbeatItem={chatAboutHeartbeatItem}
            section={section}
            feed={feed}
            principal={principal}
            routineId={page.routineId}
            runId={page.runId}
            reminderId={page.reminderId}
            scheduleId={page.scheduleId}
            reminders={offersReminders}
            sections={sections}
            unseen={unseen}
            onSection={openSection}
            onOpenRoutine={openRoutine}
            onOpenReminder={openReminder}
            onOpenSchedule={openSchedule}
            onOpenTask={follow}
            onOpenTaskWithPanel={followWithPanel}
            onOpenWorker={followWorker}
            chatNotes={chatEditable}
            skills={offersSkills}
            onOpenBrowserSession={followBrowserSession}
            onPermissions={(ruleId) => {
              setRuleFocus(ruleId);
              navigate((current) => ({ ...current, route: "settings", view: "permissions" }));
            }}
            onModels={() => navigate((current) => ({ ...current, route: "settings", view: "models" }))}
          />
        ) : scheduleOnly ? (
          <div className="center center-alone">
            <div className="center-main">
              <Schedule
                key={workspaceId}
                summary={undefined}
                revision={scheduleTick}
                routineId={page.routineId}
                runId={page.runId}
                reminderId={page.reminderId}
                scheduleId={page.scheduleId}
                reminders={offersReminders}
                onOpenRoutine={openRoutine}
                onOpenReminder={openReminder}
                onOpenSchedule={openSchedule}
                onFollow={follow}
              />
            </div>
          </div>
        ) : (
          <Notice className="center-unavailable">
            {connected
              ? "This owner does not offer the Command Center. Restart `tavi serve` with this build to use it."
              : "Waiting for the owner…"}
          </Notice>
        )
      ) : (
        <Settings
          view={view}
          ruleId={ruleFocus}
          ideas={offersIdeas}
          pluginRevision={feed.revisions.plugin ?? 0}
          apps={{ tab: page.appsTab ?? "connected", appId: page.appId, connect: page.appConnect, query: page.appsQuery }}
          onApps={(where) =>
            navigate((current) => ({
              ...current,
              view: "apps",
              appsTab: where.tab,
              appId: where.appId,
              appConnect: where.connect,
              appsQuery: undefined,
            }))
          }
          onOpenTask={(taskId) => void follow(taskId)}
          onModelsChanged={onModelsChanged}
          onPluginOff={store.dropPluginStatus}
          onRunSetup={
            offersOnboarding
              ? () => navigate((current) => ({ ...current, route: "welcome", stepId: undefined, welcomeAll: true }))
              : undefined
          }
          onReset={() =>
            reloadAfterReset({
              ...(client.state === undefined ? {} : { state: client.state }),
              ...(client.onState === undefined ? {} : { onState: client.onState.bind(client) }),
            })
          }
        />
      )}
    </Suspense>
  );
}
