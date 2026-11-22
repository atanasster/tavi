import type { RecordedTask } from "@tavi/client/browser";
import {
  ArtifactsResultSchema,
  ChatContextRewindAnswerSchema,
  TaskLabelAnswerSchema,
  TaskListResultSchema,
  TranscriptPageSchema,
  type ApprovalScope,
  type TaskLabelAnswer,
  type ApprovePayload,
  type ArtifactsResult,
  type ChatContextRewindAnswer,
  type TranscriptPage,
} from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { ask, read, unreadable, type AskOptions, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/**
 * The canvas's reads of one task: its record (`tasks { taskId }`) and a page
 * of its saved history (`tasks transcript`), typed once rather than cast at
 * every surface that opens a chat, follows a turn or names one.
 */

/** A task's record as `tasks { taskId }` answers it, with the row fields the canvas reads. */
export type TaskRecord = RecordedTask & {
  /** `false`: the owner holds no such task. */
  readonly found?: boolean;
  readonly task?: {
    readonly workspaceId?: string;
    readonly status?: string;
    readonly finalText?: string;
    readonly title?: unknown;
    readonly originScheduleId?: string | null;
    readonly creationOperationKey?: string | null;
  } | null;
  readonly executions?: readonly unknown[];
  /** The task's cancel, when it was cancelled: the reason is the person's own. */
  readonly cancellations?: readonly { readonly reason?: string }[];
};

/** A task's record as the owner answers it, whatever it says of the task. */
export function loadTaskRecord(client: SettingsClient, taskId: string, options: AskOptions = {}): Promise<Outcome<TaskRecord>> {
  return ask<TaskRecord>(client, "tasks", { taskId }, options);
}

/**
 * A task's record, found: one the owner does not hold — or, with
 * `workspaceId`, holds in another workspace — is a failure in `notFound`'s
 * words (code `NOT_FOUND`).
 */
export async function readTaskRecord(
  client: SettingsClient,
  workspaceId: string | undefined,
  taskId: string,
  options: AskOptions & { readonly notFound?: string } = {},
): Promise<Outcome<TaskRecord>> {
  const { notFound = translateNow("chat.record.notFound"), ...asking } = options;
  const answer = await loadTaskRecord(client, taskId, asking);
  if (!answer.ok) return answer;
  const record = answer.value;
  return record.found === false || (workspaceId !== undefined && record.task?.workspaceId !== workspaceId)
    ? { ok: false, message: notFound, code: "NOT_FOUND" }
    : answer;
}

/** A chat's context label: the header's taint chip, read after each turn. */
export function loadTaskLabel(client: SettingsClient, workspaceId: string, taskId: string): Promise<Outcome<TaskLabelAnswer>> {
  return read(client, "tasks", { action: "label", taskId, workspaceId }, TaskLabelAnswerSchema, {
    refused: translateNow("chat.record.labelRefused"),
  });
}

/** The newest page of a task's saved history, or the one before `before`; its deadline the client's own. */
export function loadTranscriptPage(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  before?: number,
  refused?: string,
): Promise<Outcome<TranscriptPage>> {
  return read(
    client,
    "tasks",
    { action: "transcript", taskId, workspaceId, ...(before === undefined ? {} : { before }) },
    TranscriptPageSchema,
    { timeoutMs: null, ...(refused === undefined ? {} : { refused }) },
  );
}

/** Rewind a chat to before its turn `seq`; `prompt` is the message as the page shows it, refused when the turn is another. */
export function rewindChat(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  seq: number,
  prompt: string,
): Promise<Outcome<ChatContextRewindAnswer>> {
  return read(client, "chat-context", { action: "rewind", workspaceId, taskId, seq, prompt }, ChatContextRewindAnswerSchema);
}

/** The code `loadArtifacts` gives an answer that came back but did not parse: its message already says to restart. */
export const ARTIFACTS_UNREADABLE = "UNREADABLE";

/** One page of a task's archived artifacts, decided ones too, from `cursor` when given. */
export async function loadArtifacts(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  cursor?: string,
  options: AskOptions = {},
): Promise<Outcome<ArtifactsResult>> {
  const answer = await ask<unknown>(
    client,
    "artifacts",
    { workspaceId, taskId, includeDecided: true, limit: 100, ...(cursor === undefined ? {} : { cursor }) },
    options,
  );
  if (!answer.ok) return answer;
  const parsed = ArtifactsResultSchema.safeParse(answer.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: unreadable("artifacts"), code: ARTIFACTS_UNREADABLE };
}

/**
 * The person's Home chat in `workspaceId`, or `undefined`: none yet,
 * or an owner that cannot say. Its deadline is the client's own.
 */
export async function findHome(client: SettingsClient, workspaceId: string, principal: string | undefined): Promise<string | undefined> {
  const answer = await read(
    client,
    "tasks",
    { action: "list", workspaceId, chatKinds: ["home"], ...(principal === undefined ? {} : { principalId: principal }), limit: 1 },
    TaskListResultSchema,
    { timeoutMs: null },
  );
  return answer.ok ? answer.value.rows.find((row) => row.workspaceId === workspaceId)?.taskId : undefined;
}

/** The prompt an admission carried, when it carried one. */
export function admissionPrompt(admission: NonNullable<RecordedTask["admissions"]>[number]): string | undefined {
  const intent = admission.intent as { prompt?: unknown } | null | undefined;
  return typeof intent?.prompt === "string" ? intent.prompt : undefined;
}

/** One call of a round decided call by call; a rejection may say why. */
export interface CallDecision {
  readonly callId: string;
  readonly approved: boolean;
  readonly note?: string | undefined;
}

/**
 * The `approve` payload for one round, as every surface that decides one
 * sends it. The owner (`apps/cli/src/features/approvals/owner.ts`) reads a top-level
 * `note` and `scope` as each call's default, so each is put only where it
 * means something: a verdict carries its scope when it approves and its note
 * when it rejects; a per-call decision carries the scope on each approved call
 * and the note on each rejected one — a rejection's reason is the tool result
 * the agent reads, and on an approved call it would be recorded as if it were
 * why. A note is trimmed and a blank one dropped.
 */
export function approvePayload(
  round: {
    readonly taskId: string;
    readonly workspaceId: string;
    readonly expectedSteps?: number | undefined;
    readonly decidedBy?: string | undefined;
  },
  decision: boolean | readonly CallDecision[],
  extra: { readonly scope?: ApprovalScope | undefined; readonly note?: string | undefined } = {},
): ApprovePayload {
  const { scope } = extra;
  const reason = (note: string | undefined) => {
    const trimmed = note?.trim() ?? "";
    return trimmed === "" ? {} : { note: trimmed };
  };
  return {
    taskId: round.taskId,
    workspaceId: round.workspaceId,
    ...(round.expectedSteps === undefined ? {} : { expectedSteps: round.expectedSteps }),
    ...(typeof decision === "boolean"
      ? { verdict: decision ? "approve" : "reject", ...(decision ? (scope === undefined ? {} : { scope }) : reason(extra.note)) }
      : {
          decisions: decision.map((call) => ({
            callId: call.callId,
            approved: call.approved,
            ...(call.approved ? (scope === undefined ? {} : { scope }) : reason(call.note ?? extra.note)),
          })),
        }),
    ...(round.decidedBy === undefined ? {} : { decidedBy: round.decidedBy }),
  };
}
