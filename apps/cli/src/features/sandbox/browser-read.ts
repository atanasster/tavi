import { TaviError } from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

import { type BrowserToolContext, pageOf, requireChatSession, withCancelOnAbort } from "./browser-context.js";
import { noteBlock } from "./browser-guards.js";
import { withBlockHints, withPageLabel } from "./browser-results.js";
import { BrowserReadInputSchema } from "./browser-schemas.js";

/** `browser.read`: the text of the session's page. */
export function registerBrowserRead(registry: ToolRegistry, ctx: BrowserToolContext): void {
  registry.register({
    id: "browser.read",
    sink: "none",
    version: "1.0.0",
    description:
      "Read the text of a browser session's current page — an article's body, a document — which navigate/observe leave out; for its records (listings, products, a table), use browser.structured, then browser.extract. Long pages come in pieces: pass the previous read's `nextOffset` as `offset` to continue. It waits up to 15 seconds for content a page renders late; `stillLoading`, when set, means the page still looked to be loading even then — its text may be incomplete, so read again, and if what you need never arrives say so rather than guessing. `recovery`, when set, says the page shows an error and what to try (its Reload button, navigating again) before looking elsewhere. `blocked` means what it does for browser.navigate.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    // The page author's own words reach the model.
    untrustedOutput: true,
    // Every browser read is personal: sessions share the persistent profile, with the person's cookies.
    outputSource: "web",
    outputConfidentiality: "personal",
    inputSchema: BrowserReadInputSchema,
    handler: async ({ input, context, signal }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "browser.read was cancelled");
      const parsed = BrowserReadInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "browser.read received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      requireChatSession(ctx, parsed.data.sessionId, context);
      const read = await withCancelOnAbort(ctx, parsed.data.sessionId, signal, () =>
        ctx.browser.read(parsed.data.sessionId, parsed.data.offset),
      );
      // A block seen in a read ends the site for the task too.
      await noteBlock(ctx, read, context.runId);
      return withPageLabel(withBlockHints(read, ctx.handoff), pageOf(ctx, parsed.data.sessionId));
    },
  });
}
