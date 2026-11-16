import type { AsyncRepository } from "./persistence-types.js";

/**
 * Browser history: which
 * sites the agent is on or was on, per task.
 *
 * What is stored, and what is not:
 *
 *  - one row per browser session (its task, when it opened and closed, the
 *    last page's scrubbed URL and title, how many pages it saw) and one row
 *    per page visit;
 *  - URLs keep the scheme, host, port and path only (`scrubBrowserUrl`): the
 *    query string, fragment and userinfo carry session tokens, one-time links
 *    and search terms, so they are never written here. The full URL stays only
 *    in the task's own transcript;
 *  - a small JPEG thumbnail of the last page, never of a page with a password
 *    field or on a host in `browserNoThumbnailHosts`. Thumbnails are internal
 *    artifacts (`purpose: "thumbnail"`) the model never sees.
 *
 * Everything is kept `BROWSER_HISTORY_RETENTION_DAYS` days, by a step of the
 * owner's retention sweep that always runs.
 */

/** How long sessions, their visits and thumbnails are kept. */
export const BROWSER_HISTORY_RETENTION_DAYS = 30;
/** The longest stored URL and title. */
export const BROWSER_URL_MAX = 2048;
export const BROWSER_TITLE_MAX = 300;
/** Thumbnails: width in pixels, JPEG quality, and at most one per session this often. */
export const BROWSER_THUMBNAIL_WIDTH = 320;
export const BROWSER_THUMBNAIL_QUALITY = 60;
export const BROWSER_THUMBNAIL_INTERVAL_MS = 10_000;
/** Why a session closed without a `close` call: the process that held it stopped. */
export const BROWSER_CLOSE_REASON_RESTART = "owner restarted";
export const BROWSER_CLOSE_REASON_CLOSED = "closed";
/** The reason recorded for a session reaped after its chat left it unused for `browser.sessionIdleMinutes`. */
export const BROWSER_CLOSE_REASON_IDLE = "idle";
/** The reason an operator's **Close browser** (or `tavi browser close`) records. */
export const BROWSER_CLOSE_REASON_OPERATOR = "closed by operator";
/** The reason recorded for a session closed because the operator cleared its workspace's browser profile. */
export const BROWSER_CLOSE_REASON_PROFILE_CLEARED = "browser profile cleared";

/**
 * Hosts whose pages never get a thumbnail unless the workspace sets its own
 * list (`tavi config set browser.noThumbnailHosts`). Short on purpose: common
 * webmail and payment hosts, and the `.bank` top-level domain. A page with a
 * password field gets none wherever it is, so login pages are covered anyway.
 * `*.example.com` matches `example.com` and every subdomain of it.
 */
export const DEFAULT_BROWSER_NO_THUMBNAIL_HOSTS: readonly string[] = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "mail.yahoo.com",
  "mail.proton.me",
  "*.paypal.com",
  "*.bank",
];
/** The most hosts a workspace may list. */
export const BROWSER_NO_THUMBNAIL_HOSTS_MAX = 200;

// Contracts compile without the DOM or Node libraries; `URL` is a global in
// every runtime this package runs in (Node, browsers), so only its type is
// declared here.
declare const URL: new (
  input: string,
) => {
  readonly protocol: string;
  readonly hostname: string;
  readonly host: string;
  readonly pathname: string;
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * The part of `raw` that is stored: scheme, host, port and path. The query
 * string, fragment and userinfo are dropped; a host is in its ASCII (punycode)
 * form. A non-web URL keeps only its scheme (a `data:` URL's "path" is its
 * content), except `about:` pages, which keep their name. `undefined` when
 * `raw` is not a URL at all.
 */
export function scrubBrowserUrl(raw: string): string | undefined {
  let parsed: InstanceType<typeof URL>;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  let scrubbed: string;
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    // `host` is hostname plus a non-default port; userinfo is never part of it.
    scrubbed = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } else if (parsed.protocol === "about:") {
    scrubbed = `about:${parsed.pathname}`;
  } else {
    scrubbed = parsed.protocol;
  }
  return scrubbed.replace(CONTROL_CHARACTERS, "").slice(0, BROWSER_URL_MAX);
}

/** A page title as stored: control characters removed, trimmed, clipped; `undefined` when nothing is left. */
export function clipBrowserTitle(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clipped = raw.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, BROWSER_TITLE_MAX).trim();
  return clipped === "" ? undefined : clipped;
}

/** A host as compared: lower case, ASCII (punycode), no trailing dot; `undefined` when it is not a host. */
function normalizeHost(host: string): string | undefined {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed === "" || trimmed.length > 253 || /[/?#@\s:]/.test(trimmed)) return undefined;
  try {
    const hostname = new URL(`http://${trimmed}/`).hostname;
    return hostname === "" ? undefined : hostname;
  } catch {
    return undefined;
  }
}

/**
 * One no-thumbnail entry in its stored form, or `undefined` when it is not a
 * host or a `*.` suffix pattern.
 */
export function normalizeNoThumbnailHost(entry: string): string | undefined {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed.startsWith("*.")) {
    const suffix = normalizeHost(trimmed.slice(2));
    return suffix === undefined ? undefined : `*.${suffix}`;
  }
  return normalizeHost(trimmed);
}

/**
 * Whether the page at `url` may not get a thumbnail by host: an exact entry
 * matches that host, and `*.example.com` matches `example.com` and all its
 * subdomains. A URL without a host (`about:blank`) matches nothing.
 */
export function hostBlocksThumbnail(url: string, patterns: readonly string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const host = normalizeHost(hostname);
  if (host === undefined) return false;
  return patterns.some((pattern) => {
    const normalized = normalizeNoThumbnailHost(pattern);
    if (normalized === undefined) return false;
    if (!normalized.startsWith("*.")) return host === normalized;
    const suffix = normalized.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}

/** One browser session as stored. `thumbnailArtifactId` names an internal artifact (`purpose: "thumbnail"`). */
export interface BrowserSessionRecord {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
  readonly lastUrl: string | null;
  readonly lastTitle: string | null;
  readonly thumbnailArtifactId: string | null;
  readonly pages: number;
  /** The `browser.create_session` call that opened it; `null` for a session recorded before calls were (or opened outside a model turn). */
  readonly openedByCallId: string | null;
  /** Since when its task has been over and the session kept, open, for the chat's next turn; `null` while in use, and for a closed one. */
  readonly inactiveSince: string | null;
}

/**
 * A session as the Command Center lists it: the stored row, plus its task's
 * title and person. `thumbnailArtifactId` is set only while the thumbnail
 * artifact still exists.
 */
export interface BrowserSessionListing extends BrowserSessionRecord {
  /** The task's generated title, else the first line of its prompt; `null` when neither is known. */
  readonly taskTitle: string | null;
  readonly principalId: string;
}

export interface BrowserVisitRecord {
  readonly sessionId: string;
  readonly seq: number;
  readonly url: string;
  readonly title: string | null;
  readonly at: string;
}

/**
 * Storage for browser history.
 *
 * Every URL a caller passes is scrubbed here (`scrubBrowserUrl`) and every
 * title clipped, so no write path can store a query string. A write for a
 * session with no row (the process that opened it had no task, or the row was
 * swept) is a no-op.
 */
interface BrowserHistoryRepositoryPortDefinition {
  /** Records a newly opened session. `sessionId` is a fresh UUID, not the adapter's in-process id. */
  open(input: {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly taskId: string;
    readonly openedAt: string;
    readonly openedByCallId?: string | undefined;
  }): void;
  /**
   * The session is on `url` now: updates its last URL and title and appends a
   * visit, unless the scrubbed URL equals the last visit's (a re-observe of the
   * same page updates the title only). `pages` counts visits.
   */
  recordPage(input: { readonly sessionId: string; readonly url: string; readonly title?: string | undefined; readonly at: string }): void;
  /**
   * Point the session at a new thumbnail artifact, or at none (`null`), and
   * delete the one it replaces (row and file). Returns the replaced id.
   */
  setThumbnail(input: { readonly sessionId: string; readonly artifactId: string | null }): string | null;
  close(input: { readonly sessionId: string; readonly closedAt: string; readonly reason: string }): void;
  /** Mark an open session inactive since `since` (its task ended), or in use again (`null`). A closed or unknown session is left alone. */
  setInactive(input: { readonly sessionId: string; readonly since: string | null }): void;
  /** How many sessions are open now, owner-wide: in use, and inactive (kept for a chat's next turn). */
  counts(): { readonly open: number; readonly inactive: number };
  /** Close every session still open that opened before `openedBefore` (restart cleanup). Returns how many. */
  closeOpen(input: { readonly openedBefore: string; readonly closedAt: string; readonly reason: string }): number;
  /** Delete sessions opened before `olderThan`, their visits and their thumbnails (rows and files). */
  sweep(input: { readonly olderThan: string }): { readonly sessions: number; readonly thumbnails: number };
  /**
   * One page of a workspace's sessions, newest first (`opened_at`, then
   * `session_id`, both descending): only open ones with `open: true`, only
   * closed ones with `open: false`; only one task's with `taskId`, or any of
   * `taskIds`' (a task tree). `before` is the last row of the previous page.
   */
  sessions(input: {
    readonly workspaceId: string;
    readonly open?: boolean | undefined;
    readonly taskId?: string | undefined;
    readonly taskIds?: readonly string[] | undefined;
    /** With `open: true`: only inactive ones (`true`), or only those in use (`false`). */
    readonly inactive?: boolean | undefined;
    readonly before?: { readonly openedAt: string; readonly sessionId: string } | undefined;
    readonly limit: number;
  }): readonly BrowserSessionListing[];
  /**
   * One page of a session's visits in order, after `afterSeq`; `undefined`
   * when the session is not in `workspaceId` (or does not exist).
   */
  visitPage(input: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly afterSeq?: number | undefined;
    readonly limit: number;
  }): readonly BrowserVisitRecord[] | undefined;
}

export type BrowserHistoryRepositoryPort = AsyncRepository<BrowserHistoryRepositoryPortDefinition>;
