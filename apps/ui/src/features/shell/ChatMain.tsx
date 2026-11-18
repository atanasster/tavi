import { memorySeenCount, type ArtifactListRow } from "@tavi/contracts";
import { Suspense, useCallback, useState } from "react";

import { HeartbeatItemCard } from "../center/HeartbeatItem.js";
import { HeartbeatOffer } from "../center/HeartbeatOffer.js";
import { OnboardingChecklist } from "../center/OnboardingChecklist.js";
import type { waitingOf } from "../chat-panel/Activity.js";
import { CHAT_CONTEXT_FEATURE } from "../chat-panel/api.js";
import { BROWSE_FEATURE, FOLDER_FEATURE } from "../chat-panel/folder-api.js";
import { DraftFolderChip, FolderChip, draftAttachments, type DraftFolder } from "../chat-panel/Folder.js";
import type { uploadFile, UploadAttachment } from "../chat/attachments.js";
import { Canvas } from "../chat/Canvas.js";
import { MemoryCard } from "../chat/MemoryCard.js";
import { proposesSkill, SkillOfferCard } from "../chat/SkillOffer.js";
import { MemoryModeToggle } from "../chat/MemoryMode.js";
import { MemoryUsed } from "../chat/MemoryUsed.js";
import { ModelPicker } from "../chat/ModelPicker.js";
import type { CanvasStore } from "../chat/store/types.js";
import { TaintChip } from "../chat/TaintChip.js";
import type { useChatModel } from "../chat/use-chat-model.js";
import { IdeaChips } from "../ideas/IdeaChips.js";
import { targetNotice } from "../settings/models-api.js";
import type { usePageRoute } from "./route.js";
import type { shellState } from "./shell.js";
import type { useChatNavigation, ChatPane } from "./use-chat-navigation.js";
import type { useOwnerFeatures } from "./use-owner-features.js";
import { WorkerNeedCards, type WorkerRoundDecide } from "../workers/WorkerNeeds.js";
import { workerLabel } from "../workers/WorkerView.js";
import { CHAT_NOT_STARTED, NO_CHAT_SELECTED, Pending } from "../../ui/Parts.js";
import { lazyModule } from "../../ui/lazy-module.js";
import { Tabs } from "../../ui/Tabs.js";
import { usePhone } from "../../hooks/page.js";
import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { ViewBoundary } from "../../ui/ViewBoundary.js";

import { useTimeZone, useWorkspace } from "./Workspace.js";

// "Repeat this" (its schedule and routine forms) is its own chunk, fetched the first time it opens.
const repeatForms = lazyModule(() => import("../chat/RepeatThis.js").then((module) => module.RepeatForms));
const RepeatForms = repeatForms.Route;

// The views other than the transcript are each their own chunk, fetched the first time one is shown.
const trajectoryView = lazyModule(() => import("../chat/Trajectory.js").then((module) => module.Trajectory));
const changesView = lazyModule(() => import("../chat/Changes.js").then((module) => module.Changes));
const agentsView = lazyModule(() => import("../workers/AgentTree.js").then((module) => module.AgentTree));
const Trajectory = trajectoryView.Route;
const Changes = changesView.Route;
const AgentTree = agentsView.Route;
const parts = [repeatForms, trajectoryView, changesView, agentsView];

/**
 * Settles once every part the chat fetches on first use ("Repeat this" and
 * the views other than the transcript) is in, so a test reads it synchronously.
 */
export function chatPartsReady(): Promise<void> {
  return Promise.all(parts.map((part) => part.ready())).then(() => undefined);
}

/** Forgets every chat part chunk whose fetch failed, so the next render fetches it again. */
function retryChatParts(): void {
  for (const part of parts) part.retry();
}

/** What a message carries beside its prompt from the composer, and the folders picked on an empty chat. */
export interface SentExtra {
  readonly asPrompt?: boolean;
  readonly attachments?: readonly string[];
  readonly attachmentNames?: readonly string[];
  readonly folderAttachments?: ReturnType<typeof draftAttachments>;
}

/**
 * The chat route's main column: its views' tabs (transcript, trajectory,
 * changes, agents) over the canvas, with the chips, cards and pickers the
 * canvas draws in its slots. What it acts on comes from the shell.
 */
export function ChatMain({
  state,
  store,
  current,
  acting,
  nav,
  model,
  pane,
  setPane,
  features,
  sections,
  offersIdeas,
  offersOnboarding,
  homeChat,
  toHome,
  memoryRow,
  memoryRevision,
  skillRevision = 0,
  currentWorkers,
  answerWorker,
  decideWorker,
  workerWatch,
  submit,
  uploadAttachment,
  openArchive,
  freshContext,
  setSeededIdea,
  onInspect,
  navigate,
}: {
  readonly state: ReturnType<CanvasStore["getSnapshot"]>;
  readonly store: CanvasStore;
  readonly current: ReturnType<typeof shellState>["current"];
  readonly acting: ReturnType<typeof shellState>["acting"];
  readonly nav: ReturnType<typeof useChatNavigation>;
  readonly model: ReturnType<typeof useChatModel>;
  readonly pane: ChatPane;
  readonly setPane: (pane: ChatPane) => void;
  readonly features: readonly string[];
  readonly sections: ReturnType<typeof useOwnerFeatures>["sections"];
  readonly offersIdeas: boolean;
  readonly offersOnboarding: boolean;
  readonly homeChat: boolean;
  readonly toHome: boolean;
  /** The name of the chat the next prompt goes to. */
  /** The chat on screen as the chat list reads it, for its memory toggle. */
  readonly memoryRow: NonNullable<ReturnType<CanvasStore["getSnapshot"]>["directory"]>["rows"][number] | undefined;
  /** The workspace's memory revision: a memory card reads again when it moves. */
  readonly memoryRevision: number;
  /** The workspace's skills revision: a skill offer's card reads again when it moves. */
  readonly skillRevision?: number;
  readonly currentWorkers: Parameters<typeof waitingOf>[2];
  readonly answerWorker: (waitId: string, text: string) => void;
  readonly decideWorker: WorkerRoundDecide;
  readonly workerWatch: number | undefined;
  readonly submit: (prompt: string, sent?: SentExtra) => boolean;
  readonly uploadAttachment: (file: UploadAttachment) => ReturnType<typeof uploadFile>;
  readonly openArchive: (artifactId: string) => Promise<void>;
  readonly freshContext: (taskId: string) => Promise<string | undefined>;
  readonly setSeededIdea: (ideaId: string | undefined) => void;
  /** An artifact row picked in Changes: shown in the chat panel's Details. */
  readonly onInspect: (row: ArtifactListRow) => void;
  readonly navigate: ReturnType<typeof usePageRoute>["navigate"];
}) {
  const { workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const {
    newFreshSession,
    follow,
    replyToNotice,
    doHeartbeatItem,
    chatAboutHeartbeatItem,
    worker,
    setWorker,
    openSection,
    composerSeed,
    setComposerSeed,
  } = nav;
  const { shownModel, target, pickModel } = model;
  // *Repeat this…* on a message: the chat and the message it was asked on, and where to say what was created.
  const [repeating, setRepeating] = useState<{
    readonly taskId: string;
    readonly prompt: string;
    readonly report: (note: string) => void;
  }>();
  const chatTaskId = current?.taskId;
  // A chat not started yet — a new chat, or Home before its first message — has no folder to change:
  // the folders picked on it are held here, and its first message starts it with them attached.
  const next = state.next ?? { kind: "new" as const };
  const unstarted = current === undefined && (next.kind === "new" || (next.kind === "home" && state.home === undefined));
  const phone = usePhone();
  const [draftFolders, setDraftFolders] = useState<readonly DraftFolder[]>([]);
  // Their tokens are this connection's: another connection, or another workspace, cannot redeem them.
  useResetOnChange([workspaceId, state.connection], () => setDraftFolders([]));
  const send = (prompt: string, sent?: SentExtra): boolean => {
    if (!unstarted || draftFolders.length === 0) return submit(prompt, sent);
    const sentOk = submit(prompt, { ...sent, folderAttachments: draftAttachments(draftFolders) });
    if (sentOk) setDraftFolders([]);
    return sentOk;
  };
  const repeat = useCallback(
    (prompt: string, report: (note: string) => void) => {
      if (chatTaskId !== undefined) setRepeating({ taskId: chatTaskId, prompt, report });
    },
    [chatTaskId],
  );
  return (
    <>
      <div className="main-head">
        <Tabs
          label="chat views"
          className="subviews"
          items={[
            { value: "transcript" as const, label: "Transcript" },
            { value: "trajectory" as const, label: "Trajectory" },
            { value: "changes" as const, label: "Held files" },
            { value: "agents" as const, label: "Agents" },
          ]}
          current={pane}
          onPick={setPane}
        />
      </div>
      <Canvas
        modelTarget={shownModel}
        modelNotice={targetNotice(target)}
        unconfigured={target?.unconfigured === true}
        onModels={() => navigate((current) => ({ ...current, route: "settings", view: "models" }))}
        folderChip={
          unstarted && !phone && features.includes(FOLDER_FEATURE) && features.includes(BROWSE_FEATURE) ? (
            <DraftFolderChip key={`${workspaceId}:draft:folder`} draft={draftFolders} onChange={setDraftFolders} />
          ) : current?.taskId !== undefined && features.includes(FOLDER_FEATURE) ? (
            <FolderChip
              // Canvas renders folderChip, memoryToggle and taintChip as siblings of one header: each slot's key ends in its own suffix.
              key={`${workspaceId}:${current.taskId}:folder`}
              taskId={current.taskId}
              canBrowse={features.includes(BROWSE_FEATURE)}
              version={`${current.runs.length}:${current.runs.at(-1)?.run.status ?? ""}`}
            />
          ) : undefined
        }
        taintChip={
          current?.taskId !== undefined ? (
            <TaintChip
              key={`${workspaceId}:${current.taskId}:taint`}
              taskId={current.taskId}
              version={`${current.runs.length}:${current.runs.at(-1)?.run.status ?? ""}`}
              onFreshChat={newFreshSession}
            />
          ) : undefined
        }
        memoryToggle={
          memoryRow !== undefined && features.includes(CHAT_CONTEXT_FEATURE) ? (
            <MemoryModeToggle key={`${workspaceId}:${memoryRow.taskId}:memory`} taskId={memoryRow.taskId} mode={memoryRow.memoryMode} />
          ) : undefined
        }
        modelPicker={
          <ModelPicker
            key={workspaceId}
            target={shownModel}
            onPick={pickModel}
            onManage={() => navigate((current) => ({ ...current, route: "settings", view: "models" }))}
          />
        }
        content={
          pane === "transcript" ? undefined : current === undefined ? (
            <p>{NO_CHAT_SELECTED}</p>
          ) : (
            <ViewBoundary resetKey={`${current.key}:${pane}`} what="panel" onRetry={retryChatParts}>
              <Suspense fallback={<Pending />}>
                {pane === "trajectory" ? (
                  <Trajectory key={current.key} session={current} />
                ) : pane === "agents" ? (
                  current.taskId ? (
                    <AgentTree
                      key={current.key}
                      taskId={current.taskId}
                      needs={
                        <WorkerNeedCards
                          needs={currentWorkers}
                          connected={state.connection === "ready"}
                          onAnswer={answerWorker}
                          onDecide={decideWorker}
                          density="compact"
                        />
                      }
                      version={current.runs.map((run) => `${run.id}:${run.run.spawned.at(-1)?.sequence ?? ""}`).join("|")}
                      watch={workerWatch}
                      opened={worker?.chatTaskId === current.taskId ? worker.taskId : undefined}
                      onOpen={async (taskId) => {
                        await store.openTask(taskId);
                        navigate((current) => ({ ...current, taskId, route: "chat" }));
                        setPane("transcript");
                      }}
                      onOpenWorker={(node) =>
                        current.taskId === undefined
                          ? undefined
                          : setWorker({ taskId: node.taskId, label: workerLabel(node), chatTaskId: current.taskId })
                      }
                    />
                  ) : (
                    <p>{CHAT_NOT_STARTED}</p>
                  )
                ) : (
                  <Changes key={current.key} taskId={current.taskId} onInspect={onInspect} />
                )}
              </Suspense>
            </ViewBoundary>
          )
        }
        state={state}
        session={current}
        acting={acting}
        onSubmit={send}
        onUpload={uploadAttachment}
        onLoadArtifacts={store.loadArtifacts}
        onReview={store.reviewArtifacts}
        onAnswer={store.answerQuestion}
        workers={currentWorkers}
        onAnswerWorker={answerWorker}
        onDecideWorker={decideWorker}
        notices={current?.taskId === undefined ? undefined : state.notices?.[current.taskId]}
        onOpenNotice={(taskId) => void follow(taskId)}
        onReplyNotice={replyToNotice}
        heartbeatOffer={
          offersOnboarding && homeChat ? (
            // Setup's checklist shares the slot with the heartbeat offer: one proactive card at a time.
            <OnboardingChecklist
              key={workspaceId}
              offer={sections.includes("heartbeat") ? (onDone) => <HeartbeatOffer key={workspaceId} onDone={onDone} /> : undefined}
              ideas={offersIdeas}
              onOpenStep={(stepId) => navigate((current) => ({ ...current, route: "welcome", stepId, welcomeAll: undefined }))}
            />
          ) : homeChat && sections.includes("heartbeat") ? (
            <HeartbeatOffer key={workspaceId} />
          ) : undefined
        }
        memoryCard={(notice) => (
          <MemoryCard
            noticeId={notice.noticeId}
            version={`${notice.createdAt}|${memoryRevision}`}
            connected={state.connection === "ready"}
            onReview={sections.includes("identity") ? () => openSection("identity") : undefined}
          />
        )}
        skillOffer={
          features.includes("skills")
            ? (run, index, runs) => {
                const taskId = run.run.taskId ?? run.continues;
                return taskId === undefined || !proposesSkill(run) ? null : (
                  <SkillOfferCard
                    taskId={taskId}
                    runs={runs}
                    index={index}
                    revision={skillRevision}
                    connected={state.connection === "ready"}
                    onReview={sections.includes("identity") ? () => openSection("identity") : undefined}
                  />
                );
              }
            : undefined
        }
        memoryUsedChip={(run) => {
          const taskId = run.run.taskId ?? run.continues;
          return taskId === undefined ||
            run.memorySeq === undefined ||
            run.memoryUsed === undefined ||
            memorySeenCount(run.memoryUsed) === 0 ? null : (
            <MemoryUsed
              key={`${taskId}:${run.memorySeq}`}
              taskId={taskId}
              seq={run.memorySeq}
              used={run.memoryUsed}
              connected={state.connection === "ready"}
            />
          );
        }}
        heartbeatCard={(notice) => (
          <HeartbeatItemCard
            itemId={notice.heartbeatItemId}
            timeZone={timeZone}
            connected={state.connection === "ready"}
            onDoIt={doHeartbeatItem}
            onChat={chatAboutHeartbeatItem}
          />
        )}
        onOpenArchive={(artifactId) => void openArchive(artifactId)}
        onFreshContext={current?.taskId === undefined ? undefined : () => freshContext(current.taskId as string)}
        onDecide={store.decide}
        onAbort={store.abort}
        onExpand={store.setExpanded}
        onCancelQueued={store.cancelQueued}
        onRewind={store.rewind}
        onRepeat={sections.includes("schedule") && chatTaskId !== undefined ? repeat : undefined}
        onSteerQueued={store.steerQueued}
        onLoadEarlier={store.loadEarlier}
        composerSeed={composerSeed}
        onComposerSeeded={() => setComposerSeed(undefined)}
        // The idea goes with the words it put in the box: emptied, the next message is the person's own.
        onComposerCleared={() => setSeededIdea(undefined)}
        ideaChips={
          offersIdeas && worker === undefined
            ? (fill, hidden) => (
                <IdeaChips
                  key={workspaceId}
                  ideas={!toHome}
                  hidden={hidden}
                  onFill={(prompt, ideaId) => {
                    setSeededIdea(ideaId);
                    fill(prompt);
                  }}
                  onOpenTask={(taskId) => void follow(taskId)}
                  onMore={() => navigate((current) => ({ ...current, route: "ideas" }))}
                />
              )
            : undefined
        }
      />
      {repeating !== undefined && current !== undefined && repeating.taskId === current.taskId ? (
        <ViewBoundary resetKey={`${repeating.taskId}:${repeating.prompt}`} what="panel" onRetry={retryChatParts}>
          <Suspense fallback={null}>
            <RepeatForms
              key={`${repeating.taskId}:${repeating.prompt}`}
              source={{ taskId: repeating.taskId, prompt: repeating.prompt, runs: current.runs }}
              onClose={() => setRepeating(undefined)}
              onDone={(note) => {
                setRepeating(undefined);
                repeating.report(note);
              }}
            />
          </Suspense>
        </ViewBoundary>
      ) : null}
    </>
  );
}
