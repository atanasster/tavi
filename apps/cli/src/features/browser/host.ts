import type { BrowserLiveSource, BrowserPort, RenderPort } from "@tavi/contracts";
import { createBrowserLiveSource, type BrowserLiveSourceOptions } from "@tavi/plugin-browser/live";
import {
  agentSignatureFromEnv,
  createPlaywrightBrowser,
  hostIdentity,
  signAgentRequest,
  type BrowserIdentity,
  type PlaywrightBrowserOptions,
} from "@tavi/plugin-browser/playwright";
import { createPlaywrightRenderer } from "@tavi/plugin-browser/render";

/**
 * Where the owner puts the built-in browser together: the engine
 * (`BrowserPort`), the live view's producer (`BrowserLiveSource`) and the
 * page renderer (`RenderPort`). This module alone names
 * `@tavi/plugin-browser`; every other owner file sees the ports, and
 * composition takes an override for each, as `features/sandbox/host.ts`
 * does for the sandbox modules.
 */

/**
 * The operator's opt-in agent signature (`TAVI_AGENT_SIGNATURE_*`) as a signer for an outgoing URL, the
 * browser's own for its documents: `undefined` when no key is configured.
 */
export function ownerRequestSigner(): ((url: URL) => Readonly<Record<string, string>>) | undefined {
  const signature = agentSignatureFromEnv();
  return signature === undefined ? undefined : (url) => signAgentRequest(url, signature);
}

/** The built-in browser engine: Playwright's Chromium, confined where the options say. */
export function createOwnerBrowser(options: PlaywrightBrowserOptions): BrowserPort {
  return createPlaywrightBrowser(options);
}

/** The live view's producer the built-in engine reports its sessions to. */
export function createOwnerLiveSource(options: BrowserLiveSourceOptions = {}): BrowserLiveSource {
  return createBrowserLiveSource(options);
}

/** The renderer reports and routines print their pages with. */
export function createOwnerRenderer(): RenderPort {
  return createPlaywrightRenderer();
}

/** The operator's locale and timezone, which the browser reports as its own. */
export function ownerBrowserIdentity(): BrowserIdentity {
  return hostIdentity();
}
