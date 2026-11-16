import {
  OAuthError,
  auth,
  computeScopeUnion,
  discoverOAuthServerInfo,
  refreshAuthorization,
  validateAuthorizationResponseIssuer,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import { TaviError } from "@tavi/contracts";
import { clip, definedOnly, errorMessage } from "@tavi/contracts/util";

import { cleanServerText } from "./results.js";
import {
  endpointProblem,
  pastedCallback,
  providerRefusal,
  type OAuthCallbackHandler,
  type OAuthCallbackInput,
  type OAuthCallbackOutcome,
} from "../oauth/core.js";
import { randomToken } from "../oauth/pkce.js";

/**
 * OAuth for MCP servers: an operator's
 * login (`tavi mcp login`, Settings) runs the SDK's authorization code flow
 * through Tavi's guarded fetch, with Tavi's own checks on top — PKCE S256 must
 * be advertised, every endpoint is https (or a loopback address), the issuer is
 * checked (never skipped), `client_name` is always `Tavi`, and `state` is
 * Tavi's and used once. The client is, in order: a pre-registered one from the
 * server's settings (`clientId`, credential `clientSecret`), CIMD (with a
 * public https address), DCR (`application_type` `native` for a loopback
 * redirect, `web` for a public one), or the login asks for a client id. The
 * grant is stored as one credential, `plugins.<id>.oauth`, keyed by issuer;
 * at run time its access token is sent as a Bearer header, refreshed once
 * (single-flight) a minute before it expires. A refused refresh makes the
 * server `login-required`, its notice naming the cause.
 */

/** The credential holding a server's grants. */
export const mcpOAuthRef = (pluginId: string): string => `plugins.${pluginId}.oauth`;

/** A login waits this long for its callback. */
const MCP_LOGIN_TTL_MS = 10 * 60 * 1000;
/** The most sign-ins kept at once, waiting or just settled, as a channel's are (`features/oauth/flow.ts`). */
export const MCP_LOGIN_MAX = 50;
/** A token is refreshed this long before it expires. */
const REFRESH_AHEAD_MS = 60 * 1000;
/**
 * A refusal this long after signing in is a provider's weekly sign-out (an app in Testing):
 * the server is then known to sign out every 7 days.
 */
const WEEKLY_LAPSE_MS = { from: 6.5 * 86_400_000, to: 7.5 * 86_400_000 } as const;

interface StoredTokens {
  readonly access_token: string;
  readonly token_type: string;
  readonly refresh_token?: string;
  readonly scope?: string;
  /** Epoch ms. */
  readonly expires_at?: number;
}

/** One authorization server's grant for a server. */
/** A logout's or a removal's revocation: whether the server held a grant, and whether its issuers confirmed revoking it. */
export interface McpRevocation {
  readonly hadGrant: boolean;
  readonly confirmed: boolean;
}

export interface McpGrant {
  readonly issuer: string;
  readonly authorizationServerUrl: string;
  readonly metadata?: AuthorizationServerMetadata;
  readonly resource: string;
  readonly client: OAuthClientInformationMixed;
  readonly tokens: StoredTokens;
  readonly signedInAt: string;
  /** The account it signed in as, from the id_token's `email`; absent when not asked for. */
  readonly identity?: string;
  /** Scopes asked for and not granted (granular consent): the account then needs more access. */
  readonly missingScopes?: readonly string[];
}

interface GrantFile {
  readonly grants: Readonly<Record<string, McpGrant>>;
  readonly latest?: string;
  /** Learned from a refusal 7 days after signing in: its sign-in lasts a week. Kept across sign-ins. */
  readonly weekly?: true;
  /** Scopes a refused call named (RFC 6750 `insufficient_scope`): the next sign-in asks for them too. */
  readonly wanted?: string;
}

export interface McpGrantStore {
  read(reference: string): Promise<string | null>;
  write(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

const parseGrants = (text: string | null): GrantFile => {
  if (text === null) return { grants: {} };
  try {
    const parsed = JSON.parse(text) as GrantFile;
    return typeof parsed === "object" && parsed !== null && typeof parsed.grants === "object" ? parsed : { grants: {} };
  } catch {
    return { grants: {} };
  }
};

const storedTokens = (tokens: OAuthTokens, now: number, previous?: StoredTokens): StoredTokens => ({
  access_token: tokens.access_token,
  token_type: tokens.token_type,
  // A rotated refresh token replaces the old one; none sent keeps it.
  ...((tokens.refresh_token ?? previous?.refresh_token) === undefined
    ? {}
    : { refresh_token: (tokens.refresh_token ?? previous?.refresh_token) as string }),
  ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
  ...(tokens.expires_in === undefined ? {} : { expires_at: now + tokens.expires_in * 1000 }),
});

/** The words a login notice gives for a refused refresh: Google's apps in *Testing* sign in for 7 days. */
export function loginCause(issuer: string, error: string): string {
  if (/accounts\.google\.com/.test(issuer))
    return `Google refused its sign-in (${error}): an OAuth app in Testing signs in for 7 days at a time; publish it, or sign in again each week`;
  return `the server no longer accepts its sign-in (${error})`;
}

/** A server that needs its operator to sign in (again): not a crash, so it is not backed off. */
export const loginRequired = (pluginId: string, cause: string): TaviError =>
  new TaviError("NOT_AUTHORIZED", `${pluginId} needs a login: ${cause}; \`tavi mcp login ${pluginId}\``, {
    details: { mcpFailure: "login", cause, pluginId },
  });

/** Run-time access tokens, one refresh at a time per server. */
export class McpOAuthTokens {
  readonly #store: McpGrantStore;
  readonly #fetchFor: (pluginId: string) => FetchLike;
  readonly #now: () => number;
  readonly #refreshing = new Map<string, Promise<string>>();
  /** Bumped by a logout: a refresh still running when it lands never writes its grant back. */
  readonly #generation = new Map<string, number>();

  constructor(options: { readonly store: McpGrantStore; readonly fetchFor: (pluginId: string) => FetchLike; readonly now?: () => number }) {
    this.#store = options.store;
    this.#fetchFor = options.fetchFor;
    this.#now = options.now ?? Date.now;
  }

  async #latest(pluginId: string): Promise<McpGrant | undefined> {
    const file = parseGrants(await this.#store.read(mcpOAuthRef(pluginId)));
    return file.latest === undefined ? undefined : file.grants[file.latest];
  }

  /**
   * Whether the server's grants name Tavi by its CIMD document: its authorization server may read that
   * document again — at a refresh — so the public listener stays open while one does.
   */
  async usesClientDocument(pluginId: string): Promise<boolean> {
    const file = parseGrants(await this.#store.read(mcpOAuthRef(pluginId)));
    return Object.values(file.grants).some((grant) => grant.client.client_id.endsWith(MCP_CLIENT_METADATA_PATH));
  }

  /** Whether the server has a grant at all. */
  async signedIn(pluginId: string): Promise<boolean> {
    return (await this.#latest(pluginId)) !== undefined;
  }

  /** What a page may know of the newest grant: who, when, and what consent left out; never a token. */
  async grant(pluginId: string): Promise<
    | {
        readonly identity?: string;
        readonly signedInAt: string;
        readonly missingScopes: readonly string[];
        readonly issuer: string;
        readonly learnedWeekly: boolean;
      }
    | undefined
  > {
    const file = parseGrants(await this.#store.read(mcpOAuthRef(pluginId)));
    const latest = file.latest === undefined ? undefined : file.grants[file.latest];
    if (latest === undefined) return undefined;
    return {
      signedInAt: latest.signedInAt,
      issuer: latest.issuer,
      missingScopes: latest.missingScopes ?? [],
      learnedWeekly: file.weekly === true,
      ...(latest.identity === undefined ? {} : { identity: latest.identity }),
    };
  }

  /** Notes the scopes a refused call named, for the next sign-in to ask for beside what it has. */
  async noteWantedScope(pluginId: string, scope: string): Promise<void> {
    const file = parseGrants(await this.#store.read(mcpOAuthRef(pluginId)));
    if (file.latest === undefined) return;
    const wanted = computeScopeUnion(file.wanted, scope);
    if (wanted === file.wanted) return;
    await this.#store.write(mcpOAuthRef(pluginId), JSON.stringify({ ...file, ...(wanted === undefined ? {} : { wanted }) }));
  }

  /** What a new sign-in must not lose: the scopes the newest grant holds, and those a refused call named. */
  async scopeToKeep(pluginId: string): Promise<string | undefined> {
    const file = parseGrants(await this.#store.read(mcpOAuthRef(pluginId)));
    const latest = file.latest === undefined ? undefined : file.grants[file.latest];
    return computeScopeUnion(latest?.tokens.scope, file.wanted);
  }

  /** The access token to send, refreshed first when it expires within a minute. */
  async accessToken(pluginId: string): Promise<string> {
    const grant = await this.#latest(pluginId);
    if (grant === undefined) throw loginRequired(pluginId, "it is not signed in");
    const expiresAt = grant.tokens.expires_at;
    if (expiresAt === undefined || expiresAt - REFRESH_AHEAD_MS > this.#now()) return grant.tokens.access_token;
    const running = this.#refreshing.get(pluginId);
    if (running !== undefined) return running;
    const refresh = this.#refresh(pluginId, grant, this.#generation.get(pluginId) ?? 0).finally(() => this.#refreshing.delete(pluginId));
    this.#refreshing.set(pluginId, refresh);
    return refresh;
  }

  async #refresh(pluginId: string, grant: McpGrant, generation: number): Promise<string> {
    const refreshToken = grant.tokens.refresh_token;
    if (refreshToken === undefined) throw loginRequired(pluginId, "its sign-in expired and gave no refresh token");
    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(grant.authorizationServerUrl, {
        ...(grant.metadata === undefined ? {} : { metadata: grant.metadata }),
        clientInformation: grant.client,
        refreshToken,
        resource: new URL(grant.resource),
        fetchFn: this.#fetchFor(pluginId),
      });
    } catch (error) {
      if (OAuthError.isInstance(error) && ["invalid_grant", "invalid_client", "unauthorized_client"].includes(error.code)) {
        if (error.code === "invalid_grant") await this.#noteWeeklyLapse(pluginId, grant);
        throw loginRequired(pluginId, loginCause(grant.issuer, error.code));
      }
      throw error;
    }
    if ((this.#generation.get(pluginId) ?? 0) !== generation) throw loginRequired(pluginId, "it was signed out");
    const file = parseGrants(await this.#store.read(mcpOAuthRef(pluginId)));
    const updated: McpGrant = { ...grant, tokens: storedTokens(tokens, this.#now(), grant.tokens) };
    await this.#store.write(mcpOAuthRef(pluginId), JSON.stringify({ ...file, grants: { ...file.grants, [grant.issuer]: updated } }));
    return updated.tokens.access_token;
  }

  /**
   * Revokes every grant the server holds, at each issuer that offers
   * revocation (RFC 7009, the client authenticated as at its token endpoint),
   * and deletes them: whether there was one, and whether every issuer
   * confirmed it (an issuer that offers no revocation, or refused, did not).
   * `upstream: false` forgets the grants here only: a Google revoke reaches
   * every client of the Cloud project, so it is left to the last app signed
   * in with that project and account.
   */
  async revoke(pluginId: string, options: { readonly upstream?: boolean } = {}): Promise<McpRevocation> {
    this.#generation.set(pluginId, (this.#generation.get(pluginId) ?? 0) + 1);
    const grants = Object.values(parseGrants(await this.#store.read(mcpOAuthRef(pluginId))).grants);
    let confirmed = grants.length > 0 && options.upstream !== false;
    for (const grant of options.upstream === false ? [] : grants) {
      const metadata = grant.metadata;
      const endpoint =
        metadata !== undefined && "revocation_endpoint" in metadata && typeof metadata.revocation_endpoint === "string"
          ? metadata.revocation_endpoint
          : undefined;
      if (endpoint === undefined || endpointProblem(endpoint, "revocation endpoint") !== undefined) {
        confirmed = false;
        continue;
      }
      const body = new URLSearchParams({
        token: grant.tokens.refresh_token ?? grant.tokens.access_token,
        token_type_hint: grant.tokens.refresh_token === undefined ? "access_token" : "refresh_token",
        client_id: grant.client.client_id,
      });
      if (grant.client.client_secret !== undefined) body.set("client_secret", grant.client.client_secret);
      // Best effort: revoking at the server; the local token is dropped whatever it answers.
      const answer = await this.#fetchFor(pluginId)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }).catch(() => undefined);
      // Best effort: the body is discarded; one already closed has nothing to cancel.
      await answer?.body?.cancel().catch(() => undefined);
      if (answer?.ok !== true) confirmed = false;
    }
    await this.#store.delete(mcpOAuthRef(pluginId));
    return { hadGrant: grants.length > 0, confirmed };
  }

  /** Stores a new grant, the server's latest. */
  async save(pluginId: string, grant: McpGrant): Promise<void> {
    const file = parseGrants(await this.#store.read(mcpOAuthRef(pluginId)));
    await this.#store.write(
      mcpOAuthRef(pluginId),
      JSON.stringify({
        grants: { ...file.grants, [grant.issuer]: grant },
        latest: grant.issuer,
        ...(file.weekly === true ? { weekly: true } : {}),
      }),
    );
  }

  /** A refused refresh between 6.5 and 7.5 days after signing in teaches that this server signs out weekly. */
  async #noteWeeklyLapse(pluginId: string, grant: McpGrant): Promise<void> {
    const age = this.#now() - Date.parse(grant.signedInAt);
    if (!(age >= WEEKLY_LAPSE_MS.from && age <= WEEKLY_LAPSE_MS.to)) return;
    const file = parseGrants(await this.#store.read(mcpOAuthRef(pluginId)));
    if (file.weekly === true || file.latest === undefined) return;
    await this.#store.write(mcpOAuthRef(pluginId), JSON.stringify({ ...file, weekly: true }));
  }
}

/** The SDK's view of one login: Tavi's client, state and checks, its results kept until the callback. */
class LoginProvider implements OAuthClientProvider {
  authorizeUrl: string | undefined;
  #client: OAuthClientInformationMixed | undefined;
  #tokens: OAuthTokens | undefined;
  #verifier: string | undefined;
  #discovery: OAuthDiscoveryState | undefined;
  readonly #redirect: string;
  readonly #state: string;
  readonly #applicationType: "native" | "web";
  readonly clientMetadataUrl?: string;

  readonly #authorizeParams: Readonly<Record<string, string>>;

  constructor(options: {
    readonly redirect: string;
    readonly state: string;
    readonly applicationType: "native" | "web";
    readonly client?: OAuthClientInformationMixed;
    readonly clientMetadataUrl?: string;
    readonly authorizeParams?: Readonly<Record<string, string>>;
  }) {
    this.#redirect = options.redirect;
    this.#authorizeParams = options.authorizeParams ?? {};
    this.#state = options.state;
    this.#applicationType = options.applicationType;
    this.#client = options.client;
    if (options.clientMetadataUrl !== undefined) this.clientMetadataUrl = options.clientMetadataUrl;
  }

  get redirectUrl(): string {
    return this.#redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Tavi",
      redirect_uris: [this.#redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.#client?.client_secret === undefined ? "none" : "client_secret_post",
      application_type: this.#applicationType,
    } as OAuthClientMetadata;
  }

  state(): string {
    return this.#state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.#client;
  }

  saveClientInformation(information: OAuthClientInformationMixed): void {
    this.#client = information;
  }

  tokens(): OAuthTokens | undefined {
    return this.#tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.#tokens = tokens;
  }

  redirectToAuthorization(url: URL): void {
    // Never opened, nor printed, unless it is https (or a loopback address).
    const problem = endpointProblem(url, "authorization URL");
    if (problem !== undefined) throw new TaviError("INVALID_INPUT", `the server cannot be signed in to: ${problem}`);
    // A preset's parameters only add: none replaces one the SDK set (state, PKCE, resource, redirect).
    for (const [name, value] of Object.entries(this.#authorizeParams)) if (!url.searchParams.has(name)) url.searchParams.set(name, value);
    this.authorizeUrl = url.href;
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    if (this.#verifier === undefined) throw new TaviError("CONFLICT", "no login is in progress");
    return this.#verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }
}

export interface McpLoginServer {
  readonly url: string;
  /** A pre-registered client from the server's settings. */
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** A preset's additions: parameters the authorization request adds, and the scope asked for. */
  readonly authorizeParams?: Readonly<Record<string, string>>;
  readonly scope?: string;
  /** Read the account's email from the id_token: the login then also asks for `openid email`. */
  readonly identity?: "oidc-email";
}

export interface McpLoginsOptions {
  readonly tokens: McpOAuthTokens;
  /** The server's address and pre-registered client; refuses a server that does not sign in with OAuth. */
  readonly server: (pluginId: string) => Promise<McpLoginServer>;
  readonly fetchFor: (pluginId: string) => FetchLike;
  /** The owner's public https address, when one is set (CIMD and a public redirect). */
  readonly publicUrl: () => Promise<string | undefined>;
  /** The server signed in: it starts afresh with its token, and its login notice is done. */
  readonly signedIn: (pluginId: string) => Promise<void>;
  /** A public login now waits: the owner's public listener must be up for its callback (and its CIMD document). */
  readonly awaitingPublic?: () => Promise<void>;
  /** Whether the credential store is encrypted: a sign-in keeps a refresh token, kept only there. */
  readonly encrypted?: () => boolean;
  /** Another instance of the same server already signed in as this account, if one is: the same account is connected once. */
  readonly takenBy?: (pluginId: string, identity: string) => Promise<string | undefined>;
  readonly now?: () => number;
}

interface LoginFlow {
  readonly flowId: string;
  readonly state: string;
  readonly pluginId: string;
  readonly provider: LoginProvider;
  readonly serverUrl: string;
  readonly expiresAt: number;
  readonly public: boolean;
  /** Where the browser comes back to: a pasted address must name exactly this. */
  readonly redirect: string;
  /** The scopes asked for, to find what consent left out. */
  readonly scope?: string;
  readonly identity?: "oidc-email";
  status: "pending" | "connected" | "failed";
  detail?: string;
  /** The account the sign-in named, once it came back. */
  signedInAs?: string;
}

/** The scopes a login asks for: the server's, with `openid email` added when its identity is read from the id_token. */
export function loginScope(server: Pick<McpLoginServer, "scope" | "identity">): string | undefined {
  if (server.identity !== "oidc-email") return server.scope;
  const scopes = new Set((server.scope ?? "").split(" ").filter((scope) => scope !== ""));
  scopes.add("openid");
  scopes.add("email");
  return [...scopes].join(" ");
}

/**
 * The email an id_token names. It came straight from the token endpoint over
 * TLS, so its signature is not checked (OIDC Core §3.1.3.7), but its `iss` must
 * be the issuer signed in with and its `aud` must name this client; an id_token
 * that does not parse, or names another issuer or client, names no one.
 */
export function idTokenEmail(
  idToken: string | undefined,
  expected: { readonly issuer: string; readonly clientId: string },
): string | undefined {
  const payload = idToken?.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      readonly email?: unknown;
      readonly email_verified?: unknown;
      readonly iss?: unknown;
      readonly aud?: unknown;
    };
    // Google names itself with or without its scheme (`accounts.google.com`): the same issuer either way.
    const bare = (issuer: string): string => issuer.replace(/^https:\/\//, "").replace(/\/+$/, "");
    if (typeof claims.iss !== "string" || bare(claims.iss) !== bare(expected.issuer)) return undefined;
    const audience = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (!audience.includes(expected.clientId)) return undefined;
    // An address the provider says it has not verified names no one; and only an address's own characters, as the model reads it.
    if (claims.email_verified === false || typeof claims.email !== "string") return undefined;
    const email = claims.email.toLowerCase();
    return email.length <= 254 && /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,189}\.[a-z]{2,}$/.test(email) ? email : undefined;
  } catch {
    return undefined;
  }
}

/** Requested scopes the token response leaves out; none when it names no scope (the request stood). */
export function missingScopes(requested: string | undefined, granted: string | undefined): readonly string[] {
  if (requested === undefined || granted === undefined) return [];
  const have = new Set(granted.split(" ").filter((scope) => scope !== ""));
  return requested.split(" ").filter((scope) => scope !== "" && scope !== "openid" && scope !== "email" && !have.has(scope));
}

/** The CIMD document a public owner serves: Tavi's client, its URL its id. */
export function clientMetadataDocument(publicUrl: string): Readonly<Record<string, unknown>> {
  const base = publicUrl.replace(/\/+$/, "");
  return {
    client_id: `${base}${MCP_CLIENT_METADATA_PATH}`,
    client_name: "Tavi",
    redirect_uris: [`${base}/oauth/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
}

/**
 * The protected-resource metadata a server names when it refuses an
 * unauthenticated request (`WWW-Authenticate: Bearer resource_metadata="…"`,
 * RFC 9728 §5.1): an http(s) address, or undefined when it names none or does
 * not answer 401. Asked through the server's own guarded fetch.
 */
export async function challengedMetadataUrl(serverUrl: string, fetchFn: FetchLike): Promise<URL | undefined> {
  const answer = await fetchFn(serverUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    // Best effort: revoking at the server; the local token is dropped whatever it answers.
  }).catch(() => undefined);
  // Best effort: the body is discarded; one already closed has nothing to cancel.
  await answer?.body?.cancel().catch(() => undefined);
  if (answer?.status !== 401) return undefined;
  const named = /\bresource_metadata\s*=\s*"([^"]{1,2048})"/i.exec(answer.headers.get("www-authenticate") ?? "")?.[1];
  if (named === undefined) return undefined;
  try {
    const url = new URL(named, serverUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Where a public owner serves its CIMD document. */
export const MCP_CLIENT_METADATA_PATH = "/.well-known/tavi-mcp-client.json";

/** Logins in progress: started by the operator only, completed by the callback that owns their state. */
export class McpLogins implements OAuthCallbackHandler {
  readonly #options: McpLoginsOptions;
  readonly #byState = new Map<string, LoginFlow>();
  readonly #byId = new Map<string, LoginFlow>();
  readonly #now: () => number;

  constructor(options: McpLoginsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Starts a login: Tavi's checks on the server's metadata, then the authorization URL to open. `origin` is a loopback listener's. */
  async start(input: {
    readonly pluginId: string;
    readonly origin?: string;
    readonly via?: "loopback" | "public";
  }): Promise<{ readonly flowId: string; readonly authorizeUrl: string; readonly public: boolean; readonly redirect: string }> {
    this.#sweep();
    if (this.#byId.size >= MCP_LOGIN_MAX) throw new TaviError("UNAVAILABLE", "Too many sign-ins are waiting; finish or close one first");
    if (this.#options.encrypted?.() === false)
      throw new TaviError(
        "NOT_CONFIGURED",
        `signing in to ${input.pluginId} keeps a sign-in token: turn on credential encryption first (\`tavi credentials encrypt\`)`,
      );
    const server = await this.#options.server(input.pluginId);
    const fetchFn = this.#options.fetchFor(input.pluginId);
    // Discovery through the guarded fetch (a private address only with `lan`), then Tavi's own refusals: the
    // protected-resource metadata the server names in its 401 first (RFC 9728 §5.1), its well-known paths otherwise.
    let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
    try {
      const resourceMetadataUrl = await challengedMetadataUrl(server.url, fetchFn);
      info = await discoverOAuthServerInfo(server.url, { fetchFn, ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }) });
    } catch (error) {
      // A refused address, an issuer that does not match, or metadata that does not parse (a `javascript:` endpoint).
      if (error instanceof TaviError) throw error;
      throw new TaviError(
        "UNSUPPORTED",
        `${input.pluginId}'s authorization server cannot be used: ${errorMessage(error).replace(/\s+/g, " ").slice(0, 300)}`,
      );
    }
    const metadata = info.authorizationServerMetadata;
    if (metadata === undefined)
      throw new TaviError("UNSUPPORTED", `${input.pluginId}'s authorization server publishes no metadata, so Tavi cannot check it`);
    if (!(metadata.code_challenge_methods_supported ?? []).includes("S256"))
      throw new TaviError(
        "UNSUPPORTED",
        `${input.pluginId}'s authorization server does not advertise PKCE (S256); Tavi does not sign in without it`,
      );
    for (const [what, url] of [
      ["authorization endpoint", metadata.authorization_endpoint],
      ["token endpoint", metadata.token_endpoint],
    ] as const) {
      const problem = endpointProblem(url, what);
      if (problem !== undefined) throw new TaviError("UNSUPPORTED", `${input.pluginId} cannot be signed in to: ${problem}`);
    }
    if (metadata.registration_endpoint !== undefined) {
      const problem = endpointProblem(metadata.registration_endpoint, "registration endpoint");
      if (problem !== undefined) throw new TaviError("UNSUPPORTED", `${input.pluginId} cannot be signed in to: ${problem}`);
    }
    // A loopback listener (the CLI's or the canvas's) comes back to this computer; `via: "public"`, or no origin, to the
    // owner's https address, when one is set (it needs only to open in the person's browser).
    if (input.via === "loopback" && input.origin === undefined)
      throw new TaviError("INVALID_INPUT", "a sign-in here needs the loopback address it comes back to");
    const publicUrl = input.via === "public" || input.origin === undefined ? await this.#options.publicUrl() : undefined;
    if (input.via === "public" && publicUrl?.startsWith("https://") !== true)
      throw new TaviError(
        "NOT_CONFIGURED",
        "no https address is set for this server: set one with `tavi channels ingress --public-url <url>`",
      );
    const isPublic = publicUrl?.startsWith("https://") === true;
    const redirect =
      input.via !== "public" && input.origin !== undefined
        ? `${input.origin.replace(/\/+$/, "")}/oauth/callback`
        : isPublic
          ? `${(publicUrl as string).replace(/\/+$/, "")}/oauth/callback`
          : undefined;
    if (redirect === undefined)
      throw new TaviError(
        "INVALID_INPUT",
        "a login needs somewhere to come back to: run `tavi mcp login` (it listens on this computer), or set a public https address",
      );
    // The client, in order: pre-registered, CIMD, DCR, else ask.
    const client =
      server.clientId === undefined
        ? undefined
        : { client_id: server.clientId, ...(server.clientSecret === undefined ? {} : { client_secret: server.clientSecret }) };
    const cimd =
      client === undefined && isPublic && metadata.client_id_metadata_document_supported === true
        ? `${(publicUrl as string).replace(/\/+$/, "")}${MCP_CLIENT_METADATA_PATH}`
        : undefined;
    if (client === undefined && cimd === undefined && metadata.registration_endpoint === undefined) {
      throw new TaviError(
        "NOT_CONFIGURED",
        `${input.pluginId}'s authorization server registers no clients: create one there and set it with \`tavi plugins config ${input.pluginId} --set clientId=… --set clientSecret=<credential reference>\``,
        // A page asks for that client's id in place of the command.
        { details: { needsClient: true, redirect } },
      );
    }
    const state = randomToken(32);
    const provider = new LoginProvider({
      redirect,
      state,
      applicationType: isPublic ? "web" : "native",
      ...definedOnly({ client, clientMetadataUrl: cimd, authorizeParams: server.authorizeParams }),
    });
    // The SDK uses the discovery Tavi checked, never one of its own after it.
    provider.saveDiscoveryState(info);
    // A sign-in again asks for what the last one held and what a refused call named, beside the server's own (step-up).
    // With no scope of its own, the server's listed ones stand in, as the SDK would ask for them.
    const keep = await this.#options.tokens.scopeToKeep(input.pluginId);
    const scope =
      keep === undefined
        ? loginScope(server)
        : computeScopeUnion(loginScope(server) ?? info.resourceMetadata?.scopes_supported?.join(" "), keep);
    const result = await auth(provider, { serverUrl: server.url, fetchFn, ...(scope === undefined ? {} : { scope }) });
    if (result !== "REDIRECT" || provider.authorizeUrl === undefined)
      throw new TaviError("CONFLICT", `${input.pluginId} did not ask for a sign-in`);
    const flow: LoginFlow = {
      flowId: randomToken(12),
      state,
      pluginId: input.pluginId,
      provider,
      serverUrl: server.url,
      expiresAt: this.#now() + MCP_LOGIN_TTL_MS,
      public: isPublic,
      redirect,
      ...(scope === undefined ? {} : { scope }),
      ...(server.identity === undefined ? {} : { identity: server.identity }),
      status: "pending",
    };
    this.#byState.set(state, flow);
    this.#byId.set(flow.flowId, flow);
    // The public listener opens once a login waits on it.
    if (isPublic) await this.#options.awaitingPublic?.();
    return { flowId: flow.flowId, authorizeUrl: provider.authorizeUrl, public: isPublic, redirect };
  }

  /**
   * Paste-back: the address a browser landed on, for a sign-in finished where its redirect could
   * not reach this owner. It must name this flow's own redirect and `state`; anything else is refused without spending
   * either flow, and the address itself is never logged or echoed.
   */
  async finish(flowId: string, address: string): Promise<OAuthCallbackOutcome> {
    const flow = this.#byId.get(flowId);
    if (flow === undefined || flow.status !== "pending")
      return { ok: false, message: "This sign-in is no longer waiting: start it again." };
    const pasted = pastedCallback(address, { redirect: flow.redirect, state: flow.state });
    return pasted.ok ? await this.callback(pasted.input) : pasted;
  }

  /** Ends a sign-in still waiting: its link is spent. */
  cancel(flowId: string): boolean {
    const flow = this.#byId.get(flowId);
    if (flow === undefined || flow.status !== "pending") return false;
    this.#byState.delete(flow.state);
    flow.status = "failed";
    flow.detail = "cancelled";
    return true;
  }

  /** Every state this issued, expired included (its callback says so in its own words), until it is swept. */
  owns(state: string): boolean {
    return this.#byState.has(state);
  }

  /** The callback for a state this owns: once only; the code exchanged by the SDK, the grant stored. */
  async callback(input: OAuthCallbackInput): Promise<OAuthCallbackOutcome> {
    const flow = this.#byState.get(input.state);
    this.#byState.delete(input.state);
    if (flow === undefined) return { ok: false, message: "This sign-in link has expired or was already used." };
    if (flow.expiresAt <= this.#now())
      return { ok: false, message: `This sign-in to ${flow.pluginId} took too long: run \`tavi mcp login ${flow.pluginId}\` again.` };
    const fail = (given: string): OAuthCallbackOutcome => {
      // The server's words are cleaned before they reach a terminal or a page.
      const detail = cleanServerText(given).replace(/\s+/g, " ").slice(0, 300);
      flow.status = "failed";
      flow.detail = detail;
      return { ok: false, message: `${flow.pluginId} was not signed in: ${detail}` };
    };
    // RFC 9207: an answer, an error's included, must come from the server the sign-in went to.
    const metadata = flow.provider.discoveryState()?.authorizationServerMetadata;
    try {
      validateAuthorizationResponseIssuer({
        iss: input.iss,
        expectedIssuer: metadata?.issuer,
        issParameterSupported: metadata?.authorization_response_iss_parameter_supported === true,
      });
    } catch {
      return fail("the answer came from another server than the one the sign-in went to");
    }
    if (input.error !== undefined) return fail(providerRefusal(input.error, { provider: "The server's sign-in", redirect: flow.redirect }));
    if (input.code === undefined) return fail("no code came back");
    const fetchFn = this.#options.fetchFor(flow.pluginId);
    try {
      const result = await auth(flow.provider, {
        serverUrl: flow.serverUrl,
        authorizationCode: input.code,
        ...(input.iss === undefined ? {} : { iss: input.iss }),
        fetchFn,
      });
      const tokens = flow.provider.tokens();
      const client = flow.provider.clientInformation();
      const discovery = flow.provider.discoveryState();
      if (result !== "AUTHORIZED" || tokens === undefined || client === undefined || discovery === undefined)
        return fail("the server did not give a token");
      const issuer = discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl;
      const identity =
        flow.identity === "oidc-email"
          ? idTokenEmail((tokens as { readonly id_token?: string }).id_token, { issuer, clientId: client.client_id })
          : undefined;
      // A reconnect keeps its account: another one is another account, not this one.
      const before = await this.#options.tokens.grant(flow.pluginId);
      if (flow.identity === "oidc-email" && before?.identity !== undefined && identity !== before.identity) {
        flow.status = "failed";
        // An account it cannot name is not taken as the one it reconnects, or a later sign-in could be anyone.
        flow.detail =
          identity === undefined ? "the sign-in did not say which account it was" : `signed in as ${identity}, not ${before.identity}`;
        return identity === undefined
          ? {
              ok: false,
              conflict: true,
              message: `The sign-in did not say which account it was, so it was not taken as ${before.identity}. Sign in again.`,
            }
          : {
              ok: false,
              conflict: true,
              message: `You signed in as ${identity}, but this account is ${before.identity}. Add it as another account instead.`,
            };
      }
      // A new account that is one already connected: refused, so one revoke never ends two of them.
      const taken =
        identity === undefined || before?.identity === identity ? undefined : await this.#options.takenBy?.(flow.pluginId, identity);
      if (taken !== undefined) {
        flow.status = "failed";
        flow.detail = `${identity ?? ""} is already connected as ${taken}`;
        return {
          ok: false,
          conflict: true,
          message: `${identity ?? ""} is already connected (${taken}): reconnect that account instead of adding it again.`,
        };
      }
      const missing = missingScopes(flow.scope, tokens.scope);
      await this.#options.tokens.save(flow.pluginId, {
        issuer,
        authorizationServerUrl: discovery.authorizationServerUrl,
        ...(discovery.authorizationServerMetadata === undefined ? {} : { metadata: discovery.authorizationServerMetadata }),
        resource: discovery.resourceMetadata?.resource ?? flow.serverUrl,
        client,
        tokens: storedTokens(tokens, this.#now()),
        signedInAt: new Date(this.#now()).toISOString(),
        ...(identity === undefined ? {} : { identity }),
        ...(missing.length === 0 ? {} : { missingScopes: missing }),
      });
      if (identity !== undefined) flow.signedInAs = identity;
    } catch (error) {
      return fail(clip(errorMessage(error), 300));
    }
    flow.status = "connected";
    // Best effort: the sign-in is stored; a listener that fails to hear of it reconnects on its next call.
    await this.#options.signedIn(flow.pluginId).catch(() => undefined);
    return { ok: true, message: `${flow.pluginId} is signed in. You can close this page.` };
  }

  status(flowId: string):
    | {
        readonly state: "pending" | "connected" | "failed" | "expired";
        readonly pluginId: string;
        readonly detail?: string;
        readonly identity?: string;
      }
    | undefined {
    const flow = this.#byId.get(flowId);
    if (flow === undefined) return undefined;
    const state = flow.status === "pending" && flow.expiresAt <= this.#now() ? "expired" : flow.status;
    return {
      state,
      pluginId: flow.pluginId,
      ...(flow.detail === undefined ? {} : { detail: flow.detail }),
      ...(flow.signedInAs === undefined ? {} : { identity: flow.signedInAs }),
    };
  }

  /** Whether a login waits on the public address (the ingress stays open meanwhile). */
  waitingPublic(): boolean {
    return [...this.#byState.values()].some((flow) => flow.public && flow.status === "pending" && flow.expiresAt > this.#now());
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, flow] of this.#byId) {
      if (flow.expiresAt + MCP_LOGIN_TTL_MS <= now) {
        this.#byId.delete(id);
        this.#byState.delete(flow.state);
      }
    }
  }
}
