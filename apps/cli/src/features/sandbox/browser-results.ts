import {
  BROWSER_REQUEST_HANDOFF_TOOL_ID,
  type BrowserBlock,
  type BrowserPort,
  type ContentLabel,
  type InvocationContext,
  TOOL_LABEL_KEY,
  TOOL_MEDIA_KEY,
  isUntrusted,
  pageResultLabel,
} from "@tavi/contracts";

/** How a browser tool's result is dressed for the model: a block's hint, a screenshot, the page's label. */

/**
 * What to do about a page that blocks the one asked for. A blocked page is never the answer, and a challenge is never the
 * agent's to solve: a person takes it over (`handoff`, when the live view is
 * served), or the information comes from elsewhere.
 */
export function blockHint(block: BrowserBlock, handoff: boolean): string {
  const elsewhere = "get the information from another source (another site, or a domain tool)";
  const ask = handoff
    ? `call ${BROWSER_REQUEST_HANDOFF_TOOL_ID} so the person can get past it in the live view, or ${elsewhere}`
    : `no person can take over this run's browser, so ${elsewhere}, or report that the site blocked automated access`;
  switch (block.kind) {
    case "captcha":
    case "bot-wall":
    case "rate-limit":
      return `This is ${block.detail}, not the page you asked for, and its text is not an answer. Never try to solve or bypass it: ${ask}.`;
    case "consent":
      return `This is ${block.detail} with no way to decline: accepting is the person's choice, not yours. Do not accept for them: ${ask}.`;
    case "login":
      return `This is ${block.detail}. Never ask for a password or code in the conversation: ${handoff ? `call ${BROWSER_REQUEST_HANDOFF_TOOL_ID} so the person signs in in the live view (the browser keeps the sign-in for later sessions), or ${elsewhere}` : `${elsewhere}, or report that the page needs a sign-in`}.`;
  }
}

/** An observation shows its page when its elements cannot: blocked, or two elements or fewer (a captcha, a canvas, an error page). */
const SCREENSHOT_AT_ELEMENTS = 2;

/**
 * `observation` with a screenshot the model sees, when what it lists cannot
 * say what the page is: blocked, or next
 * to no elements. A page that must not be pictured, or a capture that fails,
 * leaves the observation as it was.
 */
export async function withScreenshot<T>(
  browser: BrowserPort,
  observation: T,
  contextLabel: ContentLabel | undefined,
  wholePage = true,
): Promise<T> {
  const value = observation as { readonly sessionId?: unknown; readonly elements?: unknown; readonly blocked?: unknown };
  if (typeof value.sessionId !== "string" || !Array.isArray(value.elements)) return observation;
  // A scoped or filtered observation is small on purpose: only a blocked page is pictured then.
  if (value.blocked === undefined && (!wholePage || value.elements.length > SCREENSHOT_AT_ELEMENTS)) return observation;
  try {
    const capture = await browser.capture(value.sessionId, { forModel: true, ...(contextLabel === undefined ? {} : { contextLabel }) });
    return {
      ...observation,
      screenshot: capture.artifactId,
      [TOOL_MEDIA_KEY]: { artifactId: capture.artifactId, mediaType: capture.contentType ?? "image/jpeg" },
    };
  } catch {
    return observation;
  }
}

/**
 * `result` labelled with the page it read (`TOOL_LABEL_KEY`): the host of the page's own URL — where it ended up,
 * after redirects — and the title it gives itself, display only. `fallback`:
 * the session's page as last observed, for a result that names none.
 */
export function withPageLabel<T>(result: T, fallback?: string): T {
  if (typeof result !== "object" || result === null) return result;
  const value = result as { readonly url?: unknown; readonly title?: unknown; readonly page?: unknown };
  const nested = value.page as { readonly url?: unknown; readonly title?: unknown } | null | undefined;
  const page =
    typeof value.url === "string"
      ? value
      : typeof nested === "object" && nested !== null && typeof nested.url === "string"
        ? nested
        : undefined;
  const label = page === undefined ? pageResultLabel(fallback) : pageResultLabel(page.url, page.title);
  return label.host === undefined ? result : ({ ...result, [TOOL_LABEL_KEY]: label } as T);
}

const DENSE_PAGE_HINT = "Use browser.find for a control off the list, and browser.extract for dense tables.";

/** `result` with its `blocked` (and a `page`'s) given the hint for this registry, plus a dense-page hint when `elementsOmitted > 40` or `nextOffset` is present. */
export function withBlockHints<T>(result: T, handoff: boolean): T {
  if (typeof result !== "object" || result === null) return result;
  const value = result as {
    readonly blocked?: BrowserBlock;
    readonly page?: unknown;
    readonly elementsOmitted?: unknown;
    readonly nextOffset?: unknown;
    readonly hint?: unknown;
  };
  const blocked = value.blocked === undefined ? {} : { blocked: { ...value.blocked, hint: blockHint(value.blocked, handoff) } };
  const page = value.page === undefined ? {} : { page: withBlockHints(value.page, handoff) };
  const needsDenseHint =
    value.hint === undefined &&
    ((typeof value.elementsOmitted === "number" && value.elementsOmitted > 40) || typeof value.nextOffset === "number");
  const hint = needsDenseHint ? { hint: DENSE_PAGE_HINT } : {};
  return value.blocked === undefined && value.page === undefined && !needsDenseHint
    ? result
    : ({ ...result, ...blocked, ...page, ...hint } as T);
}

/** The call a recipe may replay on: its run, and whether replay is allowed there at all. */
export interface RecipeReplayContext {
  readonly runId: string;
  readonly allowed: boolean;
  readonly signal: AbortSignal;
}

/**
 * Replay acts on a site without asking, so only for a person watching (an
 * attended run) whose chat holds nothing a page or message could have planted.
 */
export function recipeReplayFor(
  context: InvocationContext,
  executionPolicy: { readonly mode?: string } | undefined,
  contextLabel: ContentLabel | undefined,
  signal: AbortSignal,
): RecipeReplayContext {
  return {
    runId: context.runId,
    signal,
    allowed: executionPolicy?.mode !== "unattended" && (contextLabel === undefined || !isUntrusted(contextLabel)),
  };
}
