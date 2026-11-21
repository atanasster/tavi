import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { SqliteStore } from "../src/persistence/store.js";

/**
 * Raw video's retention: a
 * workspace's videos taken from outside, past its `video.keepDays`, pruned
 * with their bodies; never a trusted file, a preview, a still pending one,
 * another workspace's or a newer one. (One another table names is kept by
 * the same predicate `pruneArtifacts` uses, tested with it.) A preview made
 * from a pruned video stays, and says what it was made from.
 */

const stores: SqliteStore[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});

function fixture(): SqliteStore {
  const directory = directories.create("tavi-video-retention-");
  const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  stores.push(store);
  return store;
}

describe("pruneVideo", () => {
  it("prunes a workspace's old videos from outside, and nothing else", () => {
    const store = fixture();
    const put = (
      artifactId: string,
      input: {
        readonly workspaceId?: string;
        readonly contentType?: string;
        readonly untrusted?: boolean;
        readonly reviewState?: "pending" | "approved";
        readonly preview?: "video-frame";
        readonly derivedFrom?: string;
      },
    ) =>
      store.putArtifact({
        artifactId,
        workspaceId: input.workspaceId ?? "w1",
        contentType: input.contentType ?? "video/mp4",
        body: artifactId,
        extension: "bin",
        ...(input.untrusted === false ? {} : { untrusted: true }),
        ...(input.reviewState === undefined ? {} : { reviewState: input.reviewState }),
        ...(input.preview === undefined ? {} : { preview: input.preview, derivedFrom: input.derivedFrom }),
      });
    const old = put("art-in-old", {});
    put("art-in-mov", { contentType: "video/quicktime" });
    // A voice message is a recording of someone: kept as long as a video, then gone.
    put("art-in-voice", { contentType: "audio/ogg" });
    put("art-folder", { untrusted: false });
    put("art-gif", { contentType: "image/gif" });
    put("art-pending", { reviewState: "pending" });
    put("art-elsewhere", { workspaceId: "w2" });
    put("art-frame", { contentType: "image/jpeg", preview: "video-frame", derivedFrom: "art-in-old" });
    const later = new Date(Date.now() + 60_000).toISOString();
    const body = store.resolveArtifactPath(old.relativePath);
    expect(existsSync(body)).toBe(true);
    expect(store.pruneVideo({ workspaceId: "w1", olderThan: later })).toEqual({
      artifacts: 3,
      bytes: "art-in-old".length + "art-in-mov".length + "art-in-voice".length,
    });
    expect(existsSync(body)).toBe(false);
    for (const kept of ["art-folder", "art-gif", "art-pending", "art-elsewhere", "art-frame"])
      expect(store.getArtifact(kept), kept).toBeDefined();
    expect(store.getArtifact("art-in-old")).toBeUndefined();
    // Its frame says what it was made from: the video tools tell a pruned video from one never there.
    expect(store.derivedPreviewExists("w1", "art-in-old")).toBe(true);
    expect(store.derivedPreviewExists("w2", "art-in-old")).toBe(false);
    expect(store.derivedPreviewExists("w1", "art-never")).toBe(false);
    // Nothing newer than the cut goes.
    put("art-in-new", {});
    expect(store.pruneVideo({ workspaceId: "w1", olderThan: new Date(Date.now() - 60_000).toISOString() })).toEqual({
      artifacts: 0,
      bytes: 0,
    });
  });

  it("keeps a video a report names, past its days, as pruneArtifacts keeps one", () => {
    const store = fixture();
    store.putArtifact({
      artifactId: "art-in-reported",
      workspaceId: "w1",
      contentType: "video/mp4",
      body: "reported",
      extension: "mp4",
      untrusted: true,
    });
    store.putArtifact({
      artifactId: "art-in-plain",
      workspaceId: "w1",
      contentType: "video/mp4",
      body: "plain",
      extension: "mp4",
      untrusted: true,
    });
    store.handle
      .prepare(
        "INSERT INTO tavi_reports (report_id, workspace_id, run_id, artifact_id, period_start, period_end, generated_at, bytes, projects_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "report-1",
        "w1",
        "run-1",
        "art-in-reported",
        "2026-10-01T00:00:00.000Z",
        "2026-10-02T00:00:00.000Z",
        "2026-10-02T00:00:00.000Z",
        8,
        "[]",
      );
    expect(store.pruneVideo({ workspaceId: "w1", olderThan: new Date(Date.now() + 60_000).toISOString() })).toEqual({
      artifacts: 1,
      bytes: "plain".length,
    });
    expect(store.getArtifact("art-in-reported")).toBeDefined();
    expect(store.getArtifact("art-in-plain")).toBeUndefined();
  });
});
