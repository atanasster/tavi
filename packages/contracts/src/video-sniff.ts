import type { AudioContainer, VideoContainer } from "./video.js";

/**
 * What a video file is, from its bytes alone, before FFmpeg sees them: an
 * ISO-BMFF video by
 * its `ftyp` brand, Matroska or WebM by its EBML header's DocType, or a GIF.
 * One rule for the channels' intake and the decoder: what intake files as a
 * video is what the decoder will read, and anything else (a playlist, a
 * concat list, SDP, text named `.mp4`) is never handed to FFmpeg.
 */

/** ISO brands that are not video: still images, audio, raw camera files. */
const NOT_VIDEO_BRANDS = new Set([
  "crx ",
  "jp2 ",
  "jpx ",
  "jpm ",
  "mjp2",
  "M4A ",
  "M4B ",
  "M4P ",
  "F4A ",
  "F4B ",
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
  "avif",
  "avis",
  "avio",
]);

/**
 * The container an ISO-BMFF major brand names: QuickTime is `qt  `, 3GPP's
 * brands start `3g`, and every other video brand (`isom`, `mp42`, `dash`,
 * `XAVC`, …) is read as MP4, as intake always has; a known non-video brand is
 * none.
 */
export function isoVideoContainer(brand: string): VideoContainer | undefined {
  if (NOT_VIDEO_BRANDS.has(brand)) return undefined;
  if (brand === "qt  ") return "mov";
  if (/^3g[pgs2e]/.test(brand)) return "3gp";
  return "mp4";
}

/** The ASCII of `bytes[start, end)`, or undefined past the end. */
function ascii(bytes: Uint8Array, start: number, end: number): string | undefined {
  if (end > bytes.length) return undefined;
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** An EBML variable-length integer at `offset`: its value and width, the length marker removed. */
function vint(bytes: Uint8Array, offset: number): { readonly value: number; readonly width: number } | undefined {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  let width = 1;
  while (width <= 8 && (first & (0x80 >> (width - 1))) === 0) width += 1;
  if (width > 8 || offset + width > bytes.length) return undefined;
  let value = first & (0xff >> width);
  for (let index = 1; index < width; index += 1) value = value * 256 + (bytes[offset + index] as number);
  return { value, width };
}

/** The EBML header's DocType (element 0x4282), read from the header's own children. */
function ebmlDocType(bytes: Uint8Array): string | undefined {
  const size = vint(bytes, 4);
  if (size === undefined) return undefined;
  const end = Math.min(bytes.length, 4 + size.width + size.value);
  let offset = 4 + size.width;
  while (offset + 2 < end) {
    // The header's children have two-byte ids (0x42xx).
    const id = ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
    const length = vint(bytes, offset + 2);
    if (length === undefined) return undefined;
    const body = offset + 2 + length.width;
    // A DocType is a short word (`webm`, `matroska`): a longer one names no container this reads.
    if (id === 0x4282) return length.value > 64 ? undefined : ascii(bytes, body, Math.min(body + length.value, end));
    offset = body + length.value;
  }
  return undefined;
}

/** How many bytes of a file `sniffVideoContainer` needs: an EBML header is small, and `ftyp` is the first box. */
export const VIDEO_SNIFF_BYTES = 4096;

/** The container `bytes` (the file's first few KiB suffice) hold, or undefined for anything that is not a video this reads. */
export function sniffVideoContainer(whole: Uint8Array): VideoContainer | undefined {
  // Only the head is read, whatever the caller passes: a crafted header cannot make the sniff walk a whole download.
  const bytes = whole.subarray(0, VIDEO_SNIFF_BYTES);
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    return brand === undefined ? undefined : isoVideoContainer(brand);
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const docType = ebmlDocType(bytes);
    return docType === "webm" ? "webm" : docType === "matroska" ? "matroska" : undefined;
  }
  const signature = ascii(bytes, 0, 6);
  if (signature === "GIF87a" || signature === "GIF89a") return "gif";
  return undefined;
}

/** ISO brands of audio alone: AAC or ALAC in an MP4 (`.m4a`), an audiobook, Flash audio. */
const AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P ", "F4A ", "F4B "]);

/**
 * The audio container `bytes` hold: Ogg (a Telegram voice note's Opus), MP3 (an ID3 tag or an MPEG audio frame),
 * raw AAC in ADTS frames (some Android recorders' and bots'), RIFF WAVE, or an ISO file of an audio brand. Undefined
 * for anything else, so FFmpeg is only ever handed one of these demuxers. Intake (`sniffMediaType`) uses this same
 * rule, so what it files as audio is what the decoder reads.
 */
export function sniffAudioContainer(whole: Uint8Array): AudioContainer | undefined {
  const bytes = whole.subarray(0, VIDEO_SNIFF_BYTES);
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "wav";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    return brand !== undefined && AUDIO_BRANDS.has(brand) ? "m4a" : undefined;
  }
  if (ascii(bytes, 0, 3) === "ID3") return "mp3";
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    // An MPEG audio frame's sync (11 set bits) names its layer; ADTS (12 set bits, layer 00) is AAC's. JPEG's 0xFFD8
    // matches neither.
    const second = bytes[1] ?? 0;
    if ((second & 0xf6) === 0xf0) return "aac";
    if ((second & 0x06) !== 0) return "mp3";
  }
  return undefined;
}

/** What a GIF's blocks say of it, walked without decoding: its images (counted up to `stopAt`), and whether it says it moves. */
export interface GifShape {
  readonly images: number;
  /** A looping (NETSCAPE2.0) extension, or a frame delay above zero: an animation, not a still tiled from several images. */
  readonly timed: boolean;
}

/**
 * A GIF's shape: a walk of
 * its blocks, no decoding, so the owner can tell an animation (read with
 * `video.frames`) from a still (seen as an image). Undefined for bytes that
 * are not a well-formed GIF up to where the walk stopped.
 */
export function gifShape(bytes: Uint8Array, stopAt = 2): GifShape | undefined {
  const signature = ascii(bytes, 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  if (bytes.length < 13) return undefined;
  /** The offset past a run of data sub-blocks starting at `at`, or undefined past the end. */
  const skipSubBlocks = (at: number): number | undefined => {
    let offset = at;
    while (offset < bytes.length) {
      const size = bytes[offset] as number;
      offset += 1 + size;
      if (size === 0) return offset <= bytes.length ? offset : undefined;
    }
    return undefined;
  };
  const flags = bytes[10] as number;
  let offset = 13 + ((flags & 0x80) !== 0 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  let images = 0;
  let timed = false;
  while (offset < bytes.length) {
    const block = bytes[offset] as number;
    if (block === 0x3b) return { images, timed };
    if (block === 0x21) {
      const label = bytes[offset + 1];
      // A graphic control extension's delay (hundredths of a second), and the looping application extension.
      if (label === 0xf9 && offset + 6 <= bytes.length && ((bytes[offset + 4] as number) | ((bytes[offset + 5] as number) << 8)) > 0)
        timed = true;
      if (label === 0xff && ascii(bytes, offset + 3, offset + 14) === "NETSCAPE2.0") timed = true;
      // An extension: its label, then data sub-blocks.
      const next = skipSubBlocks(offset + 2);
      if (next === undefined) return undefined;
      offset = next;
      continue;
    }
    if (block !== 0x2c) return undefined;
    images += 1;
    if (images >= stopAt) return { images, timed };
    if (offset + 10 > bytes.length) return undefined;
    const local = bytes[offset + 9] as number;
    // The image descriptor (10 bytes), its local colour table, the LZW code size byte, then the image's sub-blocks.
    const next = skipSubBlocks(offset + 10 + ((local & 0x80) !== 0 ? 3 * 2 ** ((local & 0x07) + 1) : 0) + 1);
    if (next === undefined) return undefined;
    offset = next;
  }
  return { images, timed };
}

/** How many images a GIF holds, counting up to `stopAt`; undefined for a malformed one. */
export function gifFrameCount(bytes: Uint8Array, stopAt = 2): number | undefined {
  return gifShape(bytes, stopAt)?.images;
}

/** Whether a GIF is an animation: two images or more, and a delay or a loop that says they play in turn. */
export function gifIsAnimated(bytes: Uint8Array): boolean {
  // The delay or loop may come after the second image's descriptor: the whole file's blocks are walked (linear, no decoding).
  const shape = gifShape(bytes, Number.MAX_SAFE_INTEGER);
  return shape !== undefined && shape.images >= 2 && shape.timed;
}
