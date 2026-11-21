import { execFile } from "node:child_process";
import { closeSync, copyFileSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  isAudioContainer,
  rawFrameBudget,
  sniffAudioContainer,
  VIDEO_LIMITS,
  type AudioFacts,
  type DecodedFrame,
  type MediaContainer,
  type FramePlan,
  type SheetPlan,
  type TimeRange,
  type VideoDecoderFacts,
  type VideoDecoderPort,
  type VideoFacts,
  type VideoInput,
  type VideoResult,
  type VideoRun,
  type VideoSandbox,
  type VideoSourceData,
} from "@tavi/contracts";
import { z } from "zod";

import { decoderFacts, findFfmpeg, type FfmpegPaths, type FindFfmpegOptions } from "./ffmpeg.js";
import { createRunner, type ExecResult, type RunDirectory, VideoOpenError } from "./run.js";
import { SNIFF_BYTES, sniffVideo } from "./sniff.js";
import {
  audioArgs,
  encodeClipArgs,
  FACTS_ARGS,
  frameAtArgs,
  probeArgs,
  rateFramesArgs,
  sheetArgs,
  subtitleArgs,
  timelineArgs,
} from "./templates.js";
import { parseSubRip } from "./subtitles.js";
import { openNoFollowSync, sameIdentity, systemChildEnv } from "@tavi/node-kit";

/**
 * The built-in video decoder: `VideoDecoderPort` over the person's own FFmpeg. Every call
 * that reads a video is one confined, capped run (`run.ts`) of a fixed
 * template (`templates.ts`) in the video's own run directory, and every
 * answer is parsed and bounded here before a field of it is used.
 *
 * The build's facts are read once, at creation, from FFmpeg's own listings:
 * no video is involved, so that read is not confined, and it does not wait
 * for the sandbox's tier.
 */

export interface FfmpegDecoderOptions extends FindFfmpegOptions {
  readonly sandbox: VideoSandbox;
  /** Where run directories are made (`<data>/video/runs`). */
  readonly runsDirectory: string;
  /** The binaries' library closure to reopen inside the denied roots (the owner computes it, `libraryRoots`). */
  readonly readRoots?: (paths: FfmpegPaths) => readonly string[];
  readonly now?: () => number;
  /** The watchdog's sampler (tests replace it). */
  readonly residentKb?: (pid: number) => Promise<number | undefined>;
}

// ------------------------------------------------------------------ probe

const RationalSchema = z.string().max(32).optional();
const TagsSchema = z.record(z.string().max(256), z.unknown()).optional();
const ProbeSchema = z
  .object({
    format: z
      .object({ duration: z.string().max(32).optional(), size: z.string().max(32).optional(), tags: TagsSchema })
      .passthrough()
      .optional(),
    streams: z
      .array(
        z
          .object({
            codec_type: z.string().max(32).optional(),
            codec_name: z.string().max(64).optional(),
            width: z.number().int().optional(),
            height: z.number().int().optional(),
            avg_frame_rate: RationalSchema,
            r_frame_rate: RationalSchema,
            nb_frames: z.string().max(32).optional(),
            nb_read_packets: z.string().max(32).optional(),
            duration: z.string().max(32).optional(),
            channels: z.number().int().optional(),
            sample_rate: z.string().max(16).optional(),
            side_data_list: z
              .array(z.object({ rotation: z.number().optional() }).passthrough())
              .max(16)
              .optional(),
            tags: TagsSchema,
            disposition: z.object({ attached_pic: z.number().optional() }).passthrough().optional(),
          })
          .passthrough(),
      )
      .max(64)
      .optional(),
  })
  .passthrough();

function rational(value: string | undefined): number {
  if (value === undefined) return 0;
  const [num, den] = value.split("/").map(Number);
  if (num === undefined || !Number.isFinite(num)) return 0;
  if (den === undefined) return num;
  return den > 0 && Number.isFinite(den) ? num / den : 0;
}

/** A display matrix's rotation (ffprobe gives (-180, 180]) as a clockwise quarter turn. */
export function quarterTurn(rotation: number | undefined): 0 | 90 | 180 | 270 {
  if (rotation === undefined || !Number.isFinite(rotation)) return 0;
  const normalized = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  return normalized as 0 | 90 | 180 | 270;
}

/** Whether a tag set names a location: present is all that is said, never the value. */
function locationTag(tags: Record<string, unknown> | undefined): boolean {
  return Object.keys(tags ?? {}).some((key) => key.toLowerCase().startsWith("location") || key === "com.apple.quicktime.location.ISO6709");
}

/** A probe's JSON as the facts the tools report, bounded and with no tag but whether there is a location. */
export function probeFacts(json: unknown, input: VideoInput, byteSize: number): VideoFacts | undefined {
  const parsed = ProbeSchema.safeParse(json);
  if (!parsed.success || isAudioContainer(input.container)) return undefined;
  const container = input.container;
  const streams = parsed.data.streams ?? [];
  // A cover picture is not the video.
  const video = streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  if (video === undefined) return undefined;
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const fps = Math.min(1_000, Math.max(0, rational(video.avg_frame_rate) || rational(video.r_frame_rate)));
  const duration = Math.max(0, Number(parsed.data.format?.duration ?? video.duration ?? 0) || 0);
  const frames = Number(video.nb_read_packets ?? video.nb_frames);
  const width = Math.max(0, video.width ?? 0);
  const height = Math.max(0, video.height ?? 0);
  const pixels = width * height;
  const hasLocation = locationTag(parsed.data.format?.tags) || streams.some((stream) => locationTag(stream.tags));
  return {
    sha256: input.sha256,
    container,
    durationSec: Math.round(duration * 1000) / 1000,
    video: {
      codec: (video.codec_name ?? "unknown").slice(0, 32),
      width,
      height,
      fps: Math.round(fps * 1000) / 1000,
      rotation: quarterTurn(video.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation),
      ...(Number.isInteger(frames) && frames >= 0 ? { frames } : {}),
      slowMotion: fps >= 100,
    },
    ...(audio === undefined
      ? {}
      : {
          audio: {
            codec: (audio.codec_name ?? "unknown").slice(0, 32),
            channels: Math.max(0, audio.channels ?? 0),
            sampleRate: Math.max(0, Number(audio.sample_rate ?? 0) || 0),
          },
        }),
    subtitles: streams.filter((stream) => stream.codec_type === "subtitle").length,
    hasLocation,
    withinLimits: {
      frames: duration <= VIDEO_LIMITS.maxDurationSec && pixels <= VIDEO_LIMITS.maxPixels,
      pose: duration <= VIDEO_LIMITS.poseMaxDurationSec && pixels <= VIDEO_LIMITS.maxPixels,
      view: duration <= VIDEO_LIMITS.viewMaxDurationSec && byteSize <= VIDEO_LIMITS.viewMaxBytes,
    },
  };
}

/** An audio file's probe as its facts: its length and its first audio stream, or undefined when it has none. */
function audioProbeFacts(json: unknown, input: VideoInput): AudioFacts | undefined {
  const parsed = ProbeSchema.safeParse(json);
  if (!parsed.success || !isAudioContainer(input.container)) return undefined;
  const audio = (parsed.data.streams ?? []).find((stream) => stream.codec_type === "audio");
  if (audio === undefined) return undefined;
  const duration = Math.max(0, Number(parsed.data.format?.duration ?? audio.duration ?? 0) || 0);
  return {
    sha256: input.sha256,
    container: input.container,
    durationSec: Math.round(duration * 1000) / 1000,
    audio: {
      codec: (audio.codec_name ?? "unknown").slice(0, 32),
      channels: Math.max(0, audio.channels ?? 0),
      sampleRate: Math.max(0, Number(audio.sample_rate ?? 0) || 0),
    },
  };
}

/** The scene timeline's stdout: each sampled frame's time (from the range's start) and scene score. */
export function parseTimeline(output: string, from: number): readonly (readonly [number, number])[] {
  const points: [number, number][] = [];
  let time: number | undefined;
  for (const line of output.split("\n")) {
    const frame = /pts_time:(-?[\d.]+)/.exec(line);
    if (frame !== null) {
      time = Number(frame[1]);
      continue;
    }
    const score = /lavfi\.scd\.score=([\d.]+)/.exec(line);
    if (score !== null && time !== undefined && Number.isFinite(time)) {
      points.push([Math.round((from + Math.max(0, time)) * 1000) / 1000, Math.min(100, Math.max(0, Number(score[1]) || 0))]);
      time = undefined;
    }
  }
  return points;
}

/** A JPEG's size from its frame header (SOF0-SOF15, not DHT, JPG or DAC), without decoding it. */
export function jpegSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] as number;
    const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[at + 5] as number) << 8) | (bytes[at + 6] as number);
      const width = ((bytes[at + 7] as number) << 8) | (bytes[at + 8] as number);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    at += 2 + length;
  }
  return undefined;
}

function readHead(path: string, bytes: number): Uint8Array {
  const buffer = Buffer.alloc(bytes);
  const fd = openSync(path, "r");
  try {
    return buffer.subarray(0, readSync(fd, buffer));
  } finally {
    closeSync(fd);
  }
}

/**
 * An output the confined child wrote, read as the owner trusts it: a regular
 * file with one link, opened without following a link and without blocking
 * (a planted FIFO), and the same file as was checked; its size, and its
 * first `head` bytes. Undefined for anything else.
 */
export function readOutputFile(
  path: string,
  maxBytes: number,
  head = maxBytes,
): { readonly size: number; readonly bytes: Uint8Array } | undefined {
  let checked;
  try {
    checked = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!checked.isFile() || checked.nlink !== 1 || checked.size > maxBytes) return undefined;
  let fd: number;
  try {
    fd = openNoFollowSync(path, "read");
  } catch {
    return undefined;
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(opened, checked) || opened.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(Math.min(head, opened.size));
    let read = 0;
    while (read < buffer.length) {
      const got = readSync(fd, buffer, read, buffer.length - read, read);
      if (got === 0) break;
      read += got;
    }
    return { size: opened.size, bytes: buffer.subarray(0, read) };
  } finally {
    closeSync(fd);
  }
}

/** FFmpeg's diagnostics when it refused a frame past `-max_pixels`. */
function pixelRefusal(stderr: string): boolean {
  return /max pixel|exceeds specified max|image parameters invalid/i.test(stderr);
}

function versionOutputs(
  paths: FfmpegPaths,
): Promise<{ readonly version: string; readonly decoders: string; readonly filters: string; readonly encoders: string }> {
  const read = (args: readonly string[]): Promise<string> =>
    new Promise((done) => {
      execFile(
        paths.ffmpeg,
        [...args],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env: { ...systemChildEnv(), LANG: "C" } },
        (error, stdout) => done(error === null ? stdout : ""),
      );
    });
  return Promise.all([read(FACTS_ARGS.version), read(FACTS_ARGS.decoders), read(FACTS_ARGS.filters), read(FACTS_ARGS.encoders)]).then(
    ([version, decoders, filters, encoders]) => ({ version, decoders, filters, encoders }),
  );
}

/** The decoder over the person's FFmpeg, or one that answers `no-ffmpeg` to every call when none was found. */
export async function createFfmpegDecoder(options: FfmpegDecoderOptions): Promise<VideoDecoderPort> {
  const found = findFfmpeg(options);
  if ("missing" in found) return missingDecoder(found.missing);
  const outputs = await versionOutputs(found);
  if (outputs.version === "") return missingDecoder(`${found.ffmpeg} did not run: is it FFmpeg?`);
  const read = decoderFacts(outputs);
  const unread = (["decoders", "filters", "encoders"] as const).filter((listing) => outputs[listing] === "");
  // A listing that did not come back narrows what the tools offer: said, not silent.
  const facts: VideoDecoderFacts =
    unread.length === 0
      ? read
      : { ...read, warnings: [...read.warnings, `this FFmpeg did not list its ${unread.join(", ")}: what depends on them is off`] };
  const runner = createRunner({
    sandbox: options.sandbox,
    runsDirectory: options.runsDirectory,
    readRoots: options.readRoots?.(found) ?? [],
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.residentKb === undefined ? {} : { residentKb: options.residentKb }),
  });
  const now = options.now ?? Date.now;
  const runs = new Map<string, RunDirectory>();
  const probed = new Map<string, VideoFacts>();
  const has = (feature: VideoDecoderFacts["features"][number]): boolean => facts.features.includes(feature);

  const runOf = (input: VideoInput): RunDirectory | undefined => runs.get(input.path);
  /** Whether `path` is the run directory or inside it. */
  const inRun = (run: RunDirectory, path: string): boolean => {
    const rel = relative(run.path, resolve(path));
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(`..${sep}`));
  };
  /** A fresh directory of this call's own under `out`, a directory inside the run: no call reads another's output. */
  const callDirectory = (run: RunDirectory, out: string): string | undefined => {
    if (!inRun(run, out)) return undefined;
    try {
      const directory = lstatSync(out);
      if (!directory.isDirectory()) return undefined;
      return mkdtempSync(join(resolve(out), "call-"));
    } catch {
      return undefined;
    }
  };

  const failed = <T>(result: Exclude<ExecResult, { readonly ok: true }>): VideoResult<T> => {
    if ("refused" in result) return { ok: false, refused: "refused-recently" };
    if ("failure" in result) return { ok: false, failure: result.failure };
    return { ok: false, refused: pixelRefusal(result.stderr) ? "too-many-pixels" : "unreadable" };
  };

  /** The largest cell a `columns` × `rows` sheet may have, its padding and margins included, within the output's long edge. */
  const sheetCellFit = (columns: number, rows: number): number => {
    const across = Math.max(1, columns, rows);
    return Math.max(1, Math.floor((VIDEO_LIMITS.outputLongEdge - VIDEO_LIMITS.sheetGapPx * (across + 1)) / across));
  };

  /**
   * A run that ended cleanly with output that cannot be read back: the video is refused for a day,
   * so a file that reliably makes FFmpeg answer badly is not run again on every call.
   */
  const badOutput = <T>(input: VideoInput): VideoResult<T> => {
    runner.refuse(input.sha256, "protocol");
    return { ok: false, failure: "protocol" };
  };

  /**
   * A run's ffprobe answer read as facts by `read`, kept per file (`cache`): a video's or an audio file's. `none` is
   * the refusal when `read` finds nothing it reads (no video stream, or no audio one).
   */
  const probeOf = async <T>(
    input: VideoInput,
    cache: Map<string, T>,
    read: (json: unknown) => T | undefined,
    none: Extract<VideoResult<T>, { readonly refused: unknown }>,
  ): Promise<VideoResult<T>> => {
    const known = cache.get(input.sha256);
    if (known !== undefined) return { ok: true, value: known, peakKb: 0, wallMs: 0 };
    const run = runOf(input);
    if (run === undefined) return { ok: false, refused: "unreadable", detail: "no open run for this file" };
    const result = await runner.exec({
      binary: found.ffprobe,
      args: probeArgs(input.path, input.container, VIDEO_LIMITS.maxPixels),
      run,
      timeoutMs: VIDEO_LIMITS.infoTimeoutMs,
      stdoutMaxBytes: VIDEO_LIMITS.probeMaxBytes,
    });
    if (!result.ok) return failed(result);
    let json: unknown;
    try {
      json = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      return badOutput(input);
    }
    const value = read(json);
    if (value === undefined) return none;
    cache.set(input.sha256, value);
    if (cache.size > 64) cache.delete(cache.keys().next().value as string);
    return { ok: true, value, peakKb: result.peakKb, wallMs: result.wallMs };
  };
  const factsOf = (input: VideoInput): Promise<VideoResult<VideoFacts>> =>
    probeOf(input, probed, (json) => probeFacts(json, input, statSync(input.path).size), {
      ok: false,
      refused: "unreadable",
      detail: "the probe found no video stream, or answered out of shape",
    });
  const audioProbed = new Map<string, AudioFacts>();
  const audioFactsOf = (input: VideoInput): Promise<VideoResult<AudioFacts>> =>
    isAudioContainer(input.container)
      ? probeOf(input, audioProbed, (json) => audioProbeFacts(json, input), {
          ok: false,
          refused: "no-audio",
          detail: "the probe found no audio stream",
        })
      : Promise.resolve({ ok: false, refused: "unreadable", detail: "not an audio run: open it with openAudio" });

  /** `source` in a run of its own, as the container `sniff` finds in its head; refused when it finds none. */
  const openAs = (source: VideoSourceData, sniff: (head: Uint8Array) => MediaContainer | undefined): VideoResult<VideoRun> => {
    // Sized before anything is copied: a folder file past the cap is never read whole.
    const size = "bytes" in source ? source.bytes.length : statSync(source.file).size;
    if (size > VIDEO_LIMITS.maxInputBytes)
      return {
        ok: false,
        refused: "too-large",
        detail: `the file is ${String(Math.ceil(size / 1024 / 1024))} MiB; the most is ${String(VIDEO_LIMITS.maxInputBytes / 1024 / 1024)} MiB`,
      };
    const head = "bytes" in source ? source.bytes.subarray(0, SNIFF_BYTES) : readHead(source.file, SNIFF_BYTES);
    const container = sniff(head);
    if (container === undefined) return { ok: false, refused: "not-video" };
    let run: RunDirectory;
    try {
      run = runner.open(source, container);
    } catch (error) {
      if (error instanceof VideoOpenError) return { ok: false, refused: error.refusal, detail: error.message };
      throw error;
    }
    runs.set(run.input.path, run);
    const value: VideoRun = {
      input: run.input,
      directory: run.path,
      readOutput: (path, maxBytes) => (inRun(run, path) ? readOutputFile(resolve(path), maxBytes)?.bytes : undefined),
      dispose: () => {
        runs.delete(run.input.path);
        run.dispose();
      },
    };
    return { ok: true, value, peakKb: 0, wallMs: 0 };
  };

  /** A time inside the clip: one past its last frame is pulled back to it. */
  const within = (value: VideoFacts, time: number): number => {
    const last = Math.max(0, value.durationSec - (value.video.fps > 0 ? 1 / value.video.fps : 0.05));
    return Math.min(Math.max(0, time), last);
  };

  const decoder: VideoDecoderPort = {
    facts: () => facts,

    open: (source: VideoSourceData) => openAs(source, sniffVideo),
    openAudio: (source: VideoSourceData) => openAs(source, sniffAudioContainer),

    probe: factsOf,
    probeAudio: audioFactsOf,

    async frames(input: VideoInput, plan: FramePlan, out: string) {
      const run = runOf(input);
      if (run === undefined) return { ok: false, refused: "unreadable", detail: "no open run for this video" };
      const known = await factsOf(input);
      if (!known.ok) return known;
      const directory = callDirectory(run, out);
      if (directory === undefined)
        return { ok: false, refused: "unreadable", detail: "the output is not a directory in the video's run directory" };
      const started = now();
      let peakKb = known.peakKb;
      if (plan.kind === "times") {
        const frames: DecodedFrame[] = [];
        for (const [index, time] of plan.times.slice(0, VIDEO_LIMITS.framesStoredPerCall).entries()) {
          const remaining = VIDEO_LIMITS.framesTimeoutMs - (now() - started);
          if (remaining <= 0) return { ok: false, failure: "timeout" };
          const path = join(directory, `frame-${String(index)}.jpg`);
          const at = within(known.value, time);
          const result = await runner.exec({
            binary: found.ffmpeg,
            args: frameAtArgs(
              input.path,
              input.container,
              VIDEO_LIMITS.maxPixels,
              at,
              Math.min(plan.longEdge, VIDEO_LIMITS.outputLongEdge),
              path,
            ),
            run,
            timeoutMs: remaining,
            stdoutMaxBytes: 4096,
          });
          if (!result.ok) return failed(result);
          peakKb = Math.max(peakKb, result.peakKb);
          const written = readOutputFile(path, VIDEO_LIMITS.frameMaxBytes, 64 * 1024);
          const size = written === undefined ? undefined : jpegSize(written.bytes);
          // Read back and dimension-checked: a still past the output's long edge is not what was asked for.
          if (size === undefined || Math.max(size.width, size.height) > VIDEO_LIMITS.outputLongEdge) return badOutput(input);
          frames.push({ timeSec: at, path, ...size, format: "jpeg" });
        }
        return { ok: true, value: frames, peakKb, wallMs: now() - started };
      }
      const from = Math.max(0, plan.range.from);
      const to = Math.min(known.value.durationSec, plan.range.to);
      if (to <= from) return { ok: true, value: [], peakKb, wallMs: 0 };
      // Bounded by count (`poseMaxFrames`) and by bytes: raw frames must fit the run's write cap, so a long
      // range is sampled more sparsely, and one that cannot fit even at 1 fps is refused before it runs.
      const { width, frames: budget } = rawFrameBudget(known.value.video, plan.maxWidth);
      const most = Math.min(VIDEO_LIMITS.poseMaxFrames, budget);
      if (most < Math.ceil(to - from))
        return {
          ok: false,
          refused: "too-long",
          detail: `at ${String(width)} px wide, at most ${String(most)} frames fit one run: ask for at most ${String(Math.max(1, most))} s`,
        };
      const fps = Math.max(1, Math.min(plan.fps, Math.floor(most / (to - from))));
      const pattern = join(directory, "frame-%04d.rgb");
      const result = await runner.exec({
        binary: found.ffmpeg,
        args: rateFramesArgs(input.path, input.container, VIDEO_LIMITS.maxPixels, from, to, fps, plan.maxWidth, pattern),
        run,
        timeoutMs: VIDEO_LIMITS.poseTimeoutMs,
        stdoutMaxBytes: 4096,
      });
      if (!result.ok) return failed(result);
      const names = readdirSync(directory, { withFileTypes: true })
        .map((entry) => entry.name)
        .filter((name) => /^frame-\d{4}\.rgb$/.test(name))
        .sort();
      const frames: DecodedFrame[] = [];
      for (const [index, name] of names.entries()) {
        const path = join(directory, name);
        const written = readOutputFile(path, VIDEO_LIMITS.runDirMaxBytes, 0);
        if (written === undefined) return badOutput(input);
        const bytes = written.size;
        const height = bytes / (width * 3);
        // FFmpeg's `-2` rounding is never predicted: the height is what the file holds, whole rows only.
        if (width <= 0 || !Number.isInteger(height) || height <= 0) return badOutput(input);
        frames.push({ timeSec: Math.round((from + index / fps) * 1000) / 1000, path, width, height, format: "rgb24" });
      }
      return { ok: true, value: frames, peakKb: Math.max(peakKb, result.peakKb), wallMs: now() - started };
    },

    async sheet(input: VideoInput, plan: SheetPlan, out: string) {
      const run = runOf(input);
      if (run === undefined) return { ok: false, refused: "unreadable", detail: "no open run for this video" };
      if (!has("tile")) return { ok: false, refused: "missing-feature", detail: "this FFmpeg has no tile filter" };
      const known = await factsOf(input);
      if (!known.ok) return known;
      const directory = callDirectory(run, out);
      if (directory === undefined)
        return { ok: false, refused: "unreadable", detail: "the output is not a directory in the video's run directory" };
      const path = join(directory, "sheet.jpg");
      const times = plan.times.slice(0, VIDEO_LIMITS.sheetMaxCells).map((time) => within(known.value, time));
      if (times.length === 0) return { ok: false, refused: "unreadable", detail: "a sheet needs a time" };
      // The font is a file in the run directory, named relative to it (the child's cwd).
      const font = plan.font !== undefined && has("drawtext") ? plan.font : undefined;
      const result = await runner.exec({
        binary: found.ffmpeg,
        args: sheetArgs(
          input.path,
          input.container,
          VIDEO_LIMITS.maxPixels,
          times,
          plan.columns,
          plan.rows,
          Math.min(plan.cellLongEdge, sheetCellFit(plan.columns, plan.rows)),
          path,
          font,
        ),
        run,
        timeoutMs: VIDEO_LIMITS.framesTimeoutMs,
        stdoutMaxBytes: 4096,
      });
      if (!result.ok) return failed(result);
      const written = readOutputFile(path, VIDEO_LIMITS.frameMaxBytes, 64 * 1024);
      const size = written === undefined ? undefined : jpegSize(written.bytes);
      if (size === undefined || Math.max(size.width, size.height) > VIDEO_LIMITS.outputLongEdge) return badOutput(input);
      return {
        ok: true,
        value: { timeSec: times[0] as number, path, ...size, format: "jpeg" },
        peakKb: result.peakKb,
        wallMs: result.wallMs,
      };
    },

    async timeline(input: VideoInput, range: TimeRange) {
      const run = runOf(input);
      if (run === undefined) return { ok: false, refused: "unreadable", detail: "no open run for this video" };
      if (!has("scdet")) return { ok: false, refused: "missing-feature", detail: "this FFmpeg has no scdet filter" };
      const known = await factsOf(input);
      if (!known.ok) return known;
      const from = Math.max(0, range.from);
      const to = Math.min(known.value.durationSec, range.to);
      if (to <= from) return { ok: true, value: [], peakKb: 0, wallMs: 0 };
      // About 100 bytes a sample: the rate is lowered so the whole range fits the output's cap.
      const fps = Math.max(1, Math.min(VIDEO_LIMITS.timelineMaxFps, Math.floor(VIDEO_LIMITS.timelineMaxBytes / 100 / (to - from))));
      const result = await runner.exec({
        binary: found.ffmpeg,
        args: timelineArgs(input.path, input.container, VIDEO_LIMITS.maxPixels, from, to, fps, 10),
        run,
        timeoutMs: VIDEO_LIMITS.framesTimeoutMs,
        stdoutMaxBytes: VIDEO_LIMITS.timelineMaxBytes,
      });
      if (!result.ok) return failed(result);
      return { ok: true, value: parseTimeline(result.stdout.toString("utf8"), from), peakKb: result.peakKb, wallMs: result.wallMs };
    },

    async audio(input: VideoInput, range: TimeRange, out: string) {
      const run = runOf(input);
      if (run === undefined) return { ok: false, refused: "unreadable", detail: "no open run for this video" };
      if (!has("audio-extract")) return { ok: false, refused: "missing-feature", detail: "this FFmpeg cannot write PCM" };
      // An audio run's facts are its own: it has no video stream for the video probe to find.
      const known = isAudioContainer(input.container) ? await audioFactsOf(input) : await factsOf(input);
      if (!known.ok) return known;
      if (known.value.audio === undefined) return { ok: false, refused: "no-audio" };
      const directory = callDirectory(run, out);
      if (directory === undefined)
        return { ok: false, refused: "unreadable", detail: "the output is not a directory in the video's run directory" };
      const from = Math.max(0, range.from);
      const to = Math.min(known.value.durationSec, range.to);
      const path = join(directory, "audio.wav");
      const result = await runner.exec({
        binary: found.ffmpeg,
        args: audioArgs(input.path, input.container, VIDEO_LIMITS.maxPixels, from, to, path),
        run,
        timeoutMs: VIDEO_LIMITS.transcribeTimeoutMs,
        stdoutMaxBytes: 4096,
      });
      if (!result.ok) return failed(result);
      if (readOutputFile(path, VIDEO_LIMITS.runDirMaxBytes, 0) === undefined) return badOutput(input);
      return { ok: true, value: { path, seconds: Math.max(0, to - from) }, peakKb: result.peakKb, wallMs: result.wallMs };
    },

    async subtitles(input: VideoInput) {
      const run = runOf(input);
      if (run === undefined) return { ok: false, refused: "unreadable", detail: "no open run for this video" };
      const known = await factsOf(input);
      if (!known.ok) return known;
      if (known.value.subtitles === 0) return { ok: true, value: [], peakKb: 0, wallMs: 0 };
      // A long track is text, not a fault of the video: its head is read, never a reason to refuse the video.
      const result = await runner.exec({
        binary: found.ffmpeg,
        args: subtitleArgs(input.path, input.container, VIDEO_LIMITS.maxPixels),
        run,
        timeoutMs: VIDEO_LIMITS.infoTimeoutMs,
        stdoutMaxBytes: VIDEO_LIMITS.subtitlesMaxBytes,
        stdoutPastCap: "keep-head",
      });
      // A track FFmpeg cannot write as text (a bitmap one) is its own refusal, said as such; any other exit is a failed read.
      if (!result.ok && "exitCode" in result)
        return /text to text or bitmap to bitmap/i.test(result.stderr)
          ? { ok: false, refused: "unreadable", detail: "the video's subtitle track is not text (a bitmap track cannot be read)" }
          : { ok: false, refused: "unreadable", detail: "FFmpeg could not read the video's subtitle track" };
      if (!result.ok) return failed(result);
      const text = result.stdout.toString("utf8");
      // Cut at the cap: the last block may be cut too, so it is dropped rather than read half.
      const whole = result.truncated === true ? text.slice(0, Math.max(0, text.lastIndexOf("\n\n"))) : text;
      return { ok: true, value: parseSubRip(whole), peakKb: result.peakKb, wallMs: result.wallMs };
    },

    async encodeClip(
      frames: readonly Uint8Array[],
      size: { readonly width: number; readonly height: number; readonly fps: number },
      out: string,
    ) {
      const frameBytes = size.width * size.height * 3;
      if (frames.length === 0 || frames.some((frame) => frame.length !== frameBytes))
        return { ok: false, refused: "unreadable", detail: "each frame is width × height × 3 bytes" };
      const h264 = has("h264-encoder");
      if (!h264 && !has("mpeg4-encoder"))
        return { ok: false, refused: "missing-feature", detail: "this FFmpeg has neither libx264 nor mpeg4" };
      const scratch = runner.scratch(
        "clip.rgb",
        Buffer.concat(frames.map((frame) => Buffer.from(frame.buffer, frame.byteOffset, frame.length))),
      );
      try {
        const encoded = join(scratch.path, "probe.mp4");
        const result = await runner.exec({
          binary: found.ffmpeg,
          args: encodeClipArgs(scratch.input.path, size.width, size.height, size.fps, h264, encoded),
          run: scratch,
          timeoutMs: VIDEO_LIMITS.framesTimeoutMs,
          stdoutMaxBytes: 4096,
        });
        if (!result.ok) return failed(result);
        const written = readOutputFile(encoded, VIDEO_LIMITS.viewMaxBytes, SNIFF_BYTES);
        if (written === undefined || sniffVideo(written.bytes) !== "mp4") return { ok: false, failure: "protocol" };
        copyFileSync(encoded, out);
        return { ok: true, value: out, peakKb: result.peakKb, wallMs: result.wallMs };
      } finally {
        scratch.dispose();
      }
    },

    close: async () => {
      await runner.close();
      for (const run of runs.values()) run.dispose();
      runs.clear();
    },
  };
  return decoder;
}

/** No FFmpeg: every call is refused with the install hint. */
function missingDecoder(missing: string): VideoDecoderPort {
  const refused = { ok: false as const, refused: "no-ffmpeg" as const, detail: missing };
  return {
    facts: () => ({ missing }),
    open: () => refused,
    openAudio: () => refused,
    probe: async () => refused,
    probeAudio: async () => refused,
    frames: async () => refused,
    sheet: async () => refused,
    timeline: async () => refused,
    audio: async () => refused,
    subtitles: async () => refused,
    encodeClip: async () => refused,
    close: async () => undefined,
  };
}
