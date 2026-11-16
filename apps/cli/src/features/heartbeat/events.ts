import { isPlumbingOrigin } from "@tavi/contracts";
import type { NeedRow, PersistencePort } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { HeartbeatWakeEvent } from "@tavi/agent-host/heartbeat-host";
import { type RepeatTimer, repeatEvery } from "@tavi/agent-host/schedule-scheduler";

import { writeGate } from "../../shared/write-gate.js";
import { principalOfNeed } from "./sources.js";

/**
 * What wakes a heartbeat between its checks: a
 * run that failed, a need past 80% of the time to its deadline, and a message
 * someone else sent. Each asks the host for a look now; the host debounces,
 * limits and gates them. A heartbeat's own runs never wake it.
 */

/** A need with a deadline wakes its person once this share of the time to it has passed. */
const HEARTBEAT_NEED_WAKE_SHARE = 0.8;
/** How often needs are read for one crossing that share. */
const HEARTBEAT_NEED_POLL_MS = 60_000;
/** With `writes`, how long needs go unread when nothing was written and no need crosses its share sooner. */
const HEARTBEAT_NEED_IDLE_POLL_MS = 15 * 60_000;

export interface HeartbeatEventDependencies {
  readonly wake: (workspaceId: string, principalId: string, event: HeartbeatWakeEvent) => void;
  readonly repositories: Pick<PersistencePort["repositories"], "tasks">;
  /** A workspace's needs waiting on someone, and whether the list was cut short. */
  readonly needs: (workspaceId: string) => Promise<{ readonly needs: readonly NeedRow[]; readonly truncated: boolean }>;
  /** The workspaces this owner serves. */
  readonly workspaces: () => readonly string[];
  /** The operator a workspace is served for: whose heartbeat a message from someone else wakes. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  /** Called with each task as it finishes, completed or failed; answers how to stop. */
  readonly onCompleted: (listener: (taskId: string) => void) => () => void;
  readonly now: () => Date;
  readonly pollMs?: number;
  /** What runs the poll's timer; absent, `setInterval`. */
  readonly every?: RepeatTimer;
  /**
   * The store's count of requests that changed rows. Given, a poll reads needs
   * only when something was written since the last, when a need it saw reaches
   * its share, or every `HEARTBEAT_NEED_IDLE_POLL_MS`: needs change only by
   * writes, and their crossings are known from the last read.
   */
  readonly writes?: () => number;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export interface HeartbeatEvents {
  /** An inbound message from `senderPrincipalId` in a workspace: it wakes the operator's heartbeat unless the operator sent it. */
  messageArrived(workspaceId: string, senderPrincipalId: string): void;
  stop(): void;
}

export function startHeartbeatEvents(deps: HeartbeatEventDependencies): HeartbeatEvents {
  const failed = (taskId: string): void => {
    void (async () => {
      const task = await deps.repositories.tasks.get(taskId);
      if (task?.status !== "failed" || isPlumbingOrigin(task.origin)) return;
      deps.wake(task.workspaceId, task.principalId, { reason: "failed-run", mode: "now" });
    })().catch((error: unknown) => deps.log("a failed run could not wake the heartbeat", { taskId, error: errorMessage(error) }));
  };
  const stopCompleted = deps.onCompleted(failed);

  /** Needs already woken for: each wakes once, and is forgotten once it is no longer waiting. */
  const woken = new Set<string>();
  let polling = false;
  const gate = deps.writes === undefined ? undefined : writeGate(deps.writes, HEARTBEAT_NEED_IDLE_POLL_MS, () => deps.now().getTime());
  /** When the earliest need the last read saw, not yet woken for, reaches its share (ms). */
  let nextCrossing = Number.POSITIVE_INFINITY;
  const poll = async (): Promise<void> => {
    if (polling) return;
    if (gate !== undefined && !gate.due() && deps.now().getTime() < nextCrossing) return;
    polling = true;
    try {
      const at = deps.now().getTime();
      let crossing = Number.POSITIVE_INFINITY;
      const waiting = new Set<string>();
      // A list cut short says nothing of the needs past its end: none is forgotten, so none wakes twice.
      let complete = true;
      for (const workspaceId of deps.workspaces()) {
        const { needs, truncated } = await deps.needs(workspaceId);
        if (truncated) complete = false;
        for (const need of needs) {
          waiting.add(need.needId);
          if (need.deadlineAt === undefined || woken.has(need.needId)) continue;
          const asked = Date.parse(need.askedAt);
          const deadline = Date.parse(need.deadlineAt);
          if (!(deadline > asked)) continue;
          const crosses = asked + HEARTBEAT_NEED_WAKE_SHARE * (deadline - asked);
          if (at < crosses) {
            crossing = Math.min(crossing, crosses);
            continue;
          }
          woken.add(need.needId);
          deps.wake(workspaceId, principalOfNeed(need), { reason: "need", mode: "now" });
        }
      }
      if (complete) for (const needId of woken) if (!waiting.has(needId)) woken.delete(needId);
      // A list cut short hides crossings past its end: those are read for at every tick, as before.
      nextCrossing = complete ? crossing : 0;
      gate?.ran();
    } catch (error) {
      deps.log("needs could not be read for the heartbeat", { error: errorMessage(error) });
    } finally {
      polling = false;
    }
  };
  const stopPolling = (deps.every ?? repeatEvery)(() => void poll(), deps.pollMs ?? HEARTBEAT_NEED_POLL_MS);

  return {
    messageArrived: (workspaceId, senderPrincipalId) => {
      const operator = deps.principalOf(workspaceId);
      if (operator === undefined || operator === senderPrincipalId) return;
      // Not a look now: a message becomes a signal only once it has waited an hour unanswered, so a check now would find
      // nothing new and still spend a model check (a busy group would use up the day). It makes the next check look.
      deps.wake(workspaceId, operator, { reason: "message", mode: "next" });
    },
    stop: () => {
      stopPolling();
      stopCompleted();
    },
  };
}
