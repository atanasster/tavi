import {
  CONNECT_WAIT_DEFAULT_MS,
  keyedError,
  connectNeedText,
  refusedEarly,
  type AgentWaitOutcome,
  type ConnectRequest,
  type PersistencePort,
  type ToolHandler,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { resumeTask, type SweepExpiredWaitsOptions } from "@tavi/agent-host/agent-wait-scheduler";

/**
 * Settling `connect` waits. An
 * account that signs in settles **every** wait for it as `connected`, and
 * each waiting task resumes and runs its call again; *Not now* settles only
 * the one task's wait as `declined`. A wait's deadline is the sweep's.
 */

export interface ConnectWaitsDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "agentWaits" | "tasks" | "agentDelegations">;
  /** The workflow a resumed task runs in; absent while the owner starts, when the sweep resumes it later. */
  readonly workflow: () => SweepExpiredWaitsOptions["workflow"] | undefined;
  readonly log: (level: "warn", message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** Overrides when a sign-in looks again (tests). */
  readonly recheckMs?: readonly number[];
}

export interface ConnectWaits {
  /** The account signed in: every task waiting on it resumes. Answers how many waits it settled. */
  connected(accountId: string): Promise<number>;
  /** *Not now* for one task's wait, in `workspaceId`. */
  decline(waitId: string, workspaceId: string): Promise<void>;
  /** Stops the re-checks still due: the owner is closing. */
  close(): void;
}

const VIA = "connected-apps";

/** When a sign-in looks again for waits made as it landed (an ask is active only once its task has suspended). */
const RECHECK_MS: readonly number[] = [2_000, 15_000];

export function createConnectWaits(deps: ConnectWaitsDependencies): ConnectWaits {
  const { repositories } = deps;
  /** Settles a connect wait and resumes its task; false when it was already settled. */
  const settle = async (taskId: string, waitId: string, outcome: AgentWaitOutcome): Promise<boolean> => {
    if (!(await repositories.agentWaits.settle({ waitId, outcome, resume: true, by: "operator", via: VIA }))) return false;
    const task = await repositories.tasks.get(taskId);
    const workflow = deps.workflow();
    // Without a workflow (or a task), the wait sweep re-admits the promised resume later.
    if (workflow !== undefined && task !== undefined) {
      void resumeTask({ waits: repositories.agentWaits, delegations: repositories.agentDelegations, workflow }, task, waitId, outcome, {
        via: VIA,
        decidedBy: "operator",
      }).catch((error: unknown) => deps.log("warn", "a connect wait could not resume its task", { taskId, error: errorMessage(error) }));
    }
    return true;
  };
  const settleFor = async (accountId: string): Promise<number> => {
    let settled = 0;
    for (const wait of await repositories.agentWaits.listActiveConnects()) {
      if (wait.connect?.accountId !== accountId) continue;
      if (await settle(wait.taskId, wait.waitId, { kind: "answered", connect: { outcome: "connected" } })) settled += 1;
    }
    return settled;
  };
  const rechecks = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  return {
    async connected(accountId) {
      const settled = await settleFor(accountId);
      // A wait being made as the sign-in landed is active only a moment later: looked for again, shortly.
      for (const delay of closed ? [] : (deps.recheckMs ?? RECHECK_MS)) {
        const timer = setTimeout(() => {
          rechecks.delete(timer);
          void settleFor(accountId).catch((error: unknown) =>
            deps.log("warn", "a connect wait could not be settled", { accountId, error: errorMessage(error) }),
          );
        }, delay);
        timer.unref?.();
        rechecks.add(timer);
      }
      return settled;
    },
    close() {
      closed = true;
      for (const timer of rechecks) clearTimeout(timer);
      rechecks.clear();
    },
    async decline(waitId, workspaceId) {
      const wait = await repositories.agentWaits.get(waitId);
      const task = wait === undefined ? undefined : await repositories.tasks.get(wait.taskId);
      if (wait === undefined || wait.connect === undefined || task === undefined || task.workspaceId !== workspaceId)
        throw keyedError("NOT_FOUND", "error.apps.connectNeed.notFound");
      if (wait.state !== "active") throw keyedError("CONFLICT", "error.apps.connectNeed.settled");
      await settle(wait.taskId, waitId, { kind: "answered", connect: { outcome: "declined" } });
    },
  };
}

/**
 * A call that met an account needing its sign-in, in a run that may ask its
 * person: the task waits for the account, through the call's `ask`.
 * The first time this suspends the task. Once the wait settles, the call
 * runs again from the top, and it reaches here only if signing in did not
 * help: then this answers `connected`, and the caller fails the call as
 * before — one re-run per call. *Not now*, a deadline or a cancel ends the
 * call with what happened; nothing ran, so `details` marks it a sign-in.
 */
export async function awaitConnect(
  ask: NonNullable<Parameters<ToolHandler>[0]["ask"]>,
  request: ConnectRequest,
  details: Readonly<Record<string, unknown>>,
): Promise<"connected"> {
  const outcome = await ask({ key: "connect", question: connectNeedText(request), deadlineMs: CONNECT_WAIT_DEFAULT_MS, connect: request });
  if (outcome.kind === "answered" && outcome.connect?.outcome === "connected") return "connected";
  // An account never signed in is signed in for the first time, not again.
  const again = request.health === "not-set-up" ? "" : " again";
  const why =
    outcome.kind === "answered" && outcome.connect?.outcome === "declined"
      ? `the person chose not to sign in to ${request.appName}${again} now`
      : outcome.kind === "wait-timeout"
        ? `nobody signed in to ${request.appName}${again} in time`
        : `the wait for ${request.appName}'s sign-in ended`;
  // Tavi's own words, and the call reached nothing while it waited: a chat it ends reads nothing (QA 2090).
  throw refusedEarly("NOT_AUTHORIZED", `${request.appName} is not signed in: ${why}.`, { ...details });
}
