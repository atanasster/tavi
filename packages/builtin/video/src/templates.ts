import { VIDEO_LIMITS, type VideoContainer } from "@tavi/contracts";

import { demuxerOf } from "./sniff.js";

/**
 * Every FFmpeg and ffprobe argument list the decoder runs: fixed
 * templates with only validated numbers and run-directory paths filled in,
 * never a shell, verified against FFmpeg 9.0.2 on synthetic clips.
 *
 * Every input is read by the sniffed demuxer alone (`-f`), from a file
 * (`-protocol_whitelist file`), among the video demuxers only, with its
 * frames capped in pixels: FFmpeg never probes for a format, follows a
 * reference, or opens a network protocol.
 */

/** The video demuxers FFmpeg may open at all, by their own names. */
export const FORMAT_WHITELIST = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,gif";

/** A number as an argument: finite, never exponent notation, millisecond precision for times. */
export function argSeconds(value: number): string {
  // `SecondsSchema`'s range: within it `toFixed` never writes an exponent.
  if (!Number.isFinite(value) || value < 0 || value > 36_000) throw new RangeError(`not a time: ${String(value)}`);
  return value.toFixed(3);
}

function argInteger(value: number, min: number, max: number): string {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`out of range: ${String(value)}`);
  return String(value);
}

/** Options both binaries take, placed before `-i` so `-f` and `-max_pixels` bind to the input. */
export function commonInputOptions(container: VideoContainer, maxPixels: number): readonly string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    FORMAT_WHITELIST,
    "-threads",
    "1",
    "-f",
    demuxerOf(container),
    "-max_pixels",
    argInteger(maxPixels, 1, 2 ** 30),
  ];
}

/** `ffmpeg`-only global options: `ffprobe` 9.0.2 refuses each with "Option not found". */
export const FFMPEG_ONLY = ["-nostdin", "-filter_threads", "1", "-filter_complex_threads", "1"] as const;

function ffmpegInput(container: VideoContainer, maxPixels: number): readonly string[] {
  return [...commonInputOptions(container, maxPixels), ...FFMPEG_ONLY];
}

/**
 * Full-range YUV for the JPEG encoder: FFmpeg picks limited-range YUV for an
 * RGB or palette source (a GIF), which `mjpeg` refuses ("Non full-range YUV
 * is non-standard").
 */
const JPEG_RANGE = "format=yuvj420p";

/** A scale to at most `longEdge` on the longer side, after auto-rotation, never upscaling; the other side even. */
export function scaleLongEdge(longEdge: number): string {
  const edge = argInteger(longEdge, 16, 8192);
  return `scale='if(gte(iw,ih),min(iw,${edge}),-2)':'if(gte(iw,ih),-2,min(ih,${edge}))'`;
}

/** The facts' JSON: format and streams, packets counted, as `probeFacts` reads them. */
export function probeArgs(input: string, container: VideoContainer, maxPixels: number): readonly string[] {
  return [
    ...commonInputOptions(container, maxPixels),
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-count_packets",
    "-i",
    input,
  ];
}

/** One still at `timeSec` as JPEG. `-ss` before `-i` seeks to the keyframe and decodes forward; the frame's time is `timeSec`, not read back. */
export function frameAtArgs(
  input: string,
  container: VideoContainer,
  maxPixels: number,
  timeSec: number,
  longEdge: number,
  out: string,
): readonly string[] {
  return [
    ...ffmpegInput(container, maxPixels),
    "-ss",
    argSeconds(timeSec),
    "-i",
    input,
    "-an",
    "-sn",
    "-dn",
    "-frames:v",
    "1",
    "-vf",
    `${scaleLongEdge(longEdge)},${JPEG_RANGE}`,
    "-c:v",
    "mjpeg",
    "-q:v",
    "3",
    "-f",
    "image2",
    out,
  ];
}

/**
 * The scene timeline: frames sampled at `fps` over the range, each one's
 * scene score printed to stdout by the `metadata` filter (`scdet` itself logs
 * only at info level, silent under `-loglevel error`); only the score key is
 * printed, so the output fits its cap.
 */
export function timelineArgs(
  input: string,
  container: VideoContainer,
  maxPixels: number,
  from: number,
  to: number,
  fps: number,
  threshold: number,
): readonly string[] {
  return [
    ...ffmpegInput(container, maxPixels),
    "-ss",
    argSeconds(from),
    "-t",
    argSeconds(Math.max(0, to - from)),
    "-i",
    input,
    "-an",
    "-sn",
    "-dn",
    "-vf",
    `fps=${argInteger(fps, 1, 30)},scale=320:-2,scdet=threshold=${argInteger(threshold, 1, 100)},metadata=mode=print:key=lavfi.scd.score:file=-`,
    "-f",
    "null",
    "-",
  ];
}

/**
 * A contact sheet: the first frame at or after each time (relative to the
 * seek to the first), scaled, labelled with its time when a font is given
 * (`drawtext`), tiled `columns` × `rows`; a partial last tile is flushed at
 * the end of input.
 */
export function sheetArgs(
  input: string,
  container: VideoContainer,
  maxPixels: number,
  times: readonly number[],
  columns: number,
  rows: number,
  cellLongEdge: number,
  out: string,
  font?: string,
): readonly string[] {
  if (times.length === 0) throw new RangeError("a sheet needs a time");
  // The font is a file the owner wrote into the run directory (the child's cwd), named so it needs no escaping in the filter.
  if (font !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(font))
    throw new RangeError("a sheet's font is a plain file name in the run directory");
  const start = Math.min(...times);
  const terms = [...times]
    .sort((a, b) => a - b)
    .map((time) => {
      const at = argSeconds(time - start);
      return `gte(t\\,${at})*(isnan(prev_selected_t)+lt(prev_selected_t\\,${at}))`;
    });
  const label =
    font === undefined
      ? ""
      : `,drawtext=fontfile=${font}:text='%{pts\\:hms\\:${argSeconds(start)}}':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`;
  const filter = `select='${terms.join("+")}',${scaleLongEdge(cellLongEdge)}${label},tile=${argInteger(columns, 1, 9)}x${argInteger(rows, 1, 9)}:padding=${String(VIDEO_LIMITS.sheetGapPx)}:margin=${String(VIDEO_LIMITS.sheetGapPx)},${JPEG_RANGE}`;
  const span = Math.max(...times) - start + 1;
  return [
    ...ffmpegInput(container, maxPixels),
    "-ss",
    argSeconds(start),
    "-t",
    argSeconds(span),
    "-i",
    input,
    "-an",
    "-sn",
    "-dn",
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-c:v",
    "mjpeg",
    "-q:v",
    "3",
    "-f",
    "image2",
    out,
  ];
}

/**
 * Every frame at `fps` over the range as raw `rgb24`, one file per frame
 * (`-f image2` is required: without it every frame lands in one file), at
 * most `maxWidth` wide and never upscaled. FFmpeg auto-rotates first, so
 * the frames are upright; their height is read from each file's size.
 */
export function rateFramesArgs(
  input: string,
  container: VideoContainer,
  maxPixels: number,
  from: number,
  to: number,
  fps: number,
  maxWidth: number,
  pattern: string,
): readonly string[] {
  return [
    ...ffmpegInput(container, maxPixels),
    "-ss",
    argSeconds(from),
    "-t",
    argSeconds(Math.max(0, to - from)),
    "-i",
    input,
    "-an",
    "-sn",
    "-dn",
    "-vf",
    `fps=${argInteger(fps, 1, 30)},scale='min(${argInteger(maxWidth, 16, 4096)},iw)':-2`,
    "-pix_fmt",
    "rgb24",
    "-f",
    "image2",
    "-c:v",
    "rawvideo",
    pattern,
  ];
}

/** 16 kHz mono 16-bit WAV of the range (only when the probe found audio: otherwise FFmpeg fails with no stream). */
export function audioArgs(
  input: string,
  container: VideoContainer,
  maxPixels: number,
  from: number,
  to: number,
  out: string,
): readonly string[] {
  return [
    ...ffmpegInput(container, maxPixels),
    "-ss",
    argSeconds(from),
    "-t",
    argSeconds(Math.max(0, to - from)),
    "-i",
    input,
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    out,
  ];
}

/**
 * The first subtitle track as SubRip on stdout: text tracks only (a bitmap
 * one fails to convert, and FFmpeg says so), nothing else decoded.
 */
export function subtitleArgs(input: string, container: VideoContainer, maxPixels: number): readonly string[] {
  return [...ffmpegInput(container, maxPixels), "-i", input, "-map", "0:s:0", "-vn", "-an", "-dn", "-c:s", "srt", "-f", "srt", "-"];
}

/**
 * The native-video probe's clip, from raw `rgb24` frames the owner wrote:
 * not the common input options (the whitelists refuse `rawvideo` and
 * `pipe:`), only the raw file. H.264 where the build has libx264, MPEG-4
 * Part 2 otherwise.
 */
export function encodeClipArgs(raw: string, width: number, height: number, fps: number, h264: boolean, out: string): readonly string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-threads",
    "1",
    "-protocol_whitelist",
    "file",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-video_size",
    `${argInteger(width, 16, 4096)}x${argInteger(height, 16, 4096)}`,
    "-framerate",
    argInteger(fps, 1, 60),
    "-i",
    raw,
    "-c:v",
    h264 ? "libx264" : "mpeg4",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    out,
  ];
}

/** What a build is: each listing read once at discovery. */
export const FACTS_ARGS = {
  version: ["-hide_banner", "-version"],
  decoders: ["-hide_banner", "-decoders"],
  filters: ["-hide_banner", "-filters"],
  encoders: ["-hide_banner", "-encoders"],
} as const satisfies Record<string, readonly string[]>;
