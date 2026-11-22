import { TERMINAL_TASK_STATUSES } from "@tavi/agent-host/agent-communication";
import {
  ATTENDED_TASK_POLICY,
  TaviError,
  HOME_CHAT_INDEX,
  automaticDecider,
  decidableRound,
  homeConversationId,
  pendingRoundFromAdmission,
  roundResumeKey,
  isUntrusted,
  untrustedLabel,
  type ChatFolderMode,
  type ChatSeed,
  type ContentLabel,
  type InboundBlock,
  type InvocationContext,
  type IpcCursor,
  type PendingRound,
  type PersistencePort,
  type PolicyStopped,
  type RunPayload,
  type RunResult,
  type TaskRecord,
  type WorkflowPort,
  type ModelTarget,
  type RunFolderResult,
  type TaskRoutingPort,
  englishOf,
  navPath,
} from "@tavi/contracts";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
import type { ChatFolders, RunEventBus } from "@tavi/runtime";
import type { LocalChatModels } from "../models/local-chats.js";
import { LOCAL_CHAIN_UNAVAILABLE } from "../router/task-routing.js";

import { attachmentBlock, namedAttachments } from "./attachment-intake.js";
import {
  pendingRoundRefusal,
  refuse,
  refusalOf,
  runningHere,
  targetRefusal,
  unconfiguredRefusal,
  type IpcAnswer,
  type IpcRefusal,
} from "../../shared/ipc-decisions.js";
import { attemptIdFor, emitOutcomeEvents } from "./run-events.js";
import { approveReviewRound, automaticDecision } from "./workers.js";

/**
 * IPC `run`: admit a prompt under the owner's own model target and
 * answer as soon as the run can no longer be refused.
 *
 * `WorkflowPort.admit` resolves only when the turn finishes or suspends, so it
 * is started un-awaited and the response is settled from `onAdmitted` — for a
 * new task, a replay of a committed key, or the same key already running here,
 * nothing can refuse it after that point. A retry of an admission left in doubt
 * (its owner died mid-run) can still be refused before its claim — the dead
 * owner's lease — and the decorator publishes nothing for an unclaimed
 * admission, so that retry is answered from its claim or from the refusal
 * instead, never with a subscription that would stay silent. A rejection after
 * the answer ends the stream with the decorator's `task.failed` when it was
 * claimed, and is logged here.
 */

/**
 * A model target the owner runs, and where it came from: the
 * one resolved at startup — what `liveTarget` resolves again, from its
 * `flags`, at each command that reads it — or that live one.
 */
export interface OwnerModelTarget {
  /**
   * - `flags`: `--connection` and `--model` both named it; no stored
   *   configuration was read, and none changes it.
   * - `connection`: `--connection` named the connection; the stored connection
   *   (or the workspace default on it) gave the model.
   * - `role`: role `main`'s binding named it — the owner's own
   *   workspace's, else the default workspace's.
   * - `default`: the workspace default — the owner's own, else the default
   *   workspace's — named it.
   * - `placeholder`: nothing configured it; `serve` composed against its
   *   `default`/`default` placeholders.
   */
  readonly source: "flags" | "connection" | "role" | "default" | "placeholder";
  readonly connectionId: string;
  readonly model: string;
  /** The fallback the owner composed after its target; absent or empty, none. */
  readonly fallback?: readonly ModelTarget[];
  /** The workspace the owner resolved its target in. */
  readonly workspaceId: string;
  /**
   * What `--connection`/`--model` pinned at startup, which a restart resolves
   * again whatever is stored — so a `models` write can say whether a restart
   * would run another target. Absent, a `connection` source pinned its
   * connection alone.
   */
  readonly flags?: { readonly connectionId?: string; readonly model?: string };
}

/**
 * The tasks whose approval rounds an IPC run's `"approve"`/`"deny"` loop answers
 * here, so a client attaching to one leaves its rounds to the owner. Counted,
 * as `InFlightFires` is: two retries of one run answer the same task, and the
 * first to finish must not clear the other's claim.
 */
export interface AnsweringRuns {
  has(taskId: string): boolean;
  /** Record that a loop answers this task's rounds; the returned release is idempotent. */
  enter(taskId: string): () => void;
}

export function createAnsweringRuns(): AnsweringRuns {
  const counts = new Map<string, number>();
  return {
    has: (taskId) => counts.has(taskId),
    enter(taskId) {
      counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (counts.get(taskId) ?? 1) - 1;
        if (remaining <= 0) counts.delete(taskId);
        else counts.set(taskId, remaining);
      };
    },
  };
}

/** A transport subscription on the requesting connection, reserved first and fed from a task's stream once attached. */
export interface ReservedSubscription {
  readonly subscriptionId: string;
  attach(
    taskId: string,
    from?: IpcCursor | "beginning",
  ): { readonly replayed: number; readonly resync: boolean; readonly truncated: boolean };
  release(): void;
}

export interface RunDependencies {
  /** The decorated port, so the run publishes to the task's stream. */
  readonly workflow: WorkflowPort | undefined;
  readonly repositories: Pick<PersistencePort["repositories"], "tasks" | "approvals" | "cancellations" | "executions">;
  /** Where a message's uploaded files are looked up; without it, a run naming one is refused. */
  readonly artifacts?: Pick<PersistencePort["repositories"]["artifacts"], "getArtifact" | "claimAttachmentForRun">;
  readonly access: { authorize(context: InvocationContext, permissions: readonly string[]): { readonly details?: unknown } | undefined };
  readonly target: OwnerModelTarget;
  /** What a run's `model` is checked against and saved through as the chat's own; absent, a `model` is refused. */
  readonly taskRouting?: Pick<TaskRoutingPort, "accepts" | "choose">;
  /** Which chats are local: a side chat of one stays on a local model. Absent: none is. */
  readonly localChats?: Pick<LocalChatModels, "isLocal" | "locality" | "localTargetOf" | "ideaModel">;
  /** This owner's session: a lease it holds is a turn running here. */
  readonly ownerSession: string;
  /** Reserve a subscription on the requesting connection; throws when it holds no more. */
  readonly reserveSubscription: () => ReservedSubscription;
  readonly log: (level: "info" | "warn", message: string, fields: Record<string, unknown>) => void;
  /** The answering loop's round limit; `RUN_POLICY_ROUNDS` unless a test lowers it. */
  readonly policyRounds?: number;
  /** Where a `"approve"`/`"deny"` run records that its rounds are the owner's to answer. */
  readonly answering?: AnsweringRuns;
  /**
   * What an `"approve"` run releases its review rounds through (`approveReviewRound`):
   * the artifact records, and the copy of an approved download into its chat's folder.
   * Absent, such a run leaves a review for a person.
   */
  readonly reviews?: {
    readonly artifacts: Pick<PersistencePort["repositories"]["artifacts"], "getArtifact" | "setReviewState">;
    readonly materializeArtifact?: (artifactId: string) => Promise<unknown>;
  };
  /**
   * The task streams: where an `"approve"`/`"deny"` run's answering loop says it
   * stopped answering a round (`leaveRound`), so a client that left the run's
   * rounds to the owner ends on it rather than waiting. Absent, the loop stops silently.
   */
  readonly stream?: Pick<RunEventBus, "publish" | "lastAttempt" | "subscribe">;
  /** The local connections a run opens its conversation on; absent, a run opens none. */
  readonly conversations?: RunConversations;
  /**
   * The front end the request came through: `web` for `tavi ui`'s bridge,
   * `ipc` (the default) for any other attached client. The owner never
   * reads origin from the `run` payload, so a page cannot record its run as
   * anything but `web`; which front end sent it comes from the client's hello,
   * attribution rather than authority (see `operatorActor`).
   */
  readonly origin?: "ipc" | "web";
  /** The person's Home in a workspace, if they have one; absent, a run cannot go to Home. */
  readonly homeOf?: (workspaceId: string, principalId: string) => Promise<string | undefined>;
  /** Whether the workspace's effective `chat.home` is on; absent, read as on. A run into Home is refused while it is off. */
  readonly homeOn?: (workspaceId: string) => Promise<boolean>;
  /**
   * A side chat's seed from its parent: background from the
   * parent's latest epoch summary and newest saved turns. Absent, or failing,
   * a side chat begins without one.
   */
  readonly sideChatSeed?: (parent: TaskRecord, notice?: NoticeSeedSource) => Promise<ChatSeed | undefined>;
  /**
   * The notice a side chat replies to, resolved owner-side: posted
   * into `parent`, with the run it is about and that run's output. Undefined
   * for a notice that is not that chat's.
   */
  readonly noticeSource?: (noticeId: string, parent: TaskRecord) => Promise<NoticeSeedSource | undefined>;
  /**
   * A turn about a heartbeat item: what the owner seeds it with from
   * the item, for an item of this person (with a proposal, for *Do it*);
   * undefined otherwise. Absent, `fromHeartbeatItemId` is refused. `prompt`
   * is the host's fixed request, the person's message; `item` — its proposal
   * for *Do it*, the item quoted for *Chat about this* — goes in as an
   * `inbound` block, never the person's words.
   * `label`: what the turn starts with (`heartbeatItemLabel`, the item and the
   * hosts of its pages); absent, a bare `heartbeat` label naming the item.
   */
  readonly heartbeatSeed?: (
    workspaceId: string,
    principalId: string,
    itemId: string,
    action: "do" | "chat",
  ) => Promise<{ readonly prompt: string; readonly item: string; readonly heading: string; readonly label?: ContentLabel } | undefined>;
  /**
   * Told once a message sent from an idea's *Try it* created its chat,
   * with what was sent. Best effort: the run goes on.
   */
  /**
   * An idea's prepared first step, fresh: what it found, put to the
   * first turn of the chat *Try it* starts as an untrusted block. Absent or
   * undefined, there is none.
   */
  readonly ideaPrepared?: (
    workspaceId: string,
    principalId: string,
    ideaId: string,
  ) => Promise<{ readonly title: string; readonly text: string } | undefined>;
  readonly ideaSeeded?: (seed: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly ideaId: string;
    readonly taskId: string;
    readonly sent: string;
  }) => Promise<void>;
  /** Told once a message created the person's Home: its "Earlier chats" notice. Best effort. */
  readonly onHomeCreated?: (home: { readonly taskId: string; readonly workspaceId: string; readonly principalId: string }) => Promise<void>;
  /**
   * The chats' working folders: a new
   * chat's `folder`, `folderAttachments` or `clientCwd` is checked before
   * anything is admitted and applied by the admission that creates the chat,
   * before its first turn resolves its folder. Absent, a `folder` naming a host folder is refused
   * and `clientCwd` is left unused.
   */
  readonly folders?: Pick<ChatFolders, "checkPrimary" | "begin"> &
    Partial<Pick<ChatFolders, "attachableRoots" | "checkAttachment" | "set">>;
  /** The path a picker token issued on this connection stands for (`browse`); undefined for any other. */
  readonly redeemPick?: (token: string) => string | undefined;
}

/** A replied-to notice's run, as a side chat's seed quotes it. */
export interface NoticeSeedSource {
  readonly title: string;
  readonly sourceTaskId: string;
  readonly output: string;
}

/** How a run gets its conversation on its workspace's local connection. */
interface RunConversations {
  /** The workspace's local connection, when it is open. */
  connectionFor(workspaceId: string): string | undefined;
  /**
   * The principal whose run holds the conversation — recorded, or being
   * admitted now — if any. Operation keys are unique per principal, but a
   * conversation per workspace: another principal's key must not become this
   * run's conversation.
   */
  holderOf(connectionId: string, conversationId: string): Promise<string | undefined>;
  /** Hold the conversation for `principalId` while its run is admitted; the release. */
  hold(connectionId: string, conversationId: string, principalId: string): () => void;
  /** Record the run's conversation, and its sender, before the run is answered. */
  open(input: {
    readonly connectionId: string;
    readonly conversationId: string;
    readonly taskId: string;
    readonly principalId: string;
    readonly workspaceId: string;
  }): Promise<void>;
}

/** A side chat's seed, or none: a seed that cannot be built costs the side chat its background, never the run. */
async function sideChatSeedOf(deps: RunDependencies, parent: TaskRecord, notice?: NoticeSeedSource): Promise<ChatSeed | undefined> {
  if (deps.sideChatSeed === undefined) return undefined;
  try {
    return await deps.sideChatSeed(parent, notice);
  } catch (error) {
    deps.log("warn", "a side chat's seed could not be built; it begins without one", {
      parentChatId: parent.taskId,
      reason: errorMessage(error),
    });
    return undefined;
  }
}

/**
 * Why a new chat does not work in the terminal's directory, in one sentence: an
 * owner with no `--fs-root` lets no chat work in a host folder at all, so the
 * directory is not named, only how to allow it.
 */
export function folderNoteOf(clientCwd: string, reason: string, noRoots: boolean): string {
  if (noRoots) return "This chat works in its own folder. Start tavi serve with --fs-root <path> to let chats work in your folders.";
  const why = reason.charAt(0).toLowerCase() + reason.slice(1);
  return `This chat works in its own folder, not ${clientCwd}: ${why}`.slice(0, 1_000);
}

/**
 * Attach the folders a new chat's first message carried, one by one; a
 * folder that cannot be attached now (it overlaps another) is left out and
 * named, with why, in the answer — the chat is admitted already.
 */
async function attachPicked(
  deps: RunDependencies,
  scope: { readonly workspaceId: string; readonly principalId: string },
  taskId: string,
  attaching: readonly { readonly path: string; readonly mode: ChatFolderMode; readonly picked: boolean }[],
): Promise<string | undefined> {
  const failed: string[] = [];
  for (const { path, mode, picked } of attaching) {
    try {
      await deps.folders?.set?.(
        scope,
        taskId,
        { kind: "attach", path, mode },
        { frontEnd: deps.origin ?? "ipc", ...(picked ? { picked } : {}) },
      );
    } catch (error) {
      const reason = errorMessage(error);
      failed.push(`${path} (${reason})`);
      deps.log("warn", "a folder picked for a new chat could not be attached", { taskId, reason });
    }
  }
  return failed.length === 0 ? undefined : failed.join("; ");
}

/**
 * How many rounds the daemon answers for one `run` under `"approve"`/`"deny"`,
 * as the scheduler bounds its policy loop: a model that keeps asking would
 * otherwise hold a turn open forever. The round past it is left pending for an
 * operator. Defence in depth: the workflow's step guard (8 model steps a turn —
 * an approval's resume counts in the turn it resumes — and no
 * composition raises it today) ends such a task first.
 */
const RUN_POLICY_ROUNDS = 50;

export async function startRun(deps: RunDependencies, request: RunPayload): Promise<IpcAnswer<RunResult>> {
  // Q1 is answered "no": provider reasoning is never streamed.
  if (request.includeReasoning === true) {
    return refuse("INVALID_INPUT", "includeReasoning is not supported: provider reasoning is never streamed to clients");
  }
  // With nothing configured the owner composed
  // against placeholders, and the run would fail inside the model call — unless
  // it names a model of its own, checked below.
  const unconfigured = request.model === undefined ? unconfiguredRefusal(deps.target, "a run") : undefined;
  if (unconfigured !== undefined) return unconfigured;
  // `expectTarget` asserts the owner's default as it resolves now; `model` chooses the chat's own.
  const mismatch = targetRefusal(deps.target, request.expectTarget);
  if (mismatch !== undefined) return mismatch;
  const workflow = deps.workflow;
  if (workflow === undefined) return refuse("UNAVAILABLE", "this owner has no model connection");
  // Into Home: the person's Home, or a new one this message
  // begins. A Home's conversation id is never an operation key (`home:` is a
  // reserved prefix), so no run can take it.
  const toHome = request.target === "home";
  const homeOf = deps.homeOf;
  if (toHome && homeOf === undefined) return refuse("UNAVAILABLE", "this owner cannot find a Home");
  if (toHome && request.chatInstructions !== undefined) {
    return refuse("INVALID_INPUT", "a message to Home cannot draft chat instructions; edit Home's instructions instead");
  }
  // One message would change every later Home turn's model, its messaging turns included: Home's is picked on its own.
  if (toHome && request.model !== undefined) {
    return refuse(
      "INVALID_INPUT",
      "a message to Home cannot choose its model; pick Home's model with /model in `tavi chat` or the composer's picker",
    );
  }
  // Authorized before Home is looked up, so a refused caller learns nothing of it.
  const authorizing: InvocationContext = {
    workspaceId: request.workspaceId,
    principalId: request.principal,
    caller: "ipc",
    runId: "pending-admission",
  };
  const denied = deps.access.authorize(authorizing, ["runs.create", "models.invoke"]);
  if (denied !== undefined) return refuse("NOT_AUTHORIZED", `Not authorized: ${JSON.stringify(denied.details ?? {})}`);
  // The chat's own model, checked before anything is admitted.
  const chosenModel = request.model;
  const routingScope = { workspaceId: request.workspaceId, principalId: request.principal };
  if (
    chosenModel !== undefined &&
    (deps.taskRouting?.accepts === undefined ||
      deps.taskRouting.choose === undefined ||
      !(await deps.taskRouting.accepts(routingScope, chosenModel)))
  ) {
    return refuse(
      "NOT_CONFIGURED",
      `no configured connection offers ${chosenModel.connectionId}/${chosenModel.model}: add or test it in ${englishOf(navPath("nav.route.settings", "nav.settings.models"))} (\`tavi models\`), then choose it again`,
    );
  }
  // With `chat.home` off there is no Home to message: a stored
  // one is an ordinary chat, and none is begun.
  if (toHome && deps.homeOn !== undefined && !(await deps.homeOn(request.workspaceId))) {
    return refuse("INVALID_INPUT", "Home is off: `tavi config set chat.home on`");
  }
  // A chat's memory is set when it is created: Home's is turned off in Home, and a run has none.
  if (request.memory !== undefined && request.target !== undefined) {
    return refuse(
      "INVALID_INPUT",
      request.target === "home"
        ? "a message to Home cannot set its memory; turn it off with /memory off in Home"
        : "a standalone run has no memory mode",
    );
  }
  if (request.fromHeartbeatItemId !== undefined && (request.parentChatId !== undefined || request.target === "run")) {
    return refuse("INVALID_INPUT", "Do it runs in Home or a new chat, never a side chat or a standalone run");
  }
  // Uploaded files: quoted after the prompt under their own heading, as a channel attachment is.
  let attachments: InboundBlock | undefined;
  try {
    if (request.attachments !== undefined && deps.artifacts === undefined)
      throw new TaviError("UNSUPPORTED", "this owner cannot take attachments");
    attachments =
      deps.artifacts === undefined
        ? undefined
        : attachmentBlock(await namedAttachments(deps.artifacts, request.workspaceId, request.attachments), request.principal);
  } catch (error) {
    const failure = TaviError.from(error);
    return refuse(failure.code, failure.message);
  }
  // A side chat: opened from a chat of the same person in the
  // same workspace — any other is not found, so a caller learns nothing of it —
  // and never from a worker, which is no chat.
  let parent: TaskRecord | undefined;
  if (request.parentChatId !== undefined) {
    if (request.target !== undefined) return refuse("INVALID_INPUT", "parentChatId starts a side chat, which takes no target");
    parent = await deps.repositories.tasks.get(request.parentChatId);
    if (parent === undefined || parent.workspaceId !== request.workspaceId || parent.principalId !== request.principal) {
      return refuse("NOT_FOUND", `chat ${request.parentChatId} was not found in workspace ${request.workspaceId}`);
    }
    if (parent.chatKind === "worker")
      return refuse("INVALID_INPUT", `task ${request.parentChatId} is a worker, not a chat: a side chat opens from a chat`);
    // A messaging chat (a conversation Home, a topic's side chat) is read by
    // its group: a side chat of it would carry the canvas's words back there
    // in its settle notice. A topic's side chat is opened from the topic.
    if (parent.origin === "messaging") {
      return refuse(
        "INVALID_INPUT",
        `chat ${request.parentChatId} is a messaging conversation: a side chat opens from Home or a chat of your own, and a topic in the group opens one there`,
      );
    }
  }
  // A side chat of a local chat quotes it, so it runs on a local model too: the parent's own, unless one is chosen.
  let sideModel: ModelTarget | undefined;
  if (parent !== undefined && deps.localChats !== undefined && (await deps.localChats.isLocal(request.workspaceId, parent.taskId))) {
    if (chosenModel !== undefined) {
      if ((await deps.localChats.locality(chosenModel.connectionId)) !== "local")
        return refuse(
          "NOT_CONFIGURED",
          `chat ${parent.taskId} runs on a local model, so a side chat of it stays local: choose a local model for it, or open a new chat instead`,
        );
    } else {
      sideModel = await deps.localChats.localTargetOf(request.workspaceId, parent.taskId);
      if (sideModel === undefined) return refuse("NOT_CONFIGURED", LOCAL_CHAIN_UNAVAILABLE);
    }
  }
  // An idea written from local chats and records starts its chat on a local model too.
  const ideaModel = request.fromIdeaId === undefined ? undefined : await deps.localChats?.ideaModel(request.workspaceId);
  if (ideaModel !== undefined && chosenModel !== undefined && (await deps.localChats?.locality(chosenModel.connectionId)) !== "local") {
    return refuse(
      "NOT_CONFIGURED",
      "this idea was written from your local chats and memory, so its chat stays on a local model: choose a local model for it",
    );
  }
  const savedModel = chosenModel ?? sideModel ?? ideaModel;
  // A turn about a heartbeat item: seeded from the item in the owner's
  // ledger, never the prompt the client sent, and tainted — the gate asks.
  let heartbeatPrompt: string | undefined;
  let heartbeatItem: { readonly text: string; readonly heading: string } | undefined;
  let heartbeatLabel: ContentLabel | undefined;
  if (request.fromHeartbeatItemId !== undefined) {
    if (deps.heartbeatSeed === undefined) return refuse("UNAVAILABLE", "this owner cannot run a heartbeat item's proposal");
    const seed = await deps.heartbeatSeed(
      request.workspaceId,
      request.principal,
      request.fromHeartbeatItemId,
      request.heartbeatAction ?? "do",
    );
    if (seed === undefined) return refuse("NOT_FOUND", `heartbeat item ${request.fromHeartbeatItemId} has nothing to do here`);
    heartbeatPrompt = seed.prompt;
    heartbeatItem = { text: seed.item, heading: seed.heading };
    heartbeatLabel =
      seed.label !== undefined && isUntrusted(seed.label)
        ? seed.label
        : untrustedLabel("heartbeat", { ref: { ref: request.fromHeartbeatItemId.slice(0, 200), at: nowTimestamp() } });
  }
  // An idea's prepared step: what it found goes with the message that starts its chat, as data the turn reads.
  const prepared =
    request.fromIdeaId === undefined
      ? undefined
      : await deps.ideaPrepared?.(request.workspaceId, request.principal, request.fromIdeaId).catch(() => undefined);
  const preparedBlock: InboundBlock | undefined =
    prepared === undefined || request.fromIdeaId === undefined
      ? undefined
      : {
          heading: `What Tavi found ahead of time for the idea "${prepared.title}"`,
          text: prepared.text,
          label: untrustedLabel("agent", { ref: { ref: `idea:${request.fromIdeaId}`.slice(0, 200), at: nowTimestamp() } }),
        };
  const inbound: InboundBlock[] = [
    ...(heartbeatItem === undefined || heartbeatLabel === undefined ? [] : [{ ...heartbeatItem, label: heartbeatLabel }]),
    ...(preparedBlock === undefined ? [] : [preparedBlock]),
    ...(attachments === undefined ? [] : [attachments]),
  ];
  // A reply to a notice: a side chat of the chat it was posted into,
  // seeded with the output of the run it is about. A notice of another chat
  // is not found, as another person's chat is not.
  let notice: NoticeSeedSource | undefined;
  if (request.fromNoticeId !== undefined) {
    if (parent === undefined)
      return refuse("INVALID_INPUT", "fromNoticeId replies in a side chat of the notice's chat: it needs parentChatId");
    notice = await deps.noticeSource?.(request.fromNoticeId, parent);
    if (notice === undefined) return refuse("NOT_FOUND", `notice ${request.fromNoticeId} was not found in chat ${parent.taskId}`);
  }
  // The new chat's folder, checked before anything
  // is admitted: Home keeps its own, the web bridge never names a path
  // nor sends a directory of its own, and a folder that cannot be used is
  // refused. A client's directory that cannot be used is not: the chat works
  // in its own folder, and the answer says why.
  const chosenFolder = request.folder;
  if (toHome && chosenFolder !== undefined) {
    return refuse(
      "INVALID_INPUT",
      "a message to Home cannot choose its folder; change Home's folder with /folder in `tavi chat` or the canvas's folder chip",
    );
  }
  if (deps.origin === "web" && chosenFolder !== undefined && "path" in chosenFolder)
    return refuse("NOT_AUTHORIZED", "The canvas cannot name a host folder; pick one from the folder list instead");
  if (deps.origin === "web" && request.clientCwd !== undefined)
    return refuse("NOT_AUTHORIZED", "A working directory comes from a terminal only; the canvas picks a folder instead");
  let beginIn: string | undefined;
  let picked = false;
  let folderNote: string | undefined;
  if (chosenFolder !== undefined && !("managed" in chosenFolder)) {
    if (deps.folders === undefined) return refuse("UNAVAILABLE", "this owner cannot set a chat's folder");
    const named = "pick" in chosenFolder ? deps.redeemPick?.(chosenFolder.pick) : chosenFolder.path;
    if (named === undefined) return refuse("NOT_FOUND", "That folder is no longer offered here: browse the folders again");
    picked = "pick" in chosenFolder;
    try {
      beginIn = deps.folders.checkPrimary(named);
    } catch (error) {
      const failure = TaviError.from(error);
      return refuse(failure.code, failure.message);
    }
  } else if (chosenFolder === undefined && request.clientCwd !== undefined && !toHome && deps.folders !== undefined) {
    try {
      beginIn = deps.folders.checkPrimary(request.clientCwd);
    } catch (error) {
      folderNote = folderNoteOf(request.clientCwd, errorMessage(error), deps.folders.attachableRoots?.().length === 0);
    }
  }
  // The folders the new chat starts with attached, picked before its first message: checked as an attach is,
  // before anything is admitted. A page names each by a token `browse` issued on its connection, never a path.
  const attaching: { readonly path: string; readonly mode: ChatFolderMode; readonly picked: boolean }[] = [];
  for (const wanted of request.folderAttachments ?? []) {
    if (deps.origin === "web" && "path" in wanted.folder)
      return refuse("NOT_AUTHORIZED", "The canvas cannot name a host folder; pick one from the folder list instead");
    if (deps.folders?.checkAttachment === undefined || deps.folders.set === undefined)
      return refuse("UNAVAILABLE", "this owner cannot attach a folder to a chat");
    const named = "pick" in wanted.folder ? deps.redeemPick?.(wanted.folder.pick) : wanted.folder.path;
    if (named === undefined) return refuse("NOT_FOUND", "That folder is no longer offered here: browse the folders again");
    try {
      attaching.push({ path: deps.folders.checkAttachment(named, wanted.mode), mode: wanted.mode, picked: "pick" in wanted.folder });
    } catch (error) {
      const failure = TaviError.from(error);
      return refuse(failure.code, failure.message);
    }
  }
  /** What the answer says of the new chat's folder; set once the run created its chat. */
  let folderResult: RunFolderResult | undefined;
  const homeTaskId = toHome && homeOf !== undefined ? await homeOf(request.workspaceId, request.principal) : undefined;
  if (homeTaskId !== undefined) {
    const refusal = await homeRefusal(deps, homeTaskId, request.operationKey);
    if (refusal !== undefined) return refusal;
  }

  // The run's conversation: the operation key, client-minted and
  // known before the task is, on the workspace's local connection — where
  // `operator.ask_user` replies, and where `reply` answers it. A Home's is one
  // fixed id per person, whichever message began it.
  const conversationId = toHome ? homeConversationId(request.principal) : request.operationKey;
  const local = deps.conversations?.connectionFor(request.workspaceId);
  const context: InvocationContext = {
    workspaceId: request.workspaceId,
    principalId: request.principal,
    caller: "ipc",
    runId: homeTaskId ?? "pending-admission",
    // The front end this turn was typed in: a Home keeps the
    // origin its first client gave it, so a canvas turn of a Home `tavi chat`
    // began is held to `web` rules by this. Decided by the connection.
    frontEnd: deps.origin ?? "ipc",
    // Labelled with where it came from: the heartbeat item it is about, and its pages' hosts.
    ...(heartbeatLabel === undefined ? {} : { inheritedTaint: true as const, inheritedLabel: heartbeatLabel }),
    ...(local === undefined
      ? {}
      : {
          messagingReplyTo: {
            connectionId: local,
            externalConversationId: conversationId,
            externalSenderId: request.principal,
            audience: "one-to-one" as const,
          },
        }),
  };
  // The key names a conversation for the whole workspace: refused when another
  // principal's run holds it, rather than asking this run's questions there.
  let releaseConversation = (): void => undefined;
  if (local !== undefined && deps.conversations !== undefined) {
    const holder = await deps.conversations.holderOf(local, conversationId);
    if (holder !== undefined && holder !== request.principal) {
      return refuse(
        "CONFLICT",
        `operation key ${request.operationKey} names another principal's conversation in workspace ${request.workspaceId}; use a key of your own`,
      );
    }
    releaseConversation = deps.conversations.hold(local, conversationId, request.principal);
  }

  // Reserved before anything is admitted, so a connection that can hold no more
  // subscriptions is refused with nothing started.
  let subscription: ReservedSubscription;
  try {
    subscription = deps.reserveSubscription();
  } catch (error) {
    releaseConversation();
    const failure = TaviError.from(error);
    return refuse(failure.code, failure.message);
  }
  // Built once nothing can refuse the run any more: it reads the parent's checkpoint and transcript.
  const seed = parent === undefined ? undefined : await sideChatSeedOf(deps, parent, notice);
  // A side chat begins with what its parent's words carry: the parent's label (and a replied-to run's), as it is.
  const admittedContext: InvocationContext = seed?.label === undefined ? context : { ...context, inheritedLabel: seed.label };

  return new Promise<IpcAnswer<RunResult>>((resolve) => {
    let answered = false;
    const answer = (value: IpcAnswer<RunResult>): void => {
      if (answered) return;
      answered = true;
      resolve(value);
    };
    const fail = (refusal: IpcRefusal): void => {
      // A failed response discards the subscription's held events as well.
      subscription.release();
      answer(refusal);
    };
    let taskId: string | undefined;
    let replayed = 0;
    let truncated = false;
    /** Set when the answer waits for the claim (a retry of an admission left in doubt). */
    let deferred = false;
    /** Releases this run's claim on answering the task's rounds, once its loop ends. */
    let leaveAnswering: (() => void) | undefined;
    /** The run's conversation is recorded, so a `reply` into it finds its task. */
    let conversationOpen = false;
    let modelUnsaved = false;
    const ok = (id: string, created: boolean, replay: boolean): IpcAnswer<RunResult> => ({
      ok: true,
      result: {
        taskId: id,
        subscriptionId: subscription.subscriptionId,
        created,
        replay,
        replayed,
        ...(truncated ? { truncated } : {}),
        ...(conversationOpen ? { conversationId } : {}),
        ...(modelUnsaved ? { modelSaved: false as const } : {}),
        ...(folderResult === undefined ? {} : { folder: folderResult }),
      },
    });

    workflow
      .admit({
        context: admittedContext,
        operationKey: request.operationKey,
        // A message to an existing Home is its next turn; it keeps the policy and origin Home was made with.
        ...(homeTaskId !== undefined
          ? { kind: "reply" as const, taskId: homeTaskId }
          : {
              kind: "start" as const,
              // An attached client is a person watching this run, so it may ask them a
              // question.
              executionPolicy: ATTENDED_TASK_POLICY,
              // The task's durable origin: an attached client's run, `web`
              // when the owner received it through the canvas's bridge.
              origin: deps.origin ?? "ipc",
              ...(request.target === undefined ? {} : { chatKind: request.target }),
              // Its parent's background, as context ahead of the prompt, never as the person's message.
              ...(parent === undefined
                ? {}
                : { chatKind: "side" as const, parentChatId: parent.taskId, ...(seed === undefined ? {} : { seed }) }),
              // Memory off, or a private chat, from its first turn; a side chat also takes its parent's.
              ...(request.memory === undefined ? {} : { memoryMode: request.memory }),
            }),
        explicitModelSelection: request.expectTarget?.connectionId !== undefined || request.expectTarget?.model !== undefined,
        prompt: heartbeatPrompt ?? request.prompt,
        // The item itself is someone else's words: quoted data under its label, never the person's message.
        ...(inbound.length === 0 ? {} : { inbound }),
        // Drafted in the chat panel before the first message, saved under the front end that sent it.
        ...(request.chatInstructions === undefined
          ? {}
          : { chatInstructions: { text: request.chatInstructions, author: deps.origin === "web" ? "operator:ui" : "operator:cli" } }),
        // Guarded throughout: `onAdmitted` runs inside the admission after the
        // task row is written, and a throw here would fail a run that has not
        // started for a reason that is only this handler's.
        onAdmitted: async (admitted) => {
          try {
            taskId = admitted.taskId;
            // A chat an idea's *Try it* started is linked to it before its first turn runs, so a turn that ends at once still marks it done.
            if (admitted.created && request.fromIdeaId !== undefined && deps.ideaSeeded !== undefined) {
              try {
                await deps.ideaSeeded({
                  workspaceId: request.workspaceId,
                  principalId: request.principal,
                  ideaId: request.fromIdeaId,
                  taskId: admitted.taskId,
                  sent: request.prompt,
                });
              } catch (error) {
                deps.log("warn", "a chat an idea started could not be linked to it", {
                  taskId: admitted.taskId,
                  reason: errorMessage(error),
                });
              }
            }
            // The files go with the chat they began (or joined): its erasure takes them.
            for (const artifactId of request.attachments ?? [])
              await deps.artifacts?.claimAttachmentForRun?.({ artifactId, runId: admitted.taskId });
            // Saved before the turn's first model call reads the chat's route —
            // by a new admission only: a resent `run` must not undo a later choice.
            if (savedModel !== undefined && admitted.created) {
              try {
                await deps.taskRouting?.choose?.(routingScope, admitted.taskId, savedModel);
              } catch (error) {
                // Admitted already, so not refused: the answer says the choice was not kept.
                modelUnsaved = true;
                deps.log("warn", "a run's chosen model could not be saved; the chat keeps its earlier model, else the default", {
                  taskId: admitted.taskId,
                  reason: errorMessage(error),
                });
              }
            }
            // The new chat's folder, before its first turn resolves it — by
            // the admission that created it only, as its model is.
            if (admitted.created && (beginIn !== undefined || folderNote !== undefined || chosenFolder !== undefined)) {
              folderResult = { kind: "managed", ...(folderNote === undefined ? {} : { note: folderNote }) };
              if (beginIn !== undefined && deps.folders !== undefined) {
                try {
                  await deps.folders.begin(routingScope, admitted.taskId, beginIn, {
                    frontEnd: deps.origin ?? "ipc",
                    ...(picked ? { picked: true as const } : {}),
                  });
                  folderResult = { kind: "host", path: beginIn };
                } catch (error) {
                  // Admitted already, so not refused: the chat works in its own folder, and the answer says so.
                  const reason = errorMessage(error);
                  folderResult = {
                    kind: "managed",
                    note: `This chat works in its own folder: ${beginIn} could not be set (${reason})`.slice(0, 1_000),
                  };
                  deps.log("warn", "a new chat's folder could not be set; it works in its own folder", { taskId: admitted.taskId, reason });
                }
              }
            }
            // The folders picked before the first message, attached after its primary and before its first turn.
            // By the admission that created the chat only: a message to the Home that exists attaches nothing, and says so.
            if (attaching.length > 0 && admitted.created) {
              const unattached = homeTaskId === undefined ? await attachPicked(deps, routingScope, admitted.taskId, attaching) : undefined;
              const note =
                homeTaskId !== undefined
                  ? "Home had begun already, so the folders picked for this message were not attached: attach them from its folder chip."
                  : unattached === undefined
                    ? undefined
                    : `Not attached: ${unattached}`.slice(0, 1_000);
              if (note !== undefined) folderResult = { ...(folderResult ?? { kind: "managed" }), note };
            }
            // Before the answer, so a reply sent the moment the client has it
            // finds the conversation's task — and never starts another.
            if (local !== undefined && deps.conversations !== undefined) {
              try {
                await deps.conversations.open({
                  connectionId: local,
                  conversationId,
                  taskId: admitted.taskId,
                  principalId: request.principal,
                  workspaceId: request.workspaceId,
                });
                conversationOpen = true;
                // Recorded: the record holds it from here.
                releaseConversation();
              } catch (error) {
                // The run goes on; only its questions cannot be answered by `reply`.
                deps.log("warn", "a run's conversation could not be opened", {
                  taskId: admitted.taskId,
                  reason: errorMessage(error),
                });
              }
            }
            // Before the stream can show a round: a client attaching from now on
            // leaves this run's rounds to the loop below.
            if (request.approval !== "client") leaveAnswering ??= deps.answering?.enter(admitted.taskId);
            try {
              // Home's earlier turns are not this message's: its subscription starts live.
              ({ replayed, truncated } =
                homeTaskId !== undefined ? subscription.attach(admitted.taskId) : subscription.attach(admitted.taskId, "beginning"));
            } catch {
              fail(
                refuse(
                  "UNAVAILABLE",
                  `task ${admitted.taskId} was admitted but its subscription could not be opened; ` +
                    "subscribe to it by task id, or send `run` again with the same operationKey",
                ),
              );
              return;
            }
            if (admitted.created) {
              // A new Home starts with its "Earlier chats" notice.
              if (toHome && homeTaskId === undefined && deps.onHomeCreated !== undefined) {
                try {
                  await deps.onHomeCreated({ taskId: admitted.taskId, workspaceId: request.workspaceId, principalId: request.principal });
                } catch (error) {
                  deps.log("warn", "a new Home's earlier-chats notice could not be posted", {
                    taskId: admitted.taskId,
                    reason: errorMessage(error),
                  });
                }
              }
              answer(ok(admitted.taskId, true, false));
              return;
            }
            const recorded = await deps.repositories.tasks.getAdmission(admitted.taskId, request.operationKey);
            // A retry under a committed key: answered from the record.
            if (recorded !== undefined && recorded.result !== null) {
              answer(ok(admitted.taskId, false, true));
              return;
            }
            // The same run, still running here.
            if (await runningHere(deps, admitted.taskId, request.operationKey)) {
              answer(ok(admitted.taskId, false, false));
              return;
            }
            deferred = true;
          } catch (error) {
            deps.log("warn", "a run's admission could not be answered as it was admitted", {
              reason: errorMessage(error),
            });
            deferred = true;
          }
        },
        onClaimed: (claimed) => {
          if (deferred) answer(ok(claimed.taskId, false, false));
        },
      })
      .then(async (admission) => {
        // Settled without an answer — a path that never fired the hooks above.
        if (!answered) answer(ok(admission.taskId, admission.created, admission.replay));
        if (request.approval === "client") return;
        await answerRounds(workflow, deps, {
          context: { ...context, runId: admission.taskId },
          taskId: admission.taskId,
          approved: request.approval === "approve",
          // Decided for every round unseen: the call runs, but no person
          // allowed where it goes (a browser site off the allowlist stays refused).
          decidedBy: automaticDecider(request.principal),
          rounds: deps.policyRounds ?? RUN_POLICY_ROUNDS,
        });
      })
      .catch((error: unknown) => {
        // Before the answer, the caller is told — a busy slot with the
        // `tavi recover` that frees it. After it, the stream already ends with
        // the decorator's `task.failed` for a claimed admission, so this is only
        // recorded: an unhandled rejection would take the owner down.
        if (!answered) {
          // Two first messages raced to create Home: the unique index refused this one.
          if (toHome && homeTaskId === undefined && isSecondHome(error)) {
            fail(refuse("CONFLICT", "another message created Home at the same moment; send this one again and it goes into that Home"));
            return;
          }
          fail(refusalOf(error, taskId ?? "<task>", "the run"));
          return;
        }
        deps.log("warn", "an IPC run ended in an error after it was admitted", {
          ...(taskId === undefined ? {} : { taskId }),
          reason: errorMessage(error),
        });
      })
      .finally(() => {
        leaveAnswering?.();
        releaseConversation();
      });
  });
}

/** The store's typed refusal of a second Home for a person: its code and the index it names. */
export function isSecondHome(error: unknown): boolean {
  const failure = TaviError.from(error);
  return failure.code === "CONFLICT" && failure.details?.["index"] === HOME_CHAT_INDEX;
}

/**
 * Why a message cannot go to this Home now, if it cannot: this key's message
 * was already sent — running or done, its turn is in Home's stream and saved
 * history, and a live subscription could not replay that one turn apart from
 * Home's others — or Home waits on a round to decide.
 */
async function homeRefusal(
  deps: Pick<RunDependencies, "repositories">,
  homeTaskId: string,
  operationKey: string,
): Promise<IpcRefusal | undefined> {
  if ((await deps.repositories.tasks.getAdmission(homeTaskId, operationKey)) !== undefined) {
    return refuse(
      "CONFLICT",
      `operation key ${operationKey} was already sent to Home; nothing was sent again — follow it with \`tavi run --attach ${homeTaskId}\``,
    );
  }
  return pendingRoundRefusal(deps.repositories.tasks, homeTaskId, `Home (task ${homeTaskId})`);
}

/**
 * The daemon's answering loop for `"approve"`/`"deny"`: every round
 * the task is waiting on is decided with that verdict, under the round's own key
 * with the round as the in-queue precondition — the fifth approval path, and the
 * same one as every other.
 *
 * Each round is read from the task's durable state, not from the outcome the
 * previous admission returned: a retried `run` replays its start's recorded
 * outcome, which names a round decided long ago, and walking those rounds again
 * would replay every one of them. Under `"approve"` a review round is answered
 * too — its pending artifacts approved (`approveReviewRound`) and the suspension
 * acknowledged — as the foreground `--approval approve` answers it; under
 * `"deny"` a review, and under either a question, waits for a person.
 */
async function answerRounds(
  workflow: WorkflowPort,
  deps: Pick<RunDependencies, "repositories" | "log" | "reviews" | "stream" | "answering">,
  input: {
    readonly context: InvocationContext;
    readonly taskId: string;
    readonly approved: boolean;
    readonly decidedBy: string;
    readonly rounds: number;
  },
): Promise<void> {
  /**
   * The round the loop answers next; `moved-on` when the task is running again
   * under a resume another front end admitted, so its next round is no longer
   * this loop's to answer; undefined when nothing is left for the loop.
   */
  const pendingRound = async (): Promise<PendingRound | "moved-on" | undefined> => {
    const task = await deps.repositories.tasks.get(input.taskId);
    if (task === undefined) return undefined;
    const decidability = await decidableRound(deps.repositories, task);
    if (!decidability.decidable) {
      if (decidability.reason === "settled-uncommitted") {
        deps.log("warn", "a run's round was decided by a resume that never committed; the answering loop stops", {
          taskId: input.taskId,
        });
      }
      if (decidability.reason === "not-waiting" && (task.status === "admitted" || task.status === "running")) return "moved-on";
      return undefined;
    }
    const round = decidability.round;
    if (round.kind === "approval") return round;
    return input.approved && deps.reviews !== undefined ? round : undefined;
  };
  const stopped = (reason: string, message: string): PolicyStopped => ({ reason, message });
  const decidedElsewhere = stopped(
    "decided-elsewhere",
    "the run went on under an admission another front end made, so its later rounds are a person's",
  );

  // This loop answers the task's rounds now: an earlier loop's watch is not to leave them for a person.
  endWatch(deps.stream, input.taskId);
  for (let round = 0; round < input.rounds; round += 1) {
    const pending = await pendingRound();
    if (pending === undefined) return;
    if (pending === "moved-on") {
      watchNextRound(deps, input.taskId, decidedElsewhere);
      return;
    }
    if (pending.kind === "review") {
      const reviews = deps.reviews;
      if (reviews === undefined) return;
      const decided = await approveReviewRound(
        { ...reviews, now: nowTimestamp },
        { workspaceId: input.context.workspaceId, taskId: input.taskId },
        pending.artifactIds,
        input.decidedBy,
      );
      // An artifact that is gone, or not this run's, stays undecided: acknowledging would only suspend again.
      if (!decided) {
        await leaveRound(
          deps,
          input.taskId,
          stopped("not-own-artifact", "an artifact of the review is gone, or was not made by this run, so a person decides it"),
        );
        return;
      }
    }
    try {
      await workflow.admit({
        context: input.context,
        taskId: input.taskId,
        operationKey: roundResumeKey(input.taskId, pending),
        kind: "approval",
        resume:
          pending.kind === "review"
            ? { reviewAck: true, expectedSteps: pending.steps }
            : {
                decisions: pending.requests.map((request) => automaticDecision(request, input.approved, input.decidedBy)),
                expectedSteps: pending.steps,
              },
      });
    } catch (error) {
      const failure = TaviError.from(error);
      if (failure.code === "CONFLICT") {
        // The precondition, or the round key's content: another front end
        // decided this round first. Not a failure of the run.
        deps.log("info", "a run's round was decided by another front end; the answering loop stops", {
          taskId: input.taskId,
          steps: pending.steps,
        });
        // Its resume may still be running: the round it suspends on next is the one left for a person.
        watchNextRound(deps, input.taskId, decidedElsewhere, pending.admissionId);
        return;
      }
      if (failure.code === "UNAVAILABLE") {
        deps.log(
          "warn",
          "the owner stopped admitting while a run's rounds were being answered; the round is left pending — " +
            "send `run` again with the same operationKey to resume answering",
          { taskId: input.taskId, steps: pending.steps },
        );
        await leaveRound(deps, input.taskId, stopped("unavailable", "the owner stopped admitting work while answering the run's rounds"));
        return;
      }
      throw error;
    }
  }
  const last = await pendingRound();
  if (last === "moved-on") {
    watchNextRound(deps, input.taskId, decidedElsewhere);
    return;
  }
  if (last !== undefined) {
    deps.log("warn", `a run reached its ${input.rounds}-round answering limit; the pending round is left for an operator`, {
      taskId: input.taskId,
    });
    await leaveRound(
      deps,
      input.taskId,
      stopped("round-limit", `the run reached its limit of ${input.rounds} rounds answered by its --approval policy`),
    );
  }
}

/**
 * Publish the round a task is waiting on again, tagged `policyStopped`: the
 * answering loop stopped answering it, so it is a person's now, and a client
 * that left the run's rounds to the owner ends on it. The events are the
 * decorator's own for the waiting outcome (`emitOutcomeEvents`), so every
 * reducer folds them into the round it already shows; a call's input is
 * masked, as the safe reading of `tools.redactResults`. Best effort: nothing
 * is published for a task not waiting on a round, or without a stream.
 */
async function leaveRound(
  deps: Pick<RunDependencies, "repositories" | "log" | "stream">,
  taskId: string,
  stopped: PolicyStopped,
): Promise<boolean> {
  const stream = deps.stream;
  if (stream === undefined) return false;
  try {
    const admission = await deps.repositories.tasks.latestSettledAdmission(taskId);
    const outcome = admission?.result;
    if (admission === undefined || outcome === null || outcome === undefined || pendingRoundFromAdmission(admission) === undefined) {
      return false;
    }
    const attemptId = stream.lastAttempt(taskId) ?? attemptIdFor(admission.admissionId);
    emitOutcomeEvents(
      outcome,
      taskId,
      (event) => {
        if (event.kind === "approval.required" || event.kind === "task.review_required") {
          stream.publish(taskId, { ...event, policyStopped: stopped });
        }
      },
      attemptId,
      true,
    );
    return true;
  } catch (error) {
    deps.log("warn", "a run's round left for a person could not be announced on its stream", { taskId, reason: errorMessage(error) });
    return false;
  }
}

/** The task watches `watchNextRound` holds, per stream. */
const watches = new WeakMap<object, Map<string, () => void>>();

/** End the task's `watchNextRound` watch on `stream`, if one is held. */
function endWatch(stream: object | undefined, taskId: string): void {
  if (stream !== undefined) watches.get(stream)?.get(taskId)?.();
}

/**
 * After another front end decided a run's round, its resume runs on: the round
 * it suspends on next (if any) is left for a person (`leaveRound`) once it is
 * published. A task already waiting on a round other than `decidedAdmission`'s
 * is announced at once; one that completes, fails or waits on something else
 * ends the watch.
 */
function watchNextRound(
  deps: Pick<RunDependencies, "repositories" | "log" | "stream" | "answering">,
  taskId: string,
  stopped: PolicyStopped,
  decidedAdmission?: string,
): void {
  const stream = deps.stream;
  if (stream === undefined) return;
  // One watch per task: a cancelled task, or a round whose resume never commits, publishes nothing that ends it.
  endWatch(stream, taskId);
  let watching = watches.get(stream);
  if (watching === undefined) watches.set(stream, (watching = new Map()));
  let done = false;
  let unsubscribe: () => void = () => {};
  const finish = (announce: boolean): void => {
    if (done) return;
    done = true;
    unsubscribe();
    if (watching.get(taskId) === cancel) watching.delete(taskId);
    // After the publish that delivered it: a round's other calls are still being published.
    // A `run` sent again since answers the task's rounds itself.
    if (announce) setImmediate(() => void (deps.answering?.has(taskId) === true ? undefined : leaveRound(deps, taskId, stopped)));
  };
  const cancel = (): void => finish(false);
  watching.set(taskId, cancel);
  const { subscription } = stream.subscribe({
    taskId,
    deliver: (event) => {
      if (event.kind === "task.completed" || event.kind === "task.failed" || event.kind === "task.stopped" || event.kind === "task.waiting")
        finish(false);
      else if ((event.kind === "approval.required" || event.kind === "task.review_required") && event.policyStopped === undefined) {
        finish(true);
      }
    },
  });
  unsubscribe = () => subscription.unsubscribe();
  if (done) unsubscribe();
  // Already suspended again before the watch began.
  void (async () => {
    const task = await deps.repositories.tasks.get(taskId);
    if (task === undefined || TERMINAL_TASK_STATUSES.has(task.status)) {
      finish(false);
      return;
    }
    if (task.status !== "waiting") return;
    const admission = await deps.repositories.tasks.latestSettledAdmission(taskId);
    const round = pendingRoundFromAdmission(admission);
    if (round === undefined) finish(false);
    else if (round.admissionId !== decidedAdmission) finish(true);
  })().catch((error: unknown) => {
    deps.log("warn", "a run's next round could not be watched for", { taskId, reason: errorMessage(error) });
    finish(false);
  });
}
