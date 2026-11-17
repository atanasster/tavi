import { randomUUID } from "node:crypto";

import {
  type BrowserCreateSessionInput,
  type BrowserSessionHandle,
  type BrowserObservation,
  DEFAULT_BROWSER_DOWNLOAD_MAX_MIB,
  TaviError,
  folderFileName,
  type BrowserObserveOptions,
  type BrowserPageText,
  pageTextPiece,
  clipBrowserTitle,
  type BrowserAction,
  type BrowserActionOutcome,
  browserActionNeedsRef,
  BROWSER_PAGE_MOVED,
  type BrowserPageContent,
  BROWSER_CONTENT_MAX_CHARS,
  BROWSER_CONTENT_MAX_LINKS,
  stripTrackingParams,
  type StructuredBlocks,
  STRUCTURED_DATA_MAX_CHARS,
  sanitizeStructuredBlocks,
  type BrowserPointerAction,
  type BrowserActGuard,
  BROWSER_POINTER_WAIT_MAX_MS,
  type BrowserCaptureOptions,
  type BrowserCaptureResult,
  type BrowserCaptureMark,
  type BrowserCaptureScale,
  browserArtifactLabel,
  BROWSER_CLOSE_REASON_CLOSED,
  DEFAULT_BROWSER_SESSION_IDLE_MINUTES,
  BROWSER_CLOSE_REASON_IDLE,
  BROWSER_CLOSE_REASON_RESTART,
  type BrowserPort,
} from "@tavi/contracts";
import { errorMessage, definedOnly } from "@tavi/contracts/util";
import { sleep, prefixedId } from "@tavi/node-kit";
import type { Page, Download } from "playwright";

import { describeChanges } from "./changes.js";
import { namesNetworkShare } from "./egress-proxy.js";
import { playwrightControlTarget } from "./control.js";
import { playwrightLiveTarget } from "./live.js";
import { requirePressAllowed, pressFactsBySight } from "./guard.js";
import { requireUnprotected, readFieldFacts, isolatedFieldFacts } from "./protected.js";
import { keptUnsavedChanges, requireDecidedHost, requireFocusDecided } from "./act-guard.js";
import { limitOf, NAVIGATE_LOAD_GRACE_MS, POPUP_GRACE_MS, KEY_DELAY_MS, CLICK_LOAD_TIMEOUT_MS } from "./action-kit.js";
import { captureForModel, resolveCaptureClip, collectRefMarks, drawMarksOnScreenshot, readImageDimensions } from "./capture.js";
import { readBoundedDownload, sniffDownloadMediaType } from "./download-media.js";
import { visibleChildFrames, refusedFrames } from "./frames.js";
import { followClick } from "./interactions.js";
import { openSessionPage, clearNow } from "./launch.js";
import { liveAction, captureMainPdfNavigation, readPdfBytes, recordNavigation, reportAction, boxOf } from "./navigation.js";
import { reportHistoryError, blockedHostsOf, refresh, pageSensitivity, refreshIfElementsChanged, withSensitivity } from "./observation.js";
import {
  settlePage,
  NAVIGATE_SETTLE_MAX_MS,
  tidyPageText,
  READ_EXTRA_SETTLE_MS,
  pageContentOf,
  READ_TIMEOUT_MS,
  READ_SETTLE_MAX_MS,
  structuredBlocksOf,
} from "./page-read.js";
import { trackStatus, blockOf, recoveryOf, sampleState, networkErrorsSince } from "./page-status.js";
import { perform } from "./perform.js";
import { newRefRegistry } from "./scan.js";
import type { SessionRecord, BrowserRuntime } from "./session-types.js";
import {
  adoptPopup,
  requireOpenSession,
  asAgent,
  storedElementOf,
  refuseHumanCheck,
  pageBlock,
  elementOf,
  closeSession,
  clearIdleTimer,
  personActs,
  recordInactive,
  removeStagedUploads,
} from "./sessions.js";
import { within, untilAborted, stopDownload, TITLE_TIMEOUT_MS, pressModeOf } from "./timing.js";
import { startDownloadMonitor, finishedDownload } from "./transfer.js";

export function portOf(ctx: BrowserRuntime): BrowserPort {
  return {
    async createSession(input: BrowserCreateSessionInput): Promise<BrowserSessionHandle> {
      const { context, page, shared } = await openSessionPage(ctx, input.workspaceId, input.profile);
      const sessionId = `browser-session-${(ctx.counter += 1)}`;
      let historyId: string | undefined;
      if (ctx.options.history !== undefined && input.taskId !== undefined) {
        const candidate = (ctx.options.newHistoryId ?? randomUUID)();
        try {
          await ctx.options.history.open({
            sessionId: candidate,
            workspaceId: input.workspaceId,
            taskId: input.taskId,
            openedAt: ctx.now(),
            ...(input.callId === undefined ? {} : { openedByCallId: input.callId }),
          });
          historyId = candidate;
        } catch (error) {
          reportHistoryError(ctx, error);
        }
      }
      const record: SessionRecord = {
        state: "open",
        epoch: 0,
        url: page.url(),
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        historyId,
        lastThumbnailAt: undefined,
        thumbnailQueue: Promise.resolve(),
        inactive: false,
        context,
        shared,
        page,
        pages: [page],
        openers: new Map(),
        trackedPages: new WeakSet(),
        onActivePageChanged: (next) => {
          if (historyId !== undefined) ctx.options.live?.retarget(historyId, (ctx.options.liveTarget ?? playwrightLiveTarget)(next));
        },
        lastStatus: undefined,
        elements: new Map(),
        heldDialogPages: new Set<Page>(),
        unreportedDialogs: [],
        refs: newRefRegistry(),
      };
      trackStatus(record, page);
      if (historyId !== undefined && input.taskId !== undefined && ctx.options.live !== undefined) {
        const workspaceId = input.workspaceId;
        ctx.options.live.opened({
          sessionId: historyId,
          workspaceId,
          taskId: input.taskId,
          ...(input.callId === undefined ? {} : { openedByCallId: input.callId }),
          target: (ctx.options.liveTarget ?? playwrightLiveTarget)(page),
          blockedHosts: () => blockedHostsOf(ctx, workspaceId),
          control: playwrightControlTarget({
            context,
            page: () => record.page,
            // In a shared profile, only a tab this session's pages opened is its own.
            owns: async (popup) => !shared || record.pages.includes((await popup.opener().catch(() => null)) as Page),
            // A tab the person opened becomes the session's active page while keeping the opener open.
            follow: async (popup) => adoptPopup(ctx, record, popup, record.page),
            heldDialogPages: record.heldDialogPages,
          }),
        });
      }
      ctx.sessions.set(sessionId, record);
      return { sessionId, state: "open" };
    },

    async navigate(sessionId: string, url: string, navigateOptions?: { readonly callId?: string }): Promise<BrowserObservation> {
      // Playwright completes a URL it cannot parse (`localhost…` and `127.0.0.1…` become http://): only an absolute one opens.
      if (!URL.canParse(url) || /^(localhost|127\.0\.0\.1)/i.test(url))
        throw new TaviError("INVALID_INPUT", "browser navigate needs an absolute URL");
      if (namesNetworkShare(url))
        throw new TaviError(
          "INVALID_INPUT",
          "a file:// URL naming a network share is refused: it would reach that server around the proxy",
        );
      const session = requireOpenSession(ctx, sessionId);
      return asAgent(
        ctx,
        session,
        async (signal) => {
          await liveAction(ctx, session, "navigate", navigateOptions?.callId, undefined, async () => {
            session.lastDialog = undefined;
            // A dialog raised while it opens is the navigation's, not the next action's.
            session.unreportedDialogs.length = 0;
            // A page opened by hand is no popup's opener: a popup that closed before says nothing of it.
            session.returnedFromPopup = undefined;
            session.pdfPage = undefined;
            session.lastMainPdfBytes = undefined;
            session.recentErrors = [];
            const maxMiB = await limitOf(ctx.options.downloadMaxMiB, session.workspaceId, DEFAULT_BROWSER_DOWNLOAD_MAX_MIB);
            let resolveNavDownload: ((download: Download) => void) | undefined;
            const navDownload = new Promise<Download>((resolve) => {
              resolveNavDownload = resolve;
            });
            const pageEmitter = session.page as unknown as {
              on?: (event: string, listener: (download: Download) => void) => void;
              off?: (event: string, listener: (download: Download) => void) => void;
              removeListener?: (event: string, listener: (download: Download) => void) => void;
            };
            const onNavDownload = (download: Download): void => resolveNavDownload?.(download);
            pageEmitter.on?.("download", onNavDownload);
            // Watched from before the navigation: a URL that downloads starts the file as it loads.
            const monitor = startDownloadMonitor(session.page, maxMiB, "download");
            let navigationDownload: Download | undefined;
            try {
              await monitor.attachCdp(session);
              // The document, not every subresource: an ad-heavy news page may never
              // fire `load` inside Playwright's 30 s, and the navigation then failed
              // with the article already on screen. A short wait for `load` after it
              // gives scripts that render the content their chance.
              try {
                const gotoResponse = await session.page.goto(url, { waitUntil: "domcontentloaded" });
                await within(session.page.waitForLoadState("load"), NAVIGATE_LOAD_GRACE_MS);
                // Content a script renders after the load (a results list) gets its chance before the page is observed.
                await settlePage(session.page, NAVIGATE_SETTLE_MAX_MS);
                await captureMainPdfNavigation(ctx, session, url, gotoResponse);
              } catch (error) {
                if (keptUnsavedChanges(session)) {
                  throw new TaviError(
                    "INVALID_INPUT",
                    "the page asked to keep its unsaved changes, so Tavi stayed on it: save or submit them first, leave through a link with browser.act and dialog: { accept: true } (asked about first), or hand the page to the person (browser.request_handoff)",
                    { details: { dialog: "beforeunload" } },
                  );
                }
                if (!/Download is starting|net::ERR_ABORTED/i.test(errorMessage(error))) throw error;
                const download = await untilAborted(within(navDownload, POPUP_GRACE_MS), signal);
                if (download === undefined) throw error;
                navigationDownload = download;
                monitor.watchDownload(typeof download.url === "function" ? download.url() : undefined);
                const path = await finishedDownload(download, monitor, signal, error);
                const streamed = await readBoundedDownload(path, monitor.maxBytes);
                if (streamed.overCap) {
                  throw new TaviError("INVALID_INPUT", `Download exceeds the ${maxMiB} MiB size limit`);
                }
                const fileName = folderFileName(download.suggestedFilename(), "document.pdf");
                if (sniffDownloadMediaType(streamed.body, fileName) !== "application/pdf") throw error;
                const text = await readPdfBytes(ctx, streamed.body);
                session.pdfPage = { url, hostPageUrl: session.page.url(), text, title: fileName };
              }
              return { status: "accepted" };
            } finally {
              if (typeof pageEmitter.off === "function") pageEmitter.off("download", onNavDownload);
              else pageEmitter.removeListener?.("download", onNavDownload);
              await monitor.cleanup();
              // Read into memory or refused: the browser's copy is not kept either way.
              if (navigationDownload !== undefined) await stopDownload(navigationDownload, false);
            }
          });
          // A navigation loads a new document even to the same address: every earlier ref is stale.
          return refresh(ctx, sessionId, session, true, undefined, { bumpMinEpoch: true });
        },
        true,
      );
    },

    async observe(sessionId: string, observeOptions?: BrowserObserveOptions): Promise<BrowserObservation> {
      const session = requireOpenSession(ctx, sessionId);
      return asAgent(ctx, session, () => refresh(ctx, sessionId, session, false, observeOptions));
    },

    async read(sessionId: string, offset = 0): Promise<BrowserPageText> {
      const session = requireOpenSession(ctx, sessionId);
      return asAgent(ctx, session, async () => {
        if (session.pdfPage !== undefined) {
          const piece = pageTextPiece(
            { sessionId, url: session.pdfPage.url, title: clipBrowserTitle(session.pdfPage.title) },
            tidyPageText(session.pdfPage.text),
            offset,
          );
          const sensitive = await pageSensitivity(ctx, session);
          return {
            ...piece,
            ...definedOnly({ sensitive }),
          };
        }
        // Content a script renders after the load (a search's results) gets its chance to arrive first;
        // a later piece of the same page was waited for by the first.
        // A page still loading after the first wait gets a longer one before the read gives up on it.
        const first = offset > 0 ? undefined : await settlePage(session.page);
        const loading = first === undefined ? undefined : await settlePage(session.page, READ_EXTRA_SETTLE_MS);
        // The page's readable text, as the page itself lays it out (`innerText`: what is rendered, not scripts or hidden markup).
        const raw = (await within(session.page.evaluate(pageContentOf, { chars: Number.MAX_SAFE_INTEGER, links: 0 }), READ_TIMEOUT_MS))
          ?.text;
        if (typeof raw !== "string") {
          throw new TaviError("UNAVAILABLE", `The text of ${session.page.url()} could not be read within ${READ_TIMEOUT_MS / 1000}s`);
        }
        const pageUrl = session.page.url();
        const childFrames = await visibleChildFrames(session.page);
        const policy = ctx.options.isFrameHostAllowed;
        const refused = await refusedFrames(
          childFrames,
          pageUrl,
          policy === undefined ? undefined : (frameOrigin) => policy(frameOrigin, pageUrl, session.workspaceId, sessionId),
        );
        const frameSections: string[] = [];
        for (const child of childFrames) {
          if (refused.has(child.frame) || typeof (child.frame as { readonly evaluate?: unknown }).evaluate !== "function") continue;
          const frameRaw = await within(
            child.frame.evaluate(pageContentOf, { chars: Number.MAX_SAFE_INTEGER, links: 0 }).catch(() => undefined),
            READ_TIMEOUT_MS,
          );
          const tidiedFrame = typeof frameRaw?.text === "string" ? tidyPageText(frameRaw.text) : "";
          if (tidiedFrame !== "") {
            frameSections.push(`## Frame ${child.prefix} (${child.origin})\n\n${tidiedFrame}`);
          }
        }
        const combinedText = frameSections.length === 0 ? tidyPageText(raw) : tidyPageText(`${raw}\n\n${frameSections.join("\n\n")}`);
        const title = clipBrowserTitle(
          await within(
            Promise.resolve().then(() => session.page.title()),
            TITLE_TIMEOUT_MS,
          ),
        );
        const piece = pageTextPiece({ sessionId, url: session.page.url(), title }, combinedText, offset);
        const blocked = offset > 0 ? undefined : await blockOf(session.page, title, session.lastStatus);
        const recovery =
          offset > 0 || blocked !== undefined
            ? undefined
            : await recoveryOf(session.page, session.epoch === session.observed?.epoch ? session.observed : undefined);
        const sensitive = await pageSensitivity(ctx, session);
        return {
          ...piece,
          ...(loading === undefined
            ? {}
            : {
                stillLoading: `after ${(READ_SETTLE_MAX_MS + READ_EXTRA_SETTLE_MS) / 1000}s the page still showed ${loading}; it may still have been loading, so this text may be incomplete — read again to see whether more arrived`,
              }),
          ...definedOnly({ recovery, blocked, sensitive }),
        };
      });
    },

    async act(action: BrowserAction): Promise<BrowserActionOutcome> {
      const session = requireOpenSession(ctx, action.sessionId);
      if (browserActionNeedsRef(action.kind) && action.ref === undefined) {
        throw new TaviError("INVALID_INPUT", `browser ${action.kind} needs the ref of an element from the session's latest observation`);
      }
      if (action.dialog?.promptText !== undefined && action.dialog.promptText !== "") {
        throw new TaviError(
          "NOT_AUTHORIZED",
          "answering a prompt dialog with text is the person's: ask the person in the live view (`browser.request_handoff`)",
          { details: { dialog: "prompt" } },
        );
      }
      // `back` and the tab kinds act on the session's pages whatever ref came with them; `wait_for` waits for its ref's element when it names one.
      const ref =
        action.kind === "back" || action.kind === "tab" || action.kind === "open_in_tab" || action.kind === "close_tab"
          ? undefined
          : action.ref;
      // Without its epoch, a ref is the latest observation's — acted on only where that observation saw it, never recovered from a move.
      const latest = ref !== undefined && action.epoch === undefined && session.elements.has(ref);
      const found = ref === undefined ? undefined : storedElementOf(session, action.sessionId, ref, latest ? session.epoch : action.epoch);
      const stored = found === undefined || !latest ? found : { ...found, strict: true };
      const actedWith = latest ? `acted with epoch ${session.epoch}` : undefined;
      const locator = stored?.locator;

      // Never the typed value: the live view learns only what kind of action ran where.
      const acted = await asAgent(
        ctx,
        session,
        async () => {
          if (
            action.kind === "click" ||
            action.kind === "type" ||
            action.kind === "press" ||
            action.kind === "select" ||
            action.kind === "drag"
          )
            await refuseHumanCheck(session, locator);
          const outcome = await liveAction(ctx, session, action.kind, action.callId, locator, async () => {
            requireDecidedHost(session, action.guard, stored);
            const errorsAtStart = session.networkErrorsSeen ?? 0;
            if ((session.noChangeActions ?? 0) >= 6) {
              return {
                status: "rejected",
                detail: "No change in the last 6 actions: observe, try another approach, or hand off",
              };
            }
            const beforeUrl = session.page.url();
            const before = await sampleState(session.page);
            const prevElements = session.observed?.elements;
            const epochBeforePerform = session.epoch;
            session.lastDialog = undefined;
            session.armedDialog = action.dialog?.accept === true ? action.dialog : undefined;
            let result: BrowserActionOutcome;
            let movedChange: string | undefined;
            let navBumpedMinEpoch = false;
            try {
              const performed = await perform(ctx, session, action, ref, stored);
              result = performed.outcome;
              movedChange = performed.movedChange;
              navBumpedMinEpoch = session.minValidEpoch !== undefined && session.minValidEpoch > epochBeforePerform;
            } finally {
              session.armedDialog = undefined;
            }
            // Every dialog since the last outcome: one raised after an action returned is reported with the next.
            const dialogs = session.unreportedDialogs.splice(0);
            const lastDialog = dialogs.at(-1);
            const dialogInfo = lastDialog === undefined ? {} : { dialog: lastDialog, ...(dialogs.length > 1 ? { dialogs } : {}) };
            // A fresh observation already lists the page as it is: the change summary is for the actions that answer none.
            if (result.page !== undefined) {
              session.noChangeActions = 0;
              return {
                ...result,
                ...(movedChange === undefined ? {} : { changes: [movedChange, ...(result.changes ?? [])] }),
                ...dialogInfo,
              };
            }
            const after = await sampleState(session.page);
            // The outcome already names a page the action moved to.
            const described =
              before === undefined || after === undefined
                ? []
                : describeChanges(before, after, session.valuesWithheldOn !== undefined && session.valuesWithheldOn === before.url).filter(
                    (line) => !(line.startsWith(BROWSER_PAGE_MOVED) && result.detail?.includes(after.url) === true),
                  );
            const changes = movedChange === undefined ? described : [movedChange, ...described];
            const urlChanged =
              session.page.url() !== beforeUrl || (before !== undefined && after !== undefined && after.url !== before.url);
            const overlayChanged =
              before !== undefined &&
              after !== undefined &&
              (after.overlays.some((overlay) => !before.overlays.includes(overlay)) ||
                before.overlays.some((overlay) => !after.overlays.includes(overlay)));
            const kindTriggersPage = action.kind === "submit" || action.kind === "select";
            let attachedPage: BrowserObservation | undefined;
            if (result.status === "accepted" && action.kind !== "download") {
              if (urlChanged || overlayChanged || kindTriggersPage) {
                attachedPage = await refresh(ctx, action.sessionId, session, false, undefined, {
                  autoRefresh: true,
                  urlChanged,
                  bumpMinEpoch: navBumpedMinEpoch,
                });
              } else if (
                prevElements !== undefined &&
                (action.kind === "click" ||
                  action.kind === "press" ||
                  action.kind === "hover" ||
                  action.kind === "scroll" ||
                  action.kind === "drag")
              ) {
                attachedPage = await refreshIfElementsChanged(ctx, action.sessionId, session, prevElements, navBumpedMinEpoch);
              }
            }
            if (before !== undefined && after !== undefined) {
              const scrollProgressed = action.kind === "scroll" && (session.scrollsWithoutGrowth ?? 0) < 2;
              const nonDomAction = action.kind === "download" || action.kind === "upload" || action.kind === "wait_for";
              const substantiveChanges = changes.some((line) => !line.startsWith("focus is on "));
              if (attachedPage !== undefined || substantiveChanges || scrollProgressed || nonDomAction) {
                session.noChangeActions = 0;
              } else {
                // The action ran: it is answered as it went, with a nudge; the next one is refused before it runs.
                session.noChangeActions = (session.noChangeActions ?? 0) + 1;
                if (session.noChangeActions >= 4) {
                  const nudge = "No change in the last 4 actions: observe, try another approach, or hand off";
                  result = {
                    ...result,
                    detail: result.detail === undefined ? nudge : `${result.detail}. ${nudge}`,
                  };
                }
              }
            }
            // An action that took the page elsewhere (a link, a submit, a new tab) is classified as a navigation is.
            const blocked =
              attachedPage !== undefined
                ? attachedPage.blocked
                : before !== undefined && after !== undefined && after.url !== before.url
                  ? await pageBlock(session)
                  : undefined;
            const nonDomAction = action.kind === "download" || action.kind === "upload" || action.kind === "wait_for";
            const changedNothing = changes.length === 0 && attachedPage === undefined && result.page === undefined && !nonDomAction;
            const sinceStart = networkErrorsSince(session, errorsAtStart);
            const includeNetworkErrors = sinceStart.length > 0 && (result.status !== "accepted" || changedNothing);
            return {
              ...result,
              ...(attachedPage === undefined ? {} : { page: attachedPage }),
              ...(changes.length === 0 ? {} : { changes }),
              ...(blocked === undefined ? {} : { blocked }),
              ...dialogInfo,
              ...(includeNetworkErrors ? { networkErrors: sinceStart } : {}),
            };
          });
          return withSensitivity(ctx, session, outcome);
        },
        true,
      );
      return actedWith === undefined ? acted : { ...acted, note: actedWith };
    },

    async content(sessionId: string, contentOptions?: { readonly ref?: string; readonly epoch?: number }): Promise<BrowserPageContent> {
      const session = requireOpenSession(ctx, sessionId);
      return asAgent(ctx, session, async () => {
        if (contentOptions?.ref === undefined && session.pdfPage !== undefined) {
          const text = tidyPageText(session.pdfPage.text);
          const title = clipBrowserTitle(session.pdfPage.title);
          const sensitive = await pageSensitivity(ctx, session);
          return {
            sessionId,
            url: session.pdfPage.url,
            ...(title === undefined ? {} : { title }),
            text: text.slice(0, BROWSER_CONTENT_MAX_CHARS),
            links: [],
            truncated: text.length > BROWSER_CONTENT_MAX_CHARS,
            ...(sensitive === undefined ? {} : { sensitive }),
          };
        }
        const scope =
          contentOptions?.ref === undefined ? undefined : elementOf(session, sessionId, contentOptions.ref, contentOptions.epoch);
        // Results a script renders after the load get their chance, as for a read.
        if (scope === undefined) await settlePage(session.page);
        const limits = { chars: BROWSER_CONTENT_MAX_CHARS, links: BROWSER_CONTENT_MAX_LINKS };
        const raw = await within(
          scope === undefined ? session.page.evaluate(pageContentOf, limits) : scope.evaluate(pageContentOf, limits),
          READ_TIMEOUT_MS,
        );
        if (raw === undefined)
          throw new TaviError("UNAVAILABLE", `The content of ${session.page.url()} could not be read within ${READ_TIMEOUT_MS / 1000}s`);
        const title = clipBrowserTitle(
          await within(
            Promise.resolve().then(() => session.page.title()),
            TITLE_TIMEOUT_MS,
          ),
        );
        const sensitive = await pageSensitivity(ctx, session);
        return {
          sessionId,
          url: session.page.url(),
          ...(title === undefined ? {} : { title }),
          text: tidyPageText(raw.text),
          links: raw.links.map((link) => ({ ...(link.text === "" ? {} : { text: link.text }), href: stripTrackingParams(link.href) })),
          truncated: raw.truncated,
          ...(sensitive === undefined ? {} : { sensitive }),
        };
      });
    },

    async currentUrl(sessionId: string): Promise<string | undefined> {
      const session = ctx.sessions.get(sessionId);
      return session?.pdfPage?.url ?? session?.page.url();
    },

    async structured(sessionId: string): Promise<{ readonly url: string; readonly blocks: StructuredBlocks }> {
      const session = requireOpenSession(ctx, sessionId);
      return asAgent(ctx, session, async () => {
        await settlePage(session.page);
        const blocks = await within(session.page.evaluate(structuredBlocksOf, STRUCTURED_DATA_MAX_CHARS), READ_TIMEOUT_MS);
        if (blocks === undefined)
          throw new TaviError(
            "UNAVAILABLE",
            `The structured data of ${session.page.url()} could not be read within ${READ_TIMEOUT_MS / 1000}s`,
          );
        // The page's script context answered it: copied within bounds before the owner reads it.
        return { url: session.page.url(), blocks: sanitizeStructuredBlocks(blocks) };
      });
    },

    async pointer(
      sessionId: string,
      action: BrowserPointerAction,
      pointerOptions?: { readonly callId?: string; readonly guard?: BrowserActGuard },
    ): Promise<BrowserActionOutcome> {
      const session = requireOpenSession(ctx, sessionId);
      const live =
        action.kind === "type"
          ? "type"
          : action.kind === "press"
            ? "press"
            : action.kind === "scroll"
              ? "scroll"
              : action.kind === "wait"
                ? "wait_for"
                : "click";
      if (action.kind !== "wait" && action.kind !== "scroll")
        await refuseHumanCheck(session, action.kind === "click" ? { x: action.x, y: action.y } : undefined);
      return asAgent(
        ctx,
        session,
        () =>
          liveAction(ctx, session, live, pointerOptions?.callId, undefined, async () => {
            requireDecidedHost(session, pointerOptions?.guard);
            const before = session.page.url();
            const errorsAtStart = session.networkErrorsSeen ?? 0;
            const page = session.page;
            switch (action.kind) {
              case "click":
                // The control at the point is read again against the call's guard.
                if (pointerOptions?.guard !== undefined)
                  await requirePressAllowed(
                    pressFactsBySight(page, { x: action.x, y: action.y }, pointerOptions.guard, "press"),
                    pointerOptions.guard,
                  );
                // A click by sight on a protected checkbox or field is refused, as one by ref is.
                requireUnprotected(await readFieldFacts(isolatedFieldFacts(page, { x: action.x, y: action.y })));
                // A click by sight that opens a tab moves the session to it, as an element's click does.
                return followClick(ctx, session, sessionId, () =>
                  page.mouse.click(action.x, action.y, action.double === true ? { clickCount: 2 } : undefined),
                );
              case "type":
                // Keys typed by sight go wherever focus is: into a frame only on a decided host.
                await requireFocusDecided(session, pointerOptions?.guard);
                // Keys typed by sight go into the focused field: a protected one is the person's.
                requireUnprotected(await readFieldFacts(isolatedFieldFacts(page, "focused")), action.text);
                // A newline is Enter, and a space on a focused button presses it: each checked as that press.
                if (pointerOptions?.guard !== undefined && /[\r\n ]/.test(action.text))
                  await requirePressAllowed(
                    pressFactsBySight(page, "focused", pointerOptions.guard, /[\r\n]/.test(action.text) ? "enter" : "press"),
                    pointerOptions.guard,
                  );
                await page.keyboard.type(action.text, { delay: KEY_DELAY_MS });
                break;
              case "press": {
                await requireFocusDecided(session, pointerOptions?.guard);
                requireUnprotected(await readFieldFacts(isolatedFieldFacts(page, "focused")));
                const mode = pressModeOf(action.key);
                if (pointerOptions?.guard !== undefined && mode !== undefined)
                  await requirePressAllowed(pressFactsBySight(page, "focused", pointerOptions.guard, mode), pointerOptions.guard);
                await page.keyboard.press(action.key);
                break;
              }
              case "scroll":
                await page.mouse.move(action.x, action.y);
                await page.mouse.wheel(action.dx, action.dy);
                break;
              case "drag":
                // A stroke on a signature pad, or a drag onto a field, is the person's.
                requireUnprotected(await readFieldFacts(isolatedFieldFacts(page, { x: action.x, y: action.y })));
                requireUnprotected(await readFieldFacts(isolatedFieldFacts(page, { x: action.toX, y: action.toY })));
                // A drag presses what is at its start, and one that ends where it began is a click there.
                if (pointerOptions?.guard !== undefined)
                  await requirePressAllowed(
                    pressFactsBySight(page, { x: action.x, y: action.y }, pointerOptions.guard, "press"),
                    pointerOptions.guard,
                  );
                await page.mouse.move(action.x, action.y);
                await page.mouse.down();
                await page.mouse.move(action.toX, action.toY, { steps: 12 });
                await page.mouse.up();
                break;
              case "wait":
                await sleep(Math.min(Math.max(action.ms, 0), BROWSER_POINTER_WAIT_MAX_MS));
                break;
            }
            // A click or a key can load another page, as an element's can.
            await within(session.page.waitForLoadState("domcontentloaded"), CLICK_LOAD_TIMEOUT_MS);
            await recordNavigation(ctx, session);
            // The page changed under the agent's refs by sight: they are stale until it observes again.
            if (action.kind !== "wait") {
              session.epoch += 1;
              session.elements = new Map();
            }
            const after = session.page.url();
            if (after === before) {
              const sinceStart = networkErrorsSince(session, errorsAtStart);
              return { status: "accepted", ...(sinceStart.length === 0 ? {} : { networkErrors: sinceStart }) };
            }
            const blocked = await pageBlock(session);
            return { status: "accepted", detail: `${BROWSER_PAGE_MOVED} ${after}`, ...(blocked === undefined ? {} : { blocked }) };
          }).then((outcome) => withSensitivity(ctx, session, outcome)),
        true,
      );
    },

    async capture(sessionId: string, captureOptions?: BrowserCaptureOptions): Promise<BrowserCaptureResult> {
      const session = requireOpenSession(ctx, sessionId);
      if (ctx.options.artifacts === undefined) {
        throw new TaviError("NOT_CONFIGURED", "No artifact store is configured for this adapter; pass { artifacts } to capture");
      }
      if (captureOptions?.forModel === true) return captureForModel(ctx, sessionId, session, ctx.options.artifacts, captureOptions);
      const clip = await resolveCaptureClip(sessionId, session, captureOptions);
      // A person acting in the page is not photographed (invariant 8).
      let buffer = await asAgent(ctx, session, () =>
        clip === undefined ? session.page.screenshot() : session.page.screenshot({ clip, scale: "device" }),
      );
      let marks: BrowserCaptureMark[] | undefined;
      if (captureOptions?.marks === true && clip === undefined) {
        marks = await collectRefMarks(session);
        buffer = await drawMarksOnScreenshot(session.page, buffer, marks, "image/png");
      }
      const vpSize =
        typeof (session.page as { readonly viewportSize?: unknown }).viewportSize === "function" ? session.page.viewportSize() : null;
      const logicalWidth = clip?.width ?? vpSize?.width ?? 1280;
      const logicalHeight = clip?.height ?? vpSize?.height ?? 720;
      const imgDims = readImageDimensions(buffer, logicalWidth, logicalHeight);
      const scale: BrowserCaptureScale = {
        logicalWidth,
        logicalHeight,
        imageWidth: imgDims.width,
        imageHeight: imgDims.height,
      };
      const artifactId = prefixedId("art");
      const artifact = await ctx.options.artifacts.putArtifact({
        artifactId,
        // The page's, with the calling conversation's.
        label: browserArtifactLabel({
          contextLabel: captureOptions?.contextLabel,
          source: "web",
          pageUrl: session.page.url(),
          ref: artifactId,
          at: ctx.now(),
        }),
        workspaceId: session.workspaceId,
        // The task that asked for it, so the capture is not an orphan.
        ...(session.taskId === undefined ? {} : { runId: session.taskId }),
        contentType: "image/png",
        body: buffer,
        extension: "png",
        // A real screenshot is genuinely untrusted external content
        // — created `pending`, never `approved` by
        // default, so `reviewNode` (`@tavi/agent-host`) suspends the turn
        // until an operator decides, the same gate `archiveToolOutput`
        // already applies to oversized sandboxed command output.
        reviewState: "pending",
      });
      return {
        sessionId,
        artifactId: artifact.artifactId,
        capturedAt: ctx.now(),
        scale,
        ...(marks === undefined ? {} : { marks }),
      };
    },

    async cancel(sessionId: string): Promise<void> {
      const session = requireOpenSession(ctx, sessionId);
      session.cancelInFlight?.();
      session.cancelInFlight = undefined;
    },

    // Closes this session's own `BrowserContext` only; the shared `Browser`
    // process `ensureBrowser()` launches outlives it, until `dispose()`.
    async close(sessionId: string): Promise<void> {
      const session = ctx.sessions.get(sessionId);
      if (session === undefined) {
        throw new TaviError("NOT_FOUND", `No browser session ${sessionId}`);
      }
      await closeSession(ctx, session, BROWSER_CLOSE_REASON_CLOSED);
    },

    // Kept open, never closed at once: a chat's logins stay warm for its next turn,
    // and are reaped after `sessionIdleMinutes` if no turn reactivates the session
    // and no live takeover or pending handoff holds it.
    async taskEnded(taskId: string): Promise<void> {
      for (const session of ctx.sessions.values()) {
        if (session.state !== "open" || session.inactive || session.taskId !== taskId) continue;
        session.inactive = true;
        clearIdleTimer(session);
        const idleMinutes = await limitOf(ctx.options.sessionIdleMinutes, session.workspaceId, DEFAULT_BROWSER_SESSION_IDLE_MINUTES);
        // A call that made it active again while the setting was read keeps it open, and in use.
        if (!session.inactive || session.state !== "open") continue;
        const idleMs = idleMinutes > 0 ? Math.round(idleMinutes * 60_000) : 0;
        clearIdleTimer(session);
        if (idleMs > 0) {
          const reapLater = (): void => {
            const timer = setTimeout(() => {
              session.idleTimer = undefined;
              if (ctx.disposed || session.state !== "open" || !session.inactive) return;
              // A takeover or pending handoff holds it: looked at again once it has been idle that long once more.
              if (personActs(ctx, session)) {
                reapLater();
                return;
              }
              void closeSession(ctx, session, BROWSER_CLOSE_REASON_IDLE).catch(() => undefined);
            }, idleMs);
            timer.unref?.();
            session.idleTimer = timer;
          };
          reapLater();
        }
        if (session.historyId === undefined) continue;
        ctx.options.live?.inactive(session.historyId);
        await recordInactive(ctx, session.historyId, ctx.now());
      }
    },

    async pendingAction({ sessionId, ref, epoch, kind, callId, decided }) {
      const session = ctx.sessions.get(sessionId);
      if (session === undefined || session.state !== "open" || session.epoch !== epoch) return;
      if (decided === "denied") {
        reportAction(ctx, session, { phase: "ended", action: kind, status: "rejected", callId });
        return;
      }
      // Read only for its box: nothing is done to the page while it waits.
      const box = await boxOf(session.elements.get(ref)?.locator);
      reportAction(ctx, session, { phase: "pending", action: kind, ...(box === undefined ? {} : { box }), callId });
    },

    handoffTarget(sessionId: string, targetOptions?: { readonly wake?: boolean }) {
      const kept = ctx.sessions.get(sessionId);
      if (
        kept === undefined ||
        kept.state !== "open" ||
        kept.historyId === undefined ||
        kept.taskId === undefined ||
        ctx.options.live === undefined
      )
        return undefined;
      // Every browser call, whichever chat makes it, looks the session up: only a wake for its own task's handoff
      // makes one kept from the chat's last turn in use again (a person can only take one that is open).
      const session = targetOptions?.wake === true ? requireOpenSession(ctx, sessionId) : kept;
      return session.historyId === undefined || session.taskId === undefined
        ? undefined
        : { historyId: session.historyId, taskId: session.taskId };
    },

    async closeRecorded(recordedSessionId: string, reason: string): Promise<boolean> {
      const session = [...ctx.sessions.values()].find(
        (candidate) => candidate.historyId === recordedSessionId && candidate.state === "open",
      );
      if (session === undefined) return false;
      await closeSession(ctx, session, reason);
      return true;
    },

    // The shared `Browser` is a child process: left running, it keeps the
    // embedding Node process alive after everything else has shut down. The
    // composition root calls this as it closes the runtime, before the store
    // the history writes go to.
    async dispose(): Promise<void> {
      if (ctx.disposed) return;
      ctx.disposed = true;
      try {
        for (const session of ctx.sessions.values()) {
          clearIdleTimer(session);
          if (session.state === "closed") continue;
          session.state = "closed";
          // A queued thumbnail sees the session closed and stops; one already
          // running is bounded by its own timeout.
          await session.thumbnailQueue.catch(() => undefined);
          // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
          await (session.shared ? session.page.close() : session.context.close()).catch(() => undefined);
          await removeStagedUploads(session);
          if (session.historyId !== undefined) ctx.options.live?.closed(session.historyId, BROWSER_CLOSE_REASON_RESTART);
          if (ctx.options.history !== undefined && session.historyId !== undefined) {
            try {
              await ctx.options.history.close({ sessionId: session.historyId, closedAt: ctx.now(), reason: BROWSER_CLOSE_REASON_RESTART });
            } catch (error) {
              reportHistoryError(ctx, error);
            }
          }
        }
        const opened = [...ctx.profiles.values()];
        ctx.profiles.clear();
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        for (const profile of opened) await (await profile.catch(() => undefined))?.close().catch(() => undefined);
        const pending = ctx.browserPromise;
        ctx.browserPromise = undefined;
        // A launch that failed already reported its failure to its own caller; there is nothing to close.
        const browser = await pending?.catch(() => undefined);
        await browser?.close();
      } finally {
        // The proxy goes whatever closing the browser did.
        const proxy = ctx.egressProxy;
        ctx.egressProxy = undefined;
        // A proxy that failed to start already reported it; there is nothing to close.
        await (await proxy?.catch(() => undefined))?.close();
      }
    },

    async clearProfile(workspaceId: string): Promise<{ readonly closed: number }> {
      const { promise: cleared, resolve: done } = Promise.withResolvers<void>();
      const previous = ctx.clearing.get(workspaceId);
      ctx.clearing.set(workspaceId, cleared);
      try {
        await previous;
        return await clearNow(ctx, workspaceId);
      } finally {
        done();
        if (ctx.clearing.get(workspaceId) === cleared) ctx.clearing.delete(workspaceId);
      }
    },
  };
}
