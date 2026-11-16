import type { FetchFunction } from "@tavi/client/browser";
import { UI_SESSION_PATH, UiSessionAnswerSchema } from "@tavi/contracts";

/** What the page reads its link from, and scrubs it out of. */
export interface PageLocation {
  readonly origin: string;
  readonly pathname: string;
  readonly hash: string;
}

export interface PageHistory {
  replaceState(data: unknown, unused: string, url?: string): void;
}

/** The page's `fetch`, as the client's bridge dialer calls it: one shape for both. */
export type SessionFetch = FetchFunction;

/** A session, or why there is none, in words the page shows. */
export type SessionOutcome =
  | { readonly kind: "session"; readonly secret: string }
  | { readonly kind: "no-link" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Exchange the one-time token in the URL's fragment for a session: the
 * cookie the bridge sets, and the secret it answers, which the page keeps
 * in memory and in the tab's own storage.
 *
 * The fragment is scrubbed from the address bar and the history entry first,
 * before any request: whatever happens next, the token is not left where a
 * reload, a bookmark or a synced history would find it.
 */
export async function openSession(location: PageLocation, history: PageHistory, fetch: SessionFetch): Promise<SessionOutcome> {
  const token = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  if (token !== "") history.replaceState(null, "", location.pathname);
  if (token === "") return { kind: "no-link" };
  let response;
  try {
    response = await fetch(`${location.origin}${UI_SESSION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token }),
    });
  } catch {
    return { kind: "refused", message: "tavi ui is not answering: is it still running?" };
  }
  if (response.status === 401) {
    return { kind: "refused", message: "This link was used or has expired. Press Enter where `tavi ui` runs for a new one." };
  }
  if (!response.ok) return { kind: "refused", message: `tavi ui refused the link (${response.status}).` };
  // A body that is not JSON fails the schema below, said as such.
  const answer = UiSessionAnswerSchema.safeParse(await response.json().catch(() => undefined));
  if (!answer.success) return { kind: "refused", message: "tavi ui answered in a form this page cannot read: reload it from a new link." };
  return { kind: "session", secret: answer.data.secret };
}
