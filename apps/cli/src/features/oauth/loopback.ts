import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { definedOnly } from "@tavi/contracts/util";

import { oauthCallbackPage } from "./flow.js";
import type { OAuthCallbackInput } from "./core.js";

/** A listener on `127.0.0.1` for a provider's redirect, and the origin it answers on. */
export interface Loopback {
  readonly server: Server;
  readonly origin: string;
}

/** Listen on `127.0.0.1:port` (`0`: any free port), answering each request with `handle`. */
export async function listenLoopback(
  port: number,
  handle: (request: IncomingMessage, response: ServerResponse, url: URL) => void,
): Promise<Loopback> {
  const server = createServer((request, response) => handle(request, response, new URL(request.url ?? "/", "http://127.0.0.1")));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : port)}` };
}

/**
 * A loopback listener that hands each redirect to `/oauth/callback` on with
 * `relay` — to the owner, whose router gives it to the sign-in that owns its
 * state — and shows the browser the outcome; `unanswered` is said when the
 * relay fails.
 */
export async function relayOAuthCallbacks(
  port: number,
  relay: (input: OAuthCallbackInput) => Promise<{ readonly ok: boolean; readonly message: string }>,
  unanswered: string,
): Promise<Loopback> {
  return await listenLoopback(port, (request, response, url) => {
    if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
      response.writeHead(404).end();
      return;
    }
    const state = url.searchParams.get("state")?.slice(0, 128);
    const code = url.searchParams.get("code")?.slice(0, 4096);
    const error = url.searchParams.get("error")?.slice(0, 256);
    const iss = url.searchParams.get("iss")?.slice(0, 512);
    const answered =
      state === undefined
        ? Promise.resolve({ ok: false, message: "This sign-in link is no longer valid." })
        : relay({ state, ...definedOnly({ code, error, iss }) });
    void answered
      .catch(() => ({ ok: false, message: unanswered }))
      .then((outcome) => {
        const page = oauthCallbackPage(outcome);
        response.writeHead(page.status, page.headers).end(page.body);
      });
  });
}
