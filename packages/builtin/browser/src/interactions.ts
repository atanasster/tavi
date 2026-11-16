import {
  type BrowserActionOutcome,
  type BrowserActGuard,
  TaviError,
  BROWSER_SCROLL_DIRECTIONS,
  BROWSER_WAIT_MAX_MS,
  BROWSER_PAGE_MOVED,
} from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";
import type { Locator, Page } from "playwright";

import { playwrightLiveTarget } from "./live.js";
import { requirePressAllowed } from "./guard.js";
import { FIELD_FACTS_TIMEOUT_MS } from "./protected.js";
import type { PageGlobals } from "./page-globals.js";
import {
  SUGGESTION_WAIT_MS,
  SUGGESTION_SHORT_WAIT_MS,
  KEY_DELAY_MS,
  SUGGESTION_POLL_MS,
  SUGGESTION_SETTLE_MS,
  SUGGESTION_SELECTOR,
  SELECT_TIMEOUT_MS,
  NO_SUCH_OPTION,
  LIST_OPTION_SELECTOR,
  scrollElement,
  SCROLL_SETTLE_MS,
  scrollPage,
  WAIT_DEFAULT_MS,
  POPUP_GRACE_MS,
  CLOSED_TARGET_PATTERN,
  POPUP_SETTLE_MS,
  CLICK_LOAD_TIMEOUT_MS,
} from "./action-kit.js";
import { recordNavigation } from "./navigation.js";
import { refresh } from "./observation.js";
import { SIGNALS_TIMEOUT_MS } from "./page-status.js";
import type { SessionRecord, BrowserRuntime } from "./session-types.js";
import { adoptPopup } from "./sessions.js";
import { within } from "./timing.js";

/**
 * Type as a person does, key by key, for a field that suggests as you type
 * (an airport, a city, a search box): the suggestions it opens are listed in
 * a fresh observation, ready to click.
 */
export async function typeKeys(
  ctx: BrowserRuntime,
  session: SessionRecord,
  sessionId: string,
  locator: Locator,
  text: string,
  clear?: boolean,
): Promise<BrowserActionOutcome> {
  // Options already on show (a menu left open) are not this typing's suggestions: only a change is.
  const before = await visibleSuggestions(session.page);
  const hasSuggestionHints =
    typeof locator.evaluate === "function"
      ? await within(
          locator
            .evaluate((el: { getAttribute?(name: string): string | null }) => {
              if (typeof el.getAttribute !== "function") return false;
              const auto = (el.getAttribute("aria-autocomplete") ?? "").trim().toLowerCase();
              const controls = (el.getAttribute("aria-controls") ?? "").trim();
              const list = (el.getAttribute("list") ?? "").trim();
              return (auto !== "" && auto !== "none") || controls !== "" || list !== "";
            })
            .catch(() => false),
          FIELD_FACTS_TIMEOUT_MS,
        )
      : false;
  const suggestionWaitMs = hasSuggestionHints === true ? SUGGESTION_WAIT_MS : SUGGESTION_SHORT_WAIT_MS;
  await locator.click();
  if (clear !== false) {
    await locator.fill("");
  }
  if (text !== "") {
    await locator.pressSequentially(text, { delay: KEY_DELAY_MS });
  }
  let suggested = false;
  for (const deadline = Date.now() + suggestionWaitMs; Date.now() < deadline; ) {
    const now = await visibleSuggestions(session.page);
    if (now !== "" && now !== before) {
      suggested = true;
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(SUGGESTION_POLL_MS, remaining));
  }
  if (!suggested) {
    const now = await visibleSuggestions(session.page);
    if (now !== "" && now !== before) suggested = true;
  }
  // Results that arrive a moment after the list opens.
  if (suggested) await sleep(SUGGESTION_SETTLE_MS);
  const page = await refresh(ctx, sessionId, session);
  return {
    status: "accepted",
    detail: suggested ? "suggestions opened: their options are in `page`; click one to choose it" : "no suggestion list opened",
    page,
  };
}

/** The suggestions on show, as one string of their texts (empty for none), for telling whether typing changed them. */
async function visibleSuggestions(page: Page): Promise<string> {
  const texts = await within(page.locator(SUGGESTION_SELECTOR).allInnerTexts(), SUGGESTION_POLL_MS * 4);
  return texts === undefined ? "" : texts.join("\n");
}

/**
 * Choose an option of a drop-down: a native `<select>` by its option's label,
 * else its value; any other drop-down — the ARIA comboboxes and menu buttons
 * most sites build their own — is opened and its option clicked by name.
 */
export async function selectOption(locator: Locator, option: string, guard?: BrowserActGuard): Promise<BrowserActionOutcome> {
  if (option === "") throw new TaviError("INVALID_INPUT", "browser select needs the option's label or value in value");
  // Typed here: Playwright types the element with the DOM's types, which this package does not declare.
  const native = await locator.evaluate((element: { readonly tagName: string }) => element.tagName === "SELECT");
  if (!native) return chooseFromList(locator, option, guard);
  try {
    await locator.selectOption({ label: option }, { timeout: SELECT_TIMEOUT_MS });
    return { status: "accepted" };
  } catch (byLabel) {
    if (!(byLabel instanceof Error) || !NO_SUCH_OPTION.test(byLabel.message)) throw byLabel;
  }
  try {
    await locator.selectOption(option, { timeout: SELECT_TIMEOUT_MS });
    return { status: "accepted" };
  } catch (byValue) {
    // Only a missing option is the page's answer; a lost session or a detached element is not.
    if (byValue instanceof Error && NO_SUCH_OPTION.test(byValue.message))
      return { status: "rejected", detail: `no option labelled or valued ${JSON.stringify(option)}` };
    throw byValue;
  }
}

/**
 * A custom drop-down: click it open, then click the option named `option` —
 * in the list it names (`aria-controls`, `aria-owns`), exactly or else the
 * first whose name contains it; with no list named, anywhere on the page but
 * only exactly. An option that is not there closes the list again and names
 * the ones that are.
 */
async function chooseFromList(locator: Locator, option: string, guard?: BrowserActGuard): Promise<BrowserActionOutcome> {
  const page = locator.page();
  // The list it controls, when it names one (aria-controls, aria-owns): options elsewhere on the page are not its.
  const owned = (
    await locator.evaluate(
      (element: { getAttribute(name: string): string | null }) =>
        element.getAttribute("aria-controls") ?? element.getAttribute("aria-owns") ?? "",
    )
  )
    .split(/\s+/)
    .filter((id) => id !== "");
  await locator.click();
  const scope = owned.length === 0 ? undefined : page.locator(owned.map((id) => `[id="${id.replace(/["\\]/g, "\\$&")}"]`).join(", "));
  const options = scope === undefined ? page.locator(LIST_OPTION_SELECTOR) : scope.locator(LIST_OPTION_SELECTOR);
  await within(options.first().waitFor({ state: "visible", timeout: SELECT_TIMEOUT_MS }), SELECT_TIMEOUT_MS + 500);
  const names = ((await within(options.allInnerTexts(), SELECT_TIMEOUT_MS)) ?? []).map((name) => name.replace(/\s+/g, " ").trim());
  const wanted = option.replace(/\s+/g, " ").trim().toLowerCase();
  const index = names.findIndex((name) => name.toLowerCase() === wanted);
  // A partial name only within the list the control names: across the whole page it could be any menu's item.
  const chosen = index >= 0 || scope === undefined ? index : names.findIndex((name) => name.toLowerCase().includes(wanted));
  if (chosen < 0) {
    await page.keyboard.press("Escape");
    const offered = names.filter((name) => name !== "").slice(0, 12);
    return {
      status: "rejected",
      detail:
        offered.length === 0
          ? "it opened no list of options: click it and observe what it shows"
          : `no option named ${JSON.stringify(option)}; it offers ${offered.map((name) => JSON.stringify(name)).join(", ")}`,
    };
  }
  // An option is a press like any other: a menu's "Delete account" is refused unless approved as a commit. It is
  // read by the name the list showed, since an option's role is no button's and its place no observed element's.
  if (guard !== undefined)
    await requirePressAllowed(
      Promise.resolve({
        pressable: true,
        label: names[chosen] ?? "",
        submitsForm: false,
        selectorMatched: false,
        headings: [],
        url: page.url(),
      }),
      guard,
    );
  await options.nth(chosen).click();
  return { status: "accepted", detail: `chose ${JSON.stringify(names[chosen])}` };
}

/** Bring an element into view, scroll an element/container along `direction`, or move the page. */
export async function scroll(
  session: SessionRecord,
  page: Page,
  locator: Locator | undefined,
  direction: string | undefined,
): Promise<BrowserActionOutcome> {
  if (locator !== undefined) {
    if (direction === undefined) {
      await locator.scrollIntoViewIfNeeded();
      return { status: "accepted" };
    }
    if (!(BROWSER_SCROLL_DIRECTIONS as readonly string[]).includes(direction)) {
      throw new TaviError("INVALID_INPUT", `browser scroll goes ${BROWSER_SCROLL_DIRECTIONS.join(", ")}, or to a ref`);
    }
    const pos = await locator.evaluate(scrollElement, direction);
    await sleep(SCROLL_SETTLE_MS);
    return {
      status: "accepted",
      detail: `scrolled to ${Math.round(pos.offset)} of ${Math.round(pos.span)} px`,
    };
  }
  const where = direction ?? "down";
  if (!(BROWSER_SCROLL_DIRECTIONS as readonly string[]).includes(where)) {
    throw new TaviError("INVALID_INPUT", `browser scroll goes ${BROWSER_SCROLL_DIRECTIONS.join(", ")}, or to a ref`);
  }
  const position = await page.evaluate(scrollPage, where);
  // Content a page loads as it is scrolled to.
  await sleep(SCROLL_SETTLE_MS);
  if (where === "left" || where === "right") {
    return {
      status: "accepted",
      detail: `scrolled to ${Math.round(position.x ?? 0)} of ${Math.round(position.width ?? 0)} px`,
    };
  }
  // Read once the scroll settled: a smooth scroll is still on its way when `scrollBy` returns.
  const settled = await within(
    Promise.resolve().then(() =>
      page.evaluate(() => {
        const g = globalThis as PageGlobals<{ readonly documentElement: { readonly scrollHeight: number } }>;
        return { height: g.document?.documentElement.scrollHeight, y: g.scrollY, view: g.innerHeight };
      }),
    ),
    SIGNALS_TIMEOUT_MS,
  );
  const postHeight = settled?.height;
  const y = typeof settled?.y === "number" ? settled.y : position.y;
  const view = typeof settled?.view === "number" ? settled.view : position.view;
  const height = typeof postHeight === "number" && Number.isFinite(postHeight) ? Math.max(position.height, postHeight) : position.height;
  let endOfPage = false;
  if (where === "down" || where === "bottom") {
    const prevHeight = session.lastScrollHeight;
    const grew = height > position.height || (prevHeight !== undefined && height > prevHeight);
    // Only a scroll that reached the bottom can find the page's end: on a long page, scrolling on is reading.
    const atBottom = y + view >= height - 2;
    session.lastScrollHeight = height;
    if (grew || !atBottom) {
      session.scrollsWithoutGrowth = 0;
    } else {
      session.scrollsWithoutGrowth = (session.scrollsWithoutGrowth ?? 0) + 1;
      if (session.scrollsWithoutGrowth >= 2) endOfPage = true;
    }
  } else {
    session.lastScrollHeight = height;
  }
  const baseDetail = `scrolled to ${Math.round(y)} of ${Math.round(height)} px`;
  return { status: "accepted", detail: endOfPage ? `${baseDetail} (end of page)` : baseDetail };
}

/** Wait for `text` to show on the page, else for its network to go quiet; then observe it. */
export async function waitFor(
  ctx: BrowserRuntime,
  session: SessionRecord,
  sessionId: string,
  text: string | undefined,
  timeoutMs: number | undefined,
  locator?: Locator,
): Promise<BrowserActionOutcome> {
  const timeout = Math.min(Math.max(timeoutMs ?? WAIT_DEFAULT_MS, 100), BROWSER_WAIT_MAX_MS);
  let detail: string;
  const urlPart = text?.startsWith("url:") === true ? text.slice(4).trim() : undefined;
  if (locator !== undefined) {
    const shown = await within(
      locator.waitFor({ state: "visible", timeout }).then(() => true),
      timeout + 500,
    );
    detail = shown === true ? "the element is showing" : `the element did not show within ${timeout / 1000}s`;
  } else if (urlPart !== undefined && urlPart !== "") {
    const moved = await within(
      session.page.waitForURL((url) => url.href.includes(urlPart), { timeout }).then(() => true),
      timeout + 500,
    );
    detail =
      moved === true
        ? `the address holds ${JSON.stringify(urlPart)}: ${session.page.url()}`
        : `the address did not come to hold ${JSON.stringify(urlPart)} within ${timeout / 1000}s`;
  } else if (text !== undefined && text !== "") {
    const found = await within(
      session.page
        .getByText(text)
        .first()
        .waitFor({ state: "visible", timeout })
        .then(() => true),
      timeout + 500,
    );
    detail = found === true ? `${JSON.stringify(text)} is on the page` : `${JSON.stringify(text)} did not appear within ${timeout / 1000}s`;
  } else {
    const quiet = await within(
      session.page.waitForLoadState("networkidle", { timeout }).then(() => true),
      timeout + 500,
    );
    detail = quiet === true ? "the page went quiet" : `the page was still busy after ${timeout / 1000}s`;
  }
  await recordNavigation(ctx, session);
  return { status: "accepted", detail, page: await refresh(ctx, sessionId, session) };
}

/**
 * Click, and follow wherever the click went. A link that opens a new tab
 * (`target="_blank"`, `window.open`) makes the popup the session's active
 * page while keeping the opener open (up to `MAX_SESSION_PAGES`). When a
 * click closes a popup (`window.close()`), the session returns to its opener,
 * observes it, and says so. A click that starts a file download keeps
 * nothing: the download is canceled, and the call is told to fetch it as a
 * download, which is asked about first.
 */
export async function followClick(
  ctx: BrowserRuntime,
  session: SessionRecord,
  sessionId: string,
  click: () => Promise<void>,
): Promise<BrowserActionOutcome> {
  const clickedPage = session.page;
  const before = clickedPage.url();
  session.returnedFromPopup = undefined;
  // Listened for before the click: the tab opens as the click lands.
  // In a shared profile, another session's tab is not this click's.
  const opened = session.context
    // No opener read: the popup is not taken as this session's.
    .waitForEvent("page", {
      timeout: POPUP_GRACE_MS,
      predicate: async (popup) => !session.shared || session.pages.includes((await popup.opener().catch(() => null)) as Page),
    })
    .catch(() => undefined);
  // Watched whether or not anything could store it: a download a click starts is never kept.
  const downloadStarted =
    typeof clickedPage.waitForEvent === "function"
      ? clickedPage.waitForEvent("download", { timeout: POPUP_GRACE_MS }).catch(() => undefined)
      : Promise.resolve(undefined);
  const closedByEvent = new Promise<boolean>((resolve) => {
    if (typeof clickedPage.once === "function") {
      clickedPage.once("close", () => resolve(true));
    } else if (typeof clickedPage.on === "function") {
      clickedPage.on("close", () => resolve(true));
    }
  });
  try {
    await click();
  } catch (error) {
    const closedMidClick =
      (clickedPage as { isClosed?: () => boolean }).isClosed?.() === true ||
      session.returnedFromPopup !== undefined ||
      session.page !== clickedPage;
    const downloadMidClick = error instanceof Error && /Download is starting/i.test(error.message);
    if (!downloadMidClick && (!closedMidClick || !(error instanceof Error && CLOSED_TARGET_PATTERN.test(error.message)))) {
      throw error;
    }
  }
  const popupClosed =
    (clickedPage as { isClosed?: () => boolean }).isClosed?.() === true ||
    session.returnedFromPopup !== undefined ||
    (session.openers.has(clickedPage) && (await within(closedByEvent, POPUP_SETTLE_MS)) === true);
  if (popupClosed) {
    const idx = session.pages.indexOf(clickedPage);
    if (idx >= 0) session.pages.splice(idx, 1);
    if (session.page === clickedPage) {
      const opener = session.openers.get(clickedPage);
      const next =
        opener !== undefined && session.pages.includes(opener) && (opener as { isClosed?: () => boolean }).isClosed?.() !== true
          ? opener
          : session.pages.findLast((candidate) => (candidate as { isClosed?: () => boolean }).isClosed?.() !== true);
      if (next !== undefined) {
        session.page = next;
        session.lastStatus = undefined;
        if (session.historyId !== undefined) {
          ctx.options.live?.retarget(session.historyId, (ctx.options.liveTarget ?? playwrightLiveTarget)(next));
        }
      }
    }
    session.returnedFromPopup = undefined;
    await sleep(POPUP_SETTLE_MS);
    await recordNavigation(ctx, session);
    const page = await refresh(ctx, sessionId, session, false);
    return {
      status: "accepted",
      detail: `the popup closed; returned to ${session.page.url()}`,
      page,
    };
  }
  await within(session.page.waitForLoadState("domcontentloaded"), CLICK_LOAD_TIMEOUT_MS);
  const [popup, download] = await Promise.all([within(opened, POPUP_SETTLE_MS), within(downloadStarted, POPUP_SETTLE_MS)]);
  if (download !== undefined) {
    // Best effort: the file is not kept either way; a download already done has nothing to cancel.
    await download.cancel().catch(() => undefined);
    await download.delete().catch(() => undefined);
    return {
      status: "rejected",
      detail:
        'this click starts a file download, which was not kept: fetch it with kind: "download" on that element\'s ref (observe for it after a click by sight), which is asked about first',
    };
  }
  if (popup !== undefined) {
    await adoptPopup(ctx, session, popup, clickedPage);
    await within(popup.waitForLoadState("domcontentloaded"), CLICK_LOAD_TIMEOUT_MS);
  }
  const after = session.page.url();
  await recordNavigation(ctx, session);
  if (popup !== undefined) return { status: "accepted", detail: `opened ${after} in a new tab, which this session now shows` };
  // The page it moved to comes back with the action (`page`): nothing to observe first.
  if (after !== before) return { status: "accepted", detail: `${BROWSER_PAGE_MOVED} ${after}` };
  return { status: "accepted" };
}
