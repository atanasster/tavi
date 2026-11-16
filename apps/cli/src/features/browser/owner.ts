import {
  ARTIFACT_READ_CHUNK_BYTES,
  BROWSER_IPC_LIST_DEFAULT,
  BROWSER_IPC_VISITS_DEFAULT,
  BROWSER_CLOSE_REASON_OPERATOR,
  BrowserClearProfileAnswerSchema,
  BrowserCloseAnswerSchema,
  BrowserRecipesAnswerSchema,
  BrowserListAnswerSchema,
  BrowserSiteNoteProposedAnswerSchema,
  type BrowserClearProfileAnswer,
  type BrowserRecipesAnswer,
  type BrowserSiteNoteProposedAnswer,
  type BrowserCloseAnswer,
  BrowserVisitsAnswerSchema,
  DEFAULT_WORKSPACE_ID,
  TaviError,
  scrubBrowserUrl,
  type ArtifactReadAnswer,
  type ArtifactsReadPayload,
  type BrowserListAnswer,
  type BrowserPayload,
  type BrowserSessionListing,
  type BrowserSessionView,
  type BrowserVisitsAnswer,
  type PersistencePort,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import { z } from "zod";

import type { IpcAnswer } from "../../shared/ipc-decisions.js";
import { proposeRecipeNote, recipeHost } from "./site-notes.js";

/**
 * `browser` and `artifacts read`: the Command
 * Center's Browser section. Reads, and the operator's `close`, which
 * a page may also send through the bridge: closing a session the operator
 * sees is theirs to do from any front end.
 *
 * Only scrubbed URLs leave here. The repository scrubs every URL it writes;
 * each one read is scrubbed again on the way out, so a row written by some
 * other path (an import, a hand edit) still never shows a query string.
 */
export interface BrowserDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "browserHistory" | "artifacts" | "siteRecipes">;
  /** The operator principal a workspace is served for, or undefined for one this owner does not serve. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly now: () => Date;
  /** The task and every task under it (`browser list` with `tree`); without it, a tree is the task alone. */
  readonly taskTree?: (workspaceId: string, taskId: string) => Promise<readonly string[]>;
  /** Close a session the browser adapter holds, by its recorded id; false when it holds no such open session. Absent offline. */
  readonly closeSession?: (sessionId: string, reason: string) => Promise<boolean>;
  /** Forget a workspace's browser profile, closing its open sessions; how many it closed. Offline, the profile's directory is removed. */
  readonly clearProfile?: (workspaceId: string) => Promise<{ readonly closed: number }>;
  /** The data directory's `site-notes/`, where `propose-site-note` writes; absent, it is refused. */
  readonly siteNotesDirectory?: string;
}

const ListCursorSchema = z.strictObject({
  v: z.literal(1),
  at: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  open: z.boolean().nullable(),
  task: z.string().min(1).max(128).optional(),
  tree: z.literal(true).optional(),
});
const VisitsCursorSchema = z.strictObject({ v: z.literal(1), session: z.string().min(1).max(128), seq: z.number().int().nonnegative() });

/** The repository's largest page of sessions; `close` reads as many as there are. */
const CLOSE_PAGE = 200;

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
function decode<T>(schema: z.ZodType<T>, cursor: string): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new TaviError("INVALID_INPUT", "Invalid browser cursor; restart the list");
  }
}

/** A workspace this owner serves, or `NOT_FOUND` — never an empty, plausible-looking answer for one it does not. */
function servedWorkspace(deps: Pick<BrowserDependencies, "principalOf">, workspaceId: string | undefined): string {
  const id = workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (deps.principalOf(id) === undefined)
    throw new TaviError("NOT_FOUND", `workspace ${id} is not configured on this owner`, { details: { workspaceId: id } });
  return id;
}

/** The host a scrubbed URL names, or `null` for one without (`about:blank`, `data:`). */
function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "" ? parsed.host : null;
  } catch {
    return null;
  }
}

function toView(row: BrowserSessionListing, now: number): BrowserSessionView {
  const lastUrl = row.lastUrl === null ? null : (scrubBrowserUrl(row.lastUrl) ?? null);
  // An inactive session's time ended with its task.
  const end = row.closedAt !== null ? Date.parse(row.closedAt) : row.inactiveSince !== null ? Date.parse(row.inactiveSince) : now;
  return {
    sessionId: row.sessionId,
    taskId: row.taskId,
    ...(row.taskTitle === null ? {} : { taskTitle: row.taskTitle.slice(0, 256) }),
    principalId: row.principalId,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    closeReason: row.closeReason,
    live: row.closedAt === null && row.inactiveSince === null,
    ...(row.closedAt === null && row.inactiveSince !== null ? { inactive: true as const } : {}),
    lastUrl,
    host: hostOf(lastUrl),
    lastTitle: row.lastTitle,
    pages: row.pages,
    durationMs: Math.max(0, end - Date.parse(row.openedAt)),
    ...(row.thumbnailArtifactId === null ? {} : { thumbnail: { artifactId: row.thumbnailArtifactId } }),
    ...(row.openedByCallId === null ? {} : { openedByCallId: row.openedByCallId.slice(0, 256) }),
  };
}

export async function browserCommand(
  deps: BrowserDependencies,
  payload: BrowserPayload,
): Promise<
  IpcAnswer<
    | BrowserListAnswer
    | BrowserVisitsAnswer
    | BrowserCloseAnswer
    | BrowserClearProfileAnswer
    | BrowserRecipesAnswer
    | BrowserSiteNoteProposedAnswer
  >
> {
  try {
    const workspaceId = servedWorkspace(deps, payload.workspaceId);
    const history = deps.repositories.browserHistory;
    if (payload.action === "propose-site-note") {
      // The CLI's `--propose`, from the canvas: the same note, written the same way, off.
      if (deps.siteNotesDirectory === undefined)
        throw new TaviError("UNAVAILABLE", "site notes are written by a running owner, or with tavi browser site-notes --propose");
      const { note, file } = await proposeRecipeNote(
        deps.siteNotesDirectory,
        await deps.repositories.siteRecipes.list(workspaceId),
        payload.host,
      );
      return {
        ok: true,
        result: BrowserSiteNoteProposedAnswerSchema.parse({
          proposed: { id: note.id, name: note.name, hosts: note.hosts, file, on: false },
        }),
      };
    }
    if (payload.action === "recipes") {
      const host = typeof payload.forget === "string" ? recipeHost(payload.forget) : undefined;
      const replayChanged =
        payload.replay === undefined
          ? undefined
          : await deps.repositories.siteRecipes.setReplay(workspaceId, recipeHost(payload.replay.host), payload.replay.on);
      const forgotten = payload.forget === undefined ? undefined : await deps.repositories.siteRecipes.remove(workspaceId, host);
      const recipes = await deps.repositories.siteRecipes.list(workspaceId);
      return {
        ok: true,
        result: BrowserRecipesAnswerSchema.parse({
          recipes: recipes.map(({ host, steps, results, uses, updatedAt, replay }) => ({
            host,
            steps: steps.map((step) => ({
              kind: step.kind,
              ...(step.role === undefined ? {} : { role: step.role }),
              ...(step.label === undefined ? {} : { label: step.label.slice(0, 240) }),
              ...(step.value === undefined ? {} : { value: step.value }),
            })),
            results,
            uses,
            updatedAt,
            ...(replay === true ? { replay: true as const } : {}),
          })),
          ...(forgotten === undefined ? {} : { forgotten }),
          ...(replayChanged === undefined ? {} : { replayChanged }),
        }),
      };
    }
    if (payload.action === "clear-profile") {
      if (deps.clearProfile === undefined) throw new TaviError("UNAVAILABLE", "this owner keeps no browser profile to clear");
      return { ok: true, result: BrowserClearProfileAnswerSchema.parse(await deps.clearProfile(workspaceId)) };
    }
    if (payload.action === "close") {
      if ((payload.sessionId === undefined) === (payload.inactive === undefined)) {
        throw new TaviError("INVALID_INPUT", "browser close needs one session id, or inactive: every session whose task has ended");
      }
      // Every open session, page by page: one past the first page is still closable, and --inactive closes them all.
      const open: string[] = [];
      for (let before: { openedAt: string; sessionId: string } | undefined; ; ) {
        const page = await history.sessions({
          workspaceId,
          open: true,
          ...(payload.inactive === true ? { inactive: true } : {}),
          ...(before === undefined ? {} : { before }),
          limit: CLOSE_PAGE,
        });
        open.push(...page.map((row) => row.sessionId));
        const last = page.at(-1);
        if (page.length < CLOSE_PAGE || last === undefined || (payload.sessionId !== undefined && open.includes(payload.sessionId))) break;
        before = { openedAt: last.openedAt, sessionId: last.sessionId };
      }
      const targets = payload.sessionId === undefined ? open : open.filter((sessionId) => sessionId === payload.sessionId);
      if (payload.sessionId !== undefined && targets.length === 0)
        throw new TaviError("NOT_FOUND", `no open browser session ${payload.sessionId} in workspace ${workspaceId}`);
      for (const sessionId of targets) {
        // Closed in the adapter, which records it; a row the adapter does not hold is closed in the record alone.
        const closed = (await deps.closeSession?.(sessionId, BROWSER_CLOSE_REASON_OPERATOR)) ?? false;
        if (!closed) await history.close({ sessionId, closedAt: deps.now().toISOString(), reason: BROWSER_CLOSE_REASON_OPERATOR });
      }
      return { ok: true, result: BrowserCloseAnswerSchema.parse({ closed: targets }) };
    }
    if (payload.action === "list") {
      const limit = payload.limit ?? BROWSER_IPC_LIST_DEFAULT;
      const open = payload.open ?? null;
      const cursor = payload.cursor === undefined ? undefined : decode(ListCursorSchema, payload.cursor);
      // A cursor from a list of other sessions (open vs closed, another task's) would skip or repeat rows.
      const tree = payload.tree === true;
      if (tree && payload.taskId === undefined)
        throw new TaviError("INVALID_INPUT", "browser list --tree needs the task whose tree it lists");
      if (cursor !== undefined && (cursor.open !== open || cursor.task !== payload.taskId || (cursor.tree === true) !== tree))
        throw new TaviError("INVALID_INPUT", "Invalid browser cursor; restart the list");
      const taskIds =
        tree && payload.taskId !== undefined
          ? deps.taskTree === undefined
            ? [payload.taskId]
            : await deps.taskTree(workspaceId, payload.taskId)
          : undefined;
      const rows = await history.sessions({
        workspaceId,
        ...(payload.open === undefined ? {} : { open: payload.open }),
        ...(taskIds !== undefined ? { taskIds } : payload.taskId === undefined ? {} : { taskId: payload.taskId }),
        ...(cursor === undefined ? {} : { before: { openedAt: cursor.at, sessionId: cursor.id } }),
        limit: limit + 1,
      });
      const shown = rows.slice(0, limit);
      const last = shown.at(-1);
      const now = deps.now().getTime();
      return {
        ok: true,
        result: BrowserListAnswerSchema.parse({
          items: shown.map((row) => toView(row, now)),
          ...(rows.length > limit && last !== undefined
            ? {
                nextCursor: encode({
                  v: 1,
                  at: last.openedAt,
                  id: last.sessionId,
                  open,
                  ...(payload.taskId === undefined ? {} : { task: payload.taskId }),
                  ...(tree ? { tree: true } : {}),
                }),
              }
            : {}),
        }),
      };
    }
    const limit = payload.limit ?? BROWSER_IPC_VISITS_DEFAULT;
    const cursor = payload.cursor === undefined ? undefined : decode(VisitsCursorSchema, payload.cursor);
    if (cursor !== undefined && cursor.session !== payload.sessionId)
      throw new TaviError("INVALID_INPUT", "Invalid browser cursor; restart the list");
    const rows = await history.visitPage({
      workspaceId,
      sessionId: payload.sessionId,
      ...(cursor === undefined ? {} : { afterSeq: cursor.seq }),
      limit: limit + 1,
    });
    if (rows === undefined) throw new TaviError("NOT_FOUND", `browser session ${payload.sessionId} is not in workspace ${workspaceId}`);
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return {
      ok: true,
      result: BrowserVisitsAnswerSchema.parse({
        sessionId: payload.sessionId,
        items: shown.flatMap((row) => {
          const url = scrubBrowserUrl(row.url);
          return url === undefined ? [] : [{ seq: row.seq, url, title: row.title, at: row.at }];
        }),
        ...(rows.length > limit && last !== undefined ? { nextCursor: encode({ v: 1, session: payload.sessionId, seq: last.seq }) } : {}),
      }),
    };
  } catch (error) {
    const failure = TaviError.from(error);
    return { ok: false, error: { code: failure.code, message: failure.message } };
  }
}

/**
 * `artifacts read`: one chunk of a browser thumbnail's bytes, or of a PDF
 * page preview a fill or render stored. Every other artifact —
 * an ordinary one, another workspace's, one that is gone — is the same
 * `NOT_FOUND`, so the answer never tells a page that an id exists.
 */
export async function artifactsReadCommand(
  deps: BrowserDependencies,
  payload: ArtifactsReadPayload,
): Promise<IpcAnswer<ArtifactReadAnswer>> {
  try {
    const workspaceId = servedWorkspace(deps, payload.workspaceId);
    const missing = (): TaviError =>
      new TaviError("NOT_FOUND", `artifact ${payload.artifactId} is not a thumbnail or page preview in workspace ${workspaceId}`);
    const artifacts = deps.repositories.artifacts;
    const record = await artifacts.getArtifact(payload.artifactId);
    // A preview is an image: a whole PDF `pdf.view` stored with the same tag (to go with the chat) is not one.
    if (
      record === undefined ||
      (record.purpose !== "thumbnail" && (record.preview === undefined || !record.contentType.startsWith("image/"))) ||
      record.workspaceId !== workspaceId
    )
      throw missing();
    const bytes = await artifacts.readArtifactBody(record.artifactId);
    if (bytes === undefined) throw missing();
    const hash = sha256Hex(bytes);
    if (hash !== record.sha256) throw new TaviError("UNAVAILABLE", "The image's bytes are missing or damaged");
    const offset = payload.offset ?? 0;
    if (offset > bytes.length) throw new TaviError("INVALID_INPUT", "Invalid artifact offset");
    const chunk = bytes.subarray(offset, offset + ARTIFACT_READ_CHUNK_BYTES);
    const end = offset + chunk.length;
    return {
      ok: true,
      result: {
        artifactId: record.artifactId,
        contentType: record.contentType,
        hash,
        totalBytes: bytes.length,
        offset,
        base64: Buffer.from(chunk).toString("base64"),
        nextOffset: end < bytes.length ? end : null,
      },
    };
  } catch (error) {
    const failure = TaviError.from(error);
    return { ok: false, error: { code: failure.code, message: failure.message } };
  }
}
