import {
  isAttendedOrigin,
  type AgentWaitOutcome,
  type BrowserHandoffPort,
  type BrowserLiveControlChange,
  type BrowserPort,
  type PersistencePort,
  type WorkflowPort,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { BrowserLiveSource, BrowserObservation } from "@tavi/contracts";
import { resumeTask } from "@tavi/agent-host/agent-wait-scheduler";

/**
 * Handing the agent's browser to a person: the
 * owner's side of `browser.request_handoff`.
 *
 * - The workflow asks through `port`: which session (by its live-view id),
 *   who acts in it now, and — once the wait is active — the request itself,
 *   which marks the session as waiting for a person and, for a task a chat
 *   started, tells that chat where to go (the takeover is in the canvas, on
 *   this computer).
 * - The person ends it in the live view: the live source reports the change
 *   of control, and the task's handoff wait on that session is settled with
 *   how (`done`/`failed`, their note, how long) and the task resumed, as an
 *   answered question is. A session that ends meanwhile (closed, its task
 *   over) settles it `cancelled`.
 * - An owner starting settles every handoff a restart left open `cancelled`:
 *   its browser closed with the process.
 *
 * A timeout is the wait sweep's, as for any wait; the resumed tool hands the
 * page back to the agent (`end`). One that came from the person's side (the
 * idle "Still working?" check, or the owner's unattended limit) settles the
 * wait as timed out at once.
 */
export interface BrowserHandoffDependencies {
  readonly browser: BrowserPort;
  readonly live: BrowserLiveSource;
  readonly repositories: Pick<PersistencePort["repositories"], "agentWaits" | "tasks" | "agentDelegations">;
  readonly workflow: () => WorkflowPort | undefined;
  /** The task and every task under it. */
  readonly taskTree: (workspaceId: string, taskId: string) => Promise<readonly string[]>;
  /**
   * A person held the session and handed it back while no wait was on it: the
   * task's transcript says so (`browser.controlled`). Optional; nothing typed is in it.
   */
  readonly recordControl?: (change: Extract<BrowserLiveControlChange, { state: "agent" }>) => void;
  /** Posts `text` to the chat a task came from; false when it has none. */
  readonly tellChat: (taskId: string, text: string, effectId: string) => Promise<boolean>;
  /**
   * Records the page handed back as the browser tools record any observation (`RegisteredBrowserTools`): the next
   * action's card names its elements and the page's title as it is now, not as before the person signed in.
   */
  readonly noteObservation?: (observation: BrowserObservation, sessionId: string) => Promise<BrowserObservation>;
  readonly log: (level: "warn" | "info", message: string, fields?: Record<string, unknown>) => void;
}

export interface BrowserHandoffs {
  readonly port: BrowserHandoffPort;
  /** Starts listening to the live view, and settles the handoffs a restart orphaned. Answers how to stop. */
  start(): () => void;
  /**
   * Stop from the takeover for a chat that is never cancelled (a Home):
   * every handoff `taskId` or a task under it waits on is settled
   * `cancelled` and its task resumed, as a session that ended is — the
   * resumed tool hands the page back. How many were withdrawn.
   */
  withdraw(taskId: string, by: string): Promise<number>;
  /**
   * The person sent a new message instead of taking the page (a chat message while `taskId` waits on a handoff):
   * the wait is settled `cancelled` without resuming the turn that asked, and the page goes back to the agent. The
   * message's own turn moves past the call (the workflow answers it as not run). Whether a handoff was waiting.
   */
  supersede(taskId: string, by: string): Promise<boolean>;
}

/** What a remote chat is told: the takeover itself is only in the canvas, on the owner's computer. */
export function remoteHandoffText(instructions: string | undefined, host: string | undefined): string {
  const where = host === undefined ? "the browser" : host;
  return `Tavi needs you in ${where}. Open Tavi on your computer (tavi ui) to take over the browser${instructions === undefined ? "" : `: ${instructions}`}`;
}

export function createBrowserHandoffs(deps: BrowserHandoffDependencies): BrowserHandoffs {
  const { repositories } = deps;

  /** Settles a handoff wait and resumes its task; false when it was already settled. */
  async function settle(taskId: string, waitId: string, outcome: AgentWaitOutcome, by: string, via: string): Promise<boolean> {
    const workflow = deps.workflow();
    if (!(await repositories.agentWaits.settle({ waitId, outcome, resume: true, by, via }))) return false;
    const task = await repositories.tasks.get(taskId);
    // Without a workflow (or a task), the wait sweep re-admits the promised resume later.
    if (workflow !== undefined && task !== undefined) {
      void resumeTask({ waits: repositories.agentWaits, delegations: repositories.agentDelegations, workflow }, task, waitId, outcome, {
        via,
        decidedBy: by,
      }).catch((error: unknown) => deps.log("warn", "a browser handoff could not resume its task", { taskId, error: errorMessage(error) }));
    }
    return true;
  }

  /** Sessions this port handed back itself (a wait's deadline or cancel, after the wait settled): their change is no person's hold. */
  const endedHere = new Set<string>();

  async function onControl(change: BrowserLiveControlChange): Promise<void> {
    if (change.state !== "agent") return;
    // Read before any await: the change is emitted while `end` runs.
    const ours = endedHere.delete(change.sessionId);
    // By the session: a task may hand over a session one of its workers opened, so the wait is not always the session's task's.
    const wait = (await repositories.agentWaits.listActiveHandoffs()).find(
      (candidate) => candidate.handoff?.sessionId === change.sessionId,
    );
    if (wait === undefined) {
      // A person's own hold the task never waited on (it made no browser call meanwhile): only the transcript hears of it.
      // (A request always has its wait; a session that ended with nobody holding it is no hold.)
      // One the task's own wait ended (its deadline, a cancel) has that wait's receipt already.
      if (!ours && (change.outcome !== "cancelled" || change.controlledMs > 0)) deps.recordControl?.(change);
      return;
    }
    // A timeout the wait's own deadline caused already settled it (the sweep's, so this finds it settled); one the
    // person's idle check or the owner's unattended limit caused did not, and the task must not wait out its deadline.
    const outcome: AgentWaitOutcome =
      change.outcome === "done" || change.outcome === "failed"
        ? {
            kind: "answered",
            handoff: { outcome: change.outcome, controlledMs: Math.round(change.controlledMs) },
            ...(change.note === undefined ? {} : { replyText: change.note }),
          }
        : change.outcome === "timeout"
          ? { kind: "wait-timeout" }
          : { kind: "cancelled", error: { code: "HANDOFF_CANCELLED", message: "the browser session ended before it was handed back" } };
    const by = change.outcome === "done" || change.outcome === "failed" ? (change.by ?? "operator") : "policy";
    await settle(wait.taskId, wait.waitId, outcome, by, "browser");
  }

  const port: BrowserHandoffPort = {
    async target({ taskId, sessionId }) {
      const target = deps.browser.handoffTarget?.(sessionId);
      if (target === undefined) return { refusal: `No open browser session ${sessionId} that a person could take over` };
      const task = await repositories.tasks.get(taskId);
      if (task === undefined) return { refusal: "This task is not known" };
      // The task's own session, or one of a task it delegated to.
      if (target.taskId !== taskId && !(await deps.taskTree(task.workspaceId, taskId)).includes(target.taskId)) {
        return { refusal: `Browser session ${sessionId} is not this task's` };
      }
      // The task's own, kept from its last turn: open again, for a person to take.
      deps.browser.handoffTarget?.(sessionId, { wake: true });
      return { historyId: target.historyId };
    },

    controlState({ sessionId }) {
      const target = deps.browser.handoffTarget?.(sessionId);
      return target === undefined ? "agent" : (deps.live.controlState(target.historyId) ?? "agent");
    },

    async request({ taskId, historyId, handoff, waitId }) {
      // Its deadline travels with the session, so a take from anywhere (a Command Center card) shows the time left.
      const deadlineAt = (
        await repositories.agentWaits.get(waitId).catch((error: unknown) => {
          deps.log("warn", "a browser handoff's deadline could not be read; the time left shows only where the task is open", {
            error: errorMessage(error),
          });
          return undefined;
        })
      )?.deadlineAt;
      deps.live.requestHandoff(historyId, deadlineAt);
      if (deps.live.controlState(historyId) === "agent") throw new Error("the browser session could not be handed over");
      const task = await repositories.tasks.get(taskId);
      // A person at a terminal or the canvas sees it there; a chat is told where to go.
      if (task !== undefined && !isAttendedOrigin(task.origin)) {
        const host = deps.live
          .sessions({ workspaceId: task.workspaceId, taskIds: [task.taskId] })
          .find((info) => info.sessionId === historyId)?.url;
        const told = await deps
          .tellChat(taskId, remoteHandoffText(handoff.instructions, host === undefined ? undefined : hostOf(host)), `handoff:${waitId}`)
          .catch(() => false);
        if (!told) deps.log("info", "a browser handoff could not be announced in a chat", { taskId });
      }
    },

    end({ historyId, outcome }) {
      // Only when someone was asked or held it: an `end` that changes nothing emits nothing to forget.
      if ((deps.live.controlState(historyId) ?? "agent") !== "agent") endedHere.add(historyId);
      deps.live.endControl(historyId, outcome);
    },

    // What the person typed is theirs: the page is observed without its fields' values.
    observe: async (sessionId) => {
      const page = await deps.browser.observe(sessionId, { withholdValues: true });
      return deps.noteObservation === undefined ? page : await deps.noteObservation(page, sessionId);
    },

    async recorded(waitId) {
      return (await repositories.agentWaits.get(waitId)) !== undefined;
    },
  };

  return {
    port,
    async withdraw(taskId, by) {
      const task = await repositories.tasks.get(taskId);
      if (task === undefined) return 0;
      const tree = new Set([taskId, ...(await deps.taskTree(task.workspaceId, taskId))]);
      let withdrawn = 0;
      for (const wait of await repositories.agentWaits.listActiveHandoffs()) {
        if (!tree.has(wait.taskId)) continue;
        const outcome: AgentWaitOutcome = {
          kind: "cancelled",
          error: {
            code: "HANDOFF_STOPPED",
            message: "the person stopped this from the browser takeover; do not take the browser again unless they ask",
          },
        };
        if (await settle(wait.taskId, wait.waitId, outcome, by, "browser")) withdrawn += 1;
      }
      return withdrawn;
    },
    async supersede(taskId, by) {
      const wait = await repositories.agentWaits.getActiveByTask(taskId);
      if (wait?.handoff === undefined) return false;
      const outcome: AgentWaitOutcome = {
        kind: "cancelled",
        error: { code: "HANDOFF_SUPERSEDED", message: "the person sent a new message instead of taking over the browser" },
      };
      if (!(await repositories.agentWaits.settle({ waitId: wait.waitId, outcome, resume: false, by, via: "messaging" }))) return false;
      port.end({ historyId: wait.handoff.sessionId, outcome: "cancelled" });
      return true;
    },
    start() {
      const stop =
        deps.live.onControl?.((change) => {
          void onControl(change).catch((error: unknown) =>
            deps.log("warn", "a browser handoff could not be settled", { error: errorMessage(error) }),
          );
        }) ?? (() => undefined);
      // A restart closed every browser: no handoff left open can be handed back.
      void (async () => {
        for (const wait of await repositories.agentWaits.listActiveHandoffs()) {
          await settle(
            wait.taskId,
            wait.waitId,
            { kind: "cancelled", error: { code: "HANDOFF_CANCELLED", message: "the owner restarted, which closed the browser session" } },
            "policy",
            "policy",
          );
        }
      })().catch((error: unknown) => deps.log("warn", "an orphaned browser handoff could not be settled", { error: errorMessage(error) }));
      return stop;
    },
  };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}
