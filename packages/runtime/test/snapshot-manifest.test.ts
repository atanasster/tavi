import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { readSnapshotManifest, snapshotBytes } from "../src/persistence/snapshot-files.js";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

const MANIFEST = {
  createdAt: "2026-10-22T09:00:00.000Z",
  buildId: "test",
  dataDirectory: "/data",
  applicationTables: ["tavi_meta"],
  migrations: ["0001"],
  rowCounts: { tavi_meta: 1 },
  saverSchemaVersion: null,
  includes: { artifacts: false, credentials: false, chats: true },
  excluded: ["logs/"],
};

it("reads a Tavi manifest, and none for a bare database copy", () => {
  const directory = directories.create("tavi-manifest-");
  expect(readSnapshotManifest(directory)).toBeNull();
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ ...MANIFEST, futureField: 1 }));
  expect(readSnapshotManifest(directory)).toMatchObject({ buildId: "test", includes: { chats: true } });
});

it("refuses a manifest that is not JSON, or not a Tavi manifest, as INVALID_INPUT", () => {
  const directory = directories.create("tavi-manifest-");
  writeFileSync(join(directory, "manifest.json"), "{ truncated");
  expect(() => readSnapshotManifest(directory)).toThrowError(
    expect.objectContaining({ code: "INVALID_INPUT", message: "the snapshot manifest is not valid JSON" }),
  );
  for (const foreign of [{}, null, [], { ...MANIFEST, includes: undefined }, { ...MANIFEST, includes: { artifacts: "yes" } }]) {
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(foreign));
    expect(() => readSnapshotManifest(directory)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT", message: "the snapshot manifest is not a Tavi manifest" }),
    );
  }
});

it("counts a snapshot's bytes on disk, nested directories included", () => {
  const directory = directories.create("tavi-manifest-");
  writeFileSync(join(directory, "a"), "12345");
  mkdirSync(join(directory, "chats"));
  writeFileSync(join(directory, "chats", "b"), "123");
  expect(snapshotBytes(directory)).toBe(8);
});
