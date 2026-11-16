import { assertPositiveLimit } from "../values.js";
import {
  ARTIFACT_STAGING_DIRECTORY,
  TaviError,
  type ArtifactRecord,
  type ArtifactFold,
  type ArtifactPreview,
  type ArtifactFolderCopy,
  type ArtifactPurpose,
  type ArtifactReviewState,
  type ContentLabel,
} from "@tavi/contracts";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, readSync, renameSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, normalize, posix, resolve, sep } from "node:path";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import { flushDirectory, openNoFollowSync, prefixedId, sha256Hex, writeFileAtomic } from "@tavi/node-kit";
import type { StoreContext } from "./context.js";
import { storedLabelOf } from "./stored-values.js";

interface ArtifactRow {
  artifact_id: string;
  workspace_id: string;
  run_id: string | null;
  relative_path: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  review_state: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  purpose: string | null;
  untrusted: number;
  file_name: string | null;
  folder_copy: string | null;
  fold: string | null;
  preview: string | null;
  derived_from: string | null;
  label_json: string | null;
}

function toArtifactRecord(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.artifact_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    relativePath: row.relative_path,
    contentType: row.content_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    // `review_state` is `TEXT NOT NULL DEFAULT 'approved'` — always one of
    // `ARTIFACT_REVIEW_STATES`, written only by `putArtifact`/`setReviewState`
    // below, both of which only ever write a validated `ArtifactReviewState`.
    reviewState: row.review_state as ArtifactReviewState,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    ...(row.review_note === null ? {} : { reviewNote: row.review_note }),
    // `purpose` is CHECK-constrained to `ARTIFACT_PURPOSES`.
    ...(row.purpose === null ? {} : { purpose: row.purpose as ArtifactPurpose }),
    ...(row.untrusted === 1 ? { untrusted: true as const } : {}),
    ...(row.file_name === null ? {} : { fileName: row.file_name }),
    // `folder_copy` is CHECK-constrained to `ARTIFACT_FOLDER_COPIES`.
    ...(row.folder_copy === null ? {} : { folderCopy: row.folder_copy as ArtifactFolderCopy }),
    // `fold` is CHECK-constrained to `ARTIFACT_FOLDS`.
    ...(row.fold === null ? {} : { fold: row.fold as ArtifactFold }),
    // `preview` is CHECK-constrained to `ARTIFACT_PREVIEWS`.
    ...(row.preview === null ? {} : { preview: row.preview as ArtifactPreview }),
    ...(row.derived_from === null ? {} : { derivedFrom: row.derived_from }),
    // A stored label that does not parse reads as untrusted from an unknown source: it only narrows.
    ...(row.label_json === null ? {} : { label: storedLabelOf(row.label_json) }),
  };
}

/** A swept artifact a report row points at (its PDF, the deliverable): kept unless the caller overrides. */
const UNREFERENCED_BY_REPORTS = "a.artifact_id NOT IN (SELECT artifact_id FROM tavi_reports WHERE artifact_id IS NOT NULL)";

/**
 * Anything else another table points at, which no sweep deletes: a routine's
 * blob, a skill version's package, a mailbox envelope's attachment. One list
 * for every sweep, so a new referencing table is added once.
 */
const UNREFERENCED_ELSEWHERE = `a.artifact_id NOT IN (SELECT artifact_id FROM tavi_routine_blob_refs)
            AND a.artifact_id NOT IN (SELECT package_artifact_id FROM tavi_skill_versions)
            AND a.artifact_id NOT IN (SELECT artifact_id FROM tavi_agent_mailbox WHERE artifact_id IS NOT NULL)`;

/** What `putArtifact` and `putStagedArtifact` take besides the body. */
export type ArtifactPutFields = {
  readonly artifactId?: string | undefined;
  readonly workspaceId: string;
  readonly runId?: string | undefined;
  readonly contentType: string;
  readonly extension?: string | undefined;
  readonly reviewState?: ArtifactReviewState | undefined;
  readonly purpose?: ArtifactPurpose | undefined;
  readonly untrusted?: boolean | undefined;
  readonly fileName?: string | undefined;
  readonly folderCopy?: ArtifactFolderCopy | undefined;
  readonly fold?: ArtifactFold | undefined;
  readonly preview?: ArtifactPreview | undefined;
  readonly derivedFrom?: string | undefined;
  readonly label?: ContentLabel | undefined;
  readonly reviewedBy?: string | undefined;
};

/** Bound a stored payload so an admission record cannot grow without limit. */
/** Filesystem-safe single path segment. */
function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "workspace";
}

/**
 * Publish an artifact body, then commit its metadata reference.
 *
 * The body is written before the row so a reader can never see a reference
 * without its bytes; the cost is that a failed insert leaves an unreferenced
 * file, a known cost rather than an accident.
 */
export function putArtifact(store: StoreContext, input: ArtifactPutFields & { readonly body: string | Uint8Array }): ArtifactRecord {
  const bytes = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
  return putArtifactContent(store, input, {
    sha256: sha256Hex(bytes),
    byteSize: bytes.byteLength,
    place: (absolute) => writeFileAtomic(absolute, bytes, { durable: true }),
  });
}

/** `<artifacts>/.staging`: where a caller writes a large body before `putStagedArtifact` takes it. */
export function artifactStagingDirectory(store: StoreContext): string {
  if (store.artifactsDirectory === "") throw new TaviError("UNSUPPORTED", "No artifacts directory is configured for this store");
  return join(resolve(store.artifactsDirectory), ARTIFACT_STAGING_DIRECTORY);
}

/**
 * Publish a body a caller wrote to a file in the store's staging directory:
 * the store reads it to hash it
 * and measure it itself, as `putArtifact` hashes what it is given, and
 * moves it into place on the same volume, fsynced before its row. A path
 * anywhere else is refused and left alone; a link, a non-file, or a file
 * with another name for it is refused and removed. A staged file is gone
 * after, taken or not.
 */
export function putStagedArtifact(store: StoreContext, input: ArtifactPutFields & { readonly stagedPath: string }): ArtifactRecord {
  const staging = artifactStagingDirectory(store);
  const path = resolve(input.stagedPath);
  // Anything elsewhere is left as it is: the store never removes a file it was not handed in its staging directory.
  if (dirname(path) !== staging) throw new TaviError("INVALID_INPUT", "A staged artifact is taken only from the store's staging directory");
  // lstat: the staging directory itself is no link (the volume above it is the owner's choice).
  if (!lstatSync(staging).isDirectory()) throw new TaviError("INVALID_INPUT", "The store's staging directory is not a plain directory");
  // Moved first to a name of the store's own, outside staging, so the file hashed is the file placed.
  const taking = join(dirname(staging), `.taking-${randomUUID()}`);
  let moved = false;
  let taken = false;
  try {
    let staged;
    try {
      staged = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TaviError("INVALID_INPUT", "The staged artifact is not there");
      throw error;
    }
    // A link, a directory or a FIFO is never opened: a FIFO would block the store.
    if (!staged.isFile()) throw new TaviError("INVALID_INPUT", "A staged artifact must be a plain file, not a link");
    renameSync(path, taking);
    moved = true;
    const fd = openNoFollowSync(taking, "read");
    let sha256: string;
    let byteSize: number;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new TaviError("INVALID_INPUT", "A staged artifact must be a plain file with one name");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1024 * 1024);
      byteSize = 0;
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, byteSize);
        if (read === 0) break;
        hash.update(buffer.subarray(0, read));
        byteSize += read;
      }
      sha256 = hash.digest("hex");
      // On disk before its row commits, as `putArtifact`'s bytes are.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return putArtifactContent(store, input, {
      sha256,
      byteSize,
      place: (absolute) => {
        renameSync(taking, absolute);
        taken = true;
        flushDirectory(dirname(absolute));
      },
    });
  } finally {
    // Taken or refused, nothing is left: neither the staged file nor the store's own name for it.
    if (!taken) {
      try {
        rmSync(moved ? taking : path, { recursive: true, force: true });
      } catch {
        // Best effort: the owner clears staging at its next start; the error that stopped the put stands.
      }
    }
  }
}

function putArtifactContent(
  store: StoreContext,
  input: ArtifactPutFields,
  content: { readonly sha256: string; readonly byteSize: number; readonly place: (absolute: string) => void },
): ArtifactRecord {
  if (
    input.derivedFrom !== undefined &&
    (input.preview === undefined || input.derivedFrom.length === 0 || input.derivedFrom.length > 200)
  ) {
    throw new TaviError("INVALID_INPUT", "A source is recorded only for a preview");
  }
  if (input.reviewedBy !== undefined && (input.reviewState === undefined || input.reviewState === "pending")) {
    throw new TaviError("INVALID_INPUT", "A reviewer is recorded only with a decided review state");
  }
  const artifactId = input.artifactId ?? prefixedId("art");
  if (!/^art-[a-zA-Z0-9_-]{1,128}$/.test(artifactId)) throw new TaviError("INVALID_INPUT", "Invalid artifact publication identity");
  const extension = (input.extension ?? "bin").replace(/[^a-z0-9]/gi, "");
  // POSIX separators whatever the platform, so a backup restores on any.
  const relativePath = posix.join(safeSegment(input.workspaceId), `${artifactId}.${extension}`);
  const sha256 = content.sha256;
  const existing = getArtifact(store, artifactId);
  if (existing !== undefined) {
    if (
      existing.workspaceId !== input.workspaceId ||
      existing.runId !== (input.runId ?? null) ||
      existing.contentType !== input.contentType ||
      existing.sha256 !== sha256 ||
      existing.relativePath !== relativePath ||
      existing.purpose !== input.purpose ||
      (existing.untrusted === true) !== (input.untrusted === true) ||
      existing.fileName !== input.fileName ||
      existing.folderCopy !== input.folderCopy ||
      existing.fold !== input.fold ||
      existing.preview !== input.preview ||
      existing.derivedFrom !== input.derivedFrom
    ) {
      throw new TaviError("CONFLICT", "Artifact identity already names a different publication", { details: { artifactId } });
    }
    return existing;
  }
  const absolute = resolveArtifactPath(store, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  content.place(absolute);

  // Kept in canonical form; one the schema refuses is stored as untrusted from an unknown source (it only narrows).
  const label = input.label === undefined ? undefined : storedLabelOf(JSON.stringify(input.label));
  const record: ArtifactRecord = {
    artifactId,
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    relativePath,
    contentType: input.contentType,
    byteSize: content.byteSize,
    sha256,
    reviewState: input.reviewState ?? "approved",
    reviewedBy: input.reviewedBy ?? null,
    reviewedAt: input.reviewedBy === undefined ? null : nowTimestamp(),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    ...(input.untrusted === true ? { untrusted: true as const } : {}),
    ...definedOnly({
      fileName: input.fileName,
      folderCopy: input.folderCopy,
      fold: input.fold,
      preview: input.preview,
      derivedFrom: input.derivedFrom,
      label,
    }),
  };
  store.handle
    .prepare(
      `INSERT INTO tavi_artifacts
         (artifact_id, workspace_id, run_id, relative_path, content_type, byte_size, sha256, created_at, review_state, reviewed_by, reviewed_at, purpose, untrusted, file_name, folder_copy, fold, preview, derived_from, label_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.artifactId,
      record.workspaceId,
      record.runId,
      record.relativePath,
      record.contentType,
      record.byteSize,
      record.sha256,
      nowTimestamp(),
      record.reviewState,
      record.reviewedBy,
      record.reviewedAt,
      input.purpose ?? null,
      input.untrusted === true ? 1 : 0,
      input.fileName ?? null,
      input.folderCopy ?? null,
      input.fold ?? null,
      input.preview ?? null,
      input.derivedFrom ?? null,
      label === undefined ? null : JSON.stringify(label),
    );
  return record;
}

export function getArtifact(store: StoreContext, artifactId: string): ArtifactRecord | undefined {
  const row = store.handle.prepare("SELECT * FROM tavi_artifacts WHERE artifact_id = ?").get(artifactId) as ArtifactRow | undefined;
  if (row === undefined) return undefined;
  return toArtifactRecord(row);
}

/**
 * The artifact's bytes, or `undefined` when either the row or the *file* is
 * absent.
 *
 * The declared return type already said `undefined`, and the metadata and the
 * bytes are separate durability boundaries (see the publication protocol): a
 * restore without artifacts leaves rows whose bodies are gone. Throwing `ENOENT`
 * made that legitimate state look like a crash and left every caller to
 * translate it; returning `undefined` lets each of them say what it means
 * (`artifact_unavailable` for delivery, "missing or damaged" for a download).
 */
export function readArtifactBody(store: StoreContext, artifactId: string): Uint8Array | undefined {
  const record = getArtifact(store, artifactId);
  if (record === undefined) return undefined;
  try {
    return readFileSync(resolveArtifactPath(store, record.relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Delete artifacts older than a cutoff, with their bodies.
 *
 * `tavi_prune`'s transport sweep deliberately left this alone, because an
 * approved report PDF is the deliverable; what accumulates without bound are the
 * *other* artifacts — a screenshot per `browser.capture`, a download per
 * `browser.act`, an archived tool output per oversized read. So the rule is:
 * never a `pending` artifact (it is an undecided review item, and deleting it
 * would silently answer the question it exists to ask), never one that a
 * `tavi_reports` row references (that *is* the delivered brief), and only past
 * the window. `includeReports` is the operator's explicit override.
 *
 * The body is unlinked before the row, mirroring `putArtifact`'s ordering
 * concern in reverse: a row without its bytes would make `reports open` fail
 * with an I/O error rather than a clear refusal.
 */
export function pruneArtifacts(
  store: StoreContext,
  input: {
    readonly olderThan: string;
    readonly dryRun: boolean;
    readonly includeReports?: boolean;
  },
): { readonly artifacts: number; readonly bytes: number } {
  const rows = store.handle
    .prepare(
      `SELECT a.artifact_id, a.relative_path, a.byte_size FROM tavi_artifacts a
        WHERE a.created_at < @olderThan
          AND a.review_state <> 'pending'
          -- Anything another table still points at: a report row's PDF (the
          -- deliverable, unless the caller explicitly overrides), a skill
          -- version's package and a mailbox envelope's attachment. Those are
          -- real foreign keys, so deleting the row would fail anyway — and
          -- because the body was unlinked first, the failure left the row
          -- pointing at a file that no longer existed.
          AND (@includeReports = 1 OR ${UNREFERENCED_BY_REPORTS})
          AND ${UNREFERENCED_ELSEWHERE}`,
    )
    .all({ olderThan: input.olderThan, includeReports: input.includeReports === true ? 1 : 0 }) as {
    readonly artifact_id: string;
    readonly relative_path: string;
    readonly byte_size: number;
  }[];
  if (input.dryRun) {
    return { artifacts: rows.length, bytes: rows.reduce((sum, row) => sum + row.byte_size, 0) };
  }
  return deleteArtifactRows(store, rows);
}

/** Deletes swept artifacts, rows then bodies, in one transaction: `pruneArtifacts`'s and `pruneVideo`'s one way. */
function deleteArtifactRows(
  store: StoreContext,
  rows: readonly { readonly artifact_id: string; readonly relative_path: string; readonly byte_size: number }[],
): { readonly artifacts: number; readonly bytes: number } {
  let bytes = 0;
  let deleted = 0;
  store.transaction(() => {
    for (const row of rows) {
      // The row first: if a foreign key still references it (a table this
      // predicate does not know about yet), the delete throws, the transaction
      // rolls back and the *body is still there* — the reverse order leaves a
      // row pointing at a file that is already gone.
      store.handle.prepare("DELETE FROM tavi_artifacts WHERE artifact_id = ?").run(row.artifact_id);
      try {
        // Through the store's own resolver, so an escaped relative path is
        // refused rather than followed — the same rule every read uses.
        rmSync(resolveArtifactPath(store, row.relative_path), { force: true });
      } catch {
        // The row is gone; an unreadable or already-absent body must not stop
        // the sweep.
      }
      deleted += 1;
      bytes += row.byte_size;
    }
  });
  return { artifacts: deleted, bytes };
}

/** See `ArtifactRepositoryPort.derivedPreviewExists`. */
export function derivedPreviewExists(store: StoreContext, workspaceId: string, source: string): boolean {
  return (
    store.handle
      .prepare("SELECT 1 FROM tavi_artifacts WHERE derived_from = ? AND workspace_id = ? AND preview IS NOT NULL LIMIT 1")
      .get(source, workspaceId) !== undefined
  );
}

/**
 * A workspace's videos taken from outside (a channel's attachment, an
 * upload: untrusted, `video/*`, not a preview), older than `olderThan`,
 * pruned with their bodies: by the
 * retention sweep whatever `retentionSweepArtifacts` says, since "kept 30
 * days" must not mean forever. Never one still pending review, nor one
 * another table points at, as `pruneArtifacts` keeps; the frames and
 * sheets made from it stay with their chat.
 */
export function pruneVideo(
  store: StoreContext,
  input: { readonly workspaceId: string; readonly olderThan: string },
): { readonly artifacts: number; readonly bytes: number } {
  const rows = store.handle
    .prepare(`SELECT a.artifact_id, a.relative_path, a.byte_size FROM tavi_artifacts a
      WHERE a.workspace_id = @workspaceId AND a.created_at < @olderThan AND a.untrusted = 1 AND a.content_type LIKE 'video/%' AND a.preview IS NULL
        AND a.review_state <> 'pending'
        AND ${UNREFERENCED_BY_REPORTS}
        AND ${UNREFERENCED_ELSEWHERE}`)
    .all(input) as { readonly artifact_id: string; readonly relative_path: string; readonly byte_size: number }[];
  return deleteArtifactRows(store, rows);
}

/**
 * Erases the named artifacts, rows and bodies, whatever their age or review
 * (a removed channel's media, a forgotten sender's): never one
 * another table still points at, as `pruneArtifacts` keeps. Answers how many
 * went, and their bytes. Idempotent: an id already gone is passed over.
 */
export function eraseArtifacts(
  store: StoreContext,
  artifactIds: readonly string[],
): { readonly artifacts: number; readonly bytes: number } {
  let bytes = 0;
  let deleted = 0;
  store.transaction(() => {
    for (const artifactId of artifactIds) {
      const row = store.handle
        .prepare(`SELECT a.relative_path, a.byte_size FROM tavi_artifacts a
        WHERE a.artifact_id = ?
          AND a.artifact_id NOT IN (SELECT artifact_id FROM tavi_reports WHERE artifact_id IS NOT NULL)
          AND a.artifact_id NOT IN (SELECT artifact_id FROM tavi_routine_blob_refs)
          AND a.artifact_id NOT IN (SELECT package_artifact_id FROM tavi_skill_versions)
          AND a.artifact_id NOT IN (SELECT artifact_id FROM tavi_agent_mailbox WHERE artifact_id IS NOT NULL)`)
        .get(artifactId) as { readonly relative_path: string; readonly byte_size: number } | undefined;
      if (row === undefined) continue;
      // The row first, as `pruneArtifacts` does: a body is never left without its row's refusal to explain it.
      store.handle.prepare("DELETE FROM tavi_artifacts WHERE artifact_id = ?").run(artifactId);
      try {
        rmSync(resolveArtifactPath(store, row.relative_path), { force: true });
      } catch {
        // The row is gone; an unreadable or absent body does not stop the rest.
      }
      deleted += 1;
      bytes += row.byte_size;
    }
  });
  return { artifacts: deleted, bytes };
}

/** Artifacts still `pending` review, oldest first — the operator-facing review queue (`tavi artifacts list --pending`). */
export function listPendingReview(store: StoreContext, workspaceId: string, limit: number): readonly ArtifactRecord[] {
  // SQLite reads a negative `LIMIT` as "no limit" — this guard is what
  // makes that impossible here, matching `listTasks`'s identical
  // precedent immediately below and every other bounded listing in this
  // file.
  assertPositiveLimit(limit, "listPendingReview");
  const rows = store.handle
    .prepare(`SELECT * FROM tavi_artifacts WHERE workspace_id = ? AND review_state = 'pending' ORDER BY created_at ASC LIMIT ?`)
    .all(workspaceId, limit) as ArtifactRow[];
  return rows.map(toArtifactRecord);
}

/**
 * Transition a `pending` artifact to a terminal review state.
 *
 * A genuine compare-and-set (`transactionImmediate`, not the default
 * deferred `transaction`, for the same reason as
 * `SqliteMessagingIdentityBindingRepository.bind`: two concurrent decisions on the same artifact must not
 * both observe "still pending" before either writes) — refuses a call
 * against an artifact that is no longer `pending`, so a decision is
 * never silently overwritten by a second one.
 */
export function claimUploadForRun(store: StoreContext, input: { readonly artifactId: string; readonly runId: string }): void {
  store.handle
    .prepare(
      "UPDATE tavi_artifacts SET run_id = ? WHERE artifact_id = ? AND run_id IS NULL AND untrusted = 1 AND artifact_id LIKE 'art-up-%'",
    )
    .run(input.runId, input.artifactId);
}

export function setReviewState(
  store: StoreContext,
  input: {
    readonly artifactId: string;
    readonly reviewState: "approved" | "rejected";
    readonly reviewedBy: string;
    readonly reviewedAt: string;
    readonly note?: string;
  },
): void {
  store.transactionImmediate(() => {
    const existing = getArtifact(store, input.artifactId);
    if (existing === undefined) {
      throw new TaviError("NOT_FOUND", `No artifact ${input.artifactId}`);
    }
    if (existing.reviewState !== "pending") {
      throw new TaviError("CONFLICT", `Artifact ${input.artifactId} already has a terminal review state (${existing.reviewState})`);
    }
    // `AND review_state = 'pending'` is defense-in-depth, not the
    // primary guard: `transactionImmediate` already serializes the read
    // above against any concurrent writer, so this can never actually
    // filter out a row in practice — but it keeps the UPDATE itself a
    // true compare-and-set rather than depending solely on the
    // surrounding transaction boundary staying correct under a future
    // refactor.
    store.handle
      .prepare(
        `UPDATE tavi_artifacts SET review_state = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? ` +
          `WHERE artifact_id = ? AND review_state = 'pending'`,
      )
      .run(input.reviewState, input.reviewedBy, input.reviewedAt, input.note ?? null, input.artifactId);
  });
}

/** Resolve a stored relative path, refusing to escape the artifacts directory. */
export function resolveArtifactPath(store: StoreContext, relativePath: string): string {
  if (store.artifactsDirectory === "") {
    throw new TaviError("UNSUPPORTED", "No artifacts directory is configured for this store");
  }
  const root = resolve(store.artifactsDirectory);
  const candidate = resolve(root, normalize(relativePath));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new TaviError("INVALID_INPUT", "Artifact path escapes the artifacts directory", {
      details: { relativePath },
    });
  }
  return candidate;
}
