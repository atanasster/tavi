import type { TaviClient } from "@tavi/client/browser";
import { errorMessage } from "@tavi/contracts/util";

import { openSession, type PageHistory, type PageLocation, type SessionFetch } from "./session.js";
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
    host.message("Open this page from the link `tavi ui` gives you: press Enter where it runs for a new one.");
    return;
  }
  if (session.kind === "refused") {
    host.message(session.message);
    return;
  }
  const reused = "reused" in session && session.reused;
  if (!reused && storage !== undefined) writeStored(SESSION_SECRET_KEY, session.secret, storage);
  host.message("Connecting to the owner…");
  let client: TaviClient;
  try {
    client = await host.connect(session.secret);
  } catch (error) {
    if (reused) {
      // The kept session is over (expired, or `tavi ui` restarted): forgotten, and a new link asked for.
      if (storage !== undefined) removeStored(SESSION_SECRET_KEY, storage);
      host.message("This tab's sign-in has ended: press Enter where `tavi ui` runs for a new link.");
      return;
    }
    host.message(`Could not reach the owner: ${errorMessage(error)}`);
    return;
  }
  host.render(client);
}
