import { join } from "node:path";

import { nowTimestamp } from "@tavi/contracts/util";
import { acquireDataDirectoryOwnership } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { retentionCutoff } from "../../src/features/maintenance/retention.js";

/**
 * `tavi prune`.
 *
 * The transport tables grow one row per message, send, delegation and
 * suspension, and nothing pruned them; the path from there to "the disk is full
 * and the alert about the disk is unwritable" had no gate on it. The command is
 * the sweep `serve` also runs every six hours.
 */

const directories = temporaryDirectories({ prefix: "tavi-prune-" });

afterEach(() => directories.cleanup());

/** A migrated directory with one old processed inbox row and one fresh one. */
async function seeded(): Promise<string> {
  const directory = directories.create();
  expect(await main(["models", "list", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  try {
    const insert = store.handle.prepare(
      "INSERT INTO tavi_messaging_inbox (connection_id, provider_event_id, kind, payload_json, state, received_at) VALUES (?, ?, 'message', '{}', ?, ?)",
    );
    insert.run("telegram-main", "old-processed", "processed", "2026-01-01T00:00:00.000Z");
    insert.run("telegram-main", "fresh-processed", "processed", nowTimestamp());
  } finally {
    await store.close();
  }
  return directory;
}

describe("tavi prune", () => {
  it("counts what it would delete, then deletes it", async () => {
    const directory = await seeded();
    const dry = capture();
    expect(await main(["prune", "--dry-run", "--format", "json", "--data-dir", directory], { io: dry.io })).toBe(EXIT.ok);
    const preview = JSON.parse(dry.stdout()) as { inbox: number; total: number; dryRun: boolean };
    expect(preview).toMatchObject({ inbox: 1, total: 1, dryRun: true });

    // Nothing moved: the fresh row is inside the window either way, and the old
    // one is still there after a dry run.
    const still = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      expect((await still.transportRowCounts()).inbox).toBe(2);
    } finally {
      await still.close();
    }

    const real = capture();
    expect(await main(["prune", "--data-dir", directory], { io: real.io })).toBe(EXIT.ok);
    expect(real.stdout()).toMatch(/deleted 1 row\(s\) older than/);

    const after = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      expect(await after.transportRowCounts()).toMatchObject({ inbox: 1, inboxUnprocessed: 0 });
    } finally {
      await after.close();
    }
  });

  it("deletes non-report artifacts only when asked, and never a pending one", async () => {
    const directory = directories.create();
    expect(await main(["models", "list", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const artifacts = store.asPort().repositories.artifacts;
      // Older than the default 30-day window the command uses.
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const shot = await artifacts.putArtifact({ workspaceId: "default", contentType: "image/png", body: "png", extension: "png" });
      const pending = await artifacts.putArtifact({
        workspaceId: "default",
        contentType: "text/plain",
        body: "review",
        extension: "txt",
        reviewState: "pending",
      });
      store.handle
        .prepare("UPDATE tavi_artifacts SET created_at = ? WHERE artifact_id IN (?, ?)")
        .run(old, shot.artifactId, pending.artifactId);
    } finally {
      await store.close();
    }

    // Without the flag, nothing happens to artifacts.
    const without = capture();
    expect(await main(["prune", "--format", "json", "--data-dir", directory], { io: without.io })).toBe(EXIT.ok);
    expect((JSON.parse(without.stdout()) as { artifacts: number }).artifacts).toBe(0);

    const listed = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      expect(await listed.asPort().repositories.artifacts.getArtifact("art-")).toBeUndefined();
      const remaining = listed.handle.prepare("SELECT COUNT(*) AS n FROM tavi_artifacts").get() as { n: number };
      expect(remaining.n).toBe(2);
    } finally {
      await listed.close();
    }

    // An artifact another table references (a skill package) is left alone, so the
    // sweep's foreign-key failure mode is unreachable — and its body is still there.
    const referenced = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const body = await referenced.asPort().repositories.artifacts.putArtifact({
        workspaceId: "default",
        contentType: "application/zip",
        body: "zip",
        extension: "zip",
      });
      referenced.handle
        .prepare(
          `INSERT INTO tavi_skill_versions
             (skill_id, version, content_hash, scope_key, manifest_json, provenance, review_state, package_artifact_id, imported_by, imported_at)
           VALUES ('s', '1.0.0', 'hash', 'default', '{}', 'operator', 'approved', ?, 'operator', '2026-01-01T00:00:00.000Z')`,
        )
        .run(body.artifactId);
      referenced.handle
        .prepare("UPDATE tavi_artifacts SET created_at = ? WHERE artifact_id = ?")
        .run(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(), body.artifactId);
    } finally {
      await referenced.close();
    }

    const withFlag = capture();
    expect(await main(["prune", "--include-artifacts", "--format", "json", "--data-dir", directory], { io: withFlag.io })).toBe(EXIT.ok);
    expect((JSON.parse(withFlag.stdout()) as { artifacts: number }).artifacts).toBe(1);

    const after = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      // The pending review item is still there: deleting it would answer the
      // question it exists to ask. The skill package is still there because a
      // foreign key references it, and its body survived the sweep.
      const rows = after.handle.prepare("SELECT review_state FROM tavi_artifacts").all() as { review_state: string }[];
      expect(rows.map((row) => row.review_state).sort()).toEqual(["approved", "pending"]);
      expect(
        await after.asPort().repositories.artifacts.readArtifactBody(
          (
            after.handle.prepare("SELECT artifact_id FROM tavi_artifacts WHERE review_state = 'approved'").get() as {
              artifact_id: string;
            }
          ).artifact_id,
        ),
      ).toBeDefined();
    } finally {
      await after.close();
    }
  });

  it("refuses while another process owns the directory, because it deletes", async () => {
    const directory = await seeded();
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "test-owner" });
    try {
      const refused = capture();
      expect(await main(["prune", "--data-dir", directory], { io: refused.io })).toBe(EXIT.alreadyOwned);
      expect(refused.stderr()).toMatch(/^prune command failed: Another tavi command \(pid \d+\) already owns .*; prune needs it to itself/);
    } finally {
      await ownership.release();
    }
  });

  it("rejects a nonsensical window as usage", async () => {
    const directory = directories.create();
    const refused = capture();
    expect(await main(["prune", "--older-than", "0", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/--older-than must be a whole number of days/);
    const help = capture();
    expect(await main(["prune", "--help"], { io: help.io })).toBe(EXIT.ok);
    expect(help.stdout()).toMatch(/^tavi prune \[options\]/);
  });

  it("computes the cutoff from the window", () => {
    expect(retentionCutoff(new Date("2026-03-01T00:00:00.000Z"), 30)).toBe("2026-01-30T00:00:00.000Z");
  });
});
