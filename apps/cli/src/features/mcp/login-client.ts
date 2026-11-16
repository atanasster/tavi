import { jsonText } from "../../cli/output.js";
import type { Server } from "node:http";

import { TaviError, type McpPayload } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { sleep } from "@tavi/node-kit";

import { relayOAuthCallbacks } from "../oauth/loopback.js";
import { oauthSharedHostNote, openAuthorizationUrl } from "../oauth/core.js";

/**
 * `tavi mcp login <id>`: the operator's login
 * to an OAuth MCP server. The server's authorization redirect comes back to a
 * listener here on 127.0.0.1 (or to the owner's public address), which hands
 * it to the owner; the authorization URL is opened (never through a shell)
 * when it is https, else printed. Only the operator's CLI and the canvas
 * reach this: no tool, chat or channel can start a login.
 */

const POLL_MS = 500;
const WAIT_MS = 10 * 60 * 1000;

export interface McpLoginIo {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

type Ask = <T>(command: "mcp" | "channels", payload: Readonly<Record<string, unknown>>) => Promise<T>;

export interface McpLoginOptions {
  readonly open: boolean;
  /** The browser opener; `openAuthorizationUrl` by default. */
  readonly openUrl?: (url: string) => boolean | Promise<boolean>;
  readonly format?: "text" | "json";
  readonly port?: number;
  /** Come back to the owner's https address instead of a listener here. */
  readonly public?: boolean;
  /**
   * Paste-back: the address the browser landed on, read here, for a browser that cannot reach this
   * computer. The listener still waits, so whichever comes first finishes the sign-in.
   */
  readonly paste?: (signal: AbortSignal) => Promise<string>;
}

export async function runMcpLogin(pluginId: string, ask: Ask, io: McpLoginIo, options: McpLoginOptions = { open: true }): Promise<void> {
  if (options.public === true) {
    const started = await ask<{ readonly login: { readonly flowId: string; readonly authorizeUrl: string; readonly redirect: string } }>(
      "mcp",
      { action: "login", pluginId, via: "public" } satisfies McpPayload,
    );
    const { opened, note } = await openSignIn(started.login.authorizeUrl, options);
    io.stderr(
      `${opened ? "Opened your browser to sign in to" : "Open this address in a browser to sign in to"} ${pluginId}; it comes back to ${started.login.redirect}:\n${started.login.authorizeUrl}\n${note}`,
    );
    await waitFor(pluginId, started.login.flowId, ask, io, options);
    return;
  }
  let server: Server | undefined;
  const pasteWait = new AbortController();
  try {
    // A fixed port for a client that registered this redirect exactly (a Google Web client); any free one otherwise.
    const loopback = await relayOAuthCallbacks(
      options.port ?? 0,
      (callback) => ask<{ readonly ok: boolean; readonly message: string }>("channels", { action: "oauth-callback", ...callback }),
      "The owner did not answer; log in again.",
    );
    server = loopback.server;
    const origin = loopback.origin;
    const started = await ask<{ readonly login: { readonly flowId: string; readonly authorizeUrl: string } }>("mcp", {
      action: "login",
      pluginId,
      origin,
      via: "loopback",
    } satisfies McpPayload);
    const { flowId, authorizeUrl } = started.login;
    const { opened, note } = await openSignIn(authorizeUrl, options);
    io.stderr(
      `${opened ? "Opened your browser to sign in to" : "Open this address in a browser to sign in to"} ${pluginId}, then come back here:\n${authorizeUrl}\n${note}`,
    );
    if (options.paste !== undefined) {
      io.stderr(
        "Signing in on another computer? Paste the address the browser lands on here (only here, never into a chat or another site), then press Enter:\n",
      );
      // The paste finishes the flow; the poll below then sees it signed in. A bad paste is said, and the poll goes on.
      // However the sign-in ends, the wait for a paste ends with it, so the command exits.
      void options.paste(pasteWait.signal).then(
        async (address) => {
          if (address.trim() === "") return;
          try {
            await ask("mcp", { action: "login-finish", flowId, address: address.trim().slice(0, 8192) } satisfies McpPayload);
          } catch (error) {
            io.stderr(`${errorMessage(error)}\n`);
          }
        },
        () => undefined,
      );
    }
    await waitFor(pluginId, flowId, ask, io, options);
  } finally {
    pasteWait.abort();
    server?.close();
  }
}

async function waitFor(pluginId: string, flowId: string, ask: Ask, io: McpLoginIo, options: McpLoginOptions): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    await sleep(POLL_MS);
    const status = (
      await ask<{ readonly loginStatus: { readonly state: string; readonly detail?: string } }>("mcp", {
        action: "login-status",
        flowId,
      } satisfies McpPayload)
    ).loginStatus;
    if (status.state === "connected") {
      io.stdout(options.format === "json" ? jsonText({ pluginId, signedIn: true }) : `${pluginId} is signed in\n`);
      return;
    }
    if (status.state !== "pending")
      throw new TaviError(
        "UNAVAILABLE",
        status.detail ??
          (status.state === "expired" ? "The sign-in took too long; log in again." : "The sign-in did not finish; log in again."),
      );
    if (Date.now() > deadline) throw new TaviError("UNAVAILABLE", "The sign-in took too long; log in again.");
  }
}

/**
 * Opens the authorization URL unless `--no-open`; `note` is the shared-host
 * note when the default opener's command line held it, else empty.
 */
async function openSignIn(url: string, options: McpLoginOptions): Promise<{ readonly opened: boolean; readonly note: string }> {
  if (!options.open) return { opened: false, note: "" };
  const opened = await (options.openUrl ?? openAuthorizationUrl)(url);
  const note = opened && options.openUrl === undefined ? oauthSharedHostNote("next time, use `--no-open` and open it by hand.") : undefined;
  return { opened, note: note ?? "" };
}
