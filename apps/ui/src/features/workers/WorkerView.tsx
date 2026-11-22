import { useEffect, useRef, useState } from "react";
import { initialRunState, reduceRun, type RunState, type Subscription, type TaviClient } from "@tavi/client/browser";
import { AgentTreeResultSchema, type AgentTreeNode, type AgentTreeResult, type TranscriptEntry as SavedTurn } from "@tavi/contracts";
import { clip, errorMessage } from "@tavi/contracts/util";

import { mergeBy } from "../../lib/paging.js";
import { translateNow, useT } from "../../lib/i18n.js";
import { Markdown } from "../../ui/Markdown.js";
import { Failure, Notice, Pending } from "../../ui/Parts.js";
import { read, type SettingsClient } from "../../lib/ipc.js";
import { loadTranscriptPage } from "../chat/tasks-api.js";
import { savedEntries } from "../chat/store/runs.js";
import { Transcript } from "../transcript/Transcript.js";
import { latestPlan } from "../chat/plan.js";
import { PlanCard } from "../chat/PlanCard.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * Workers are seen, not chatted with.
 * A delegated worker is no chat: the page shows what it did — its row
 * in the Agents tab, its saved turns in a view-only transcript beside the chat
 * that delegated to it — and never offers a composer, a sidebar row or a chat
 * route for it. What it asks is answered in its root chat.
 */

/** A worker as the page names it: its agent definition, else its agent id, else its task. */
export function workerLabel(node: Pick<AgentTreeNode, "taskId" | "agentDefinitionId" | "workerAgentId">): string {
  return node.agentDefinitionId ?? node.workerAgentId ?? node.taskId;
}

/** A worker open in the view-only transcript, and the chat it was opened from: it shows beside that chat only. */
export interface OpenWorker {
  readonly taskId: string;
  readonly label: string;
  readonly chatTaskId: string;
}

/** How much of a worker's final text a row shows before **Show all**. */
const WORKER_FINAL_CLIP = 280;

/** `text` cut to `max` characters, with an ellipsis when it was — and no space left before the ellipsis. */
export function clipText(text: string, max: number): string {
  const clipped = clip(text, max);
  return clipped === text ? text : `${clipped.slice(0, -1).trimEnd()}…`;
}

/**
 * The start of a Markdown answer, cut at the last line break within `max` so
 * no `**` or link is left open; one long line is cut as plain text is.
 */
function markdownPreview(text: string, max: number): string {
  const head = text.slice(0, max);
  const lineEnd = head.lastIndexOf("\n");
  return lineEnd > max / 3 ? `${head.slice(0, lineEnd).trimEnd()}\n\n…` : clipText(text, max);
}

/** `agents tree` for `taskId`, checked to be the tree asked for; `detail: false` asks for no activity or final text. */
export async function loadAgentTree(client: SettingsClient, workspaceId: string, taskId: string, detail = true): Promise<AgentTreeResult> {
  const answer = await read(
    client,
    "agents",
    { action: "tree", workspaceId, taskId, limit: 200, ...(detail ? {} : { detail: false }) },
    AgentTreeResultSchema,
    { timeoutMs: null, refused: translateNow("workers.view.treeUnavailable") },
  );
  if (!answer.ok) throw new Error(answer.message);
  const result = answer.value;
  if (result.workspaceId !== workspaceId || result.taskId !== taskId) throw new Error(translateNow("workers.view.treeMismatch"));
  return result;
}

/** How long the change feed's moves are gathered before a worker view or list reads again. */
export const WATCH_SETTLE_MS = 1_000;

/**
 * A feed revision that moves at most once per `ms`: the first move after a
 * quiet spell waits `ms`, and every move within it is folded into that one
 * read. `undefined` (no feed) passes through at once.
 */
export function useSettledRevision(revision: number | undefined, ms = WATCH_SETTLE_MS): number | undefined {
  const [shown, setShown] = useState(revision);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(revision);
  latest.current = revision;
  useEffect(() => {
    if (revision === undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
      setShown(undefined);
      return;
    }
    if (revision === shown || timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setShown(latest.current);
    }, ms);
  }, [revision, shown, ms]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return shown;
}

/** A worker's final text, clipped, with **Show all** for the rest. */
export function FinalText({ text, label }: { readonly text: string; readonly label: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const long = text.length > WORKER_FINAL_CLIP;
  return (
    <div className="worker-final">
      <span className="visually-hidden">{t("workers.view.finalAnswer", { label })}</span>
      {/* An agent's answer is Markdown, as a chat's is: read as such, never as its raw marks. */}
      <Markdown text={all || !long ? text : markdownPreview(text, WORKER_FINAL_CLIP)} tainted />
      {long ? (
        <Button aria-expanded={all} onClick={() => setAll((before) => !before)}>
          {all ? t("workers.view.showLess") : t("workers.view.showAll")}
        </Button>
      ) : null}
    </div>
  );
}

/** The part of the client the view reads with: requests, and the worker's stream when the client offers one. */
export type WorkerViewClient = SettingsClient & Partial<Pick<TaviClient, "subscribe">>;

/** A run state that starts over, keeping its cursor so the stream's order is still checked. */
const freshRun = (taskId: string, before?: RunState): RunState => ({
  ...initialRunState({ taskId }),
  ...(before?.cursor === undefined ? {} : { cursor: before.cursor }),
});

/** A turn that ended and was saved: a live turn that reaches one of these is read back from history. */
const turnSaved = (status: RunState["status"]): boolean => status !== "running" && status !== "idle" && status !== "unknown";

/** Turns by `seq`, one each, oldest first. */
const bySeq = (turns: readonly SavedTurn[]): readonly SavedTurn[] => mergeBy([turns], (turn) => turn.seq).sort((a, b) => a.seq - b.seq);

/**
 * The newest page laid over what is held. Before the reader paged back it is
 * the whole of it. After, it joins the earlier turns — unless more turns were
 * saved since than a page holds, which would leave a gap: then the newest page
 * starts the list over.
 */
export function mergeNewest(
  held: { readonly turns: readonly SavedTurn[]; readonly pagedBack: boolean; readonly more: boolean } | undefined,
  entries: readonly SavedTurn[],
  nextBefore: number | undefined,
): { readonly turns: readonly SavedTurn[]; readonly pagedBack: boolean; readonly more: boolean } {
  const fresh = { turns: bySeq(entries), pagedBack: false, more: nextBefore !== undefined };
  if (held === undefined || !held.pagedBack) return fresh;
  const first = entries[0]?.seq;
  const last = held.turns.at(-1)?.seq;
  if (first !== undefined && last !== undefined && first > last + 1) return fresh;
  return { turns: bySeq([...held.turns, ...entries]), pagedBack: true, more: held.more };
}

/**
 * A worker's view-only transcript: its saved turns (`tasks transcript`),
 * newest page first with **Load earlier turns**, and — while it runs and the
 * client can follow its stream — the turn in progress. It reads the newest
 * page again when `revision` moves (the Command Center's change feed) and when
 * the turn it follows ends. No composer: nothing typed here reaches the worker.
 */
export function WorkerTranscript({
  client,
  worker,
  revision,
  onClose,
}: {
  readonly client: WorkerViewClient;
  readonly worker: OpenWorker;
  readonly revision?: number | undefined;
  readonly onClose: () => void;
}) {
  const t = useT();
  const { workspaceId } = useWorkspace();
  const { taskId, label } = worker;
  const settled = useSettledRevision(revision);
  /** Every saved turn read, newest page and earlier ones, one list by `seq`. */
  const [held, setHeld] = useState<{ readonly turns: readonly SavedTurn[]; readonly pagedBack: boolean; readonly more: boolean }>();
  const [error, setError] = useState<string>();
  const [live, setLive] = useState<RunState>();
  const [ended, setEnded] = useState(0);
  const loading = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    setHeld(undefined);
    setLive(undefined);
    setError(undefined);
    heading.current?.focus();
  }, [taskId]);
  useEffect(() => {
    let current = true;
    void loadTranscriptPage(client, workspaceId, taskId, undefined, translateNow("workers.view.historyUnread"))
      .then((page) => {
        if (!current) return;
        if (!page.ok) {
          setError(page.message);
          return;
        }
        setHeld((before) => mergeNewest(before, page.value.entries, page.value.nextBefore));
        setError(undefined);
      })
      .catch((failure: unknown) => {
        if (current) setError(errorMessage(failure));
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, taskId, settled, ended]);
  useEffect(() => {
    if (client.subscribe === undefined) return;
    let current = true;
    let subscription: Subscription | undefined;
    let run = freshRun(taskId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    client
      .subscribe(taskId, {
        from: "beginning",
        onEvent: (event) => {
          if (!current) return;
          // A turn that ended — completed, failed, or left waiting on a person or a
          // decision — is saved as it ends: what comes next starts the live turn over.
          if (turnSaved(run.status) && event.kind !== "task.completed" && event.kind !== "task.failed" && event.kind !== "task.stopped")
            run = freshRun(taskId, run);
          const before = run.status;
          try {
            run = reduceRun(run, event);
          } catch {
            run = freshRun(taskId);
          }
          setLive(run);
          if (before === "running" && run.status !== "running") {
            clearTimeout(timer);
            // The turn is saved as it ends; read the history again once it is.
            timer = setTimeout(() => {
              if (current) setEnded((count) => count + 1);
            }, 500);
          }
        },
      })
      .then((opened) => {
        if (current) subscription = opened.subscription;
        else void opened.subscription?.close();
      })
      .catch(() => undefined);
    return () => {
      current = false;
      clearTimeout(timer);
      void subscription?.close();
    };
  }, [client, taskId]);
  const loadEarlier = (): void => {
    const before = held?.turns[0]?.seq;
    // One page back at a time: a second click while one is read asks nothing.
    if (before === undefined || !held?.more || loading.current) return;
    loading.current = true;
    void loadTranscriptPage(client, workspaceId, taskId, before, t("workers.view.earlierUnread"))
      .then((page) => {
        if (!page.ok) {
          setError(page.message);
          return;
        }
        setHeld((now) => ({
          turns: bySeq([...page.value.entries, ...(now?.turns ?? [])]),
          pagedBack: true,
          more: page.value.nextBefore !== undefined,
        }));
      })
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => {
        loading.current = false;
      });
  };
  const turns = held?.turns ?? [];
  const working = live !== undefined && live.status === "running" && live.transcript.length > 0;
  // Only a running turn's: a saved turn keeps no tool inputs, so its plan cannot be read back.
  const plan = working ? latestPlan(live.transcript) : undefined;
  return (
    <aside
      className="worker-view"
      aria-label={t("workers.view.title", { label })}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Taken here: the page's own Esc stops the chat's running turn.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="worker-view-head">
        <h2 tabIndex={-1} ref={heading}>
          {t("workers.view.title", { label })}
        </h2>
        <Button onClick={onClose}>{t("workers.view.close")}</Button>
      </header>
      <p className="muted">{t("workers.view.notAChat")}</p>
      {/* A worker has no chat panel: its plan is drawn here, where the chat's goes to the Activity tab. */}
      {plan === undefined ? null : <PlanCard plan={plan} />}
      <Failure message={error} />
      {held === undefined && error === undefined ? <Pending label={t("workers.view.loading")} className="notice" status /> : null}
      {held?.more ? (
        <p className="older">
          <Button onClick={loadEarlier}>{t("workers.view.loadEarlier")}</Button>
        </p>
      ) : null}
      {turns.map((turn) => (
        <article key={turn.seq} className="worker-turn">
          {turn.turn.prompt ? (
            <div className="user-message">
              <div className="message-heading">{t("workers.view.askedOf", { label })}</div>
              <p className="prompt">{turn.turn.prompt}</p>
            </div>
          ) : null}
          <Transcript entries={savedEntries(turn)} tainted={turn.turn.tainted} knownUrls={turn.turn.knownUrls} />
          {turn.turn.outcome.status === "failed" ? (
            <Failure alert={false}>
              {turn.turn.outcome.message ? t("workers.view.failedWith", { message: turn.turn.outcome.message }) : t("workers.view.failed")}
            </Failure>
          ) : turn.turn.outcome.status === "stopped" ? (
            <Notice>{turn.turn.outcome.message ?? t("workers.view.stopped")}</Notice>
          ) : turn.turn.outcome.status === "waiting" ? (
            <Notice>{t("workers.view.waited")}</Notice>
          ) : null}
        </article>
      ))}
      {working ? (
        <article className="worker-turn worker-live">
          <div className="message-heading">
            {label} <span>{t("workers.view.working")}</span>
          </div>
          <Transcript entries={live.transcript} tainted={live.tainted} knownUrls={live.knownUrls} />
        </article>
      ) : null}
      {held !== undefined && turns.length === 0 && !working ? <p>{t("workers.view.nothingSaved")}</p> : null}
    </aside>
  );
}
