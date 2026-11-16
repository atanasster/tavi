/**
 * A directory snapshot's own files, read without SQLite: its manifest, checked
 * against a schema because a snapshot being restored may come from another
 * machine or build, and its size on disk for the operator's summary. Light, so
 * the CLI reads a manifest without loading the persistence worker.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TaviError, parseOrThrow } from "@tavi/contracts";
import { z } from "zod";

/** Files in a directory snapshot, relative to the snapshot root. */
export const SNAPSHOT_DATABASE = "tavi.sqlite";
export const SNAPSHOT_MANIFEST = "manifest.json";

const SnapshotManifestSchema = z.object({
  profileFormat: z.string().optional(),
  createdAt: z.string(),
  buildId: z.string(),
  dataDirectory: z.string(),
  applicationTables: z.array(z.string()).readonly(),
  migrations: z.array(z.string()).readonly(),
  rowCounts: z.record(z.string(), z.number()).readonly(),
  saverSchemaVersion: z.string().nullable(),
  /** What the snapshot carries besides the database. */
  includes: z
    .object({
      artifacts: z.boolean(),
      credentials: z.boolean(),
      /** Installed plugin snapshots; absent is not carried. */
      plugins: z.boolean().optional(),
      webProviders: z.boolean().optional(),
      /** The chats' working folders; absent is not carried. */
      chats: z.boolean().optional(),
    })
    .readonly(),
  /** What it deliberately does not carry, so a restore is not read as complete. */
  excluded: z.array(z.string()).readonly(),
});

export type SnapshotManifest = Readonly<z.output<typeof SnapshotManifestSchema>>;

/**
 * Read a snapshot's manifest, or `null` when it has none (a bare database
 * copy). A manifest that is not JSON, or not a Tavi manifest, is refused as
 * `INVALID_INPUT` rather than failing later on a missing field.
 */
export function readSnapshotManifest(snapshotDirectory: string): SnapshotManifest | null {
  const path = join(snapshotDirectory, SNAPSHOT_MANIFEST);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new TaviError("INVALID_INPUT", "the snapshot manifest is not valid JSON", { details: { path: SNAPSHOT_MANIFEST } });
  }
  return parseOrThrow(SnapshotManifestSchema, raw, "the snapshot manifest is not a Tavi manifest", {
    details: { path: SNAPSHOT_MANIFEST },
  });
}

/** Bytes on disk of a snapshot directory, for the operator-facing summary. */
export function snapshotBytes(directory: string): number {
  let total = 0;
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      // `withFileTypes` reports a symlink as a symlink rather than following it,
      // and a link's own size is all a copy of it occupies.
      if (entry.isDirectory()) walk(child);
      else total += lstatSync(child).size;
    }
  };
  walk(directory);
  return total;
}
