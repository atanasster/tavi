import { TaviError } from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

import { type BrowserToolContext, requireChatSession, withCancelOnAbort } from "./browser-context.js";
import { noteBlock } from "./browser-guards.js";
import { withBlockHints, withPageLabel, withScreenshot } from "./browser-results.js";
import { BrowserObserveInputSchema } from "./browser-schemas.js";
import { withSite } from "./browser-site.js";

/** `browser.observe`: the session's page again, or part of it. */
export function registerBrowserObserve(registry: ToolRegistry, ctx: BrowserToolContext): void {
  registry.register({
    id: "browser.observe",
    sink: "none",
    version: "1.0.0",
    description:
      "Re-observe a browser session's current page without navigating, or part of it (`scope`: main, dialog, form, or one element's part by ref) and only what a person acts on (`filter: interactive`) — less to read on a busy page. " +
      "A ref names the same element for the session's life, so re-observing keeps the refs you know. `blocked` and `consentDeclined` mean what they do for browser.navigate; a `covered` element is under something else (a banner, a modal) a click would reach first.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    untrustedOutput: true,
    // Every browser read is personal: sessions share the persistent profile, with the person's cookies.
    outputSource: "web",
    outputConfidentiality: "personal",
    inputSchema: BrowserObserveInputSchema,
    handler: async ({ input, context, signal, contextLabel }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "browser.observe was cancelled");
      const parsed = BrowserObserveInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "browser.observe received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      requireChatSession(ctx, parsed.data.sessionId, context);
      const options = {
        ...(parsed.data.scope === undefined ? {} : { scope: parsed.data.scope }),
        ...(parsed.data.filter === undefined ? {} : { filter: parsed.data.filter }),
      };
      const whole = Object.keys(options).length === 0;
      return withPageLabel(
        await withSite(
          ctx,
          withBlockHints(
            await noteBlock(
              ctx,
              await withScreenshot(
                ctx.browser,
                await withCancelOnAbort(ctx, parsed.data.sessionId, signal, () =>
                  ctx.browser.observe(parsed.data.sessionId, whole ? undefined : options),
                ),
                contextLabel,
                whole,
              ),
              context.runId,
            ),
            ctx.handoff,
          ),
          context.workspaceId,
        ),
      );
    },
  });
}
