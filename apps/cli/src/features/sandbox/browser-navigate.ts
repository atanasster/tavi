import { TaviError } from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

import { assessBrowserNavigate } from "../approvals/call-assessors.js";
import { cardWords } from "../approvals/card-words.js";
import { type BrowserToolContext, noteApprovedHost, requireChatSession, withCancelOnAbort } from "./browser-context.js";
import {
  NEEDS_TARGET,
  navigationTarget,
  noteBlock,
  requireAllowedDestination,
  requireSiteAllows,
  withDestination,
} from "./browser-guards.js";
import { recipeReplayFor, withBlockHints, withPageLabel, withScreenshot } from "./browser-results.js";
import { BrowserNavigateInputSchema } from "./browser-schemas.js";
import { withSite } from "./browser-site.js";

/** `browser.navigate`: a session to a URL, observed. */
export function registerBrowserNavigate(registry: ToolRegistry, ctx: BrowserToolContext): void {
  registry.register({
    id: "browser.navigate",
    sink: "network",
    urlOnly: true,
    version: "1.0.0",
    description:
      "Navigate a browser session to a URL and observe its interactive elements (at most 60, the page's content first; `elementsOmitted` counts the rest). A link's element carries its `href`: navigate to it to open the link directly. Use browser.read for the page's text. A cookie banner is declined for you (`consentDeclined`). `blocked` means the page is a captcha, bot wall, rate limit, consent wall or sign-in rather than what you asked for: follow its `hint`, and never try to solve a captcha.",
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    inputSchema: BrowserNavigateInputSchema,
    assess: (input, context) => withDestination(ctx, assessBrowserNavigate(input, cardWords(context)), input),
    // The page's text reaches the model: web content is untrusted.
    untrustedOutput: true,
    // Every browser read is personal: sessions share the persistent profile, with the person's cookies.
    outputSource: "web",
    outputConfidentiality: "personal",
    handler: async ({ input, context, signal, operatorApproved, callId, contextLabel, executionPolicy }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "browser.navigate was cancelled");
      const parsed = BrowserNavigateInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "browser.navigate received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      requireChatSession(ctx, parsed.data.sessionId, context);
      // The one absolute URL checked and opened; a relative URL resolves against the session's page.
      const target = navigationTarget(ctx, parsed.data.url, parsed.data.sessionId);
      if (target === undefined) throw new TaviError("INVALID_INPUT", NEEDS_TARGET);
      // A profiled host's own refusal first: it says why, and counts no page.
      await requireSiteAllows(ctx, target, context, executionPolicy?.mode === "unattended", signal);
      await requireAllowedDestination(ctx, target, operatorApproved === true);
      noteApprovedHost(ctx, parsed.data.sessionId, target, operatorApproved === true);
      return withPageLabel(
        await withSite(
          ctx,
          withBlockHints(
            await noteBlock(
              ctx,
              await withScreenshot(
                ctx.browser,
                await withCancelOnAbort(ctx, parsed.data.sessionId, signal, () =>
                  ctx.browser.navigate(parsed.data.sessionId, target, callId === undefined ? undefined : { callId }),
                ),
                contextLabel,
              ),
              context.runId,
            ),
            ctx.handoff,
          ),
          context.workspaceId,
          recipeReplayFor(context, executionPolicy, contextLabel, signal),
        ),
      );
    },
  });
}
