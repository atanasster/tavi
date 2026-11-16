import {
  ArtifactReadAnswerSchema,
  BROWSER_IPC_LIST_MAX,
  BROWSER_IPC_VISITS_MAX,
  BrowserClearProfileAnswerSchema,
  BrowserCloseAnswerSchema,
  BrowserRecipesAnswerSchema,
  BrowserListAnswerSchema,
  BrowserSiteNoteProposedAnswerSchema,
  type BrowserClearProfileAnswer,
  type BrowserSiteNoteProposedAnswer,
  type BrowserRecipesAnswer,
  type BrowserCloseAnswer,
  BrowserVisitsAnswerSchema,
  type BrowserListAnswer,
  type BrowserVisitsAnswer,
} from "@tavi/contracts";

import { readChunks } from "../../lib/chunks.js";
import { read, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/** Closed sessions per page of Earlier. */
const BROWSER_PAGE_SIZE = 20;

/**
 * One page of the workspace's browser sessions, newest first: the newest
 * live ones (`open: true`, as many as one request lists — the summary counts
 * the rest), or the closed ones, paged.
 */
export function listBrowserSessions(
  client: SettingsClient,
  workspaceId: string,
  options: { readonly open: boolean; readonly cursor?: string | undefined; readonly taskId?: string | undefined },
): Promise<Outcome<BrowserListAnswer>> {
  return read(
    client,
    "browser",
    {
      action: "list",
      workspaceId,
      open: options.open,
      limit: options.open ? BROWSER_IPC_LIST_MAX : BROWSER_PAGE_SIZE,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    },
    BrowserListAnswerSchema,
  );
}

/**
 * Close a browser session the agent left open after its task ended:
 * the owner frees the browser it holds and records it as closed by the
 * operator.
 */
export function closeBrowserSession(client: SettingsClient, workspaceId: string, sessionId: string): Promise<Outcome<BrowserCloseAnswer>> {
  return read(client, "browser", { action: "close", workspaceId, sessionId }, BrowserCloseAnswerSchema);
}

/**
 * Forget the workspace's browser profile — the cookies, consent choices and
 * sign-ins the agent's browser keeps — closing its open sessions first.
 */
export function clearBrowserProfile(client: SettingsClient, workspaceId: string): Promise<Outcome<BrowserClearProfileAnswer>> {
  return read(client, "browser", { action: "clear-profile", workspaceId }, BrowserClearProfileAnswerSchema);
}

/** The workspace's site recipes; with `forget`, one site's (a host) or every one forgotten first. */
export function browserRecipes(
  client: SettingsClient,
  workspaceId: string,
  forget?: string | true,
): Promise<Outcome<BrowserRecipesAnswer>> {
  return read(
    client,
    "browser",
    { action: "recipes", workspaceId, ...(forget === undefined ? {} : { forget }) },
    BrowserRecipesAnswerSchema,
  );
}

/**
 * A site's recipe saved as a proposed site note in the data directory's
 * `site-notes/` (`tavi browser site-notes --propose <host>`): off until the
 * operator reviews it and turns it on.
 */
export function proposeSiteNote(
  client: SettingsClient,
  workspaceId: string,
  host: string,
): Promise<Outcome<BrowserSiteNoteProposedAnswer>> {
  return read(client, "browser", { action: "propose-site-note", workspaceId, host }, BrowserSiteNoteProposedAnswerSchema);
}

/** A session's visits, in order: one page of the most the owner sends. */
export function loadBrowserVisits(
  client: SettingsClient,
  workspaceId: string,
  sessionId: string,
  cursor?: string,
): Promise<Outcome<BrowserVisitsAnswer>> {
  return read(
    client,
    "browser",
    { action: "visits", workspaceId, sessionId, limit: BROWSER_IPC_VISITS_MAX, ...(cursor === undefined ? {} : { cursor }) },
    BrowserVisitsAnswerSchema,
  );
}

/** The most chunks one thumbnail is read in: far above a 320-pixel JPEG's one. */
const THUMBNAIL_MAX_CHUNKS = 16;

/**
 * A thumbnail's bytes as a `data:` URL (the canvas allows `img-src data:`),
 * read chunk by chunk with `artifacts read`, which serves thumbnails only. A
 * body that changes between chunks, or is not an image, is a failure.
 */
export async function readThumbnail(client: SettingsClient, workspaceId: string, artifactId: string): Promise<Outcome<string>> {
  const parts: string[] = [];
  const last = await readChunks(
    (offset) => read(client, "artifacts", { action: "read", workspaceId, artifactId, offset }, ArtifactReadAnswerSchema),
    (chunk) => {
      parts.push(chunk.base64);
      return undefined;
    },
    { changed: "The thumbnail changed while it was read", tooLarge: "The thumbnail is too large to show", maxChunks: THUMBNAIL_MAX_CHUNKS },
  );
  if (!last.ok) return last;
  const contentType = last.value.contentType;
  if (!/^image\/(jpeg|png|webp)$/.test(contentType)) return { ok: false, message: "The thumbnail is not an image" };
  // Chunks are cut at byte offsets, so each one's base64 is decoded and joined as bytes.
  const bytes = parts.length === 1 ? undefined : parts.map((part) => atob(part)).join("");
  return { ok: true, value: `data:${contentType};base64,${bytes === undefined ? parts[0] : btoa(bytes)}` };
}
