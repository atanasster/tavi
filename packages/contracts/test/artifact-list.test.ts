import { describe, expect, it } from "vitest";
import {
  ARTIFACT_READ_CHUNK_BYTES,
  ATTACHMENT_UPLOAD_VIDEO_MAX_BYTES,
  AUDIO_MEDIA_TYPES,
  UPLOAD_CONTENT_TYPES,
  isUploadAudio,
  uploadMaxBytes,
  ArtifactReadAnswerSchema,
  ArtifactsPayloadSchema,
  ArtifactsResultSchema,
  IPC_MAX_FRAME_BYTES,
  parseCommandPayload,
} from "../src/index.js";

describe("artifact metadata contract", () => {
  it("requires workspace scope and bounds IDs, pages and cursors", () => {
    expect(parseCommandPayload("artifacts", { workspaceId: "default" }).ok).toBe(true);
    for (const input of [
      {},
      { workspaceId: "default", limit: 101 },
      { workspaceId: "default", artifactIds: [] },
      { workspaceId: "default", artifactIds: Array(101).fill("a") },
      { workspaceId: "default", cursor: "../x" },
      { workspaceId: "default", body: true },
    ])
      expect(ArtifactsPayloadSchema.safeParse(input).success).toBe(false);
  });
  it("keeps worst-case metadata under an IPC frame and excludes content", () => {
    const id = "\0".repeat(128);
    const row = { artifactId: id, workspaceId: id, runId: id, contentType: "\0".repeat(256), byteSize: 1, reviewState: "pending" };
    const result = { rows: Array.from({ length: 100 }, () => row) };
    expect(ArtifactsResultSchema.safeParse(result).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(IPC_MAX_FRAME_BYTES - 4096);
    expect(ArtifactsResultSchema.safeParse({ rows: [{ ...row, body: "secret" }] }).success).toBe(false);
  });
  it("takes a thumbnail read beside the list, and bounds a chunk under a frame", () => {
    expect(parseCommandPayload("artifacts", { action: "read", workspaceId: "default", artifactId: "art-1", offset: 0 }).ok).toBe(true);
    for (const input of [
      { action: "read", workspaceId: "default" },
      { action: "read", artifactId: "art-1" },
      { action: "read", workspaceId: "default", artifactId: "art-1", offset: -1 },
      { action: "read", workspaceId: "default", artifactId: "art-1", limit: 5 },
      { action: "download", workspaceId: "default", artifactId: "art-1" },
    ]) {
      expect(parseCommandPayload("artifacts", input).ok, JSON.stringify(input)).toBe(false);
    }
    const chunk = {
      artifactId: "a".repeat(128),
      contentType: "image/jpeg",
      hash: "0".repeat(64),
      totalBytes: 1,
      offset: 0,
      base64: "A".repeat(Math.ceil(ARTIFACT_READ_CHUNK_BYTES / 3) * 4),
      nextOffset: null,
    };
    expect(ArtifactReadAnswerSchema.safeParse(chunk).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength).toBeLessThan(IPC_MAX_FRAME_BYTES - 4096);
  });
});

describe("upload types", () => {
  it("takes every audio file audio.transcribe reads, under the video cap", () => {
    for (const contentType of Object.values(AUDIO_MEDIA_TYPES)) {
      expect(UPLOAD_CONTENT_TYPES).toContain(contentType);
      const audio = contentType as (typeof UPLOAD_CONTENT_TYPES)[number];
      expect(isUploadAudio(audio)).toBe(true);
      expect(uploadMaxBytes(audio)).toBe(ATTACHMENT_UPLOAD_VIDEO_MAX_BYTES);
    }
    expect(isUploadAudio("video/mp4")).toBe(false);
  });
});
