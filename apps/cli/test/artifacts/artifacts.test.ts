import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FOLDER_CAP_DEFAULT_BYTES } from "@tavi/contracts";
import { acquireDataDirectoryOwnership } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * `tavi artifacts`: the first artifact-facing CLI
 * surface this codebase has ever had. There is no `tavi artifacts create`
 * — artifacts are only ever created by a real governed tool's dispatch —
 * so these tests seed pending artifacts directly via `SqliteStore`,
 * releasing ownership before each `main()` call the same way a real
 * process handing off to the CLI would.
 */

const directories = temporaryDirectories({ prefix: "tavi-artifacts-cli-" });

afterAll(() => directories.cleanup());

/** Seeds one pending artifact directly, releasing ownership before returning — mirrors a real tool dispatch's own write, without a real graph. */
async function seedPendingArtifact(directory: string, body: string): Promise<string> {
  const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: `seed-${process.pid}` });
  const store = await SqliteStore.open({ databasePath: `${directory}/tavi.sqlite`, artifactsDirectory: `${directory}/artifacts` });
  try {
    const record = store.putArtifact({ workspaceId: "default", contentType: "text/plain", body, reviewState: "pending" });
    return (await record).artifactId;
  } finally {
    store.close();
    ownership.release();
  }
}

describe("tavi artifacts", () => {
  it("lists pending artifacts, then approves one and rejects another", async () => {
    const directory = directories.create();
    const first = await seedPendingArtifact(directory, "screenshot bytes");
    const second = await seedPendingArtifact(directory, "archived output bytes");

    const listed = capture();
    const listCode = await main(["artifacts", "list", "--data-dir", directory], { io: listed.io });
    expect(listCode, listed.stderr()).toBe(EXIT.ok);
    expect(listed.stdout()).toContain(first);
    expect(listed.stdout()).toContain(second);

    const approved = capture();
    const approveCode = await main(["artifacts", "approve", first, "--data-dir", directory, "--reviewed-by", "alice"], { io: approved.io });
    expect(approveCode, approved.stderr()).toBe(EXIT.ok);
    const approvedRecord = JSON.parse(approved.stdout()) as { reviewState: string; reviewedBy: string };
    expect(approvedRecord).toMatchObject({ reviewState: "approved", reviewedBy: "alice" });

    const rejected = capture();
    const rejectCode = await main(["artifacts", "reject", second, "--data-dir", directory], { io: rejected.io });
    expect(rejectCode, rejected.stderr()).toBe(EXIT.ok);
    const rejectedRecord = JSON.parse(rejected.stdout()) as { reviewState: string; reviewedBy: string };
    expect(rejectedRecord).toMatchObject({ reviewState: "rejected", reviewedBy: "operator" });

    // Both are now decided — the pending queue is empty.
    const listedAgain = capture();
    const listAgainCode = await main(["artifacts", "list", "--data-dir", directory], { io: listedAgain.io });
    expect(listAgainCode, listedAgain.stderr()).toBe(EXIT.ok);
    expect(listedAgain.stdout()).toContain("no pending artifacts");
  });

  it("copies an approved download into its chat's downloads/ with no owner running, and a rejected one nowhere", async () => {
    const directory = directories.create();
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: `seed-${process.pid}` });
    const store = await SqliteStore.open({ databasePath: `${directory}/tavi.sqlite`, artifactsDirectory: `${directory}/artifacts` });
    let kept: string;
    let dropped: string;
    try {
      store.handle
        .prepare(
          "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at,origin) VALUES('chat-1','default','operator','thread-1','','waiting','2026-10-10T00:00:00.000Z','2026-10-10T00:00:00.000Z','ipc')",
        )
        .run();
      kept = (
        await store.putArtifact({
          workspaceId: "default",
          runId: "chat-1",
          contentType: "text/csv",
          body: "a,b\n",
          reviewState: "pending",
          fileName: "table.csv",
          folderCopy: "downloads",
        })
      ).artifactId;
      dropped = (
        await store.putArtifact({
          workspaceId: "default",
          runId: "chat-1",
          contentType: "text/csv",
          body: "c,d\n",
          reviewState: "pending",
          fileName: "other.csv",
          folderCopy: "downloads",
        })
      ).artifactId;
    } finally {
      await store.close();
      ownership.release();
    }
    const approved = capture();
    expect(await main(["artifacts", "approve", kept, "--data-dir", directory], { io: approved.io }), approved.stderr()).toBe(EXIT.ok);
    const rejected = capture();
    expect(await main(["artifacts", "reject", dropped, "--data-dir", directory], { io: rejected.io }), rejected.stderr()).toBe(EXIT.ok);
    const downloads = join(directory, "chats", "default", "chat-1", "downloads");
    expect(readdirSync(downloads)).toEqual(["table.csv"]);
    expect(readFileSync(join(downloads, "table.csv"), "utf8")).toBe("a,b\n");
    // Approving it again is refused as a second decision, but retries the copy first.
    rmSync(join(downloads, "table.csv"));
    const again = capture();
    expect(await main(["artifacts", "approve", kept, "--data-dir", directory], { io: again.io })).toBe(EXIT.usage);
    expect(again.stderr()).toMatch(/already has a terminal review state/);
    expect(readdirSync(downloads)).toEqual(["table.csv"]);
  });

  it("copies no approved download into a folder past its budget with no owner running, and the approval stands", async () => {
    const directory = directories.create();
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: `seed-${process.pid}` });
    const store = await SqliteStore.open({ databasePath: `${directory}/tavi.sqlite`, artifactsDirectory: `${directory}/artifacts` });
    let artifactId: string;
    try {
      store.handle
        .prepare(
          "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at,origin) VALUES('chat-1','default','operator','thread-1','','waiting','2026-10-10T00:00:00.000Z','2026-10-10T00:00:00.000Z','ipc')",
        )
        .run();
      artifactId = (
        await store.putArtifact({
          workspaceId: "default",
          runId: "chat-1",
          contentType: "text/csv",
          body: "a,b\n",
          reviewState: "pending",
          fileName: "table.csv",
          folderCopy: "downloads",
        })
      ).artifactId;
    } finally {
      await store.close();
      ownership.release();
    }
    // The chat's folder already holds its whole default budget (a sparse file: its size is what is counted).
    const managed = join(directory, "chats", "default", "chat-1");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "big.bin"), "");
    truncateSync(join(managed, "big.bin"), FOLDER_CAP_DEFAULT_BYTES);
    const approved = capture();
    expect(await main(["artifacts", "approve", artifactId, "--data-dir", directory], { io: approved.io }), approved.stderr()).toBe(EXIT.ok);
    expect(approved.stderr()).toMatch(/not copied.*its whole 2.0 GB budget \(tavi serve --folder-cap\)/s);
    expect(existsSync(join(managed, "downloads", "table.csv"))).toBe(false);
  });

  it("refuses a second decision on an already-decided artifact", async () => {
    const directory = directories.create();
    const artifactId = await seedPendingArtifact(directory, "bytes");

    const first = capture();
    expect(await main(["artifacts", "approve", artifactId, "--data-dir", directory], { io: first.io })).toBe(EXIT.ok);

    const second = capture();
    const secondCode = await main(["artifacts", "reject", artifactId, "--data-dir", directory], { io: second.io });
    expect(secondCode).toBe(EXIT.usage);
    expect(second.stderr()).toMatch(/already has a terminal review state/);
  });

  it("refuses approve/reject on an unknown artifact id", async () => {
    const directory = directories.create();
    const result = capture();
    const code = await main(["artifacts", "approve", "art-does-not-exist", "--data-dir", directory], { io: result.io });
    // Matches models/memory/skills' own NOT_FOUND -> EXIT.unavailable
    // convention: a missing named resource, not a malformed invocation.
    expect(code).toBe(EXIT.unavailable);
    expect(result.stderr()).toMatch(/No artifact art-does-not-exist/);
  });

  it("refuses approve/reject without an artifact id", async () => {
    const directory = directories.create();
    const result = capture();
    const code = await main(["artifacts", "approve", "--data-dir", directory], { io: result.io });
    expect(code).toBe(EXIT.usage);
    expect(result.stderr()).toMatch(/needs an artifact id/);
  });

  it("scopes list by workspace", async () => {
    const directory = directories.create();
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: `seed-${process.pid}` });
    const store = await SqliteStore.open({ databasePath: `${directory}/tavi.sqlite`, artifactsDirectory: `${directory}/artifacts` });
    let otherWorkspaceId: string;
    try {
      otherWorkspaceId = (
        await store.putArtifact({ workspaceId: "other-ws", contentType: "text/plain", body: "x", reviewState: "pending" })
      ).artifactId;
    } finally {
      store.close();
      ownership.release();
    }
    const defaultId = await seedPendingArtifact(directory, "y");

    const result = capture();
    const code = await main(["artifacts", "list", "--data-dir", directory], { io: result.io });
    expect(code, result.stderr()).toBe(EXIT.ok);
    expect(result.stdout()).toContain(defaultId);
    expect(result.stdout()).not.toContain(otherWorkspaceId);
  });

  it("refuses artifacts commands while an owner holds the data directory", async () => {
    const directory = directories.create();
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: `owner-${process.pid}` });
    try {
      const result = capture();
      const code = await main(["artifacts", "list", "--data-dir", directory], { io: result.io });
      // The exact code, matching bindings.test.ts/skills.test.ts/models.test.ts's
      // identical assertion — not just "not ok", which would have hidden
      // a real regression where this returned EXIT.usage instead.
      expect(code).toBe(EXIT.alreadyOwned);
      expect(result.stderr()).toMatch(/already owns/);
    } finally {
      ownership.release();
    }
  });

  it("list --limit truncates the pending queue", async () => {
    const directory = directories.create();
    await seedPendingArtifact(directory, "a");
    await seedPendingArtifact(directory, "b");
    await seedPendingArtifact(directory, "c");
    const result = capture();
    const code = await main(["artifacts", "list", "--data-dir", directory, "--limit", "2"], { io: result.io });
    expect(code, result.stderr()).toBe(EXIT.ok);
    expect(result.stdout().trim().split("\n")).toHaveLength(2);
  });

  it("list --format json renders a parseable array", async () => {
    const directory = directories.create();
    const id = await seedPendingArtifact(directory, "a");
    const result = capture();
    const code = await main(["artifacts", "list", "--data-dir", directory, "--format", "json"], { io: result.io });
    expect(code, result.stderr()).toBe(EXIT.ok);
    const rows = JSON.parse(result.stdout()) as { artifactId: string }[];
    expect(rows.map((row) => row.artifactId)).toContain(id);
  });

  it("refuses to decide an artifact belonging to a different workspace", async () => {
    const directory = directories.create();
    const artifactId = await seedPendingArtifact(directory, "a"); // seeded into "default"
    const result = capture();
    const code = await main(["artifacts", "approve", artifactId, "--workspace", "other-ws", "--data-dir", directory], { io: result.io });
    expect(code).toBe(EXIT.usage);
    expect(result.stderr()).toMatch(/belongs to workspace default/);
    // The decision was refused, not silently applied against the wrong workspace.
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: `check-${process.pid}` });
    const store = await SqliteStore.open({ databasePath: `${directory}/tavi.sqlite`, artifactsDirectory: `${directory}/artifacts` });
    try {
      expect((await store.getArtifact(artifactId))?.reviewState).toBe("pending");
    } finally {
      store.close();
      ownership.release();
    }
  });
});
