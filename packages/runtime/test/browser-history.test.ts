import { existsSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Browser history: the session lifecycle, visits and their dedupe, scrubbed
 * URLs, thumbnails as internal artifacts, restart cleanup, the 30-day sweep,
 * the cascade from a task, and the `browser` change counter.
 */

const AT = "2026-09-20T00:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const directories = temporaryDirectories();

afterEach(() => {
  directories.cleanup();
});

function fixture() {
  const artifactsDirectory = directories.create("tavi-browser-history-");
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true, artifactsDirectory });
  const { tasks, browserHistory, artifacts } = store.asPort().repositories;
  const task = (id: string) =>
    tasks.admit({
      workspaceId: "default",
      principalId: "operator",
      operationKey: id,
      kind: "start",
      intent: { prompt: `Prompt ${id}` },
      checkpointNamespace: "",
      origin: "ipc",
      now: () => AT,
      newTaskId: () => id,
      newThreadId: () => `thread-${id}`,
      newAdmissionId: () => `admission-${id}`,
    });
  const thumbnail = (taskId: string) =>
    artifacts.putArtifact({
      workspaceId: "default",
      runId: taskId,
      contentType: "image/jpeg",
      body: new Uint8Array([0xff, 0xd8, 0xff, 1]),
      extension: "jpg",
      reviewState: "approved",
      purpose: "thumbnail",
    });
  const fileOf = (artifactId: string) => {
    const record = artifacts.getArtifact(artifactId);
    return record === undefined ? undefined : store.resolveArtifactPath(record.relativePath);
  };
  const version = () =>
    (
      store.handle.prepare("SELECT version FROM tavi_center_versions WHERE scope = 'default' AND kind = ?").get("browser") as
        | { version: number }
        | undefined
    )?.version ?? 0;
  const reviewVersion = () =>
    (
      store.handle.prepare("SELECT version FROM tavi_center_versions WHERE scope = 'default' AND kind = 'review'").get() as
        | { version: number }
        | undefined
    )?.version ?? 0;
  const session = (sessionId: string) =>
    browserHistory.sessions({ workspaceId: "default", limit: 50 }).find((row) => row.sessionId === sessionId);
  const visits = (sessionId: string) => browserHistory.visitPage({ workspaceId: "default", sessionId, limit: 200 });
  return { store, browserHistory, artifacts, task, thumbnail, fileOf, version, reviewVersion, session, visits };
}

describe("browser sessions", () => {
  it("records a session's pages with scrubbed URLs, dedupes a repeated page, and closes", () => {
    const { store, browserHistory, task, session, visits } = fixture();
    try {
      task("t1");
      browserHistory.open({ sessionId: "s1", workspaceId: "default", taskId: "t1", openedAt: AT });
      expect(session("s1")).toEqual({
        sessionId: "s1",
        workspaceId: "default",
        taskId: "t1",
        openedAt: AT,
        closedAt: null,
        closeReason: null,
        lastUrl: null,
        lastTitle: null,
        thumbnailArtifactId: null,
        pages: 0,
        openedByCallId: null,
        inactiveSince: null,
        principalId: "operator",
        taskTitle: "Prompt t1",
      });

      browserHistory.recordPage({
        sessionId: "s1",
        url: "https://user:pw@example.com/search?q=secret#top",
        title: "Results\u0000",
        at: at(1),
      });
      // An observe of the same page (a different query, even) adds no visit; a title that loaded since is kept.
      browserHistory.recordPage({ sessionId: "s1", url: "https://example.com/search?q=other", at: at(2) });
      browserHistory.recordPage({ sessionId: "s1", url: "https://example.com/search", title: "Results (2)", at: at(3) });
      browserHistory.recordPage({ sessionId: "s1", url: "https://docs.example.com:8443/guide", title: "Guide", at: at(4) });
      // Back to the first page: not consecutive, so it is a visit again.
      browserHistory.recordPage({ sessionId: "s1", url: "https://example.com/search", at: at(5) });
      // Not a URL: nothing recorded.
      browserHistory.recordPage({ sessionId: "s1", url: "::::", at: at(6) });

      expect(visits("s1")).toEqual([
        { sessionId: "s1", seq: 1, url: "https://example.com/search", title: "Results (2)", at: at(1) },
        { sessionId: "s1", seq: 2, url: "https://docs.example.com:8443/guide", title: "Guide", at: at(4) },
        { sessionId: "s1", seq: 3, url: "https://example.com/search", title: null, at: at(5) },
      ]);
      expect(session("s1")).toMatchObject({ lastUrl: "https://example.com/search", lastTitle: null, pages: 3 });
      // Nothing anywhere holds the query string.
      expect(JSON.stringify(store.handle.prepare("SELECT * FROM tavi_browser_visits").all())).not.toContain("secret");
      expect(JSON.stringify(store.handle.prepare("SELECT * FROM tavi_browser_sessions").all())).not.toContain("secret");

      browserHistory.close({ sessionId: "s1", closedAt: at(7), reason: "closed" });
      // A second close keeps the first.
      browserHistory.close({ sessionId: "s1", closedAt: at(8), reason: "owner restarted" });
      expect(session("s1")).toMatchObject({ closedAt: at(7), closeReason: "closed" });
    } finally {
      store.close();
    }
  });

  it("lists the sessions of several tasks at once (a task tree), and none for an empty tree", () => {
    const { store, browserHistory, task } = fixture();
    try {
      for (const id of ["t1", "t2", "t3"]) {
        task(id);
        browserHistory.open({ sessionId: `s-${id}`, workspaceId: "default", taskId: id, openedAt: AT });
      }
      expect(
        browserHistory
          .sessions({ workspaceId: "default", taskIds: ["t1", "t3"], limit: 10 })
          .map((row) => row.sessionId)
          .sort(),
      ).toEqual(["s-t1", "s-t3"]);
      expect(browserHistory.sessions({ workspaceId: "default", taskIds: [], limit: 10 })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("marks a session inactive and in use again, counts both, lists inactive ones, and clears it on close", () => {
    const { store, browserHistory, task, session } = fixture();
    try {
      task("t1");
      browserHistory.open({ sessionId: "s1", workspaceId: "default", taskId: "t1", openedAt: AT });
      browserHistory.open({ sessionId: "s2", workspaceId: "default", taskId: "t1", openedAt: at(1) });
      browserHistory.setInactive({ sessionId: "s1", since: at(5) });
      expect(session("s1")?.inactiveSince).toBe(at(5));
      expect(browserHistory.counts()).toEqual({ open: 1, inactive: 1 });
      expect(
        browserHistory.sessions({ workspaceId: "default", open: true, inactive: true, limit: 10 }).map((row) => row.sessionId),
      ).toEqual(["s1"]);
      expect(
        browserHistory.sessions({ workspaceId: "default", open: true, inactive: false, limit: 10 }).map((row) => row.sessionId),
      ).toEqual(["s2"]);
      browserHistory.setInactive({ sessionId: "s1", since: null });
      expect(browserHistory.counts()).toEqual({ open: 2, inactive: 0 });
      browserHistory.setInactive({ sessionId: "s1", since: at(6) });
      browserHistory.close({ sessionId: "s1", closedAt: at(7), reason: "closed by operator" });
      expect(session("s1")).toMatchObject({ closedAt: at(7), closeReason: "closed by operator", inactiveSince: null });
      // A closed session is never marked inactive again.
      browserHistory.setInactive({ sessionId: "s1", since: at(8) });
      expect(session("s1")?.inactiveSince).toBeNull();
      expect(browserHistory.counts()).toEqual({ open: 1, inactive: 0 });
    } finally {
      store.close();
    }
  });

  it("keeps the tool call that opened a session", () => {
    const { store, browserHistory, task, session } = fixture();
    try {
      task("t1");
      browserHistory.open({ sessionId: "s1", workspaceId: "default", taskId: "t1", openedAt: AT, openedByCallId: "call-open-1" });
      expect(session("s1")).toMatchObject({ openedByCallId: "call-open-1" });
    } finally {
      store.close();
    }
  });

  it("ignores writes for a session it has no row for", () => {
    const { store, browserHistory, visits } = fixture();
    try {
      browserHistory.recordPage({ sessionId: "ghost", url: "https://example.com/", at: AT });
      expect(browserHistory.setThumbnail({ sessionId: "ghost", artifactId: null })).toBeNull();
      expect(visits("ghost")).toBeUndefined();
      expect(store.handle.prepare("SELECT count(*) AS n FROM tavi_browser_visits").get()).toEqual({ n: 0 });
    } finally {
      store.close();
    }
  });

  it("refuses a session for a task that does not exist", () => {
    const { store, browserHistory } = fixture();
    try {
      expect(() => browserHistory.open({ sessionId: "s1", workspaceId: "default", taskId: "missing", openedAt: AT })).toThrow(
        /FOREIGN KEY/,
      );
    } finally {
      store.close();
    }
  });

  it("closes the sessions a previous owner left open, and none opened since", () => {
    const { store, browserHistory, task, session } = fixture();
    try {
      task("t1");
      browserHistory.open({ sessionId: "left", workspaceId: "default", taskId: "t1", openedAt: at(1) });
      browserHistory.open({ sessionId: "done", workspaceId: "default", taskId: "t1", openedAt: at(1) });
      browserHistory.close({ sessionId: "done", closedAt: at(2), reason: "closed" });
      browserHistory.open({ sessionId: "new", workspaceId: "default", taskId: "t1", openedAt: at(10) });
      expect(browserHistory.closeOpen({ openedBefore: at(5), closedAt: at(5), reason: "owner restarted" })).toBe(1);
      expect(session("left")).toMatchObject({ closedAt: at(5), closeReason: "owner restarted" });
      expect(session("done")).toMatchObject({ closedAt: at(2), closeReason: "closed" });
      expect(session("new")).toMatchObject({ closedAt: null });
    } finally {
      store.close();
    }
  });

  it("lists a workspace's sessions newest first", () => {
    const { store, browserHistory, task } = fixture();
    try {
      task("t1");
      browserHistory.open({ sessionId: "a", workspaceId: "default", taskId: "t1", openedAt: at(1) });
      browserHistory.open({ sessionId: "b", workspaceId: "default", taskId: "t1", openedAt: at(2) });
      expect(browserHistory.sessions({ workspaceId: "default", limit: 10 }).map((row) => row.sessionId)).toEqual(["b", "a"]);
      expect(browserHistory.sessions({ workspaceId: "default", limit: 1 }).map((row) => row.sessionId)).toEqual(["b"]);
      expect(browserHistory.sessions({ workspaceId: "other", limit: 10 })).toEqual([]);
      expect(() => browserHistory.sessions({ workspaceId: "default", limit: 0 })).toThrow();
    } finally {
      store.close();
    }
  });
});

describe("the Command Center's reads", () => {
  it("pages a workspace's sessions, live or closed, with the task's title, person and a live thumbnail", () => {
    const { store, browserHistory, artifacts, task, thumbnail } = fixture();
    try {
      task("t1");
      task("t2");
      store.handle.prepare("UPDATE tavi_tasks SET title = 'Generated title' WHERE task_id = 't2'").run();
      browserHistory.open({ sessionId: "a", workspaceId: "default", taskId: "t1", openedAt: at(1) });
      browserHistory.open({ sessionId: "b", workspaceId: "default", taskId: "t2", openedAt: at(2) });
      browserHistory.open({ sessionId: "c", workspaceId: "default", taskId: "t1", openedAt: at(3) });
      browserHistory.close({ sessionId: "a", closedAt: at(4), reason: "closed" });
      const thumb = thumbnail("t2");
      browserHistory.setThumbnail({ sessionId: "b", artifactId: thumb.artifactId });
      // An ordinary artifact a row names (never written so, but a card must not point at it).
      const capture = artifacts.putArtifact({
        workspaceId: "default",
        runId: "t1",
        contentType: "image/png",
        body: "png",
        extension: "png",
      });
      store.handle.prepare("UPDATE tavi_browser_sessions SET thumbnail_artifact_id = ? WHERE session_id = 'c'").run(capture.artifactId);

      const all = browserHistory.sessions({ workspaceId: "default", limit: 10 });
      expect(all.map((row) => row.sessionId)).toEqual(["c", "b", "a"]);
      expect(all.find((row) => row.sessionId === "b")).toMatchObject({
        taskTitle: "Generated title",
        principalId: "operator",
        thumbnailArtifactId: thumb.artifactId,
      });
      expect(all.find((row) => row.sessionId === "c")).toMatchObject({ taskTitle: "Prompt t1", thumbnailArtifactId: null });
      expect(browserHistory.sessions({ workspaceId: "default", open: true, limit: 10 }).map((row) => row.sessionId)).toEqual(["c", "b"]);
      expect(browserHistory.sessions({ workspaceId: "default", open: false, limit: 10 }).map((row) => row.sessionId)).toEqual(["a"]);
      const first = browserHistory.sessions({ workspaceId: "default", limit: 2 });
      const last = first.at(-1)!;
      expect(
        browserHistory
          .sessions({ workspaceId: "default", limit: 2, before: { openedAt: last.openedAt, sessionId: last.sessionId } })
          .map((row) => row.sessionId),
      ).toEqual(["a"]);
      expect(browserHistory.sessions({ workspaceId: "other", limit: 10 })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("pages a session's visits only within its workspace", () => {
    const { store, browserHistory, task } = fixture();
    try {
      task("t1");
      browserHistory.open({ sessionId: "s1", workspaceId: "default", taskId: "t1", openedAt: AT });
      for (let index = 1; index <= 3; index += 1)
        browserHistory.recordPage({ sessionId: "s1", url: `https://example.com/p${index}?token=x`, at: at(index) });
      expect(browserHistory.visitPage({ workspaceId: "default", sessionId: "s1", limit: 2 })?.map((visit) => visit.url)).toEqual([
        "https://example.com/p1",
        "https://example.com/p2",
      ]);
      expect(
        browserHistory.visitPage({ workspaceId: "default", sessionId: "s1", afterSeq: 2, limit: 2 })?.map((visit) => visit.seq),
      ).toEqual([3]);
      expect(browserHistory.visitPage({ workspaceId: "other", sessionId: "s1", limit: 2 })).toBeUndefined();
      expect(browserHistory.visitPage({ workspaceId: "default", sessionId: "ghost", limit: 2 })).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("counts live sessions in the center summary", () => {
    const { store, browserHistory, task } = fixture();
    try {
      task("t1");
      browserHistory.open({ sessionId: "a", workspaceId: "default", taskId: "t1", openedAt: at(1) });
      browserHistory.open({ sessionId: "b", workspaceId: "default", taskId: "t1", openedAt: at(2) });
      browserHistory.close({ sessionId: "a", closedAt: at(3), reason: "closed" });
      const summary = store
        .asPort()
        .repositories.center.summary({ workspaceId: "default", principalId: "operator", timezone: "UTC", days: 1, now: at(5) });
      expect(summary.counts.liveBrowserSessions).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("thumbnails", () => {
  it("are internal artifacts: replacing one deletes the previous row and file", () => {
    const { store, browserHistory, artifacts, task, thumbnail, fileOf, session } = fixture();
    try {
      task("t1");
      browserHistory.open({ sessionId: "s1", workspaceId: "default", taskId: "t1", openedAt: AT });
      const first = thumbnail("t1");
      expect(artifacts.getArtifact(first.artifactId)).toMatchObject({ purpose: "thumbnail", reviewState: "approved", runId: "t1" });
      const firstFile = fileOf(first.artifactId) ?? "";
      expect(existsSync(firstFile)).toBe(true);
      expect(browserHistory.setThumbnail({ sessionId: "s1", artifactId: first.artifactId })).toBeNull();

      const second = thumbnail("t1");
      expect(browserHistory.setThumbnail({ sessionId: "s1", artifactId: second.artifactId })).toBe(first.artifactId);
      expect(artifacts.getArtifact(first.artifactId)).toBeUndefined();
      expect(existsSync(firstFile)).toBe(false);
      expect(session("s1")?.thumbnailArtifactId).toBe(second.artifactId);

      // A sensitive page clears it.
      const secondFile = fileOf(second.artifactId) ?? "";
      expect(browserHistory.setThumbnail({ sessionId: "s1", artifactId: null })).toBe(second.artifactId);
      expect(existsSync(secondFile)).toBe(false);
      expect(session("s1")?.thumbnailArtifactId).toBeNull();
    } finally {
      store.close();
    }
  });

  it("never deletes an ordinary artifact passed as a thumbnail", () => {
    const { store, browserHistory, artifacts, task } = fixture();
    try {
      task("t1");
      browserHistory.open({ sessionId: "s1", workspaceId: "default", taskId: "t1", openedAt: AT });
      const capture = artifacts.putArtifact({
        workspaceId: "default",
        runId: "t1",
        contentType: "image/png",
        body: "png",
        extension: "png",
      });
      browserHistory.setThumbnail({ sessionId: "s1", artifactId: capture.artifactId });
      browserHistory.setThumbnail({ sessionId: "s1", artifactId: null });
      expect(artifacts.getArtifact(capture.artifactId)).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("are left out of the operator's artifact listing", () => {
    const { store, task, thumbnail, artifacts } = fixture();
    try {
      task("t1");
      const thumb = thumbnail("t1");
      const capture = artifacts.putArtifact({
        workspaceId: "default",
        runId: "t1",
        contentType: "image/png",
        body: "png",
        extension: "png",
      });
      const listed = store.listArtifacts({ workspaceId: "default", limit: 50, includeDecided: true });
      expect(listed.rows.map((row) => row.artifactId)).toEqual([capture.artifactId]);
      expect(store.listArtifacts({ workspaceId: "default", limit: 50, artifactIds: [thumb.artifactId] }).rows).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("wake the browser section, not the approvals page", () => {
    const { store, browserHistory, task, thumbnail, artifacts, version, reviewVersion } = fixture();
    try {
      task("t1");
      const reviews = reviewVersion();
      const before = version();
      browserHistory.open({ sessionId: "s1", workspaceId: "default", taskId: "t1", openedAt: AT });
      expect(version()).toBeGreaterThan(before);
      const opened = version();
      browserHistory.recordPage({ sessionId: "s1", url: "https://example.com/", at: at(1) });
      expect(version()).toBeGreaterThan(opened);
      const thumb = thumbnail("t1");
      const recorded = version();
      browserHistory.setThumbnail({ sessionId: "s1", artifactId: thumb.artifactId });
      expect(version()).toBeGreaterThan(recorded);
      expect(reviewVersion()).toBe(reviews);
      // An ordinary artifact still counts as a review change.
      artifacts.putArtifact({
        workspaceId: "default",
        runId: "t1",
        contentType: "image/png",
        body: "png",
        extension: "png",
        reviewState: "pending",
      });
      expect(reviewVersion()).toBeGreaterThan(reviews);
    } finally {
      store.close();
    }
  });
});

describe("retention", () => {
  it("deletes sessions older than the window with their visits and thumbnails, and nothing else", () => {
    const { store, browserHistory, artifacts, task, thumbnail, fileOf, session, visits } = fixture();
    try {
      task("t1");
      browserHistory.open({ sessionId: "old", workspaceId: "default", taskId: "t1", openedAt: "2026-08-01T00:00:00.000Z" });
      browserHistory.recordPage({ sessionId: "old", url: "https://example.com/a", at: "2026-08-01T00:01:00.000Z" });
      const oldThumb = thumbnail("t1");
      browserHistory.setThumbnail({ sessionId: "old", artifactId: oldThumb.artifactId });
      const oldFile = fileOf(oldThumb.artifactId) ?? "";

      browserHistory.open({ sessionId: "recent", workspaceId: "default", taskId: "t1", openedAt: AT });
      browserHistory.recordPage({ sessionId: "recent", url: "https://example.com/b", at: AT });
      const recentThumb = thumbnail("t1");
      browserHistory.setThumbnail({ sessionId: "recent", artifactId: recentThumb.artifactId });

      // An ordinary artifact of the same task, and an orphaned thumbnail past the window.
      const capture = artifacts.putArtifact({
        workspaceId: "default",
        runId: "t1",
        contentType: "image/png",
        body: "png",
        extension: "png",
      });
      const orphan = thumbnail("t1");
      store.handle
        .prepare("UPDATE tavi_artifacts SET created_at = '2026-08-01T00:00:00.000Z' WHERE artifact_id IN (?, ?)")
        .run(capture.artifactId, orphan.artifactId);
      const orphanFile = fileOf(orphan.artifactId) ?? "";

      expect(browserHistory.sweep({ olderThan: "2026-09-01T00:00:00.000Z" })).toEqual({ sessions: 1, thumbnails: 2 });
      expect(session("old")).toBeUndefined();
      expect(visits("old")).toBeUndefined();
      expect(store.handle.prepare("SELECT count(*) AS n FROM tavi_browser_visits WHERE session_id = 'old'").get()).toEqual({ n: 0 });
      expect(artifacts.getArtifact(oldThumb.artifactId)).toBeUndefined();
      expect(existsSync(oldFile)).toBe(false);
      expect(artifacts.getArtifact(orphan.artifactId)).toBeUndefined();
      expect(existsSync(orphanFile)).toBe(false);

      expect(session("recent")).toMatchObject({ thumbnailArtifactId: recentThumb.artifactId, pages: 1 });
      expect(artifacts.getArtifact(recentThumb.artifactId)).toBeDefined();
      expect(artifacts.getArtifact(capture.artifactId)).toBeDefined();
      expect(existsSync(fileOf(capture.artifactId) ?? "")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("deletes a task's sessions and visits with the task", () => {
    const { store, browserHistory, task } = fixture();
    try {
      task("t1");
      task("t2");
      browserHistory.open({ sessionId: "s1", workspaceId: "default", taskId: "t1", openedAt: AT });
      browserHistory.recordPage({ sessionId: "s1", url: "https://example.com/", at: AT });
      browserHistory.open({ sessionId: "s2", workspaceId: "default", taskId: "t2", openedAt: AT });
      store.handle.prepare("DELETE FROM tavi_admissions WHERE task_id = 't1'").run();
      store.handle.prepare("DELETE FROM tavi_tasks WHERE task_id = 't1'").run();
      expect(browserHistory.sessions({ workspaceId: "default", limit: 10 }).map((row) => row.sessionId)).toEqual(["s2"]);
      expect(store.handle.prepare("SELECT count(*) AS n FROM tavi_browser_visits").get()).toEqual({ n: 0 });
    } finally {
      store.close();
    }
  });
});
