import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import {
  ATTACHMENT_UPLOAD_CHUNK_CHARS,
  TaviError,
  UPLOAD_CONTENT_TYPES,
  VIDEO_SNIFF_BYTES,
  folderFileName,
  untrustedLabel,
  uploadMaxBytes,
  type ArtifactRepositoryPort,
  type ArtifactUploadAnswer,
  type ArtifactsUploadPayload,
  type UploadContentType,
} from "@tavi/contracts";
import { sniffMediaType } from "@tavi/runtime";

import type { IpcAnswer } from "../../shared/ipc-decisions.js";

/**
 * `artifacts upload`: a PDF,
 * a video or an animated GIF the person attaches in the web UI, taken in
 * chunk by chunk, in order, and kept as a channel attachment is: an approved,
 * untrusted artifact labelled `attachment`. What it is is read from its first
 * piece's bytes, never its name: that type's tools must be on and the file
 * within that type's cap. The pieces are appended to a `0600` file in the
 * store's staging directory, on the artifacts' own volume, and the store
 * takes the file whole: an upload is never held in the owner's memory.
 */

/** Uploads one connection may have under way at once; a further one drops the oldest. */
const UPLOADS_PER_CONNECTION = 4;

interface Staged {
  readonly name: string;
  readonly size: number;
  readonly contentType: UploadContentType;
  /** The staging file and its descriptor, written at `received`. */
  readonly path: string;
  /** Undefined once closed: a descriptor is never closed twice, since its number may be another file's by then. */
  fd: number | undefined;
  received: number;
  /** Where each later piece is decoded: one buffer for the upload, never one per piece. */
  readonly scratch: Buffer;
}

/** One connection's uploads under way, by the client's upload id: dropped, their files removed, when the connection closes. */
export class AttachmentUploads {
  readonly #staged = new Map<string, Staged>();

  get(uploadId: string): Staged | undefined {
    return this.#staged.get(uploadId);
  }

  start(uploadId: string, staged: Staged): void {
    this.drop(uploadId);
    this.#staged.set(uploadId, staged);
    if (this.#staged.size > UPLOADS_PER_CONNECTION) {
      const oldest = this.#staged.keys().next().value;
      if (oldest !== undefined) this.drop(oldest);
    }
  }

  /** Forgets an upload; its staging file goes too unless the store has taken it. */
  drop(uploadId: string): void {
    const staged = this.#staged.get(uploadId);
    if (staged === undefined) return;
    this.#staged.delete(uploadId);
    if (staged.fd !== undefined) closeSync(staged.fd);
    staged.fd = undefined;
    rmSync(staged.path, { force: true });
  }

  clear(): void {
    for (const uploadId of [...this.#staged.keys()]) this.drop(uploadId);
  }
}

export interface UploadCommandDependencies {
  readonly artifacts: Required<Pick<ArtifactRepositoryPort, "putStagedArtifact">>;
  /** The store's staging directory (`<data>/artifacts/.staging`), where pieces are written. */
  readonly stagingDirectory: string;
  /** The operator principal a workspace is served for, or undefined for one this owner does not serve. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly now: () => string;
  /** `pdf.enabled` for a workspace: with the PDF tools off, nothing could read an uploaded PDF, so none is taken. */
  readonly pdfEnabled?: (workspaceId: string) => Promise<boolean>;
  /** `video.enabled` for a workspace, and whether the video tools are offered here at all: else no video or GIF is taken. */
  readonly videoEnabled?: (workspaceId: string) => Promise<boolean>;
  /** This connection's uploads; none without a connection, which cannot upload. */
  readonly uploads: AttachmentUploads | undefined;
  /**
   * The owner's free-space floor, checked before a staging file is made: its pieces land on the
   * volume `tavi.sqlite` shares long before the store's own check at the final put.
   */
  readonly checkSpace?: () => void;
}

const EXTENSIONS: Readonly<Record<UploadContentType, string>> = {
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/gif": "gif",
};

/** What an upload's bytes are, of the types it may be; undefined for anything else. */
function uploadTypeOf(bytes: Uint8Array): UploadContentType | undefined {
  const sniffed = sniffMediaType(bytes.subarray(0, VIDEO_SNIFF_BYTES));
  return (UPLOAD_CONTENT_TYPES as readonly string[]).includes(sniffed ?? "") ? (sniffed as UploadContentType) : undefined;
}

/** The staged file's head, as the store will see it: what the whole is, checked again once the last piece is in. */
function stagedHead(fd: number): Uint8Array {
  const head = Buffer.alloc(VIDEO_SNIFF_BYTES);
  const read = readSync(fd, head, 0, head.length, 0);
  return head.subarray(0, read);
}

export async function artifactsUploadCommand(
  deps: UploadCommandDependencies,
  payload: ArtifactsUploadPayload,
): Promise<IpcAnswer<ArtifactUploadAnswer>> {
  // The first piece is decoded to be sniffed; each later one into its upload's own scratch buffer.
  let bytes: Buffer = payload.offset === 0 ? Buffer.from(payload.data, "base64") : Buffer.alloc(0);
  try {
    const principal = deps.principalOf(payload.workspaceId);
    if (principal === undefined) throw new TaviError("NOT_FOUND", `workspace ${payload.workspaceId} is not configured on this owner`);
    const uploads = deps.uploads;
    if (uploads === undefined) throw new TaviError("UNSUPPORTED", "Uploads need a connection");
    if (payload.offset === 0) {
      uploads.drop(payload.uploadId);
      // What the bytes are, not what the name says: a renamed file is refused at its first piece.
      const contentType = uploadTypeOf(bytes);
      if (contentType === undefined)
        throw new TaviError("INVALID_INPUT", `${payload.name} is not a PDF, a video (MP4, MOV, WebM) or a GIF`);
      // Only the tools that read this type are asked about: a video is taken with the PDF tools off, and so on.
      if (contentType === "application/pdf" && deps.pdfEnabled !== undefined && !(await deps.pdfEnabled(payload.workspaceId)))
        throw new TaviError("UNSUPPORTED", "the PDF tools are off in this workspace (`tavi config set pdf.enabled on`)");
      if (contentType !== "application/pdf" && deps.videoEnabled !== undefined && !(await deps.videoEnabled(payload.workspaceId)))
        throw new TaviError(
          "UNSUPPORTED",
          "the video tools are off in this workspace, or FFmpeg is not installed (`tavi config set video.enabled on`, `tavi doctor`)",
        );
      const cap = uploadMaxBytes(contentType);
      if (payload.size > cap)
        throw new TaviError(
          "INVALID_INPUT",
          `${payload.name}: ${contentType === "application/pdf" ? "a PDF" : "a video or GIF"} is at most ${String(cap / 1024 / 1024)} MiB`,
        );
      deps.checkSpace?.();
      mkdirSync(deps.stagingDirectory, { recursive: true, mode: 0o700 });
      // A link there would send the pieces elsewhere: refused before anything is written (the store refuses it too).
      if (!lstatSync(deps.stagingDirectory).isDirectory())
        throw new TaviError("INTERNAL", "the artifact staging directory is not a directory");
      chmodSync(deps.stagingDirectory, 0o700);
      const path = join(deps.stagingDirectory, `upload-${randomBytes(16).toString("hex")}`);
      const fd = openSync(path, "wx+", 0o600);
      uploads.start(payload.uploadId, {
        name: payload.name,
        size: payload.size,
        contentType,
        path,
        fd,
        received: 0,
        scratch: Buffer.alloc(Math.ceil(ATTACHMENT_UPLOAD_CHUNK_CHARS / 4) * 3),
      });
    }
    const staged = uploads.get(payload.uploadId);
    // Chunks in order from offset 0, each the same file; anything else starts over.
    if (
      staged === undefined ||
      staged.fd === undefined ||
      staged.received !== payload.offset ||
      staged.name !== payload.name ||
      staged.size !== payload.size
    ) {
      uploads.drop(payload.uploadId);
      throw new TaviError("INVALID_INPUT", "The upload's pieces came out of order; attach the file again");
    }
    if (payload.offset > 0) bytes = staged.scratch.subarray(0, staged.scratch.write(payload.data, "base64"));
    if (staged.received + bytes.length > staged.size) {
      uploads.drop(payload.uploadId);
      throw new TaviError("INVALID_INPUT", "The upload ran past the size it declared; attach the file again");
    }
    let written = 0;
    const fd = staged.fd;
    try {
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, staged.received + written);
    } catch (error) {
      // A piece that could not be written (the volume full) ends the upload: its descriptor and file go now.
      uploads.drop(payload.uploadId);
      throw error;
    }
    staged.received += bytes.length;
    if (staged.received < staged.size) return { ok: true, result: { received: staged.received } };
    try {
      // Read again from the file the store will take: what is staged is what the first piece was sniffed as.
      if (uploadTypeOf(stagedHead(fd)) !== staged.contentType)
        throw new TaviError("INVALID_INPUT", `${payload.name} is not what its first piece said it was`);
      closeSync(fd);
      staged.fd = undefined;
      const artifactId = `art-up-${randomBytes(20).toString("hex")}`;
      const extension = EXTENSIONS[staged.contentType];
      // A name safe to show and to name a filled copy after: no separators, no control characters.
      const name = folderFileName(payload.name, `attachment.${extension}`);
      const record = await deps.artifacts.putStagedArtifact({
        artifactId,
        workspaceId: payload.workspaceId,
        contentType: staged.contentType,
        stagedPath: staged.path,
        extension,
        untrusted: true,
        fileName: name,
        // The person chose it, but its bytes are from outside: `attachment`, as a channel's.
        label: untrustedLabel("attachment", { principal, ref: { ref: artifactId, at: deps.now() } }),
      });
      return {
        ok: true,
        result: {
          received: staged.received,
          attachment: { artifactId: record.artifactId, name, contentType: staged.contentType, byteSize: record.byteSize },
        },
      };
    } finally {
      // Taken by the store or refused, the staging file is gone.
      uploads.drop(payload.uploadId);
    }
  } catch (error) {
    const failure = TaviError.from(error);
    return { ok: false, error: { code: failure.code, message: failure.message } };
  } finally {
    bytes.fill(0);
  }
}
