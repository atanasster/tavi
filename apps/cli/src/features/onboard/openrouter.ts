import type { Server } from "node:http";

import { TaviError, type OnboardingConnectAnswer } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { readJsonBody } from "../../shared/json-body.js";
import {
  oauthSharedHostNote,
  openAuthorizationUrl,
  pastedCallback,
  type OAuthCallbackHandler,
  type OAuthCallbackInput,
  type OAuthCallbackOutcome,
} from "../oauth/core.js";
import { listenLoopback } from "../oauth/loopback.js";
import { pkcePair, randomToken } from "../oauth/pkce.js";
import { SignInFlows, type SignInOutcome, type SignInStatus } from "./sign-in-flows.js";

/**
 * Sign in with OpenRouter: OpenRouter's
 * PKCE flow mints a key the person controls — `openrouter.ai/auth` with a
 * `callback_url` and an S256 challenge, then the code exchanged at
 * `POST /api/v1/auth/keys` with the verifier. OpenRouter appends `code` to
 * `callback_url` and takes no `state` of its own, so the state rides inside
 * `callback_url` (`…/oauth/callback?state=<state>`). One implementation for
 * the canvas (the owner's callback router) and the terminal (a 127.0.0.1
 * listener in its own process, or a pasted address over SSH). The key is
 * handed to the caller to store like a typed one, and never logged.
 */

export interface OpenRouterEndpoints {
  readonly auth: string;
  readonly keys: string;
}

const OPENROUTER_ENDPOINTS: OpenRouterEndpoints = { auth: "https://openrouter.ai/auth", keys: "https://openrouter.ai/api/v1/auth/keys" };

/** How long a sign-in waits for the browser to come back. */
const OPENROUTER_SIGN_IN_TTL_MS = 10 * 60_000;

export interface OpenRouterSignInStart {
  readonly state: string;
  readonly verifier: string;
  /** Where the browser comes back to, with the state in it. */
  readonly callbackUrl: string;
  /** What the browser opens. */
  readonly url: string;
}

/** A sign-in's state, PKCE verifier and challenge, and the address to open, for a callback under `callbackOrigin`. */
export function startOpenRouterSignIn(
  callbackOrigin: string,
  endpoints: OpenRouterEndpoints = OPENROUTER_ENDPOINTS,
): OpenRouterSignInStart {
  const state = randomToken(24);
  const { verifier, challenge } = pkcePair(32);
  const callbackUrl = `${callbackOrigin.replace(/\/+$/u, "")}/oauth/callback?state=${state}`;
  const url = `${endpoints.auth}?callback_url=${encodeURIComponent(callbackUrl)}&code_challenge=${challenge}&code_challenge_method=S256`;
  return { state, verifier, callbackUrl, url };
}

/** The code exchanged for a key. A refusal names the status, never the body, which could echo what was sent. */
async function exchangeOpenRouterCode(input: {
  readonly code: string;
  readonly verifier: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoints?: OpenRouterEndpoints;
}): Promise<string> {
  const response = await (input.fetch ?? globalThis.fetch)((input.endpoints ?? OPENROUTER_ENDPOINTS).keys, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: input.code, code_verifier: input.verifier, code_challenge_method: "S256" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new TaviError(
      "NOT_AUTHORIZED",
      `OpenRouter did not issue a key (HTTP ${String(response.status)}); sign in again, or paste a key instead`,
    );
  // A body that is not JSON is checked below like any unexpected answer.
  const body = (await readJsonBody(response).catch(() => undefined)) as { readonly key?: unknown } | null | undefined;
  if (typeof body?.key !== "string" || body.key.trim() === "")
    throw new TaviError("UNAVAILABLE", "OpenRouter answered without a key; sign in again, or paste a key instead");
  return body.key.trim();
}

/**
 * The canvas's sign-ins on the owner: each owned by its state, used
 * once, and gone after `OPENROUTER_SIGN_IN_TTL_MS`. The callback router hands
 * a state this owns here; the key goes to `onKey`, which stores it, and the
 * outcome is kept for the page to read.
 */
export class OpenRouterSignIns implements OAuthCallbackHandler {
  readonly #flows: SignInFlows<{
    readonly verifier: string;
    readonly onKey: (key: string) => Promise<OnboardingConnectAnswer>;
    claimed?: boolean;
  }>;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #endpoints: OpenRouterEndpoints;

  constructor(
    options: { readonly now?: () => number; readonly fetch?: typeof globalThis.fetch; readonly endpoints?: OpenRouterEndpoints } = {},
  ) {
    this.#flows = new SignInFlows({ ttlMs: OPENROUTER_SIGN_IN_TTL_MS, ...(options.now === undefined ? {} : { now: options.now }) });
    this.#fetch = options.fetch;
    this.#endpoints = options.endpoints ?? OPENROUTER_ENDPOINTS;
  }

  /** A sign-in whose key, once issued, `onKey` stores (as the person typed it), answering the connection it made. */
  start(callbackOrigin: string, onKey: (key: string) => Promise<OnboardingConnectAnswer>): OpenRouterSignInStart {
    const started = startOpenRouterSignIn(callbackOrigin, this.#endpoints);
    this.#flows.add(started.state, { verifier: started.verifier, onKey });
    return started;
  }

  /** How a sign-in stands: waiting, done with its connection, failed, or gone. */
  status(state: string): SignInStatus {
    return this.#flows.status(state);
  }

  owns(state: string): boolean {
    return this.#flows.owns(state);
  }

  async callback(input: OAuthCallbackInput): Promise<OAuthCallbackOutcome> {
    const flow = this.#flows.get(input.state);
    // A state is used once: claimed before anything is awaited, so a second callback with it is refused at once.
    if (flow === undefined || flow.data.claimed === true) return { ok: false, message: "This sign-in is over. Start it again from setup." };
    flow.data.claimed = true;
    const settle = (outcome: SignInOutcome) => {
      flow.outcome = outcome;
      return { ok: outcome.ok, message: outcome.message };
    };
    if (input.error !== undefined || input.code === undefined)
      return settle({
        ok: false,
        message:
          input.error === "access_denied"
            ? "You didn't allow access. Nothing was connected."
            : "OpenRouter did not sign you in. Nothing was connected.",
      });
    try {
      const key = await exchangeOpenRouterCode({
        code: input.code,
        verifier: flow.data.verifier,
        ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
        endpoints: this.#endpoints,
      });
      const connection = await flow.data.onKey(key);
      return settle({ ok: true, message: "Signed in with OpenRouter. You can close this tab.", connection });
    } catch (error) {
      return settle({ ok: false, message: errorMessage(error) });
    }
  }
}

/** How onboarding keeps a sign-in address out of the process list: the shared-host note's advice. */
export const ONBOARD_SHARED_HOST_REMEDY = "if that matters, choose an API key instead of signing in.";

export interface TerminalSignInOptions {
  /** Opens the address in the person's browser; false when it could not, and it is printed instead. */
  readonly open?: (url: string) => boolean | Promise<boolean>;
  readonly say: (text: string) => void;
  /** Over SSH (`--paste`): the address the browser landed on, typed back; the listener still waits. */
  readonly paste?: (signal: AbortSignal) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoints?: OpenRouterEndpoints;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const DONE_PAGE =
  "<!doctype html><meta charset=utf-8><title>Tavi</title><p>Signed in with OpenRouter. You can close this tab and go back to the terminal.</p>";
const FAILED_PAGE = "<!doctype html><meta charset=utf-8><title>Tavi</title><p>The sign-in did not finish. Go back to the terminal.</p>";

/**
 * The terminal's sign-in: a listener on an ephemeral 127.0.0.1 port in
 * this process, the browser opened at OpenRouter, and the code that comes
 * back — with this sign-in's state, and nothing else — exchanged for a key. A
 * pasted address finishes it as well. Cancelled or timed out, nothing is
 * stored, because nothing was handed back.
 */
export async function signInWithOpenRouterHere(options: TerminalSignInOptions): Promise<string> {
  let server: Server | undefined;
  const ended = new AbortController();
  // Settles on a cancel or the timeout, whenever it comes: before the listener is up included.
  const stopped = new Promise<never>((_resolve, reject) =>
    ended.signal.addEventListener("abort", () => reject(ended.signal.reason as Error), { once: true }),
  );
  // Awaited or raced elsewhere: this only keeps an early rejection from going unhandled.
  stopped.catch(() => undefined);
  const timer = setTimeout(
    () => ended.abort(new TaviError("CANCELLED", "The sign-in timed out")),
    options.timeoutMs ?? OPENROUTER_SIGN_IN_TTL_MS,
  );
  const outer = () => ended.abort(new TaviError("CANCELLED", "The sign-in was cancelled"));
  if (options.signal?.aborted === true) outer();
  else options.signal?.addEventListener("abort", outer, { once: true });
  try {
    let resolveCode: (input: OAuthCallbackInput) => void = () => undefined;
    const answered = new Promise<OAuthCallbackInput>((resolve) => {
      resolveCode = resolve;
    });
    // The browser's tab is answered once the key is in hand (or not), never before.
    let answerTab: ((ok: boolean) => void) | undefined;
    let started: OpenRouterSignInStart | undefined;
    if (ended.signal.aborted) await stopped;
    const loopback = await listenLoopback(0, (request, response, url) => {
      if (
        request.method !== "GET" ||
        url.pathname !== "/oauth/callback" ||
        started === undefined ||
        url.searchParams.get("state") !== started.state
      ) {
        response.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      const code = url.searchParams.get("code") ?? undefined;
      const error = url.searchParams.get("error") ?? undefined;
      if (answerTab !== undefined) {
        response.writeHead(409, { "content-type": "text/html; charset=utf-8" }).end(FAILED_PAGE);
        return;
      }
      answerTab = (ok) => void response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ok ? DONE_PAGE : FAILED_PAGE);
      resolveCode({
        state: started.state,
        ...(code === undefined ? {} : { code: code.slice(0, 4096) }),
        ...(error === undefined ? {} : { error: error.slice(0, 256) }),
      });
    });
    server = loopback.server;
    started = startOpenRouterSignIn(loopback.origin, options.endpoints);
    const flow = started;
    const opened = await (options.open ?? openAuthorizationUrl)(flow.url);
    options.say(
      opened
        ? "Your browser opened OpenRouter: sign in and allow Tavi there."
        : `Open this address to sign in with OpenRouter:\n  ${flow.url}`,
    );
    const note = opened && options.open === undefined ? oauthSharedHostNote(ONBOARD_SHARED_HOST_REMEDY) : undefined;
    if (note !== undefined) options.say(note.trimEnd());
    if (options.paste !== undefined) {
      const paste = options.paste;
      options.say("On another computer? Paste the address the browser landed on here.");
      // Asked again after a wrong address; a cancel there (Ctrl-C) cancels the sign-in. The listener still waits.
      void (async () => {
        while (!ended.signal.aborted) {
          const pasted = await paste(ended.signal);
          const parsed = pastedCallback(pasted, { redirect: flow.callbackUrl, state: flow.state });
          if (parsed.ok) return resolveCode(parsed.input);
          options.say(parsed.message);
        }
      })().catch((error: unknown) => {
        if (!ended.signal.aborted) ended.abort(error);
      });
    }
    const callback = await Promise.race([answered, stopped]);
    let ok = false;
    try {
      if (callback.code === undefined)
        throw new TaviError(
          "NOT_AUTHORIZED",
          callback.error === "access_denied"
            ? "You didn't allow access. Nothing was connected."
            : "OpenRouter did not sign you in. Nothing was connected.",
        );
      const key = await exchangeOpenRouterCode({
        code: callback.code,
        verifier: flow.verifier,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
      });
      ok = true;
      return key;
    } finally {
      answerTab?.(ok);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", outer);
    ended.abort();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  }
}
