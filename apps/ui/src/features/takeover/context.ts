import type { TaviClient } from "@tavi/client/browser";
import { errorMessage } from "@tavi/contracts/util";
import { createContext, useContext } from "react";

import { translateNow } from "../../lib/i18n.js";
import { refusal } from "../../lib/ipc.js";

/** A session a person may take over, and the agent's request when it asked. */
export interface TakeoverTarget {
  readonly taskId: string;
  /** The live-view (browser-history) id. */
  readonly sessionId: string;
  /** `reason` is the wait's: `operator` for a grab of the person's own the agent then waited on, else the agent's own request. */
  readonly handoff?: { readonly instructions?: string; readonly deadlineAt?: string; readonly reason?: string };
  /** A session its task's finished turn kept: no turn runs to stop, so the takeover offers no Stop. */
  readonly kept?: true;
}

/**
 * What any view may do about the agent's browser: open the takeover surface,
 * or answer the agent's request without taking the page ("I can't do this").
 * Absent where the owner offers no live view.
 */
export interface TakeoverActions {
  open(target: TakeoverTarget): void;
  /** Answers `undefined` when declined, or why it could not be. */
  decline(target: TakeoverTarget, note?: string): Promise<string | undefined>;
}

export const TakeoverContext = createContext<TakeoverActions | undefined>(undefined);

export const useTakeover = (): TakeoverActions | undefined => useContext(TakeoverContext);

/**
 * "I can't do this": a watch of the session just long enough to
 * decline the agent's request, closed whatever the owner answered.
 */
export async function declineThrough(
  liveWatch: TaviClient["liveWatch"],
  workspaceId: string,
  target: TakeoverTarget,
  note?: string,
): Promise<string | undefined> {
  const opened = await liveWatch(target.taskId, { workspaceId, sessionId: target.sessionId, onMessage: (_message, ack) => ack() });
  if (opened.watch === undefined) return refusal(opened.response, translateNow("takeover.decline.unreachable"));
  try {
    const answer = await opened.watch.control({ action: "decline", sessionId: target.sessionId, ...(note === undefined ? {} : { note }) });
    return answer.ok ? undefined : refusal(answer, translateNow("takeover.decline.untold"));
  } finally {
    await opened.watch.close();
  }
}

/**
 * What the takeover's Stop is called for the task it stops: it cancels a chat or a run that only waits on the handoff, for
 * good, so it says so; a Home is never cancelled (its handoff is withdrawn)
 * and a worker is an agent of its chat, so both — and a task the page has not
 * listed — say "Stop the agent".
 */
export function stopLabel(chatKind: "home" | "side" | "worker" | "run" | "chat" | undefined, known: boolean): string {
  if (!known || chatKind === "home" || chatKind === "worker") return translateNow("takeover.stop.agent");
  return translateNow(chatKind === "run" ? "takeover.stop.run" : "takeover.stop.chat");
}

/** An owner request's answer, as far as Stop reads it. */
type StopAnswer = { readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } | undefined };

/**
 * Stop from the takeover for a task other than the open chat's running turn:
 * its turn aborted; one waiting on the person (its handoff) runs no turn, so it
 * is cancelled — except a Home, which is never cancelled: the handoff
 * it waits on is withdrawn and it resumes. A Home this page had not read yet
 * refuses the cancel (CONFLICT), and its handoff is withdrawn then. Answers
 * the request that decided it.
 */
export async function stopTakenOverTask(
  request: (command: "abort" | "cancel" | "tasks", payload: Record<string, unknown>) => Promise<StopAnswer>,
  input: { readonly taskId: string; readonly workspaceId: string; readonly isHome: boolean },
): Promise<StopAnswer> {
  const failed = (error: unknown): StopAnswer => ({ ok: false, error: { code: "UNAVAILABLE", message: errorMessage(error) } });
  const ask = (command: "abort" | "cancel" | "tasks", payload: Record<string, unknown>) => request(command, payload).catch(failed);
  const aborted = await ask("abort", { taskId: input.taskId });
  if (aborted.ok || aborted.error?.code !== "NOT_RUNNING") return aborted;
  const withdraw = () => ask("tasks", { action: "stop-handoff", taskId: input.taskId, workspaceId: input.workspaceId });
  if (input.isHome) return await withdraw();
  const cancelled = await ask("cancel", { taskId: input.taskId, reason: "Stopped from the browser takeover" });
  if (cancelled.ok || cancelled.error?.code !== "CONFLICT") return cancelled;
  const withdrawn = await withdraw();
  return withdrawn.ok ? withdrawn : cancelled;
}
