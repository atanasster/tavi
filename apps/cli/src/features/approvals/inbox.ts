import {
  NEEDS_MAX_LIMIT,
  approvalChannelLabel,
  approvalProvenanceLine,
  needsOf,
  type ApprovalListRow,
  type ApprovalsHistoryResult,
  type NeedRow,
  type NeedsAnswer,
  type PendingApprovalRow,
  type PersistencePort,
} from "@tavi/contracts";
import { definedOnly, plural } from "@tavi/contracts/util";

import { numberedOptions, oneLine } from "../run/waiting-text.js";

import { channelLabelOf, recordedConnectionProviders } from "../channels/catalog.js";
import { BUILTIN_CHANNELS } from "../plugins/catalog.js";

/**
 * The approvals inbox as `approvals list` and `approvals history` answer it,
 * shared by the owner and the offline command
 * so the two cannot answer differently.
 */

/**
 * A pending row in `approvals list`'s shape: the `record` and `task` every
 * client already reads, and the inbox's fields beside them. The chat a round
 * was announced in is named as a person reads it (`channelName`: only the
 * owner knows its connections' names).
 */
export function approvalListRowOf(row: PendingApprovalRow, channelName?: (connectionId: string) => string | undefined): ApprovalListRow {
  const provenance = pendingProvenance(row);
  return {
    record: {
      // The row's own id and round: a client addresses a row
      // by `approvalId`, and decides a round by `steps`.
      approvalId: row.approvalId,
      taskId: row.taskId,
      toolId: row.toolId,
      callId: row.callId,
      steps: row.steps,
      createdAt: row.createdAt,
    },
    task: {
      workspaceId: row.workspaceId,
      principalId: row.principalId,
      status: row.taskStatus,
      ...(row.taskOrigin === undefined ? {} : { origin: row.taskOrigin }),
    },
    ...(row.taskTitle === undefined ? {} : { taskTitle: row.taskTitle }),
    principalId: row.principalId,
    ...definedOnly({
      rootTaskId: row.rootTaskId,
      summary: row.summary,
      risk: row.risk,
      expiresAt: row.expiresAt,
    }),
    allowedScopes: row.allowedScopes,
    ...(row.announcedIn === undefined
      ? {}
      : { announcedIn: { ...row.announcedIn, channel: approvalChannelLabel(row.announcedIn.connectionId, channelName) } }),
    ...(row.label === undefined ? {} : { label: row.label }),
    ...(provenance === undefined ? {} : { provenance }),
  };
}

/**
 * Where a pending round's chat read untrusted content, as a person reads it:
 * "⚠ after reading news.example — once only"; undefined for a round of
 * a chat that read none.
 */
export function pendingProvenance(row: Pick<PendingApprovalRow, "label" | "allowedScopes">): string | undefined {
  if (row.label === undefined) return undefined;
  return approvalProvenanceLine(row.label, row.allowedScopes.length === 1 && row.allowedScopes[0] === "once");
}

/** The history with each approval's `via` named as a person reads it; only the owner knows its connections' names. */
export function withChannels(
  result: ApprovalsHistoryResult,
  channelName?: (connectionId: string) => string | undefined,
): ApprovalsHistoryResult {
  return {
    ...result,
    items: result.items.map((item) =>
      (item.kind === "approval" || item.kind === "question") && item.via !== undefined
        ? { ...item, channel: approvalChannelLabel(item.via, channelName) }
        : item,
    ),
  };
}

/**
 * Connections' names without an owner (the offline `approvals history` and
 * `needs`): each connection's channel label, by the provider this data
 * directory recorded for it; undefined for a connection it never recorded.
 * A built-in channel keeps its name in history while its plugin is off.
 */
export async function offlineChannelNames(
  repositories: Pick<PersistencePort["repositories"], "messagingConnections" | "messagingConversations">,
): Promise<(connectionId: string) => string | undefined> {
  const providers = await recordedConnectionProviders(repositories);
  return (connectionId) => {
    const providerId = providers.get(connectionId);
    return channelLabelOf(providerId) ?? BUILTIN_CHANNELS.find((channel) => channel.descriptor.providerId === providerId)?.descriptor.label;
  };
}

/** One history item as a line of `tavi approvals history`'s text output. */
export function historyLine(item: ApprovalsHistoryResult["items"][number]): string {
  const title = (text: string | undefined) => (text === undefined ? "-" : JSON.stringify(text));
  switch (item.kind) {
    case "approval":
      return [
        item.decidedAt,
        "approval",
        item.state,
        item.taskId,
        item.toolId + (item.summary === undefined ? "" : ` ${item.summary}`),
        item.decidedBy ?? "-",
        item.channel ?? item.via ?? "-",
        item.scope ?? "-",
        ...(item.ruleId === undefined ? [] : [`rule ${item.ruleId}`]),
      ].join("\t");
    case "review":
      return [
        item.decidedAt,
        "review",
        item.state,
        item.taskId ?? "-",
        `${item.artifactId} ${item.contentType}`,
        item.decidedBy ?? "-",
        title(item.taskTitle),
      ].join("\t");
    case "question":
      return [
        item.decidedAt,
        "question",
        item.state,
        item.taskId,
        title(item.question),
        item.answer === null ? "-" : title(item.answer),
        item.decidedBy ?? "-",
        item.channel ?? item.via ?? "-",
      ].join("\t");
    case "connect":
      return [item.decidedAt, "connect", item.state, item.taskId, title(item.appName), item.decidedBy ?? "-", title(item.taskTitle)].join(
        "\t",
      );
  }
}

/**
 * Everything waiting on a person in a workspace, as one queue:
 * pending approvals, open questions and pending reviews, the soonest
 * deadline first. Each chat is named as a person reads it.
 */
export async function listNeeds(
  repositories: Pick<PersistencePort["repositories"], "approvalInbox">,
  input: { readonly workspaceId: string; readonly taskId?: string; readonly rootTaskId?: string; readonly limit?: number },
  channelName?: (connectionId: string) => string | undefined,
): Promise<NeedsAnswer> {
  const limit = Math.min(input.limit ?? 200, NEEDS_MAX_LIMIT);
  const scope = { workspaceId: input.workspaceId, limit, ...(input.taskId === undefined ? {} : { taskId: input.taskId }) };
  // A root chat's workers: their questions, approvals, reviews and browser handoffs.
  const rooted = input.rootTaskId === undefined ? undefined : { workspaceId: input.workspaceId, limit, rootTaskId: input.rootTaskId };
  const [approvals, waits] = await Promise.all([
    repositories.approvalInbox.pending(rooted ?? scope),
    repositories.approvalInbox.pendingWaits(rooted ?? scope),
  ]);
  const named = (row: PendingApprovalRow): PendingApprovalRow =>
    row.announcedIn === undefined
      ? row
      : { ...row, announcedIn: { ...row.announcedIn, channel: approvalChannelLabel(row.announcedIn.connectionId, channelName) } };
  return {
    needs: needsOf({
      approvals: approvals.rows.map(named),
      questions: waits.questions.map((question) => ({
        ...question,
        deliveries: question.deliveries.map((delivery) => ({
          ...delivery,
          channel: approvalChannelLabel(delivery.connectionId, channelName),
        })),
      })),
      reviews: waits.reviews,
      ...(waits.connects === undefined ? {} : { connects: waits.connects }),
    }),
    ...(waits.handoffs === undefined ? {} : { handoffs: waits.handoffs }),
    truncated: approvals.truncated || waits.truncated,
  };
}

/** How long a need's chat title may run in `tavi needs` before it is cut with "…". */
const NEED_TITLE_CHARS = 60;

/**
 * One need as `tavi needs`' text output: a first line with its kind and what it
 * asks — a question with its numbered options, a call by its headline,
 * results by their count — an indented line with its chat and when it stops
 * waiting, and one with the command that answers it, so no row runs past a
 * terminal's width. `--format json` is for scripts.
 */
export function needLine(need: NeedRow): string {
  const chat = (text: string | undefined) => (text === undefined ? need.taskId : `${oneLine(text, NEED_TITLE_CHARS)} (${need.taskId})`);
  const until = need.deadlineAt === undefined ? "" : ` · until ${need.deadlineAt.slice(0, 16).replace("T", " ")}Z`;
  const entry = (head: string, title: string | undefined, how: string) => `${head}\n    ${chat(title)}${until}\n    ${how}`;
  switch (need.kind) {
    case "question": {
      return entry(
        `? ${oneLine(need.question.question, 200)}${numberedOptions(need.question.choices)}`,
        need.question.originLabel ?? need.question.taskTitle,
        `answer: tavi answer ${need.taskId} <answer>`,
      );
    }
    case "approval":
      return entry(
        `! ${need.approval.toolId}${need.approval.summary === undefined ? "" : ` ${oneLine(need.approval.summary, 200)}`}`,
        need.approval.taskTitle,
        `decide: tavi approvals approve ${need.taskId} (or reject)`,
      );
    case "review":
      return entry(
        `◆ ${plural(need.review.artifactCount, "result")} to review`,
        need.review.taskTitle,
        `decide: tavi artifacts list, then approve or reject`,
      );
    case "connect":
      return entry(
        `↻ sign in to ${oneLine(need.connect.appName, 60)} again`,
        need.connect.taskTitle,
        "tavi apps connect, or Connected apps in tavi ui",
      );
  }
}
