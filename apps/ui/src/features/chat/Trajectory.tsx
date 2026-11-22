import { memo, useMemo, useState } from "react";
import type { ToolCard } from "@tavi/client/browser";
import type { Session } from "../shell/shell.js";
import { sessionStats, sessionToolGroups } from "../shell/shell.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { formatElapsed } from "../../lib/time.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { readTaskRecord } from "./tasks-api.js";
import { useWorkspace } from "../shell/Workspace.js";

export function durationBand(duration: number | undefined, total: number | undefined): "major" | "notable" | "" {
  if (duration === undefined || total === undefined || total <= 0) return "";
  return duration / total >= 0.75 ? "major" : duration / total >= 0.5 ? "notable" : "";
}
function render(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? translateNow("chat.trajectory.notRecorded");
  } catch {
    return translateNow("chat.trajectory.unrenderable");
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
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const total = sessionStats(session).elapsedMs;
  return (
    <section className="trajectory" aria-label={t("chat.trajectory.label")}>
      <p>{t("chat.trajectory.elapsed", { elapsed: total === undefined ? t("chat.trajectory.elapsedUnknown") : formatElapsed(total) })}</p>
      <p>{t("chat.trajectory.intro")}</p>
      {sessionToolGroups(session).map(({ run, cards }, index) => {
        const attempts = [...new Set(cards.map((card) => card.attemptId))];
        const sum = cards.reduce((value, card) => value + (card.durationMs ?? 0), 0);
        return (
          <details key={run.id}>
            <summary className="disclosure">
              {t(cards.some((card) => card.durationMs === undefined) ? "chat.trajectory.turnUnmeasured" : "chat.trajectory.turn", {
                turn: run.recordedHistory ? t("chat.trajectory.recordedChat") : t("chat.trajectory.turnNumber", { number: index + 1 }),
                count: cards.length,
                time: formatElapsed(sum),
              })}
            </summary>
            {run.recordedHistory?.partial ? <p>{t("chat.trajectory.partial")}</p> : null}
            {cards.length === 0 ? <p>{t("chat.trajectory.none")}</p> : null}
            {attempts.map((attempt) => {
              const children = cards.filter((card) => card.attemptId === attempt);
              const duration = children.reduce((value, card) => value + (card.durationMs ?? 0), 0);
              return (
                <details key={attempt}>
                  <summary className="disclosure">{t("chat.trajectory.attempt", { attempt, time: formatElapsed(duration) })}</summary>
                  <div className="trajectory-columns">{t("chat.trajectory.columns")}</div>
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
  const t = useT();
  const [open, setOpen] = useState(false);
  const bytes = useMemo(() => retainedBytes(card), [card.input, card.output]);
  return (
    <details className={`trajectory-call ${durationBand(card.durationMs, total)}`} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="disclosure">
        <span>
          <code>{card.toolName}</code> · {card.durationMs === undefined ? t("chat.trajectory.noDuration") : formatElapsed(card.durationMs)}{" "}
          · {card.model ?? t("chat.trajectory.noModel")} ·{" "}
          {bytes === undefined ? t("chat.trajectory.noSize") : t("chat.trajectory.bytes", { count: bytes, bytes: String(bytes) })}
        </span>
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
  const t = useT();
  const { data, error } = useLoaded(
    async () => {
      const unavailable = translateNow("chat.trajectory.recordUnavailable");
      const answer = await readTaskRecord(client, workspaceId, taskId ?? "", {
        timeoutMs: null,
        refused: unavailable,
        notFound: unavailable,
      });
      return answer.ok
        ? ({
            ok: true,
            value: translateNow("chat.trajectory.record", {
              status: answer.value.task?.status ?? translateNow("chat.trajectory.statusUnknown"),
              admissions: answer.value.admissions?.length ?? 0,
              executions: answer.value.executions?.length ?? 0,
            }),
          } as const)
        : answer;
    },
    [client, taskId, workspaceId],
    { enabled: Boolean(taskId) },
  );
  // A failed read says why in place of the last answer; the last answer stays while the next is read.
  const note = !taskId ? t("ui.parts.chatNotStarted") : (error ?? data ?? t("chat.trajectory.reading"));
  return (
    <>
      <p>{note}</p>
      <h4>{t("chat.trajectory.input")}</h4>
      <pre>{render(card.input)}</pre>
      <h4>{t("chat.trajectory.output")}</h4>
      <pre>{render(card.output)}</pre>
      {card.message ? <p>{card.message}</p> : null}
    </>
  );
}
