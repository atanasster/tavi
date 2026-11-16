import { BROWSER_REQUEST_HANDOFF_TOOL_ID, BrowserRequestHandoffInputSchema, TaviError } from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

import type { BrowserToolContext } from "./browser-context.js";

/** `browser.request_handoff`, when the owner serves the live view: answered by the agent loop itself. */
export function registerBrowserRequestHandoff(registry: ToolRegistry, ctx: BrowserToolContext): void {
  if (ctx.options.handoff === true) {
    registry.register({
      id: BROWSER_REQUEST_HANDOFF_TOOL_ID,
      sink: "none",
      version: "1.0.0",
      description:
        "Ask the operator to act in this browser session themselves — sign in, enter a one-time code, solve a human check, enter payment details, accept consent — and wait until they hand it back from Tavi's live view. Use it only when a person must act in the page; for information that is not secret (an address, a choice), use operator.ask_user instead. Never ask the operator to tell you a password or code. Must be the only tool call in its turn. The result says how it went (`done`, `failed`, `timeout`, `cancelled`), the operator's note, and the page as it is now: check the page, do not assume it worked.",
      // Asking for help is not an action: nothing happens in the page until the person acts.
      effect: "read-only",
      requiredPermissions: ["tools.invoke"],
      inputSchema: BrowserRequestHandoffInputSchema,
      // The page it returns is the site's content, as any observation is.
      untrustedOutput: true,
      // Every browser read is personal: sessions share the persistent profile, with the person's cookies.
      outputSource: "web",
      outputConfidentiality: "personal",
      // Defensive only: `toolsNode` dispatches it directly, as it does `operator.ask_user`, so it can suspend.
      handler: async () => {
        throw new TaviError(
          "INTERNAL",
          "browser.request_handoff is handled by the agent loop itself; it cannot be called through the general tool registry",
        );
      },
    });
  }
}
