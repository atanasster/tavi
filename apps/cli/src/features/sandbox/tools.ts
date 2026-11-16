import type { BrowserObservation, BrowserPort, SandboxPort } from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

import { registerBrowserAct } from "./browser-act.js";
import { registerBrowserBatch } from "./browser-batch.js";
import { registerBrowserCapture } from "./browser-capture.js";
import { registerBrowserClose } from "./browser-close.js";
import type { SessionOpener } from "../browser/session-input.js";
import { type BrowserToolOptions, createBrowserToolContext, urlNow } from "./browser-context.js";
import { registerBrowserCreateSession } from "./browser-create-session.js";
import { frameUrlAllowed } from "./browser-guards.js";
import { registerBrowserRequestHandoff } from "./browser-handoff.js";
import { registerBrowserNavigate } from "./browser-navigate.js";
import { registerBrowserObserve } from "./browser-observe.js";
import { registerBrowserRead } from "./browser-read.js";
import { withSite } from "./browser-site.js";
import { registerBrowserStructured } from "./browser-structured.js";
import { type SandboxToolOptions, sandboxBase } from "./sandbox-policy.js";
import { registerSandboxRun } from "./sandbox-run.js";

/**
 * Governed sandbox/browser tool surface. Every
 * handler dispatches through `dispatchSandboxedTool`/`dispatchBrowserAction`
 * (`@tavi/contracts`) — the "no unsandboxed fallback" / uncertain-write
 * gates those functions already enforce, never a direct `sandbox.run`/
 * `browser.act` call — matching the exact pattern `features/agents/tools.ts`
 * establishes for `agents.*`.
 *
 * **Sandbox policy is never model-supplied.** `sandbox.run`'s input schema
 * accepts only `command`/`args`/`cwd`. The filesystem policy and the
 * environment are built per call from the folder the owner stamped on the
 * turn (`context.folder`) and the
 * operator's flags; the network and resource policy is fixed at
 * registration. Letting the model choose its own sandbox policy would
 * defeat the point of sandboxing entirely (I-model).
 *
 * **Sandbox×browser pairing is out of scope** — these two tool families are independent; nothing here routes
 * a `browser.*` call's underlying process through `sandbox.run`.
 */

export type { BrowserToolOptions } from "./browser-context.js";
export { blockHint } from "./browser-results.js";
export { holdsDownloads } from "./sandbox-folders.js";
export {
  type SandboxCredentialBinding,
  type SandboxToolOptions,
  DEFAULT_SANDBOX_OUTPUT_BYTES,
  checkedSandboxRead,
  readOwnerGitIdentity,
  sandboxCallFor,
} from "./sandbox-policy.js";

export function registerSandboxTools(registry: ToolRegistry, sandbox: SandboxPort, options: SandboxToolOptions): void {
  registerSandboxRun(registry, sandbox, options, sandboxBase(options));
}

/** What the registered browser tools share with the tools registered beside them (`browser.extract`). */
export interface RegisteredBrowserTools {
  /** The workspace that opened a session in this process; `undefined` for one this process did not open. */
  sessionWorkspace(sessionId: string): string | undefined;
  /** Who opened a session in this process (its workspace and chat), for the check every browser tool makes; `undefined` for one this process did not open. */
  sessionOpener(sessionId: string): SessionOpener | undefined;
  /** The URL of a session's page now, else as last observed. */
  urlNow(sessionId: string): Promise<string | undefined>;
  /**
   * Whether a frame of `frameOrigin` inside the page at `pageUrl` may be read
   * in this session: the page's own host, a host a person allowed for the
   * session, or one the browser may open unasked (the operator's list, an
   * enabled site).
   */
  frameHostAllowed(frameOrigin: string, pageUrl: string, sessionId: string): boolean;
  /**
   * An observation another tool took (`browser.find`), as the browser tools
   * keep theirs: its elements named for the next action's card, its frames
   * on hosts not allowed withheld, its final step tagged. The site's notes
   * are left for the session's own next observation.
   */
  noteObservation(observation: BrowserObservation, workspaceId: string): Promise<BrowserObservation>;
}

export function registerBrowserTools(
  registry: ToolRegistry,
  browser: BrowserPort,
  options: BrowserToolOptions = {},
): RegisteredBrowserTools {
  const ctx = createBrowserToolContext(browser, options);
  registerBrowserCreateSession(registry, ctx);
  registerBrowserNavigate(registry, ctx);
  registerBrowserObserve(registry, ctx);
  registerBrowserRead(registry, ctx);
  registerBrowserStructured(registry, ctx);
  registerBrowserAct(registry, ctx);
  registerBrowserBatch(registry, ctx);
  registerBrowserCapture(registry, ctx);
  registerBrowserClose(registry, ctx);
  registerBrowserRequestHandoff(registry, ctx);
  return {
    sessionWorkspace: (sessionId) => ctx.sessionOpener.get(sessionId)?.workspaceId,
    sessionOpener: (sessionId) => ctx.sessionOpener.get(sessionId),
    urlNow: (sessionId) => urlNow(ctx, sessionId),
    frameHostAllowed: (frameOrigin, pageUrl, sessionId) => frameUrlAllowed(ctx, frameOrigin, pageUrl, sessionId),
    noteObservation: async (observation, workspaceId) => await withSite(ctx, observation, workspaceId, undefined, { siteNotes: false }),
  };
}
