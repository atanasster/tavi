import { createReadStream } from "node:fs";

import { AUDIO_MEDIA_TYPES, type ArtifactRecord, folderFileName, sniffAudioContainer } from "@tavi/contracts";

/**
 * Largest artifact this adapter will hand to a page.
 *
 * The whole body is read into memory and handed to the page, and the
 * destination page chooses what it asks for, so the size is bounded before the
 * read — the same discipline (and the same reasoning) as the Telegram delivery
 * path's attachment bound.
 */
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** How much of a re-fetched PDF one DevTools read takes. */
export const PDF_READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Largest upload Playwright hands a page from memory (its own bound is 50 MiB):
 * anything bigger goes to the page as a staged file, which a confined Chromium cannot read.
 */
export const UPLOAD_IN_MEMORY_MAX_BYTES = 50 * 1024 * 1024 - 1;

/** An artifact that passed every upload check, plus the name the page will see. */
/** A file's media type by its extension, as a page's file picker reads it (`accept="image/*"`); bytes of any other kind otherwise. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  json: "application/json",
  xml: "application/xml",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

export function mediaTypeOf(fileName: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return (extension === undefined ? undefined : MEDIA_TYPES[extension]) ?? "application/octet-stream";
}

const TEXT_MEDIA_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "application/json",
  "application/xml",
  "image/svg+xml",
]);

/** Sniffs a downloaded file's media type from its leading bytes and safe filename. */
export function sniffDownloadMediaType(bytes: Uint8Array, fileName: string): string {
  const starts = (...signature: readonly number[]): boolean => signature.every((byte, index) => bytes[index] === byte);
  const ascii = (offset: number, text: string): boolean => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "%PDF-")) return "application/pdf";
  // Audio by the decoder's rule, so a downloaded recording is what audio.transcribe reads.
  const audio = sniffAudioContainer(bytes);
  if (audio !== undefined && audio !== "m4a") return AUDIO_MEDIA_TYPES[audio];
  if (starts(0x1f, 0x8b)) return "application/gzip";
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) || starts(0x50, 0x4b, 0x07, 0x08)) {
    const byName = mediaTypeOf(fileName);
    return byName.startsWith("application/vnd.openxmlformats-") ? byName : "application/zip";
  }
  if (ascii(4, "ftyp")) {
    if (["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].some((brand) => ascii(8, brand))) return "image/heic";
    if (ascii(8, "avif") || ascii(8, "avis")) return "image/avif";
    if (["M4A ", "M4B ", "M4P ", "F4A ", "F4B "].some((brand) => ascii(8, brand))) return "audio/mp4";
    if (ascii(8, "qt  ")) return "video/quicktime";
    return "video/mp4";
  }
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  const byName = mediaTypeOf(fileName);
  const sample = bytes.subarray(0, 8192);
  if (sample.byteLength > 0 && !sample.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample);
      return TEXT_MEDIA_TYPES.has(byName) ? byName : "text/plain";
    } catch {
      return TEXT_MEDIA_TYPES.has(byName) ? "application/octet-stream" : byName;
    }
  }
  return TEXT_MEDIA_TYPES.has(byName) && sample.byteLength > 0 ? "application/octet-stream" : byName;
}

/** Extracts literal text strings from uncompressed PDF content streams, for an adapter built with no `PdfEnginePort`. */
export function extractLiteralPdfText(bytes: Uint8Array): string {
  const raw = new TextDecoder("latin1").decode(bytes);
  const blocks: string[] = [];
  const btRegex = /\bBT\b([\s\S]*?)\bET\b/g;
  for (let match = btRegex.exec(raw); match !== null; match = btRegex.exec(raw)) {
    if (match[1] !== undefined) blocks.push(match[1]);
  }
  const source = blocks.length > 0 ? blocks.join("\n") : raw;
  const pieces: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "(") continue;
    let depth = 1;
    let current = "";
    i += 1;
    while (i < source.length && depth > 0) {
      const ch = source[i]!;
      if (ch === "\\") {
        i += 1;
        const next = source[i];
        if (next === undefined) break;
        if (next === "n") current += "\n";
        else if (next === "r") current += "\r";
        else if (next === "t") current += "\t";
        else if (next === "(" || next === ")" || next === "\\") current += next;
        else if (next >= "0" && next <= "7") {
          let oct = next;
          if ((source[i + 1] ?? "") >= "0" && (source[i + 1] ?? "") <= "7") {
            oct += source[i + 1];
            i += 1;
            if ((source[i + 1] ?? "") >= "0" && (source[i + 1] ?? "") <= "7") {
              oct += source[i + 1];
              i += 1;
            }
          }
          current += String.fromCharCode(Number.parseInt(oct, 8));
        } else {
          current += next;
        }
      } else if (ch === "(") {
        depth += 1;
        current += ch;
      } else if (ch === ")") {
        depth -= 1;
        if (depth > 0) current += ch;
      } else {
        current += ch;
      }
      i += 1;
    }
    i -= 1;
    const trimmed = current.trim();
    if (trimmed !== "" && (blocks.length > 0 || /^[\x20-\x7e\s]+$/.test(trimmed))) {
      pieces.push(trimmed);
    }
  }
  return pieces.join(" ").replace(/\s+/g, " ").trim();
}

/** The `Content-Length` a response declares, when it declares a usable one. */
export function declaredLengthOf(headers: Record<string, string>): number | undefined {
  const raw = headers["content-length"];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * A main-frame PDF response's body, read only when its declared length is
 * within `UPLOAD_MAX_BYTES` (Playwright buffers a whole body before it answers
 * one), and dropped when it turns out over it: `"over-cap"` when the declared
 * length already says so, so no second request is made for it.
 */
export function pdfBodyOf(headers: Record<string, string>, body: () => Promise<Uint8Array>): Promise<Uint8Array | "over-cap" | undefined> {
  const declared = declaredLengthOf(headers);
  if (declared !== undefined && declared > UPLOAD_MAX_BYTES) return Promise.resolve("over-cap");
  return Promise.resolve()
    .then(body)
    .then((buf) => (buf instanceof Uint8Array && buf.byteLength <= UPLOAD_MAX_BYTES ? new Uint8Array(buf) : undefined))
    .catch(() => undefined);
}

/**
 * Reads up to `maxBytes` of `path` into memory, stopping as soon as the file
 * passes `maxBytes`, whether or not the server said its size: the artifact
 * store takes a whole body, so a download is held in memory, as its chunks
 * and then joined (about twice its size at the peak), bounded by the download
 * cap (`browser.downloadMaxMiB`).
 */
export async function readBoundedDownload(
  path: string,
  maxBytes: number,
): Promise<{ readonly body: Uint8Array; readonly overCap: boolean }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.byteLength;
      if (totalBytes > maxBytes) {
        stream.destroy();
        return { body: new Uint8Array(0), overCap: true };
      }
      chunks.push(buf);
    }
  } finally {
    stream.destroy();
  }
  return { body: Buffer.concat(chunks, totalBytes), overCap: false };
}

export interface UploadableArtifact {
  readonly body: Uint8Array;
  readonly fileName: string;
}

/**
 * A safe name for the temp file the page receives.
 *
 * `relativePath` is a store-supplied string with no contract-stated character
 * set, so this keeps only a plain basename and falls back to a fixed name for
 * anything odd (a NUL, an exotic separator, a `.`/`..` segment, an over-long
 * segment). The fresh `mkdtemp` directory already contains traversal; the point
 * here is that the page gets a sane filename and the failure is never an opaque
 * `ENOENT`/`ENAMETOOLONG` from inside `runWriteAction`.
 */
export function safeUploadName(record: ArtifactRecord): string {
  // The file's own name, when it has one (a folder file sent by path), made safe again here.
  if (record.fileName !== undefined) return folderFileName(record.fileName, "upload");
  const base = record.relativePath.split("/").pop() ?? "";
  return /^[\w.-]{1,128}$/.test(base) && base !== "." && base !== ".." ? base : "upload";
}
