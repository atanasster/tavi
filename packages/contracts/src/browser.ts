import { CONTENT_LABEL_LIMITS, joinLabels, untrustedLabel, type ContentLabel } from "./content-label.js";
import { TaviError } from "./errors.js";
import type { BrowserActGuard } from "./commit-guard.js";
import type { StructuredBlocks } from "./structured-data.js";
import { hostOfUrl } from "./tool-result.js";
import { hostAndPathOf } from "./url-text.js";

/**
 * Browser-tool contract: browser-level operations — create session,
 * navigate, observe, act, capture, cancel and close — with exact Playwright
 * classes/selectors kept out of workflow/domain contracts, and opaque
 * scoped session/element references.
 *
 * **Opaque string references, not TypeScript-branded types**: this
 * codebase's existing convention for "opaque, not a provider handle" is a
 * plain `string` (`ArtifactRecord.artifactId`, `AdmissionRecord
 * .admissionId`) — no branded-type pattern exists anywhere else in
 * `@tavi/contracts`, so this contract doesn't introduce one either.
 *
 * **Stale-reference rejection** (an old observation or replaced
 * session cannot authorize a stale action) is `epoch`-based: every
 * `BrowserObservation` (from `navigate`/`observe`) carries the session's
 * current `epoch`, incremented on every observation. An `act()` call
 * passes back the `epoch` its `ref` came from, or none to act at the latest
 * observation, only where that observation saw the element. Observing the
 * same document again keeps earlier epochs valid (a bounded number); a new
 * document, a navigation or another page makes them stale.
 * `BrowserPort.act()` implementations are required to validate
 * `action.epoch` against the session's *actual* epochs at the moment the
 * action runs — not a
 * separate, earlier `observe()` call a generic dispatch wrapper might
 * make, which would be check-then-act on two different points in time
 * (a real TOCTOU gap a real browser session can close across). Rejecting
 * a stale `ref` is therefore each port implementation's own
 * responsibility, the same way `SqliteAgentWaitRepository.settle`'s
 * conditional transition — not a caller checking first — is what actually
 * closes a race, not a pre-check.
 */

export const BROWSER_SESSION_STATES = ["open", "closed"] as const;
export type BrowserSessionState = (typeof BROWSER_SESSION_STATES)[number];

export const BROWSER_SESSION_PROFILES = ["persistent", "ephemeral"] as const;
export type BrowserSessionProfile = (typeof BROWSER_SESSION_PROFILES)[number];

export interface BrowserSessionHandle {
  readonly sessionId: string;
  readonly state: BrowserSessionState;
}

export interface BrowserCreateSessionInput {
  readonly workspaceId: string;
  /**
   * The task that opens the session, from the tool's invocation context. With
   * it, an adapter that keeps browser history records the session against the
   * task; without it, nothing is recorded.
   */
  readonly taskId?: string;
  /** The tool call that opens it, recorded with the session so the Command Center can open the task at that call. */
  readonly callId?: string;
  /**
   * `"ephemeral"` opens a fresh browser context with no stored cookies or
   * profile state (logged-out mode); `"persistent"` (the default) uses the
   * workspace's profile when configured.
   */
  readonly profile?: BrowserSessionProfile;
}

/** One opaque, scoped element reference from a specific observation — never authoritative outside the `epoch` it was observed under. */
export interface BrowserElementSummary {
  readonly ref: string;
  readonly role?: string;
  readonly text?: string;
  /** Leading text or heading of the nearest row, list item, article or card container (up to 60 characters), excluding the element's own label. */
  readonly context?: string;
  /** A link's absolute http(s) destination, so it can be navigated to directly. */
  readonly href?: string;
  /**
   * What a form field holds now: a text
   * field's text, a `<select>`'s chosen option. Never a password field's.
   */
  readonly value?: string;
  /** The state a person would see: `checked`, `unchecked`, `expanded`, `collapsed`, `selected`, `disabled`, joined by spaces. */
  readonly state?: string;
  /** A control that submits its form: a submit button in it, a form's primary action, or one under a review step. */
  readonly submitsForm?: true;
  /** A field or control inside a strict search form (`role="search"` or only search-like text fields, with no secret/protected/email/tel/file/textarea fields). */
  readonly searchForm?: true;
  /** A searchbox or combobox inside a form that is not a strict search form: Enter in it may submit that form. */
  readonly inForm?: true;
  /** A stage profile's final step: pressing it is refused, and the person takes over. */
  readonly finalStep?: true;
  /** A field that holds a password, one-time code, PIN, or card detail: its value is never shown, and only the person may fill it. */
  readonly secret?: true;
  /** Origin of the child frame this element is inside, or `"<host> (not allowed)"` when the frame's host is not allowed. */
  readonly frame?: string;
}

/** How a compact element line reads, said once with each observation sent to a model (`compactObservationForModel`). */
export const COMPACT_ELEMENT_FORMAT = 'ref role "text" ["context"] = value (state) → href {flags}';

/** One element as one line: `el-4 link "Next" ["Results"] → /p/2`, a same-origin `href` made relative to the page. */
export function compactElementLine(element: BrowserElementSummary, pageUrl: string): string {
  const origin = (url: string): string | undefined => /^(https?:\/\/[^/?#]+)/i.exec(url)?.[1]?.toLowerCase();
  const pageOrigin = origin(pageUrl);
  const href =
    element.href === undefined
      ? undefined
      : pageOrigin !== undefined && origin(element.href) === pageOrigin
        ? element.href.slice(pageOrigin.length) || "/"
        : element.href;
  const flags = [
    element.submitsForm === true ? "submits" : undefined,
    element.searchForm === true ? "search" : undefined,
    element.inForm === true ? "in-form" : undefined,
    element.finalStep === true ? "final-step" : undefined,
    element.secret === true ? "secret" : undefined,
    element.frame === undefined ? undefined : `frame ${element.frame}`,
  ].filter((flag): flag is string => flag !== undefined);
  return [
    element.ref,
    element.role ?? "element",
    ...(element.text === undefined || element.text === "" ? [] : [JSON.stringify(element.text)]),
    // Quoted as the text is, so a page's context cannot pass for the line's href or flags.
    ...(element.context === undefined ? [] : [`[${JSON.stringify(element.context)}]`]),
    ...(element.value === undefined ? [] : [`= ${JSON.stringify(element.value)}`]),
    ...(element.state === undefined ? [] : [`(${element.state})`]),
    ...(href === undefined ? [] : [`→ ${href}`]),
    ...(flags.length === 0 ? [] : [`{${flags.join(", ")}}`]),
  ].join(" ");
}

function compactObservation(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (
    typeof record["sessionId"] === "string" &&
    typeof record["url"] === "string" &&
    typeof record["epoch"] === "number" &&
    Array.isArray(record["elements"]) &&
    record["elements"].every(
      (element) => typeof element === "object" && element !== null && typeof (element as { ref?: unknown }).ref === "string",
    )
  ) {
    const url = record["url"];
    return {
      ...record,
      elementsFormat: COMPACT_ELEMENT_FORMAT,
      elements: (record["elements"] as BrowserElementSummary[]).map((element) => compactElementLine(element, url)),
    };
  }
  return value;
}

/**
 * A browser tool's result as a model is sent it: an observation's elements
 * (the result itself, or an action's `page`) as one compact line each. Only
 * the words sent change; what is stored, assessed and acted on keeps the
 * structured elements.
 */
export function compactObservationForModel(output: unknown): unknown {
  const top = compactObservation(output);
  if (top !== output || typeof output !== "object" || output === null) return top;
  const page = (output as { readonly page?: unknown }).page;
  if (page === undefined) return output;
  const compacted = compactObservation(page);
  return compacted === page ? output : { ...(output as Record<string, unknown>), page: compacted };
}

/** The most elements one observation lists: the rest of a page is reached by `read`, or by acting and observing again. */
export const BROWSER_OBSERVATION_MAX_ELEMENTS = 60;
/** The longest `text` an element summary carries, in UTF-16 units; a longer one is cut and ends in "…". */
export const BROWSER_ELEMENT_TEXT_MAX_CHARS = 120;
/** The longest `context` an element summary carries, in UTF-16 units; a longer one is cut and ends in "…". */
export const BROWSER_ELEMENT_CONTEXT_MAX_CHARS = 60;
/**
 * The most JSON one observation's element list may take, in UTF-16 units
 * (about 2,000 tokens). Every observation stays in the conversation and is
 * sent again with each later model call, so it is kept small — and always far
 * inside the 64 KiB a tool result may carry inline (`MAX_TOOL_RESULT_BYTES`).
 */
export const BROWSER_OBSERVATION_MAX_CHARS = 8_000;

/** An element as an adapter scanned it, before `compactBrowserElements`. */
export interface BrowserScannedElement extends BrowserElementSummary {
  /** In the site's own navigation, header, footer or sidebar rather than the page's content. */
  readonly chrome?: boolean;
}

/** `text` with its whitespace collapsed, cut to `maxChars` without splitting a surrogate pair. */
function clipElementText(text: string, maxChars = BROWSER_ELEMENT_TEXT_MAX_CHARS): string {
  const squeezed = text.replace(/\s+/g, " ").trim();
  if (squeezed.length <= maxChars) return squeezed;
  let end = maxChars - 1;
  const code = squeezed.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${squeezed.slice(0, end).trimEnd()}…`;
}

/** Query parameters that only attribute a click (campaign tags, ad click ids), on any host. Compared lower-cased. */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "igshid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
  "_ga",
  "_gl",
]);
/** Tracking parameters that mean nothing else only on their own site: `ocid` elsewhere is, for one, an Oracle Cloud resource id. */
const SITE_TRACKING_PARAMS: readonly (readonly [host: string, params: ReadonlySet<string>])[] = [
  ["msn.com", new Set(["ocid", "cvid"])],
  ["bing.com", new Set(["form", "cvid"])],
];

/**
 * `href` without its tracking parameters (`utm_*`, ad click ids, and MSN's and
 * Bing's own), which change nothing about the page a link opens but can be a
 * third of its length. The rest of the URL is kept byte for byte, parameter
 * order and encoding included, and a URL with nothing to strip (or that is
 * not an absolute http(s) URL) comes back as it was.
 */
export function stripTrackingParams(href: string): string {
  const queryStart = href.indexOf("?");
  // No query, or a "?" inside the fragment rather than a query.
  if (queryStart === -1 || href.lastIndexOf("#", queryStart) !== -1) return href;
  // The authority of an absolute http(s) URL, as a browser writes `a.href`, without userinfo or port.
  const authority = /^https?:\/\/([^/?#]*)/i.exec(href)?.[1];
  if (authority === undefined) return href;
  const hostname = authority
    .slice(authority.lastIndexOf("@") + 1)
    .replace(/:\d*$/, "")
    .toLowerCase();
  const site = SITE_TRACKING_PARAMS.find(([host]) => hostname === host || hostname.endsWith(`.${host}`))?.[1];
  const hashStart = href.indexOf("#", queryStart);
  const query = href.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const pairs = query.split("&");
  const kept = pairs.filter((pair) => {
    let key: string;
    try {
      key = decodeURIComponent(pair.split("=", 1)[0] ?? "").toLowerCase();
    } catch {
      return true;
    }
    return !(key.startsWith("utm_") || TRACKING_PARAMS.has(key) || site?.has(key) === true);
  });
  if (kept.length === pairs.length) return href;
  const hash = hashStart === -1 ? "" : href.slice(hashStart);
  return `${href.slice(0, queryStart)}${kept.length === 0 ? "" : `?${kept.join("&")}`}${hash}`;
}

/**
 * An observation's element list as the model sees it, in page order: what
 * tells it nothing is left out, nothing is said twice, and the page's own
 * content comes before the site around it.
 *  - An element with no role, no text and no href is dropped.
 *  - `text` is whitespace-collapsed and clipped (`BROWSER_ELEMENT_TEXT_MAX_CHARS`).
 *  - `href` loses its tracking parameters (`stripTrackingParams`) first, so
 *    two links that differ only by them count as one.
 *  - One element per `href`: the first with text, else the first — the
 *    image beside a headline links to the same story.
 *  - A repeat of an earlier element's role and text (with no href) is
 *    dropped — a menu a page renders twice. An element with no text (an
 *    unlabelled field) is never a repeat: each is its own place to type.
 *  - At most `BROWSER_OBSERVATION_MAX_ELEMENTS` elements that fit
 *    `BROWSER_OBSERVATION_MAX_CHARS` are kept, chosen content first, then
 *    the site chrome's fields and buttons, then its links; `omitted` counts
 *    the rest.
 * Refs are kept as given, so an adapter's ref still names the element it
 * scanned; a dropped element's ref is simply not offered.
 */
export function compactBrowserElements(elements: readonly BrowserScannedElement[]): {
  readonly elements: BrowserElementSummary[];
  readonly omitted: number;
} {
  const clipped = elements.map((element) => {
    const text = element.text === undefined ? "" : clipElementText(element.text);
    const context = element.context === undefined ? "" : clipElementText(element.context, BROWSER_ELEMENT_CONTEXT_MAX_CHARS);
    const value = element.value === undefined ? "" : clipElementText(element.value);
    const summary: BrowserElementSummary = {
      ref: element.ref,
      ...(element.role === undefined ? {} : { role: element.role }),
      ...(text === "" ? {} : { text }),
      ...(context === "" || context === text ? {} : { context }),
      ...(element.href === undefined ? {} : { href: stripTrackingParams(element.href) }),
      ...(value === "" ? {} : { value }),
      ...(element.state === undefined || element.state === "" ? {} : { state: element.state }),
      ...(element.submitsForm === true ? { submitsForm: true as const } : {}),
      ...(element.searchForm === true ? { searchForm: true as const } : {}),
      ...(element.inForm === true ? { inForm: true as const } : {}),
      ...(element.secret === true ? { secret: true as const } : {}),
      ...(element.frame === undefined || element.frame === "" ? {} : { frame: element.frame }),
    };
    const tier = element.chrome !== true ? 0 : element.href === undefined ? 1 : 2;
    return { summary, tier };
  });
  const byHref = new Map<string, BrowserElementSummary>();
  for (const { summary } of clipped) {
    if (summary.href === undefined) continue;
    const hrefKey = `${summary.frame ?? ""}\u0000${summary.href}`;
    const first = byHref.get(hrefKey);
    if (first === undefined || (first.text === undefined && summary.text !== undefined)) byHref.set(hrefKey, summary);
  }
  const seen = new Set<string>();
  let folded = 0;
  const distinct = clipped.filter(({ summary }) => {
    if (summary.role === undefined && summary.text === undefined && summary.href === undefined && summary.frame === undefined) return false;
    if (summary.href !== undefined) return byHref.get(`${summary.frame ?? ""}\u0000${summary.href}`) === summary;
    if (summary.text === undefined) return true;
    // A control that submits a form is never folded into a same-named one that does not,
    // and repeated controls in different row/card contexts or different frames are kept distinct.
    const framePrefix = summary.ref.includes(":") ? (summary.ref.split(":", 1)[0] ?? null) : null;
    const key = JSON.stringify([
      framePrefix,
      summary.frame ?? null,
      summary.role ?? null,
      summary.text,
      summary.context ?? null,
      summary.submitsForm === true,
    ]);
    if (seen.has(key)) {
      folded += 1;
      return false;
    }
    seen.add(key);
    return true;
  });
  const chosen = new Set<BrowserElementSummary>();
  let chars = 2;
  for (const tier of [0, 1, 2]) {
    for (const { summary } of distinct.filter((entry) => entry.tier === tier)) {
      if (chosen.size >= BROWSER_OBSERVATION_MAX_ELEMENTS) break;
      const size = JSON.stringify(summary).length + 1;
      if (chars + size > BROWSER_OBSERVATION_MAX_CHARS) continue;
      chars += size;
      chosen.add(summary);
    }
  }
  return {
    elements: distinct.filter(({ summary }) => chosen.has(summary)).map(({ summary }) => summary),
    omitted: distinct.length - chosen.size + folded,
  };
}

export const BROWSER_BLOCK_KINDS = ["captcha", "bot-wall", "rate-limit", "consent", "login"] as const;
export type BrowserBlockKind = (typeof BROWSER_BLOCK_KINDS)[number];

/**
 * A page standing between the agent and the one it asked for: what kind,
 * and what it was. The tool
 * layer adds `hint`, what to do about it, since only it knows whether a person
 * can be handed the browser.
 */
export interface BrowserBlock {
  readonly kind: BrowserBlockKind;
  /** What was seen, in words: "a press-and-hold human check (PerimeterX)". */
  readonly detail: string;
  readonly hint?: string;
}

/**
 * Why a page is sensitive: a host on the no-thumbnail list, a
 * password field, or a payment or one-time-code field. The live view and
 * thumbnails never picture such a page, and plugins' hooks never see a browser
 * tool's output from one.
 */
export const BROWSER_SENSITIVE_REASONS = ["blocked-host", "password-field", "payment-field"] as const;
export type BrowserSensitiveReason = (typeof BROWSER_SENSITIVE_REASONS)[number];

/** How a browser engine shows its window: none (`headless`), or on the operator's screen (`headed`). */
export type BrowserDisplay = "headless" | "headed";

/**
 * The browser's own sandbox inside the host's confinement, strongest first: `full` (nested in it),
 * `seccomp` (Linux: its seccomp layer, the confinement's namespaces), then `none` (the confinement alone).
 */
export type ChromiumSandboxMode = "full" | "seccomp" | "none";

/**
 * Whether a browser tool's output came from a sensitive page: an observation,
 * a read, an action's outcome, or one in a batch's `steps` or an outcome's
 * `page` that says so. Looked for a few levels down, where the browser tools
 * put them.
 */
export function browserOutputSensitive(output: unknown, depth = 0): boolean {
  if (typeof output !== "object" || output === null || depth > 3) return false;
  if (Array.isArray(output)) return output.some((item) => browserOutputSensitive(item, depth + 1));
  const record = output as Record<string, unknown>;
  if (typeof record["sensitive"] === "string" && (BROWSER_SENSITIVE_REASONS as readonly string[]).includes(record["sensitive"]))
    return true;
  return browserOutputSensitive(record["page"], depth + 1) || browserOutputSensitive(record["steps"], depth + 1);
}

export interface BrowserTabSummary {
  readonly index: number;
  readonly url: string;
  readonly title?: string;
  readonly active?: true;
}

export interface BrowserObservation {
  readonly sessionId: string;
  /** Increments on every navigate/observe; `act()` checks the `epoch` a `ref` was observed under against the ones still valid. */
  readonly epoch: number;
  readonly url: string;
  /** The page's title, when it could be read in time. */
  readonly title?: string;
  readonly elements: readonly BrowserElementSummary[];
  /** How many more elements past this observation's bounds were left out (at least); absent when none. `read` returns the page's text. */
  readonly elementsOmitted?: number;
  /** The session's open pages when there are two or more; switch between them with `act({ kind: "tab", tab: <index> })`. */
  readonly tabs?: readonly BrowserTabSummary[];
  /** The page is a captcha, bot wall, rate limit, consent wall or sign-in, not the content asked for. */
  readonly blocked?: BrowserBlock;
  /** A cookie banner the browser answered by itself, declining what is not essential: the button it pressed. */
  readonly consentDeclined?: string;
  /** Set when the popup the session showed closed by itself and this is the page that opened it, said once. */
  readonly popupClosed?: true;
  /** The page is sensitive: why. */
  readonly sensitive?: BrowserSensitiveReason;
}

/** A link a superseded observation keeps: where it went, and what it said. */
export interface BrowserObservationLink {
  readonly text?: string;
  readonly href: string;
}

/**
 * What an observation becomes in a model's context once its session has been
 * observed again. No element keeps its ref: the newer observation lists the
 * elements as they are now (another page's made them stale), and an old one
 * left in would only invite acting on what changed. The links
 * stay, because a research task reads a results list, opens one article, and
 * then needs the list's other hrefs. `superseded` tells the model which
 * observation replaced this one. `links` is absent when the same page was
 * observed again later, since that later observation lists them.
 */
export interface SupersededBrowserObservation {
  readonly sessionId: string;
  readonly epoch: number;
  readonly url: string;
  readonly title?: string;
  readonly superseded: string;
  readonly links?: readonly BrowserObservationLink[];
}

/**
 * `observation` as a model sees it after `by`, the session's first later
 * observation (or, with `sameUrl`, its first later observation of the same
 * URL), made its refs stale. The result depends only on those two values, so
 * the same history renders the same bytes on every call and a provider's
 * prefix cache still matches it.
 */
export function supersedeBrowserObservation(
  observation: BrowserObservation,
  by: { readonly epoch: number; readonly sameUrl: boolean },
): SupersededBrowserObservation {
  const head = {
    sessionId: observation.sessionId,
    epoch: observation.epoch,
    url: observation.url,
    ...(observation.title === undefined ? {} : { title: observation.title }),
  };
  if (by.sameUrl) {
    return {
      ...head,
      superseded: `This page was observed again at epoch ${by.epoch}, which lists its elements: act on them as that observation lists them.`,
    };
  }
  return {
    ...head,
    superseded: `Epoch ${by.epoch} replaced this observation: its refs are stale and were removed. Its links are kept to navigate to.`,
    links: observation.elements.flatMap((element) =>
      element.href === undefined ? [] : [{ ...(element.text === undefined ? {} : { text: element.text }), href: element.href }],
    ),
  };
}

/** How an action's outcome says it took the session to another page: `the page is now <url>`. */
export const BROWSER_PAGE_MOVED = "the page is now";

export const BROWSER_ACTION_KINDS = [
  "click",
  "type",
  "submit",
  "upload",
  "download",
  "select",
  "hover",
  "drag",
  "press",
  "scroll",
  "back",
  "wait_for",
  "tab",
  "open_in_tab",
  "close_tab",
] as const;
export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number];

/**
 * Kinds that act on the page rather than an element: `press` and `scroll`
 * may name one (the field a key goes to, the
 * element to bring into view), `back`, `wait_for`, `tab`, `open_in_tab` and
 * `close_tab` never do (the tools layer turns an `open_in_tab` ref into its
 * link's URL before the port sees it). Every other kind needs a `ref`.
 */
export const BROWSER_PAGE_ACTION_KINDS = [
  "press",
  "scroll",
  "back",
  "wait_for",
  "tab",
  "open_in_tab",
  "close_tab",
] as const satisfies readonly BrowserActionKind[];

/** Whether `kind` needs an element `ref` (and the `epoch` it was observed under). */
export function browserActionNeedsRef(kind: BrowserActionKind): boolean {
  return !(BROWSER_PAGE_ACTION_KINDS as readonly BrowserActionKind[]).includes(kind);
}

/** Where `scroll` goes: a screenful either way (`down`/`up`/`left`/`right`), or an end of the page (`top`/`bottom`). */
export const BROWSER_SCROLL_DIRECTIONS = ["down", "up", "top", "bottom", "left", "right"] as const;
export type BrowserScrollDirection = (typeof BROWSER_SCROLL_DIRECTIONS)[number];

/** The longest a `wait_for` waits, in milliseconds. */
export const BROWSER_WAIT_MAX_MS = 15_000;

/** "Broker-check writes, form submissions, uploads and downloads" — every kind but `"click"`/`"type"` is a governed write. */
export const BROWSER_WRITE_ACTION_KINDS = ["submit", "upload", "download"] as const satisfies readonly BrowserActionKind[];

export interface BrowserAction {
  readonly sessionId: string;
  /** The element acted on; required unless `kind` is a page action (`browserActionNeedsRef`). */
  readonly ref?: string;
  /** The `epoch` `ref` was observed under — see this module's header comment. Omitted, the port acts at its latest observation, where that observation saw the element. */
  readonly epoch?: number;
  readonly kind: BrowserActionKind;
  /**
   * `type`: the text. `select`: the option, by its label (or a native `<select>`'s value). `press`: the
   * key or chord (`Enter`, `ArrowDown`, `Control+A`). `scroll`:
   * a `BrowserScrollDirection`. `wait_for`: text to wait for on the page, or
   * `url:<part>` for the address to come to hold `<part>`; with a ref, for that
   * element to show; with neither, for the page to go quiet. `open_in_tab`:
   * the absolute http(s) URL to open in a new tab of the session, which the
   * tools layer has already held to the navigation policy a `navigate` is.
   */
  readonly value?: string;
  /** `drag`: destination element ref from the same observation. */
  readonly toRef?: string;
  /** `drag`: horizontal offset in CSS pixels from `ref`. */
  readonly dx?: number;
  /** `drag`: vertical offset in CSS pixels from `ref`. */
  readonly dy?: number;
  /** `tab`: 0-based tab index from `observation.tabs`. `close_tab`: the tab to close (the active one when absent). */
  readonly tab?: number;
  /** `type`: `fill` sets the field at once; `keys` types it key by key, as a person does, for fields that suggest as you type. */
  readonly mode?: "fill" | "keys";
  /** `type` with `mode: "keys"`: whether to clear the field before typing (`true` by default; `false` appends). */
  readonly clear?: boolean;
  /** `wait_for`: how long to wait, at most `BROWSER_WAIT_MAX_MS`. */
  readonly timeoutMs?: number;
  /** What the browser re-checks on the element before a press: the call's tools layer sets it. */
  readonly guard?: BrowserActGuard;
  /** For `"upload"`: an already-authorized artifact reference, never a raw local path (the artifact-intake discipline, matching the sandbox/messaging fixtures' own bounded-reference pattern). */
  readonly artifactId?: string;
  /** The tool call that asked for it, so the live view can open the transcript at that call. Never shown to the page. */
  readonly callId?: string;
  /**
   * The conversation's context label as the call runs: a `"download"`
   * stores its file labelled with it, joined with
   * the page's own (`download`, `personal`, the page's host). Never shown to the page.
   */
  readonly contextLabel?: ContentLabel;
  /**
   * Arms the session's dialog listener to accept the next confirm or
   * beforeunload dialog raised by this action: with `message`, only one that
   * asks exactly that (the dialog the approval card showed).
   */
  readonly dialog?: {
    readonly accept: true;
    readonly promptText?: string | undefined;
    readonly message?: string | undefined;
  };
}

/**
 * What a browser artifact is stored with: the call's context label
 * joined with what the page gives — untrusted, from `source` (`web` for a
 * capture, `download` for a file), `personal` (sessions share the person's
 * profile), with the page's host when it has one.
 */
export function browserArtifactLabel(input: {
  readonly contextLabel?: ContentLabel | undefined;
  readonly source: "web" | "download";
  readonly pageUrl: string;
  readonly ref: string;
  readonly at: string;
}): ContentLabel {
  const host = hostOfUrl(input.pageUrl);
  const page = untrustedLabel(input.source, {
    confidentiality: "personal",
    ...(host === undefined ? {} : { principal: `host:${host}` }),
    ref: { ref: input.ref.slice(0, CONTENT_LABEL_LIMITS.maxRefLength), ...(host === undefined ? {} : { host }), at: input.at },
  });
  return input.contextLabel === undefined ? page : joinLabels(input.contextLabel, page);
}

export const BROWSER_ACTION_OUTCOME_STATUSES = ["accepted", "uncertain", "rejected"] as const;
export type BrowserActionOutcomeStatus = (typeof BROWSER_ACTION_OUTCOME_STATUSES)[number];

export interface BrowserActionDialog {
  readonly type: "alert" | "confirm" | "prompt" | "beforeunload";
  readonly message: string;
  readonly handled: "accepted" | "dismissed";
}

export type BrowserNetworkError =
  | {
      readonly status: number;
      readonly method: string;
      readonly url: string;
    }
  | {
      readonly pageError: string;
    };

/**
 * `"uncertain"` — not `"rejected"` — is the outcome for a write whose
 * result could not be confirmed, e.g. session loss mid-write (uncertain
 * outcomes are preserved after browser loss), mirroring
 * `SendOutcome`'s identical three-way split in `./messaging.js`.
 */
export interface BrowserActionOutcome {
  readonly status: BrowserActionOutcomeStatus;
  readonly detail?: string;
  /**
   * The artifact a `download` stored, `pending` review: named here, not only in
   * `detail`, so the turn's review gate finds it (`collectPendingReviewArtifactIds`)
   * and the model reads it once it is approved.
   */
  readonly artifactId?: string;
  /** How the action was taken when the call left it open: `acted with epoch N` for a ref sent without its epoch. */
  readonly note?: string;
  /**
   * What the action changed on the page, in words: the URL, a field's
   * value, a list or dialog that opened or
   * closed, where focus went. Absent when nothing visible changed.
   */
  readonly changes?: readonly string[];
  /** The page observed afresh, when the action is one whose next step needs its elements (typing that suggests, `back`, `wait_for`): its refs replace the old ones. */
  readonly page?: BrowserObservation;
  /** The page the action left is sensitive: why. Absent with `page`, which says so itself. */
  readonly sensitive?: BrowserSensitiveReason;
  /** What stands in the way on the page the action moved to (classified after every action), as an observation says it. */
  readonly blocked?: BrowserBlock;
  /**
   * A JavaScript dialog (`alert`, `confirm`, `prompt`, `beforeunload`) raised
   * and answered during the action, or since the last action ended: the last of `dialogs`.
   */
  readonly dialog?: BrowserActionDialog;
  /** Every dialog raised and answered, in order, when there was more than one. */
  readonly dialogs?: readonly BrowserActionDialog[];
  /** Recent HTTP >= 400 responses (`fetch`, `xhr`, `document`) with scrubbed URLs and clipped uncaught `pageerror` messages, surfaced when the action failed or changed nothing. */
  readonly networkErrors?: readonly BrowserNetworkError[];
}

export interface BrowserCaptureScale {
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

export interface BrowserCaptureMark {
  readonly ref: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserCaptureRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Converts a point `(x, y)` in captured image space (or normalized `[0, 1000]` space when `normalized` is true)
 * into logical viewport CSS pixels, clamped to `[0, logicalWidth - 1]` x `[0, logicalHeight - 1]`.
 */
export function toLogicalPoint(
  point: { readonly x: number; readonly y: number },
  scale?: BrowserCaptureScale,
  normalized = false,
): { readonly x: number; readonly y: number } {
  if (scale === undefined) {
    return {
      x: Math.max(0, Math.round(point.x)),
      y: Math.max(0, Math.round(point.y)),
    };
  }
  const lw = Math.max(1, scale.logicalWidth);
  const lh = Math.max(1, scale.logicalHeight);
  const iw = Math.max(1, normalized ? 1000 : scale.imageWidth);
  const ih = Math.max(1, normalized ? 1000 : scale.imageHeight);
  const rawX = Math.round((point.x * lw) / iw);
  const rawY = Math.round((point.y * lh) / ih);
  return {
    x: Math.min(lw - 1, Math.max(0, rawX)),
    y: Math.min(lh - 1, Math.max(0, rawY)),
  };
}

/** A screenshot (or other capture) as a bounded artifact reference, never inline bytes — matching the sandbox fixture's own output pattern. */
export interface BrowserCaptureResult {
  readonly sessionId: string;
  readonly artifactId: string;
  readonly capturedAt: string;
  /** Taken for the model to look at (`forModel`): a JPEG of the viewport, approved, never of a sensitive page. */
  readonly forModel?: true;
  /** Its image type, for a capture taken for the model. */
  readonly contentType?: string;
  /** Declared coordinate scale between the captured image and the logical CSS viewport. */
  readonly scale?: BrowserCaptureScale;
  /** Set-of-Marks boxes and ref labels drawn onto the screenshot copy. */
  readonly marks?: readonly BrowserCaptureMark[];
}

/**
 * The most text one `read` returns, in UTF-16 units: a longer page is read in
 * pieces by `offset`. Three UTF-8 bytes a unit at worst, it stays inside the
 * 64 KiB a tool result may carry inline (`MAX_TOOL_RESULT_BYTES`), so reading a
 * page never archives it for review.
 */
export const BROWSER_READ_MAX_CHARS = 16_000;

/** A page's readable text, one piece of it: what an observation's element summaries leave out. */
export interface BrowserPageText {
  readonly sessionId: string;
  readonly url: string;
  readonly title?: string;
  /** The text from `offset`, at most `BROWSER_READ_MAX_CHARS`. */
  readonly text: string;
  readonly offset: number;
  /** The whole readable text's length, so a caller knows how much is left. */
  readonly totalLength: number;
  /** Where the next piece starts; absent once `text` reaches the end. */
  readonly nextOffset?: number;
  /**
   * Set when the page still looked to be loading after `read` waited for it —
   * a progress indicator, a "Loading…" line — saying what was seen: the text
   * may be incomplete, or lack the results entirely.
   */
  readonly stillLoading?: string;
  /**
   * Set when the page shows it failed ("Oops, something went wrong") — what
   * to do about it, naming the control it offers to try again, if any.
   */
  readonly recovery?: string;
  /** The page is a captcha, bot wall, rate limit, consent wall or sign-in: its text is that, not the content asked for. */
  readonly blocked?: BrowserBlock;
  /** The page is sensitive: why. */
  readonly sensitive?: BrowserSensitiveReason;
}

/**
 * The piece of `text` a `read` from `offset` returns. The cut never splits a
 * surrogate pair, and an offset past the end answers an empty piece rather
 * than an error: the page may have shrunk since the last read.
 */
export function pageTextPiece(
  page: { readonly sessionId: string; readonly url: string; readonly title?: string | undefined },
  text: string,
  offset = 0,
): BrowserPageText {
  const start = Math.min(Math.max(0, Math.trunc(offset)), text.length);
  let end = Math.min(start + BROWSER_READ_MAX_CHARS, text.length);
  // A high surrogate left last would lose its pair to the next piece.
  if (end < text.length && end > start) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return {
    sessionId: page.sessionId,
    url: page.url,
    ...(page.title === undefined ? {} : { title: page.title }),
    text: text.slice(start, end),
    offset: start,
    totalLength: text.length,
    ...(end < text.length ? { nextOffset: end } : {}),
  };
}

/** The most text `content` returns: about 15,000 tokens, what an extraction model reads at once. */
export const BROWSER_CONTENT_MAX_CHARS = 60_000;
/** The most links `content` returns. */
export const BROWSER_CONTENT_MAX_LINKS = 300;

/**
 * A page's content for extraction: its
 * readable text and its links, of the whole page's main content or of one
 * element's subtree. Read by the extractor, never sent to the agent's model
 * as it is.
 */
export interface BrowserPageContent {
  readonly sessionId: string;
  readonly url: string;
  readonly title?: string;
  readonly text: string;
  readonly links: readonly BrowserObservationLink[];
  /** The text or links went past `BROWSER_CONTENT_MAX_CHARS` / `BROWSER_CONTENT_MAX_LINKS` and were cut. */
  readonly truncated: boolean;
  /** The page is sensitive: why. */
  readonly sensitive?: BrowserSensitiveReason;
}

/**
 * What an observation looks at: one
 * element's part of the page (`ref` from the latest observation), or its main
 * content, its open dialog, or its form; and every element, or only those a
 * person acts on (`interactive`: fields, buttons, links, options).
 */
export interface BrowserObserveOptions {
  readonly scope?: { readonly ref: string; readonly epoch: number } | "main" | "dialog" | "form";
  readonly filter?: "interactive" | "all";
  /**
   * Every element the scan keeps, past an observation's usual bounds: for the
   * browser tools' own use (`browser.find` reads them all to choose from), never
   * an option offered to a model.
   */
  readonly all?: boolean;
  /**
   * The page was just in a person's hands (a handoff): no field's
   * value is reported — they may have typed anything into any field — in this
   * observation or a later one of the same page, until it goes elsewhere.
   */
  readonly withholdValues?: boolean;
}

/**
 * An action by sight: at a point of the
 * viewport, in CSS pixels as a capture for the model shows them, or a key,
 * text, a scroll, a pause. For a page whose elements do not say how to act on
 * it — a canvas, a map, a widget drawn its own way.
 */
export type BrowserPointerAction =
  | { readonly kind: "click"; readonly x: number; readonly y: number; readonly double?: boolean }
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "press"; readonly key: string }
  | { readonly kind: "scroll"; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }
  | { readonly kind: "drag"; readonly x: number; readonly y: number; readonly toX: number; readonly toY: number }
  | { readonly kind: "wait"; readonly ms: number };

/** The longest a pointer `wait` waits. */
export const BROWSER_POINTER_WAIT_MAX_MS = 5_000;

/** `BrowserPort.capture`'s options. */
export interface BrowserCaptureOptions {
  readonly forModel?: boolean;
  /** Draw Set-of-Marks boxes and ref labels onto the screenshot copy (never mutating the page). */
  readonly marks?: boolean;
  /** Element ref from the current observation to crop at full resolution (`zoom`). */
  readonly ref?: string;
  /** Epoch for `ref` when cropping an element. */
  readonly epoch?: number;
  /** Viewport region `{ x, y, width, height }` in CSS pixels to crop at full resolution (`zoom`). */
  readonly region?: BrowserCaptureRegion;
  /** The calling conversation's context label, joined into the capture's stored label (`browserArtifactLabel`). */
  readonly contextLabel?: ContentLabel;
}

export interface BrowserPort {
  createSession(input: BrowserCreateSessionInput): Promise<BrowserSessionHandle>;
  /** `options.callId`: the tool call that asked, for the live view (never shown to the page). */
  navigate(sessionId: string, url: string, options?: { readonly callId?: string }): Promise<BrowserObservation>;
  observe(sessionId: string, options?: BrowserObserveOptions): Promise<BrowserObservation>;
  /** The current page's readable text from `offset` (default 0), one piece of at most `BROWSER_READ_MAX_CHARS`. */
  read(sessionId: string, offset?: number): Promise<BrowserPageText>;
  act(action: BrowserAction): Promise<BrowserActionOutcome>;
  /**
   * The current page's text and links for extraction (`BrowserPageContent`):
   * its main content, or with `ref` (and the `epoch` it was observed under)
   * that element's subtree. Optional — an adapter without it offers no
   * `browser.extract`.
   */
  content?(sessionId: string, options?: { readonly ref?: string; readonly epoch?: number }): Promise<BrowserPageContent>;
  /**
   * The current page's structured data as it stands in the page: each
   * `application/ld+json` block's text and its top-level
   * microdata items, gathered without running the page's scripts, within
   * `STRUCTURED_DATA_MAX_CHARS`. Optional — an adapter without it offers no
   * `browser.structured`.
   */
  structured?(sessionId: string): Promise<{ readonly url: string; readonly blocks: StructuredBlocks }>;
  /**
   * The URL the session's page is on now, read without touching the page:
   * what a check before an action holds against, since a person may have
   * moved the page since it was last observed. Optional.
   */
  currentUrl?(sessionId: string): Promise<string | undefined>;
  /**
   * A screenshot as an artifact. By default held for the operator's review
   * before anything reads it; with `forModel` a JPEG of the viewport for
   * the agent's own model to look at,
   * approved — and refused, `NOT_AUTHORIZED`, on a page that must not be
   * pictured (a password, payment or one-time-code field, a no-thumbnail host).
   */
  capture(sessionId: string, options?: BrowserCaptureOptions): Promise<BrowserCaptureResult>;
  /**
   * Act by sight on the session's page (`BrowserPointerAction`). Optional — an
   * adapter without it offers no `browser.vision_act`.
   */
  pointer?(
    sessionId: string,
    action: BrowserPointerAction,
    options?: { readonly callId?: string; readonly guard?: BrowserActGuard },
  ): Promise<BrowserActionOutcome>;
  cancel(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  /**
   * A task reached its end (a turn completed or failed): its sessions stay
   * open, **inactive**, so the chat's next turn finds its browser where it
   * left it; the task's next browser call makes one in use again. Never closes
   * anything: an inactive session closes only by `close`, the operator or
   * shutdown. Optional.
   */
  taskEnded?(taskId: string): Promise<void>;
  /**
   * Close the session recorded under `recordedSessionId` (its browser-history
   * id, as the Command Center names it), recording `reason`. False when this
   * adapter holds no such open session. Optional.
   */
  closeRecorded?(recordedSessionId: string, reason: string): Promise<boolean>;
  /**
   * A session's live-view (browser-history) id and the task that opened it,
   * for a handoff; `undefined` for one not open, or not offered to the
   * live view. A look-up leaves a session kept from its task's last turn as
   * it is; `wake` makes it open again, for a person to be asked to take it
   * (only for the session's own task, once that is checked).
   */
  handoffTarget?(
    sessionId: string,
    options?: { readonly wake?: boolean },
  ): { readonly historyId: string; readonly taskId: string } | undefined;
  /**
   * A `browser.act` waiting for the operator's approval: the live view
   * outlines its target as `pending`; `denied` takes
   * the outline away. One that is approved runs, and is reported as any action.
   * Nothing is done to the page.
   */
  pendingAction?(input: {
    readonly sessionId: string;
    readonly ref: string;
    readonly epoch: number;
    readonly kind: BrowserActionKind;
    readonly callId: string;
    readonly decided?: "denied";
  }): Promise<void>;
  /**
   * Forget the workspace's browser profile — its cookies, consent choices and
   * logins: every open session of the
   * workspace is closed first, recorded as closed for that reason. Answers how
   * many sessions it closed. Optional — an adapter that keeps no profile omits it.
   */
  clearProfile?(workspaceId: string): Promise<{ readonly closed: number }>;
  /**
   * Release whatever the adapter holds for its whole lifetime (a shared
   * browser process), closing any session still open. Called once, by the
   * owner of the adapter, when it shuts down: after it the adapter must not
   * be used. Optional — an adapter that holds nothing process-wide omits it.
   */
  dispose?(): Promise<void>;
}

/**
 * The dispatch-time gate for governed writes: they go through the same
 * approval-binding path as any other mutating tool, and uncertain outcomes
 * after browser loss are preserved. A plain function, like
 * `dispatchSandboxedTool`. A write-kind action
 * (`BROWSER_WRITE_ACTION_KINDS`) that reaches a session in a `"closed"`
 * state is reported `"uncertain"`, never silently treated as failed or
 * successful — the session may have closed after the write was already
 * submitted to the page.
 */

/** A readonly tuple's `.includes()` narrows its parameter to the tuple's own element type, rejecting the wider `BrowserActionKind` — a named guard reads clearer than an inline cast at the one call site that needs this. */
function isBrowserWriteAction(kind: BrowserActionKind): kind is (typeof BROWSER_WRITE_ACTION_KINDS)[number] {
  return (BROWSER_WRITE_ACTION_KINDS as readonly BrowserActionKind[]).includes(kind);
}

export async function dispatchBrowserAction(browser: BrowserPort, action: BrowserAction): Promise<BrowserActionOutcome> {
  try {
    // Stale-reference (epoch) rejection is `browser.act`'s own
    // responsibility, checked against the session's actual state at the
    // moment the action runs — not re-derived here from an earlier,
    // separately-timed `observe()` call, which would open exactly the
    // check-then-act race this contract exists to close (see this
    // module's header comment).
    return await browser.act(action);
  } catch (error) {
    if (isBrowserWriteAction(action.kind) && error instanceof TaviError && error.code === "UNAVAILABLE") {
      // Session loss mid-write: the outcome is unknown, not a confirmed
      // failure — never silently success or silently failed.
      return { status: "uncertain", detail: error.message };
    }
    throw error;
  }
}

// ------------------------------------------------------------------ site skills

/** What a site skill tests a URL's path with: a note's globs (`sitePathPattern`), or a regular expression. */
export interface SitePathMatcher {
  test(path: string): boolean;
}

/**
 * Site skills: what is known of a site an agent often browses, which the
 * browser tools carry on the first observation of one of its pages (`site`).
 * A plugin supplies them (the built-in ones are `tavi.siteskills`'); the
 * browser tools read whichever are registered (`SiteSkillRegistryPort`).
 */
export interface SiteSkill {
  readonly id: string;
  readonly name: string;
  /** A host is the skill's when it is one of these, or under one. */
  readonly hosts: readonly string[];
  /** Matched against the URL's path, when the skill is for part of a site. */
  readonly path?: SitePathMatcher;
  /** How to use the site, in a few sentences. */
  readonly notes: string;
  /** Said only when a person can be handed the browser (`browser.request_handoff` is offered). */
  readonly handoffNote?: string;
  /** A URL that opens a search directly, as a template with {placeholders}. */
  readonly searchUrl?: string;
  /** A JSON Schema for one result, for `browser.extract`. */
  readonly resultSchema?: Readonly<Record<string, unknown>>;
}

/** The site skills the running plugins registered, by the plugin that did. */
export interface SiteSkillRegistryPort {
  /** Adds `skills` for `pluginId`; the function returned takes them away again. */
  add(pluginId: string, skills: readonly SiteSkill[]): () => void;
  /** The skill for a page's URL, if a registered one covers it. */
  skillFor(url: string): SiteSkill | undefined;
}

/** The skill for a page's URL, if one covers it: the most specific (a path) first. */
export function siteSkillFor(skills: readonly SiteSkill[], url: string): SiteSkill | undefined {
  const parsed = hostAndPathOf(url);
  if (parsed === undefined) return undefined;
  const onHost = skills.filter((skill) =>
    skill.hosts.some((candidate) => parsed.hostname === candidate || parsed.hostname.endsWith(`.${candidate}`)),
  );
  return onHost.find((skill) => skill.path?.test(parsed.pathname) === true) ?? onHost.find((skill) => skill.path === undefined);
}

/** A skill as an observation carries it; its handoff note only when a person can be handed the page. */
export function siteView(skill: SiteSkill, handoff = false): Readonly<Record<string, unknown>> {
  return {
    name: skill.name,
    notes: handoff && skill.handoffNote !== undefined ? `${skill.notes} ${skill.handoffNote}` : skill.notes,
    ...(skill.searchUrl === undefined ? {} : { searchUrl: skill.searchUrl }),
    ...(skill.resultSchema === undefined ? {} : { resultSchema: skill.resultSchema }),
  };
}
