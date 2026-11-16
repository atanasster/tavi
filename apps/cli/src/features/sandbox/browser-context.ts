import {
  ASSIST_ONLY_COMMIT_LABEL,
  type BrowserActionOutcome,
  type BrowserPort,
  type CallAssessment,
  type InvocationContext,
  type SiteSkillRegistryPort,
  TaviError,
} from "@tavi/contracts";

import type { ObservedElement } from "../approvals/call-assessors.js";
import { type ResolveHost, systemResolve } from "../browser/address-guard.js";
import type { SitePolicy } from "../browser/site-policy.js";
import { type SessionOpener, requireSessionOf } from "../browser/session-input.js";
import type { RecipeRecorder } from "../browser/site-recipes.js";
import type { FolderPromotion } from "../folders/promotion.js";

/**
 * Extra policy for the browser tools.
 *
 * `allowedHosts` is the navigation allowlist: the destination of
 * `browser.navigate` is model-authored, and without a control on it an approved
 * artifact could be POSTed to any host the model named once
 * `browser.act {kind:"upload"}` was allowed: the workspace and review-state
 * gates do not check the *destination*. Same
 * semantics as `--http-allow-host`: exact host or `*.suffix`, deny by default.
 */
export interface BrowserToolOptions {
  readonly allowedHosts?: readonly string[];
  /** Offer `browser.request_handoff`: the owner serves the live view, where a person can take the page over. */
  readonly handoff?: boolean;
  /** Learns which steps led to results on a site, and shows them the next time. */
  readonly recipes?: RecipeRecorder;
  /** The site skills the running plugins registered, carried on a first observation of one of their sites. */
  readonly siteSkills?: SiteSkillRegistryPort;
  /**
   * Turns a file of the chat's folder into the artifact an upload by `path`
   * sends. Absent: an upload takes an
   * `artifactId` only.
   */
  readonly promotion?: FolderPromotion;
  /** The site profiles the operator turned on, and their rules. Absent: no host is profiled. */
  readonly sites?: SitePolicy;
  /** Test seam: the addresses a host name resolves to. Production asks the system resolver. */
  readonly resolveHost?: ResolveHost;
  /**
   * @internal Tests: hosts exempt from the private-address rule alone (a
   * fixture site on 127.0.0.1 or `*.localhost`), which stay off the allowlist.
   * In production `allowedHosts` is the only exemption.
   */
  readonly privateHostsAllowed?: readonly string[];
}

/** The most sessions whose observed elements the browser tools keep for assessing actions; the oldest is forgotten past it. */
export const MAX_OBSERVED_SESSIONS = 200;

/** A URL's port, its scheme's default when it names none. */
export const portOf = (url: URL): number => (url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port));

/** The host a page is on, by its origin: a `blob:` URL's is its creator's; an opaque origin (`data:`, `about:blank`) has none (""). */
export function hostOfPage(url: string): string {
  const origin = URL.parse(url)?.origin;
  return origin === undefined || origin === "null" ? "" : (URL.parse(origin)?.host ?? "");
}

/** The browser's refusal of a host that is, or resolves to, `what`: no approval opens it, only the operator's list. */
export function unreachableHost(hostname: string, what: string): TaviError {
  return new TaviError(
    "NOT_AUTHORIZED",
    `the browser may not open ${hostname}: it is ${what}, which no approval opens. The operator can list it with --browser-allow-host.`,
    { details: { host: hostname, privateAddress: true } },
  );
}

/** What a press on an `assist-only` site may not be: built from the shared commit table plus sign-in, apply and save. */
export const COMMITS = ASSIST_ONLY_COMMIT_LABEL;
/** What may be done on a final step's own address: look, and leave. */
export const LOOKING_KINDS: ReadonlySet<string> = new Set(["scroll", "hover", "back", "wait_for", "tab", "open_in_tab", "close_tab"]);

/** A protocol-relative URL (`//host/x`) as the browser resolves it: over https. */
export const absoluteOf = (url: string): string => (url.startsWith("//") ? `https:${url}` : url);

/**
 * What the browser tools of one registration share: the port, the operator's
 * policy, and what each session has been shown and has reached in this process.
 */
export interface BrowserToolContext {
  readonly browser: BrowserPort;
  readonly options: BrowserToolOptions;
  readonly handoff: boolean;
  /** What each session has been shown of a site: its skill and its recipe come once, when the session first reaches it. */
  readonly shownSites: Map<string, Set<string>>;
  /**
   * What each session's observations named, by ref (a ref names one element for
   * the session's life): an action's assessment reads its element's role and
   * label, so a press of "Place order" is asked about as a submit.
   */
  readonly observed: Map<string, { url: string; readonly elements: Map<string, ObservedElement> }>;
  /** The URL of the session's page as last read live (after an action, a redirect), which may be newer than its observation. */
  readonly pageNow: Map<string, string>;
  /**
   * The last dialog each session dismissed, and the host it was on: an armed
   * accept on that host is asked about as what it asked, and accepts only it.
   */
  readonly dismissedDialogs: Map<string, { readonly message: string; readonly host: string }>;
  /** Hosts explicitly approved by the operator for each session. */
  readonly approvedSessionHosts: Map<string, Set<string>>;
  /**
   * Which workspace, and which chat, opened each session *in this process*.
   *
   * The port's methods take only a session id, so a task that learned another
   * workspace's or another chat's id could drive that session — and through it
   * upload that workspace's artifacts, or close a chat's browser without asking.
   * The port is the authority on existence; this map is what makes ownership
   * checkable at the tool boundary without a port change (`requireChatSession`).
   * A session this process did not open is left to the port to refuse.
   */
  readonly sessionOpener: Map<string, SessionOpener>;
  readonly allowedHosts: readonly string[];
  readonly resolveHost: ResolveHost;
}

/** A registration's context: nothing shown or reached yet. */
export function createBrowserToolContext(browser: BrowserPort, options: BrowserToolOptions): BrowserToolContext {
  return {
    browser,
    options,
    handoff: options.handoff === true,
    shownSites: new Map(),
    observed: new Map(),
    pageNow: new Map(),
    dismissedDialogs: new Map(),
    approvedSessionHosts: new Map(),
    sessionOpener: new Map(),
    allowedHosts: options.allowedHosts ?? [],
    resolveHost: options.resolveHost ?? systemResolve,
  };
}

/** What the session's observations named the element `ref`. */
export function elementOf(ctx: BrowserToolContext, sessionId: string, ref: string): ObservedElement | undefined {
  return ctx.observed.get(sessionId)?.elements.get(ref);
}

/** The URL of the session's page as last observed. */
export function pageOf(ctx: BrowserToolContext, sessionId: string): string | undefined {
  return ctx.observed.get(sessionId)?.url;
}

export function noteDialogs(ctx: BrowserToolContext, sessionId: string, outcome: BrowserActionOutcome): void {
  const last = (outcome.dialogs ?? (outcome.dialog === undefined ? [] : [outcome.dialog])).findLast((dialog) => dialog.type !== "alert");
  if (last === undefined) return;
  ctx.dismissedDialogs.delete(sessionId);
  const host = hostNow(ctx, sessionId);
  if (last.handled === "accepted" || host === undefined) return;
  ctx.dismissedDialogs.set(sessionId, { message: last.message, host });
  if (ctx.dismissedDialogs.size > MAX_OBSERVED_SESSIONS) ctx.dismissedDialogs.delete(ctx.dismissedDialogs.keys().next().value ?? "");
}

/** The message of the dialog the session last dismissed, while its page is still on that dialog's host. */
export function dismissedDialogOf(ctx: BrowserToolContext, sessionId: string): string | undefined {
  const dismissed = ctx.dismissedDialogs.get(sessionId);
  return dismissed !== undefined && dismissed.host === hostNow(ctx, sessionId) ? dismissed.message : undefined;
}

export function noteApprovedHost(ctx: BrowserToolContext, sessionId: string, url: string, operatorApproved: boolean): void {
  if (!operatorApproved) return;
  const host = hostOfPage(absoluteOf(url));
  if (host === "") return;
  let set = ctx.approvedSessionHosts.get(sessionId);
  if (set === undefined) {
    set = new Set();
    ctx.approvedSessionHosts.set(sessionId, set);
  }
  set.add(host);
}

/** The host the session's page is on now, as last read: what a click, typing or screenshot there acts on. */
function hostNow(ctx: BrowserToolContext, sessionId: string): string | undefined {
  const url = ctx.pageNow.get(sessionId) ?? pageOf(ctx, sessionId);
  const host = url === undefined ? "" : hostOfPage(url);
  return host === "" ? undefined : host;
}

/**
 * The hosts an action or a batch acts on, each as it would be asked about
 * sent alone: a frame-qualified ref (`ref`, or `drag`'s `toRef`) on its
 * frame's host, and an unqualified ref or a step with none on the page's.
 * Empty when the page has no host and no ref names a frame.
 */
export function hostsOfCall(ctx: BrowserToolContext, sessionId: string, input: unknown): string[] {
  const call = input as { readonly ref?: unknown; readonly toRef?: unknown; readonly actions?: unknown } | null;
  const hosts = new Set<string>();
  const pageHost = hostNow(ctx, sessionId);
  const noteRef = (ref: unknown): boolean => {
    if (typeof ref !== "string") return false;
    const frame = elementOf(ctx, sessionId, ref)?.frame;
    const host = frame === undefined ? "" : hostOfPage(frame);
    if (host !== "") hosts.add(host);
    else if (pageHost !== undefined) hosts.add(pageHost);
    return true;
  };
  const noteStep = (step: { readonly ref?: unknown; readonly toRef?: unknown } | null): void => {
    const hadRef = noteRef(step?.ref);
    if (!hadRef && pageHost !== undefined) hosts.add(pageHost);
    noteRef(step?.toRef);
  };
  if (Array.isArray(call?.actions)) {
    for (const step of call.actions as ({ readonly ref?: unknown; readonly toRef?: unknown } | null)[]) noteStep(step);
  } else noteStep(call);
  return [...hosts];
}

/**
 * A browser call held to the host its page (or target frame) is on now
 * (`CallAssessment.scopeHost`): a decision for one site covers no other, so
 * after a click or a redirect led elsewhere the next call there asks again,
 * and a call asked about on its own runs only on the host it was asked about on.
 */
export function onPageHost(ctx: BrowserToolContext, assessment: CallAssessment, input: unknown): CallAssessment {
  const sessionId = (input as { readonly sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== "string") return assessment;
  const [host, ...others] = hostsOfCall(ctx, sessionId, input);
  if (host === undefined) return assessment;
  // A batch whose steps land on frames of other sites is decided for each of them, as its steps sent alone would be.
  const held = { ...assessment, scopeHost: host, ...(others.length === 0 ? {} : { additionalHosts: others }) };
  // A call asked about on its own (a submit, an upload, a dialog accept) is held to the page's host too, when it runs.
  if (assessment.scopeGroup === undefined) return held;
  return { ...held, display: { ...assessment.display, host: assessment.display.host ?? [host, ...others].join(", ") } };
}

export function forget(ctx: BrowserToolContext, sessionId: string): void {
  ctx.shownSites.delete(sessionId);
  ctx.observed.delete(sessionId);
  ctx.pageNow.delete(sessionId);
  ctx.dismissedDialogs.delete(sessionId);
  ctx.approvedSessionHosts.delete(sessionId);
}

/** Refuses a call on a session another workspace or another chat opened: a session is its chat's and its sub-tasks'. */
export function requireChatSession(
  ctx: BrowserToolContext,
  sessionId: string,
  context: Pick<InvocationContext, "workspaceId" | "runId" | "chatTaskId">,
): void {
  requireSessionOf(sessionId, context, ctx.sessionOpener.get(sessionId));
}

/** Cancels the session's in-flight call when the tool handler's `signal` aborts. */
export async function withCancelOnAbort<T>(
  ctx: BrowserToolContext,
  sessionId: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const onAbort = (): void => {
    void ctx.browser.cancel(sessionId).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await run();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The session's page now, as the adapter reads it, else as last observed: a person may have moved it since. */
export async function urlNow(ctx: BrowserToolContext, sessionId: string): Promise<string | undefined> {
  const live = await ctx.browser.currentUrl?.(sessionId);
  if (live !== undefined && live !== "") {
    ctx.pageNow.set(sessionId, live);
    if (ctx.pageNow.size > MAX_OBSERVED_SESSIONS) ctx.pageNow.delete(ctx.pageNow.keys().next().value ?? "");
  }
  return live ?? pageOf(ctx, sessionId);
}
