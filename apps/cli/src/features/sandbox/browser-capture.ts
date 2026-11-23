import { TOOL_MEDIA_KEY, TaviError } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import type { ToolRegistry } from "@tavi/runtime";

import { assessBrowserSession } from "../approvals/call-assessors.js";
import { type BrowserToolContext, hostsOfCall, onPageHost, requireChatSession } from "./browser-context.js";
import { requireDecidedHost } from "./browser-guards.js";
import { BrowserCaptureInputSchema } from "./browser-schemas.js";

/** `browser.capture`: a screenshot of the session's page. */
export function registerBrowserCapture(registry: ToolRegistry, ctx: BrowserToolContext): void {
  registry.register({
    id: "browser.capture",
    sink: "none",
    version: "1.0.0",
    description:
      "Capture a screenshot of a browser session. With `forModel: true` you see it: use it when the page's text does not say what you need — a chart, a map, a seat plan, a widget whose state the elements do not show, an error you cannot read. " +
      "A page with a password, payment or one-time-code field is never shown. Without `forModel` it is kept as an artifact for the person to review.",
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    inputSchema: BrowserCaptureInputSchema,
    assess: (input, context) => onPageHost(ctx, assessBrowserSession("approval.card.browser.screenshot")(input, context), input),
    // A screenshot of a page shows its author's text to a vision model.
    untrustedOutput: true,
    // Every browser read is personal: sessions share the persistent profile, with the person's cookies.
    outputSource: "web",
    outputConfidentiality: "personal",
    handler: async ({ input, context, signal, contextLabel, assessedHosts }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "browser.capture was cancelled");
      const parsed = BrowserCaptureInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "browser.capture received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      requireChatSession(ctx, parsed.data.sessionId, context);
      await requireDecidedHost(ctx, parsed.data.sessionId, assessedHosts, hostsOfCall(ctx, parsed.data.sessionId, parsed.data));
      // Stored labelled with the page's and this conversation's.
      const captureOpts = definedOnly({
        contextLabel,
        marks: parsed.data.marks,
        ref: parsed.data.ref,
        epoch: parsed.data.epoch,
        region: parsed.data.region,
      });
      if (parsed.data.forModel !== true) {
        return ctx.browser.capture(parsed.data.sessionId, Object.keys(captureOpts).length === 0 ? undefined : captureOpts);
      }
      const capture = await ctx.browser.capture(parsed.data.sessionId, { forModel: true, ...captureOpts });
      return { ...capture, [TOOL_MEDIA_KEY]: { artifactId: capture.artifactId, mediaType: capture.contentType ?? "image/jpeg" } };
    },
  });
}
