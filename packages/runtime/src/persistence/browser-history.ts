import { rmSync } from "node:fs";

import {
  clipBrowserTitle,
  scrubBrowserUrl,
  type BrowserSessionListing,
  type BrowserSessionRecord,
  type BrowserVisitRecord,
} from "@tavi/contracts";

import { TASK_PROMPT_SQL, displayTitleOf } from "./task-list.js";
import type { BrowserHistoryRepositoryPort } from "./internal-contracts.js";
import type { Database } from "./sqlite-loader.js";
import { assertPositiveLimit } from "./values.js";

/**
 * Browser history.
 *
 * A session row per browser session a task opened and a visit row per page it
 * was on. Deleting a task deletes both (cascade). Only scrubbed URLs are ever
 * written: this repository scrubs whatever it is given, so no caller can store
 * a query string by accident.
 *
 * A session's thumbnail is an internal artifact (it has a `purpose`), which the
 * model-facing paths skip; the artifact `review` counter triggers fire only for
 * artifacts without one, so a thumbnail written every few seconds does not wake
 * the approvals page (thumbnails wake `browser`, through their session row).
 */

/** What the repository needs of the store: its handle, a transaction, and the artifact path resolver. */
export interface BrowserHistoryStore {
  readonly handle: Database;
  transaction<T>(fn: () => T): T;
  resolveArtifactPath(relativePath: string): string;
}

interface SessionRow {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly close_reason: string | null;
  readonly last_url: string | null;
  readonly last_title: string | null;
  readonly thumbnail_artifact_id: string | null;
  readonly pages: number;
  readonly opened_by_call_id: string | null;
  readonly inactive_since: string | null;
}

const toSession = (row: SessionRow): BrowserSessionRecord => ({
  sessionId: row.session_id,
  workspaceId: row.workspace_id,
  taskId: row.task_id,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  closeReason: row.close_reason,
  lastUrl: row.last_url,
  lastTitle: row.last_title,
  thumbnailArtifactId: row.thumbnail_artifact_id,
  pages: row.pages,
  openedByCallId: row.opened_by_call_id,
  inactiveSince: row.inactive_since,
});

/** The most rows one `sessions` or `visitPage` returns. */
const PAGE_MAX = 200;

interface VisitRow {
  readonly session_id: string;
  readonly seq: number;
  readonly url: string;
  readonly title: string | null;
  readonly at: string;
}

const toVisit = (row: VisitRow): BrowserVisitRecord => ({
  sessionId: row.session_id,
  seq: row.seq,
  url: row.url,
  title: row.title,
  at: row.at,
});

export class SqliteBrowserHistoryRepository implements BrowserHistoryRepositoryPort {
  readonly #store: BrowserHistoryStore;

  constructor(store: BrowserHistoryStore) {
    this.#store = store;
  }

  get #db(): Database {
    return this.#store.handle;
  }

  open(input: {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly taskId: string;
    readonly openedAt: string;
    readonly openedByCallId?: string | undefined;
  }): void {
    this.#db
      .prepare("INSERT INTO tavi_browser_sessions (session_id, workspace_id, task_id, opened_at, opened_by_call_id) VALUES (?, ?, ?, ?, ?)")
      .run(input.sessionId, input.workspaceId, input.taskId, input.openedAt, input.openedByCallId ?? null);
  }

  recordPage(input: { readonly sessionId: string; readonly url: string; readonly title?: string | undefined; readonly at: string }): void {
    const url = scrubBrowserUrl(input.url);
    if (url === undefined) return;
    const title = clipBrowserTitle(input.title) ?? null;
    this.#store.transaction(() => {
      const session = this.#db.prepare("SELECT 1 FROM tavi_browser_sessions WHERE session_id = ?").get(input.sessionId);
      if (session === undefined) return;
      const last = this.#db
        .prepare("SELECT seq, url FROM tavi_browser_visits WHERE session_id = ? ORDER BY seq DESC LIMIT 1")
        .get(input.sessionId) as { seq: number; url: string } | undefined;
      if (last?.url === url) {
        // The same page again (a re-observe, a reload): the title may have
        // loaded since, so it is refreshed when known, and nothing is appended.
        if (title !== null) {
          this.#db
            .prepare("UPDATE tavi_browser_visits SET title = ? WHERE session_id = ? AND seq = ?")
            .run(title, input.sessionId, last.seq);
        }
        this.#db
          .prepare("UPDATE tavi_browser_sessions SET last_url = ?, last_title = COALESCE(?, last_title) WHERE session_id = ?")
          .run(url, title, input.sessionId);
        return;
      }
      this.#db
        .prepare("INSERT INTO tavi_browser_visits (session_id, seq, url, title, at) VALUES (?, ?, ?, ?, ?)")
        .run(input.sessionId, (last?.seq ?? 0) + 1, url, title, input.at);
      this.#db
        .prepare("UPDATE tavi_browser_sessions SET last_url = ?, last_title = ?, pages = pages + 1 WHERE session_id = ?")
        .run(url, title, input.sessionId);
    });
  }

  setThumbnail(input: { readonly sessionId: string; readonly artifactId: string | null }): string | null {
    const replaced = this.#store.transaction(() => {
      const row = this.#db.prepare("SELECT thumbnail_artifact_id FROM tavi_browser_sessions WHERE session_id = ?").get(input.sessionId) as
        | { thumbnail_artifact_id: string | null }
        | undefined;
      if (row === undefined) return null;
      if (row.thumbnail_artifact_id === input.artifactId) return null;
      this.#db
        .prepare("UPDATE tavi_browser_sessions SET thumbnail_artifact_id = ? WHERE session_id = ?")
        .run(input.artifactId, input.sessionId);
      return row.thumbnail_artifact_id;
    });
    if (replaced !== null) this.#deleteThumbnails([replaced]);
    return replaced;
  }

  close(input: { readonly sessionId: string; readonly closedAt: string; readonly reason: string }): void {
    this.#db
      .prepare(
        "UPDATE tavi_browser_sessions SET closed_at = ?, close_reason = ?, inactive_since = NULL WHERE session_id = ? AND closed_at IS NULL",
      )
      .run(input.closedAt, input.reason, input.sessionId);
  }

  setInactive(input: { readonly sessionId: string; readonly since: string | null }): void {
    this.#db
      .prepare("UPDATE tavi_browser_sessions SET inactive_since = ? WHERE session_id = ? AND closed_at IS NULL")
      .run(input.since, input.sessionId);
  }

  counts(): { readonly open: number; readonly inactive: number } {
    const row = this.#db
      .prepare(
        "SELECT count(*) FILTER (WHERE inactive_since IS NULL) AS open, count(*) FILTER (WHERE inactive_since IS NOT NULL) AS inactive FROM tavi_browser_sessions WHERE closed_at IS NULL",
      )
      .get() as { open: number; inactive: number };
    return { open: row.open, inactive: row.inactive };
  }

  closeOpen(input: { readonly openedBefore: string; readonly closedAt: string; readonly reason: string }): number {
    return this.#db
      .prepare(
        "UPDATE tavi_browser_sessions SET closed_at = ?, close_reason = ?, inactive_since = NULL WHERE closed_at IS NULL AND opened_at < ?",
      )
      .run(input.closedAt, input.reason, input.openedBefore).changes;
  }

  sweep(input: { readonly olderThan: string }): { readonly sessions: number; readonly thumbnails: number } {
    const { sessions, thumbnailIds } = this.#store.transaction(() => {
      const referenced = (
        this.#db
          .prepare(
            "SELECT thumbnail_artifact_id AS id FROM tavi_browser_sessions WHERE opened_at < ? AND thumbnail_artifact_id IS NOT NULL",
          )
          .all(input.olderThan) as { id: string }[]
      ).map((row) => row.id);
      const deleted = this.#db.prepare("DELETE FROM tavi_browser_sessions WHERE opened_at < ?").run(input.olderThan).changes;
      // Thumbnails no session points at any more and past the window: one
      // whose session went with its task, or whose replacement was
      // interrupted between writing it and recording it.
      const orphans = (
        this.#db
          .prepare(`SELECT a.artifact_id AS id FROM tavi_artifacts a
          WHERE a.purpose = 'thumbnail' AND a.created_at < ?
            AND NOT EXISTS (SELECT 1 FROM tavi_browser_sessions s WHERE s.thumbnail_artifact_id = a.artifact_id)`)
          .all(input.olderThan) as { id: string }[]
      ).map((row) => row.id);
      return { sessions: deleted, thumbnailIds: [...new Set([...referenced, ...orphans])] };
    });
    return { sessions, thumbnails: this.#deleteThumbnails(thumbnailIds) };
  }

  sessions(input: {
    readonly workspaceId: string;
    readonly open?: boolean | undefined;
    readonly taskId?: string | undefined;
    readonly taskIds?: readonly string[] | undefined;
    readonly inactive?: boolean | undefined;
    readonly before?: { readonly openedAt: string; readonly sessionId: string } | undefined;
    readonly limit: number;
  }): readonly BrowserSessionListing[] {
    assertPositiveLimit(input.limit, "browserHistory.sessions");
    const where = ["s.workspace_id = ?"];
    const params: (string | number)[] = [input.workspaceId];
    if (input.open === true) where.push("s.closed_at IS NULL");
    if (input.open === false) where.push("s.closed_at IS NOT NULL");
    if (input.inactive === true) where.push("s.closed_at IS NULL AND s.inactive_since IS NOT NULL");
    if (input.inactive === false) where.push("s.inactive_since IS NULL");
    if (input.taskId !== undefined) {
      where.push("s.task_id = ?");
      params.push(input.taskId);
    }
    if (input.taskIds !== undefined) {
      // A tree is bounded (AGENT_TREE_LIMIT); none matches nothing.
      const ids = input.taskIds.slice(0, 500);
      if (ids.length === 0) return [];
      where.push(`s.task_id IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
    if (input.before !== undefined) {
      where.push("(s.opened_at < ? OR (s.opened_at = ? AND s.session_id < ?))");
      params.push(input.before.openedAt, input.before.openedAt, input.before.sessionId);
    }
    // The thumbnail is named only while its artifact is there and is a
    // thumbnail: a card never points at bytes `artifacts read` would refuse.
    const rows = this.#db
      .prepare(`SELECT s.session_id, s.workspace_id, s.task_id, s.opened_at, s.closed_at, s.close_reason, s.last_url, s.last_title, s.pages, s.opened_by_call_id, s.inactive_since,
          (SELECT a.artifact_id FROM tavi_artifacts a WHERE a.artifact_id = s.thumbnail_artifact_id AND a.purpose = 'thumbnail' AND a.workspace_id = s.workspace_id) AS thumbnail_artifact_id,
          t.principal_id, COALESCE(NULLIF(trim(t.title_override), ''), t.title) AS generated_title, ${TASK_PROMPT_SQL("t")} AS prompt
        FROM tavi_browser_sessions s JOIN tavi_tasks t ON t.task_id = s.task_id
        WHERE ${where.join(" AND ")}
        ORDER BY s.opened_at DESC, s.session_id DESC LIMIT ?`)
      .all(...params, Math.min(input.limit, PAGE_MAX)) as (SessionRow & {
      principal_id: string;
      generated_title: string | null;
      prompt: string | null;
    })[];
    return rows.map((row) => ({
      ...toSession(row),
      principalId: row.principal_id,
      taskTitle: displayTitleOf(row.generated_title, row.prompt) ?? null,
    }));
  }

  visitPage(input: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly afterSeq?: number | undefined;
    readonly limit: number;
  }): readonly BrowserVisitRecord[] | undefined {
    assertPositiveLimit(input.limit, "browserHistory.visitPage");
    const session = this.#db
      .prepare("SELECT 1 FROM tavi_browser_sessions WHERE session_id = ? AND workspace_id = ?")
      .get(input.sessionId, input.workspaceId);
    if (session === undefined) return undefined;
    return (
      this.#db
        .prepare("SELECT session_id, seq, url, title, at FROM tavi_browser_visits WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
        .all(input.sessionId, input.afterSeq ?? 0, Math.min(input.limit, PAGE_MAX)) as VisitRow[]
    ).map(toVisit);
  }

  /**
   * Delete thumbnail artifacts, row first and then the file, as
   * `pruneArtifacts` does: a failed row delete leaves the file in place. Only
   * `purpose = 'thumbnail'` rows are touched, whatever id is passed. Returns
   * how many rows went.
   */
  #deleteThumbnails(artifactIds: readonly string[]): number {
    let deleted = 0;
    for (const artifactId of artifactIds) {
      const row = this.#db
        .prepare("SELECT relative_path FROM tavi_artifacts WHERE artifact_id = ? AND purpose = 'thumbnail'")
        .get(artifactId) as { relative_path: string } | undefined;
      if (row === undefined) continue;
      this.#db.prepare("DELETE FROM tavi_artifacts WHERE artifact_id = ? AND purpose = 'thumbnail'").run(artifactId);
      deleted += 1;
      try {
        rmSync(this.#store.resolveArtifactPath(row.relative_path), { force: true });
      } catch {
        // The row is gone; an unreadable or already-absent file (or a store
        // with no artifacts directory) must not fail the caller.
      }
    }
    return deleted;
  }
}
