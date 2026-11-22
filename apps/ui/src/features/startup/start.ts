import type { TaviClient } from "@tavi/client/browser";
import { errorMessage } from "@tavi/contracts/util";

import { openSession, type PageHistory, type PageLocation, type SessionFetch } from "./session.js";
import { translateNow } from "../../lib/i18n.js";
import { readStored, removeStored, writeStored } from "../../lib/storage.js";

/**
 * The tab's own storage (`sessionStorage`): scoped to this page's origin —
 * its port included, so another loopback server never reads it — and gone
 * when the tab closes. Every access may throw (storage disabled): a page that
 * cannot use it works as before, a reload needing a new link.
 */
export interface PageStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where the tab keeps its session's secret, so a reload keeps the session. */
export const SESSION_SECRET_KEY = "tavi.session";

/** What the page's start needs from its host: a test passes fakes. */
export interface PageHost {
  /** The tab's storage, when it has one: a reload reuses the session kept there. */
  readonly storage?: PageStorage;
  readonly location: PageLocation;
  readonly history: PageHistory;
  readonly fetch: SessionFetch;
  readonly connect: (secret: string) => Promise<TaviClient>;
  /** Show a line in place of the canvas. */
  readonly message: (text: string) => void;
  /** Render the canvas over a connected client. */
  readonly render: (client: TaviClient) => void;
}

/**
 * The page's start, in order: exchange the link's token
 * (scrubbed from the address bar first), connect through the bridge with the
 * secret, then render. The secret is kept in the tab's own storage:
 * reloaded, the page reuses it — the bridge still asks for the cookie as well,
 * and the session's 12 h — rather than ask for a new link.
 */
export async function startPage(host: PageHost): Promise<void> {
  const storage = host.storage;
  const opened = await openSession(host.location, host.history, host.fetch);
  const kept = opened.kind === "no-link" && storage !== undefined ? readStored(SESSION_SECRET_KEY, storage) : undefined;
  const session = kept !== undefined && kept !== "" ? { kind: "session" as const, secret: kept, reused: true } : opened;
  if (session.kind === "no-link") {
    host.message(translateNow("app.start.noLink"));
    return;
  }
  if (session.kind === "refused") {
    host.message(session.message);
    return;
  }
  const reused = "reused" in session && session.reused;
  if (!reused && storage !== undefined) writeStored(SESSION_SECRET_KEY, session.secret, storage);
  host.message(translateNow("app.start.connecting"));
  let client: TaviClient;
  try {
    client = await host.connect(session.secret);
  } catch (error) {
    if (reused) {
      // The kept session is over (expired, or `tavi ui` restarted): forgotten, and a new link asked for.
      if (storage !== undefined) removeStored(SESSION_SECRET_KEY, storage);
      host.message(translateNow("app.start.signInEnded"));
      return;
    }
    host.message(translateNow("app.start.unreachable", { error: errorMessage(error) }));
    return;
  }
  host.render(client);
}

/** A `tavi ui` link's fragment: its one-time token, 32 random bytes in base64url. */
const LINK_FRAGMENT = /^#[A-Za-z0-9_-]{43}$/;

/** What watching for a new link needs from the page: a test passes fakes. */
export interface LinkWatchHost {
  readonly location: Pick<PageLocation, "pathname" | "hash">;
  readonly addEventListener: (type: "hashchange", listener: () => void) => void;
  /** Load the page again, at its current address. */
  readonly reload: () => void;
}

/**
 * A new link opened in a tab already showing the page: the page loads again
 * and signs in with it. Its address differs from the tab's only in the
 * fragment, so the browser does not load it — it only changes the fragment —
 * and a tab whose `tavi ui` restarted would otherwise keep its ended session.
 * Only a token at the page's root counts: a settings anchor is never one.
 */
export function watchForNewLink(host: LinkWatchHost): void {
  host.addEventListener("hashchange", () => {
    if (host.location.pathname === "/" && LINK_FRAGMENT.test(host.location.hash)) host.reload();
  });
}
