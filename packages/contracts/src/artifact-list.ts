import { z } from "zod";
import { IdSchema } from "./ids.js";

export const ARTIFACT_LIST_LIMIT = 100;
export const ArtifactsPayloadSchema = z
  .object({
    workspaceId: IdSchema,
    taskId: IdSchema.optional(),
    includeDecided: z.boolean().optional(),
    artifactIds: z.array(IdSchema).min(1).max(ARTIFACT_LIST_LIMIT).optional(),
    limit: z.number().int().min(1).max(ARTIFACT_LIST_LIMIT).default(50),
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();
export type ArtifactsPayload = z.infer<typeof ArtifactsPayloadSchema>;
export const ArtifactListRowSchema = z
  .object({
    artifactId: IdSchema,
    workspaceId: IdSchema,
    runId: IdSchema.nullable(),
    contentType: z.string().max(256),
    byteSize: z.number().int().nonnegative(),
    reviewState: z.enum(["pending", "approved", "rejected"]),
    /** The file's own name, when it has one (a download's, an attachment's): what a person calls it. */
    fileName: z.string().max(255).optional(),
  })
  .strict();
export type ArtifactListRow = z.infer<typeof ArtifactListRowSchema>;
export const ArtifactsResultSchema = z
  .object({
    rows: z.array(ArtifactListRowSchema).max(ARTIFACT_LIST_LIMIT),
    nextCursor: z.string().max(2048).optional(),
  })
  .strict();
export type ArtifactsResult = z.infer<typeof ArtifactsResultSchema>;

/**
 * `artifacts read`: the bytes of a browser
 * session's thumbnail, for the Command Center's Browser cards, in base64
 * chunks of at most `ARTIFACT_READ_CHUNK_BYTES` (as the routine `artifact`
 * action pages a report). Only `purpose: "thumbnail"` artifacts of the named
 * workspace are served; anything else is `NOT_FOUND`, so this is never a
 * general download path for what a task produced.
 */
export const ARTIFACT_READ_CHUNK_BYTES = 256 * 1024;
export const ArtifactsReadPayloadSchema = z.strictObject({
  action: z.literal("read"),
  workspaceId: IdSchema,
  artifactId: IdSchema,
  /** Where the chunk starts; absent, at the first byte. */
  offset: z.number().int().min(0).optional(),
});
export type ArtifactsReadPayload = z.infer<typeof ArtifactsReadPayloadSchema>;
/**
 * The artifact store's staging directory, under its artifacts directory:
 * an upload is written there piece by
 * piece and taken whole by `putStagedArtifact`, on the same volume as the
 * artifacts, never held in the owner's memory.
 */
export const ARTIFACT_STAGING_DIRECTORY = ".staging";
/** A PDF `artifacts upload` takes at most. */
export const ATTACHMENT_UPLOAD_PDF_MAX_BYTES = 20 * 1024 * 1024;
/** A video or animated GIF `artifacts upload` takes at most. */
export const ATTACHMENT_UPLOAD_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
/** A photo (PNG, JPEG) `artifacts upload` takes at most: the largest picture `artifacts.view_image` puts in front of a model. */
export const ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES = 5_000_000;
/** A file `artifacts upload` takes at most, of any type: each type's own cap is checked against what its bytes are. */
export const ATTACHMENT_UPLOAD_MAX_BYTES = ATTACHMENT_UPLOAD_VIDEO_MAX_BYTES;
/** One upload chunk's base64: well inside an IPC frame. */
export const ATTACHMENT_UPLOAD_CHUNK_CHARS = 512 * 1024;
/**
 * `artifacts upload`: a PDF,
 * a video, an animated GIF or a photo (PNG, JPEG) the person attaches in the web UI, in base64
 * chunks from offset 0, in order. The owner reads what the first chunk is
 * from its bytes, refuses a type whose tools are off or that is over its cap,
 * checks it again once the last is in, and keeps the file as an approved,
 * untrusted artifact labelled `attachment`, as a channel attachment is kept.
 */
export const ArtifactsUploadPayloadSchema = z.strictObject({
  action: z.literal("upload"),
  workspaceId: IdSchema,
  /** The client's id for this upload: its chunks share it. */
  uploadId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  name: z.string().min(1).max(255),
  size: z.number().int().min(1).max(ATTACHMENT_UPLOAD_MAX_BYTES),
  offset: z.number().int().nonnegative().max(ATTACHMENT_UPLOAD_MAX_BYTES),
  data: z
    .string()
    .min(1)
    .max(ATTACHMENT_UPLOAD_CHUNK_CHARS)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type ArtifactsUploadPayload = z.infer<typeof ArtifactsUploadPayloadSchema>;
/** What `artifacts upload` takes, by what the bytes are: a PDF, a video in a container the decoder reads, an animated GIF, a photo. */
export const UPLOAD_CONTENT_TYPES = [
  "application/pdf",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "image/gif",
  "image/png",
  "image/jpeg",
] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];
/** Each type's cap. */
export function uploadMaxBytes(contentType: UploadContentType): number {
  if (contentType === "application/pdf") return ATTACHMENT_UPLOAD_PDF_MAX_BYTES;
  return isUploadPhoto(contentType) ? ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES : ATTACHMENT_UPLOAD_VIDEO_MAX_BYTES;
}
/** A still photo, which `artifacts.view_image` shows: no PDF or video tools are needed to read it. */
export function isUploadPhoto(contentType: UploadContentType): contentType is "image/png" | "image/jpeg" {
  return contentType === "image/png" || contentType === "image/jpeg";
}
export const UploadedAttachmentSchema = z.strictObject({
  artifactId: IdSchema,
  name: z.string().min(1).max(255),
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
  byteSize: z.number().int().positive(),
});
export type UploadedAttachment = z.infer<typeof UploadedAttachmentSchema>;
/** Bytes received so far; with the last chunk, the stored attachment. */
export const ArtifactUploadAnswerSchema = z.strictObject({
  received: z.number().int().nonnegative(),
  attachment: UploadedAttachmentSchema.optional(),
});
export type ArtifactUploadAnswer = z.infer<typeof ArtifactUploadAnswerSchema>;
/** Everything the `artifacts` command takes: a list (no `action`), `read`, or `upload`. */
export const ArtifactsCommandPayloadSchema = z.union([ArtifactsReadPayloadSchema, ArtifactsUploadPayloadSchema, ArtifactsPayloadSchema]);
export type ArtifactsCommandPayload = z.infer<typeof ArtifactsCommandPayloadSchema>;
export const ArtifactReadAnswerSchema = z.strictObject({
  artifactId: IdSchema,
  contentType: z.string().min(1).max(256),
  /** The whole body's SHA-256, so a reader can tell chunks of one version from another's. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  totalBytes: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  base64: z.string().max(Math.ceil(ARTIFACT_READ_CHUNK_BYTES / 3) * 4),
  /** Where the next chunk starts, or `null` after the last. */
  nextOffset: z.number().int().positive().nullable(),
});
export type ArtifactReadAnswer = z.infer<typeof ArtifactReadAnswerSchema>;
