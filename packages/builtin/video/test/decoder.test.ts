import { spawnSync } from "node:child_process";
import { linkSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { VIDEO_LIMITS, type VideoDecoderPort, type VideoInput } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createFfmpegDecoder, jpegSize, parseTimeline, probeFacts, quarterTurn, readOutputFile } from "../src/decoder.js";
import { findFfmpeg } from "../src/ffmpeg.js";

const input: VideoInput = { path: "/r/in.mov", sha256: "a".repeat(64), container: "mov" };

describe("reading an output the child wrote", () => {
  const temp = temporaryDirectories();
  afterEach(() => temp.cleanup());

  it("reads only a regular, singly linked file, never through a link or from a FIFO", () => {
    const directory = temp.create("tavi-video-outputs-");
    const real = join(directory, "frame-0.jpg");
    writeFileSync(real, Buffer.from([0xff, 0xd8, 1, 2, 3]));
    expect(readOutputFile(real, 100)).toMatchObject({ size: 5 });
    expect([...(readOutputFile(real, 100)?.bytes ?? [])]).toEqual([0xff, 0xd8, 1, 2, 3]);
    expect(readOutputFile(real, 4)).toBeUndefined();
    const secret = join(directory, "secret.txt");
    writeFileSync(secret, "TAVI-SECRET");
    symlinkSync(secret, join(directory, "frame-1.jpg"));
    expect(readOutputFile(join(directory, "frame-1.jpg"), 100)).toBeUndefined();
    linkSync(secret, join(directory, "frame-2.jpg"));
    expect(readOutputFile(join(directory, "frame-2.jpg"), 100)).toBeUndefined();
    const fifo = join(directory, "frame-3.jpg");
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
    expect(readOutputFile(fifo, 100)).toBeUndefined();
    expect(readOutputFile(join(directory, "missing"), 100)).toBeUndefined();
  });
});

describe("reading FFmpeg's answers", () => {
  it("turns a probe into bounded facts, the location's presence and never its value", () => {
    const facts = probeFacts(
      {
        format: {
          duration: "4.000000",
          size: "267096",
          tags: { major_brand: "qt  ", location: "+48.8584+002.2945/", "location-eng": "+48.8584+002.2945/" },
        },
        streams: [
          {
            codec_type: "video",
            codec_name: "hevc",
            width: 640,
            height: 360,
            avg_frame_rate: "30/1",
            nb_read_packets: "120",
            side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
          },
          { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
          { codec_type: "subtitle", codec_name: "mov_text" },
        ],
      },
      input,
      267_096,
    );
    expect(facts).toEqual({
      sha256: input.sha256,
      container: "mov",
      durationSec: 4,
      video: { codec: "hevc", width: 640, height: 360, fps: 30, rotation: 270, frames: 120, slowMotion: false },
      audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
      subtitles: 1,
      hasLocation: true,
      withinLimits: { frames: true, pose: true, view: true },
    });
    expect(JSON.stringify(facts)).not.toContain("48.8584");
    // A cover picture alone is no video.
    expect(
      probeFacts({ streams: [{ codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }] }, input, 1),
    ).toBeUndefined();
    expect(probeFacts("not json at all", input, 1)).toBeUndefined();
    // Past the limits: ten hours, 16k pixels, a 240 fps capture.
    const long = probeFacts(
      {
        format: { duration: "36000" },
        streams: [{ codec_type: "video", codec_name: "h264", width: 16_384, height: 1_088, r_frame_rate: "240/1" }],
      },
      input,
      1,
    );
    expect(long?.withinLimits).toEqual({ frames: false, pose: false, view: false });
    expect(long?.video.slowMotion).toBe(true);
  });

  it("reads rotations, the timeline, and a JPEG's size", () => {
    expect([quarterTurn(90), quarterTurn(-90), quarterTurn(-180), quarterTurn(180), quarterTurn(0), quarterTurn(undefined)]).toEqual([
      90, 270, 180, 180, 0, 0,
    ]);
    const out =
      "frame:0    pts:0       pts_time:0\nlavfi.scd.mafd=0.000\nlavfi.scd.score=0.000\nframe:1    pts:1       pts_time:0.2\nlavfi.scd.score=22.166\nlavfi.scd.time=0.2\n";
    expect(parseTimeline(out, 10)).toEqual([
      [10, 0],
      [10.2, 22.166],
    ]);
    expect(parseTimeline("garbage\nlavfi.scd.score=5\n", 0)).toEqual([]);
    const sof = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x40, 0x00, 0xf0, 3, 0, 0, 0]);
    expect(jpegSize(sof)).toEqual({ width: 240, height: 320 });
    expect(jpegSize(Buffer.from("not a jpeg"))).toBeUndefined();
  });

  it("answers no-ffmpeg to every call when none is found", async () => {
    const decoder = await createFfmpegDecoder({ sandbox: { kind: "none" }, runsDirectory: "/nonexistent", path: "", exists: () => false });
    expect(decoder.facts()).toMatchObject({ missing: expect.stringContaining("install FFmpeg") });
    expect(decoder.open({ bytes: new Uint8Array([1, 2, 3]) })).toMatchObject({ ok: false, refused: "no-ffmpeg" });
    expect(await decoder.probe(input)).toMatchObject({ ok: false, refused: "no-ffmpeg" });
  });
});

const found = findFfmpeg();
describe.skipIf("missing" in found)("the decoder on FFmpeg itself", () => {
  let root = "";
  let decoder: VideoDecoderPort;
  let clip = "";
  let rotated = "";
  let silent = "";
  const ffmpeg = (found as { readonly ffmpeg: string }).ffmpeg;
  const make = (args: readonly string[]): void => {
    const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    expect(result.status, result.stderr.toString()).toBe(0);
  };
  const temp = temporaryDirectories();
  beforeAll(async () => {
    root = temp.create("tavi-video-decoder-");
    clip = join(root, "clip.mp4");
    rotated = join(root, "rotated.mov");
    silent = join(root, "silent.mp4");
    make([
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x240:r=10:d=2",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x240:r=10:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:d=4",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1[v]",
      "-map",
      "[v]",
      "-map",
      "2:a",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      clip,
    ]);
    make(["-display_rotation", "90", "-i", clip, "-c", "copy", rotated]);
    make(["-f", "lavfi", "-i", "testsrc2=s=160x120:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    decoder = await createFfmpegDecoder({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs") });
  });
  afterAll(async () => {
    await decoder.close();
    temp.cleanup();
  });

  it("reads a text subtitle track as cues, markup gone, and none from a video without one", async () => {
    const captions = join(root, "captions.srt");
    writeFileSync(
      captions,
      "1\n00:00:00,500 --> 00:00:01,250\n<i>Hello</i> there\n\n2\n00:00:02,000 --> 00:00:03,000\n{\\an8}SEND THE FILES\n",
    );
    const subtitled = join(root, "subtitled.mp4");
    make([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x120:r=10:d=4",
      "-i",
      captions,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:s",
      "mov_text",
      subtitled,
    ]);
    const opened = decoder.open({ file: subtitled });
    if (!opened.ok) throw new Error("not opened");
    try {
      expect(await decoder.subtitles(opened.value.input)).toMatchObject({
        ok: true,
        value: [
          { startSec: 0.5, endSec: 1.25, text: "Hello there" },
          { startSec: 2, endSec: 3, text: "SEND THE FILES" },
        ],
      });
    } finally {
      opened.value.dispose();
    }
    const plain = decoder.open({ file: silent });
    if (!plain.ok) throw new Error("not opened");
    try {
      expect(await decoder.subtitles(plain.value.input)).toMatchObject({ ok: true, value: [] });
    } finally {
      plain.value.dispose();
    }
  });

  it("knows its build", () => {
    const facts = decoder.facts();
    expect(facts).toMatchObject({
      kind: "ffmpeg",
      decoders: expect.arrayContaining(["h264"]),
      features: expect.arrayContaining(["scdet", "tile"]),
    });
  });

  it("refuses what is not a video before a run, and an output outside its run directory", async () => {
    expect(decoder.open({ bytes: new TextEncoder().encode("#EXTM3U\n") })).toMatchObject({ ok: false, refused: "not-video" });
    const opened = decoder.open({ file: clip });
    if (!opened.ok) throw new Error("not opened");
    expect(await decoder.frames(opened.value.input, { kind: "times", times: [1], longEdge: 320 }, root)).toMatchObject({
      ok: false,
      refused: "unreadable",
    });
    opened.value.dispose();
  });

  it("probes, takes stills, a sheet, the cut, and the audio", async () => {
    const opened = decoder.open({ file: clip });
    if (!opened.ok) throw new Error("not opened");
    const run = opened.value;
    const facts = await decoder.probe(run.input);
    expect(facts).toMatchObject({
      ok: true,
      value: {
        container: "mp4",
        durationSec: expect.closeTo(4, 0),
        video: { codec: "h264", width: 320, height: 240, fps: 10, rotation: 0 },
        audio: { codec: "aac" },
      },
    });
    const stills = await decoder.frames(run.input, { kind: "times", times: [0.5, 3, 99], longEdge: 160 }, run.directory);
    expect(stills.ok, JSON.stringify(stills)).toBe(true);
    if (stills.ok) {
      // A time past the end is the last frame's, and says so.
      expect(stills.value.map((frame) => [frame.timeSec, frame.width, frame.height, frame.format])).toEqual([
        [0.5, 160, 120, "jpeg"],
        [3, 160, 120, "jpeg"],
        [3.9, 160, 120, "jpeg"],
      ]);
      expect(readFileSync(stills.value[0]?.path as string).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    }
    const sheet = await decoder.sheet(run.input, { times: [0.5, 1.5, 2.5, 3.5], columns: 2, rows: 2, cellLongEdge: 160 }, run.directory);
    expect(sheet).toMatchObject({ ok: true, value: { width: 160 * 2 + 12, format: "jpeg" } });
    const timeline = await decoder.timeline(run.input, { from: 0, to: 4 });
    expect(timeline.ok).toBe(true);
    if (timeline.ok) {
      const cut = timeline.value.reduce((best, point) => (point[1] > best[1] ? point : best));
      expect(cut[0]).toBeCloseTo(2, 0);
    }
    const audio = await decoder.audio(run.input, { from: 0, to: 2 }, run.directory);
    expect(audio).toMatchObject({ ok: true, value: { seconds: 2 } });
    run.dispose();
  });

  it("refuses for a day a video whose run answered out of protocol, and clamps what it is asked for to the output's edge", async () => {
    // An ffprobe that exits cleanly with output that is not its JSON: the system's echo, standing in for a probe
    // that a hostile file makes answer badly.
    const own = await createFfmpegDecoder({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-refused"), ffprobe: "/bin/echo" });
    const opened = own.open({ file: clip });
    if (!opened.ok) throw new Error("not opened");
    try {
      expect(await own.probe(opened.value.input)).toEqual({ ok: false, failure: "protocol" });
      // The video is then refused for a day, by every call.
      expect(await own.timeline(opened.value.input, { from: 0, to: 1 })).toMatchObject({ ok: false, refused: "refused-recently" });
    } finally {
      opened.value.dispose();
      await own.close();
    }
    // A caller that asks for more than the output may be gets the output's edge, not a refusal.
    const hd = join(root, "hd.mp4");
    make(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=10:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", hd]);
    const big = decoder.open({ file: hd });
    if (!big.ok) throw new Error("not opened");
    try {
      const still = await decoder.frames(big.value.input, { kind: "times", times: [0.5], longEdge: 1920 }, big.value.directory);
      expect(still).toMatchObject({ ok: true, value: [{ width: VIDEO_LIMITS.outputLongEdge }] });
      const sheet = await decoder.sheet(
        big.value.input,
        { times: [0.1, 0.5], columns: 2, rows: 1, cellLongEdge: 1920 },
        big.value.directory,
      );
      expect(sheet.ok).toBe(true);
      if (sheet.ok) expect(sheet.value.width).toBeLessThanOrEqual(VIDEO_LIMITS.outputLongEdge);
    } finally {
      big.value.dispose();
    }
  }, 60_000);

  it("keeps the longest clip's scene timeline (10 minutes at 60 fps) inside its stdout cap, at its most samples a second", async () => {
    const long = join(root, "long-60fps.mp4");
    make(["-f", "lavfi", "-i", "testsrc2=s=64x48:r=60:d=600", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", long]);
    const opened = decoder.open({ file: long });
    if (!opened.ok) throw new Error("not opened");
    try {
      const timeline = await decoder.timeline(opened.value.input, { from: 0, to: 600 });
      expect(timeline.ok, JSON.stringify(timeline).slice(0, 300)).toBe(true);
      if (timeline.ok) {
        // The whole range at the timeline's most samples a second, which the cap holds at the longest a video may be.
        expect(timeline.value.length).toBeGreaterThanOrEqual(600 * VIDEO_LIMITS.timelineMaxFps - 10);
        expect(timeline.value.length).toBeLessThanOrEqual(VIDEO_LIMITS.timelineMaxBytes / 100);
        expect(timeline.value.at(-1)?.[0]).toBeGreaterThan(590);
      }
    } finally {
      opened.value.dispose();
    }
  }, 180_000);

  it("decodes rotated frames upright, at a rate, their height read from the files", async () => {
    const opened = decoder.open({ file: rotated });
    if (!opened.ok) throw new Error("not opened");
    const facts = await decoder.probe(opened.value.input);
    expect(facts).toMatchObject({ ok: true, value: { video: { width: 320, height: 240, rotation: 90 } } });
    const frames = await decoder.frames(
      opened.value.input,
      { kind: "rate", fps: 10, range: { from: 0, to: 1 }, maxWidth: 640 },
      opened.value.directory,
    );
    expect(frames.ok, JSON.stringify(frames)).toBe(true);
    if (frames.ok) {
      expect(frames.value.length).toBeGreaterThanOrEqual(9);
      // 240 wide (never upscaled to 640), 320 high: rotated before scaling, as FFmpeg does.
      expect(frames.value[0]).toMatchObject({ width: 240, height: 320, format: "rgb24", timeSec: 0 });
      expect(frames.value[1]?.timeSec).toBeCloseTo(0.1, 5);
    }
    opened.value.dispose();
  });

  it("says no-audio for a silent clip, and encodes the probe clip", async () => {
    const opened = decoder.open({ file: silent });
    if (!opened.ok) throw new Error("not opened");
    expect(await decoder.audio(opened.value.input, { from: 0, to: 1 }, opened.value.directory)).toMatchObject({
      ok: false,
      refused: "no-audio",
    });
    opened.value.dispose();
    const frame = new Uint8Array(32 * 32 * 3).fill(200);
    const out = join(root, "probe.mp4");
    expect(await decoder.encodeClip([frame, frame, frame, frame], { width: 32, height: 32, fps: 4 }, out)).toMatchObject({
      ok: true,
      value: out,
    });
    expect(readFileSync(out).subarray(4, 8).toString()).toBe("ftyp");
    expect(await decoder.encodeClip([new Uint8Array(5)], { width: 32, height: 32, fps: 4 }, out)).toMatchObject({
      ok: false,
      refused: "unreadable",
    });
  });

  it("gives each call its own outputs, never another call's", async () => {
    const opened = decoder.open({ file: clip });
    if (!opened.ok) throw new Error("not opened");
    const first = await decoder.frames(opened.value.input, { kind: "times", times: [0.5], longEdge: 320 }, opened.value.directory);
    const second = await decoder.frames(opened.value.input, { kind: "times", times: [3], longEdge: 160 }, opened.value.directory);
    if (!first.ok || !second.ok) throw new Error("no frames");
    expect(first.value[0]?.path).not.toBe(second.value[0]?.path);
    expect([first.value[0]?.width, second.value[0]?.width]).toEqual([320, 160]);
    // The owner reads an output only as a regular file inside the run.
    expect([...(opened.value.readOutput(second.value[0]?.path as string, 5_000_000)?.subarray(0, 2) ?? [])]).toEqual([0xff, 0xd8]);
    expect(opened.value.readOutput(clip, 5_000_000)).toBeUndefined();
    opened.value.dispose();
  });

  it("samples a long rate range more sparsely so its raw frames fit the run, and refuses one that cannot", async () => {
    const long = join(root, "long.mp4");
    make(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=10:d=30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", long]);
    const opened = decoder.open({ file: long });
    if (!opened.ok) throw new Error("not opened");
    const frames = await decoder.frames(
      opened.value.input,
      { kind: "rate", fps: 10, range: { from: 0, to: 30 }, maxWidth: 640 },
      opened.value.directory,
    );
    expect(frames.ok, JSON.stringify(frames)).toBe(true);
    // 640×360×3 bytes a frame: about 87 fit 90% of 64 MiB, so 2 fps over 30 s.
    if (frames.ok) expect(frames.value.length).toBeLessThanOrEqual(87);
    opened.value.dispose();
    const wide = join(root, "wide.mp4");
    make(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=1:d=200", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", wide]);
    const second = decoder.open({ file: wide });
    if (!second.ok) throw new Error("not opened");
    expect(
      await decoder.frames(
        second.value.input,
        { kind: "rate", fps: 10, range: { from: 0, to: 200 }, maxWidth: 640 },
        second.value.directory,
      ),
    ).toMatchObject({ ok: false, refused: "too-long" });
    second.value.dispose();
  });

  it("refuses a frame past the pixel cap as too many pixels", async () => {
    const big = join(root, "big.mp4");
    make(["-f", "lavfi", "-i", "color=c=gray:s=16384x1088:r=1:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", big]);
    const opened = decoder.open({ file: big });
    if (!opened.ok) throw new Error("not opened");
    expect(await decoder.probe(opened.value.input)).toMatchObject({ ok: false, refused: "too-many-pixels" });
    opened.value.dispose();
  });
});
