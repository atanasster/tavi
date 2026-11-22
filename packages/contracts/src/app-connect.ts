import { z } from "zod";

import { APP_HEALTH } from "./connected-apps.js";
import { coreEnglish, type CoreT } from "./locales/core.js";

/**
 * A `connect` wait: a call in a
 * run a person attends met an app that needs signing in again, and the task
 * waits — durably, across a restart — until the account is connected, the
 * person says *Not now*, or it expires. Then the call runs again, once.
 */

/** How long a connect wait waits by default before it expires, and expiry denies. */
export const CONNECT_WAIT_DEFAULT_MS = 30 * 60_000;

/** What the wait asks: which app and account, why, in Tavi's words. Never a link or a token. */
export const ConnectRequestSchema = z.strictObject({
  /** The app's id as Connected apps names it, when the caller knows it. */
  appId: z.string().min(1).max(128).optional(),
  appName: z.string().min(1).max(80),
  /** The account to sign in again: an MCP server's plugin id, or a channel connection's id. */
  accountId: z.string().min(1).max(256),
  /** The repair's own words for the cause. */
  reason: z.string().max(300),
  health: z.enum(APP_HEALTH),
});
export type ConnectRequest = z.infer<typeof ConnectRequestSchema>;

/** How a connect wait ended, besides expiring: the account connected, or the person chose *Not now*. */
export const CONNECT_OUTCOMES = ["connected", "declined"] as const;
export const ConnectSettlementSchema = z.strictObject({ outcome: z.enum(CONNECT_OUTCOMES) });
export type ConnectSettlement = z.infer<typeof ConnectSettlementSchema>;

/** A channel's words for a connect need: text only, no link, no token — a login never starts from a channel. */
export function connectNeedText(
  request: Pick<ConnectRequest, "appName"> & Partial<Pick<ConnectRequest, "health">>,
  t: CoreT = coreEnglish,
): string {
  return t(request.health === "not-set-up" ? "app.connect.need.notSetUp" : "app.connect.need.signInAgain", { app: request.appName });
}
