import { keyedError, TaviError, refusedEarly, type ChannelDescriptor, type MessagingConnectionAuthState } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { readJsonBody } from "../../shared/json-body.js";
import { oauthClientOf, oauthSpecOf, requiredScopes, withClientAuth, type OAuthOptIns } from "../channels/oauth.js";
import { createLocalCredentialStore, serializeCredentialAction } from "../credentials/store.js";
import { oauthTokenRef, type OAuthTokenSecret } from "./flow.js";

/**
 * The host's token broker: what a connector's `credentials.accessToken()`
 * answers. It refreshes a token a minute before it expires, once at a time per
 * connection, and keeps a rotated refresh token. A refresh the provider
 * refuses for good (`invalid_grant`) marks the connection expired — it stops,
 * and the operator is asked to reconnect — and is never retried in a loop. A
 * token granted fewer scopes than the channel now asks for marks it
 * needs-consent, and is used as it is meanwhile: never silently widened.
 * Plugins see an access token, never the refresh token or the client.
 */

const REFRESH_AHEAD_MS = 60_000;
const TOKEN_TIMEOUT_MS = 30_000;

export interface OAuthBrokerDependencies {
  readonly dataDirectory: string;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly descriptorOf: (providerId: string) => ChannelDescriptor | undefined;
  /** What a connection turned on that asks for more access; only its mail is the channel's own work. */
  readonly optInsOf?: (connectionId: string) => Promise<OAuthOptIns>;
  /** Records a connection's sign-in state; one expired is closed until signed in again, one needing consent keeps running. */
  readonly setAuthState: (connectionId: string, authState: MessagingConnectionAuthState) => Promise<void>;
}

async function readToken(dataDirectory: string, connectionId: string): Promise<OAuthTokenSecret | undefined> {
  // Not stored is not connected; a store that cannot be read is its own failure, said as such.
  const raw = await createLocalCredentialStore(dataDirectory).getSecret(oauthTokenRef(connectionId));
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthTokenSecret>;
    return typeof parsed.accessToken === "string"
      ? {
          accessToken: parsed.accessToken,
          scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
          tokenType: parsed.tokenType ?? "Bearer",
          ...(parsed.refreshToken === undefined ? {} : { refreshToken: parsed.refreshToken }),
          ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** `message` with every one of `secrets` cut out. */
function redacted(message: string, secrets: readonly (string | undefined)[]): string {
  return secrets.reduce<string>(
    (text, secret) => (secret === undefined || secret === "" ? text : text.split(secret).join("[redacted]")),
    message,
  );
}

export class OAuthBroker {
  readonly #deps: OAuthBrokerDependencies;
  readonly #refreshing = new Map<string, Promise<string>>();
  /** Bumped by a sign-out: a refresh begun before it never writes its token back. */
  readonly #signOuts = new Map<string, number>();

  constructor(deps: OAuthBrokerDependencies) {
    this.#deps = deps;
  }

  /**
   * Marks a signed-in connection needs-consent when its token was not granted the mail access its opt-ins now ask for
   * (its mailbox turned on, say), so its account asks for the sign-in at once instead of at its first call. True
   * when it was marked.
   */
  async markMailConsentMissing(connection: { readonly connectionId: string; readonly providerId: string }): Promise<boolean> {
    const descriptor = this.#deps.descriptorOf(connection.providerId);
    const spec = descriptor === undefined ? undefined : oauthSpecOf(descriptor);
    if (spec === undefined) return false;
    const token = await readToken(this.#deps.dataDirectory, connection.connectionId);
    if (token === undefined) return false;
    const mail = (await this.#deps.optInsOf?.(connection.connectionId))?.mail === true;
    if (!requiredScopes(spec, { mail }).some((scope) => !token.scopes.includes(scope))) return false;
    await this.#deps.setAuthState(connection.connectionId, "needs-consent");
    return true;
  }

  /** A connection's access token, refreshed when it is about to expire. */
  async accessToken(connection: { readonly connectionId: string; readonly providerId: string }): Promise<string> {
    const signOuts = this.#signOuts.get(connection.connectionId) ?? 0;
    const descriptor = this.#deps.descriptorOf(connection.providerId);
    const spec = descriptor === undefined ? undefined : oauthSpecOf(descriptor);
    if (descriptor === undefined || spec === undefined)
      throw refusedEarly("NOT_CONFIGURED", `Connection ${connection.connectionId} does not sign in with OAuth`);
    const token = await readToken(this.#deps.dataDirectory, connection.connectionId);
    if (token === undefined)
      throw refusedEarly("NOT_CONFIGURED", `${descriptor.label} is not connected: connect it in Settings → Channels`, {
        signIn: true,
        connectionId: connection.connectionId,
      });
    // Asked for more than it was granted: used as it is, and the operator asked to allow the rest.
    // The channel's own access (its mail, while it takes mail in): a calendar its token was not granted is asked for by its own tools.
    const mail = (await this.#deps.optInsOf?.(connection.connectionId))?.mail === true;
    const missing = requiredScopes(spec, { mail }).filter((scope) => !token.scopes.includes(scope));
    if (missing.length > 0) await this.#deps.setAuthState(connection.connectionId, "needs-consent");
    const expiresAt = token.expiresAt === undefined ? undefined : Date.parse(token.expiresAt);
    if (expiresAt === undefined || expiresAt - REFRESH_AHEAD_MS > this.#deps.now()) return token.accessToken;
    // One refresh at a time per connection: every caller waiting gets its result.
    const running = this.#refreshing.get(connection.connectionId);
    if (running !== undefined) return running;
    const refresh = this.#refresh(connection.connectionId, descriptor, token, signOuts).finally(() =>
      this.#refreshing.delete(connection.connectionId),
    );
    this.#refreshing.set(connection.connectionId, refresh);
    return refresh;
  }

  async #refresh(connectionId: string, descriptor: ChannelDescriptor, read: OAuthTokenSecret, signOuts: number): Promise<string> {
    const spec = oauthSpecOf(descriptor);
    if (spec === undefined) throw refusedEarly("NOT_CONFIGURED", `${descriptor.label} does not sign in with OAuth`);
    // Read again: a refresh that finished since the caller read it left a fresh token, and a rotated refresh token
    // the old one would now be refused for.
    const token = (await readToken(this.#deps.dataDirectory, connectionId)) ?? read;
    const expiresAt = token.expiresAt === undefined ? undefined : Date.parse(token.expiresAt);
    if (expiresAt === undefined || expiresAt - REFRESH_AHEAD_MS > this.#deps.now()) return token.accessToken;
    if (token.refreshToken === undefined) {
      await this.#deps.setAuthState(connectionId, "expired");
      // Marked as a sign-in, so a mailbox tool's chat shows the Connect card.
      throw refusedEarly("NOT_CONFIGURED", `${descriptor.label}'s sign-in expired: reconnect it in Settings → Channels`, {
        signIn: true,
        connectionId,
      });
    }
    const client = await oauthClientOf(this.#deps.dataDirectory, descriptor, spec);
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    withClientAuth(spec, client, body, headers);
    const secrets = [token.refreshToken, token.accessToken, client.clientSecret];
    let response: Response;
    let answer: Record<string, unknown>;
    try {
      response = await this.#deps.fetch(spec.tokenUrl, {
        method: "POST",
        headers,
        body: body.toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      // A body that is not JSON reads as an empty answer, checked below like any unexpected one.
      const parsed: unknown = await readJsonBody(response).catch(() => undefined);
      answer = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch (error) {
      // A network failure is not the provider's refusal: the sign-in stands, and the next call tries again.
      throw new TaviError("UNAVAILABLE", redacted(`${descriptor.label}'s token could not be refreshed: ${errorMessage(error)}`, secrets));
    }
    if (!response.ok) {
      // Refused for good: the grant is gone, or the OAuth app it was made with no longer is.
      if (answer["error"] === "invalid_grant" || answer["error"] === "invalid_client" || answer["error"] === "unauthorized_client") {
        // Refused for good: the connection stops, and the operator is asked to reconnect. Never retried in a loop.
        await this.#deps.setAuthState(connectionId, "expired");
        throw keyedError(
          "NOT_CONFIGURED",
          "error.oauth.revoked",
          { channel: descriptor.label },
          { details: { signIn: true, connectionId } },
        );
      }
      throw new TaviError(
        "UNAVAILABLE",
        redacted(
          `${descriptor.label}'s token could not be refreshed: HTTP ${response.status}${typeof answer["error"] === "string" ? ` ${answer["error"].slice(0, 100)}` : ""}`,
          secrets,
        ),
      );
    }
    const accessToken = answer["access_token"];
    if (typeof accessToken !== "string" || accessToken === "")
      throw new TaviError("UNAVAILABLE", `${descriptor.label} answered a refresh without an access token`);
    const refreshToken = answer["refresh_token"];
    const expiresIn = answer["expires_in"];
    const scope = answer["scope"];
    const next: OAuthTokenSecret = {
      accessToken,
      // A rotated refresh token replaces the old one; none sent keeps it.
      refreshToken: typeof refreshToken === "string" && refreshToken !== "" ? refreshToken : token.refreshToken,
      ...(typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? { expiresAt: new Date(this.#deps.now() + expiresIn * 1000).toISOString() }
        : {}),
      scopes: typeof scope === "string" ? scope.split(/[\s,]+/).filter((entry) => entry !== "") : token.scopes,
      tokenType: token.tokenType,
    };
    let current: OAuthTokenSecret | undefined;
    await serializeCredentialAction(this.#deps.dataDirectory, async () => {
      // Signed out meanwhile: the new token is not kept.
      if ((this.#signOuts.get(connectionId) ?? 0) !== signOuts) return;
      // Signed in again meanwhile (another account, other scopes): that sign-in's token stands, never this one over it.
      const stored = await readToken(this.#deps.dataDirectory, connectionId);
      if (stored !== undefined && stored.refreshToken !== token.refreshToken) {
        current = stored;
        return;
      }
      await createLocalCredentialStore(this.#deps.dataDirectory).setSecret(oauthTokenRef(connectionId), JSON.stringify(next));
    });
    if ((this.#signOuts.get(connectionId) ?? 0) !== signOuts) throw new TaviError("NOT_CONFIGURED", `${descriptor.label} was signed out`);
    return current?.accessToken ?? accessToken;
  }

  /**
   * Signs a connection out: the provider's revocation endpoint is told
   * when the channel names one, and the token is deleted either way.
   * `upstream: false`: the token is deleted here only, the provider's grant
   * left for another app of it. A token is its client's,
   * so `client` names the one it was made with when that is no longer the one in force.
   */
  async revoke(
    connection: { readonly connectionId: string; readonly providerId: string },
    options: { readonly upstream?: boolean; readonly client?: { readonly clientId: string; readonly clientSecret?: string } } = {},
  ): Promise<void> {
    // A refresh still running, or begun before this, never writes its token back after this deletes it.
    this.#signOuts.set(connection.connectionId, (this.#signOuts.get(connection.connectionId) ?? 0) + 1);
    const descriptor = this.#deps.descriptorOf(connection.providerId);
    const spec = descriptor === undefined ? undefined : oauthSpecOf(descriptor);
    const token = await readToken(this.#deps.dataDirectory, connection.connectionId);
    if (options.upstream !== false && spec?.revokeUrl !== undefined && token !== undefined && descriptor !== undefined) {
      try {
        const client = options.client ?? (await oauthClientOf(this.#deps.dataDirectory, descriptor, spec));
        const body = new URLSearchParams({ token: token.refreshToken ?? token.accessToken });
        const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
        withClientAuth(spec, client, body, headers);
        await this.#deps.fetch(spec.revokeUrl, {
          method: "POST",
          headers,
          body: body.toString(),
          signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });
      } catch {
        // Best effort: the token is deleted here whatever the provider did.
      }
    }
    await deleteOAuthToken(this.#deps.dataDirectory, connection.connectionId);
  }
}

/** Deletes a connection's OAuth token from the credential store. */
async function deleteOAuthToken(dataDirectory: string, connectionId: string): Promise<void> {
  await serializeCredentialAction(dataDirectory, async () => {
    await createLocalCredentialStore(dataDirectory).deleteSecret(oauthTokenRef(connectionId));
  });
}

/** A credential reference no connector may read itself: an OAuth app's, or any connection's sign-in token. */
export function isSignInSecret(reference: string): boolean {
  return (
    reference.startsWith("channels.oauth-client.") ||
    reference.startsWith("channels.plugin-client.") ||
    /^channels\.[^.]+\.oauth$/.test(reference)
  );
}
