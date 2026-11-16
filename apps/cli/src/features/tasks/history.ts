import {
  boundEventPayload,
  ContentLabelSchema,
  labelSummary,
  TRUSTED_PUBLIC,
  WorkflowMessageSchema,
  type ExecutionRecord,
  type LabelSummary,
  type TaskRecord,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import type { RecordedTask, ToolCard } from "@tavi/client";
import { ModelAccounting, type DatabaseClient } from "@tavi/runtime";

/** A task's latest checkpoint's channel values, parsed once for the readers below; `undefined` when it cannot be read. */
type CheckpointValues = {
  readonly runId?: string;
  readonly conversation?: unknown[];
  readonly toolCallsDispatched?: number;
  readonly contextLabel?: unknown;
};

/** A task's latest checkpoint as read: whether there is one, and its values when they parse. */
export interface CheckpointRead {
  readonly found: boolean;
  readonly values: CheckpointValues | undefined;
}

export async function readCheckpointValues(
  store: Pick<DatabaseClient, "checkpoints">,
  task: Pick<TaskRecord, "threadId" | "checkpointNamespace">,
): Promise<CheckpointRead> {
  const row = await store.checkpoints.get({ threadId: task.threadId, namespace: task.checkpointNamespace });
  if (row === undefined) return { found: false, values: undefined };
  if (row.type !== "json") return { found: true, values: undefined };
  try {
    const checkpoint = JSON.parse(Buffer.from(row.checkpoint).toString("utf8")) as { channel_values?: CheckpointValues };
    return { found: true, values: checkpoint.channel_values };
  } catch {
    return { found: true, values: undefined };
  }
}

/**
 * The chat's context label as its checkpoint records it (UNTRUSTED-CONTENT
 * U4, the header's taint chip and `tavi tasks <id>`): the sticky
 * `contextLabel` channel, summarized (`labelSummary`: sources, principals,
 * the newest 5 refs). The channel holds every label a turn admitted or a result brought,
 * so a fold does not lower it. `null` when the checkpoint cannot be read or
 * its label does not parse; trusted and public for a chat with no checkpoint yet.
 */
export function checkpointContextLabel(read: CheckpointRead): LabelSummary | null {
  if (!read.found) return labelSummary(TRUSTED_PUBLIC);
  const values = read.values;
  if (values === undefined) return null;
  const channel = values.contextLabel === undefined ? TRUSTED_PUBLIC : ContentLabelSchema.safeParse(values.contextLabel).data;
  if (channel === undefined) return null;
  return labelSummary(channel);
}

/** A bounded read of existing durable records; never depends on the event ring. `values`: the checkpoint, when the caller read it already. */
export async function taskHistory(
  store: DatabaseClient,
  task: TaskRecord,
  executions: readonly ExecutionRecord[],
  read?: CheckpointRead,
): Promise<NonNullable<RecordedTask["history"]>> {
  const attempts = await new ModelAccounting(store.asPort()).summaries(task.taskId);
  const models = [...new Set(attempts.map((call) => `${call.connectionId}/${call.model}`))];
  const starts = (await executions.map((execution) => execution.startedAt)).sort();
  const ends = (await executions.flatMap((execution) => (execution.endedAt === null ? [] : [execution.endedAt]))).sort();
  // Working time: each ended execution's own span. The gaps between them — a
  // round waiting on a person, a night between turns — are not work.
  const spans = executions.flatMap((execution) => {
    const span = execution.endedAt === null ? Number.NaN : Date.parse(execution.endedAt) - Date.parse(execution.startedAt);
    return Number.isFinite(span) && span >= 0 ? [span] : [];
  });
  const tools: ToolCard[] = [];
  let partial = false;
  {
    const values = (read ?? (await readCheckpointValues(store, task))).values;
    if (values !== undefined) {
      try {
        if (values?.runId === task.taskId && Array.isArray(values.conversation)) {
          let pending = new Map<string, number>();
          for (const raw of values.conversation) {
            const parsed = WorkflowMessageSchema.safeParse(raw);
            if (!parsed.success) {
              partial = true;
              continue;
            }
            const message = parsed.data;
            if (message.role === "assistant") {
              // Providers can reuse call ids on later model steps.
              pending = new Map();
              const attemptId = message.id.startsWith("assistant-") ? message.id.slice("assistant-".length) : message.id;
              const model = attempts.find((attempt) => attempt.attemptId === attemptId);
              for (const call of message.toolCalls ?? []) {
                pending.set(call.id, tools.length);
                tools.push({
                  kind: "tool",
                  key: `${attemptId}:${call.id}`,
                  attemptId,
                  callId: call.id,
                  toolName: call.name,
                  input: boundEventPayload(call.input),
                  status: "interrupted",
                  ...(model === undefined ? {} : { model: `${model.connectionId}/${model.model}` }),
                });
              }
            } else if (message.role === "tool" && message.toolCallId !== undefined) {
              const index = pending.get(message.toolCallId);
              const card = index === undefined ? undefined : tools[index];
              if (card === undefined || index === undefined) {
                partial = true;
                continue;
              }
              tools[index] = {
                ...card,
                status: message.isError ? "failed" : "completed",
                output: boundEventPayload(message.output ?? message.text),
                ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
              };
            }
          }
          partial ||= (values.toolCallsDispatched ?? 0) > tools.length;
        } else partial = true;
      } catch {
        partial = true;
      }
    } else partial = true;
  }
  // Bound the additional IPC payload. Checkpoint compaction may also omit older
  // calls; the UI must describe this as retained history, not a complete audit.
  const retained: ToolCard[] = [];
  let bytes = 0;
  for (const card of tools.slice().reverse()) {
    bytes += Buffer.byteLength(JSON.stringify(card));
    if (bytes > 256 * 1024 || retained.length >= 256) {
      partial = true;
      break;
    }
    retained.push(card);
  }
  return {
    ...(models.length === 0
      ? {}
      : {
          metrics: {
            models: models.slice(0, 64),
            totalTokens: attempts.reduce(
              (total, call) => total + (call.usage.totalTokens ?? (call.usage.inputTokens ?? 0) + (call.usage.outputTokens ?? 0)),
              0,
            ),
            partial: attempts.some(
              (call) =>
                call.usage.totalTokens === undefined && (call.usage.inputTokens === undefined || call.usage.outputTokens === undefined),
            ),
          },
        }),
    ...(starts[0] === undefined ? {} : { startedAt: starts[0] }),
    ...definedOnly({ lastAt: ends.at(-1) }),
    ...(spans.length === 0 ? {} : { activeMs: spans.reduce((total, span) => total + span, 0) }),
    tools: retained.reverse(),
    partial,
  };
}
