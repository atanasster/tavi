import { mkdir, rm } from "node:fs/promises";

import { TaviError, BROWSER_CLOSE_REASON_PROFILE_CLEARED } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { LaunchOptions, Page, Browser, BrowserContextOptions, BrowserContext } from "playwright";

import { userAgentFor, signAgentRequest, contextOptionsFor } from "./identity.js";
import { startEgressProxy, egressProxyOption, egressLaunchArgs } from "./egress-proxy.js";
import type { BrowserRuntime } from "./session-types.js";
import { closeSession } from "./sessions.js";
import { ACTION_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS } from "./timing.js";

export async function unconfined<O extends LaunchOptions, T>(
  ctx: BrowserRuntime,
  start: (launchOptions: O) => Promise<T>,
  launchOptions: O,
): Promise<T> {
  if (launchOptions.chromiumSandbox !== true || process.platform !== "linux") return start(launchOptions);
  if (!ctx.ownSandbox) return start({ ...launchOptions, chromiumSandbox: false });
  try {
    return await start(launchOptions);
  } catch (error) {
    const started = await start({ ...launchOptions, chromiumSandbox: false });
    ctx.ownSandbox = false;
    ctx.options.onWarning?.(
      `the browser runs without Chromium's own sandbox, which this host refused (${error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error)}); it is not confined either`,
    );
    return started;
  }
}

/** The launch options, with the egress proxy (and its credentials) once it runs. */
async function launchOptionsNow(ctx: BrowserRuntime): Promise<LaunchOptions> {
  if (ctx.disposed) throw new TaviError("UNAVAILABLE", "The browser has been shut down");
  const check = ctx.options.egress;
  if (check === undefined) return ctx.baseLaunchOptions;
  ctx.egressProxy ??= startEgressProxy(check, (refusal) => ctx.options.onEgressRefused?.(refusal)).catch((error: unknown) => {
    ctx.egressProxy = undefined;
    throw error;
  });
  const proxy = await ctx.egressProxy;
  return {
    ...ctx.baseLaunchOptions,
    proxy: egressProxyOption(proxy),
    args: [...(ctx.baseLaunchOptions.args ?? []), ...egressLaunchArgs()],
  };
}

/**
 * A launched browser's traffic reaches the egress proxy: a page asks for the
 * proxy's canary, which only the proxy answers. A browser whose traffic goes
 * elsewhere (a managed policy that sets its own proxy) is refused.
 */
async function requireEgress(ctx: BrowserRuntime, open: () => Promise<Page>): Promise<void> {
  const proxy = await ctx.egressProxy;
  if (proxy === undefined) return;
  const canary = proxy.canaryUrl();
  const page = await open();
  try {
    // The canary page's own load is not the check: the probe below is.
    await page.goto(canary, { timeout: 15_000 }).catch(() => undefined);
  } finally {
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    await page.close().catch(() => undefined);
  }
  if (!proxy.canarySeen(canary))
    throw new TaviError(
      "UNAVAILABLE",
      "The browser's traffic does not go through Tavi's egress proxy (a managed proxy policy may override it), so it is not run",
    );
}

function ensureBrowser(ctx: BrowserRuntime): Promise<Browser> {
  if (ctx.disposed) return Promise.reject(new TaviError("UNAVAILABLE", "The browser has been shut down"));
  if (ctx.browserPromise === undefined) {
    // A launch failure clears the cached promise so the next
    // `createSession()` retries, rather than wedging this adapter
    // permanently on one transient failure.
    ctx.browserPromise = launchOptionsNow(ctx)
      .then(async (chosen) => {
        const browser = await ctx.launch(chosen);
        try {
          await requireEgress(ctx, async () => {
            const context = await browser.newContext();
            const page = await context.newPage();
            // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
            page.once("close", () => void context.close().catch(() => undefined));
            return page;
          });
        } catch (error) {
          // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
          await browser.close().catch(() => undefined);
          throw error;
        }
        return browser;
      })
      .catch((error: unknown) => {
        ctx.browserPromise = undefined;
        throw error;
      });
  }
  return ctx.browserPromise;
}

const versionOf = (browser: Browser): string | undefined => (typeof browser.version === "function" ? browser.version() : undefined);

/**
 * The user agent sessions present: a desktop Chrome's for the browser's own
 * version. A headed window already says so; headless Chromium says
 * `HeadlessChrome`, which sites answer differently. With profiles the shared
 * browser is not otherwise needed, so the version is read from one launched
 * for it and closed. Read once; a failed launch is retried by the next session.
 */
function userAgent(ctx: BrowserRuntime, useSharedBrowser = false): Promise<string | undefined> {
  if (ctx.display === "headed") return Promise.resolve(undefined);
  ctx.userAgentPromise ??= (async () => {
    if (ctx.options.profileDirectory === undefined || useSharedBrowser || ctx.browserPromise !== undefined) {
      const version = versionOf(await ensureBrowser(ctx));
      return version === undefined ? undefined : userAgentFor(version);
    }
    const probe = await ctx.launch(await launchOptionsNow(ctx));
    try {
      const version = versionOf(probe);
      return version === undefined ? undefined : userAgentFor(version);
    } finally {
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      await (probe as { readonly close?: () => Promise<void> }).close?.().catch(() => undefined);
    }
  })().catch((error: unknown) => {
    ctx.userAgentPromise = undefined;
    throw error;
  });
  return ctx.userAgentPromise;
}

/** `workspaceId`'s profile, opened once in `directory`; a failure is not cached. */
function openProfile(
  ctx: BrowserRuntime,
  workspaceId: string,
  directory: string,
  contextOptions: BrowserContextOptions,
): Promise<BrowserContext> {
  let profile = ctx.profiles.get(workspaceId);
  if (profile === undefined) {
    profile = (async () => {
      await mkdir(directory, { recursive: true });
      const context = await ctx.launchPersistent(directory, { ...(await launchOptionsNow(ctx)), ...contextOptions });
      context.setDefaultTimeout?.(ACTION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout?.(NAVIGATION_TIMEOUT_MS);
      try {
        await requireEgress(ctx, () => context.newPage());
      } catch (error) {
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await context.close().catch(() => undefined);
        throw error;
      }
      context.on("close", () => {
        if (ctx.profiles.get(workspaceId) === profile) ctx.profiles.delete(workspaceId);
      });
      return context;
    })();
    ctx.profiles.set(workspaceId, profile);
    profile.catch(() => {
      if (ctx.profiles.get(workspaceId) === profile) ctx.profiles.delete(workspaceId);
    });
  }
  return profile;
}

/**
 * A route over every request of `context`, when one is needed: the operator's signature on a page's own documents,
 * and, behind the egress proxy, every request passed on as it is. Playwright pauses each request to answer the proxy's
 * credentials, and never resumes one Chromium restarts with the client hints a `Critical-CH` header asks for (every
 * Google page): the page never loads, and nothing on it answers. A request a route of its own continued is resumed
 * on its restart.
 */
async function attachRequestRoute(ctx: BrowserRuntime, context: BrowserContext): Promise<void> {
  const signature = ctx.identity.signature;
  if ((signature === undefined && ctx.options.egress === undefined) || ctx.routedContexts.has(context)) return;
  if (typeof (context as { readonly route?: unknown }).route !== "function") return;
  ctx.routedContexts.add(context);
  await context.route("**/*", async (route, request) => {
    // A page's own document is what a site checks an agent by; its images and scripts go unsigned, unslowed.
    if (signature === undefined || !request.url().startsWith("https://") || request.resourceType() !== "document") {
      await route.continue();
      return;
    }
    try {
      await route.continue({ headers: { ...request.headers(), ...signAgentRequest(request.url(), signature) } });
    } catch {
      await route.continue();
    }
  });
}

/**
 * A new session's context and page: a page of the workspace's profile, or a
 * fresh context of the shared browser. A profile that will not open (another
 * process holds it) is reported and fallen back from; a browser that is not
 * installed is not, since the fallback would fail the same way.
 */
export async function openSessionPage(
  ctx: BrowserRuntime,
  workspaceId: string,
  sessionProfile?: "persistent" | "ephemeral",
): Promise<{ readonly context: BrowserContext; readonly page: Page; readonly shared: boolean }> {
  const contextOptions = contextOptionsFor(ctx.identity, await userAgent(ctx, sessionProfile === "ephemeral"));
  const directory = sessionProfile === "ephemeral" ? undefined : ctx.options.profileDirectory?.(workspaceId);
  // A profile being cleared is gone before a session opens on it: never its old context, nor a launch on a directory being deleted.
  if (directory !== undefined) await ctx.clearing.get(workspaceId);
  if (directory !== undefined) {
    if (ctx.disposed) throw new TaviError("UNAVAILABLE", "The browser has been shut down");
    let profile: BrowserContext | undefined;
    try {
      profile = await openProfile(ctx, workspaceId, directory, contextOptions);
    } catch (error) {
      if (error instanceof TaviError && error.code === "CAPABILITY_MISSING") throw error;
      ctx.options.onWarning?.(
        `the browser profile for workspace ${workspaceId} could not be opened, so this session starts without it: ${errorMessage(error)}`,
      );
    }
    if (profile !== undefined) {
      await attachRequestRoute(ctx, profile);
      // A profile opens with a blank page: the first session takes it rather than leaving it behind.
      const page =
        profile.pages().find((candidate) => !ctx.claimedPages.has(candidate) && candidate.url() === "about:blank") ??
        (await profile.newPage());
      ctx.claimedPages.add(page);
      page.once("close", () => ctx.claimedPages.delete(page));
      return { context: profile, page, shared: true };
    }
  }
  const browser = await ensureBrowser(ctx);
  const context = await browser.newContext(contextOptions);
  context.setDefaultTimeout?.(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout?.(NAVIGATION_TIMEOUT_MS);
  await attachRequestRoute(ctx, context);
  return { context, page: await context.newPage(), shared: false };
}

/** Closes the workspace's sessions and profile and removes its directory; `clearProfile` keeps a session from opening on it meanwhile. */
export async function clearNow(ctx: BrowserRuntime, workspaceId: string): Promise<{ readonly closed: number }> {
  let closed = 0;
  for (const session of ctx.sessions.values()) {
    if (session.workspaceId !== workspaceId || session.state !== "open") continue;
    // Best effort: clearing the profile goes on; the session is dropped either way.
    await closeSession(ctx, session, BROWSER_CLOSE_REASON_PROFILE_CLEARED).catch(() => undefined);
    closed += 1;
  }
  const profile = ctx.profiles.get(workspaceId);
  ctx.profiles.delete(workspaceId);
  // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
  await (await profile?.catch(() => undefined))?.close().catch(() => undefined);
  const directory = ctx.options.profileDirectory?.(workspaceId);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  return { closed };
}
