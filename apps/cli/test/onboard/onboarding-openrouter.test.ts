import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { PassThrough } from "node:stream";

import { OnboardingProviderRegistry } from "@tavi/agent-host/onboarding-host";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { OAuthCallbackRouter } from "../../src/features/oauth/core.js";
import { onboardingCommand, type OnboardingCommandDependencies } from "../../src/features/onboard/owner.js";
import {
  OpenRouterSignIns,
  signInWithOpenRouterHere,
  startOpenRouterSignIn,
  type OpenRouterEndpoints,
} from "../../src/features/onboard/openrouter.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * Sign in with OpenRouter: the PKCE flow
 * against a stub authorization server on a free port — the state carried in
 * `callback_url`, the S256 verifier checked at the key exchange — one
 * implementation for the terminal's loopback listener and the owner's
 * callback router, the key never logged, and a cancelled sign-in storing
 * nothing.
 */

const KEY = "sk-or-v1-minted-7d1e";
const cleanups: (() => Promise<unknown> | unknown)[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  directories.cleanup();
});

/** OpenRouter's two endpoints: `/auth` remembers the challenge for a code; `/keys` mints `KEY` only for its verifier. */
async function authorizationServer(): Promise<{
  readonly endpoints: OpenRouterEndpoints;
  readonly exchanges: { code?: string; verifierOk: boolean }[];
}> {
  const challenges = new Map<string, string>();
  const exchanges: { code?: string; verifierOk: boolean }[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => void (body += chunk.toString()));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/keys" && request.method === "POST") {
        const sent = JSON.parse(body) as { code?: string; code_verifier?: string; code_challenge_method?: string };
        const expected = challenges.get(sent.code ?? "");
        const verifierOk =
          expected !== undefined &&
          sent.code_challenge_method === "S256" &&
          createHash("sha256")
            .update(sent.code_verifier ?? "")
            .digest("base64url") === expected;
        exchanges.push({ ...(sent.code === undefined ? {} : { code: sent.code }), verifierOk });
        response
          .writeHead(verifierOk ? 200 : 403, { "content-type": "application/json" })
          .end(JSON.stringify(verifierOk ? { key: KEY } : { error: "invalid code_verifier" }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  // The browser's part: OpenRouter takes the challenge, then sends the person back to callback_url with a code appended.
  const browse = (authUrl: string, code = "code-1"): string => {
    const url = new URL(authUrl);
    challenges.set(code, url.searchParams.get("code_challenge") ?? "");
    const back = new URL(url.searchParams.get("callback_url") ?? "");
    back.searchParams.set("code", code);
    return back.href;
  };
  Object.assign(exchanges, { browse });
  return { endpoints: { auth: `${origin}/auth`, keys: `${origin}/keys` }, exchanges };
}
const browse = (server: { exchanges: unknown }, url: string, code?: string): string =>
  (server.exchanges as unknown as { browse: (url: string, code?: string) => string }).browse(url, code);

describe("the sign-in's address", () => {
  it("carries the state inside callback_url and an S256 challenge of the verifier", () => {
    const started = startOpenRouterSignIn("http://127.0.0.1:4100", {
      auth: "https://openrouter.ai/auth",
      keys: "https://openrouter.ai/api/v1/auth/keys",
    });
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("callback_url")).toBe(`http://127.0.0.1:4100/oauth/callback?state=${started.state}`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(started.verifier).digest("base64url"));
    expect(started.url).not.toContain(started.verifier);
  });
});

describe("signing in from the terminal", () => {
  it("opens the browser, takes the code that comes back with its state, and exchanges it with the verifier for a key", async () => {
    const server = await authorizationServer();
    const said: string[] = [];
    const key = await signInWithOpenRouterHere({
      endpoints: server.endpoints,
      say: (text) => void said.push(text),
      // The browser: follow the address, then land on the callback.
      open: (url) => {
        void fetch(browse(server, url));
        return true;
      },
    });
    expect(key).toBe(KEY);
    expect(server.exchanges.map(({ verifierOk }) => verifierOk)).toEqual([true]);
    expect(said.join("\n")).not.toContain(KEY);
  });

  it("ignores a callback without this sign-in's state, and finishes from a pasted address", async () => {
    const server = await authorizationServer();
    let landed = "";
    const pasted = signInWithOpenRouterHere({
      endpoints: server.endpoints,
      say: () => undefined,
      open: (url) => {
        landed = browse(server, url, "code-2");
        const wrong = new URL(landed);
        wrong.searchParams.set("state", "someone-elses");
        void fetch(wrong.href).catch(() => undefined);
        return false;
      },
      paste: async () => {
        await delay(50);
        return landed;
      },
    });
    expect(await pasted).toBe(KEY);
  });

  it("refuses when the person declines, and stops when cancelled, with no key", async () => {
    const server = await authorizationServer();
    await expect(
      signInWithOpenRouterHere({
        endpoints: server.endpoints,
        say: () => undefined,
        open: (url) => {
          const back = new URL(new URL(url).searchParams.get("callback_url") ?? "");
          back.searchParams.set("error", "access_denied");
          void fetch(back.href);
          return true;
        },
      }),
    ).rejects.toThrow("You didn't allow access");
    const controller = new AbortController();
    const waiting = signInWithOpenRouterHere({
      endpoints: server.endpoints,
      say: () => undefined,
      open: () => true,
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toThrow(/cancelled/u);
    expect(server.exchanges).toHaveLength(0);
  });
});

describe("signing in from the canvas, on the owner", () => {
  it("starts with a loopback callback only, and the router hands the code to the sign-in that owns its state", async () => {
    const server = await authorizationServer();
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const writes: { command: string; payload: Record<string, unknown> }[] = [];
    const signIns = new OpenRouterSignIns({ endpoints: server.endpoints });
    const deps: OnboardingCommandDependencies = {
      repositories: store.asPort().repositories,
      principalOf: () => "operator",
      providers: new OnboardingProviderRegistry(),
      facts: async () => {
        throw new Error("unused");
      },
      census: async () => [],
      channelKinds: () => [],
      appIds: async () => [],
      now: () => new Date("2026-10-20T09:00:00.000Z"),
      signIns,
      config: {
        credentials: async (payload) => {
          writes.push({ command: "credentials", payload: payload as Record<string, unknown> });
          return { ok: true, result: payload.action === "list" ? { credentials: [] } : {} };
        },
        models: async (payload) => {
          writes.push({ command: "models", payload: payload as Record<string, unknown> });
          return {
            ok: true,
            result:
              payload.action === "list"
                ? []
                : payload.action === "discover"
                  ? { models: [{ modelId: "anthropic/claude-sonnet-4.5" }] }
                  : {},
          };
        },
      },
    };
    expect(
      await onboardingCommand(deps, { action: "sign-in", preset: "openrouter", callbackOrigin: "https://evil.example" }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    const started = await onboardingCommand(deps, { action: "sign-in", preset: "openrouter", callbackOrigin: "http://127.0.0.1:4173" });
    if (!started.ok) throw new Error(started.error.message);
    const { url, state } = started.result as { url: string; state: string };
    expect(await onboardingCommand(deps, { action: "sign-in-status", state })).toEqual({ ok: true, result: { state: "waiting" } });
    const router = new OAuthCallbackRouter([signIns], { owns: () => false, callback: async () => ({ ok: false, message: "expired" }) });
    const landed = new URL(browse(server, url));
    expect(landed.origin).toBe("http://127.0.0.1:4173");
    expect(await router.callback({ state: landed.searchParams.get("state") ?? "", code: landed.searchParams.get("code") ?? "" })).toEqual({
      ok: true,
      message: "Signed in with OpenRouter. You can close this tab.",
    });
    expect(await onboardingCommand(deps, { action: "sign-in-status", state })).toMatchObject({
      ok: true,
      result: { state: "done", connectionId: "openrouter" },
    });
    // Stored like a typed key: the connection at OpenRouter's endpoint, then its key.
    expect(writes.map((entry) => `${entry.command}:${String(entry.payload["action"])}`)).toEqual([
      "models:list",
      "credentials:list",
      "models:add",
      "credentials:set",
      "models:discover",
    ]);
    expect(writes.find((entry) => entry.payload["action"] === "set")?.payload).toEqual({
      action: "set",
      reference: "openrouter",
      value: KEY,
    });
    // A state is used once.
    expect(await router.callback({ state, code: "again" })).toMatchObject({ ok: false });
    expect(JSON.stringify(await onboardingCommand(deps, { action: "sign-in-status", state }))).not.toContain(KEY);
  });
});

describe("a state used once, and only while it lasts", () => {
  function signIns(server: Awaited<ReturnType<typeof authorizationServer>>, now: { value: number }) {
    const stored: string[] = [];
    const flows = new OpenRouterSignIns({ endpoints: server.endpoints, now: () => now.value });
    return {
      flows,
      stored,
      start: () =>
        flows.start("http://127.0.0.1:4173", async (key) => {
          stored.push(key);
          return { connectionId: "openrouter", models: [] };
        }),
    };
  }

  it("redeems a state once when two callbacks race, storing the key once", async () => {
    const server = await authorizationServer();
    const { flows, stored, start } = signIns(server, { value: 0 });
    const started = start();
    const landed = new URL(browse(server, started.url));
    const input = { state: started.state, code: landed.searchParams.get("code") ?? "" };
    const [first, second] = await Promise.all([flows.callback(input), flows.callback(input)]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(stored).toEqual([KEY]);
    expect(flows.status(started.state)).toMatchObject({ state: "done" });
  });

  it("refuses an expired state, and a declined sign-in stores nothing", async () => {
    const server = await authorizationServer();
    const now = { value: 0 };
    const { flows, stored, start } = signIns(server, now);
    const old = start();
    now.value = 11 * 60_000;
    expect(flows.owns(old.state)).toBe(false);
    expect(await flows.callback({ state: old.state, code: "c" })).toMatchObject({ ok: false });
    const declined = start();
    expect(await flows.callback({ state: declined.state, error: "access_denied" })).toEqual({
      ok: false,
      message: "You didn't allow access. Nothing was connected.",
    });
    expect(stored).toEqual([]);
    expect(server.exchanges).toHaveLength(0);
  });
});

describe("a pasted address", () => {
  it("is asked again after a wrong one, and a cancel there cancels the sign-in", async () => {
    const server = await authorizationServer();
    let flowUrl = "";
    const pastes = ["https://example.com/not-it"];
    const said: string[] = [];
    const key = await signInWithOpenRouterHere({
      endpoints: server.endpoints,
      say: (text) => void said.push(text),
      open: (url) => {
        flowUrl = url;
        return false;
      },
      paste: async () => pastes.shift() ?? browse(server, flowUrl, "code-3"),
    });
    expect(key).toBe(KEY);
    expect(said).toContain("That address is not where this sign-in comes back to.");
    const cancelled = signInWithOpenRouterHere({
      endpoints: server.endpoints,
      say: () => undefined,
      open: () => false,
      paste: async () => {
        throw new Error("cancelled at the prompt");
      },
    });
    await expect(cancelled).rejects.toThrow("cancelled at the prompt");
  });
});

describe("tavi onboard with OpenRouter", () => {
  it("offers Sign in with OpenRouter first; a declined sign-in falls back to a pasted key, and stopping there stores nothing", async () => {
    const server = await authorizationServer();
    const directory = directories.create("tavi-openrouter-");
    let out = "";
    const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (out += text), isTty: false };
    const input = new PassThrough();
    // OpenRouter (recommended, 1st), sign in (1st); the person declines in the browser, then the input ends at the key.
    input.end("1\n1\n");
    const decline = (url: string) => {
      const back = new URL(new URL(url).searchParams.get("callback_url") ?? "");
      back.searchParams.set("error", "access_denied");
      void fetch(back.href);
      return true;
    };
    const exit = await main(["onboard", "--data-dir", directory], {
      io,
      onboard: {
        input,
        env: {},
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
        sleep: async () => undefined,
        openRouter: { open: decline, endpoints: server.endpoints },
      },
    });
    expect(out).toContain("How do you want to connect OpenRouter?");
    expect(out).toContain("1. Sign in with OpenRouter — opens your browser");
    expect(out).toContain("2. Paste a key instead");
    expect(out).toContain("You didn't allow access. Nothing was connected.");
    expect(out).toContain("OpenRouter key (hidden)");
    expect(exit).toBe(130);
    expect(server.exchanges).toHaveLength(0);
    let listed = "";
    await main(["models", "list", "--data-dir", directory], {
      io: { stdout: (text) => void (listed += text), stderr: () => {}, isTty: false },
    });
    expect(listed).not.toContain("openrouter");
  });
});
