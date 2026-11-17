import type { BrowserPort } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";

import { launchChromium, launchPersistentChromium } from "./chromium.js";
import { createConfinedChromium } from "./confined.js";
import { launchOptionsFor } from "./identity.js";
import { unconfined } from "./launch.js";
import type { PlaywrightBrowserOptions } from "./options.js";
import { portOf } from "./port.js";
import type { BrowserRuntime } from "./session-types.js";

export {
  agentSignatureFromEnv,
  hostIdentity,
  signAgentRequest,
  verifyAgentRequestSignature,
  type AgentSignatureConfig,
  type BrowserDisplay,
  type BrowserIdentity,
} from "./identity.js";
export type { BrowserConfinementOptions, ChromiumSandboxMode } from "./confined.js";
export { chromiumInstalled } from "./confined.js";
export { extractLiteralPdfText, mediaTypeOf, sniffDownloadMediaType } from "./download-media.js";
export type { PlaywrightBrowserOptions } from "./options.js";
export { scrubErrorUrl } from "./page-status.js";
export { newRefRegistry, type ObserveScope, type ScannedElement } from "./scan.js";

/**
 * Real `BrowserPort` adapter over Playwright. How the browser presents itself — display,
 * user agent, locale — is `identity.ts`'s.
 *
 * **A profile per workspace.** With `profileDirectory`, a workspace's sessions
 * are pages of one persistent Chromium profile kept there: a consent choice, a
 * cookie, a login a person made through the live view outlive the session and
 * the owner. Without it — or when the profile cannot be opened, say another
 * process holds it — each session gets a fresh context of one shared browser.
 *
 * **Injectable `launch`, mirroring `packages/builtin/sandbox/src/runtime
 * .ts`'s `manager`/`spawn` seams**: production code types against
 * Playwright's own real `Browser`/`BrowserContext`/`Page`/`Locator`
 * types directly (maximal type safety, no hand-rolled duplicate
 * interface to drift from the real library) — only `launch` itself is
 * substitutable, defaulting to `launchChromium` (Playwright is an optional
 * peer, loaded on first use: `chromium.ts`). Test doubles for
 * `Browser`/`Page`/`Locator` necessarily implement only the subset of
 * methods this adapter actually calls, cast through `as unknown as` at the
 * test's own construction site — never in the adapter.
 *
 * **Test split**: `test/playwright.test.ts` unit-tests session/epoch/
 * dispatch logic against a fake `launch`/`Browser`/`Page`/`Locator`, so
 * it runs anywhere. `test/playwright.real.test.ts` (self-skipping when
 * Chromium can't actually launch — this repo has no CI today, so it
 * exists for whichever host happens to have a cached binary) runs real
 * Chromium: real navigation, real DOM interaction, a real download
 * round-trip (`Download.path()` semantics are otherwise verified only
 * against Playwright's own types), and a real screenshot
 * capture, confirmed against real PNG magic bytes.
 *
 * **Element scanning is a bounded, non-exhaustive scope decision, not a
 * full accessibility tree.** `scanElements` queries a fixed CSS selector
 * (interactive elements and roles), keeps what is rendered and tells the
 * model something (`scanPage`), and drops repeats within the observation's
 * bounds (`compactBrowserElements`, `@tavi/contracts`) — deliberately
 * simpler than a real accessibility-tree walk, and not a claim of complete
 * page coverage: `read` returns the page's text.
 *
 * **`submit`/`download` are documented conventions, not contract-mandated
 * behavior**: `submit` presses Enter on the given ref (works for a
 * focused form field or button; a caller targets whatever element makes
 * sense for the page). `download` clicks the ref and captures whatever
 * download event that triggers, then publishes the result as a `pending`
 * artifact, named in the outcome's `artifactId` (and in `detail`, `"saved as
 * artifact <id>"`), so the turn waits on its review as it does on a capture's.
 */

export function createPlaywrightBrowser(options: PlaywrightBrowserOptions): BrowserPort {
  const confined = options.confinement === undefined ? undefined : createConfinedChromium(options.confinement);
  const display = options.display ?? "headless";
  const ctx: BrowserRuntime = {
    options,
    confined,
    ownSandbox: true,
    launch:
      options.launch ??
      (confined === undefined
        ? (launchOptions) => unconfined(ctx, (chosen) => launchChromium(chosen), launchOptions)
        : (launchOptions) => confined.launch(launchOptions)),
    launchPersistent:
      options.launchPersistent ??
      (confined === undefined
        ? (userDataDir, launchOptions) => unconfined(ctx, (chosen) => launchPersistentChromium(userDataDir, chosen), launchOptions)
        : (userDataDir, launchOptions) => confined.launchPersistent(userDataDir, launchOptions)),
    display,
    baseLaunchOptions: launchOptionsFor(display),
    egressProxy: undefined,
    identity: options.identity ?? {},
    now: options.now ?? nowTimestamp,
    counter: 0,
    sessions: new Map(),
    browserPromise: undefined,
    profiles: new Map(),
    clearing: new Map(),
    claimedPages: new Set(),
    userAgentPromise: undefined,
    disposed: false,
    routedContexts: new WeakSet(),
  };
  return portOf(ctx);
}
