import { memo, useMemo, useState } from "react";
import type { ToolCard } from "@tavi/client/browser";
import type { Session } from "../shell/shell.js";
import { sessionStats, sessionToolGroups } from "../shell/shell.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { formatElapsed } from "../../lib/time.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { CHAT_NOT_STARTED } from "../../ui/Parts.js";
import { readTaskRecord } from "./tasks-api.js";
import { useWorkspace } from "../shell/Workspace.js";

export function durationBand(duration: number | undefined, total: number | undefined): "major" | "notable" | "" {
  if (duration === undefined || total === undefined || total <= 0) return "";
  return duration / total >= 0.75 ? "major" : duration / total >= 0.5 ? "notable" : "";
}
function render(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "Not recorded";
  } catch {
    return "Payload could not be rendered";
  }
}
export function retainedBytes(card: ToolCard): number | undefined {
  try {
    return [card.input, card.output].reduce<number>(
      (size, value) => size + (value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).byteLength),
      0,
    );
  } catch {
    return undefined;
  }
}

export function Trajectory({ session }: { readonly session: Session }) {
  const { client, workspaceId } = useWorkspace();
  const total = sessionStats(session).elapsedMs;
  return (
    <section className="trajectory" aria-label="trajectory">
      <p>
        Recorded elapsed: {total === undefined ? "not recorded" : formatElapsed(total)}. Emphasis marks at least 50% or 75% of this elapsed
        time. Parallel tool durations can overlap.
      </p>
      <p>
        Expand a turn and model attempt to inspect its tool calls. Saved chats use retained call inputs and results. Older calls may have no
        recorded duration.
      </p>
      {sessionToolGroups(session).map(({ run, cards }, index) => {
        const attempts = [...new Set(cards.map((card) => card.attemptId))];
        const sum = cards.reduce((value, card) => value + (card.durationMs ?? 0), 0);
        return (
          <details key={run.id}>
            <summary>
              {run.recordedHistory ? "Recorded chat" : `Turn ${index + 1}`} — {cards.length} tool calls, {formatElapsed(sum)} known tool
              time{cards.some((card) => card.durationMs === undefined) ? " + unmeasured calls" : ""}
            </summary>
            {run.recordedHistory?.partial ? <p>Some earlier tool calls are no longer retained.</p> : null}
            {cards.length === 0 ? <p>No tool trajectory is retained for this turn.</p> : null}
            {attempts.map((attempt) => {
              const children = cards.filter((card) => card.attemptId === attempt);
              const duration = children.reduce((value, card) => value + (card.durationMs ?? 0), 0);
              return (
                <details key={attempt}>
                  <summary>
                    Attempt {attempt} — {formatElapsed(duration)} known tool time
                  </summary>
                  <div className="trajectory-columns">Tool · Duration · Model · Retained detail size</div>
                  {children.map((card) => (
                    <Call key={card.key} card={card} total={total} client={client} taskId={session.taskId} workspaceId={workspaceId} />
                  ))}
                </details>
              );
            })}
          </details>
        );
      })}
    </section>
  );
}
const Call = memo(function Call({
  card,
  total,
  client,
  taskId,
  workspaceId,
}: {
  readonly card: ToolCard;
  readonly total: number | undefined;
  readonly client: SettingsClient;
  readonly taskId: string | undefined;
  readonly workspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const bytes = useMemo(() => retainedBytes(card), [card.input, card.output]);
  return (
    <details className={`trajectory-call ${durationBand(card.durationMs, total)}`} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <code>{card.toolName}</code> · {card.durationMs === undefined ? "Duration not recorded" : formatElapsed(card.durationMs)} ·{" "}
        {card.model ?? "Model not recorded"} · {bytes === undefined ? "Size unavailable" : `${bytes} retained bytes`}
      </summary>
      {open ? <CallDetails card={card} client={client} taskId={taskId} workspaceId={workspaceId} /> : null}
    </details>
  );
});
function CallDetails({
  card,
  client,
  taskId,
  workspaceId,
}: {
  readonly card: ToolCard;
  readonly client: SettingsClient;
  readonly taskId: string | undefined;
  readonly workspaceId: string;
}) {
  const { data, error } = useLoaded(
    async () => {
      const unavailable = "The chat's record is unavailable in this workspace.";
      const answer = await readTaskRecord(client, workspaceId, taskId ?? "", {
        timeoutMs: null,
        refused: unavailable,
        notFound: unavailable,
      });
      return answer.ok
        ? ({
            ok: true,
            value: `The chat's record: ${answer.value.task?.status ?? "unknown"}; ${answer.value.admissions?.length ?? 0} admissions, ${answer.value.executions?.length ?? 0} executions.`,
          } as const)
        : answer;
    },
    [client, taskId, workspaceId],
    { enabled: Boolean(taskId) },
  );
  // A failed read says why in place of the last answer; the last answer stays while the next is read.
  const note = !taskId ? CHAT_NOT_STARTED : (error ?? data ?? "Reading the chat’s record…");
  return (
    <>
      <p>{note}</p>
      <h4>Retained input preview</h4>
      <pre>{render(card.input)}</pre>
      <h4>Retained output preview</h4>
      <pre>{render(card.output)}</pre>
      {card.message ? <p>{card.message}</p> : null}
    </>
  );
}
