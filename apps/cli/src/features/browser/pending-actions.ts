import { BROWSER_WRITE_ACTION_KINDS, type BrowserPort } from "@tavi/contracts";
import type { ApprovalRoundAnnouncement, ApprovalRoundSettlement } from "@tavi/agent-host/workflow";
import { z } from "zod";

/**
 * The live view's pending-approval outline: a `browser.act` submit,
 * upload or download waiting for the operator's
 * decision is outlined on its page from the moment its round is announced;
 * a denial takes the outline away, and an approved one runs and is reported
 * as any action is. Best effort: a failure never touches the round.
 */

/** Rounds still waiting, kept for their denial; past this the oldest is forgotten. */
const PENDING_LIMIT = 256;

const PendingActSchema = z.object({
  sessionId: z.string().min(1).max(128),
  ref: z.string().min(1).max(128),
  epoch: z.number().int().nonnegative(),
  kind: z.enum(BROWSER_WRITE_ACTION_KINDS),
});
type PendingAct = z.infer<typeof PendingActSchema>;

export interface PendingBrowserActions {
  announced(round: ApprovalRoundAnnouncement): void;
  settled(settlement: ApprovalRoundSettlement): void;
}

export function createPendingBrowserActions(
  browser: Pick<BrowserPort, "pendingAction">,
  report: (error: unknown) => void,
): PendingBrowserActions {
  const waiting = new Map<string, PendingAct>();
  /** Each call's reports, in order: a denial never overtakes the outline it takes away. */
  const chains = new Map<string, Promise<void>>();
  const keyOf = (taskId: string, callId: string): string => `${taskId}\0${callId}`;
  const tell = (key: string, input: Parameters<NonNullable<BrowserPort["pendingAction"]>>[0]): void => {
    const next = (chains.get(key) ?? Promise.resolve()).then(() => browser.pendingAction?.(input)).catch(report);
    chains.set(key, next);
    void next.then(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  };
  return {
    announced(round) {
      if (browser.pendingAction === undefined) return;
      for (const request of round.requests) {
        if (request.toolName !== "browser.act") continue;
        const parsed = PendingActSchema.safeParse(request.input);
        if (!parsed.success) continue;
        const key = keyOf(round.taskId, request.callId);
        // A round is announced again on every resume, the one carrying its decision too: outlined once.
        if (waiting.has(key)) continue;
        waiting.set(key, parsed.data);
        if (waiting.size > PENDING_LIMIT) waiting.delete(waiting.keys().next().value ?? "");
        tell(key, { ...parsed.data, callId: request.callId });
      }
    },
    settled(settlement) {
      for (const decision of settlement.decisions) {
        const key = keyOf(settlement.taskId, decision.callId);
        const pending = waiting.get(key);
        waiting.delete(key);
        if (pending !== undefined && !decision.approved) tell(key, { ...pending, callId: decision.callId, decided: "denied" });
      }
    },
  };
}
