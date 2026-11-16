import {
  type BrowserElementSummary,
  type BrowserTabSummary,
  type BrowserBlock,
  type BrowserObservation,
  DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS,
  type BrowserActionOutcome,
  type BrowserObserveOptions,
  TaviError,
  clipBrowserTitle,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { type SensitiveReason, sensitivityOf, playwrightSensitivePage } from "./sensitivity.js";
import { reportNavigated, recordPage, scheduleThumbnail } from "./navigation.js";
import { SIGNALS_TIMEOUT_MS, hostOfUrl, declineConsent, blockOf, CONSENT_WALL } from "./page-status.js";
import { type AutoRefreshOptions, type ObserveScope, scanElements, cloneRefRegistry } from "./scan.js";
import type { SessionRecord, BrowserRuntime } from "./session-types.js";
import { storedElementOf } from "./sessions.js";
import { within, MAX_KEPT_EPOCHS, TITLE_TIMEOUT_MS } from "./timing.js";

function observationOf(
  sessionId: string,
  session: SessionRecord,
  summaries: readonly BrowserElementSummary[],
  omitted: number,
  title: string | undefined,
  found: {
    readonly tabs?: readonly BrowserTabSummary[] | undefined;
    readonly blocked?: BrowserBlock | undefined;
    readonly consentDeclined?: string | undefined;
    readonly sensitive?: SensitiveReason | undefined;
  },
): BrowserObservation {
  // Said on the first observation after it, then no more.
  const popupClosed = session.returnedFromPopup !== undefined && session.returnedFromPopup === session.page;
  if (popupClosed) session.returnedFromPopup = undefined;
  return {
    sessionId,
    epoch: session.epoch,
    url: session.url,
    ...(title === undefined ? {} : { title }),
    elements: summaries,
    ...(omitted === 0 ? {} : { elementsOmitted: omitted }),
    ...(found.tabs === undefined || found.tabs.length <= 1 ? {} : { tabs: found.tabs }),
    ...definedOnly({ blocked: found.blocked, consentDeclined: found.consentDeclined, sensitive: found.sensitive }),
    ...(popupClosed ? { popupClosed: true as const } : {}),
  };
}

/** The hosts whose pages are never pictured for a workspace. */
export async function blockedHostsOf(ctx: BrowserRuntime, workspaceId: string): Promise<readonly string[]> {
  return ctx.options.noThumbnailHosts === undefined ? DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS : await ctx.options.noThumbnailHosts(workspaceId);
}

/**
 * Why the session's page is sensitive, by the live view's and
 * thumbnails' one rule; `undefined` when it is not. A check that does not
 * finish in time counts as sensitive, as a failed one does (fail closed).
 */
export async function pageSensitivity(ctx: BrowserRuntime, session: SessionRecord): Promise<SensitiveReason | undefined> {
  const blockedHosts = await blockedHostsOf(ctx, session.workspaceId);
  const checked = await within(
    sensitivityOf(playwrightSensitivePage(session.page), blockedHosts).then((reason) => ({ reason })),
    SIGNALS_TIMEOUT_MS,
  );
  return checked === undefined ? "password-field" : checked.reason;
}

/** An action's outcome with the sensitivity of the page it left, unless its fresh `page` says so itself. */
export async function withSensitivity(
  ctx: BrowserRuntime,
  session: SessionRecord,
  outcome: BrowserActionOutcome,
): Promise<BrowserActionOutcome> {
  if (outcome.page !== undefined) return outcome;
  const sensitive = await pageSensitivity(ctx, session);
  return sensitive === undefined ? outcome : { ...outcome, sensitive };
}

export const reportHistoryError = (ctx: BrowserRuntime, error: unknown): void => {
  try {
    ctx.options.onHistoryError?.(error);
  } catch {
    // A reporter that throws must not fail the browser call either.
  }
};

/**
 * Observe the page, naming what blocks it, if anything. After a
 * navigation (`decline`), or on a host the session had not seen before, a
 * cookie banner on it is declined first; nothing else on the page is pressed.
 */
export async function refresh(
  ctx: BrowserRuntime,
  sessionId: string,
  session: SessionRecord,
  decline = false,
  observeOptions?: BrowserObserveOptions,
  autoOptions?: AutoRefreshOptions,
): Promise<BrowserObservation> {
  const currentHost = hostOfUrl(session.page.url());
  let consent: { readonly pressed?: string; readonly wall?: boolean } = {};
  if (!decline && currentHost !== undefined && session.pendingConsent?.host === currentHost) {
    consent = session.pendingConsent.result;
    if (autoOptions?.autoRefresh !== true) session.pendingConsent = undefined;
  } else if (decline || (currentHost !== undefined && currentHost !== session.lastConsentHost)) {
    if (currentHost !== undefined) session.lastConsentHost = currentHost;
    session.pendingConsent = undefined;
    consent = await declineConsent(session.page);
    const settledHost = hostOfUrl(session.page.url());
    if (settledHost !== undefined) {
      session.lastConsentHost = settledHost;
      if (autoOptions?.autoRefresh === true) session.pendingConsent = { host: settledHost, result: consent };
    }
  }
  const consentDeclined = consent.pressed;
  // A scope by ref is resolved against the observation it came from, before this one replaces it.
  const scopeRef = observeOptions?.scope;
  const scopeStored =
    scopeRef !== undefined && typeof scopeRef !== "string" ? storedElementOf(session, sessionId, scopeRef.ref, scopeRef.epoch) : undefined;
  const scope: ObserveScope =
    scopeRef === undefined
      ? undefined
      : typeof scopeRef === "string"
        ? scopeRef
        : { locator: scopeStored!.locator, ...(scopeStored?.frame === undefined ? {} : { frame: scopeStored.frame }) };
  const { summaries, omitted, refs, scopeFound } =
    autoOptions?.preScanned ??
    (await scanElements(
      session.page,
      session.refs,
      scope,
      observeOptions?.filter === "interactive",
      observeOptions?.all === true,
      session.epoch + 1,
      { workspaceId: session.workspaceId, sessionId, isFrameHostAllowed: ctx.options.isFrameHostAllowed },
    ));
  if (!scopeFound) throw new TaviError("INVALID_INPUT", `the page has no ${String(scopeRef)} to observe: observe the whole page`);
  // A ref names one element for the session's life, so observing the same document again keeps
  // the earlier epochs valid: only a new address (or the caller) retires them. A new document
  // already did, on its load (`domcontentloaded`, `framenavigated`).
  const sameDocument = session.observedPage === session.page && (session.page.url() === session.url || session.pdfPage !== undefined);
  session.observedPage = session.page;
  // Unset, the floor is the latest epoch: pinned here, so the one this observation replaces stays valid.
  session.minValidEpoch ??= session.epoch;
  session.epoch += 1;
  session.elementsByEpoch ??= new Map();
  if (autoOptions?.bumpMinEpoch === true || (autoOptions?.autoRefresh !== true && !sameDocument)) {
    session.minValidEpoch = session.epoch;
    session.elementsByEpoch.clear();
  }
  // The oldest epochs still valid are let go past a bound, as stale as a new document's.
  for (const kept of session.elementsByEpoch.keys()) {
    if (kept > session.epoch - MAX_KEPT_EPOCHS) break;
    session.elementsByEpoch.delete(kept);
    session.minValidEpoch = Math.max(session.minValidEpoch ?? 0, kept + 1);
  }
  const prevUrl = session.url;
  session.elements = refs;
  session.elementsByEpoch.set(session.epoch, refs);
  const liveUrl = session.page.url();
  if (session.pdfPage !== undefined) {
    if (liveUrl === "" || liveUrl === "about:blank" || liveUrl === session.pdfPage.url || liveUrl === session.pdfPage.hostPageUrl) {
      session.url = session.pdfPage.url;
    } else {
      session.pdfPage = undefined;
      session.url = liveUrl;
    }
  } else {
    session.url = liveUrl;
  }
  if (decline || session.url !== prevUrl) {
    session.noChangeActions = 0;
    session.lastScrollHeight = undefined;
    session.scrollsWithoutGrowth = 0;
  }
  const nextSig = `${session.url}\u0000${JSON.stringify(summaries)}\u0000${session.lastScrollHeight ?? 0}`;
  if (nextSig !== session.progressSignature) {
    session.progressSignature = nextSig;
    session.noChangeActions = 0;
  }
  if (observeOptions?.withholdValues === true) session.valuesWithheldOn = session.url;
  else if (session.valuesWithheldOn !== undefined && session.valuesWithheldOn !== session.url) session.valuesWithheldOn = undefined;
  const shown = session.valuesWithheldOn === undefined ? summaries : summaries.map(({ value: _withheld, ...summary }) => summary);
  session.observed = { url: session.url, epoch: session.epoch, elements: summaries };
  const rawTitle = clipBrowserTitle(
    await within(
      Promise.resolve().then(() => session.page.title()),
      TITLE_TIMEOUT_MS,
    ),
  );
  const title = rawTitle ?? clipBrowserTitle(session.pdfPage?.title);
  const openPages = session.pages.filter((candidate) => (candidate as { isClosed?: () => boolean }).isClosed?.() !== true);
  let tabs: BrowserTabSummary[] | undefined;
  if (openPages.length > 1) {
    tabs = await Promise.all(
      openPages.map(async (tabPage, index) => {
        const tabTitle =
          tabPage === session.page
            ? title
            : clipBrowserTitle(
                await within(
                  Promise.resolve().then(() => tabPage.title()),
                  TITLE_TIMEOUT_MS,
                ),
              );
        return {
          index,
          url: tabPage.url(),
          ...(tabTitle === undefined ? {} : { title: tabTitle }),
          ...(tabPage === session.page ? { active: true as const } : {}),
        };
      }),
    );
  }
  const blocked = (await blockOf(session.page, title, session.lastStatus)) ?? (consent.wall === true ? CONSENT_WALL : undefined);
  // Checked before the page is recorded: a thumbnail queued below is the last thing the call starts.
  const sensitive = await pageSensitivity(ctx, session);
  if (autoOptions?.autoRefresh !== true) {
    reportNavigated(ctx, session, title);
    await recordPage(ctx, session, title);
    scheduleThumbnail(ctx, session);
  }
  return observationOf(sessionId, session, shown, omitted, title, { tabs, blocked, consentDeclined, sensitive });
}

export async function refreshIfElementsChanged(
  ctx: BrowserRuntime,
  sessionId: string,
  session: SessionRecord,
  previous: readonly BrowserElementSummary[],
  bumpMinEpoch: boolean,
): Promise<BrowserObservation | undefined> {
  const candidateRefs = cloneRefRegistry(session.refs);
  const scanned = await scanElements(session.page, candidateRefs, undefined, false, false, session.epoch + 1, {
    workspaceId: session.workspaceId,
    sessionId,
    isFrameHostAllowed: ctx.options.isFrameHostAllowed,
  });
  const signatureOf = (el: BrowserElementSummary): string => `${el.ref}\u0000${el.frame ?? ""}\u0000${el.role ?? ""}\u0000${el.text ?? ""}`;
  const prevSet = new Set(previous.map(signatureOf));
  const nextSet = new Set(scanned.summaries.map(signatureOf));
  let unchanged = 0;
  for (const sig of nextSet) {
    if (prevSet.has(sig)) unchanged += 1;
  }
  const total = Math.max(prevSet.size, nextSet.size);
  const changedRatio = total === 0 ? 0 : (total - unchanged) / total;
  if (changedRatio < 0.3) return undefined;
  session.refs.byKey.clear();
  for (const [k, v] of candidateRefs.byKey) session.refs.byKey.set(k, v);
  session.refs.used.clear();
  for (const v of candidateRefs.used) session.refs.used.add(v);
  session.refs.next = candidateRefs.next;
  session.refs.since = candidateRefs.since;
  if (session.refs.frames !== undefined && candidateRefs.frames !== undefined) {
    session.refs.frames.clear();
    for (const [k, v] of candidateRefs.frames) session.refs.frames.set(k, v);
  }
  return refresh(ctx, sessionId, session, false, undefined, {
    autoRefresh: true,
    bumpMinEpoch,
    preScanned: scanned,
  });
}
