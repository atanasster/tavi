import {
  TaviError,
  isRefusedEarly,
  refusedEarly,
  type MessagingConnectionRecord,
  type TaskExecutionPolicy,
  type ToolHandler,
} from "@tavi/contracts";

import { attended } from "../mcp/bridge.js";
import { awaitConnect } from "./connect-waits.js";

/**
 * What a channel account's tools share, whatever they reach (its mailbox, its calendar): how a call that meets
 * a lapsed sign-in waits for it or shows its Connect card, and how their registrations are refreshed in order.
 */

type Ask = NonNullable<Parameters<ToolHandler>[0]["ask"]>;

/**
 * A lapsed sign-in met by a call: where its person may be asked, the task waits for it, and the call runs again;
 * in a run a person attends, the chat's Connect card. Any other failure is thrown as it is.
 */
export function signInLapse(
  app: { readonly providerId: string; readonly label: string },
  reason: (record: MessagingConnectionRecord) => string,
): (record: MessagingConnectionRecord, error: unknown, policy: TaskExecutionPolicy | undefined, ask?: Ask) => Promise<never> {
  const signInAgain = `${app.label} needs the person to sign in again. Tavi has shown them a Connect button in this chat; tell them, and continue once they say it's done.`;
  return async (record, error, policy, ask) => {
    if (!(error instanceof TaviError) || error.details?.["signIn"] !== true) throw error;
    // Never signed in: a first sign-in, and the account's name is a placeholder until it is.
    const first = record.authState === "none";
    if (ask !== undefined) {
      await awaitConnect(
        ask,
        {
          appId: app.providerId,
          appName: app.label,
          accountId: record.connectionId,
          reason: first ? "" : reason(record).slice(0, 300),
          health: first ? "not-set-up" : "needs-sign-in",
        },
        { signIn: true, appId: app.providerId, accountId: record.connectionId },
      );
    }
    if (attended(policy)) {
      const details = { ...error.details, appId: app.providerId, accountId: record.connectionId, connectCard: true };
      // A sign-in Tavi refused before reaching the provider stays Tavi's own words, so the chat reads nothing (QA 2090).
      throw isRefusedEarly(error)
        ? refusedEarly("NOT_AUTHORIZED", signInAgain, details)
        : new TaviError("NOT_AUTHORIZED", signInAgain, { details });
    }
    throw error;
  };
}

/** Wraps each call so a failure goes to `failed`: every call, not only its token, since a provider may refuse a revoked sign-in. */
export function guardedBy(failed: (error: unknown) => Promise<never>) {
  return <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await call(...args);
      } catch (error) {
        return await failed(error);
      }
    };
}

/** One refresh at a time, in order, so an older one never puts back opt-ins a newer one took away. */
export function serialRefresh(run: () => Promise<void>): () => Promise<void> {
  let refreshing: Promise<void> = Promise.resolve();
  return () => {
    const next = refreshing.then(run);
    // Ordering only: the work's own failure reaches its caller through the promise it was handed.
    refreshing = next.catch(() => undefined);
    return next;
  };
}
