import { type BrowserAction, type BrowserActionOutcome, TaviError } from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";
import type { Locator } from "playwright";

import { playwrightLiveTarget } from "./live.js";
import { FIELD_FACTS_TIMEOUT_MS, requireUnprotected, readFieldFacts, isolatedFieldFacts } from "./protected.js";
import { resolveTargetAndCheck, requireDecidedHost, mapActionError } from "./act-guard.js";
import { runWriteAction, CLICK_LOAD_TIMEOUT_MS, NAVIGATE_LOAD_GRACE_MS, CLOSED_TARGET_PATTERN, POPUP_SETTLE_MS } from "./action-kit.js";
import { followClick, typeKeys, selectOption, scroll, waitFor } from "./interactions.js";
import { recordNavigation, captureMainPdfNavigation } from "./navigation.js";
import { refresh } from "./observation.js";
import { settlePage, NAVIGATE_SETTLE_MAX_MS } from "./page-read.js";
import type { SessionRecord, StoredElementRef, BrowserRuntime } from "./session-types.js";
import { storedElementOf, showTab, adoptPopup, closeTab, livePagesOf } from "./sessions.js";
import { ACTION_TIMEOUT_MS, within, pressModeOf } from "./timing.js";
import { requireUploadableArtifact, uploadTo, downloadFrom } from "./transfer.js";

/** One action on `session`'s page; the element is `stored`, when the action takes one. */
export async function perform(
  ctx: BrowserRuntime,
  session: SessionRecord,
  action: BrowserAction,
  ref: string | undefined,
  stored: StoredElementRef | undefined,
): Promise<{ readonly outcome: BrowserActionOutcome; readonly movedChange?: string | undefined }> {
  const requireStored = (): StoredElementRef => {
    if (stored === undefined) throw new TaviError("INVALID_INPUT", `browser ${action.kind} needs a ref`);
    return stored;
  };
  const timeoutMs = action.timeoutMs ?? ACTION_TIMEOUT_MS;
  const callTimeout = action.timeoutMs === undefined ? undefined : { timeout: action.timeoutMs };
  let activeLocator = stored?.locator;
  try {
    switch (action.kind) {
      case "click": {
        // A click checks a checkbox or picks a radio: a protected one is the person's.
        const resolved = await resolveTargetAndCheck(session, ref, requireStored(), action, {
          needField: true,
          mode: "press",
        });
        const target = resolved.locator ?? requireStored().locator;
        activeLocator = target;
        return {
          outcome: await followClick(ctx, session, action.sessionId, () =>
            callTimeout === undefined ? target.click() : target.click(callTimeout),
          ),
          movedChange: resolved.movedChange,
        };
      }
      case "type": {
        // A newline typed key by key is Enter: in a form's field it submits the form. Typing clicks into its
        // target first: on a control rather than a field ("Place order"), that click is a press, checked as one.
        const enterMode = action.mode === "keys" && /[\r\n]/.test(action.value ?? "") ? "enter" : "press";
        const resolved = await resolveTargetAndCheck(session, ref, requireStored(), action, {
          needField: true,
          value: action.value,
          mode: enterMode,
        });
        const target = resolved.locator ?? requireStored().locator;
        activeLocator = target;
        if (action.mode === "keys") {
          return {
            outcome: await typeKeys(ctx, session, action.sessionId, target, action.value ?? "", action.clear),
            movedChange: resolved.movedChange,
          };
        }
        await (callTimeout === undefined ? target.fill(action.value ?? "") : target.fill(action.value ?? "", callTimeout));
        return { outcome: { status: "accepted" }, movedChange: resolved.movedChange };
      }
      case "submit": {
        const resolved = await resolveTargetAndCheck(session, ref, requireStored(), action, {
          needField: false,
          mode: "enter",
        });
        const target = resolved.locator ?? requireStored().locator;
        activeLocator = target;
        // Documented convention: presses Enter on the given ref — works
        // for a focused form field or a submit button. No generic
        // "find the nearest form" heuristic; the caller targets the
        // element that makes sense for the page.
        await runWriteAction("submit", () => (callTimeout === undefined ? target.press("Enter") : target.press("Enter", callTimeout)));
        await recordNavigation(ctx, session);
        return { outcome: { status: "accepted" }, movedChange: resolved.movedChange };
      }
      case "upload": {
        // Validated outside `runWriteAction` on purpose: see `uploadTo`.
        const targetStored = requireStored();
        const upload = await requireUploadableArtifact(ctx, session, action);
        const resolved = await resolveTargetAndCheck(session, ref, targetStored, action, { needField: false });
        const target = resolved.locator ?? targetStored.locator;
        activeLocator = target;
        return {
          outcome: await runWriteAction("upload", () => uploadTo(ctx, session, target, upload)),
          movedChange: resolved.movedChange,
        };
      }
      case "download": {
        const targetStored = requireStored();
        if (ctx.options.artifacts === undefined) {
          throw new TaviError("NOT_CONFIGURED", "No artifact store is configured for this adapter; pass { artifacts } to download");
        }
        // A download clicks its control: one that commits or sends a form is checked as the press it is.
        const resolved = await resolveTargetAndCheck(session, ref, targetStored, action, { needField: false, mode: "press" });
        const target = resolved.locator ?? targetStored.locator;
        activeLocator = target;
        return {
          outcome: await runWriteAction("download", () => downloadFrom(ctx, session, target, action.contextLabel)),
          movedChange: resolved.movedChange,
        };
      }
      case "select": {
        // A site's own list picks by a click on the option, checked as the press it is (`chooseFromList`). Its
        // control only opens the list, though it is often a form's typeless button, which reads as a submit.
        const resolved = await resolveTargetAndCheck(session, ref, requireStored(), action, {
          needField: true,
          value: action.value,
        });
        const target = resolved.locator ?? requireStored().locator;
        activeLocator = target;
        return {
          outcome: await selectOption(target, action.value ?? "", action.guard),
          movedChange: resolved.movedChange,
        };
      }
      case "hover": {
        const resolved = await resolveTargetAndCheck(session, ref, requireStored(), action, { needField: false });
        const target = resolved.locator ?? requireStored().locator;
        activeLocator = target;
        await (callTimeout === undefined ? target.hover() : target.hover(callTimeout));
        return { outcome: { status: "accepted" }, movedChange: resolved.movedChange };
      }
      case "drag": {
        if (action.toRef === undefined && typeof action.dx !== "number" && typeof action.dy !== "number") {
          throw new TaviError("INVALID_INPUT", "browser drag needs toRef or dx/dy");
        }
        // An epoch-less drag's target is the latest observation's too, held where that observation saw it.
        const toLatest = action.toRef !== undefined && action.epoch === undefined && session.elements.has(action.toRef);
        const toFound =
          action.toRef === undefined
            ? undefined
            : storedElementOf(session, action.sessionId, action.toRef, toLatest ? session.epoch : action.epoch);
        const toStored = toFound !== undefined && toLatest ? { ...toFound, strict: true } : toFound;
        // The drop target is held to the decided hosts too, as the source is: one in a frame on another site is not dropped on.
        if (toStored !== undefined) requireDecidedHost(session, action.guard, toStored);
        // A drag presses its source, and one that ends where it began is a click on it.
        const resolved = await resolveTargetAndCheck(session, ref, requireStored(), action, { needField: true, mode: "press" });
        const source = resolved.locator ?? requireStored().locator;
        activeLocator = source;
        let toTarget: Locator | undefined;
        if (toStored !== undefined) {
          const toResolved = await resolveTargetAndCheck(session, action.toRef, toStored, action, { needField: true });
          toTarget = toResolved.locator ?? toStored.locator;
        }
        if (typeof source.scrollIntoViewIfNeeded === "function") {
          await source.scrollIntoViewIfNeeded().catch(() => undefined);
        }
        const srcBox = await source.boundingBox();
        if (srcBox === null || srcBox === undefined) throw new TaviError("UNAVAILABLE", "not visible");
        const rangeThumbRatio =
          typeof source.evaluate === "function"
            ? await within(
                source
                  .evaluate(
                    (el: {
                      readonly tagName?: string;
                      readonly type?: unknown;
                      readonly min?: unknown;
                      readonly max?: unknown;
                      readonly value?: unknown;
                    }) => {
                      if ((el.tagName ?? "").toUpperCase() !== "INPUT" || String(el.type ?? "").toLowerCase() !== "range") return null;
                      const min = Number(el.min === "" || el.min === undefined ? 0 : el.min);
                      const max = Number(el.max === "" || el.max === undefined ? 100 : el.max);
                      const val = Number(el.value === "" || el.value === undefined ? 50 : el.value);
                      if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(val) || max <= min) return null;
                      return Math.min(1, Math.max(0, (val - min) / (max - min)));
                    },
                  )
                  .catch(() => null),
                FIELD_FACTS_TIMEOUT_MS,
              )
            : null;
        const startX =
          typeof rangeThumbRatio === "number"
            ? srcBox.x + Math.max(4, Math.min(srcBox.width - 4, srcBox.width * rangeThumbRatio))
            : srcBox.x + srcBox.width / 2;
        const startY = srcBox.y + srcBox.height / 2;
        let endX: number;
        let endY: number;
        if (toTarget !== undefined) {
          if (typeof toTarget.scrollIntoViewIfNeeded === "function") {
            await toTarget.scrollIntoViewIfNeeded().catch(() => undefined);
          }
          const dstBox = await toTarget.boundingBox();
          if (dstBox === null || dstBox === undefined) throw new TaviError("UNAVAILABLE", "not visible");
          endX = dstBox.x + dstBox.width / 2;
          endY = dstBox.y + dstBox.height / 2;
        } else {
          endX = startX + (action.dx ?? 0);
          endY = startY + (action.dy ?? 0);
        }
        const hasCdp = typeof session.page.context === "function" && typeof session.page.context().newCDPSession === "function";
        if (hasCdp || typeof session.page.evaluate === "function") {
          requireUnprotected(await readFieldFacts(isolatedFieldFacts(session.page, { x: startX, y: startY })));
          requireUnprotected(await readFieldFacts(isolatedFieldFacts(session.page, { x: endX, y: endY })));
        }
        if (session.page.mouse !== undefined) {
          await session.page.mouse.move(startX, startY);
          await session.page.mouse.down();
          await session.page.mouse.move(endX, endY, { steps: 12 });
          await session.page.mouse.up();
        } else if (toTarget !== undefined && typeof source.dragTo === "function") {
          await source.dragTo(toTarget);
        }
        await within(session.page.waitForLoadState("domcontentloaded"), CLICK_LOAD_TIMEOUT_MS);
        await recordNavigation(ctx, session);
        return { outcome: { status: "accepted" }, movedChange: resolved.movedChange };
      }
      case "press": {
        const key = action.value ?? "";
        if (key === "") throw new TaviError("INVALID_INPUT", "browser press needs the key in value, such as Enter, ArrowDown or Escape");
        // A key on a field checks or types into it (Space on a checkbox): a protected one is the person's.
        // Enter submits, Space presses: the control it acts on (the focused one, without a ref) is checked.
        const mode = pressModeOf(key);
        const resolved = await resolveTargetAndCheck(session, ref, stored, action, {
          needField: true,
          mode,
        });
        const target = resolved.locator;
        activeLocator = target;
        if (target === undefined) await session.page.keyboard.press(key);
        else await (callTimeout === undefined ? target.press(key) : target.press(key, callTimeout));
        // A key can submit a form or follow a link, as a click can.
        await within(session.page.waitForLoadState("domcontentloaded"), CLICK_LOAD_TIMEOUT_MS);
        await recordNavigation(ctx, session);
        return { outcome: { status: "accepted" }, movedChange: resolved.movedChange };
      }
      case "scroll": {
        const resolved =
          stored === undefined
            ? { locator: undefined, movedChange: undefined }
            : await resolveTargetAndCheck(session, ref, stored, action, { needField: false });
        activeLocator = resolved.locator;
        return {
          outcome: await scroll(session, session.page, resolved.locator, action.value),
          movedChange: resolved.movedChange,
        };
      }
      case "back": {
        const response = await within(session.page.goBack({ waitUntil: "domcontentloaded" }), CLICK_LOAD_TIMEOUT_MS);
        if (response === null) {
          const current = session.page;
          const opener = session.openers.get(current);
          if (
            opener !== undefined &&
            opener !== current &&
            session.pages.includes(opener) &&
            (opener as { isClosed?: () => boolean }).isClosed?.() !== true
          ) {
            session.page = opener;
            session.lastStatus = undefined;
            session.elements = new Map();
            session.elementsByEpoch?.clear();
            await (opener as { bringToFront?: () => Promise<void> }).bringToFront?.().catch(() => undefined);
            if (session.historyId !== undefined) {
              ctx.options.live?.retarget(session.historyId, (ctx.options.liveTarget ?? playwrightLiveTarget)(opener));
            }
            await recordNavigation(ctx, session);
            return {
              outcome: {
                status: "accepted",
                detail: `returned to opener ${opener.url()}`,
                page: await refresh(ctx, action.sessionId, session, false),
              },
            };
          }
          return { outcome: { status: "rejected", detail: "there is no earlier page in this session" } };
        }
        return {
          outcome: { status: "accepted", page: await refresh(ctx, action.sessionId, session, false, undefined, { bumpMinEpoch: true }) },
        };
      }
      case "tab": {
        const rawIndex = action.tab;
        if (rawIndex === undefined || !Number.isInteger(rawIndex) || rawIndex < 0) {
          throw new TaviError("INVALID_INPUT", "browser tab needs a non-negative tab index in tab");
        }
        const openPages = session.pages.filter((candidate) => (candidate as { isClosed?: () => boolean }).isClosed?.() !== true);
        const targetPage = openPages[rawIndex];
        if (targetPage === undefined) {
          return {
            outcome: {
              status: "rejected",
              detail: `no tab ${rawIndex} (open tabs: 0..${Math.max(0, openPages.length - 1)})`,
            },
          };
        }
        await showTab(ctx, session, targetPage);
        return {
          outcome: {
            status: "accepted",
            detail: `switched to tab ${rawIndex} (${targetPage.url()})`,
            page: await refresh(ctx, action.sessionId, session, false),
          },
        };
      }
      case "open_in_tab": {
        // The tools layer resolved a link's ref to its URL and held it to the navigation policy: here it is only opened.
        const url = action.value ?? "";
        if (!/^https?:\/\//i.test(url)) {
          throw new TaviError("INVALID_INPUT", "browser open_in_tab needs the absolute http(s) URL to open in value");
        }
        const opener = session.page;
        const opened = await session.context.newPage();
        // A tab of its own beside the opener, as a link's new tab is: the opener's refs go stale, its page stays open.
        await adoptPopup(ctx, session, opened, opener);
        session.pdfPage = undefined;
        session.lastMainPdfBytes = undefined;
        try {
          const response = await opened.goto(url, { waitUntil: "domcontentloaded" });
          await within(opened.waitForLoadState("load"), NAVIGATE_LOAD_GRACE_MS);
          await settlePage(opened, NAVIGATE_SETTLE_MAX_MS);
          await captureMainPdfNavigation(ctx, session, url, response);
        } catch (error) {
          // A tab that would not open is not left behind: the session goes back to the page it was on.
          await closeTab(ctx, session, opened);
          throw error;
        }
        await recordNavigation(ctx, session);
        const openPages = livePagesOf(session);
        const from = openPages.indexOf(opener);
        return {
          outcome: {
            status: "accepted",
            detail: `opened ${opened.url()} in tab ${openPages.indexOf(opened)}${from < 0 ? "" : `; tab ${from} (${opener.url()}) stays open, switch back with tab`}`,
            page: await refresh(ctx, action.sessionId, session, false, undefined, { bumpMinEpoch: true }),
          },
        };
      }
      case "close_tab": {
        const openPages = livePagesOf(session);
        const rawIndex = action.tab ?? openPages.indexOf(session.page);
        const targetPage = Number.isInteger(rawIndex) && rawIndex >= 0 ? openPages[rawIndex] : undefined;
        if (targetPage === undefined) {
          return {
            outcome: { status: "rejected", detail: `no tab ${rawIndex} (open tabs: 0..${Math.max(0, openPages.length - 1)})` },
          };
        }
        // The last tab is the session itself: closing it is browser.close's, never a side effect of this.
        if (openPages.length <= 1) {
          return {
            outcome: {
              status: "rejected",
              detail: "that is the session's only tab: Tavi keeps it open; end the session with browser.close",
            },
          };
        }
        const closedUrl = targetPage.url();
        await closeTab(ctx, session, targetPage);
        await recordNavigation(ctx, session);
        return {
          outcome: {
            status: "accepted",
            detail: `closed tab ${rawIndex} (${closedUrl}); the session shows tab ${livePagesOf(session).indexOf(session.page)} (${session.page.url()})`,
            page: await refresh(ctx, action.sessionId, session, false),
          },
        };
      }
      case "wait_for":
        return { outcome: await waitFor(ctx, session, action.sessionId, action.value, action.timeoutMs, stored?.locator) };
    }
  } catch (error) {
    if (session.returnedFromPopup !== undefined && error instanceof Error && CLOSED_TARGET_PATTERN.test(error.message)) {
      const returned = session.returnedFromPopup;
      session.returnedFromPopup = undefined;
      await sleep(POPUP_SETTLE_MS);
      await recordNavigation(ctx, session);
      return {
        outcome: {
          status: "accepted",
          detail: `the popup closed; returned to ${returned.url()}`,
          page: await refresh(ctx, action.sessionId, session, false),
        },
      };
    }
    return mapActionError(error, activeLocator, timeoutMs);
  }
}
