import {
  ArtifactsResultSchema,
  ChatContextAnswerSchema,
  ChatContextCompactAnswerSchema,
  ChatContextForgetAnswerSchema,
  ChatContextHistoryAnswerSchema,
  MemoryCardAllAnswerSchema,
  MemoryCardAnswerSchema,
  MemoryGetAnswerSchema,
  MemoryDeletionSchema,
  MemoryItemSchema,
  MemoryListAnswerSchema,
  SystemPromptPreviewSchema,
  type ArtifactListRow,
  type ChatContextAnswer,
  type ChatContextCompactAnswer,
  type ChatContextForgetAnswer,
  type ChatContextHistoryAnswer,
  type MemoryCardAllAnswer,
  type MemoryCardAnswer,
  type MemoryCardItem,
  type MemoryDeletion,
  type MemoryItem,
  type MemoryListAnswer,
  type MemoryScopeTarget,
  type SystemPromptPreview,
} from "@tavi/contracts";

import { mapOutcome, read, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/** The owner command that makes the chat panel's instructions and notes editable. */
export const CHAT_CONTEXT_FEATURE = "chat-context";

/** Fresh context: the chat's next message starts a new epoch, whatever its length. */
export function requestFreshContext(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
): Promise<Outcome<ChatContextCompactAnswer>> {
  return read(client, "chat-context", { action: "compact", workspaceId, taskId }, ChatContextCompactAnswerSchema);
}

/**
 * Forget the chat's history up to now: its saved turns, its archives
 * and the memory proposals it made that still wait; with `withMemory`, the
 * approved memories it taught too.
 */
export function forgetChatHistory(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  withMemory: boolean,
  now: Date = new Date(),
): Promise<Outcome<ChatContextForgetAnswer>> {
  return read(
    client,
    "chat-context",
    { action: "forget", workspaceId, taskId, before: now.toISOString(), ...(withMemory ? { withMemory: true } : {}) },
    ChatContextForgetAnswerSchema,
  );
}

/** An epoch's archive: the artifact its folded turns were kept in, as the chat's Details show one. */
export async function loadArchive(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  artifactId: string,
): Promise<Outcome<ArtifactListRow>> {
  const answer = await read(
    client,
    "artifacts",
    { workspaceId, taskId, artifactIds: [artifactId], includeDecided: true, limit: 1 },
    ArtifactsResultSchema,
  );
  if (!answer.ok) return answer;
  const row = answer.value.rows.find((candidate) => candidate.artifactId === artifactId && candidate.workspaceId === workspaceId);
  return row === undefined ? { ok: false, message: `The archive ${artifactId} is no longer kept.` } : { ok: true, value: row };
}

/** A chat's instructions now, and the chat a delegated task belongs to. */
export function loadChatContext(client: SettingsClient, workspaceId: string, taskId: string): Promise<Outcome<ChatContextAnswer>> {
  return read(client, "chat-context", { action: "get", workspaceId, taskId }, ChatContextAnswerSchema);
}

/** Save a new revision against the one the page read; `text` empty clears them. */
export function saveChatInstructions(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  text: string,
  expectedRevision: number,
): Promise<Outcome<ChatContextAnswer>> {
  return read(
    client,
    "chat-context",
    text === ""
      ? { action: "reset", workspaceId, taskId, expectedRevision }
      : { action: "set", workspaceId, taskId, text, expectedRevision },
    ChatContextAnswerSchema,
  );
}

/** Turn the chat's memory off or back on, from its next message; a private chat refuses `on`. */
export function setChatMemory(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  mode: "on" | "off",
): Promise<Outcome<ChatContextAnswer>> {
  return read(client, "chat-context", { action: "memory", workspaceId, taskId, mode }, ChatContextAnswerSchema);
}

/** Name the chat; `null` goes back to its generated title. */
export function renameChat(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  title: string | null,
): Promise<Outcome<ChatContextAnswer>> {
  return read(client, "chat-context", { action: "rename", workspaceId, taskId, title }, ChatContextAnswerSchema);
}

export function loadChatHistory(client: SettingsClient, workspaceId: string, taskId: string): Promise<Outcome<ChatContextHistoryAnswer>> {
  return read(client, "chat-context", { action: "history", workspaceId, taskId }, ChatContextHistoryAnswerSchema);
}

/** The layers the chat's next turn would be given. */
export function loadChatPreview(client: SettingsClient, workspaceId: string, taskId: string): Promise<Outcome<SystemPromptPreview>> {
  return read(client, "system-prompt", { action: "preview", workspaceId, taskId }, SystemPromptPreviewSchema);
}

/** One page (100) of the memory records `filter` matches, in force and (unless `statuses` says otherwise) proposed. */
function listMemoryWhere(
  client: SettingsClient,
  workspaceId: string,
  filter: Record<string, unknown>,
  statuses: readonly string[] = ["approved", "proposed"],
): Promise<Outcome<MemoryListAnswer>> {
  return read(client, "memory", { action: "list", workspaceId, ...filter, statuses: [...statuses], limit: 100 }, MemoryListAnswerSchema);
}

/** The chat's notes, in force and proposed. */
export function listChatNotes(client: SettingsClient, workspaceId: string, chatTaskId: string): Promise<Outcome<MemoryListAnswer>> {
  return listMemoryWhere(client, workspaceId, { scopes: [`chat:${chatTaskId}`] });
}

/** The memory written from this chat for every chat: what it taught. */
export function listLearnedHere(client: SettingsClient, workspaceId: string, chatTaskId: string): Promise<Outcome<MemoryListAnswer>> {
  return listMemoryWhere(client, workspaceId, { originTaskId: chatTaskId });
}

/** Every chat's notes, in force and proposed — the Command Center's list across chats — and whether more exist than one page. */
export async function listEveryChatNote(
  client: SettingsClient,
  workspaceId: string,
): Promise<Outcome<{ readonly records: readonly MemoryItem[]; readonly more: boolean }>> {
  const listed = await listMemoryWhere(client, workspaceId, { chatNotes: true });
  return mapOutcome(listed, (value) => ({ records: value.records, more: value.nextCursor !== undefined }));
}

/** The memories this chat's turns were given, most recently used first. */
export function listUsedHere(client: SettingsClient, workspaceId: string, chatTaskId: string): Promise<Outcome<MemoryListAnswer>> {
  return listMemoryWhere(client, workspaceId, { usedInTaskId: chatTaskId }, ["approved"]);
}

/** The memories one answer used, in the order it used them: the "Used N memories" chip's list. */
export function listUsedInTurn(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  seq: number,
): Promise<Outcome<MemoryListAnswer>> {
  return listMemoryWhere(client, workspaceId, { usedInTurn: { taskId, seq } }, ["approved"]);
}

/** Forget a record from an answer's chip: erased, with the deletion journal's row. */
export function forgetUsedMemory(client: SettingsClient, workspaceId: string, recordId: string): Promise<Outcome<MemoryDeletion>> {
  return read(
    client,
    "memory",
    { action: "forget", workspaceId, recordId, reason: "forgotten from an answer's memory list" },
    MemoryDeletionSchema,
  );
}

/** A note the reader keeps for this chat, in force at once. */
export function addChatNote(client: SettingsClient, workspaceId: string, chatTaskId: string, body: string): Promise<Outcome<MemoryItem>> {
  return read(client, "memory", { action: "remember", workspaceId, kind: "fact", scope: `chat:${chatTaskId}`, body }, MemoryItemSchema);
}

/** Move an approved record: a chat note to every chat, or the other way round. */
export function moveMemory(
  client: SettingsClient,
  workspaceId: string,
  record: Pick<MemoryItem, "recordId" | "currentRevisionId">,
  to: MemoryScopeTarget,
): Promise<Outcome<MemoryItem>> {
  return read(
    client,
    "memory",
    {
      action: "move",
      workspaceId,
      recordId: record.recordId,
      to,
      ...(record.currentRevisionId === undefined ? {} : { expectedRevisionId: record.currentRevisionId }),
    },
    MemoryItemSchema,
  );
}

/** A memory card, rendered by the owner now from the memory rows. */
export function loadMemoryCard(client: SettingsClient, workspaceId: string, noticeId: string): Promise<Outcome<MemoryCardAnswer>> {
  return read(client, "memory", { action: "card", workspaceId, noticeId }, MemoryCardAnswerSchema);
}

/** A card's *Keep* or *Discard*: approve or reject the proposal, held to the revision the card showed. */
export function decideMemory(
  client: SettingsClient,
  workspaceId: string,
  item: Pick<MemoryCardItem, "recordId" | "currentRevisionId">,
  decision: "approve" | "reject",
): Promise<Outcome<MemoryItem>> {
  return read(
    client,
    "memory",
    {
      action: decision,
      workspaceId,
      recordId: item.recordId,
      ...(item.currentRevisionId === undefined ? {} : { expectedRevisionId: item.currentRevisionId }),
    },
    MemoryItemSchema,
  );
}

/**
 * A card's *Keep all* or *Discard all*: the owner decides every
 * waiting record on it, *Keep all* under the one rule every bulk keep follows (plain proposals
 * only, a *Saved · N* receipt card for what it kept).
 */
export function decideMemoryCard(
  client: SettingsClient,
  workspaceId: string,
  noticeId: string,
  decision: "keep" | "discard",
): Promise<Outcome<MemoryCardAllAnswer>> {
  return read(client, "memory", { action: "card-all", workspaceId, noticeId, decision }, MemoryCardAllAnswerSchema);
}

/** A card's *Undo* on a saved record: forget it (erase it), with the deletion journal's row. */
export function undoMemory(client: SettingsClient, workspaceId: string, recordId: string): Promise<Outcome<MemoryDeletion>> {
  return read(client, "memory", { action: "forget", workspaceId, recordId, reason: "undone from a memory card" }, MemoryDeletionSchema);
}

/**
 * A card's *Edit*: keep the proposal, then correct it to the person's words —
 * only approved memory is corrected, so the approval comes first. A failed
 * correction leaves it kept as proposed, and says so.
 */
export async function keepEditedMemory(
  client: SettingsClient,
  workspaceId: string,
  item: Pick<MemoryCardItem, "recordId" | "currentRevisionId" | "state">,
  body: string,
): Promise<Outcome<MemoryItem>> {
  if (item.state === "proposed") {
    const kept = await decideMemory(client, workspaceId, item, "approve");
    if (!kept.ok) return kept;
    const corrected = await read(
      client,
      "memory",
      {
        action: "correct",
        workspaceId,
        recordId: item.recordId,
        ...(kept.value.currentRevisionId === undefined ? {} : { expectedRevisionId: kept.value.currentRevisionId }),
        body,
      },
      MemoryItemSchema,
    );
    return corrected.ok ? corrected : { ...corrected, message: `Kept as proposed; the edit was not saved: ${corrected.message}` };
  }
  return read(
    client,
    "memory",
    {
      action: "correct",
      workspaceId,
      recordId: item.recordId,
      ...(item.currentRevisionId === undefined ? {} : { expectedRevisionId: item.currentRevisionId }),
      body,
    },
    MemoryItemSchema,
  );
}

/** One record's whole current body, for a card's *Edit* (the card carries an excerpt). */
export async function loadMemoryBody(client: SettingsClient, workspaceId: string, recordId: string): Promise<Outcome<string>> {
  const answer = await read(client, "memory", { action: "get", workspaceId, recordId }, MemoryGetAnswerSchema);
  return mapOutcome(answer, (value) => value.record.body ?? "");
}
