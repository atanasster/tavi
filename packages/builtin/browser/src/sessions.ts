import { rm } from "node:fs/promises";

import { TaviError, type BrowserBlock, clipBrowserTitle } from "@tavi/contracts";
import type { Locator, Page } from "playwright";

import { playwrightLiveTarget } from "./live.js";
import { MAX_SESSION_PAGES } from "./action-kit.js";
import { recordNavigation } from "./navigation.js";
import { reportHistoryError } from "./observation.js";
import { blockOf, trackStatus } from "./page-status.js";
import type { SessionRecord, StoredElementRef, BrowserRuntime } from "./session-types.js";
import { within, TITLE_TIMEOUT_MS, ACTION_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS } from "./timing.js";

/**
 * The element `ref` names in `session`'s latest observation. Stale-reference
 * rejection is this port's own responsibility — checked against the
 * session's actual current epoch, matching the fixture's identical
 * discipline (`@tavi/contracts`'s `browser.ts` header comment).
 */
export function storedElementOf(session: SessionRecord, sessionId: string, ref: string, epoch: number | undefined): StoredElementRef {
  const minEpoch = session.minValidEpoch ?? session.epoch;
  if (epoch === undefined || epoch < minEpoch || epoch > session.epoch) {
    // A ref names one element for the session's life: when the latest observation still lists it, say so — one retry, not a re-observe.
    // Alike elements (rows of "Select") are told apart by their order, which a re-sorted list changes: the model checks before acting.
    const still =
      session.elements.has(ref) && (epoch ?? -1) >= session.refs.since
        ? ` ${ref} is listed in the latest observation (epoch ${session.epoch}): check there that it is still the element you meant, then act again with that epoch.`
        : "";
    throw new TaviError(
      "INVALID_INPUT",
      `Element reference for session ${sessionId} is stale (expected epoch ${session.epoch}, got ${epoch ?? "none"}).${still}`,
      {
        details: {
          sessionId,
          expectedEpoch: session.epoch,
          ...(epoch === undefined ? {} : { actualEpoch: epoch }),
          ...(still === "" ? {} : { stillListed: true }),
        },
      },
    );
  }
  // Only the latest epoch falls back to the latest refs: an earlier one without its own map is a document gone since.
  const epochMap = session.elementsByEpoch?.get(epoch) ?? (epoch === session.epoch ? session.elements : undefined);
  if (epochMap === undefined)
    throw new TaviError(
      "INVALID_INPUT",
      `Element reference for session ${sessionId} is stale (expected epoch ${session.epoch}, got ${epoch}): observe again`,
      { details: { sessionId, expectedEpoch: session.epoch, actualEpoch: epoch } },
    );
  const stored = epochMap.get(ref);
  if (stored === undefined) throw new TaviError("INVALID_INPUT", `Unknown element reference ${ref} for session ${sessionId}`);
  return stored;
}

export function elementOf(session: SessionRecord, sessionId: string, ref: string, epoch: number | undefined): Locator {
  return storedElementOf(session, sessionId, ref, epoch).locator;
}

export function clearIdleTimer(session: SessionRecord): void {
  if (session.idleTimer !== undefined) {
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }
}

export function requireOpenSession(ctx: BrowserRuntime, sessionId: string): SessionRecord {
  const session = ctx.sessions.get(sessionId);
  if (session === undefined) {
    throw new TaviError("NOT_FOUND", `No browser session ${sessionId}`);
  }
  if (session.state === "closed") {
    throw new TaviError("UNAVAILABLE", `Browser session ${sessionId} is closed`);
  }
  clearIdleTimer(session);
  // A call of the task's next turn: the session is in use again.
  if (session.inactive) {
    session.inactive = false;
    if (session.historyId !== undefined) {
      ctx.options.live?.activated(session.historyId);
      void recordInactive(ctx, session.historyId, null);
    }
  }
  return session;
}

/**
 * Runs one of the agent's calls on `session`, refused while a person acts
 * in it; a take waits for it to settle.
 */
/**
 * A human check is never solved by the agent:
 * refused in code, not only by prompt, before an action that could answer one.
 */
/** What stands in the way on the session's page now, if anything. */
export async function pageBlock(session: SessionRecord): Promise<BrowserBlock | undefined> {
  const title = clipBrowserTitle(
    await within(
      Promise.resolve().then(() => session.page.title()),
      TITLE_TIMEOUT_MS,
    ),
  );
  return blockOf(session.page, title, session.lastStatus);
}

export async function refuseHumanCheck(session: SessionRecord): Promise<void> {
  const blocked = await pageBlock(session);
  if (blocked?.kind === "captcha" || blocked?.kind === "bot-wall") {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `this page is ${blocked.detail}, which the agent never answers: hand the page to a person (browser.request_handoff) or use another source`,
      { details: { blocked: blocked.kind } },
    );
  }
}

/**
 * `run` as the agent's call; `acts` when it can change the page, so it first waits out an action a cancel abandoned.
 * `run`'s signal aborts when the call is cancelled, so work it waits on (a download) can stop with it.
 */
export async function asAgent<T>(
  ctx: BrowserRuntime,
  session: SessionRecord,
  run: (signal: AbortSignal) => Promise<T>,
  acts = false,
): Promise<T> {
  const done =
    ctx.options.live === undefined || session.historyId === undefined ? () => undefined : ctx.options.live.agentCall(session.historyId);
  // A person held the page since the agent last acted — asked or not (invariant 8): what they typed is theirs.
  const takes = session.historyId === undefined ? 0 : (ctx.options.live?.personTakes?.(session.historyId) ?? 0);
  if (takes > (session.takesSeen ?? 0)) {
    session.takesSeen = takes;
    session.valuesWithheldOn = session.page.url();
  }
  let cancelNow: (() => void) | undefined;
  const aborter = new AbortController();
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancelNow = () => {
      aborter.abort();
      reject(new TaviError("CANCELLED", "Browser action was cancelled; one already under way may still land before it stops"));
    };
  });
  // Avoid unhandled rejection when the call finishes normally without being cancelled.
  void cancelled.catch(() => undefined);
  session.cancelInFlight = cancelNow;
  try {
    // A cancelled action Playwright was still running goes on until it times out: a call that can change the page
    // waits for it first (bounded, and itself cancellable), so the two never interleave in the page.
    if (acts && session.abandoned !== undefined) {
      await Promise.race([within(session.abandoned, ACTION_TIMEOUT_MS + NAVIGATION_TIMEOUT_MS), cancelled]);
      session.abandoned = undefined;
    }
    const running = run(aborter.signal);
    void running.catch(() => undefined);
    try {
      return await Promise.race([running, cancelled]);
    } catch (error) {
      // Every abandoned action that can change the page is waited for, not only the last.
      if (acts && error instanceof TaviError && error.code === "CANCELLED") {
        const still = running.catch(() => undefined);
        session.abandoned = session.abandoned === undefined ? still : Promise.all([session.abandoned, still]);
      }
      throw error;
    }
  } finally {
    if (session.cancelInFlight === cancelNow) session.cancelInFlight = undefined;
    done();
  }
}

/** Whether a person acts in the session now: no thumbnail is taken then (invariant 8). */
export const personActs = (ctx: BrowserRuntime, session: SessionRecord): boolean =>
  ctx.options.live !== undefined &&
  session.historyId !== undefined &&
  (ctx.options.live.controlState(session.historyId) ?? "agent") !== "agent";

export async function recordInactive(ctx: BrowserRuntime, historyId: string, since: string | null): Promise<void> {
  if (ctx.options.history === undefined) return;
  try {
    await ctx.options.history.setInactive({ sessionId: historyId, since });
  } catch (error) {
    reportHistoryError(ctx, error);
  }
}

/** Removes the staged copies of `session`'s uploads, once the pages that could read them are closed. */
export async function removeStagedUploads(session: SessionRecord): Promise<void> {
  const staged = session.uploadDirectories ?? [];
  session.uploadDirectories = undefined;
  // Best effort: a copy that cannot be removed now is left in the owner's private staging directory.
  await Promise.all(staged.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)));
}

/** Close `session` — all of its pages, and its context when not shared — and record why; the shared browser stays. */
export async function closeSession(ctx: BrowserRuntime, session: SessionRecord, reason: string): Promise<void> {
  clearIdleTimer(session);
  const wasOpen = session.state === "open";
  session.state = "closed";
  session.inactive = false;
  const pages = [...session.pages];
  session.pages.length = 0;
  await Promise.all(
    pages.map(async (page) => {
      if (typeof page.close === "function") {
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await page.close().catch(() => undefined);
      }
    }),
  );
  try {
    if (!session.shared) await session.context.close();
  } finally {
    await removeStagedUploads(session);
  }
  if (wasOpen && session.historyId !== undefined) ctx.options.live?.closed(session.historyId, reason);
  if (wasOpen && ctx.options.history !== undefined && session.historyId !== undefined) {
    try {
      await ctx.options.history.close({ sessionId: session.historyId, closedAt: ctx.now(), reason });
    } catch (error) {
      reportHistoryError(ctx, error);
    }
  }
}

/** Adopt a newly opened popup as the session's active page while keeping the opener open (capped at `MAX_SESSION_PAGES`). */
export async function adoptPopup(ctx: BrowserRuntime, session: SessionRecord, popup: Page, opener: Page): Promise<void> {
  if (popup === session.page || session.state === "closed") return;
  if (session.shared) {
    ctx.claimedPages.add(popup);
    popup.once("close", () => ctx.claimedPages.delete(popup));
  }
  if (!session.openers.has(popup)) {
    session.openers.set(popup, opener);
  }
  const existingIdx = session.pages.indexOf(popup);
  if (existingIdx >= 0) session.pages.splice(existingIdx, 1);
  session.pages.push(popup);
  while (session.pages.length > MAX_SESSION_PAGES) {
    // Never the popup, its opener (an OAuth popup posts back to it) or the page shown now, and a page that opened
    // a popup still open only when nothing else is left to close.
    const openersInUse = new Set([...session.openers.entries()].filter(([page]) => session.pages.includes(page)).map(([, by]) => by));
    const spared = (candidate: Page): boolean => candidate === popup || candidate === opener || candidate === session.page;
    const preferred = session.pages.findIndex((candidate) => !spared(candidate) && !openersInUse.has(candidate));
    const oldestInactiveIdx = preferred >= 0 ? preferred : session.pages.findIndex((candidate) => !spared(candidate));
    if (oldestInactiveIdx < 0) break;
    const [evicted] = session.pages.splice(oldestInactiveIdx, 1);
    if (evicted !== undefined) {
      session.openers.delete(evicted);
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      await evicted.close().catch(() => undefined);
    }
  }
  session.page = popup;
  session.lastStatus = undefined;
  trackStatus(session, popup);
  // The opener's refs are not the popup's: an act on one is stale, as when a popup closes.
  session.epoch += 1;
  session.minValidEpoch = session.epoch;
  session.elements = new Map();
  session.elementsByEpoch?.clear();
  if (session.historyId !== undefined) {
    ctx.options.live?.retarget(session.historyId, (ctx.options.liveTarget ?? playwrightLiveTarget)(popup));
  }
}

/** The session's pages still open, in tab order: what `observation.tabs` indexes. */
export function livePagesOf(session: SessionRecord): Page[] {
  return session.pages.filter((candidate) => (candidate as { isClosed?: () => boolean }).isClosed?.() !== true);
}

/**
 * Show `target`, one of the session's pages: the refs of the page shown
 * before name none of its elements, so they are dropped, and the next
 * observation (another page than the one last observed) starts a new floor of
 * valid epochs.
 */
export async function showTab(ctx: BrowserRuntime, session: SessionRecord, target: Page): Promise<void> {
  if (target === session.page) return;
  session.page = target;
  session.lastStatus = undefined;
  session.elements = new Map();
  session.elementsByEpoch?.clear();
  await (target as { bringToFront?: () => Promise<void> }).bringToFront?.().catch(() => undefined);
  if (session.historyId !== undefined) {
    ctx.options.live?.retarget(session.historyId, (ctx.options.liveTarget ?? playwrightLiveTarget)(target));
  }
  await recordNavigation(ctx, session);
}

/**
 * Close one of the session's pages. The page shown moves off it first — to
 * the page that opened it, else the last other one open — so the page's own
 * close listener finds nothing to switch, and the closed page's refs go
 * stale rather than unknown, as a popup's do when it closes itself.
 */
export async function closeTab(ctx: BrowserRuntime, session: SessionRecord, target: Page): Promise<void> {
  if (target === session.page) {
    const opener = session.openers.get(target);
    const others = livePagesOf(session).filter((candidate) => candidate !== target);
    const next = opener !== undefined && others.includes(opener) ? opener : others.at(-1);
    if (next !== undefined) {
      await showTab(ctx, session, next);
      session.epoch += 1;
      session.minValidEpoch = session.epoch;
    }
  }
  const index = session.pages.indexOf(target);
  if (index >= 0) session.pages.splice(index, 1);
  session.openers.delete(target);
  // Best effort: the page may already be closing; nothing is shown from it again either way.
  await target.close().catch(() => undefined);
}
