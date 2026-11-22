import { randomUUID } from "node:crypto";

import { keyedError, TaviError, type ChannelDescriptor, type OAuth2Spec, englishOf, navPath } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { securityHeaders } from "@tavi/node-kit";

import { readJsonBody } from "../../shared/json-body.js";
import { SERVED_PAGE_STYLE, SERVED_PAGE_STYLE_SRC } from "../../shared/served-page-css.js";
import {
  oauthClientOf,
  oauthSpecOf,
  requiredScopes,
  sharedProviderOf,
  signsInByCode,
  withClientAuth,
  type OAuthOptIns,
} from "../channels/oauth.js";
import { channelSecretRef } from "../channels/settings.js";
import { createLocalCredentialStore, serializeCredentialAction } from "../credentials/store.js";
import { pastedCallback, providerRefusal } from "./core.js";
import { pkceChallenge, randomToken } from "./pkce.js";

/**
 * The host's OAuth authorization-code flow with PKCE, the same for every
 * OAuth channel. A plugin only
 * declares its `OAuth2Spec`; it never sees a code, a token or the client.
 *
 * A flow's `state` and PKCE verifier live in memory only, for ten minutes,
 * and are used once. The provider sends the browser back to a callback that
 * has no session cookie to go on (the bridge's is `SameSite=Strict`), so the
 * callback is authenticated by the state alone — unguessable, single use,
 * short-lived, and made for an operator's authenticated request — and the page
 * that started it confirms through its own authenticated `oauth-status`.
 */

export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
/** Flows started and not yet ended, at most: a bound on what abandoned popups leave behind. */
const MAX_FLOWS = 50;
/** The longest an outage lengthens a device flow's wait between asks, so a code entered meanwhile is noticed within a minute. */
const DEVICE_INTERVAL_MAX_S = 60;

/** Five seconds more after an outage, up to `DEVICE_INTERVAL_MAX_S`; a wait the provider already made longer stays. */
const outageBackOff = (interval: number): number => Math.max(interval, Math.min(DEVICE_INTERVAL_MAX_S, interval + 5));
const TOKEN_TIMEOUT_MS = 30_000;

/** The token secret `channels.<connection>.oauth`: never shown, never given to a plugin. */
export interface OAuthTokenSecret {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scopes: readonly string[];
  readonly tokenType: string;
}

/**
 * The account a connection is bound to, which signing it in again must be: while it holds a sign-in, and while it
 * is `expired` even without its token — a client change drops the token and marks it so, and it is still that
 * account's connection, with that account's people and threads. Only Disconnect (`revoked`) frees it for another.
 */
export function boundAccountOf(record: {
  readonly authState: string;
  readonly accountIdentity: string;
  readonly credentialRefs: Readonly<Record<string, string>>;
}): string | undefined {
  if (record.accountIdentity === "") return undefined;
  if (record.authState === "expired") return record.accountIdentity;
  return record.credentialRefs["oauth"] !== undefined && ["connected", "needs-consent"].includes(record.authState)
    ? record.accountIdentity
    : undefined;
}

export function oauthTokenRef(connectionId: string): string {
  return channelSecretRef(connectionId, "oauth");
}

export type OAuthFlowState = "pending" | "connected" | "failed";

interface Flow {
  readonly flowId: string;
  /** A sign-in by code (RFC 8628): its device code (a secret, never shown) and how often to ask. No `state` comes back for it. */
  readonly device?: {
    readonly deviceCode: string;
    readonly userCode: string;
    readonly verificationUri: string;
    interval: number;
    claimed?: true;
  };
  readonly state: string;
  readonly verifier: string;
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly providerId: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
  outcome?: { readonly state: "connected"; readonly accountIdentity: string } | { readonly state: "failed"; readonly detail: string };
}

export interface OAuthFlowDependencies {
  readonly dataDirectory: string;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly descriptorOf: (providerId: string) => ChannelDescriptor | undefined;
  /** What a connection turned on that asks for more access (its calendar); absent, nothing. */
  readonly optInsOf?: (connectionId: string) => Promise<OAuthOptIns>;
  /** Records the connected account on its connection and opens it; false when the connection is gone. */
  readonly connected: (input: {
    readonly connectionId: string;
    readonly workspaceId: string;
    readonly accountIdentity: string;
    readonly tokenRef: string;
  }) => Promise<boolean>;
  /**
   * The account a connection is signed in as, while it has a sign-in (connected, needing consent, or expired):
   * signing it in again must be the same account. Absent when it never was, or was signed out.
   */
  readonly signedInAccount?: (connectionId: string) => Promise<string | undefined>;
  /** A sign-in through the public address started or ended: whether the ingress listens follows it. */
  readonly onPublicFlowsChanged?: () => void;
}

/** A request the provider must answer within `timeoutMs`. */
function fetchWithin(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** A body as JSON, or `undefined` for one that is not (a proxy's HTML page). */
async function readJson(response: Response): Promise<unknown> {
  // A body that is not JSON reads as none: the caller checks the shape it needs.
  return readJsonBody(response).catch(() => undefined);
}

/** The headers of a form POST to the provider, the client's authentication added to them or to `body`. */
function clientAuthHeaders(spec: OAuth2Spec, client: Parameters<typeof withClientAuth>[1], body: URLSearchParams): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  withClientAuth(spec, client, body, headers);
  return headers;
}

/** A form POST the provider must answer within the token timeout: its status, and its body as JSON. */
async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  body: URLSearchParams,
  headers: Record<string, string>,
): Promise<{ readonly ok: boolean; readonly status: number; readonly answer: unknown }> {
  const response = await fetchWithin(fetchImpl, url, { method: "POST", headers, body: body.toString() }, TOKEN_TIMEOUT_MS);
  return { ok: response.ok, status: response.status, answer: await readJson(response) };
}

/** `message` with every one of `secrets` cut out, so no code, verifier or client secret reaches a page or a log. */
function redacted(message: string, secrets: readonly (string | undefined)[]): string {
  return secrets.reduce<string>(
    (text, secret) => (secret === undefined || secret === "" ? text : text.split(secret).join("[redacted]")),
    message,
  );
}

/** A flow that comes back through the public address, not a loopback one. */
function isPublic(flow: Flow): boolean {
  return flow.redirectUri.startsWith("https://");
}

export class OAuthFlows {
  readonly #deps: OAuthFlowDependencies;
  readonly #byState = new Map<string, Flow>();
  readonly #byId = new Map<string, Flow>();

  constructor(deps: OAuthFlowDependencies) {
    this.#deps = deps;
  }

  /** A new flow for a connection: the URL to open, and the id the page asks after it by. */
  async start(input: {
    readonly connectionId: string;
    readonly workspaceId: string;
    readonly providerId: string;
    readonly redirectUri: string;
  }): Promise<{ readonly flowId: string; readonly authorizeUrl: string }> {
    const descriptor = this.#deps.descriptorOf(input.providerId);
    const spec = descriptor === undefined ? undefined : oauthSpecOf(descriptor);
    if (descriptor === undefined || spec === undefined)
      throw keyedError("INVALID_INPUT", "error.oauth.notOAuth", { channel: descriptor?.label ?? input.providerId });
    const client = await oauthClientOf(this.#deps.dataDirectory, descriptor, spec);
    this.#sweep();
    if (this.#byId.size >= MAX_FLOWS) throw keyedError("UNAVAILABLE", "error.oauth.tooManyFlows");
    const flow: Flow = {
      flowId: randomUUID(),
      state: randomToken(32),
      verifier: randomToken(32),
      connectionId: input.connectionId,
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      redirectUri: input.redirectUri,
      expiresAt: this.#deps.now() + OAUTH_FLOW_TTL_MS,
    };
    this.#byState.set(flow.state, flow);
    this.#byId.set(flow.flowId, flow);
    if (isPublic(flow)) {
      // When it lapses unanswered, the listener it kept open may close.
      const timer = setTimeout(() => this.#deps.onPublicFlowsChanged?.(), OAUTH_FLOW_TTL_MS + 1000);
      timer.unref?.();
    }
    const url = new URL(spec.authorizeUrl);
    // The channel's own parameters first: none of them can stand in for the host's below.
    for (const [key, value] of Object.entries(spec.extraAuthorizeParams ?? {})) url.searchParams.set(key, value);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", flow.redirectUri);
    const scopes = await this.#scopesOf(input.connectionId, spec);
    if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", flow.state);
    url.searchParams.set("code_challenge", pkceChallenge(flow.verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { flowId: flow.flowId, authorizeUrl: url.toString() };
  }

  /**
   * A sign-in by code (RFC 8628), for a channel that declares a device authorization
   * address: the code to show, and the address to enter it at on any device. The owner then asks the provider
   * for the token every `interval` seconds until it is allowed, refused or the code lapses; the page follows it
   * through `status`, as it does a redirect's. Nothing comes back to a redirect, so no `state` is kept.
   */
  async startDevice(input: { readonly connectionId: string; readonly workspaceId: string; readonly providerId: string }): Promise<{
    readonly flowId: string;
    readonly userCode: string;
    readonly verificationUri: string;
    readonly verificationUriComplete?: string;
    readonly expiresAt: string;
  }> {
    const descriptor = this.#deps.descriptorOf(input.providerId);
    const spec = descriptor === undefined ? undefined : oauthSpecOf(descriptor);
    if (descriptor === undefined || spec === undefined)
      throw keyedError("INVALID_INPUT", "error.oauth.notOAuth", { channel: descriptor?.label ?? input.providerId });
    if (spec.deviceAuthorizationUrl === undefined || !signsInByCode(descriptor))
      throw keyedError("UNSUPPORTED", "error.oauth.noCode", { channel: descriptor.label });
    const client = await oauthClientOf(this.#deps.dataDirectory, descriptor, spec);
    this.#sweep();
    if (this.#byId.size >= MAX_FLOWS) throw keyedError("UNAVAILABLE", "error.oauth.tooManyFlows");
    const scopes = await this.#scopesOf(input.connectionId, spec);
    const body = new URLSearchParams(scopes.length > 0 ? { scope: scopes.join(" ") } : {});
    const headers = clientAuthHeaders(spec, client, body);
    let answer: unknown;
    try {
      const response = await postForm(this.#deps.fetch, spec.deviceAuthorizationUrl, body, headers);
      answer = response.answer;
      if (!response.ok)
        throw new TaviError("UNAVAILABLE", `The provider did not give a sign-in code: ${errorOf(answer, response.status).slice(0, 200)}`);
    } catch (error) {
      throw new TaviError(TaviError.from(error).code, redacted(errorMessage(error), [client.clientSecret]));
    }
    const code = deviceCodeOf(answer);
    const flow: Flow = {
      flowId: randomUUID(),
      state: randomToken(32),
      verifier: "",
      connectionId: input.connectionId,
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      redirectUri: "",
      // The provider's lifetime for the code, never longer than a redirect's sign-in waits.
      expiresAt: this.#deps.now() + Math.min(code.expiresIn * 1000, OAUTH_FLOW_TTL_MS),
      device: { deviceCode: code.deviceCode, userCode: code.userCode, verificationUri: code.verificationUri, interval: code.interval },
    };
    this.#byId.set(flow.flowId, flow);
    this.#poll(flow);
    return {
      flowId: flow.flowId,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      ...(code.verificationUriComplete === undefined ? {} : { verificationUriComplete: code.verificationUriComplete }),
      expiresAt: new Date(flow.expiresAt).toISOString(),
    };
  }

  /** Asks for a device flow's token after its interval, again until it ends (RFC 8628 §3.4–3.5). */
  #poll(flow: Flow): void {
    const device = flow.device;
    if (device === undefined) return;
    const timer = setTimeout(() => void this.#askDevice(flow, device), device.interval * 1000);
    timer.unref?.();
  }

  async #askDevice(flow: Flow, device: NonNullable<Flow["device"]>): Promise<void> {
    if (flow.outcome !== undefined) return;
    if (this.#deps.now() >= flow.expiresAt) {
      flow.outcome = { state: "failed", detail: "The sign-in code expired before it was entered: start again." };
      return;
    }
    try {
      const { descriptor, spec } = this.#channelOf(flow);
      const client = await oauthClientOf(this.#deps.dataDirectory, descriptor, spec);
      const body = new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: device.deviceCode });
      const headers = clientAuthHeaders(spec, client, body);
      let answer: unknown;
      try {
        const response = await postForm(this.#deps.fetch, spec.tokenUrl, body, headers);
        answer = response.answer;
        if (!response.ok) {
          const error = errorOf(answer, response.status);
          // Not entered yet, asked too often, or the provider briefly unwell: ask again later — five seconds
          // later for a slow_down (RFC 8628 §3.5), and for a server error too, so a passing outage does not end it.
          if (error === "authorization_pending" || error === "slow_down" || response.status >= 500) {
            // A slow_down adds five seconds every time (RFC 8628 §3.5); an outage's own back-off stops at a minute.
            if (error === "slow_down") device.interval += 5;
            else if (error !== "authorization_pending") device.interval = outageBackOff(device.interval);
            if (flow.outcome === undefined) this.#poll(flow);
            return;
          }
          throw new TaviError(
            error === "access_denied" ? "NOT_AUTHORIZED" : "UNAVAILABLE",
            error === "access_denied"
              ? "The sign-in was not allowed."
              : error === "expired_token"
                ? "The sign-in code expired before it was entered: start again."
                : `The provider refused the sign-in: ${error.slice(0, 200)}`,
          );
        }
      } catch (error) {
        // No answer at all (a timeout, a dropped connection): ask again later, as for a server error.
        if (!(error instanceof TaviError)) {
          device.interval = outageBackOff(device.interval);
          if (flow.outcome === undefined) this.#poll(flow);
          return;
        }
        throw new TaviError(error.code, redacted(error.message, [client.clientSecret, device.deviceCode]));
      }
      // Cancelled, or lapsed, while the provider answered: nothing is kept.
      if (flow.outcome !== undefined) return;
      if (this.#deps.now() >= flow.expiresAt) {
        flow.outcome = { state: "failed", detail: "The sign-in code expired before it was entered: start again." };
        return;
      }
      // Claimed: from here a cancel is refused, so the page is never told "cancelled" of a sign-in that was kept.
      device.claimed = true;
      const accountIdentity = await this.#keep(flow, descriptor, spec, answer);
      flow.outcome = { state: "connected", accountIdentity };
    } catch (error) {
      if (flow.outcome === undefined) flow.outcome = { state: "failed", detail: errorMessage(error) };
    }
  }

  /** How a flow of `workspaceId`'s stands; `undefined` for another workspace's or one long gone. */
  status(
    flowId: string,
    workspaceId: string,
  ):
    | {
        readonly state: OAuthFlowState | "expired";
        readonly connectionId: string;
        readonly accountIdentity?: string;
        readonly detail?: string;
      }
    | undefined {
    const flow = this.#byId.get(flowId);
    if (flow === undefined || flow.workspaceId !== workspaceId) return undefined;
    if (flow.outcome !== undefined) return { connectionId: flow.connectionId, ...flow.outcome };
    return { state: this.#deps.now() >= flow.expiresAt ? "expired" : "pending", connectionId: flow.connectionId };
  }

  /** Paste-back: a flow of `workspaceId`'s finished from the address its browser landed on. */
  async finish(flowId: string, workspaceId: string, address: string): Promise<{ readonly ok: boolean; readonly message: string }> {
    const flow = this.#byId.get(flowId);
    if (flow === undefined || flow.workspaceId !== workspaceId || flow.outcome !== undefined || !this.#byState.has(flow.state))
      return { ok: false, message: "This sign-in is no longer waiting: start it again." };
    const pasted = pastedCallback(address, { redirect: flow.redirectUri, state: flow.state });
    return pasted.ok ? await this.callback(pasted.input) : pasted;
  }

  /**
   * Ends a flow of `workspaceId`'s that is still waiting: its state is forgotten, so a
   * browser that comes back later signs nothing in. False for one that already ended or is not this workspace's.
   */
  cancel(flowId: string, workspaceId: string): boolean {
    const flow = this.#byId.get(flowId);
    // A device flow has no state to forget: its outcome alone stops its asking.
    // One whose token is being kept is past cancelling, as a code flow's callback is.
    if (
      flow === undefined ||
      flow.workspaceId !== workspaceId ||
      flow.outcome !== undefined ||
      flow.device?.claimed === true ||
      (flow.device === undefined && !this.#byState.delete(flow.state))
    )
      return false;
    flow.outcome = { state: "failed", detail: "The sign-in was cancelled." };
    // The public listener stays open only while a public flow waits.
    if (isPublic(flow)) this.#deps.onPublicFlowsChanged?.();
    return true;
  }

  /** Whether a sign-in in progress has this state (the callback router's question). */
  owns(state: string): boolean {
    return this.#byState.has(state);
  }

  /**
   * The provider's redirect back: the state names the flow, once. The code is
   * exchanged with the verifier, the account named, the tokens stored and the
   * connection opened. Answers only what the callback page may say.
   */
  async callback(input: {
    readonly state: string;
    readonly code?: string;
    readonly error?: string;
    readonly iss?: string;
  }): Promise<{ readonly ok: boolean; readonly message: string }> {
    const flow = this.#byState.get(input.state);
    // Used once: gone before anything is awaited, so a replay of the redirect finds nothing.
    this.#byState.delete(input.state);
    if (flow === undefined || this.#deps.now() >= flow.expiresAt)
      return {
        ok: false,
        message: `This sign-in link is no longer valid. Start again from ${englishOf(navPath("nav.route.settings", "nav.settings.channels"))}.`,
      };
    try {
      return await this.#answer(flow, input);
    } finally {
      if (isPublic(flow)) this.#deps.onPublicFlowsChanged?.();
    }
  }

  async #answer(
    flow: Flow,
    input: { readonly code?: string; readonly error?: string; readonly iss?: string },
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    const fail = (detail: string): { readonly ok: false; readonly message: string } => {
      flow.outcome = { state: "failed", detail };
      return { ok: false, message: detail };
    };
    const descriptor = this.#deps.descriptorOf(flow.providerId);
    const refused = {
      provider: descriptor?.app?.publisher ?? "The provider",
      redirect: flow.redirectUri,
      // A provider's shared client is a Desktop app client (Google's): its fixes name that kind of client.
      desktopClient: sharedProviderOf(flow.providerId) !== undefined,
    };
    // RFC 9207: a provider that names itself in its redirect must name itself, or the answer came from another one.
    const issuer = descriptor === undefined ? undefined : oauthSpecOf(descriptor)?.issuer;
    if (issuer !== undefined && input.iss !== issuer)
      return fail(`${refused.provider} did not answer this sign-in: the redirect names another issuer. Nothing was connected.`);
    if (input.error !== undefined) return fail(providerRefusal(input.error, refused));
    if (input.code === undefined || input.code === "") return fail("The provider sent no authorization code.");
    try {
      const accountIdentity = await this.#complete(flow, input.code);
      flow.outcome = { state: "connected", accountIdentity };
      return { ok: true, message: `Connected as ${accountIdentity}.` };
    } catch (error) {
      const message = errorMessage(error);
      // The token endpoint names a redirect the client does not list, or a client it does not know, as the callback would.
      return fail(/redirect_uri_mismatch|invalid_client|unauthorized_client/.test(message) ? providerRefusal(message, refused) : message);
    }
  }

  async #complete(flow: Flow, code: string): Promise<string> {
    const { descriptor, spec } = this.#channelOf(flow);
    const client = await oauthClientOf(this.#deps.dataDirectory, descriptor, spec);
    const secrets = [client.clientSecret, code, flow.verifier];
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
    const headers = clientAuthHeaders(spec, client, body);
    let answer: unknown;
    try {
      const response = await postForm(this.#deps.fetch, spec.tokenUrl, body, headers);
      answer = response.answer;
      if (!response.ok)
        throw new TaviError("UNAVAILABLE", `The provider refused the sign-in: ${errorOf(answer, response.status).slice(0, 200)}`);
    } catch (error) {
      throw new TaviError(TaviError.from(error).code, redacted(errorMessage(error), secrets));
    }
    return await this.#keep(flow, descriptor, spec, answer);
  }

  /** Every scope a connection's sign-in asks for: the channel's, and those of what it turned on. */
  async #scopesOf(connectionId: string, spec: OAuth2Spec): Promise<readonly string[]> {
    return requiredScopes(spec, (await this.#deps.optInsOf?.(connectionId)) ?? {});
  }

  /** The channel a flow signs in to, while it is installed and still signs in with OAuth. */
  #channelOf(flow: Flow): { readonly descriptor: ChannelDescriptor; readonly spec: OAuth2Spec } {
    const descriptor = this.#deps.descriptorOf(flow.providerId);
    const spec = descriptor === undefined ? undefined : oauthSpecOf(descriptor);
    if (descriptor === undefined || spec === undefined) throw keyedError("NOT_FOUND", "error.oauth.channelGone");
    return { descriptor, spec };
  }

  /** A token the provider answered, kept only once it allowed everything, named its account and is that connection's. */
  async #keep(flow: Flow, descriptor: ChannelDescriptor, spec: OAuth2Spec, answer: unknown): Promise<string> {
    const token = tokenOf(answer, this.#deps.now(), spec);
    // Every access the channel asks for: one signed in with less cannot do its work, so it is not kept.
    const refused = (await this.#scopesOf(flow.connectionId, spec)).filter((scope) => !token.scopes.includes(scope));
    if (refused.length > 0)
      throw keyedError("NOT_AUTHORIZED", "error.oauth.scopesRefused", { scopes: refused.join(", "), channel: descriptor.label });
    // The account it signed in as, when the channel can name it: one it cannot is not taken on trust.
    const named = await this.#accountOf(spec, token.accessToken);
    if (spec.accountIdentity !== undefined && named === undefined)
      throw keyedError("UNAVAILABLE", "error.oauth.noAccountNamed", { channel: descriptor.label });
    const accountIdentity = named ?? descriptor.label;
    // Signing in again is the same account: another one's mailbox under this connection's people and threads is refused.
    const previous = await this.#deps.signedInAccount?.(flow.connectionId);
    if (previous !== undefined && named !== undefined && previous.toLowerCase() !== named.toLowerCase()) {
      throw keyedError("CONFLICT", "error.oauth.otherAccount", { named, previous });
    }
    const tokenRef = oauthTokenRef(flow.connectionId);
    await serializeCredentialAction(this.#deps.dataDirectory, async () => {
      await createLocalCredentialStore(this.#deps.dataDirectory).setSecret(tokenRef, JSON.stringify(token));
    });
    if (!(await this.#deps.connected({ connectionId: flow.connectionId, workspaceId: flow.workspaceId, accountIdentity, tokenRef }))) {
      // Removed while it signed in: its token goes too, never left behind.
      await serializeCredentialAction(this.#deps.dataDirectory, async () => {
        await createLocalCredentialStore(this.#deps.dataDirectory).deleteSecret(tokenRef);
      });
      throw keyedError("NOT_FOUND", "error.oauth.connectionRemoved");
    }
    return accountIdentity;
  }

  /** Who connected, from the provider's userinfo endpoint when the descriptor names one. */
  async #accountOf(spec: OAuth2Spec, accessToken: string): Promise<string | undefined> {
    if (spec.accountIdentity === undefined) return undefined;
    try {
      const response = await fetchWithin(
        this.#deps.fetch,
        spec.accountIdentity.userinfoUrl,
        { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
        TOKEN_TIMEOUT_MS,
      );
      const info = await readJson(response);
      const value =
        response.ok && typeof info === "object" && info !== null
          ? (info as Record<string, unknown>)[spec.accountIdentity.field]
          : undefined;
      return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 320) : undefined;
    } catch {
      // Connected all the same: the account is named by the channel until it says.
      return undefined;
    }
  }

  /** Whether a sign-in is waiting to come back through the public address: the ingress listens for it. */
  waitingPublic(): boolean {
    const now = this.#deps.now();
    return [...this.#byState.values()].some((flow) => flow.expiresAt > now && isPublic(flow));
  }

  /** Forgets flows ended or expired a while ago. */
  #sweep(): void {
    const stale = this.#deps.now() - OAUTH_FLOW_TTL_MS;
    for (const [flowId, flow] of this.#byId) {
      if (flow.expiresAt > stale) continue;
      this.#byId.delete(flowId);
      this.#byState.delete(flow.state);
    }
  }
}

/** RFC 8628 §3.4's grant type. */
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** An OAuth error answer's `error`, else the status. */
function errorOf(answer: unknown, status: number): string {
  return typeof answer === "object" && answer !== null && typeof (answer as { error?: unknown }).error === "string"
    ? (answer as { error: string }).error
    : `HTTP ${status}`;
}

/**
 * A device authorization answer (RFC 8628 §3.2), checked: a code to show, an https address to enter it at
 * (`verification_url`, an older name, is read too), its lifetime and how often to ask, at least five seconds.
 */
function deviceCodeOf(answer: unknown): {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval: number;
} {
  const body = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
  const text = (key: string, max: number): string | undefined =>
    typeof body[key] === "string" && body[key] !== "" && (body[key] as string).length <= max ? (body[key] as string) : undefined;
  const deviceCode = text("device_code", 4096);
  const userCode = text("user_code", 64);
  const verificationUri = text("verification_uri", 2048) ?? text("verification_url", 2048);
  const complete = text("verification_uri_complete", 2048);
  const origin = verificationUri === undefined ? undefined : httpsOrigin(verificationUri);
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined || origin === undefined) {
    throw new TaviError(
      "UNAVAILABLE",
      "The provider's sign-in code could not be used: it named no code or no https address to enter it at.",
    );
  }
  const seconds = (key: string, fallback: number): number =>
    typeof body[key] === "number" && Number.isFinite(body[key]) && (body[key] as number) > 0 ? (body[key] as number) : fallback;
  return {
    deviceCode,
    userCode,
    verificationUri,
    // The address with the code in it only on the same site as the one shown, so the link goes where it says.
    ...(complete === undefined || httpsOrigin(complete) !== origin ? {} : { verificationUriComplete: complete }),
    expiresIn: seconds("expires_in", OAUTH_FLOW_TTL_MS / 1000),
    // As often as the provider allows, never more than every five seconds (RFC 8628 §3.5).
    interval: Math.max(5, seconds("interval", 5)),
  };
}

/** An https address's origin; `undefined` for anything else, a loopback http one included. */
function httpsOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The page the provider's redirect lands on: static, no script,
 * no token or code in it — only whether it worked. The page that opened the
 * sign-in learns the outcome through its own `oauth-status`.
 */
export function oauthCallbackPage(outcome: { readonly ok: boolean; readonly message: string }): {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
} {
  const title = outcome.ok ? "Connected" : "Not connected";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>${SERVED_PAGE_STYLE}</head><body><h1>${title}</h1><p>${escapeHtml(outcome.message)}</p><p>You can close this window and go back to Tavi.</p></body></html>`;
  return {
    status: outcome.ok ? 200 : 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...securityHeaders(`default-src 'none'; style-src ${SERVED_PAGE_STYLE_SRC}`),
    },
    body,
  };
}

/** The token response as the stored secret; a response without an access token is refused. */
function tokenOf(answer: unknown, now: number, spec: OAuth2Spec): OAuthTokenSecret {
  const value = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
  const accessToken = value["access_token"];
  if (typeof accessToken !== "string" || accessToken === "")
    throw new TaviError("UNAVAILABLE", "The provider answered without an access token.");
  const refreshToken = value["refresh_token"];
  const expiresIn = value["expires_in"];
  const scope = value["scope"];
  const tokenType = value["token_type"];
  return {
    accessToken,
    ...(typeof refreshToken === "string" && refreshToken !== "" ? { refreshToken } : {}),
    ...(typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: new Date(now + expiresIn * 1000).toISOString() }
      : {}),
    // A provider that does not say which scopes it granted granted the ones asked for.
    scopes: typeof scope === "string" ? scope.split(/[\s,]+/).filter((entry) => entry !== "") : [...spec.scopes],
    tokenType: typeof tokenType === "string" && tokenType !== "" ? tokenType : "Bearer",
  };
}
