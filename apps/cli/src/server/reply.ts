import { randomUUID } from "node:crypto";

import {
  isPlumbingOrigin,
  HOME_CONVERSATION_PREFIX,
  TaviError,
  replyIntentOf,
  type InboundEvent,
  type PersistencePort,
  type ReplyPayload,
  type ReplyResult,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { attachmentText, namedAttachments, type NamedAttachment } from "../features/run/attachment-intake.js";
import type { LocalMessaging } from "../runtime/types.js";
import { pendingRoundRefusal, refuse, type IpcAnswer } from "../shared/ipc-decisions.js";

/**
 * IPC `reply`: a message into one of the
 * local connection's conversations — the conversation an IPC run opened,
 * named by its operation key.
 *
 * It is handed to the connection exactly as a chat connector hands the
 * service an update, so it answers a question the conversation's task
 * is waiting on through its one settle point, or starts a follow-up turn.
 * The answer is given once the message is durably recorded (`onRecorded`);
 * the turn it admits goes on after it, on the task's stream.
 *
 * The sender is the conversation's task's own principal, never one the
 * request names: a follow-up admission is refused unless its principal is the
 * task's, and the local connection binds its sender to that principal.
 */

export interface ReplyDependencies {
  readonly repositories: Pick<
    PersistencePort["repositories"],
    | "tasks"
    | "messagingConversations"
    | "messagingIdentityBindings"
    | "messagingInbox"
    | "transcripts"
    | "cancellations"
    | "agentDelegations"
    | "artifacts"
  >;
  readonly localMessaging: LocalMessaging;
  readonly now: () => string;
  readonly log: (level: "warn", message: string, fields: Record<string, unknown>) => void;
  /** A steer's id; the owner's id source. */
  readonly newId?: () => string;
  /** The workspace's person, whose Home `home:<principal>` names; absent, any principal's. */
  readonly principalOf?: (workspaceId: string) => string | undefined;
  /**
   * The front end the reply was typed in: `web` through
   * `tavi ui`'s bridge, `ipc` otherwise — decided by the connection, never the
   * payload. The turn is held to rules for it as well as its task's origin.
   */
  readonly frontEnd?: "web" | "ipc";
}

/** Whether a turn of `taskId` runs now: an admission claimed, its result not yet written. */
async function turnRunning(tasks: Pick<PersistencePort["repositories"]["tasks"], "hasRunningAdmission">, taskId: string): Promise<boolean> {
  return await tasks.hasRunningAdmission(taskId);
}

export async function replyToConversation(deps: ReplyDependencies, request: ReplyPayload): Promise<IpcAnswer<ReplyResult>> {
  const connectionId = deps.localMessaging.connectionFor(request.workspaceId);
  if (connectionId === undefined) return refuse("UNAVAILABLE", `workspace ${request.workspaceId} has no local connection open`);
  // A message with files is a turn of its own: merged into a running one, its files would go unquoted.
  if (request.attachments !== undefined && replyIntentOf(request) === "steer")
    return refuse("INVALID_INPUT", "a message with attachments is sent as its own turn, not merged into a running one");
  let named: readonly NamedAttachment[];
  try {
    named = await namedAttachments(deps.repositories.artifacts, request.workspaceId, request.attachments);
  } catch (error) {
    const failure = TaviError.from(error);
    return refuse(failure.code, failure.message);
  }
  // A task named directly answers in its conversation on this connection,
  // opened for it when it has none.
  let conversationId: string;
  if (request.conversationId !== undefined) {
    conversationId = request.conversationId;
    // One an earlier local `/new` ended (before it was text there) is opened again.
    await reopenEnded(deps, connectionId, conversationId, request.workspaceId);
  } else {
    const named = request.taskId === undefined ? undefined : await deps.repositories.tasks.get(request.taskId);
    if (named === undefined || named.workspaceId !== request.workspaceId)
      return refuse("NOT_FOUND", `no task ${request.taskId ?? ""} in workspace ${request.workspaceId}`);
    // Refused before a conversation is opened for it: a worker never gets one.
    const refusal = await workerRefusal(deps, named);
    if (refusal !== undefined) return refusal;
    try {
      conversationId = await localConversationOf(deps, connectionId, named);
    } catch (error) {
      const failure = TaviError.from(error);
      return refuse(failure.code, failure.message);
    }
  }
  const conversation = await deps.repositories.messagingConversations.get(connectionId, conversationId);
  const task = conversation === undefined ? undefined : await deps.repositories.tasks.get(conversation.taskId);
  // The workspace check is defence in depth: the conversation was looked up on
  // that workspace's own connection, where only its runs record one.
  if (conversation === undefined || task === undefined || task.workspaceId !== request.workspaceId) {
    return refuse(
      "NOT_FOUND",
      `no conversation ${conversationId} in workspace ${request.workspaceId}: a run's conversation is named by its operation key`,
    );
  }
  const refusal = await workerRefusal(deps, task);
  if (refusal !== undefined) return refusal;
  // A task suspended on a round is decided, not replied to.
  const waiting = await pendingRoundRefusal(deps.repositories.tasks, task.taskId, `task ${task.taskId}`);
  if (waiting !== undefined) return waiting;
  try {
    await bindSender(deps, connectionId, task.principalId, request.workspaceId);
  } catch (error) {
    const failure = TaviError.from(error);
    return refuse(failure.code, `the local connection's sender could not be bound: ${failure.message}`);
  }
  // Steering: a message into the running turn is recorded for its next
  // model call rather than delivered; one that finds no turn running is
  // delivered as any reply. A message already recorded as a steer — the same
  // id sent again, or as a plain reply once its turn ended — is answered by
  // where that steer stands, so it is merged or sent exactly once.
  const steered = await steer(deps, request, task.taskId, conversationId);
  if (steered !== undefined) return steered;
  const at = deps.now();
  // The files' lines follow the text, quoted as a channel attachment's are: their names are not the person's words.
  const said = attachmentText(named);
  const content = said === "" ? request.text : `${request.text}\n\n${said}`;
  const event: Omit<InboundEvent, "connectionId"> = {
    providerEventId: request.clientMessageId,
    kind: "message",
    externalSenderId: task.principalId,
    externalConversationId: conversationId,
    externalMessageId: request.clientMessageId,
    occurredAt: at,
    receivedAt: at,
    content,
    ...(said === ""
      ? {}
      : {
          quotedRanges: [{ start: content.length - said.length, end: content.length, kind: "attachment" as const }],
          attachments: named.map(({ artifactId, filename }) => ({ artifactId, ...(filename === undefined ? {} : { filename }) })),
        }),
    ...(deps.frontEnd === undefined ? {} : { frontEnd: deps.frontEnd }),
  };
  return new Promise<IpcAnswer<ReplyResult>>((resolve) => {
    let answered = false;
    const settle = (answer: IpcAnswer<ReplyResult>): void => {
      if (answered) return;
      answered = true;
      resolve(answer);
    };
    deps.localMessaging
      .deliver(request.workspaceId, event, {
        onRecorded: async (receipt) => {
          try {
            // A message id is unique per connection: one used before in another
            // conversation was not delivered to this one.
            const earlier = receipt.duplicate
              ? await deps.repositories.messagingInbox.get(connectionId, request.clientMessageId)
              : undefined;
            if (earlier !== undefined && earlier.payload.externalConversationId !== conversationId) {
              settle(
                refuse("CONFLICT", `message id ${request.clientMessageId} was already used in another conversation; nothing was delivered`),
              );
              return;
            }
            settle({ ok: true, result: { taskId: task.taskId, conversationId, duplicate: receipt.duplicate } });
          } catch (error) {
            const failure = TaviError.from(error);
            settle(refuse(failure.code, failure.message));
          }
        },
      })
      .catch((error: unknown) => {
        const failure = TaviError.from(error);
        if (!answered) {
          settle(refuse(failure.code, failure.message));
          return;
        }
        // Answered "recorded", which stays true: the turn it admitted failed,
        // and the message is held for an operator to replay.
        deps.log("warn", "a local reply's turn failed after it was recorded", {
          taskId: task.taskId,
          conversationId,
          reason: failure.message,
        });
      });
  });
}

/**
 * A steer, when the reply is or was one: answered `steered` while a
 * turn holds it or is to take it; undefined when the message is to be
 * delivered as any reply — no turn runs (a steer recorded is handed on,
 * `queued`, first), or it is a plain reply.
 */
async function steer(
  deps: ReplyDependencies,
  request: ReplyPayload,
  taskId: string,
  conversationId: string,
): Promise<IpcAnswer<ReplyResult> | undefined> {
  const transcripts = deps.repositories.transcripts;
  const merged = (duplicate: boolean): IpcAnswer<ReplyResult> => ({
    ok: true,
    result: { taskId, conversationId, duplicate, steered: true },
  });
  let recorded = await transcripts.steerOf(taskId, request.clientMessageId);
  if (recorded === undefined) {
    if (replyIntentOf(request) !== "steer" || !(await turnRunning(deps.repositories.tasks, taskId))) return undefined;
    recorded = await transcripts.recordSteer({
      steerId: deps.newId?.() ?? `steer_${randomUUID().replaceAll("-", "")}`,
      taskId,
      messageId: request.clientMessageId,
      conversationId,
      text: request.text,
      createdAt: deps.now(),
    });
    if (recorded.state === "pending" && (await turnRunning(deps.repositories.tasks, taskId))) return merged(false);
  }
  if (recorded.state === "consumed") return merged(true);
  const running = await turnRunning(deps.repositories.tasks, taskId);
  // Claimed by a call that never settled it, with no turn running now (an owner
  // that stopped in between): pending again, and handed on below.
  if (recorded.state === "claimed") {
    if (running) return merged(true);
    await transcripts.settleSteers(taskId, []);
    recorded = (await transcripts.steerOf(taskId, request.clientMessageId)) ?? recorded;
    if (recorded.state === "consumed") return merged(true);
  }
  // The turn it was for has ended (or never ran): handed on, once, as the
  // chat's next message — by this reply or the owner's own hand-off, under the
  // one message id, so the inbox records it once. Not while the chat waits on
  // a question or a wait: the turn its answer resumes takes it.
  if (recorded.state === "pending" && (running || (await waitingNow(deps, taskId)))) return merged(true);
  if (recorded.state === "pending") await transcripts.queueSteer(taskId, recorded.steerId);
  const now = await transcripts.steerOf(taskId, request.clientMessageId);
  if (now !== undefined && (now.state === "claimed" || now.state === "consumed")) return merged(true);
  return undefined;
}

/** Whether the task's latest ended admission left it waiting: on a round, a question or a wait. */
async function waitingNow(deps: Pick<ReplyDependencies, "repositories">, taskId: string): Promise<boolean> {
  return (await deps.repositories.tasks.latestSettledAdmission(taskId))?.result?.status === "waiting";
}

/**
 * The steers a turn of `taskId` did not take before it ended, each
 * handed on as the chat's next message — a reply into the conversation it was
 * sent to, under its own message id, so a front end resending it is the same
 * message. Not while a turn runs (it takes them) or a round waits (it is
 * decided first: the turn it resumes takes them). Each is delivered once it
 * is `queued`, in order, the next once the one before is recorded.
 */
export async function handOnSteers(deps: ReplyDependencies, taskId: string): Promise<number> {
  const transcripts = deps.repositories.transcripts;
  // Read first: almost every turn that ends was steered by nobody.
  const pending = (await transcripts.openSteers(taskId)).filter((open) => open.state === "pending");
  if (pending.length === 0) return 0;
  if (await turnRunning(deps.repositories.tasks, taskId)) return 0;
  // A chat waiting — on a round, a question, a worker — is answered by the
  // person, never by a message typed before it asked: the turn the answer
  // resumes takes these at its next model call.
  if (await waitingNow(deps, taskId)) return 0;
  // A cancelled task takes no turn: they stay where they are.
  if ((await deps.repositories.cancellations.get(taskId)) !== undefined) return 0;
  const task = await deps.repositories.tasks.get(taskId);
  const connectionId = task === undefined ? undefined : deps.localMessaging.connectionFor(task.workspaceId);
  if (task === undefined || connectionId === undefined) return 0;
  await bindSender(deps, connectionId, task.principalId, task.workspaceId);
  let handed = 0;
  for (const open of pending) {
    if (!(await transcripts.queueSteer(taskId, open.steerId))) continue;
    handed += 1;
    const at = deps.now();
    await new Promise<void>((resolve) => {
      deps.localMessaging
        .deliver(
          task.workspaceId,
          {
            providerEventId: open.messageId,
            kind: "message",
            externalSenderId: task.principalId,
            externalConversationId: open.conversationId,
            externalMessageId: open.messageId,
            occurredAt: at,
            receivedAt: at,
            content: open.text,
          },
          { onRecorded: () => resolve() },
        )
        .then(() => resolve())
        .catch((error: unknown) => {
          deps.log("warn", "a steer the turn did not take could not be sent as the chat's next turn", {
            taskId,
            steerId: open.steerId,
            reason: errorMessage(error),
          });
          resolve();
        });
    });
  }
  return handed;
}

/**
 * A worker is no chat: it is seen, not written to — a reply or a
 * steer goes to the chat it works for.
 */
async function workerRefusal(
  deps: Pick<ReplyDependencies, "repositories">,
  task: { readonly taskId: string; readonly chatKind?: string | undefined; readonly origin?: string | null | undefined },
): Promise<IpcAnswer<ReplyResult> | undefined> {
  // Plumbing — a heartbeat tick, an idea's prepared step — is no chat either: a turn there would run unattended, and go with it.
  if (isPlumbingOrigin(task.origin))
    return refuse("INVALID_INPUT", `task ${task.taskId} is background work, not a chat: reply in a side chat of the chat that shows it`);
  const delegation = await deps.repositories.agentDelegations.getByWorkerTaskId(task.taskId);
  if (task.chatKind !== "worker" && delegation === undefined) return undefined;
  const chat = delegation?.rootTaskId ?? delegation?.parentTaskId;
  return refuse(
    "INVALID_INPUT",
    `task ${task.taskId} is an agent's worker, not a chat: write to the chat it works for${chat === undefined ? "" : `, ${chat}`}`,
  );
}

/**
 * A conversation of the local connection with no active epoch, opened again
 * for the task its newest ended one was: an earlier local `/new` may have
 * ended it, which would leave the chat answering nothing. A Home's
 * (`home:<principal>`) is opened for that person's Home in this workspace, or
 * recorded for it, when it never had one; any
 * other for its last task, when that is of this workspace and not cancelled.
 */
async function reopenEnded(
  deps: Pick<ReplyDependencies, "repositories" | "now" | "principalOf">,
  connectionId: string,
  conversationId: string,
  workspaceId: string,
): Promise<void> {
  const conversations = deps.repositories.messagingConversations;
  if ((await conversations.get(connectionId, conversationId)) !== undefined) return;
  let taskId: string | undefined;
  if (conversationId.startsWith(HOME_CONVERSATION_PREFIX)) {
    const principal = conversationId.slice(HOME_CONVERSATION_PREFIX.length);
    const owner = deps.principalOf?.(workspaceId);
    if (principal === "" || (owner !== undefined && owner !== principal)) return;
    taskId = await deps.repositories.tasks.homeOf(workspaceId, principal);
  } else {
    const newest = await conversations.newest(connectionId, conversationId);
    const task = newest === undefined ? undefined : await deps.repositories.tasks.get(newest.taskId);
    if (
      task === undefined ||
      task.workspaceId !== workspaceId ||
      task.status === "cancelled" ||
      (await deps.repositories.cancellations.get(task.taskId)) !== undefined
    )
      return;
    taskId = task.taskId;
  }
  if (taskId === undefined) return;
  // A Home a schedule started never had a run to open its conversation: this is its first.
  if ((await conversations.newest(connectionId, conversationId)) === undefined) {
    await conversations.record({ connectionId, externalConversationId: conversationId, taskId, createdAt: deps.now() });
    return;
  }
  await conversations.reopen(connectionId, conversationId, taskId, deps.now());
}

/**
 * A task's conversation on the local connection: the one its run
 * opened, else `task:<taskId>`, recorded now. The mapping is idempotent for
 * the same task, so a retried reply finds the same conversation.
 */
async function localConversationOf(
  deps: Pick<ReplyDependencies, "repositories" | "now">,
  connectionId: string,
  task: { readonly taskId: string },
): Promise<string> {
  const conversations = deps.repositories.messagingConversations;
  /** Whether `conversationId` is the task's active mapping on this connection — never an ended epoch's. */
  const activeFor = async (conversationId: string): Promise<boolean> =>
    (await conversations.get(connectionId, conversationId))?.taskId === task.taskId;
  const recorded = await conversations.getByTask(task.taskId);
  if (recorded !== undefined && recorded.connectionId === connectionId && (await activeFor(recorded.externalConversationId)))
    return recorded.externalConversationId;
  // None active — never opened, or only an ended one (a chat reset before
  // `/new` was ordinary text here): a fresh `task:<id>` mapping, past any
  // ended epoch of that key, so the chat goes on.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const conversationId = attempt === 0 ? `task:${task.taskId}` : `task:${task.taskId}:${attempt}`;
    if (await activeFor(conversationId)) return conversationId;
    if ((await conversations.get(connectionId, conversationId)) !== undefined) continue;
    await conversations.record({ connectionId, externalConversationId: conversationId, taskId: task.taskId, createdAt: deps.now() });
    if (await activeFor(conversationId)) return conversationId;
  }
  throw new TaviError("CONFLICT", `task ${task.taskId} has no conversation on the local connection that can be opened`);
}

/**
 * The local connection's sender is the task's principal, bound to itself —
 * idempotent for the same triple. Written by the owner, from the task, never
 * from what a client sends.
 */
export async function bindSender(
  deps: Pick<ReplyDependencies, "repositories" | "now">,
  connectionId: string,
  principalId: string,
  workspaceId: string,
): Promise<void> {
  await deps.repositories.messagingIdentityBindings.bind({
    connectionId,
    externalSenderId: principalId,
    workspaceId,
    principalId,
    approvedBy: "tavi (the local connection's own sender)",
    createdAt: deps.now(),
  });
}
