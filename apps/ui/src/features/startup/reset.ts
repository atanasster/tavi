import type { TaviClient } from "@tavi/client/browser";

import { SESSION_SECRET_KEY } from "./start.js";

/** How long the page waits for the owner to come back before it reloads anyway. */
const RESTART_WAIT_MS = 60_000;

/** What starting over needs from the page: a test passes fakes. */
export interface ResetHost {
  readonly local?: Pick<Storage, "clear">;
  readonly session?: Pick<Storage, "getItem" | "setItem" | "clear">;
  /** Load the page again at its start. */
  readonly reload: () => void;
}

function browserHost(): ResetHost {
  return { local: window.localStorage, session: window.sessionStorage, reload: () => window.location.replace("/") };
}

/**
 * After the owner accepted a reset: wait until it has stopped and is
 * back on the empty directory, then forget what this browser kept about the
 * old instance (the open chat, seen notices, widths) and load the page again.
 * The tab's session secret stays: the `tavi ui` bridge, and its session,
 * outlived the owner.
 */
export function reloadAfterReset(client: Partial<Pick<TaviClient, "state" | "onState">>, host: ResetHost = browserHost()): void {
  let left = client.state !== "ready";
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    stop();
    clearTimeout(timer);
    try {
      const secret = host.session?.getItem(SESSION_SECRET_KEY) ?? null;
      host.local?.clear();
      host.session?.clear();
      if (secret !== null) host.session?.setItem(SESSION_SECRET_KEY, secret);
    } catch {
      /* Optional storage */
    }
    host.reload();
  };
  // A client that reports no states reloads on the timer alone.
  const stop =
    client.onState?.((state) => {
      if (state !== "ready") left = true;
      else if (left) finish();
    }) ?? (() => undefined);
  const timer = setTimeout(finish, RESTART_WAIT_MS);
}
