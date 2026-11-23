import type { Locale } from "@tavi/contracts/i18n";
import { definedOnly } from "@tavi/contracts/util";
import { openerShowsUrl, openUrl, type OpenUrlOptions } from "@tavi/node-kit";

/**
 * The provider-neutral OAuth core: what the
 * channels' sign-ins and MCP servers' logins share. Each sign-in in progress
 * is owned by its `state`; the three callback entry points — the canvas
 * bridge's `/oauth/callback` (through the `channels` IPC action), the
 * channels CLI's loopback listener, and the public ingress route — all reach
 * `OAuthCallbackRouter.callback`, which hands the answer to whichever flow
 * owns that `state`. A state is used once.
 */

export interface OAuthCallbackInput {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
  /** RFC 9207: the issuer the authorization server says answered, checked against the one the login used. */
  readonly iss?: string;
}

export interface OAuthCallbackOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** The language of the workspace the sign-in is for, when it is not English: the callback page speaks it. */
  readonly locale?: Locale;
  /** `message` in `locale`, for the callback page; absent, the page shows `message`. */
  readonly said?: string;
  /** Refused because it signed in as another account than the one it reconnects. */
  readonly conflict?: true;
}

/** A kind of sign-in: it owns the states of its flows in progress, and completes one. */
export interface OAuthCallbackHandler {
  owns(state: string): boolean;
  callback(input: OAuthCallbackInput): Promise<OAuthCallbackOutcome>;
}

export class OAuthCallbackRouter {
  readonly #handlers: readonly OAuthCallbackHandler[];
  readonly #fallback: OAuthCallbackHandler;

  /** `fallback` answers a state no handler owns (the channels' flows, which say it expired). */
  constructor(handlers: readonly OAuthCallbackHandler[], fallback: OAuthCallbackHandler) {
    this.#handlers = handlers;
    this.#fallback = fallback;
  }

  callback(input: OAuthCallbackInput): Promise<OAuthCallbackOutcome> {
    const owner = this.#handlers.find((handler) => handler.owns(input.state)) ?? this.#fallback;
    return owner.callback(input);
  }
}

/**
 * Why an authorization or token endpoint is refused: anything but
 * https, or plain http to a loopback address (a local server, a test), is
 * never opened — `file:`, `javascript:` and the like included.
 */
export function endpointProblem(url: string | URL | undefined, what: string): string | undefined {
  if (url === undefined) return `the server names no ${what}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `its ${what} is not a URL`;
  }
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return undefined;
  return `its ${what} is ${parsed.protocol} — only https is opened`;
}

/**
 * Opens an https authorization URL in the person's browser, never through a
 * shell; answers false when it did not, and the caller prints it instead.
 * The URL carries the flow's `state`, the one binding to the sign-in that
 * waits: on macOS it reaches the opener on stdin; elsewhere it is on the
 * opener's command line, where other local users can read it (see
 * `oauthSharedHostNote`). Never a secret that signs anyone in: the PKCE
 * verifier stays in the owner.
 */
export async function openAuthorizationUrl(url: string, options: OpenUrlOptions = {}): Promise<boolean> {
  if (!url.startsWith("https://")) return false;
  return await openUrl(url, options);
}

/**
 * Said after an OAuth command opened the browser, when the opener's command
 * line held the authorization URL: another user of this computer could copy
 * its `state` and race the browser to finish the sign-in with their own
 * account. `remedy` says how to keep the address out of the process list.
 * Undefined where the opener keeps it off argv (macOS).
 */
export function oauthSharedHostNote(remedy: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!openerShowsUrl(platform)) return undefined;
  return `If other people have accounts on this computer, they could copy that sign-in address from the process list and finish the sign-in as themselves: ${remedy}\n`;
}

/**
 * A provider's refusal, in the person's words: a refused consent, a redirect the client does not list, an
 * organization's block and an unknown client each say what to do; any other code is named, cleaned, as given.
 * `desktopClient`: the client is a provider's shared Desktop app client (Google's), whose fixes name that kind.
 */
export function providerRefusal(
  error: string,
  context: { readonly provider: string; readonly redirect: string; readonly desktopClient?: boolean },
): string {
  if (error === "access_denied") return "You didn't allow access. Nothing was connected.";
  if (/redirect_uri_mismatch/.test(error))
    return context.desktopClient === true
      ? `${context.provider} refused the redirect: this client is not a Desktop app client, which takes any address on this computer. Make a Desktop app client and drop its file in place of this one.`
      : `${context.provider} refused the redirect. Register exactly ${context.redirect} on your client.`;
  if (/\b(?:admin_policy_enforced|org_internal)\b/.test(error))
    return `${context.provider} refused it for this account: its organization's administrator does not allow this app. Ask them to allow it, or sign in with another account.`;
  if (/\b(?:invalid_client|unauthorized_client)\b/.test(error))
    return context.desktopClient === true
      ? `${context.provider} does not know this client, or its secret: drop the Desktop app client's file again.`
      : `${context.provider} does not know this client, or its secret: check them where the client was made.`;
  return `${context.provider} did not allow it: ${error.replace(/[^\x20-\x7e]/g, "").slice(0, 200)}`;
}

/**
 * Paste-back: the address a browser
 * landed on, for a sign-in finished where its redirect could not reach this
 * owner. It must name the flow's own redirect (origin and path) and its
 * `state`; the caller hands what it carries to its own callback. Refusals
 * name no value from the address.
 */
export function pastedCallback(
  address: string,
  expected: { readonly redirect: string; readonly state: string },
): { readonly ok: true; readonly input: OAuthCallbackInput } | { readonly ok: false; readonly message: string } {
  let url: URL;
  let redirect: URL;
  try {
    url = new URL(address.trim());
    redirect = new URL(expected.redirect);
  } catch {
    return { ok: false, message: "That is not the address the sign-in came back to." };
  }
  if (url.origin !== redirect.origin || url.pathname !== redirect.pathname)
    return { ok: false, message: "That address is not where this sign-in comes back to." };
  if (url.searchParams.get("state") !== expected.state) return { ok: false, message: "That address belongs to another sign-in." };
  const code = url.searchParams.get("code")?.slice(0, 4096);
  const error = url.searchParams.get("error")?.slice(0, 256);
  const iss = url.searchParams.get("iss")?.slice(0, 512);
  return { ok: true, input: { state: expected.state, ...definedOnly({ code, error, iss }) } };
}
