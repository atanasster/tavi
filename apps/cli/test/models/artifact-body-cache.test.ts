import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireDataDirectoryOwnership } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { startOpenAiStub } from "@tavi/test-support/openai-stub";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { SqliteStore } from "../support/database-fixture.js";
import { ArtifactBodyCache, artifactBodyWrite } from "../../src/features/models/artifact-body-cache.js";

/** The artifact bodies `runtime/models.ts` keeps between steps, and the writes that drop them. */

const bytes = (size: number, fill = 1) => new Uint8Array(size).fill(fill);

describe("ArtifactBodyCache", () => {
  it("reads a body once and serves it again only for the same sha256", async () => {
    const cache = new ArtifactBodyCache(1024);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return bytes(10, loads);
    };
    const first = await cache.read({ artifactId: "a", sha256: "h1" }, load);
    expect(await cache.read({ artifactId: "a", sha256: "h1" }, load)).toBe(first);
    expect(loads).toBe(1);
    expect(cache.bytes).toBe(10);
    // A record whose body changed is read again, and the stale body is dropped.
    const second = await cache.read({ artifactId: "a", sha256: "h2" }, load);
    expect(second?.[0]).toBe(2);
    expect(loads).toBe(2);
    expect(cache.bytes).toBe(10);
  });

  it("holds at most its byte budget, dropping the least recently read first, and never keeps a body over it", async () => {
    const cache = new ArtifactBodyCache(100);
    const loads: string[] = [];
    const read = async (artifactId: string, size: number) =>
      await cache.read({ artifactId, sha256: artifactId }, async () => {
        loads.push(artifactId);
        return bytes(size);
      });
    await read("a", 40);
    await read("b", 40);
    await read("a", 40); // a is now the most recent
    await read("c", 40); // over budget: b goes
    expect(cache.bytes).toBe(80);
    await read("a", 40);
    await read("b", 40);
    expect(loads).toEqual(["a", "b", "c", "b"]);
    await read("huge", 101);
    await read("huge", 101);
    expect(loads.filter((id) => id === "huge")).toHaveLength(2);
    expect(cache.bytes).toBeLessThanOrEqual(100);
  });

  it("drops what an erasure or prune took, and keeps no read one overtook", async () => {
    const cache = new ArtifactBodyCache(1024);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return bytes(4);
    };
    await cache.read({ artifactId: "a", sha256: "h" }, load);
    await cache.read({ artifactId: "b", sha256: "h" }, load);
    cache.delete(["a"]);
    expect(cache.bytes).toBe(4);
    await cache.read({ artifactId: "a", sha256: "h" }, load);
    expect(loads).toBe(3);
    cache.clear();
    expect(cache.bytes).toBe(0);
    let release: () => void = () => {};
    const slow = cache.read({ artifactId: "c", sha256: "h" }, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return bytes(4);
    });
    cache.delete(["c"]);
    release();
    expect((await slow)?.byteLength).toBe(4);
    expect(cache.bytes).toBe(0);
  });

  it("keeps no missing body", async () => {
    const cache = new ArtifactBodyCache(1024);
    expect(await cache.read({ artifactId: "gone", sha256: "h" }, async () => undefined)).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });
});

describe("artifactBodyWrite", () => {
  it("names the artifacts an erasure or review touched, and all of them for a prune", () => {
    expect(artifactBodyWrite("store.eraseArtifacts", [["a", "b"]])).toEqual({ kind: "artifacts", artifactIds: ["a", "b"] });
    expect(artifactBodyWrite("store.pruneArtifacts", [{ olderThan: "2026-01-01", dryRun: false }])).toEqual({ kind: "all" });
    expect(artifactBodyWrite("store.setReviewState", [{ artifactId: "a", reviewState: "rejected" }])).toEqual({
      kind: "artifacts",
      artifactIds: ["a"],
    });
    expect(artifactBodyWrite("repository.artifacts.setReviewState", [{ artifactId: "b" }])).toEqual({
      kind: "artifacts",
      artifactIds: ["b"],
    });
    // An input it cannot read drops everything rather than nothing.
    expect(artifactBodyWrite("store.eraseArtifacts", [])).toEqual({ kind: "all" });
    expect(artifactBodyWrite("store.getArtifact", ["a"])).toBeUndefined();
    expect(artifactBodyWrite("repository.artifacts.putArtifact", [{}])).toBeUndefined();
    // A chat erased, a video pruned, a sender forgotten: any of them may have taken a kept body.
    for (const operation of ["repository.transcripts.forget", "store.pruneVideo", "repository.channelMessages.forgetSender"])
      expect(artifactBodyWrite(operation, [{}])).toEqual({ kind: "all" });
    expect(artifactBodyWrite("repository.workspaceSettings.get", ["default"])).toBeUndefined();
  });
});

describe("an image a run was sent, through the composed runtime", () => {
  const directories = temporaryDirectories({ prefix: "tavi-artifact-body-" });
  afterEach(() => {
    directories.cleanup();
    delete process.env["TAVI_BASE_URL"];
    delete process.env["TAVI_API_KEY_FILE"];
  });

  it("is sent again on the next step while it stands, and not once it is erased", async () => {
    const directory = directories.create();
    const keyFile = join(directory, "api-key");
    writeFileSync(keyFile, "sk-local-probe\n", { mode: 0o600 });
    const storeOptions = { databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") };
    // A real header (a 1×1 PNG): a picture whose header names no size is never sent.
    const body = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 7]);
    const encoded = Buffer.from(body).toString("base64");
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: `seed-${process.pid}` });
    const seed = await SqliteStore.open(storeOptions);
    const { artifactId } = await seed.putArtifact({ workspaceId: "default", contentType: "image/png", body, reviewState: "approved" });
    await seed.close();
    ownership.release();
    const stub = await startOpenAiStub({
      reply: async (_request, turn) => {
        if (turn === 1) return { calls: [{ id: "call-1", name: "artifacts_view_image", arguments: { artifactId } }] };
        if (turn === 2) {
          // Erased between steps, by another client of the same database: the next step must not carry it.
          const other = await SqliteStore.open(storeOptions);
          await other.eraseArtifacts([artifactId]);
          await other.close();
          return { calls: [{ id: "call-2", name: "plan_update", arguments: { items: [{ text: "look", status: "done" }] } }] };
        }
        return { says: "done" };
      },
    });
    process.env["TAVI_BASE_URL"] = stub.baseUrl;
    process.env["TAVI_API_KEY_FILE"] = keyFile;
    try {
      const captured = capture();
      const code = await main(
        ["run", "Look at the image.", "--connection", "local", "--model", "gpt-4o", "--data-dir", directory, "--format", "json"],
        { io: captured.io },
      );
      expect(code, captured.stderr()).toBe(EXIT.ok);
      const completions = stub.requests.filter((request) => request.url.includes("/chat/completions"));
      expect(completions).toHaveLength(3);
      // Booleans, not the bodies: a failure would print the whole request.
      expect(completions.map((request) => request.raw.includes(encoded))).toEqual([false, true, false]);
    } finally {
      await stub.close();
    }
  });
});
