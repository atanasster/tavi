import {
  isTopicConversationKey,
  reminderIdOfTaskKey,
  type PersistencePort,
  type TaskRecord,
  type ChatMemoryMode,
  type ChannelDescriptor,
  type MessagingIdentityBinding,
  type InvocationContext,
  isLocalConnectionId,
} from "@tavi/contracts";
import { channelDescriptorOf } from "../features/channels/catalog.js";
import { createChatGrants, type ChatGrants } from "../features/permissions/chat-grants.js";

/** The origin a task's delegation chain began with; a task that was not delegated is its own root. */
export async function delegationRootOrigin(
  repositories: Pick<PersistencePort["repositories"], "tasks" | "agentDelegations">,
  taskId: string,
): Promise<string | null | undefined> {
  return (await delegationRoot(repositories, taskId)).origin;
}

/**
 * The task a delegation chain starts from, and its origin; `agent` for a chain
 * too deep to follow (`tooDeep`) and for an agent task with no delegation row yet.
 * `known` is `taskId`'s row as the caller already read it, the walk's first hop.
 */
async function delegationRoot(
  repositories: Pick<PersistencePort["repositories"], "tasks" | "agentDelegations">,
  taskId: string,
  known?: TaskRecord,
): Promise<{ readonly origin: string | null | undefined; readonly task?: TaskRecord; readonly tooDeep?: true }> {
  let current = taskId;
  for (let hop = 0; hop < 32; hop += 1) {
    const task = hop === 0 && known?.taskId === taskId ? known : await repositories.tasks.get(current);
    if (task?.origin !== "agent") return task === undefined ? { origin: undefined } : { origin: task.origin, task };
    const delegation = await repositories.agentDelegations.getByWorkerTaskId(current);
    const next = delegation?.rootTaskId ?? delegation?.parentTaskId;
    if (next === undefined || next === current) return { origin: task.origin, task };
    current = next;
  }
  return { origin: "agent", tooDeep: true };
}

/**
 * How far a task's memory reaches: `"chat-only"` when the chat
 * it belongs to — itself, or the root of the delegation chain it is a worker
 * in — is a group conversation's Home (any epoch) or one of its forum topics'
 * side chats, on a channel's connection. A group's words are its members', and
 * they read its answers, so it reads and proposes only its chat's notes. A chat
 * channel's conversation that is not one-to-one counts as a group (a group
 * whose first message came in a topic is recorded as a `thread`); an email
 * thread and a conversation of unknown kind keep the person's memory, as
 * before. A chain too deep to follow is narrowed. A worker whose delegation
 * row is not written yet (a joined worker's first turn) is not judged here:
 * its spawner's reach, stamped on its first admission, stands for it. `known`
 * is the task's own row as the caller read it moments ago.
 */
export async function memoryReachOf(
  repositories: Pick<PersistencePort["repositories"], "tasks" | "agentDelegations" | "messagingConversations">,
  taskId: string,
  known?: TaskRecord,
): Promise<"chat-only" | undefined> {
  const root = await delegationRoot(repositories, taskId, known);
  if (root.tooDeep === true) return "chat-only";
  if (root.origin !== "messaging" || root.task === undefined) return undefined;
  const mapping = await repositories.messagingConversations.getByTask(root.task.taskId);
  if (mapping === undefined || isLocalConnectionId(mapping.connectionId)) return undefined;
  if (isTopicConversationKey(mapping.externalConversationId) || mapping.conversationKind === "group") return "chat-only";
  return mapping.conversationKind === "thread" && channelDescriptorOf(mapping.providerId)?.kind === "chat" ? "chat-only" : undefined;
}

/**
 * A task's chat memory: the mode
 * of the chat it belongs to — itself, or the root of the delegation chain it
 * is a worker in, the stricter of it and its parents' for a side chat — and
 * when that chat's memory was last turned back on, the latest along the
 * side-chat chain. A chain too deep to follow
 * is off, the narrower answer. A worker whose delegation row is not written
 * yet (a joined worker's first turn) reads as its own row: its spawner's
 * mode, stamped on its first admission, stands for it. `known` is the task's
 * own row as the caller read it in this admission or model step; its parents
 * are read afresh.
 */
export async function chatMemoryOf(
  repositories: Pick<PersistencePort["repositories"], "tasks" | "agentDelegations">,
  taskId: string,
  known?: TaskRecord,
): Promise<{ readonly mode?: ChatMemoryMode; readonly onAt?: string }> {
  const root = await delegationRoot(repositories, taskId, known);
  if (root.tooDeep === true) return { mode: "off" };
  const task = root.task;
  // A side chat inherits its parent's mode live, not only at creation: a parent turned off after the side chat was opened turns it off too. The stricter
  // of the two stands — private, then off — up the side-chat chain; a chain too long to follow is off.
  // Its memory was last turned on at the latest such moment along the chain: a parent turned off
  // and back on stamps only itself, and what was said in the side chat meanwhile stays out all the same.
  let mode = task?.memoryMode;
  let onAt = task?.memoryOnAt;
  let parentId = task?.parentChatId;
  for (let hop = 0; parentId !== undefined && mode !== "private"; hop += 1) {
    if (hop >= 32) return { mode: "off" };
    const parent = await repositories.tasks.get(parentId);
    if (parent?.memoryMode === "private" || (parent?.memoryMode === "off" && mode === undefined)) mode = parent.memoryMode;
    if (parent?.memoryOnAt !== undefined && (onAt === undefined || parent.memoryOnAt > onAt)) onAt = parent.memoryOnAt;
    parentId = parent?.parentChatId;
  }
  return { ...(mode === undefined ? {} : { mode }), ...(onAt === undefined ? {} : { onAt }) };
}

/**
 * The owner's chat grants: a chat that never ends is judged from where
 * a task started, as its tool policy is — a worker delegated from a Home, and
 * a reminder said in a chat, count as their chat. Offline commands build the
 * same, so a grant lapses at the same instant whichever reads it.
 */
export function createOwnerChatGrants(repositories: PersistencePort["repositories"], now: () => string): ChatGrants {
  return createChatGrants({ repositories, now, lastingChat: (taskId) => lastingChat(repositories, taskId) });
}

/**
 * Whether a task's chat never ends: a Home — its delegation root's —
 * or a chat a messaging conversation started. A grant made there lasts a day,
 * and every surface that offers one says so ("Allow until tomorrow").
 */
export async function lastingChat(
  repositories: Pick<PersistencePort["repositories"], "tasks" | "agentDelegations" | "reminders">,
  taskId: string,
): Promise<boolean> {
  return (
    (await delegationRoot(repositories, taskId)).task?.chatKind === "home" || (await toolPolicyOrigin(repositories, taskId)) === "messaging"
  );
}

/**
 * The origin the tool policy reads for a task: its delegation root's, except
 * that a reminder's task that answers in a chat is a chat-started task. Its approvals are asked in that chat, so the messaging profile holds
 * the shell and file writes back from it as from any task a chat started. Only
 * a reminder known to be said in the app keeps its own origin.
 */
export async function toolPolicyOrigin(
  repositories: Pick<PersistencePort["repositories"], "tasks" | "agentDelegations" | "reminders">,
  taskId: string,
): Promise<string | null | undefined> {
  const root = await delegationRoot(repositories, taskId);
  if (root.origin !== "reminder") return root.origin;
  const reminderId = reminderIdOfTaskKey(root.task?.creationOperationKey ?? null);
  // A reminder that cannot be read is not guessed at: neither origin is the narrower answer everywhere (the messaging
  // profile holds writes back, but a chat grant made under it lasts a day), so the failure reaches the policy, which refuses.
  const reminder = reminderId === undefined ? undefined : await repositories.reminders.get(reminderId);
  return reminder?.deliverTo.kind === "app" ? "reminder" : "messaging";
}

/**
 * The channel a turn arrived through: `messaging` when its context
 * replies into a messaging conversation, undefined for anything else —
 * including the owner's own local connection, which every IPC run (the canvas,
 * `tavi chat`) is given for `operator.ask_user` and which no plugin connection
 * may be named like (`local-` is reserved).
 */
export function turnChannelOf(invocation: Pick<InvocationContext, "messagingReplyTo">): string | undefined {
  const replyTo = invocation.messagingReplyTo;
  return replyTo === undefined || isLocalConnectionId(replyTo.connectionId) ? undefined : "messaging";
}

/**
 * The connection a held turn came in on: its own reply target's when that is
 * no local connection, else a worker's spawning turn's, from its delegation row.
 */
export async function heldConnectionOf(
  repositories: Pick<PersistencePort["repositories"], "agentDelegations">,
  invocation: Pick<InvocationContext, "messagingReplyTo" | "runId">,
): Promise<string | undefined> {
  return turnChannelOf(invocation) === undefined
    ? (await repositories.agentDelegations.getByWorkerTaskId(invocation.runId))?.heldConnectionId
    : invocation.messagingReplyTo?.connectionId;
}

/**
 * The channel a turn is held to: its own (`turnChannelOf`), else the
 * one a worker's spawning turn was held to, from its delegation row — so a
 * worker's later turn is held whoever admits it.
 */
export async function heldChannelOf(
  repositories: Pick<PersistencePort["repositories"], "agentDelegations">,
  invocation: Pick<InvocationContext, "messagingReplyTo" | "runId">,
): Promise<string | undefined> {
  return turnChannelOf(invocation) ?? (await repositories.agentDelegations.getByWorkerTaskId(invocation.runId))?.heldChannel;
}

/**
 * Whether a turn is in the operator's own one-to-one chat: a chat channel's
 * conversation fixed as one-to-one at admission, whose sender is bound, in the
 * turn's workspace, to that workspace's operator. The only place
 * `serve --messaging-allow-tool` lifts the messaging profile: never a room, a
 * thread, an email thread or another person's chat. A turn with no reply
 * target (a worker's, a schedule's) is none.
 */
export async function inOperatorDirectChat(
  deps: {
    readonly bindingOf: (
      connectionId: string,
      externalSenderId: string,
    ) => Promise<Pick<MessagingIdentityBinding, "workspaceId" | "principalId"> | undefined>;
    readonly operatorOf: (workspaceId: string) => string | undefined;
    readonly channelKindOf: (connectionId: string) => ChannelDescriptor["kind"] | undefined;
  },
  invocation: Pick<InvocationContext, "workspaceId" | "messagingReplyTo">,
): Promise<boolean> {
  const replyTo = invocation.messagingReplyTo;
  if (replyTo === undefined || isLocalConnectionId(replyTo.connectionId) || replyTo.audience !== "one-to-one") return false;
  if (deps.channelKindOf(replyTo.connectionId) !== "chat") return false;
  const operator = deps.operatorOf(invocation.workspaceId);
  const binding = await deps.bindingOf(replyTo.connectionId, replyTo.externalSenderId);
  return operator !== undefined && binding?.workspaceId === invocation.workspaceId && binding.principalId === operator;
}
