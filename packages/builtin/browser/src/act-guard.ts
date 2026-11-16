import {
  type BrowserActGuard,
  TaviError,
  type BrowserAction,
  BROWSER_ELEMENT_TEXT_MAX_CHARS,
  REVIEW_STEP_HEADING_SOURCE,
  SEARCH_FIELD_WORD_SOURCE,
  SEARCH_FIELD_EXACT_SOURCE,
  DISQUALIFYING_SEARCH_FIELD_SOURCE,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { Locator, Frame } from "playwright";

import { type PressMode, requirePressAllowed, focusedPressFacts, pressFactsOf, isolatedActionFacts } from "./guard.js";
import { requireUnprotected, readFieldFacts, factsOfLocator, isolatedFieldFacts, FIELD_FACTS_TIMEOUT_MS } from "./protected.js";
import { SECRET_FIELD_PATTERN } from "./secrets.js";
import type { PageGlobals } from "./page-globals.js";
import { CLOSED_TARGET_PATTERN } from "./action-kit.js";
import { focusedFrameOf, frameOwnerOf } from "./frames.js";
import { INTERACTIVE_SELECTOR, SCAN_PAGE, SCAN_LIMIT, MAX_HREF_LENGTH, type ScannedElement, type ScannableElement } from "./scan.js";
import type { SessionRecord, StoredElementRef } from "./session-types.js";
import { within } from "./timing.js";

/**
 * The protected-field check at the element, whatever the observation called it:
 * a protected field, or one the page hides, is not typed into, picked in or
 * checked. A click on anything but a field (a button, a link) is not a fill.
 */
/**
 * The page is still on a host the call was decided on (`BrowserActGuard.hosts`),
 * read the moment before the action lands: a page a timer or a redirect moved
 * since is not acted on. An element in a frame needs that frame's own host
 * decided, whatever the page's: a call sent alone on it is asked about there.
 */
export function requireDecidedHost(session: SessionRecord, guard: BrowserActGuard | undefined, stored?: StoredElementRef): void {
  if (guard?.hosts === undefined || guard.hosts.length === 0) return;
  const origin = URL.parse(session.page.url())?.origin;
  const pageHost = origin === undefined || origin === "null" ? "" : (URL.parse(origin)?.host ?? "");
  if (stored?.frame !== undefined) {
    const liveFrameOrigin = URL.parse(typeof stored.frame.url === "function" ? stored.frame.url() : "")?.origin;
    const liveFrameHost = liveFrameOrigin === undefined || liveFrameOrigin === "null" ? "" : (URL.parse(liveFrameOrigin)?.host ?? "");
    if (liveFrameHost !== "" && guard.hosts.includes(liveFrameHost)) return;
    const reportedHost = liveFrameHost !== "" ? liveFrameHost : pageHost;
    throw new TaviError(
      "NOT_AUTHORIZED",
      `the page moved to ${reportedHost === "" ? "a page with no host" : reportedHost} since this call was decided; observe it and act again`,
      { details: { host: reportedHost, decided: [...guard.hosts] } },
    );
  }
  if (pageHost !== "" && guard.hosts.includes(pageHost)) return;
  throw new TaviError(
    "NOT_AUTHORIZED",
    `the page moved to ${pageHost === "" ? "a page with no host" : pageHost} since this call was decided; observe it and act again`,
    { details: { host: pageHost, decided: [...guard.hosts] } },
  );
}

/**
 * A key sent with no element (a ref-less press, keys typed by sight) goes to
 * whatever has focus, which a Tab may have moved into a frame on another
 * site: that frame's host must be among the decided ones, as an element's
 * there must be (`requireDecidedHost`). A call meant for it names the frame's
 * element by ref, and is asked about on that frame's host.
 */
export async function requireFocusDecided(session: SessionRecord, guard: BrowserActGuard | undefined): Promise<void> {
  if (guard?.hosts === undefined || guard.hosts.length === 0) return;
  const focused = await focusedFrameOf(session.page);
  if (focused === "unknown")
    throw new TaviError(
      "NOT_AUTHORIZED",
      "browser refused: the frame that has keyboard focus could not be read; target the element by its ref",
    );
  if (focused === undefined || focused === session.page.mainFrame()) return;
  const host = frameOwnerOf(focused)?.host ?? "";
  if (host === "" || guard.hosts.includes(host)) return;
  throw new TaviError(
    "NOT_AUTHORIZED",
    `keyboard focus is in a frame on ${host}, which this call was not decided on: observe, and target that frame's element by its ref so the call is asked about on ${host}`,
    { details: { host, decided: [...guard.hosts] } },
  );
}

/** The press check: the element about to be pressed, read again against the call's guard. */
async function requireGuarded(
  session: SessionRecord,
  locator: Locator | undefined,
  action: BrowserAction,
  mode: PressMode,
  frame?: Frame,
): Promise<void> {
  if (action.guard === undefined) return;
  await requirePressAllowed(
    locator === undefined
      ? focusedPressFacts(session.page, action.guard, mode)
      : pressFactsOf(locator, session.page, action.guard, mode, frame),
    action.guard,
  );
}

async function requireFillable(locator: Locator, value: string | undefined, frame?: Frame): Promise<void> {
  requireUnprotected(await readFieldFacts(factsOfLocator(locator, frame)), value);
}

function describeRefTarget(stored: StoredElementRef): string {
  const role = stored.role !== undefined && stored.role !== "" ? stored.role : undefined;
  const label = stored.label !== undefined && stored.label !== "" ? JSON.stringify(stored.label) : undefined;
  if (role !== undefined && label !== undefined) return ` (${role} ${label})`;
  if (role !== undefined) return ` (${role})`;
  if (label !== undefined) return ` (${label})`;
  return "";
}

/** Whether the page just asked to keep its unsaved changes ("leave site?"), and was not left. */
export function keptUnsavedChanges(session: SessionRecord): boolean {
  return session.lastDialog?.type === "beforeunload" && session.lastDialog.handled === "dismissed";
}

function throwTargetChanged(ref: string, stored: StoredElementRef): never {
  throw new TaviError("INVALID_INPUT", `${ref}${describeRefTarget(stored)} changed or disappeared: observe again`);
}

/**
 * Combined target identity verification, protected-field check, and press-guard
 * check in a single isolated-world evaluate when CDP is available, or via
 * Playwright's locator reads in unit tests.
 */
export async function resolveTargetAndCheck(
  session: SessionRecord,
  ref: string | undefined,
  stored: StoredElementRef | undefined,
  action: BrowserAction,
  checkOptions: {
    readonly needField: boolean;
    readonly value?: string | undefined;
    readonly mode?: PressMode | undefined;
  },
): Promise<{ readonly locator: Locator | undefined; readonly movedChange?: string | undefined }> {
  const hasCdp = typeof session.page.context === "function" && typeof session.page.context().newCDPSession === "function";
  if (stored === undefined) {
    await requireFocusDecided(session, action.guard);
    if (hasCdp && checkOptions.needField && checkOptions.mode !== undefined && action.guard !== undefined) {
      const both = readFieldFacts(
        isolatedActionFacts(session.page, "focused", {
          needField: true,
          guard: action.guard,
          mode: checkOptions.mode,
        }).then((res) => res as unknown as never),
      ) as unknown as Promise<Awaited<ReturnType<typeof isolatedActionFacts>>>;
      const resolved = await both;
      requireUnprotected(resolved.field, checkOptions.value);
      if (resolved.press !== undefined) await requirePressAllowed(Promise.resolve(resolved.press), action.guard);
      return { locator: undefined };
    }
    if (checkOptions.needField) requireUnprotected(await readFieldFacts(isolatedFieldFacts(session.page, "focused")), checkOptions.value);
    if (checkOptions.mode !== undefined) await requireGuarded(session, undefined, action, checkOptions.mode);
    return { locator: undefined };
  }

  if (hasCdp) {
    const targetCheck =
      stored.key === undefined
        ? undefined
        : {
            index: stored.index,
            key: stored.key,
            occurrence: stored.occurrence,
            textChars: BROWSER_ELEMENT_TEXT_MAX_CHARS * 2,
          };
    const rawPromise = isolatedActionFacts(
      session.page,
      { index: stored.index, target: targetCheck },
      {
        needField: checkOptions.needField,
        guard: action.guard,
        mode: checkOptions.mode,
      },
      stored.frame,
    );
    let resolved: Awaited<ReturnType<typeof isolatedActionFacts>> | undefined;
    if (checkOptions.needField) {
      resolved = (await readFieldFacts(rawPromise.then((res) => res as unknown as never))) as unknown as Awaited<
        ReturnType<typeof isolatedActionFacts>
      >;
    } else if (checkOptions.mode !== undefined && action.guard !== undefined) {
      await requirePressAllowed(
        rawPromise.then((res) => {
          resolved = res;
          return res.press ?? "unknown";
        }),
        action.guard,
      );
    } else {
      resolved = await within(rawPromise, FIELD_FACTS_TIMEOUT_MS);
    }
    if (checkOptions.needField && resolved?.field !== undefined) {
      if (
        resolved.verify === undefined ||
        resolved.verify.status === "ok" ||
        resolved.verify.status === "moved" ||
        resolved.field === "unknown" ||
        (resolved.field.field && resolved.field.visible)
      ) {
        requireUnprotected(resolved.field, checkOptions.value);
      }
    }
    if (checkOptions.mode !== undefined && action.guard !== undefined && resolved?.press !== undefined) {
      await requirePressAllowed(Promise.resolve(resolved.press), action.guard);
    }
    // A ref whose identity was to be checked and could not be (the read failed or timed out) is not acted on blind.
    if (targetCheck !== undefined && resolved?.verify === undefined) {
      throw new TaviError("INVALID_INPUT", `${ref ?? ""}${describeRefTarget(stored)} could not be checked before acting: observe again`);
    }
    if (resolved?.verify !== undefined) {
      if (resolved.verify.status === "missing" || resolved.verify.status === "ambiguous") {
        throwTargetChanged(ref ?? "", stored);
      }
      if (resolved.verify.status === "moved") {
        if (stored.strict === true) throwTargetChanged(ref ?? "", stored);
        return {
          locator: (stored.frame ?? session.page).locator(INTERACTIVE_SELECTOR).nth(resolved.verify.index),
          movedChange: `${ref ?? ""} moved; acted on it by its label`,
        };
      }
    }
    return { locator: stored.locator };
  }

  let locator = stored.locator;
  let movedChange: string | undefined;
  if (stored.key !== undefined) {
    const matches = (stored.frame ?? session.page).locator(INTERACTIVE_SELECTOR);
    const raw = await matches.evaluateAll(SCAN_PAGE, {
      limit: SCAN_LIMIT,
      textChars: BROWSER_ELEMENT_TEXT_MAX_CHARS * 2,
      hrefChars: MAX_HREF_LENGTH,
      secretPattern: SECRET_FIELD_PATTERN,
      reviewHeading: REVIEW_STEP_HEADING_SOURCE,
      searchFieldWord: SEARCH_FIELD_WORD_SOURCE,
      searchFieldExact: SEARCH_FIELD_EXACT_SOURCE,
      disqualifyingSearchField: DISQUALIFYING_SEARCH_FIELD_SOURCE,
    });
    const scanned = Array.isArray(raw) ? (raw as ScannedElement[]) : raw.elements;
    const visible = scanned.filter((el) => !el.state?.split(/\s+/).includes("hidden"));
    const atIndex = visible.find((el) => el.index === stored.index);
    // Alike at its place is the same element only as the same one of the alike: a shift puts a neighbour there.
    if (atIndex === undefined || atIndex.key !== stored.key || atIndex.occurrence !== stored.occurrence) {
      const matching = visible.filter((el) => el.key === stored.key);
      if (stored.strict !== true && matching.length === 1 && stored.occurrence === 0 && matching[0] !== undefined) {
        const movedLocator = matches.nth(matching[0].index);
        if (movedLocator === undefined) throwTargetChanged(ref ?? "", stored);
        locator = movedLocator;
        movedChange = `${ref ?? ""} moved; acted on it by its label`;
      } else {
        throwTargetChanged(ref ?? "", stored);
      }
    }
  }
  if (checkOptions.needField) await requireFillable(locator, checkOptions.value, stored.frame);
  if (checkOptions.mode !== undefined) await requireGuarded(session, locator, action, checkOptions.mode, stored.frame);
  return { locator, movedChange };
}

/** Hit-tests the center of `element` in the page to name whatever covers it. */
function hitBlockerOf(element: ScannableElement): string | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.left === undefined || rect.top === undefined) return null;
  const view = globalThis as PageGlobals<Pick<ReturnType<ScannableElement["getRootNode"]>, "elementFromPoint">>;
  const ownRoot = element.getRootNode();
  const tester = typeof ownRoot.elementFromPoint === "function" ? ownRoot : view.document;
  if (tester?.elementFromPoint === undefined) return null;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = tester.elementFromPoint(x, y) as ScannableElement | null;
  if (hit === null || hit === (element as unknown) || element.contains?.(hit) === true || hit.contains?.(element) === true) return null;
  const blocker = hit.closest("dialog, [role=dialog], [role=alertdialog], header, footer, nav, aside, [role]") ?? hit;
  const explicitRole = (blocker.getAttribute("role") ?? "").trim().toLowerCase();
  const role = explicitRole !== "" ? explicitRole : blocker.tagName.toLowerCase();
  const label = (blocker.getAttribute("aria-label") ?? blocker.getAttribute("title") ?? blocker.innerText ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return label === "" ? `<${role}>` : `<${role} ${JSON.stringify(label)}>`;
}

/** Maps a Playwright action failure to a concise one-line `TaviError`, never including the call log. */
export async function mapActionError(error: unknown, locator: Locator | undefined, timeoutMs: number): Promise<never> {
  if (error instanceof TaviError) throw error;
  const raw = errorMessage(error);
  if (CLOSED_TARGET_PATTERN.test(raw)) throw error;
  if (locator !== undefined && typeof locator.evaluate === "function" && /intercepts pointer events|Timeout \d+ms exceeded/i.test(raw)) {
    const blocker = await within(
      locator.evaluate(hitBlockerOf).catch(() => null),
      1_000,
    );
    if (typeof blocker === "string" && blocker !== "") {
      throw new TaviError("UNAVAILABLE", `covered by ${blocker}`);
    }
  }
  if (/intercepts pointer events/i.test(raw)) {
    const dialogMatch = /role=["']dialog["'][^>]*aria-label=["']([^"']+)["']/i.exec(raw);
    if (dialogMatch?.[1] !== undefined) {
      throw new TaviError("UNAVAILABLE", `covered by <dialog ${JSON.stringify(dialogMatch[1])}>`);
    }
    throw new TaviError("UNAVAILABLE", "covered by another element");
  }
  if (/element is not visible|\bnot visible\b/i.test(raw)) {
    throw new TaviError("UNAVAILABLE", "not visible");
  }
  if (/element is not enabled|element is disabled|\bdisabled\b/i.test(raw)) {
    throw new TaviError("UNAVAILABLE", "disabled");
  }
  if (/not attached to the DOM|element was detached|frame was detached|\bdetached\b/i.test(raw)) {
    throw new TaviError("INVALID_INPUT", "detached: observe again");
  }
  if (/Timeout \d+ms exceeded|\btimed out\b/i.test(raw)) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    throw new TaviError("UNAVAILABLE", `timed out after ${seconds} s`);
  }
  const concise = (raw.split("\nCall log:")[0] ?? raw).split("\n")[0]?.trim() || "browser action failed";
  throw new TaviError("UNAVAILABLE", concise);
}
