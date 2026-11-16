import type { ArtifactRepositoryPort, BrowserHistoryRepositoryPort, PdfEnginePort } from "@tavi/contracts";
import type { LaunchOptions, Browser, BrowserContextOptions, BrowserContext, Page } from "playwright";

import type { BrowserConfinementOptions } from "./confined.js";
import type { BrowserDisplay, BrowserIdentity } from "./identity.js";
import type { EgressCheck, EgressRefusal } from "./egress-proxy.js";
import type { BrowserLiveSource, LiveTarget } from "./live.js";
import type { ThumbnailPage } from "./thumbnail.js";

export interface PlaywrightBrowserOptions {
  readonly launch?: (options: LaunchOptions) => Promise<Browser>;
  /** Opens a workspace's persistent profile. Defaults to `launchPersistentChromium`. */
  readonly launchPersistent?: (userDataDir: string, options: LaunchOptions & BrowserContextOptions) => Promise<BrowserContext>;
  /** `headless` (the default) or `headed`: see `identity.ts`. */
  readonly display?: BrowserDisplay;
  /** The locale and timezone the browser reports; without them, Chromium's own. */
  readonly identity?: BrowserIdentity;
  /** Where a workspace's persistent profile lives; without it, every session starts from a fresh context. */
  readonly profileDirectory?: (workspaceId: string) => string;
  /** Something the browser fell back from (a profile it could not open); ignored when absent. */
  readonly onWarning?: (message: string) => void;
  /**
   * Chromium confined (`confined.ts`): each launch under the
   * owner's `ConfinementPort` and limits, with the strongest Chromium sandbox
   * that works inside it. Absent, Chromium runs as the owner, with its own
   * sandbox on macOS (`identity.ts`).
   */
  readonly confinement?: BrowserConfinementOptions;
  /** Where an upload is staged on its way to the page: the owner's private staging directory, which every sandbox denies. */
  readonly stagingDirectory: string;
  readonly artifacts?: ArtifactRepositoryPort;
  readonly now?: () => string;
  /**
   * Browser history. With it, a session
   * opened for a task gets a durable row (a fresh UUID; the model keeps seeing
   * this adapter's own session id), every navigate/observe — and a click or
   * submit that leaves the page — records the page, and may take a thumbnail
   * (with `artifacts`) after the call has answered. History is a side
   * record: a failure to write it never fails the browser call.
   */
  readonly history?: BrowserHistoryRepositoryPort;
  /** The workspace's no-thumbnail hosts; `DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS` when absent. */
  readonly noThumbnailHosts?: (workspaceId: string) => Promise<readonly string[]>;
  /** Where a history or thumbnail failure is reported; ignored when absent. */
  readonly onHistoryError?: (error: unknown) => void;
  /** @internal Tests: the durable session id. */
  readonly newHistoryId?: () => string;
  /** @internal Tests: the page the thumbnail rules read. Defaults to `playwrightThumbnailPage`. */
  readonly thumbnailPage?: (page: Page) => ThumbnailPage;
  /**
   * The live view's producer. With it,
   * every session that has a history row is offered to watchers, by that
   * row's id; its navigations, actions and thumbnail are reported to it.
   */
  readonly live?: BrowserLiveSource;
  /** @internal Tests: the page the live view streams. Defaults to `playwrightLiveTarget`. */
  readonly liveTarget?: (page: Page) => LiveTarget;
  /**
   * The egress proxy's check (`egress-proxy.ts`): every connection Chromium
   * makes goes through a proxy of this adapter's own, which connects only to
   * the address this names for a host. Absent: Chromium connects directly.
   */
  readonly egress?: EgressCheck;
  /** A connection the egress proxy refused; ignored when absent. */
  readonly onEgressRefused?: (refusal: EgressRefusal) => void;
  /** Maximum download size in MiB before the browser cancels and refuses it, or the workspace's; defaults to 256. */
  readonly downloadMaxMiB?: number | ((workspaceId: string) => number | Promise<number>);
  /** Minutes an inactive session stays open after `taskEnded` before being reaped, or the workspace's; defaults to 30 (0 disables). */
  readonly sessionIdleMinutes?: number | ((workspaceId: string) => number | Promise<number>);
  /**
   * Whether a child frame whose content is `frameOrigin`'s (on another host
   * than `pageUrl`'s) may have its elements and text read in this session; a
   * frame inside a refused one is refused with it. Absent: every frame may.
   */
  readonly isFrameHostAllowed?: (
    frameOrigin: string,
    pageUrl: string,
    workspaceId: string,
    sessionId: string,
  ) => boolean | Promise<boolean>;
  /**
   * Optional PDF engine (`PdfEnginePort` or lazy getter) used to extract text
   * when a navigation lands on a PDF document.
   */
  readonly pdf?:
    | (Pick<PdfEnginePort, "run"> & Partial<Pick<PdfEnginePort, "readWithOcr">>)
    | (() => (Pick<PdfEnginePort, "run"> & Partial<Pick<PdfEnginePort, "readWithOcr">>) | undefined);
}
