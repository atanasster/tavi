import { TOOL_MEDIA_KEY, TaviError } from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

import { assessBrowserCreateSession } from "../approvals/call-assessors.js";
import { cardWords } from "../approvals/card-words.js";
import { chatOf } from "../browser/session-input.js";
import { type BrowserToolContext, noteApprovedHost, withCancelOnAbort } from "./browser-context.js";
import {
  navigationTarget,
  noteBlock,
  opensFromNothing,
  requireAllowedDestination,
  requireSiteAllows,
  withDestination,
} from "./browser-guards.js";
import { recipeReplayFor, withBlockHints, withPageLabel, withScreenshot } from "./browser-results.js";
import { BrowserCreateSessionInputSchema, NEEDS_ABSOLUTE_URL } from "./browser-schemas.js";
import { withSite } from "./browser-site.js";

/** `browser.create_session`: a new session, and its first page when the call names one. */
export function registerBrowserCreateSession(registry: ToolRegistry, ctx: BrowserToolContext): void {
  registry.register({
    id: "browser.create_session",
    sink: "network",
    urlOnly: true,
    version: "1.0.0",
    description:
      "Open a new browser session. Pass `url` to open the first page in the same call and observe it. Use this for a website the user names, and for what only a live site shows — current prices, schedules, availability, a search or booking form — including a site web search pointed to: the person is asked once to allow the browser.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: BrowserCreateSessionInputSchema,
    assess: (input, context) => {
      const t = cardWords(context);
      const url = (input as { readonly url?: unknown }).url;
      // Refused before anyone is asked: allowing it could not make it open.
      if (typeof url === "string" && !opensFromNothing(url))
        return { ...assessBrowserCreateSession(input, t), hardDeny: NEEDS_ABSOLUTE_URL };
      return withDestination(ctx, assessBrowserCreateSession(input, t), input, t);
    },
    // With a `url`, the page's text reaches the model.
    untrustedOutput: true,
    // Every browser read is personal: sessions share the persistent profile, with the person's cookies.
    outputSource: "web",
    outputConfidentiality: "personal",
    handler: async ({ input, context, signal, operatorApproved, callId, contextLabel, executionPolicy }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "browser.create_session was cancelled");
      const parsed = BrowserCreateSessionInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "browser.create_session received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      if (parsed.data.url !== undefined && !opensFromNothing(parsed.data.url)) throw new TaviError("INVALID_INPUT", NEEDS_ABSOLUTE_URL);
      // The one absolute URL checked and opened (a protocol-relative one over https).
      const target = parsed.data.url === undefined ? undefined : navigationTarget(ctx, parsed.data.url);
      if (target !== undefined) {
        // A profiled host's own refusal first: it says why, and counts no page.
        await requireSiteAllows(ctx, target, context, executionPolicy?.mode === "unattended", signal);
        await requireAllowedDestination(ctx, target, operatorApproved === true);
      }
      // The invoking workspace, never the model's claim; the calling task, so
      // the session is recorded against it.
      const session = await ctx.browser.createSession({
        workspaceId: context.workspaceId,
        taskId: context.runId,
        ...(callId === undefined ? {} : { callId }),
        ...(parsed.data.profile === undefined ? {} : { profile: parsed.data.profile }),
      });
      ctx.sessionOpener.set(session.sessionId, { workspaceId: context.workspaceId, chatId: chatOf(context) });
      if (target === undefined) return session;
      noteApprovedHost(ctx, session.sessionId, target, operatorApproved === true);
      try {
        const page = withBlockHints(
          await noteBlock(
            ctx,
            await withScreenshot(
              ctx.browser,
              await withCancelOnAbort(ctx, session.sessionId, signal, () =>
                ctx.browser.navigate(session.sessionId, target, callId === undefined ? undefined : { callId }),
              ),
              contextLabel,
            ),
            context.runId,
          ),
          ctx.handoff,
        );
        // The model sees a picture only at a result's top level, as a navigate's.
        const { [TOOL_MEDIA_KEY]: media, ...shown } = page as typeof page & { readonly [TOOL_MEDIA_KEY]?: unknown };
        return withPageLabel(
          await withSite(
            ctx,
            { ...session, page: shown, ...(media === undefined ? {} : { [TOOL_MEDIA_KEY]: media }) },
            context.workspaceId,
            recipeReplayFor(context, executionPolicy, contextLabel, signal),
          ),
        );
      } catch (error) {
        // The model never learns this session's id, so nothing else could close it.
        await ctx.browser.close(session.sessionId).catch(() => undefined);
        ctx.sessionOpener.delete(session.sessionId);
        throw error;
      }
    },
  });
}
