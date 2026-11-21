import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_UPLOAD_CHUNK_CHARS,
  ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES,
  ATTACHMENT_UPLOAD_PDF_MAX_BYTES,
  ATTACHMENT_UPLOAD_VIDEO_MAX_BYTES,
} from "@tavi/contracts";
import {
  FILE_ACCEPT,
  composePrompt,
  inlinedFilesOf,
  readAttachment,
  uploadFile,
  uploadsOf,
  MAX_ATTACHMENT_BYTES,
} from "../../../src/features/chat/attachments.js";

describe("text attachments", () => {
  it("includes the real filename and complete content in the submitted prompt", async () => {
    const file = await readAttachment(new File(['hello\n"world"'], "notes.md"));
    const prompt = composePrompt("Summarize", [file]);
    expect(prompt).toContain('Attached file "notes.md" (reference content)');
    // Its lines as they are, in a fence: never one escaped string with literal \n.
    expect(prompt).toContain('```\nhello\n"world"\n```');
    expect(prompt).not.toContain("\\n");
    // A fence in the file cannot end the block early.
    expect(composePrompt("", [{ name: "a.md", text: "```js\nx\n```" }])).toContain("````\n```js\nx\n```\n````");
    expect(composePrompt("", [file])).not.toBe("");
  });
  it("rejects unsupported, oversized, invalid UTF-8 and disguised binary files", async () => {
    await expect(readAttachment(new File(["x"], "image.webp", { type: "image/webp" }))).rejects.toThrow(
      "the canvas takes a PDF, a photo (PNG, JPEG), a video",
    );
    await expect(readAttachment(new File(["x".repeat(MAX_ATTACHMENT_BYTES + 1)], "notes.txt"))).rejects.toThrow("48 KB");
    await expect(readAttachment(new File([new Uint8Array([255])], "notes.txt"))).rejects.toThrow();
    await expect(readAttachment(new File(["a\0b"], "notes.txt"))).rejects.toThrow("binary");
  });
  it("bounds the whole prompt, attachment content included", () => {
    expect(() => composePrompt("x".repeat(65536), [{ name: "a.txt", text: "more" }])).toThrow("limit");
    expect(() => composePrompt("", [{ name: "a.txt", text: "\n".repeat(70000) }])).toThrow("limit");
  });
});

describe("inlined text files, as a message shows them", () => {
  it("reads back the files composePrompt inlined, and the person's words before them", async () => {
    const notes = await readAttachment(new File(["# Notes\n\n```js\nx\n```\n"], "notes.md"));
    const prompt = composePrompt("Summarize", [notes, { name: 'odd "name".txt', text: "" }]);
    expect(inlinedFilesOf(prompt)).toEqual({
      text: "Summarize",
      files: [
        { name: "notes.md", text: "# Notes\n\n```js\nx\n```" },
        { name: 'odd "name".txt', text: "" },
      ],
    });
    expect(inlinedFilesOf(composePrompt("", [notes])).text).toBe("");
  });

  it("leaves a prompt alone that only looks like one", () => {
    expect(inlinedFilesOf("plain words")).toEqual({ text: "plain words", files: [] });
    const typed = 'see below\n\nAttached file "x.md" (reference content):\n```\nnot closed';
    expect(inlinedFilesOf(typed)).toEqual({ text: typed, files: [] });
  });
});

describe("photo attachments", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

  it("uploads a PNG or JPEG by its bytes, and refuses a renamed file or one over 5 MB", async () => {
    expect(await readAttachment(new File([png], "shot.png", { type: "image/png" }))).toMatchObject({ kind: "upload", media: "image" });
    expect(await readAttachment(new File([jpeg], "photo.JPG"))).toMatchObject({ kind: "upload", media: "image" });
    await expect(readAttachment(new File(["just text"], "fake.png"))).rejects.toThrow("not a PNG or JPEG photo");
    const big = new Uint8Array(ATTACHMENT_UPLOAD_IMAGE_MAX_BYTES + 1);
    big.set(png);
    await expect(readAttachment(new File([big], "big.png"))).rejects.toThrow("a photo is at most 5 MB");
  });
});

describe("PDF attachments", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

  it("takes a PDF by its bytes, and refuses a file renamed .pdf or one over 20 MB", async () => {
    expect(await readAttachment(new File([pdf], "form.pdf", { type: "application/pdf" }))).toMatchObject({
      kind: "upload",
      media: "pdf",
      name: "form.pdf",
    });
    await expect(readAttachment(new File(["just text"], "notes.pdf"))).rejects.toThrow("not a PDF");
    await expect(readAttachment(new File([new Uint8Array(ATTACHMENT_UPLOAD_PDF_MAX_BYTES + 1)], "big.pdf"))).rejects.toThrow("20 MiB");
  });

  it("leaves a PDF out of the prompt: it is uploaded and named instead", async () => {
    const file = await readAttachment(new File([pdf], "form.pdf"));
    expect(composePrompt("Fill it in", [file])).toBe("Fill it in");
    expect(uploadsOf([file, { name: "a.txt", text: "x" }])).toHaveLength(1);
  });

  it("uploads in chunks under the frame cap, from offset 0, and answers the artifact id", async () => {
    const bytes = new Uint8Array(1_000_000).fill(65);
    bytes.set(pdf.subarray(0, 5));
    const sent: { offset: number; data: string }[] = [];
    const client = {
      request: async (_command: string, payload: Record<string, unknown>) => {
        sent.push({ offset: payload["offset"] as number, data: payload["data"] as string });
        const received = (payload["offset"] as number) + atob(payload["data"] as string).length;
        return {
          ok: true,
          result: {
            received,
            ...(received === bytes.length
              ? { attachment: { artifactId: "art-up-1", name: "form.pdf", contentType: "application/pdf", byteSize: received } }
              : {}),
          },
        };
      },
    } as unknown as Parameters<typeof uploadFile>[0];
    expect(
      await uploadFile(client, "default", { kind: "upload", media: "pdf", name: "form.pdf", file: new Blob([bytes]) }, "up-12345678"),
    ).toBe("art-up-1");
    expect(sent.map((chunk) => chunk.offset)).toEqual([0, 393_216, 786_432]);
    expect(sent.every((chunk) => chunk.data.length <= ATTACHMENT_UPLOAD_CHUNK_CHARS)).toBe(true);
  });

  it("says why the owner refused an upload", async () => {
    const client = {
      request: async () => ({ ok: false, error: { code: "INVALID_INPUT", message: "form.pdf is not a PDF" } }),
    } as unknown as Parameters<typeof uploadFile>[0];
    await expect(
      uploadFile(client, "default", { kind: "upload", media: "pdf", name: "form.pdf", file: new Blob([pdf]) }, "up-12345678"),
    ).rejects.toThrow("form.pdf");
  });
});

describe("video and GIF attachments", () => {
  const mp4 = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom"), 0, 0, 2, 0]);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
  const gif = new TextEncoder().encode("GIF89a\u0001\u0000");

  it("takes a video or GIF by its first bytes, up to 50 MB, and refuses one renamed", async () => {
    expect(await readAttachment(new File([mp4], "clip.mp4", { type: "video/mp4" }))).toMatchObject({
      kind: "upload",
      media: "video",
      name: "clip.mp4",
    });
    expect(await readAttachment(new File([mp4], "clip.mov"))).toMatchObject({ media: "video" });
    expect(await readAttachment(new File([webm], "clip.webm"))).toMatchObject({ media: "video" });
    expect(await readAttachment(new File([gif], "loop.gif"))).toMatchObject({ media: "gif" });
    await expect(readAttachment(new File(["just text"], "clip.mp4"))).rejects.toThrow("not an MP4, MOV or WebM video");
    await expect(readAttachment(new File([mp4], "loop.gif"))).rejects.toThrow("not a GIF");
    // A container the owner does not take is not attached as a video.
    await expect(readAttachment(new File([webm], "clip.mkv", { type: "video/x-matroska" }))).rejects.toThrow(
      "the canvas takes a PDF, a photo (PNG, JPEG), a video",
    );
    await expect(readAttachment(new File([mp4], "clip.3gp", { type: "video/3gpp" }))).rejects.toThrow(
      "the canvas takes a PDF, a photo (PNG, JPEG), a video (MP4, MOV, WebM)",
    );
    // 21 MB is too big for a PDF, not for a video; 51 MB is too big for either.
    const sized = (size: number, head: Uint8Array): Uint8Array<ArrayBuffer> => {
      const bytes = new Uint8Array(size);
      bytes.set(head);
      return bytes;
    };
    expect(await readAttachment(new File([sized(ATTACHMENT_UPLOAD_PDF_MAX_BYTES + 1, mp4)], "long.mp4"))).toMatchObject({ media: "video" });
    await expect(readAttachment(new File([sized(ATTACHMENT_UPLOAD_VIDEO_MAX_BYTES + 1, mp4)], "longer.mp4"))).rejects.toThrow("50 MiB");
  });

  it("reads the file a slice at a time as it uploads, never whole", async () => {
    const bytes = new Uint8Array(900_000);
    bytes.set(mp4);
    const blob = new Blob([bytes]);
    const sliced: number[] = [];
    const slice = blob.slice.bind(blob);
    // Every read is a slice of at most one chunk; the whole is never asked for.
    const watched = {
      size: blob.size,
      slice: (start?: number, end?: number) => {
        sliced.push((end ?? blob.size) - (start ?? 0));
        return slice(start, end);
      },
      arrayBuffer: () => {
        throw new Error("read whole");
      },
    } as unknown as Blob;
    const client = {
      request: async (_command: string, payload: Record<string, unknown>) => ({
        ok: true,
        result: {
          received: 0,
          ...((payload["offset"] as number) + atob(payload["data"] as string).length === bytes.length
            ? { attachment: { artifactId: "art-up-2", name: "clip.mp4", contentType: "video/mp4", byteSize: bytes.length } }
            : {}),
        },
      }),
    } as unknown as Parameters<typeof uploadFile>[0];
    expect(await uploadFile(client, "default", { kind: "upload", media: "video", name: "clip.mp4", file: watched }, "up-12345678")).toBe(
      "art-up-2",
    );
    expect(sliced.every((length) => length <= (ATTACHMENT_UPLOAD_CHUNK_CHARS / 4) * 3)).toBe(true);
    expect(sliced).toHaveLength(3);
  });

  it("says which file could not be read when it moved or changed after it was attached", async () => {
    const gone = {
      size: 10,
      slice: () => ({
        arrayBuffer: async () => {
          throw new DOMException("A requested file or directory could not be found", "NotFoundError");
        },
      }),
    } as unknown as Blob;
    const client = { request: async () => ({ ok: true, result: { received: 0 } }) } as unknown as Parameters<typeof uploadFile>[0];
    await expect(
      uploadFile(client, "default", { kind: "upload", media: "video", name: "clip.mp4", file: gone }, "up-12345678"),
    ).rejects.toThrow("clip.mp4: the file changed or moved after it was attached; attach it again.");
  });
});

describe("audio attachments", () => {
  const ogg = new TextEncoder().encode("OggS\u0000\u0002");
  const mp3 = new Uint8Array([...new TextEncoder().encode("ID3"), 4, 0, 0, 0, 0, 0, 0]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

  it("offers the audio audio.transcribe reads, takes it by its first bytes, and refuses one renamed", async () => {
    for (const extension of [".ogg", ".opus", ".mp3", ".m4a", ".wav", ".aac"]) expect(FILE_ACCEPT.split(",")).toContain(extension);
    expect(await readAttachment(new File([ogg], "voice.opus"))).toMatchObject({ kind: "upload", media: "audio", name: "voice.opus" });
    expect(await readAttachment(new File([mp3], "memo.mp3", { type: "audio/mpeg" }))).toMatchObject({ media: "audio" });
    const m4a = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypmp42"), 0, 0, 0, 0]);
    expect(await readAttachment(new File([m4a], "recorder.m4a"))).toMatchObject({ media: "audio" });
    await expect(readAttachment(new File([png], "fake.mp3"))).rejects.toThrow("not an Ogg, MP3, M4A, WAV or AAC audio file");
    const long = new Uint8Array(ATTACHMENT_UPLOAD_VIDEO_MAX_BYTES + 1);
    long.set(ogg);
    await expect(readAttachment(new File([long], "long.ogg"))).rejects.toThrow("an audio file is at most 50 MiB");
  });
});
