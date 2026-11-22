import type { ReminderFireView } from "@tavi/contracts";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { Notice } from "../../ui/Parts.js";
import type { CenterSection } from "../shell/route.js";
import { mcpActions } from "../settings/plugins-api.js";
import { appActions } from "../apps/apps-api.js";
import type { Outcome, SettingsClient } from "../../lib/ipc.js";
import { Activity } from "./Activity.js";
import { Browser } from "./Browser.js";
import { Heartbeat } from "./Heartbeat.js";
import { HeartbeatPill } from "./HeartbeatPill.js";
import { HeartbeatOffer } from "./HeartbeatOffer.js";
import type { HeartbeatItemView } from "./HeartbeatItem.js";
import type { CenterFeed } from "./feed.js";
import { ApprovalsInbox } from "./Inbox.js";
import { UnseenReminderCards } from "./ReminderNotifications.js";
import { Schedule } from "./Schedule.js";
import { SoulAndMemory } from "./Soul.js";
import { useWorkspace } from "../shell/Workspace.js";
import { type AppRepairItem, CenterRail } from "./CenterRail.js";
import { translateNow, useT } from "../../lib/i18n.js";

/**
 * The Command Center: the section nav in the
 * sessions column, the section in the main one, and a rail of what needs the
 * reader and what runs next. Every number comes from the feed's one summary.
 */

/** The page on the center route: the section, then the rail. */
export function CenterPage({
  section,
  feed,
  principal,
  routineId,
  runId,
  reminderId,
  scheduleId,
  reminders,
  sections,
  unseen,
  onSection,
  onOpenRoutine,
  onOpenReminder,
  onOpenSchedule,
  onOpenTask,
  onOpenTaskWithPanel,
  onOpenWorker,
  chatNotes = false,
  skills = false,
  onOpenBrowserSession,
  onPermissions,
  onModels,
  onDoHeartbeatItem,
  onChatAboutHeartbeatItem,
  homeChat = false,
}: {
  readonly section: CenterSection;
  readonly feed: CenterFeed;
  /** The routine (and run) the address names, inside Schedule. */
  readonly routineId?: string | undefined;
  readonly runId?: string | undefined;
  /** The reminder the address names, inside Schedule. */
  readonly reminderId?: string | undefined;
  /** The plain schedule the address names, inside Schedule. */
  readonly scheduleId?: string | undefined;
  /** Schedule's lists (no routine), a routine's page, or one of its runs. */
  readonly onOpenRoutine: (routineId: string | undefined, runId?: string) => void;
  /** A reminder's page inside Schedule. */
  readonly onOpenReminder?: ((reminderId: string) => void) | undefined;
  /** A plain schedule's page inside Schedule. */
  readonly onOpenSchedule?: ((scheduleId: string) => void) | undefined;
  /** Whether the owner offers `reminders`. */
  readonly reminders?: boolean | undefined;
  /** The sections this owner offers (`offeredSections`); absent, every one. The rail leads only to these. */
  readonly sections?: readonly CenterSection[] | undefined;
  /** Fired reminders not yet seen, for the rail, and how to read them again once one is answered. */
  readonly unseen?: { readonly fires: readonly ReminderFireView[] | undefined; readonly reload: () => void } | undefined;
  /** Who a decision made here is recorded as (`decidedBy`), as the task's own card records it. */
  readonly principal?: string | undefined;
  readonly onSection: (section: CenterSection) => void;
  readonly onOpenTask: (taskId: string) => Promise<void>;
  /** Open a task in the chat with its panel open on `tab`. */
  readonly onOpenTaskWithPanel?: ((taskId: string, tab: "activity" | "memory") => Promise<void>) | undefined;
  /** A delegated worker's view-only transcript, beside its root chat. */
  readonly onOpenWorker?: ((rootTaskId: string, worker: { readonly taskId: string; readonly label: string }) => Promise<void>) | undefined;
  /** Whether the owner keeps chat notes (`chat-context`): Soul & memory then lists them across chats. */
  readonly chatNotes?: boolean | undefined;
  /** Whether the owner offers the `skills` command: Soul & memory then lists the workspace's skills. */
  readonly skills?: boolean | undefined;
  /** A browser card: its task, at the tool call that opened the session (`openedByCallId`) when there is one. */
  readonly onOpenBrowserSession?: ((taskId: string, callId: string | undefined) => Promise<void>) | undefined;
  /** Settings → Permissions, where an "Always allow" rule is revoked; with a rule, that rule. */
  readonly onPermissions: (ruleId?: string) => void;
  /** Settings → Models: the memory settings link there for the capture model. */
  readonly onModels?: (() => void) | undefined;
  /** Whether Home is on: the heartbeat's first-run offer is shown there, else in the rail. */
  readonly homeChat?: boolean | undefined;
  /** A heartbeat item's *Do it* and *Chat about this*. */
  readonly onDoHeartbeatItem?: ((item: HeartbeatItemView) => void) | undefined;
  readonly onChatAboutHeartbeatItem?: ((item: HeartbeatItemView) => void) | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const decisions = (feed.revisions.approval ?? 0) + (feed.revisions.review ?? 0) + (feed.revisions.question ?? 0);
  /**
   * The rail's memory proposals were followed: Soul & memory focuses its
   * proposals once, then reports it served the request. Leaving the section
   * first drops it, so a later visit through the nav lands on the section only.
   */
  const [proposalsFocus, setProposalsFocus] = useState(false);
  /** Bumped by each heartbeat change made in its section, so the rail's pill reads it again. */
  const [heartbeatRevision, setHeartbeatRevision] = useState(0);
  const heartbeatChanged = useCallback(() => setHeartbeatRevision((value) => value + 1), []);
  const proposalsFocused = useCallback(() => setProposalsFocus(false), []);
  useResetOnChange([section], () => {
    if (section !== "identity") setProposalsFocus(false);
  });
  /*
   * One scroller holds every section, so a section opened from far down
   * another one would open as far down, its heading out of sight. Back to the
   * top on each new page — before a section's own effects scroll to what it
   * focuses (the rail's memory proposals, a day in Activity).
   */
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current !== null) scroller.current.scrollTop = 0;
  }, [section, routineId, runId, reminderId, scheduleId]);
  return (
    <div className="center" ref={scroller}>
      <div className="center-main">
        {feed.error === undefined ? null : <Notice>{t("center.page.paused", { error: feed.error })}</Notice>}
        {section === "activity" ? (
          <Activity
            key={workspaceId}
            summary={feed.summary}
            revision={feed.revisions.task ?? 0}
            onOpen={onOpenTask}
            onOpenWithPanel={onOpenTaskWithPanel === undefined ? undefined : (taskId) => onOpenTaskWithPanel(taskId, "activity")}
            onOpenWorker={onOpenWorker}
          />
        ) : section === "approvals" ? (
          <ApprovalsInbox
            key={workspaceId}
            summary={feed.summary}
            revision={decisions}
            principal={principal}
            onOpenTask={onOpenTask}
            onPermissions={onPermissions}
          />
        ) : section === "schedule" ? (
          <Schedule
            key={workspaceId}
            summary={feed.summary}
            revision={(feed.revisions.routine ?? 0) + (feed.revisions.schedule ?? 0) + (feed.revisions.reminder ?? 0)}
            routineId={routineId}
            runId={runId}
            reminderId={reminderId}
            scheduleId={scheduleId}
            reminders={reminders}
            onOpenRoutine={onOpenRoutine}
            onOpenReminder={onOpenReminder}
            onOpenSchedule={onOpenSchedule}
            heartbeat={sections === undefined || sections.includes("heartbeat")}
            onOpenHeartbeat={() => onSection("heartbeat")}
            onFollow={onOpenTask}
          />
        ) : section === "heartbeat" ? (
          <Heartbeat key={workspaceId} onChanged={heartbeatChanged} onDoIt={onDoHeartbeatItem} onChat={onChatAboutHeartbeatItem} />
        ) : section === "identity" ? (
          <SoulAndMemory
            key={workspaceId}
            summary={feed.summary}
            revision={feed.revisions.memory ?? 0}
            skillsRevision={skills ? (feed.revisions.skill ?? 0) : undefined}
            onOpenChatNotes={
              onOpenTaskWithPanel === undefined || !chatNotes ? undefined : (taskId) => onOpenTaskWithPanel(taskId, "memory")
            }
            focusProposals={proposalsFocus}
            onProposalsFocused={proposalsFocused}
            onModels={onModels}
            onOpenRoutine={sections === undefined || sections.includes("schedule") ? (routineId) => onOpenRoutine(routineId) : undefined}
          />
        ) : (
          <Browser
            key={workspaceId}
            summary={feed.summary}
            revision={feed.revisions.browser ?? 0}
            onOpenTask={onOpenBrowserSession ?? ((taskId) => onOpenTask(taskId))}
          />
        )}
      </div>
      <CenterRail
        summary={feed.summary}
        hideComingUp={section === "schedule"}
        sections={sections}
        unseenReminders={unseen?.fires?.length ?? 0}
        heartbeat={
          sections === undefined || sections.includes("heartbeat") ? (
            <>
              {/* With Home off, the first-run offer has the rail. */}
              {homeChat ? null : <HeartbeatOffer key={`offer-${workspaceId}`} onDone={heartbeatChanged} />}
              <HeartbeatPill key={workspaceId} revision={heartbeatRevision} onOpen={() => onSection("heartbeat")} />
            </>
          ) : undefined
        }
        reminders={
          unseen?.fires === undefined ? undefined : (
            <UnseenReminderCards fires={unseen.fires} timeZone={feed.summary?.timezone} changed={unseen.reload} />
          )
        }
        onSection={onSection}
        onOpenSchedule={onOpenSchedule}
        onFixApp={(item) => fixAppInPlace(client, workspaceId, item)}
        onProposals={() => {
          onSection("identity");
          setProposalsFocus(true);
        }}
      />
    </div>
  );
}

/** An in-place repair, as the app's page runs it: *Try again* tests the server, *Turn on* enables it here. */
async function fixAppInPlace(client: SettingsClient, workspaceId: string, item: AppRepairItem): Promise<Outcome<unknown>> {
  const accountId = item.accountId;
  if (accountId === undefined) return { ok: false, message: translateNow("center.page.openAppToFix") };
  return item.kind === "retry"
    ? appActions.test(client, workspaceId, item.appId, accountId)
    : mcpActions.setEnabled(client, accountId, true, workspaceId);
}
