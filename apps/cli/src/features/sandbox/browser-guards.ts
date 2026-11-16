import { type BrowserActGuard, type CallAssessment, TaviError, urlIsFinalStep } from "@tavi/contracts";
import { hostAllowed, isIpLiteralHost } from "@tavi/runtime";

import { assessBrowserAct, commitsFormSubmit, exemptAsSearch } from "../approvals/call-assessors.js";
import { listedExactly, literalAddressRefusal, resolvedAddressRefusal } from "../browser/address-guard.js";
import { hostAllowedWithPort } from "../http/tools.js";
import {
  type BrowserToolContext,
  COMMITS,
  LOOKING_KINDS,
  absoluteOf,
  elementOf,
  hostOfPage,
  pageOf,
  portOf,
  unreachableHost,
  urlNow,
} from "./browser-context.js";

/** What the browser checks before it opens a page or acts on one: the operator's list, the site profiles, the host decided on. */

/** What a navigation that names no page it can open is told. */
export const NEEDS_TARGET = "browser.navigate needs an absolute http(s) URL, or one relative to the session's page";

/**
 * The absolute URL a navigation opens: the URL itself (a protocol-relative one
 * over https), or one relative to the session's page resolved against it.
 * What is checked, named on the card and opened is this one href, never the
 * text the model wrote, which the browser would complete on its own terms
 * (Playwright opens `127.0.0.1.attacker.example/x` as `http://` to that host).
 */
export function navigationTarget(ctx: BrowserToolContext, url: string, sessionId?: unknown): string | undefined {
  if (URL.canParse(absoluteOf(url))) return absoluteOf(url);
  const page = typeof sessionId === "string" ? pageOf(ctx, sessionId) : undefined;
  return page === undefined ? undefined : URL.parse(url, page)?.href;
}

/**
 * Why a navigation to an absolute URL (`navigationTarget`) is refused, if it
 * is: one that does not parse is refused, since the browser would choose
 * where it goes.
 *
 * A call a person's decision covers passes: the list exists because the URL
 * is model-authored, and refusing a call a person allowed made the approval
 * a question with no effect. A browser decision covers the hosts it named
 * (a grant carries the host), so another host is asked about again. The
 * list is what the browser may open when nobody was asked.
 *
 * Whatever a person decided, a host that is this machine or a private
 * network — loopback, RFC 1918 and ULA, link-local and the metadata
 * service, CGNAT — is refused unless the operator listed it: a click on a
 * card is not how the LAN's admin pages or a local server are opened.
 */
function destinationRefusal(ctx: BrowserToolContext, url: string, operatorApproved: boolean): TaviError | undefined {
  // `//evil.example/x` is *protocol-relative*: `new URL` rejects it, but the
  // browser resolves it to `https://evil.example/x`, so treating it as a
  // relative path would be a straight bypass of this check. Resolved against the current page's scheme instead.
  const candidate = absoluteOf(url);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return new TaviError("INVALID_INPUT", NEEDS_TARGET);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return new TaviError("INVALID_INPUT", `browser.navigate cannot open a ${parsed.protocol} URL`);
  }
  const listed = hostAllowedWithPort(parsed, ctx.allowedHosts);
  // This machine or the private network opens only for a host:port the operator listed exactly, as at the egress proxy.
  const opened =
    listedExactly(parsed.hostname, portOf(parsed), ctx.allowedHosts) || hostAllowed(parsed.hostname, ctx.options.privateHostsAllowed ?? []);
  const literal = opened ? undefined : literalAddressRefusal(parsed.hostname);
  if (literal !== undefined) return unreachableHost(parsed.hostname, literal);
  if (operatorApproved) return undefined;
  // An enabled site profile opens its own hosts for browsing it, and nothing wider.
  if (ctx.options.sites?.allowsDestinationNow(parsed.href) === true) return undefined;
  if (ctx.allowedHosts.length === 0) {
    return new TaviError(
      "NOT_AUTHORIZED",
      `browser.navigate has no allowed destinations: the operator has not passed --browser-allow-host, and the ` +
        `destination is model-authored. ${parsed.host} opens once a person allows the browser for this task.`,
    );
  }
  if (!listed) {
    return new TaviError(
      "NOT_AUTHORIZED",
      `browser.navigate may not reach ${parsed.hostname} unasked: it is not in the operator's allowlist, and no person allowed the browser for this task.`,
      { details: { host: parsed.hostname, allowedHostCount: ctx.allowedHosts.length } },
    );
  }
  return undefined;
}

/** Whether a frame at `frameUrl` inside `pageUrl` may be read: see `RegisteredBrowserTools.frameHostAllowed`. */
export function frameUrlAllowed(ctx: BrowserToolContext, frameUrl: string, pageUrl: string, sessionId: string): boolean {
  const frameHost = hostOfPage(frameUrl);
  if (frameHost === "" || frameHost === hostOfPage(pageUrl)) return true;
  return destinationRefusal(ctx, frameUrl, ctx.approvedSessionHosts.get(sessionId)?.has(frameHost) === true) === undefined;
}

/** A new session has no page for a relative URL to resolve against. */
export function opensFromNothing(url: string): boolean {
  return URL.canParse(absoluteOf(url));
}

/**
 * A name that resolves to an address no approval opens. A resolver that
 * fails or answers nothing leaves the name to the browser, which then fails
 * to resolve it too. The browser resolves the name again itself, so this
 * catches a name that points at a private address, not a rebinding race.
 */
async function resolvedRefusal(ctx: BrowserToolContext, url: string): Promise<TaviError | undefined> {
  const parsed = URL.parse(absoluteOf(url));
  if (
    parsed === null ||
    isIpLiteralHost(parsed.hostname) ||
    listedExactly(parsed.hostname, portOf(parsed), ctx.allowedHosts) ||
    hostAllowed(parsed.hostname, ctx.options.privateHostsAllowed ?? [])
  )
    return undefined;
  const refusal = await resolvedAddressRefusal(parsed.hostname, ctx.resolveHost);
  return refusal === undefined ? undefined : unreachableHost(parsed.hostname, refusal);
}

export async function requireAllowedDestination(ctx: BrowserToolContext, url: string, operatorApproved: boolean): Promise<void> {
  const refusal = destinationRefusal(ctx, url, operatorApproved);
  if (refusal !== undefined) {
    // A private address no site profile opens.
    const privateAddress = (refusal.details as { readonly privateAddress?: unknown } | undefined)?.privateAddress === true;
    // The profiles may have changed since the assessment read them: asked again, fresh.
    if (privateAddress || refusal.code !== "NOT_AUTHORIZED" || (await ctx.options.sites?.allowsDestination(absoluteOf(url))) !== true)
      throw refusal;
  }
  const resolved = await resolvedRefusal(ctx, url);
  if (resolved !== undefined) throw resolved;
}

/** A profiled host's rules and budgets before a page is opened there. */
export async function requireSiteAllows(
  ctx: BrowserToolContext,
  url: string,
  context: { readonly workspaceId: string; readonly runId: string },
  unattended: boolean,
  signal: AbortSignal,
): Promise<void> {
  const refusal = await ctx.options.sites?.beforeNavigate({
    workspaceId: context.workspaceId,
    taskId: context.runId,
    url: absoluteOf(url),
    unattended,
    signal,
  });
  if (refusal !== undefined)
    throw new TaviError("NOT_AUTHORIZED", refusal.refused, {
      details: {
        host: refusal.host,
        ...(refusal.budgetExhausted === true ? { budgetExhausted: true } : {}),
        ...(refusal.resetsAt === undefined ? {} : { resetsAt: refusal.resetsAt }),
      },
    });
}

/**
 * The page is still on the host the call was decided on (`assessedHosts`):
 * a timed script or a redirect that moved it since leaves a decision for
 * one site behind, so the call is refused rather than made on another.
 * A call that acts only in frames (`callHosts`, from `hostsOfCall`) needs
 * the page unmoved and each of those frames' hosts decided, not the page's.
 */
export async function requireDecidedHost(
  ctx: BrowserToolContext,
  sessionId: string,
  assessedHosts: readonly string[] | undefined,
  callHosts: readonly string[] = [],
): Promise<void> {
  if (assessedHosts === undefined || assessedHosts.length === 0) return;
  const observedHost = hostOfPage(pageOf(ctx, sessionId) ?? "");
  const host = hostOfPage((await urlNow(ctx, sessionId)) ?? "");
  if (host !== "" && assessedHosts.includes(host)) return;
  if (callHosts.length > 0 && host !== "" && host === observedHost && callHosts.every((callHost) => assessedHosts.includes(callHost))) {
    return;
  }
  // A page with no host of its own (about:blank, data:, an opaque origin) is not the site decided on either.
  throw new TaviError(
    "NOT_AUTHORIZED",
    `the page moved to ${host === "" ? "a page with no host" : host} since this call was decided; observe it and act again`,
    { details: { host, decided: [...assessedHosts] } },
  );
}

/** On a page of a profiled host: what this tool may do there (rules 5, 6, 11). */
export async function requirePageAllows(
  ctx: BrowserToolContext,
  sessionId: string,
  runId: string,
  tool: "act" | "extract" | "vision_act",
): Promise<void> {
  const refusal = await ctx.options.sites?.refuseOnPage({ taskId: runId, url: await urlNow(ctx, sessionId), tool });
  if (refusal !== undefined) throw new TaviError("NOT_AUTHORIZED", refusal.refused, { details: { host: refusal.host } });
}

/** A page an action led to on a profiled host is held to its rules too (rules 3, 5, 10): its content is not returned otherwise. */
export async function requireReachedAllows(
  ctx: BrowserToolContext,
  sessionId: string,
  from: string | undefined,
  context: { readonly workspaceId: string; readonly runId: string },
  unattended: boolean,
  signal: AbortSignal,
): Promise<void> {
  const refusal = await ctx.options.sites?.pageReached({
    workspaceId: context.workspaceId,
    taskId: context.runId,
    from,
    url: await urlNow(ctx, sessionId),
    unattended,
    signal,
  });
  if (refusal !== undefined)
    throw new TaviError("NOT_AUTHORIZED", `the action led to a page Tavi may not read: ${refusal.refused}`, {
      details: { host: refusal.host },
    });
}

/**
 * On a site read for the turn only: reading and searching, nothing more. Typing goes only into a
 * search box or a suggesting field, and Enter only there; no submit, upload or download, and no press on a
 * control that sends, buys, applies or signs in.
 */
export async function requireSearchOnly(ctx: BrowserToolContext, sessionId: string, kind: string, ref: string | undefined): Promise<void> {
  if (LOOKING_KINDS.has(kind)) return;
  if ((await ctx.options.sites?.readOnlyForTurn(await urlNow(ctx, sessionId))) !== true) return;
  const element = ref === undefined ? undefined : elementOf(ctx, sessionId, ref);
  const searching = exemptAsSearch(element);
  // A click on a form's submit outside a search form sends it, whatever its label (an icon, "Weiter").
  const allowed =
    kind === "type" || kind === "press" || kind === "select"
      ? searching
      : kind === "click"
        ? !commitsFormSubmit(element) && !COMMITS.test(element?.text ?? "")
        : false;
  if (!allowed)
    throw new TaviError(
      "NOT_AUTHORIZED",
      "this site is read for the chat only: Tavi searches and reads it, and never fills, sends or signs in there",
    );
}

/**
 * What the browser re-checks before this press: the stage profile's final step on the page, and
 * whether the call's card said it commits (so the person approved a commit, and only then).
 */
export async function guardOf(
  ctx: BrowserToolContext,
  sessionId: string,
  commitApproved: boolean,
  hosts?: readonly string[],
  formSendApproved = false,
): Promise<BrowserActGuard> {
  const rule = await ctx.options.sites?.finalStepRule(await urlNow(ctx, sessionId));
  // The browser reads the page's host again the moment before it acts.
  return {
    commitApproved,
    ...(formSendApproved ? { formSendApproved: true } : {}),
    ...(rule === undefined ? {} : { finalStep: rule }),
    ...(hosts === undefined || hosts.length === 0 ? {} : { hosts: [...hosts] }),
  };
}

/** A stage site's final steps for today used (`stage.perDay`): no more acting there. */
export async function requireStageAllows(
  ctx: BrowserToolContext,
  sessionId: string,
  workspaceId: string,
  kinds: readonly string[],
): Promise<void> {
  const url = await urlNow(ctx, sessionId);
  const refusal = await ctx.options.sites?.stageRefusal({ workspaceId, url });
  if (refusal !== undefined)
    throw new TaviError("NOT_AUTHORIZED", refusal.refused, {
      details: { host: refusal.host, budgetExhausted: true, ...(refusal.resetsAt === undefined ? {} : { resetsAt: refusal.resetsAt }) },
    });
  // On the final step's own address nothing is done but to look and leave.
  const rule = url === undefined ? undefined : await ctx.options.sites?.finalStepRule(url);
  if (url !== undefined && rule !== undefined && urlIsFinalStep(url, rule) && kinds.some((kind) => !LOOKING_KINDS.has(kind))) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      "this page is the form's or booking's last step: Tavi stops here, and the person reviews and submits it themselves in the live view (browser.request_handoff)",
      { details: { guard: "final-step" } },
    );
  }
}

/** A final step the browser refused counts against the profile's day. */
export async function noteFinalStep(ctx: BrowserToolContext, error: unknown, sessionId: string, workspaceId: string): Promise<void> {
  if (error instanceof TaviError && (error.details as { readonly guard?: unknown } | undefined)?.guard === "final-step")
    await ctx.options.sites?.finalStepReached({ workspaceId, sessionId, url: await urlNow(ctx, sessionId) });
}

/** A captcha, bot wall or rate limit on a profiled page ends that site for the task. */
export async function noteBlock<T>(ctx: BrowserToolContext, result: T, runId: string): Promise<T> {
  const value = result as {
    readonly url?: unknown;
    readonly blocked?: { readonly kind?: unknown };
    readonly page?: { readonly url?: unknown; readonly blocked?: { readonly kind?: unknown } };
  };
  const page = value.blocked === undefined ? value.page : value;
  if (typeof page?.blocked?.kind === "string")
    await ctx.options.sites?.blocked({ taskId: runId, url: typeof page.url === "string" ? page.url : undefined, kind: page.blocked.kind });
  return result;
}

/**
 * A call's assessment with its destination read: a URL nobody can allow (a
 * `file:` URL) is refused before anyone is asked; a host off the list is asked
 * about, and the card says allowing the browser is what opens it.
 */
export function withDestination(ctx: BrowserToolContext, assessment: CallAssessment, input: unknown): CallAssessment {
  const url = (input as { readonly url?: unknown }).url;
  if (typeof url !== "string") return assessment;
  const target = navigationTarget(ctx, url, (input as { readonly sessionId?: unknown }).sessionId);
  if (target === undefined) return { ...assessment, hardDeny: NEEDS_TARGET };
  const refusal = destinationRefusal(ctx, target, true);
  if (refusal !== undefined) return { ...assessment, hardDeny: refusal.message };
  const named = withOpenedHost(assessment, target);
  return destinationRefusal(ctx, target, false) === undefined
    ? named
    : {
        ...named,
        reasons: [
          ...named.reasons,
          `a site this task asked for: allowing the browser opens ${named.display.host ?? "it"}, and asks again for another site`,
        ],
      };
}

/**
 * The assessment naming the host a navigation's target (`navigationTarget`)
 * opens. The host is the call's subject, which a grant for the browser
 * carries, so it must be the host the browser will reach, not the text the
 * model wrote.
 */
function withOpenedHost(assessment: CallAssessment, target: string): CallAssessment {
  const host = URL.parse(target)?.host;
  const before = assessment.display.host;
  if (host === undefined || host === "" || before === undefined || host === before) return assessment;
  return {
    ...assessment,
    subjects: [host],
    display: { ...assessment.display, title: assessment.display.title.split(before).join(host), host },
  };
}

/**
 * Where `browser.act {kind:"open_in_tab"}` goes: a link's `href` as the
 * session's observation listed it, or the URL in `value`, made absolute
 * (a protocol-relative one over https, a relative one against the page).
 */
export function tabDestinationOf(ctx: BrowserToolContext, input: unknown): string | undefined {
  const call = input as { readonly sessionId?: unknown; readonly ref?: unknown; readonly value?: unknown } | null;
  if (typeof call?.sessionId !== "string") return undefined;
  const url =
    typeof call.ref === "string" ? elementOf(ctx, call.sessionId, call.ref)?.href : typeof call.value === "string" ? call.value : undefined;
  if (url === undefined || url === "") return undefined;
  return navigationTarget(ctx, url, call.sessionId);
}

/**
 * `open_in_tab` asked about as the navigation it is (`browser.navigate`'s
 * card and destination checks) and held to the host it opens, not the page
 * it leaves: a grant for the browser on that host covers it as it covers a
 * navigate there, and nothing else.
 */
export function opensInTab(ctx: BrowserToolContext, input: unknown): CallAssessment {
  const call = input as { readonly sessionId?: unknown; readonly ref?: unknown } | null;
  const element =
    typeof call?.sessionId === "string" && typeof call.ref === "string" ? elementOf(ctx, call.sessionId, call.ref) : undefined;
  const assessed = assessBrowserAct(input, element);
  const url = tabDestinationOf(ctx, input);
  if (url === undefined || assessed.hardDeny !== undefined) return assessed;
  const destined = withDestination(ctx, assessed, { sessionId: call?.sessionId, url });
  const host = URL.parse(url)?.host ?? "";
  return host === "" ? destined : { ...destined, subjects: [host], scopeHost: host, display: { ...destined.display, host } };
}
