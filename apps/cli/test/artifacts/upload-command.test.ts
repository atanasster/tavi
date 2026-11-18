import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ARTIFACT_STAGING_DIRECTORY,
  ATTACHMENT_UPLOAD_MAX_BYTES,
  ATTACHMENT_UPLOAD_PDF_MAX_BYTES,
  parseCommandPayload,
  type ArtifactsUploadPayload,
} from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../../../../packages/runtime/src/persistence/store.js";
import { afterEach, describe, expect, it } from "vitest";

import { AttachmentUploads, artifactsUploadCommand, type UploadCommandDependencies } from "../../src/features/artifacts/upload-owner.js";

/**
 * `artifacts upload`: a web
 * UI attachment, chunk by chunk, appended to a staging file and taken whole
 * by the real store, kept as a channel attachment is.
 */

const roots = temporaryDirectories();
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  roots.cleanup();
});

type Put = Parameters<UploadCommandDependencies["artifacts"]["putStagedArtifact"]>[0];

function setup(): {
  readonly deps: UploadCommandDependencies;
  readonly puts: Put[];
  readonly store: SqliteStore;
  readonly staging: string;
} {
  const root = roots.create("tavi-upload-");
  const artifacts = join(root, "artifacts");
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true, artifactsDirectory: artifacts });
  stores.push(store);
  const puts: Put[] = [];
  const staging = join(artifacts, ARTIFACT_STAGING_DIRECTORY);
  const deps: UploadCommandDependencies = {
    artifacts: {
      putStagedArtifact: async (input) => {
        puts.push(input);
        return store.putStagedArtifact(input);
      },
    },
    stagingDirectory: staging,
    principalOf: (workspaceId) => (workspaceId === "default" ? "operator" : undefined),
    now: () => "2026-10-15T00:00:00.000Z",
    uploads: new AttachmentUploads(),
  };
  return { deps, puts, store, staging };
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n", "latin1");
/** An MP4's head: an `ftyp` box of brand `isom`, and then whatever follows. */
const MP4_HEAD = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
const mp4 = (size: number): Buffer => Buffer.concat([MP4_HEAD, Buffer.alloc(Math.max(0, size - MP4_HEAD.length))]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(32)]);
/** A PNG's signature and its `IHDR` chunk, `width` × `height`: as much as says what it is and how large. */
function png(width: number, height: number, size = 64): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(header);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 2;
  return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length))]);
}

/** `bytes` as upload chunks of `size` bytes each. */
function chunks(bytes: Buffer, name: string, size: number, uploadId = "upload-0001"): ArtifactsUploadPayload[] {
  const pieces: ArtifactsUploadPayload[] = [];
  for (let offset = 0; offset < bytes.length; offset += size)
    pieces.push({
      action: "upload",
      workspaceId: "default",
      uploadId,
      name,
      size: bytes.length,
      offset,
      data: bytes.subarray(offset, offset + size).toString("base64"),
    });
  return pieces;
}

async function upload(deps: UploadCommandDependencies, bytes: Buffer, name: string, size = 16) {
  let last;
  for (const piece of chunks(bytes, name, size)) {
    last = await artifactsUploadCommand(deps, piece);
    // A refused piece ends the upload, as the composer stops at one.
    if (!last.ok) return last;
  }
  return last;
}

describe("artifacts upload", () => {
  it("keeps a PDF sent in pieces as an approved, untrusted attachment, its staging file taken by the store", async () => {
    const { deps, puts, store, staging } = setup();
    const answers = [];
    for (const piece of chunks(PDF, "form.pdf", 16)) answers.push(await artifactsUploadCommand(deps, piece));
    expect(answers.slice(0, -1).every((answer) => answer.ok && answer.result?.attachment === undefined)).toBe(true);
    const last = answers.at(-1);
    expect(last?.ok && last.result?.attachment).toMatchObject({ name: "form.pdf", contentType: "application/pdf", byteSize: PDF.length });
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      workspaceId: "default",
      contentType: "application/pdf",
      untrusted: true,
      fileName: "form.pdf",
      extension: "pdf",
    });
    expect(puts[0]?.reviewState).toBeUndefined();
    expect(puts[0]?.purpose).toBeUndefined();
    expect(puts[0]?.label).toMatchObject({ integrity: "untrusted", sources: ["attachment"], principals: ["operator"] });
    const record = last?.ok ? store.getArtifact(last.result?.attachment?.artifactId ?? "") : undefined;
    expect(Buffer.from(store.readArtifactBody(record?.artifactId ?? "") ?? new Uint8Array()).equals(PDF)).toBe(true);
    expect(record?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Moved, not copied: nothing is left in staging.
    expect(readdirSync(staging)).toEqual([]);
  });

  it("keeps a video and a GIF, each under its own type, with the PDF tools off; a PDF is refused then", async () => {
    const { deps } = setup();
    const pdfOff = { ...deps, pdfEnabled: async () => false, videoEnabled: async () => true };
    expect(await upload(pdfOff, mp4(4096), "clip.mp4", 1024)).toMatchObject({
      ok: true,
      result: { attachment: { contentType: "video/mp4", name: "clip.mp4", byteSize: 4096 } },
    });
    expect(await upload(pdfOff, GIF, "loop.gif")).toMatchObject({ ok: true, result: { attachment: { contentType: "image/gif" } } });
    expect(await upload(pdfOff, PDF, "form.pdf")).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED", message: expect.stringContaining("pdf.enabled on") },
    });
    // And the other way: with the video tools off, a video is refused and a PDF is taken.
    const videoOff = { ...deps, pdfEnabled: async () => true, videoEnabled: async () => false };
    expect(await upload(videoOff, mp4(4096), "clip.mp4", 1024)).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED", message: expect.stringContaining("video.enabled on") },
    });
    expect(await upload(videoOff, PDF, "form.pdf")).toMatchObject({ ok: true });
  });

  it("keeps a photo with the PDF and video tools off, and refuses one a model could not be shown", async () => {
    const { deps, staging } = setup();
    const toolsOff = { ...deps, pdfEnabled: async () => false, videoEnabled: async () => false };
    expect(await upload(toolsOff, png(640, 480), "shot.png")).toMatchObject({
      ok: true,
      result: { attachment: { contentType: "image/png", name: "shot.png", byteSize: 64 } },
    });
    expect(await upload(toolsOff, png(9000, 9000), "huge.png")).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("huge.png cannot be shown to a model: it is 9000×9000 pixels") },
    });
    expect(await upload(toolsOff, png(640, 480, 5_000_001), "heavy.png", 1024 * 1024)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: "heavy.png: a photo is at most 5 MB" },
    });
    expect(readdirSync(staging)).toEqual([]);
  });

  it("refuses a renamed file by what its bytes are, whatever its name says", async () => {
    const { deps, puts, staging } = setup();
    expect(
      await artifactsUploadCommand(
        deps,
        chunks(Buffer.from("just some text, not a document"), "notes.pdf", 1024)[0] as ArtifactsUploadPayload,
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", message: expect.stringContaining("notes.pdf is not a PDF, a video") } });
    // A JPEG named as a video is not one.
    expect(
      await artifactsUploadCommand(
        deps,
        chunks(Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(64)]), "clip.mp4", 1024)[0] as ArtifactsUploadPayload,
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(puts).toHaveLength(0);
    // The type is the first piece's: later pieces, whatever they hold, never change it; staging is cleared after.
    const pieces = chunks(Buffer.concat([mp4(32), Buffer.from("%PDF-1.4 not the head")]), "clip.mp4", 32);
    expect(await artifactsUploadCommand(deps, pieces[0] as ArtifactsUploadPayload)).toMatchObject({ ok: true });
    expect(readdirSync(staging)).toHaveLength(1);
    expect(await artifactsUploadCommand(deps, pieces[1] as ArtifactsUploadPayload)).toMatchObject({
      ok: true,
      result: { attachment: { contentType: "video/mp4" } },
    });
    expect(readdirSync(staging)).toEqual([]);
    // A first piece too short to be anything is refused.
    expect(
      await artifactsUploadCommand(deps, {
        action: "upload",
        workspaceId: "default",
        uploadId: "upload-0003",
        name: "x.mp4",
        size: 64,
        offset: 0,
        data: Buffer.from("GIF").toString("base64"),
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("caps each type by what it is: a PDF at 20 MiB, a video at 50 MiB", async () => {
    expect(
      parseCommandPayload("artifacts", {
        action: "upload",
        workspaceId: "default",
        uploadId: "upload-0001",
        name: "big.mp4",
        size: ATTACHMENT_UPLOAD_MAX_BYTES + 1,
        offset: 0,
        data: "JVBERi0=",
      }).ok,
    ).toBe(false);
    const { deps } = setup();
    // A PDF that says it is 21 MiB is refused at its first piece; a video of the same size is not.
    const first = (bytes: Buffer, name: string, size: number): ArtifactsUploadPayload => ({
      action: "upload",
      workspaceId: "default",
      uploadId: "upload-0001",
      name,
      size,
      offset: 0,
      data: bytes.toString("base64"),
    });
    expect(await artifactsUploadCommand(deps, first(PDF, "big.pdf", ATTACHMENT_UPLOAD_PDF_MAX_BYTES + 1))).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("at most 20 MiB") },
    });
    expect(await artifactsUploadCommand(deps, first(mp4(64), "big.mp4", ATTACHMENT_UPLOAD_PDF_MAX_BYTES + 1))).toMatchObject({ ok: true });
    expect(
      await artifactsUploadCommand(deps, {
        action: "upload",
        workspaceId: "default",
        uploadId: "upload-0002",
        name: "a.pdf",
        size: 4,
        offset: 0,
        data: PDF.toString("base64"),
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("takes a 50 MiB video without holding it: the owner's memory grows by less than 32 MiB", async () => {
    const { deps, store } = setup();
    const size = 50 * 1024 * 1024;
    const piece = 384 * 1024;
    const zeros = Buffer.alloc(piece).toString("base64");
    const head = Buffer.concat([mp4(MP4_HEAD.length), Buffer.alloc(piece - MP4_HEAD.length)]).toString("base64");
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    let answer;
    for (let offset = 0; offset < size; offset += piece) {
      const last = size - offset < piece;
      answer = await artifactsUploadCommand(deps, {
        action: "upload",
        workspaceId: "default",
        uploadId: "upload-0001",
        name: "long.mp4",
        size,
        offset,
        data: offset === 0 ? head : last ? Buffer.alloc(size - offset).toString("base64") : zeros,
      });
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    expect(answer).toMatchObject({ ok: true, result: { attachment: { contentType: "video/mp4", byteSize: size } } });
    expect(peak - before).toBeLessThan(32 * 1024 * 1024);
    expect(store.getArtifact(answer?.ok ? (answer.result?.attachment?.artifactId ?? "") : "")?.byteSize).toBe(size);
  }, 60_000);

  it("checks the free-space floor before a staging file is made", async () => {
    const { deps, staging } = setup();
    const full = {
      ...deps,
      checkSpace: () => {
        throw new Error("the volume is below its free-space floor");
      },
    };
    expect(await upload(full, PDF, "form.pdf")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("free-space floor") },
    });
    expect(() => readdirSync(staging)).toThrow();
  });

  it("starts over on a piece out of order, and refuses a workspace this owner does not serve", async () => {
    const { deps, puts, staging } = setup();
    const pieces = chunks(PDF, "form.pdf", 16);
    await artifactsUploadCommand(deps, pieces[0] as ArtifactsUploadPayload);
    expect(await artifactsUploadCommand(deps, pieces[2] as ArtifactsUploadPayload)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("out of order") },
    });
    // The upload was dropped, its staging file with it: its next piece in order no longer joins it.
    expect(readdirSync(staging)).toEqual([]);
    expect(await artifactsUploadCommand(deps, pieces[1] as ArtifactsUploadPayload)).toMatchObject({ ok: false });
    expect(puts).toHaveLength(0);
    expect(await artifactsUploadCommand(deps, { ...(pieces[0] as ArtifactsUploadPayload), workspaceId: "elsewhere" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("names a file safely", async () => {
    const { deps, puts } = setup();
    await upload(deps, PDF, "../\u0007evil/../form.pdf", 1024);
    expect(puts[0]?.fileName).not.toMatch(/[/\\\u0000-\u001f]/);
  });

  it("starts over when a piece names another file or size, and refuses without a connection", async () => {
    const { deps } = setup();
    const pieces = chunks(PDF, "form.pdf", 16);
    await artifactsUploadCommand(deps, pieces[0] as ArtifactsUploadPayload);
    expect(await artifactsUploadCommand(deps, { ...(pieces[1] as ArtifactsUploadPayload), name: "other.pdf" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await artifactsUploadCommand({ ...deps, uploads: undefined }, pieces[0] as ArtifactsUploadPayload)).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED" },
    });
  });

  it("holds at most four uploads per connection, dropping the oldest and its staging file", async () => {
    const { deps, staging } = setup();
    for (let index = 0; index <= 4; index += 1)
      await artifactsUploadCommand(deps, { ...(chunks(PDF, "a.pdf", 16, `upload-000${String(index)}`)[0] as ArtifactsUploadPayload) });
    expect(deps.uploads?.get("upload-0000")).toBeUndefined();
    expect(readdirSync(staging)).toHaveLength(4);
    deps.uploads?.clear();
    expect(readdirSync(staging)).toEqual([]);
  });
});

describe("the store's staged put", () => {
  it("refuses a staged path outside its staging directory, and a link in it", async () => {
    const { store, staging, deps } = setup();
    // Made by a first upload.
    await upload(deps, PDF, "form.pdf", 1024);
    const outside = join(roots.paths[0] as string, "elsewhere.pdf");
    const { writeFileSync, symlinkSync } = await import("node:fs");
    writeFileSync(outside, PDF);
    const put = { workspaceId: "default", contentType: "application/pdf", extension: "pdf" };
    expect(() => store.putStagedArtifact({ ...put, stagedPath: outside })).toThrow(/only from the store's staging directory/);
    expect(() => store.putStagedArtifact({ ...put, stagedPath: join(staging, "..", "elsewhere.pdf") })).toThrow(
      /only from the store's staging directory/,
    );
    expect(readFileSync(outside)).toEqual(PDF);
    symlinkSync(outside, join(staging, "linked"));
    expect(() => store.putStagedArtifact({ ...put, stagedPath: join(staging, "linked") })).toThrow(/not a link/);
    // The link is removed; what it pointed at is not.
    expect(readdirSync(staging)).toEqual([]);
    expect(readFileSync(outside)).toEqual(PDF);
  });
});
