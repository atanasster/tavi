import { type BrowserActionOutcome, type InvocationContext, TaviError, dispatchBrowserAction } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import type { ToolRegistry } from "@tavi/runtime";

import { assessBrowserAct } from "../approvals/call-assessors.js";
import { cardWords } from "../approvals/card-words.js";
import { awaitingReview } from "../folders/promotion.js";
import {
  type BrowserToolContext,
  dismissedDialogOf,
  elementOf,
  hostsOfCall,
  noteApprovedHost,
  noteDialogs,
  onPageHost,
  pageOf,
  requireChatSession,
  urlNow,
  withCancelOnAbort,
} from "./browser-context.js";
import {
  guardOf,
  noteBlock,
  noteFinalStep,
  opensInTab,
  requireAllowedDestination,
  requireDecidedHost,
  requirePageAllows,
  requireReachedAllows,
  requireSearchOnly,
  requireSiteAllows,
  requireStageAllows,
  tabDestinationOf,
} from "./browser-guards.js";
import { withBlockHints, withPageLabel } from "./browser-results.js";
import { BrowserActInputSchema } from "./browser-schemas.js";
import { withSite } from "./browser-site.js";

/**
 * `open_in_tab`: the list stays open in its tab while the page it links to
 * opens in another. The destination passes every check a `browser.navigate`
 * there would — the site profile's rules, the allowlist or a person's
 * approval for its host, a refused scheme or private address — and must be
 * the host the call was decided on, so a link that changed since opens
 * nothing. A redirect past it is held to the site rules as any page an
 * action reaches.
 */
async function openInTab(
  ctx: BrowserToolContext,
  call: { readonly sessionId: string; readonly ref?: string | undefined; readonly value?: string | undefined },
  run: {
    readonly context: InvocationContext;
    readonly signal: AbortSignal;
    readonly callId?: string | undefined;
    readonly operatorApproved?: boolean | undefined;
    readonly assessedHosts?: readonly string[] | undefined;
    readonly unattended: boolean;
  },
): Promise<unknown> {
  if (call.ref !== undefined && call.value !== undefined)
    throw new TaviError("INVALID_INPUT", "browser.act open_in_tab takes a link's ref or a URL in value, not both");
  const target = tabDestinationOf(ctx, call);
  if (target === undefined) {
    throw new TaviError(
      "INVALID_INPUT",
      call.ref === undefined
        ? "browser.act open_in_tab needs a link's ref or the URL to open in value"
        : `${call.ref} is not a link with an href in the session's latest observation: observe again, or pass the URL in value`,
    );
  }
  const host = URL.parse(target)?.host ?? "";
  if (run.assessedHosts !== undefined && run.assessedHosts.length > 0 && !run.assessedHosts.includes(host)) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `this call was decided for ${run.assessedHosts.join(", ")}, and it now opens ${host}: ask again`,
      {
        details: { host, decided: [...run.assessedHosts] },
      },
    );
  }
  await requireSiteAllows(ctx, target, run.context, run.unattended, run.signal);
  await requireAllowedDestination(ctx, target, run.operatorApproved === true);
  noteApprovedHost(ctx, call.sessionId, target, run.operatorApproved === true);
  const outcome = await withCancelOnAbort(ctx, call.sessionId, run.signal, () =>
    dispatchBrowserAction(ctx.browser, {
      sessionId: call.sessionId,
      kind: "open_in_tab",
      value: target,
      ...(run.callId === undefined ? {} : { callId: run.callId }),
    }),
  );
  noteDialogs(ctx, call.sessionId, outcome);
  await noteBlock(ctx, outcome, run.context.runId);
  // The new tab's own address was checked above: only a redirect past it is another page reached.
  await requireReachedAllows(ctx, call.sessionId, target, run.context, run.unattended, run.signal);
  await urlNow(ctx, call.sessionId);
  return withPageLabel(await withSite(ctx, withBlockHints(outcome, ctx.handoff), run.context.workspaceId), pageOf(ctx, call.sessionId));
}

/** `browser.act`: one action in a session. */
export function registerBrowserAct(registry: ToolRegistry, ctx: BrowserToolContext): void {
  registry.register({
    id: "browser.act",
    sink: "network",
    urlOnly: false,
    version: "1.0.0",
    description:
      "Act in a browser session. On an element from an observation of this page (its ref, and the epoch it came from, or none for the latest): click, type, submit, upload (an approved artifactId, or a file of your working folder by path), download (approved downloads are copied into downloads/ in your chat's own folder), select (an option of a drop-down, native or the site's own, by its name), hover, drag (to toRef or by dx/dy). On the page: press (a key, optionally into a ref), scroll (down, up, top, bottom, left, right, or to/in a ref), back, tab (switch to a tab index from observation.tabs), open_in_tab (a link's ref or a URL in value, in a new tab; the current tab stays open), close_tab (tab, default the active one; never the last), wait_for (text to appear, `url:<part>` for the address to change to hold it, a ref for its element to show, or nothing for the page to go quiet). " +
      "For a field that suggests as you type — an airport, a city, a search box — type with mode keys: the outcome's `page` lists the suggestions to click. `changes` says what the action changed (the URL, a field's value, a list or dialog that opened); check it rather than assuming the action worked. An outcome with `page` is a fresh observation whose refs and epoch replace the old ones: act directly on that `page` without calling `browser.observe` again. A click that opens a new tab moves the session to that tab while keeping the opener in `tabs`. Several form fields: browser.batch. " +
      'Example: {"sessionId":"s1","ref":"e12","kind":"type","value":"Lisbon","mode":"keys"}.',
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    inputSchema: BrowserActInputSchema,
    assess: (input, context) => {
      const call = input as { readonly sessionId?: unknown; readonly ref?: unknown; readonly kind?: unknown; readonly path?: unknown };
      if (call?.kind === "open_in_tab") return opensInTab(ctx, input, cardWords(context));
      // An upload by path: the card shows the file as it is now.
      const file =
        call?.kind === "upload" && typeof call.path === "string" ? ctx.options.promotion?.describe(call.path, context) : undefined;
      // The page typed into, as last observed: under taint, typing is judged by its origin.
      return onPageHost(
        ctx,
        assessBrowserAct(
          input,
          typeof call?.sessionId === "string" && typeof call.ref === "string" ? elementOf(ctx, call.sessionId, call.ref) : undefined,
          file,
          typeof call?.sessionId === "string" ? pageOf(ctx, call.sessionId) : undefined,
          typeof call?.sessionId === "string" ? dismissedDialogOf(ctx, call.sessionId) : undefined,
          cardWords(context),
        ),
        input,
      );
    },
    untrustedOutput: true,
    // Every browser read is personal: sessions share the persistent profile, with the person's cookies.
    outputSource: "web",
    outputConfidentiality: "personal",
    handler: async ({
      input,
      context,
      signal,
      callId,
      approvedBy,
      approvedContentHash,
      contextLabel,
      executionPolicy,
      assessedSubjects,
      assessedHosts,
      operatorApproved,
    }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "browser.act was cancelled");
      const parsed = BrowserActInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "browser.act received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      requireChatSession(ctx, parsed.data.sessionId, context);
      if (parsed.data.kind === "open_in_tab") {
        return openInTab(ctx, parsed.data, {
          context,
          signal,
          callId,
          operatorApproved,
          assessedHosts,
          unattended: executionPolicy?.mode === "unattended",
        });
      }
      await requireDecidedHost(ctx, parsed.data.sessionId, assessedHosts, hostsOfCall(ctx, parsed.data.sessionId, parsed.data));
      await requirePageAllows(ctx, parsed.data.sessionId, context.runId, "act");
      await requireSearchOnly(ctx, parsed.data.sessionId, parsed.data.kind, parsed.data.ref);
      await requireStageAllows(ctx, parsed.data.sessionId, context.workspaceId, [parsed.data.kind]);
      const before = await urlNow(ctx, parsed.data.sessionId);
      // Approved as a commit only when the gate decided this call as a submit: what the person was shown, not a later observation.
      // A download a person approved on its own card may send the form its control belongs to (an export button).
      const guard = await guardOf(
        ctx,
        parsed.data.sessionId,
        assessedSubjects?.includes("submit") === true,
        assessedHosts,
        parsed.data.kind === "download" && assessedSubjects?.includes("download") === true,
      );
      // An upload by path sends the folder file as an artifact, approved by this call's own approval.
      let artifactId = parsed.data.artifactId;
      if (parsed.data.path !== undefined) {
        if (parsed.data.kind !== "upload") throw new TaviError("INVALID_INPUT", "browser.act takes a path only to upload a file");
        if (artifactId !== undefined) throw new TaviError("INVALID_INPUT", "browser.act upload takes exactly one of artifactId and path");
        if (ctx.options.promotion === undefined)
          throw new TaviError("NOT_CONFIGURED", "files from the chat's folder cannot be uploaded here; pass an approved artifactId");
        const promoted = await ctx.options.promotion.promote({
          path: parsed.data.path,
          context,
          approvedBy,
          approvedContentHash,
          contextLabel,
        });
        if (promoted.pending) return awaitingReview("browser.act", promoted);
        artifactId = promoted.record.artifactId;
      }
      const outcome = await withCancelOnAbort(ctx, parsed.data.sessionId, signal, () =>
        dispatchBrowserAction(ctx.browser, {
          sessionId: parsed.data.sessionId,
          ...(parsed.data.ref === undefined ? {} : { ref: parsed.data.ref }),
          ...(parsed.data.epoch === undefined ? {} : { epoch: parsed.data.epoch }),
          kind: parsed.data.kind,
          ...definedOnly({
            value: parsed.data.value,
            toRef: parsed.data.toRef,
            dx: parsed.data.dx,
            dy: parsed.data.dy,
            tab: parsed.data.tab,
            mode: parsed.data.mode,
            clear: parsed.data.clear,
            timeoutMs: parsed.data.timeoutMs,
            artifactId,
            callId,
            dialog:
              parsed.data.dialog === undefined
                ? undefined
                : { ...parsed.data.dialog, ...definedOnly({ message: dismissedDialogOf(ctx, parsed.data.sessionId) }) },
          }),
          // A download is stored labelled with it.
          ...(contextLabel === undefined ? {} : { contextLabel }),
          guard,
        }),
      ).catch(async (error: unknown) => {
        await noteFinalStep(ctx, error, parsed.data.sessionId, context.workspaceId);
        throw error;
      });
      if (outcome.status === "accepted")
        ctx.options.recipes?.acted(parsed.data.sessionId, { kind: parsed.data.kind, ref: parsed.data.ref, value: parsed.data.value });
      noteDialogs(ctx, parsed.data.sessionId, outcome);
      await noteBlock(ctx, outcome, context.runId);
      await requireReachedAllows(ctx, parsed.data.sessionId, before, context, executionPolicy?.mode === "unattended", signal);
      // Where the action left the page (a link, a redirect): the next call there is held to that host.
      await urlNow(ctx, parsed.data.sessionId);
      let verifiedOutcome: BrowserActionOutcome & { readonly verify?: unknown } = outcome;
      if (assessedSubjects?.includes("submit") === true && outcome.status === "accepted") {
        const postPage = outcome.page ?? (await ctx.browser.observe(parsed.data.sessionId).catch(() => undefined));
        const statusTexts = (postPage?.elements ?? [])
          .filter(
            (el) =>
              (el.role === "status" || el.role === "alert" || el.role === "heading") &&
              typeof el.text === "string" &&
              el.text.trim() !== "",
          )
          .map((el) => `${el.role}: ${el.text}`);
        const postChanges = [
          ...(outcome.changes ?? []),
          ...(outcome.detail !== undefined && (outcome.changes ?? []).length === 0 ? [outcome.detail] : []),
        ];
        verifiedOutcome = {
          ...outcome,
          ...(outcome.page === undefined && postPage !== undefined ? { page: postPage } : {}),
          verify: {
            ...(postChanges.length === 0 ? {} : { changes: postChanges }),
            ...(statusTexts.length === 0 ? {} : { status: statusTexts }),
            note: "Confirm the page's status and changes show the commit succeeded before reporting success.",
          },
        };
      }
      return withPageLabel(
        await withSite(ctx, withBlockHints(verifiedOutcome, ctx.handoff), context.workspaceId),
        pageOf(ctx, parsed.data.sessionId),
      );
    },
  });
}
