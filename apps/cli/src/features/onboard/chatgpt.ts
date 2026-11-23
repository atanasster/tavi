import { createPublicKey, randomUUID, verify as verifySignature, type webcrypto } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { keyedError, TaviError, type OnboardingConnectAnswer } from "@tavi/contracts";
import { definedOnly, errorMessage, isRecord } from "@tavi/contracts/util";
import { z } from "zod";
import { readJsonBody } from "../../shared/json-body.js";
import { listenLoopback, type Loopback } from "../oauth/loopback.js";
import { pkcePair, randomToken } from "../oauth/pkce.js";
import { SignInFlows, type SignInStatus } from "./sign-in-flows.js";

/**
 * Sign in with ChatGPT: OpenAI's
 * documented path for an open-source app to use a person's ChatGPT plan
 * (developers.openai.com/siwc). PKCE and OpenID Connect on a `127.0.0.1`
 * loopback; the first sign-in registers this install as the person's own agent
 * (`client_id=dynamic_agent_client` → an issued `oaiapp_…` client id, kept);
 * the ID token is checked against OpenAI's keys, issuer, audience, expiry and
 * nonce, and plan use only when `chatgpt.tokens.use.direct` was granted. The
 * whole token record is the connection's credential: an access token for an
 * hour, and a rotating refresh token, replaced together on each refresh.
 * Nothing here borrows another tool's client id or reads its token store.
 */

export interface ChatGptEndpoints {
  readonly issuer: string;
  readonly authorize: string;
  readonly token: string;
  readonly jwks: string;
  /** The API the access token is for, and the connection's endpoint. */
  readonly resource: string;
}

export const CHATGPT_ENDPOINTS: ChatGptEndpoints = {
  issuer: "https://auth.openai.com",
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  jwks: "https://auth.openai.com/.well-known/jwks.json",
  resource: "https://api.openai.com/v1",
};

/** First registration's client id: the entry point, never the one kept. */
export const CHATGPT_REGISTRATION_CLIENT = "dynamic_agent_client";
/** The name the person sees, and may edit, when they authorize this install. */
const CHATGPT_AGENT_NAME = "Tavi";
const CHATGPT_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/** The scope that lets a request use the person's plan; without it the sign-in holds, but no inference may run. */
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
const CHATGPT_CALLBACK_PATH = "/auth/callback";
/** The loopback port OpenAI's docs show; another free one when it is taken (only the port may vary). */
const CHATGPT_CALLBACK_PORT = 1455;
/** Refreshed this long before it expires. */
const CHATGPT_REFRESH_EARLY_MS = 5 * 60_000;
const CHATGPT_SIGN_IN_TTL_MS = 10 * 60_000;
/** How long a token or JWKS request to OpenAI may take, body included (as the OAuth broker's). */
const TOKEN_TIMEOUT_MS = 30_000;

/** The stored credential (OpenAI's documented record): what the connection's credential reference holds, as JSON. */
const ChatGptCredentialSchema = z.strictObject({
  kind: z.literal("chatgpt-sign-in"),
  issuer: z.string().url(),
  subject: z.string().min(1).max(256),
  email: z.string().max(320).optional(),
  client_id: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value !== CHATGPT_REGISTRATION_CLIENT, "the registration entry point is not a client id"),
  ext_agent_host_id: z.string().min(1).max(256),
  id_token: z.string().min(1).max(16_384),
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384),
  token_type: z.string().min(1).max(32),
  /** When the access token stops working. */
  expires_at: z.string().datetime(),
  scopes: z.array(z.string().min(1).max(128)).max(32),
  saved_at: z.string().datetime(),
});
export type ChatGptCredential = z.infer<typeof ChatGptCredentialSchema>;

/** The stored record, when a credential is one; anything else (an API key) is not. */
export function chatGptCredentialOf(value: string): ChatGptCredential | undefined {
  if (!value.trimStart().startsWith("{")) return undefined;
  try {
    const parsed = ChatGptCredentialSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a credential's revision is computed over: the value itself, but
 * for a ChatGPT sign-in its issued client and account alone — its tokens
 * rotate every hour, and a verification must not go stale with them; signing in
 * as someone else, or registering again, is a new revision.
 */
export function revisionValue(value: string | null): string | null {
  if (value === null) return null;
  const record = chatGptCredentialOf(value);
  return record === undefined ? value : `chatgpt-sign-in:${record.client_id}:${record.subject}`;
}

/**
 * This install's stable host identifier (`ext_agent_host_id`): a `urn:uuid:`
 * made once and kept beside the data (0600), never a user's identity.
 */
export async function chatGptHostId(dataDirectory: string): Promise<string> {
  const file = join(dataDirectory, "chatgpt-host-id");
  if (existsSync(file)) {
    const kept = readFileSync(file, "utf8").trim();
    if (/^urn:uuid:[0-9a-f-]{36}$/u.test(kept)) return kept;
  }
  const made = `urn:uuid:${randomUUID()}`;
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(file, `${made}\n`, { mode: 0o600 });
  return made;
}

export interface ChatGptSignInStart {
  readonly url: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
  /** The issued client id a returning sign-in uses; absent for a first registration. */
  readonly clientId?: string;
}

/** The authorize address for one attempt: fresh state, nonce and PKCE; a returning account's client id and hints. */
export function startChatGptSignIn(input: {
  readonly redirectUri: string;
  readonly hostId: string;
  readonly endpoints?: ChatGptEndpoints;
  readonly returning?: Pick<ChatGptCredential, "client_id" | "id_token" | "email">;
}): ChatGptSignInStart {
  const endpoints = input.endpoints ?? CHATGPT_ENDPOINTS;
  const state = randomToken(32);
  const nonce = randomToken(32);
  const { verifier, challenge } = pkcePair(48);
  const url = new URL(endpoints.authorize);
  const params: Record<string, string> = {
    client_id: input.returning?.client_id ?? CHATGPT_REGISTRATION_CLIENT,
    ext_agent_host_id: input.hostId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: CHATGPT_SCOPES,
    resource: endpoints.resource,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
    // A first registration names the agent; a returning one says which account, never naming it again.
    ...(input.returning === undefined
      ? { agent_name_hint: CHATGPT_AGENT_NAME }
      : { id_token_hint: input.returning.id_token, ...(input.returning.email === undefined ? {} : { login_hint: input.returning.email }) }),
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return {
    url: url.toString(),
    state,
    nonce,
    verifier,
    redirectUri: input.redirectUri,
    ...(input.returning === undefined ? {} : { clientId: input.returning.client_id }),
  };
}

// ------------------------------------------------------------------ the ID token

interface Jwks {
  readonly keys: readonly (webcrypto.JsonWebKey & { readonly kid?: string; readonly alg?: string })[];
}

/**
 * The ID token's claims, once its signature verifies against OpenAI's keys
 * (RS256 or ES256) and its issuer, audience, expiry and nonce are this
 * attempt's. Anything else is refused.
 */
/** Clock skew allowed on `iat` and `nbf`. */
const ID_TOKEN_SKEW_S = 60;

/** `nonce` is a sign-in's; a refreshed ID token carries none, and is checked without. */
export async function verifyChatGptIdToken(
  idToken: string,
  expected: {
    readonly issuer: string;
    readonly audience: string;
    readonly nonce?: string;
    readonly now: number;
    readonly jwks: () => Promise<Jwks>;
  },
): Promise<{ readonly sub: string; readonly email?: string }> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token is not a JWT");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: { readonly alg?: unknown; readonly kid?: unknown };
  let claims: {
    readonly iss?: unknown;
    readonly aud?: unknown;
    readonly exp?: unknown;
    readonly iat?: unknown;
    readonly nbf?: unknown;
    readonly nonce?: unknown;
    readonly sub?: unknown;
    readonly email?: unknown;
  };
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as typeof header;
    claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as typeof claims;
  } catch {
    throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token could not be read");
  }
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256")
    throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token is signed in a way Tavi does not accept");
  // The key's type is the algorithm's, so a token cannot choose how its own signature is read.
  const kty = alg === "RS256" ? "RSA" : "EC";
  const keys = (await expected.jwks()).keys.filter(
    (key) => key.kty === kty && (header.kid === undefined || key.kid === header.kid) && (key.alg === undefined || key.alg === alg),
  );
  const signed = Buffer.from(`${headerPart}.${payloadPart}`);
  const signature = Buffer.from(signaturePart, "base64url");
  const valid = keys.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return alg === "RS256"
        ? verifySignature("RSA-SHA256", signed, key, signature)
        : verifySignature("SHA256", signed, { key, dsaEncoding: "ieee-p1363" }, signature);
    } catch {
      return false;
    }
  });
  if (!valid) throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token is not signed by OpenAI");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expected.issuer) throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token is from another issuer");
  if (!audiences.includes(expected.audience)) throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token is for another client");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= expected.now)
    throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token has expired");
  const nowS = expected.now / 1000;
  if (typeof claims.iat !== "number" || claims.iat > nowS + ID_TOKEN_SKEW_S)
    throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token says no time it was issued, or a future one");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > nowS + ID_TOKEN_SKEW_S))
    throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token is not valid yet");
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce)
    throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token is not this sign-in's");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new TaviError("NOT_AUTHORIZED", "ChatGPT's ID token names no account");
  return { sub: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
}

// ------------------------------------------------------------------ tokens

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  token_type: z.string().min(1).default("Bearer"),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});

/** OpenAI's refusal, by its code alone: its body is never quoted (it may echo a token). */
async function refusalOf(response: Response): Promise<string> {
  try {
    const body = (await readJsonBody(response)) as { readonly error?: unknown; readonly code?: unknown } | null;
    const code = typeof body?.error === "string" ? body.error : typeof body?.code === "string" ? body.code : undefined;
    return code === undefined ? `HTTP ${String(response.status)}` : code.slice(0, 64);
  } catch {
    return `HTTP ${String(response.status)}`;
  }
}

/** The refresh codes that mean the sign-in is over (OpenAI's list): the person signs in again. */
const CHATGPT_SIGN_IN_AGAIN = [
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
] as const;

const jwksFrom = (fetchImpl: typeof globalThis.fetch, url: string) => async (): Promise<Jwks> => {
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
  if (!response.ok) throw new TaviError("UNAVAILABLE", `OpenAI's signing keys could not be read (HTTP ${String(response.status)})`);
  const body = await readJsonBody(response);
  if (!isRecord(body) || !Array.isArray(body["keys"])) throw new TaviError("UNAVAILABLE", "OpenAI's signing keys are not a key set");
  return body as unknown as Jwks;
};

/**
 * Exchange the callback's code for the token record: the issued client id, the
 * same redirect address and resource, and the PKCE verifier; then the ID token
 * checked and plan use confirmed. A returning sign-in must be the same account.
 */
async function exchangeChatGptCode(input: {
  readonly code: string;
  readonly start: ChatGptSignInStart;
  readonly clientId: string;
  readonly hostId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoints?: ChatGptEndpoints;
  readonly now?: () => number;
  readonly sameAccount?: string;
}): Promise<ChatGptCredential> {
  const endpoints = input.endpoints ?? CHATGPT_ENDPOINTS;
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const now = input.now ?? Date.now;
  const response = await fetchImpl(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.start.verifier,
      redirect_uri: input.start.redirectUri,
      resource: endpoints.resource,
    }).toString(),
    // Bounds the body read too: a stalled token endpoint must not hang the sign-in.
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!response.ok) throw keyedError("NOT_AUTHORIZED", "onboard.signIn.chatGptRefused", { why: await refusalOf(response) });
  const parsed = TokenResponseSchema.safeParse(await readJsonBody(response));
  if (!parsed.success || parsed.data.id_token === undefined) throw keyedError("UNAVAILABLE", "onboard.signIn.notTokenSet");
  const tokens = parsed.data;
  const identity = await verifyChatGptIdToken(tokens.id_token as string, {
    issuer: endpoints.issuer,
    audience: input.clientId,
    nonce: input.start.nonce,
    now: now(),
    jwks: jwksFrom(fetchImpl, endpoints.jwks),
  });
  if (input.sameAccount !== undefined && identity.sub !== input.sameAccount) throw keyedError("CONFLICT", "onboard.signIn.otherAccount");
  const scopes = (tokens.scope ?? "").split(/\s+/u).filter((scope) => scope !== "");
  if (!scopes.includes(CHATGPT_PLAN_SCOPE)) throw keyedError("NOT_AUTHORIZED", "onboard.signIn.planScope");
  const at = new Date(now());
  return ChatGptCredentialSchema.parse({
    kind: "chatgpt-sign-in",
    issuer: endpoints.issuer,
    subject: identity.sub,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    client_id: input.clientId,
    ext_agent_host_id: input.hostId,
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expires_at: new Date(at.getTime() + tokens.expires_in * 1000).toISOString(),
    scopes,
    saved_at: at.toISOString(),
  });
}

/**
 * A fresh access token and rotated refresh token, replaced together (the issued
 * client id, never the registration entry point; no `scope`, so the grant is
 * kept). A refusal that ends the sign-in is `NOT_AUTHORIZED`, saying to sign in
 * again; a network fault is `UNAVAILABLE`, and the stored record stays.
 */
export async function refreshChatGpt(
  record: ChatGptCredential,
  options: { readonly fetch?: typeof globalThis.fetch; readonly endpoints?: ChatGptEndpoints; readonly now?: () => number } = {},
): Promise<ChatGptCredential> {
  const endpoints = options.endpoints ?? CHATGPT_ENDPOINTS;
  const now = options.now ?? Date.now;
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: record.client_id,
        refresh_token: record.refresh_token,
        resource: endpoints.resource,
      }).toString(),
      // A renewal runs in the credential store's queue: a stalled one would hold every resolve behind it.
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    throw keyedError("UNAVAILABLE", "onboard.signIn.unreachable", { why: errorMessage(error) });
  }
  if (!response.ok) {
    const code = await refusalOf(response);
    // OpenAI's: the client itself refused, which signing in registers anew.
    if (code === "invalid_client") throw keyedError("NOT_AUTHORIZED", "onboard.signIn.invalidClient");
    if ((CHATGPT_SIGN_IN_AGAIN as readonly string[]).includes(code) || response.status === 400 || response.status === 401) {
      throw keyedError("NOT_AUTHORIZED", "onboard.signIn.ended");
    }
    throw keyedError("UNAVAILABLE", "onboard.signIn.cannotRenew", { code });
  }
  const parsed = TokenResponseSchema.safeParse(await readJsonBody(response));
  if (!parsed.success) throw keyedError("UNAVAILABLE", "onboard.signIn.notTokenSet");
  // A new ID token is kept only once it is OpenAI's, for this client, and the same account.
  if (parsed.data.id_token !== undefined) {
    const identity = await verifyChatGptIdToken(parsed.data.id_token, {
      issuer: record.issuer,
      audience: record.client_id,
      now: now(),
      jwks: jwksFrom(options.fetch ?? globalThis.fetch, endpoints.jwks),
    });
    if (identity.sub !== record.subject) throw keyedError("NOT_AUTHORIZED", "onboard.signIn.renewedOther");
  }
  const at = new Date(now());
  return ChatGptCredentialSchema.parse({
    ...record,
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token,
    ...(parsed.data.id_token === undefined ? {} : { id_token: parsed.data.id_token }),
    token_type: parsed.data.token_type,
    expires_at: new Date(at.getTime() + parsed.data.expires_in * 1000).toISOString(),
    ...(parsed.data.scope === undefined ? {} : { scopes: parsed.data.scope.split(/\s+/u).filter((scope) => scope !== "") }),
    saved_at: at.toISOString(),
  });
}

/**
 * A credential resolver that answers a ChatGPT sign-in's access token in place
 * of its stored record, renewing it near expiry and storing the rotated one
 * before answering (one renewal at a time per reference, so two calls never
 * race a rotating token). Any other credential passes through. A renewal the
 * store refuses to keep is not used: the old record stays, and the call fails.
 */
export function chatGptAwareResolver(
  resolve: (reference: string) => Promise<string | null>,
  store: (reference: string, value: string) => Promise<void>,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly endpoints?: ChatGptEndpoints;
    readonly now?: () => number;
    readonly serialize?: <T>(work: () => Promise<T>) => Promise<T>;
  } = {},
): (reference: string) => Promise<string | null> {
  const now = options.now ?? Date.now;
  const renewing = new Map<string, Promise<string>>();
  return async (reference) => {
    const value = await resolve(reference);
    if (value === null) return null;
    const record = chatGptCredentialOf(value);
    if (record === undefined) return value;
    if (Date.parse(record.expires_at) - now() > CHATGPT_REFRESH_EARLY_MS) return record.access_token;
    const running = renewing.get(reference);
    if (running !== undefined) return await running;
    // Inside the credential store's queue (`serialize`): a sign-in or another renewal landing meanwhile is read, never overwritten.
    const renewal = (options.serialize ?? (async <T>(work: () => Promise<T>) => await work()))(async () => {
      // Read again inside the renewal: another process may have renewed it already.
      const current = chatGptCredentialOf((await resolve(reference)) ?? "") ?? record;
      if (Date.parse(current.expires_at) - now() > CHATGPT_REFRESH_EARLY_MS) return current.access_token;
      const renewed = await refreshChatGpt(current, options);
      await store(reference, JSON.stringify(renewed));
      return renewed.access_token;
    });
    renewing.set(reference, renewal);
    try {
      return await renewal;
    } finally {
      renewing.delete(reference);
    }
  };
}

// ------------------------------------------------------------------ the loopback

export interface ChatGptLoopback {
  readonly redirectUri: string;
  /** The callback's query, once a request carries this attempt's state; refused ones are answered and ignored. */
  readonly callback: Promise<URLSearchParams>;
  close(): void;
}

/** A listener on `127.0.0.1` for one attempt: the documented port, or another free one. */
export async function listenForChatGpt(
  state: () => string,
  options: { readonly port?: number; readonly signal?: AbortSignal } = {},
): Promise<ChatGptLoopback> {
  let settle: (query: URLSearchParams) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const callback = new Promise<URLSearchParams>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const answer = (_request: IncomingMessage, response: ServerResponse, url: URL): void => {
    if (url.pathname !== CHATGPT_CALLBACK_PATH || url.searchParams.get("state") !== state()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not this sign-in.");
      return;
    }
    const denied = url.searchParams.get("error") !== null;
    response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end(
        denied
          ? "ChatGPT sign-in was not allowed. You can close this tab."
          : "Signed in with ChatGPT. You can close this tab and go back to Tavi.",
      );
    settle(url.searchParams);
  };
  // The documented port when it is free, so the registered redirect matches; any other free one otherwise.
  let loopback: Loopback;
  try {
    loopback = await listenLoopback(options.port ?? CHATGPT_CALLBACK_PORT, answer);
  } catch {
    loopback = await listenLoopback(0, answer);
  }
  const { server, origin } = loopback;
  const close = () => {
    server.close();
    fail(keyedError("ABORTED", "onboard.signIn.chatGptStopped"));
  };
  options.signal?.addEventListener("abort", close, { once: true });
  // Awaited or raced elsewhere: this only keeps an early rejection from going unhandled.
  callback.catch(() => undefined);
  return { redirectUri: `${origin}${CHATGPT_CALLBACK_PATH}`, callback, close };
}

/**
 * One whole sign-in: a listener, the authorize address opened, the callback's
 * state checked (a refusal stops it, nothing exchanged), the client id kept —
 * a returning sign-in's must be the one asked with — and the code exchanged.
 */
export async function signInWithChatGpt(input: {
  readonly hostId: string;
  readonly open: (url: string) => void | Promise<void>;
  readonly returning?: ChatGptCredential;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoints?: ChatGptEndpoints;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly port?: number;
}): Promise<ChatGptCredential> {
  let start: ChatGptSignInStart | undefined;
  const loopback = await listenForChatGpt(() => start?.state ?? "", {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.port === undefined ? {} : { port: input.port }),
  });
  try {
    start = startChatGptSignIn({
      redirectUri: loopback.redirectUri,
      hostId: input.hostId,
      ...(input.endpoints === undefined ? {} : { endpoints: input.endpoints }),
      ...(input.returning === undefined ? {} : { returning: input.returning }),
    });
    await input.open(start.url);
    const query = await withTimeout(loopback.callback, CHATGPT_SIGN_IN_TTL_MS);
    const error = query.get("error");
    if (error !== null)
      throw keyedError("NOT_AUTHORIZED", error === "access_denied" ? "onboard.signIn.chatGptDenied" : "onboard.signIn.chatGptNotSignedIn");
    const code = query.get("code");
    if (code === null || code === "") throw keyedError("NOT_AUTHORIZED", "onboard.signIn.noCode");
    const issued = query.get("client_id");
    let clientId: string;
    if (start.clientId !== undefined) {
      // Returning: the callback may omit the id, and may not change it.
      if (issued !== null && issued !== start.clientId) throw keyedError("CONFLICT", "onboard.signIn.otherRegistration");
      clientId = start.clientId;
    } else {
      if (issued === null || issued === "" || issued === CHATGPT_REGISTRATION_CLIENT)
        throw keyedError("UNAVAILABLE", "onboard.signIn.notRegistered");
      clientId = issued;
    }
    return await exchangeChatGptCode({
      code,
      start,
      clientId,
      hostId: input.hostId,
      ...definedOnly({ fetch: input.fetch, endpoints: input.endpoints, now: input.now }),
      ...(input.returning === undefined ? {} : { sameAccount: input.returning.subject }),
    });
  } finally {
    loopback.close();
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(keyedError("CANCELLED", "onboard.signIn.chatGptTooLong")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The owner's sign-ins for the canvas: each on a loopback of its own in
 * this process, its credential stored by `onCredential` as the terminal's is,
 * and its outcome read by state, as `sign-in-status` does for OpenRouter.
 */
export interface ChatGptSignInsOptions {
  /** This install's host id, made on the first sign-in. */
  readonly hostId: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoints?: ChatGptEndpoints;
  readonly now?: () => number;
  readonly port?: number;
}

export class ChatGptSignIns {
  /** Each sign-in's listener, stopped when the sign-in expires. */
  readonly #flows: SignInFlows<AbortController>;
  readonly #options: ChatGptSignInsOptions;

  constructor(options: ChatGptSignInsOptions) {
    this.#options = options;
    this.#flows = new SignInFlows<AbortController>({
      ttlMs: CHATGPT_SIGN_IN_TTL_MS,
      ...(options.now === undefined ? {} : { now: options.now }),
      expired: (stop) => stop.abort(),
    });
  }

  /**
   * Start one: the address to open and its state; the rest happens when the
   * browser comes back. `returning`, the account already signed in: its issued
   * client id and hints are reused, and only that account is accepted.
   */
  async start(
    onCredential: (credential: ChatGptCredential) => Promise<OnboardingConnectAnswer>,
    returning?: ChatGptCredential,
  ): Promise<{ readonly url: string; readonly state: string }> {
    this.#flows.sweep();
    const hostId = await this.#options.hostId();
    const stop = new AbortController();
    let opened: (url: string) => void = () => undefined;
    const address = new Promise<string>((resolve) => {
      opened = resolve;
    });
    const done = signInWithChatGpt({
      hostId,
      open: (url) => opened(url),
      signal: stop.signal,
      ...(returning === undefined ? {} : { returning }),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      ...(this.#options.endpoints === undefined ? {} : { endpoints: this.#options.endpoints }),
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      ...(this.#options.port === undefined ? {} : { port: this.#options.port }),
    });
    // The listener could not start: said now, not as a sign-in that never comes back.
    const url = await Promise.race([
      address,
      done.then(() => {
        throw keyedError("UNAVAILABLE", "onboard.signIn.endedBefore");
      }),
    ]);
    const state = new URL(url).searchParams.get("state") ?? "";
    const flow = this.#flows.add(state, stop);
    void done
      .then(async (credential) => {
        const connection = await onCredential(credential);
        flow.outcome = { ok: true, message: "Signed in with ChatGPT.", connection };
      })
      .catch((error: unknown) => {
        flow.outcome = { ok: false, message: errorMessage(error) };
      });
    return { url, state };
  }

  status(state: string): SignInStatus {
    return this.#flows.status(state);
  }

  owns(state: string): boolean {
    return this.#flows.owns(state);
  }
}
