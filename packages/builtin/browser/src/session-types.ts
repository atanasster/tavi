import type { BrowserSessionState, BrowserElementSummary, BrowserActionDialog, BrowserNetworkError } from "@tavi/contracts";
import type { Browser, BrowserContext, BrowserContextOptions, Frame, LaunchOptions, Locator, Page } from "playwright";

import type { ConfinedChromium } from "./confined.js";
import type { EgressProxy } from "./egress-proxy.js";
import type { BrowserDisplay, BrowserIdentity } from "./identity.js";
import type { PlaywrightBrowserOptions } from "./options.js";
import type { RefRegistry } from "./scan.js";

export interface StoredElementRef {
  readonly locator: Locator;
  readonly index: number;
  readonly key: string | undefined;
  readonly occurrence: number;
  readonly role: string | undefined;
  readonly label: string | undefined;
  readonly frame?: Frame | undefined;
  readonly frameOrigin?: string | undefined;
  /** Acted on without an epoch: a move is refused, not recovered by its label. */
  readonly strict?: boolean;
}

export interface SessionRecord {
  state: BrowserSessionState;
  epoch: number;
  /** The page the latest observation read: another (a tab switched to, a popup) is a new document. */
  observedPage?: Page | undefined;
  /** Lowest epoch still valid on the current document (advanced by explicit observations and navigations). */
  minValidEpoch?: number | undefined;
  url: string;
  readonly workspaceId: string;
  /** The task that opened it, when the caller said; artifacts it makes carry it as their run. */
  readonly taskId: string | undefined;
  /** The durable history row's id, when one was written. */
  historyId: string | undefined;
  /** When the last thumbnail was taken (ms), for the per-session throttle. */
  lastThumbnailAt: number | undefined;
  /** The epoch of the last scheduled thumbnail run, so auto-refresh on the same page does not abort it. */
  lastThumbnailEpoch?: number | undefined;
  /** Thumbnail runs, one at a time per session, off the tool call's path. */
  thumbnailQueue: Promise<void>;
  /** Its task ended and it is kept, open, for the task's next turn. */
  inactive: boolean;
  /** Idle reaper timer started when `taskEnded` marks the session inactive. */
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
  readonly context: BrowserContext;
  /** Its context is the workspace's profile, which other sessions share: closing the session closes its page, never the context. */
  readonly shared: boolean;
  /** The active page the session shows. */
  page: Page;
  /** All open pages belonging to this session, capped at `MAX_SESSION_PAGES`. */
  readonly pages: Page[];
  /** Maps a popup page to the page that opened it. */
  readonly openers: Map<Page, Page>;
  /** Pages that already have status/dialog/close listeners attached. */
  readonly trackedPages?: WeakSet<Page> | undefined;
  /** Set when the active popup closes and the session returns to its opener. */
  returnedFromPopup?: Page | undefined;
  /** Notifies live view when the active page changes on popup close. */
  onActivePageChanged?: ((next: Page) => void) | undefined;
  /** The HTTP status of its last navigation, for telling a 403 or 429 wall from a page. */
  lastStatus: number | undefined;
  elements: Map<string, StoredElementRef>;
  elementsByEpoch?: Map<number, Map<string, StoredElementRef>> | undefined;
  /** The latest observation's page and elements, to name a control by its ref outside an observation (a read's `recovery`). */
  observed?: { readonly url: string; readonly epoch: number; readonly elements: readonly BrowserElementSummary[] } | undefined;
  /** The URL whose fields' values are withheld: the page a person held (`BrowserObserveOptions.withholdValues`). */
  valuesWithheldOn?: string | undefined;
  /** The person's takes of the session the agent has seen: one more since means a person held the page. */
  takesSeen?: number;
  /** Cancels the currently running agent call on this session, if one is in flight. */
  cancelInFlight?: (() => void) | undefined;
  /** Staged upload files the page may still read (Chromium reads one when its form is sent): removed when the session closes. */
  uploadDirectories?: string[] | undefined;
  /** The pages whose dialogs the person's takeover answers now (`ControlledSession.heldDialogPages`). */
  readonly heldDialogPages: Set<Page>;
  /** Armed by `act` with `dialog: { accept: true }` for the next dialog raised during the action. */
  armedDialog?: { readonly accept: true; readonly promptText?: string | undefined; readonly message?: string | undefined } | undefined;
  /** The last dialog raised and handled during the current agent action. */
  lastDialog?: BrowserActionDialog | undefined;
  /** The dialogs answered on the session's page that no outcome has reported yet. */
  readonly unreportedDialogs: BrowserActionDialog[];
  /** The last host on which cookie consent was checked/declined. */
  lastConsentHost?: string | undefined;
  /** Consent result from an action navigation (`recordNavigation`) awaiting the next `refresh` on that host. */
  pendingConsent?:
    | {
        readonly host: string;
        readonly result: { readonly pressed?: string; readonly wall?: boolean };
      }
    | undefined;
  /** Progress signature `(url, elementsHash, scrollHeight)` for loop detection. */
  progressSignature?: string | undefined;
  /** Consecutive actions with no progress change on this session. */
  noChangeActions?: number | undefined;
  /** Last observed document scroll height (px). */
  lastScrollHeight?: number | undefined;
  /** Consecutive downward scrolls with no growth in document scroll height. */
  scrollsWithoutGrowth?: number | undefined;
  /** Extracted text of a PDF document the session navigated to, while the session stays on that URL. */
  pdfPage?: { readonly url: string; readonly hostPageUrl: string; readonly text: string; readonly title?: string | undefined } | undefined;
  /** Raw bytes of the most recent main-frame PDF navigation response. */
  lastMainPdfBytes?: { readonly url: string; readonly bytes: Promise<Uint8Array | "over-cap" | undefined> } | undefined;
  /** Ring buffer of the last 10 HTTP >= 400 responses (`fetch`, `xhr`, `document`) and uncaught `pageerror`s. */
  recentErrors?: BrowserNetworkError[] | undefined;
  /** How many network errors the session has met in all: an action reports only those after its own start. */
  networkErrorsSeen?: number | undefined;
  /** An action a cancel abandoned while it still ran: the session's next action waits for it to stop first. */
  abandoned?: Promise<unknown> | undefined;
  /** The refs it has handed out, so a re-observed page names the same element by the same ref. */
  readonly refs: RefRegistry;
}

/**
 * One `createPlaywrightBrowser` adapter's state, made once by the factory and
 * passed to the functions that act for it: the launch it uses, the browser and
 * profiles it opened, and its sessions.
 */
export interface BrowserRuntime {
  readonly options: PlaywrightBrowserOptions;
  /** Chromium confined under the owner's `ConfinementPort`, when `options.confinement` asks for it. */
  readonly confined: ConfinedChromium | undefined;
  /**
   * An unconfined launch with Chromium's own sandbox (`identity.ts`). A Linux
   * host that restricts user namespaces (Ubuntu 24.04's AppArmor) refuses it;
   * the browser then runs as Playwright would, said once, rather than not at all.
   */
  ownSandbox: boolean;
  readonly launch: (options: LaunchOptions) => Promise<Browser>;
  readonly launchPersistent: (userDataDir: string, options: LaunchOptions & BrowserContextOptions) => Promise<BrowserContext>;
  readonly display: BrowserDisplay;
  readonly baseLaunchOptions: LaunchOptions;
  /** The adapter's egress proxy, started with the first launch and closed with `dispose`. */
  egressProxy: Promise<EgressProxy> | undefined;
  readonly identity: BrowserIdentity;
  readonly now: () => string;
  counter: number;
  readonly sessions: Map<string, SessionRecord>;
  browserPromise: Promise<Browser> | undefined;
  /** Each workspace's persistent profile, once opened; dropped when it closes, so the next session opens it again. */
  readonly profiles: Map<string, Promise<BrowserContext>>;
  /** A workspace's profile being cleared: opening it again waits for that. */
  readonly clearing: Map<string, Promise<void>>;
  /** Profile pages a session has taken, marked the moment they are picked: two sessions opening at once never share one. */
  readonly claimedPages: Set<Page>;
  userAgentPromise: Promise<string | undefined> | undefined;
  disposed: boolean;
  readonly routedContexts: WeakSet<BrowserContext>;
}
