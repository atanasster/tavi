import { expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

it("pages artifact metadata, scopes before limiting, and looks up decided IDs without content", () => {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  try {
    const insert = store.handle.prepare(
      "INSERT INTO tavi_artifacts(artifact_id,workspace_id,run_id,relative_path,content_type,byte_size,sha256,created_at,review_state) VALUES(?,?,?,'private/path','text/plain',42,'private-hash','2026-01-01T00:00:00.000Z',?)",
    );
    for (let i = 0; i < 105; i++) insert.run(`a${String(i).padStart(3, "0")}`, "default", "task", "pending");
    insert.run("foreign", "other", "task", "pending");
    insert.run("decided", "default", "task", "approved");
    const first = store.listArtifacts({ workspaceId: "default", taskId: "task", limit: 100 });
    const second = store.listArtifacts({ workspaceId: "default", taskId: "task", limit: 100, cursor: first.nextCursor! });
    expect(first.rows).toHaveLength(100);
    expect(second.rows).toHaveLength(5);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.artifactId)).size).toBe(105);
    expect(() => store.listArtifacts({ workspaceId: "other", limit: 100, cursor: first.nextCursor! })).toThrow(/cursor/);
    const lookup = store.listArtifacts({ workspaceId: "default", taskId: "task", artifactIds: ["decided", "foreign"], limit: 100 });
    const all = store.listArtifacts({ workspaceId: "default", taskId: "task", includeDecided: true, limit: 100 });
    expect(() =>
      store.listArtifacts({ workspaceId: "default", taskId: "task", includeDecided: true, limit: 100, cursor: first.nextCursor! }),
    ).toThrow(/cursor/);
    const tail = store.listArtifacts({ workspaceId: "default", taskId: "task", includeDecided: true, limit: 100, cursor: all.nextCursor! });
    expect(tail.rows.some((row) => row.artifactId === "decided")).toBe(true);
    expect(lookup.rows).toEqual([
      { artifactId: "decided", workspaceId: "default", runId: "task", contentType: "text/plain", byteSize: 42, reviewState: "approved" },
    ]);
    // A file's own name, where it has one: what the review card calls it.
    store.handle.prepare("UPDATE tavi_artifacts SET file_name = 'bill-2026-10.pdf' WHERE artifact_id = 'decided'").run();
    expect(store.listArtifacts({ workspaceId: "default", taskId: "task", artifactIds: ["decided"], limit: 100 }).rows[0]).toMatchObject({
      fileName: "bill-2026-10.pdf",
    });
    expect(() => store.listArtifacts({ workspaceId: "default", limit: -1 })).toThrow();
  } finally {
    store.close();
  }
});
