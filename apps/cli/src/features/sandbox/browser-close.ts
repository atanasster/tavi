import { TaviError } from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

import { assessBrowserSession } from "../approvals/call-assessors.js";
import { type BrowserToolContext, forget, requireChatSession } from "./browser-context.js";
import { BrowserSessionInputSchema } from "./browser-schemas.js";

/** `browser.close`: the session, and what this process kept of it. */
export function registerBrowserClose(registry: ToolRegistry, ctx: BrowserToolContext): void {
  registry.register({
    id: "browser.close",
    sink: "none",
    version: "1.0.0",
    description: "Close a browser session.",
    // Ends the calling chat's own session (`requireChatSession`), and no other's: it reaches nothing new, so what the chat read gives no reason to ask.
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: BrowserSessionInputSchema,
    assess: assessBrowserSession("approval.card.browser.close"),
    handler: async ({ input, context, signal }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "browser.close was cancelled");
      const parsed = BrowserSessionInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "browser.close received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      requireChatSession(ctx, parsed.data.sessionId, context);
      await ctx.browser.close(parsed.data.sessionId);
      forget(ctx, parsed.data.sessionId);
      return { closed: true };
    },
  });
}
