import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { VideoLaunch, VideoSandbox } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findFfmpeg } from "../src/ffmpeg.js";
import { createRunner, type RunDirectory, VideoOpenError } from "../src/run.js";
import { sniffVideo } from "../src/sniff.js";
import {
  audioArgs,
  commonInputOptions,
  encodeClipArgs,
  FFMPEG_ONLY,
  frameAtArgs,
  probeArgs,
  rateFramesArgs,
  sheetArgs,
  timelineArgs,
} from "../src/templates.js";

let root = "";
const temp = temporaryDirectories();
beforeAll(() => {
  root = temp.create("tavi-video-run-");
});
afterAll(() => temp.cleanup());

const node = process.execPath;

describe("the argv templates", () => {
  it("fills in only validated numbers and run-directory paths, never a shell", () => {
    const common = commonInputOptions("mov", 4096 * 4096);
    expect(common).toEqual(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,gif",
        "-threads",
        "1",
        "-f",
        "matroska",
        "-max_pixels",
        "16777216",
      ].map((arg, index) => (index === 10 ? "mov" : arg)),
    );
    // ffprobe never receives the ffmpeg-only options it refuses.
    for (const option of FFMPEG_ONLY.filter((arg) => arg.startsWith("-"))) expect(probeArgs("/r/in.mp4", "mp4", 100)).not.toContain(option);
    expect(frameAtArgs("/r/in.mp4", "mp4", 100, 1.5, 1568, "/r/f.jpg")).toEqual(
      expect.arrayContaining(["-nostdin", "-ss", "1.500", "-c:v", "mjpeg", "-f", "image2"]),
    );
    // Every time and count is validated: no expression, exponent or negative reaches the filter.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => frameAtArgs("/r/in", "mp4", 100, bad, 1568, "/r/f.jpg")).toThrow(RangeError);
    expect(() => timelineArgs("/r/in", "mp4", 100, 0, 10, 0.5, 10)).toThrow(RangeError);
    expect(() => sheetArgs("/r/in", "mp4", 100, [1], 3, 3, 400, "/r/s.jpg", "../etc/font.ttf")).toThrow(RangeError);
    expect(() => sheetArgs("/r/in", "mp4", 100, [], 3, 3, 400, "/r/s.jpg")).toThrow(RangeError);
    expect(() => frameAtArgs("/r/in", "mp4", 100, 1e21, 1568, "/r/f.jpg")).toThrow(RangeError);
    // A property: across many inputs, every argument is a fixed token, a run-directory path, or a number.
    for (let seed = 0; seed < 200; seed += 1) {
      const t = (seed * 7.31) % 600;
      const args = [
        ...frameAtArgs("/r/in.mov", "mov", 1000 + seed, t, 64 + seed, "/r/out.jpg"),
        ...timelineArgs("/r/in.mov", "mov", 1000, t, t + 5, 1 + (seed % 5), 1 + (seed % 90)),
        ...rateFramesArgs("/r/in.mov", "mov", 1000, t, t + 3, 5 + (seed % 20), 640, "/r/f-%04d.rgb"),
        ...sheetArgs("/r/in.mov", "mov", 1000, [t, t + 1, t + 2], 3, 1, 320, "/r/s.jpg", seed % 2 === 0 ? "font.ttf" : undefined),
        ...audioArgs("/r/in.mov", "mov", 1000, t, t + 30, "/r/a.wav"),
      ];
      for (const arg of args) expect(arg, arg).not.toMatch(/[;`$|&<>]|\.\.|\n/);
    }
  });

  it("encodes the probe clip from a raw file, outside the whitelisted demuxers", () => {
    const args = encodeClipArgs("/r/clip.rgb", 320, 240, 4, true, "/r/probe.mp4");
    expect(args).toEqual(expect.arrayContaining(["-f", "rawvideo", "-video_size", "320x240", "-c:v", "libx264"]));
    expect(args).not.toContain("-format_whitelist");
    expect(encodeClipArgs("/r/clip.rgb", 320, 240, 4, false, "/r/probe.mp4")).toContain("mpeg4");
  });
});

describe("one confined, capped run per call", () => {
  const open = (runner: ReturnType<typeof createRunner>, text = "GIF89a"): RunDirectory =>
    runner.open({ bytes: new TextEncoder().encode(text) }, "gif");

  it("copies the input read-only into a fresh 0700 directory, and removes it whole", () => {
    const runner = createRunner({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-a") });
    const run = open(runner);
    expect(statSync(run.path).mode & 0o777).toBe(0o700);
    expect(statSync(run.input.path).mode & 0o777).toBe(0o400);
    expect(statSync(run.input.path).nlink).toBe(1);
    expect(run.input.sha256).toMatch(/^[0-9a-f]{64}$/);
    run.dispose();
    expect(existsSync(run.path)).toBe(false);
  });

  it("answers what the child printed, or why it gave none", async () => {
    const runner = createRunner({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-b") });
    const run = open(runner);
    const ok = await runner.exec({
      binary: node,
      args: ["-e", "process.stdout.write('hello')"],
      run,
      timeoutMs: 10_000,
      stdoutMaxBytes: 1024,
    });
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect(ok.stdout.toString()).toBe("hello");
    // A non-zero exit is the binary's own refusal of the file: its diagnostics come back, the video is not refused.
    const refused = await runner.exec({
      binary: node,
      args: ["-e", "console.error('Invalid data'); process.exit(1)"],
      run,
      timeoutMs: 10_000,
      stdoutMaxBytes: 1024,
    });
    expect(refused).toMatchObject({ ok: false, exitCode: 1, stderr: expect.stringContaining("Invalid data") });
    run.dispose();
  });

  it("keeps a long stdout's head when asked, never killing the run or refusing the video for it", async () => {
    const runner = createRunner({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-head") });
    const run = open(runner);
    const long = await runner.exec({
      binary: node,
      args: ["-e", "process.stdout.write('x'.repeat(200_000))"],
      run,
      timeoutMs: 10_000,
      stdoutMaxBytes: 1024,
      stdoutPastCap: "keep-head",
    });
    expect(long).toMatchObject({ ok: true, truncated: true });
    if (long.ok) expect(long.stdout.length).toBe(1024);
    // The same video is read again at once: nothing was remembered against it.
    expect(
      await runner.exec({ binary: node, args: ["-e", "process.stdout.write('ok')"], run, timeoutMs: 10_000, stdoutMaxBytes: 1024 }),
    ).toMatchObject({ ok: true });
    run.dispose();
  });

  it("kills a run past its clock or its stdout cap, and refuses that video for a day", async () => {
    let clock = 1_000_000;
    const runner = createRunner({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-c"), now: () => clock });
    const run = open(runner, "GIF89a slow");
    const slow = await runner.exec({
      binary: node,
      args: ["-e", "setTimeout(() => {}, 60_000)"],
      run,
      timeoutMs: 300,
      stdoutMaxBytes: 1024,
    });
    expect(slow).toEqual({ ok: false, failure: "timeout" });
    const again = await runner.exec({ binary: node, args: ["-e", ""], run, timeoutMs: 10_000, stdoutMaxBytes: 1024 });
    expect(again).toEqual({ ok: false, refused: "refused-recently", failure: "timeout" });
    clock += 25 * 60 * 60_000;
    expect(await runner.exec({ binary: node, args: ["-e", ""], run, timeoutMs: 10_000, stdoutMaxBytes: 1024 })).toMatchObject({ ok: true });
    const loud = open(runner, "GIF89a loud");
    expect(
      await runner.exec({
        binary: node,
        args: ["-e", "process.stdout.write('x'.repeat(100_000))"],
        run: loud,
        timeoutMs: 10_000,
        stdoutMaxBytes: 1024,
      }),
    ).toEqual({ ok: false, failure: "protocol" });
    run.dispose();
    loud.dispose();
  });

  it("refuses a video for a day after a run that answered out of protocol, as after one it killed", async () => {
    const runner = createRunner({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-protocol") });
    const run = open(runner);
    // The decoder found its output unreadable after a clean exit: it says so, and the runner remembers it.
    runner.refuse(run.input.sha256, "protocol");
    expect(await runner.exec({ binary: node, args: ["-e", "0"], run, timeoutMs: 10_000, stdoutMaxBytes: 1024 })).toEqual({
      ok: false,
      refused: "refused-recently",
      failure: "protocol",
    });
    run.dispose();
    await runner.close();
  });

  it("refuses a copy that is not what was sniffed, or past the input cap", () => {
    const runner = createRunner({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-open") });
    const text = join(root, "not-a-video.mp4");
    writeFileSync(text, "just text named .mp4");
    expect(() => runner.open({ file: text }, "mp4")).toThrow(VideoOpenError);
    const gif = join(root, "real.gif");
    writeFileSync(gif, "GIF89a");
    expect(runner.open({ file: gif }, "gif").input.container).toBe("gif");
    // Hashed from the copy: a hash from before it changed does not match.
    expect(() => runner.open({ file: gif }, "gif", "0".repeat(64))).toThrow(VideoOpenError);
    expect(readdirSync(join(root, "runs-open")).length).toBe(1);
  });

  it("kills a run that writes past the cap while it runs, long before its clock", async () => {
    const runner = createRunner({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-flood") });
    const run = open(runner, "GIF89a flood");
    const started = Date.now();
    const flood = await runner.exec({
      binary: node,
      args: [
        "-e",
        "const fs = require('fs'); const chunk = Buffer.alloc(8 * 1024 * 1024); let n = 0; setInterval(() => fs.writeFileSync(`f-${n++}.bin`, chunk), 20)",
      ],
      run,
      timeoutMs: 60_000,
      stdoutMaxBytes: 1024,
    });
    expect(flood).toEqual({ ok: false, failure: "protocol" });
    expect(Date.now() - started).toBeLessThan(20_000);
    run.dispose();
  });

  it("does not refuse a video for a binary that never started", async () => {
    const runner = createRunner({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-missing") });
    const run = open(runner, "GIF89a missing");
    expect(await runner.exec({ binary: join(root, "no-such-binary"), args: [], run, timeoutMs: 5_000, stdoutMaxBytes: 1 })).toEqual({
      ok: false,
      failure: "crashed",
    });
    expect(await runner.exec({ binary: node, args: ["-e", ""], run, timeoutMs: 5_000, stdoutMaxBytes: 1 })).toMatchObject({ ok: true });
    run.dispose();
  });

  it("kills a run past its memory, one run at a time, and stops what runs on close", async () => {
    // A sampler that reports the child over its cap: the watchdog kills it, and the video is refused.
    const heavy = createRunner({
      sandbox: { kind: "none" },
      runsDirectory: join(root, "runs-heavy"),
      residentKb: async () => 10 * 1024 * 1024,
    });
    const run = open(heavy, "GIF89a heavy");
    expect(
      await heavy.exec({ binary: node, args: ["-e", "setTimeout(() => {}, 30_000)"], run, timeoutMs: 30_000, stdoutMaxBytes: 1 }),
    ).toEqual({ ok: false, failure: "memory" });
    run.dispose();
    const order: string[] = [];
    const queued = createRunner({
      sandbox: { kind: "none" },
      runsDirectory: join(root, "runs-queue"),
      observe: (event) => order.push(event.kind),
    });
    const one = open(queued, "GIF89a one");
    const two = open(queued, "GIF89a two");
    await Promise.all([
      queued.exec({ binary: node, args: ["-e", "setTimeout(() => {}, 200)"], run: one, timeoutMs: 10_000, stdoutMaxBytes: 1 }),
      queued.exec({ binary: node, args: ["-e", ""], run: two, timeoutMs: 10_000, stdoutMaxBytes: 1 }),
    ]);
    expect(order).toEqual(["spawn", "exit", "spawn", "exit"]);
    const closing = queued.exec({
      binary: node,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      run: one,
      timeoutMs: 30_000,
      stdoutMaxBytes: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await queued.close();
    expect(await closing).toMatchObject({ ok: false });
    one.dispose();
    two.dispose();
  });

  it("reads the owner's cgroup: an out-of-memory end is memory, a failed entry is not the video's fault", async () => {
    const wrapped = (onExit: () => "oom" | undefined, exitCode: number): VideoSandbox => ({
      kind: "wrapped",
      wrap: () => ({ command: node, args: ["-e", `process.exit(${String(exitCode)})`], env: {}, onExit }),
    });
    const oom = createRunner({ sandbox: wrapped(() => "oom", 137), runsDirectory: join(root, "runs-oom") });
    const run = open(oom, "GIF89a oom");
    expect(await oom.exec({ binary: "/unused", args: [], run, timeoutMs: 10_000, stdoutMaxBytes: 1 })).toEqual({
      ok: false,
      failure: "memory",
    });
    const unentered = createRunner({ sandbox: wrapped(() => undefined, 125), runsDirectory: join(root, "runs-125") });
    const fresh = open(unentered, "GIF89a unentered");
    expect(await unentered.exec({ binary: "/unused", args: [], run: fresh, timeoutMs: 10_000, stdoutMaxBytes: 1 })).toEqual({
      ok: false,
      failure: "crashed",
    });
    // Not remembered: the next run of the same video goes ahead.
    expect(await unentered.exec({ binary: "/unused", args: [], run: fresh, timeoutMs: 10_000, stdoutMaxBytes: 1 })).toEqual({
      ok: false,
      failure: "crashed",
    });
    run.dispose();
    fresh.dispose();
  });

  it("holds what a run writes to the run directory's cap, the input's copy aside", async () => {
    const runner = createRunner({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-d") });
    const run = open(runner, "GIF89a writer");
    const big = await runner.exec({
      binary: node,
      args: ["-e", "require('fs').writeFileSync('out.bin', Buffer.alloc(65 * 1024 * 1024))"],
      run,
      timeoutMs: 20_000,
      stdoutMaxBytes: 1024,
    });
    expect(big).toEqual({ ok: false, failure: "protocol" });
    run.dispose();
  });

  it("is refused, never run bare, when the owner's wrap cannot confine it", async () => {
    let launched: VideoLaunch | undefined;
    const sandbox: VideoSandbox = {
      kind: "wrapped",
      wrap: (launch) => {
        launched = launch;
        return { refused: "unconfined" };
      },
    };
    const runner = createRunner({ sandbox, runsDirectory: join(root, "runs-e"), readRoots: ["/opt/ffmpeg"] });
    const run = open(runner);
    expect(await runner.exec({ binary: "/usr/bin/false", args: [], run, timeoutMs: 1_000, stdoutMaxBytes: 1 })).toEqual({
      ok: false,
      failure: "unconfined",
    });
    expect(launched).toMatchObject({
      runDirectory: run.path,
      workload: "video",
      readRoots: ["/opt/ffmpeg"],
      limits: { memoryBytes: 384 * 1024 * 1024, processes: 64 },
    });
    run.dispose();
  });
});

// The templates against the person's real FFmpeg, unconfined, on synthetic clips it makes itself.
const found = findFfmpeg();
const HAS_FFMPEG = !("missing" in found);
describe.skipIf(!HAS_FFMPEG)("the templates on FFmpeg itself", () => {
  const paths = found as { readonly ffmpeg: string; readonly ffprobe: string };
  let clip = "";
  let rotated = "";
  beforeAll(() => {
    clip = join(root, "clip.mp4");
    rotated = join(root, "rotated.mov");
    // Two seconds of red, then two of a test pattern: one cut at 2 s; with a tone.
    const made = spawnSync(paths.ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
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
    expect(made.status, made.stderr.toString()).toBe(0);
    const turned = spawnSync(paths.ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-display_rotation",
      "90",
      "-i",
      clip,
      "-c",
      "copy",
      rotated,
    ]);
    expect(turned.status, turned.stderr.toString()).toBe(0);
  });

  const runOn = (file: string): { readonly runner: ReturnType<typeof createRunner>; readonly run: RunDirectory } => {
    const runner = createRunner({ sandbox: { kind: "none" }, runsDirectory: join(root, "runs-ffmpeg") });
    const head = readFileSync(file).subarray(0, 4096);
    const container = sniffVideo(head);
    if (container === undefined) throw new Error("not sniffed");
    return { runner, run: runner.open({ file }, container) };
  };

  it("probes, takes stills, finds the cut, extracts audio and pose frames", async () => {
    const { runner, run } = runOn(clip);
    const probe = await runner.exec({
      binary: paths.ffprobe,
      args: probeArgs(run.input.path, "mp4", 4096 * 4096),
      run,
      timeoutMs: 10_000,
      stdoutMaxBytes: 256 * 1024,
    });
    expect(probe.ok, JSON.stringify(probe)).toBe(true);
    if (probe.ok)
      expect(
        JSON.parse(probe.stdout.toString())
          .streams.map((stream: { codec_type: string }) => stream.codec_type)
          .sort(),
      ).toEqual(["audio", "video"]);
    const still = await runner.exec({
      binary: paths.ffmpeg,
      args: frameAtArgs(run.input.path, "mp4", 4096 * 4096, 3, 1568, join(run.path, "f.jpg")),
      run,
      timeoutMs: 10_000,
      stdoutMaxBytes: 1024,
    });
    expect(still.ok, JSON.stringify(still)).toBe(true);
    expect(readFileSync(join(run.path, "f.jpg")).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const timeline = await runner.exec({
      binary: paths.ffmpeg,
      args: timelineArgs(run.input.path, "mp4", 4096 * 4096, 0, 4, 5, 10),
      run,
      timeoutMs: 20_000,
      stdoutMaxBytes: 1024 * 1024,
    });
    expect(timeline.ok, JSON.stringify(timeline)).toBe(true);
    if (timeline.ok) {
      const scores = [...timeline.stdout.toString().matchAll(/pts_time:([\d.]+)[\s\S]*?lavfi\.scd\.score=([\d.]+)/g)].map(
        (match) => [Number(match[1]), Number(match[2])] as const,
      );
      expect(scores.length).toBeGreaterThanOrEqual(15);
      const cut = scores.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
      expect(cut[0]).toBeCloseTo(2, 0);
    }
    const audio = await runner.exec({
      binary: paths.ffmpeg,
      args: audioArgs(run.input.path, "mp4", 4096 * 4096, 0, 2, join(run.path, "a.wav")),
      run,
      timeoutMs: 20_000,
      stdoutMaxBytes: 1024,
    });
    expect(audio.ok, JSON.stringify(audio)).toBe(true);
    expect(readFileSync(join(run.path, "a.wav")).subarray(0, 4).toString()).toBe("RIFF");
    const pose = await runner.exec({
      binary: paths.ffmpeg,
      args: rateFramesArgs(run.input.path, "mp4", 4096 * 4096, 0, 1, 10, 640, join(run.path, "p-%04d.rgb")),
      run,
      timeoutMs: 20_000,
      stdoutMaxBytes: 1024,
    });
    expect(pose.ok, JSON.stringify(pose)).toBe(true);
    const frames = readdirSync(run.path).filter((name) => name.startsWith("p-"));
    expect(frames.length).toBeGreaterThanOrEqual(9);
    // One raw frame per file, never upscaled: 320 wide, 240 high, three bytes a pixel.
    expect(statSync(join(run.path, frames[0] as string)).size).toBe(320 * 240 * 3);
    run.dispose();
  });

  it("refuses a frame past the pixel cap, and reads rotated frames upright", async () => {
    const { runner, run } = runOn(rotated);
    expect(run.input.container).toBe("mov");
    const capped = await runner.exec({
      binary: paths.ffmpeg,
      args: frameAtArgs(run.input.path, "mov", 1000, 1, 1568, join(run.path, "f.jpg")),
      run,
      timeoutMs: 10_000,
      stdoutMaxBytes: 1024,
    });
    expect(capped).toMatchObject({ ok: false, exitCode: expect.any(Number) });
    const pose = await runner.exec({
      binary: paths.ffmpeg,
      args: rateFramesArgs(run.input.path, "mov", 4096 * 4096, 0, 0.5, 10, 640, join(run.path, "p-%04d.rgb")),
      run,
      timeoutMs: 20_000,
      stdoutMaxBytes: 1024,
    });
    expect(pose.ok, JSON.stringify(pose)).toBe(true);
    const first = readdirSync(run.path).find((name) => name.startsWith("p-")) as string;
    // A 90° 320×240 clip comes out 240 wide, 320 high: FFmpeg rotated it before scaling.
    expect(statSync(join(run.path, first)).size).toBe(240 * 320 * 3);
    run.dispose();
  });

  it("takes a JPEG still of a GIF, whose palette FFmpeg would hand the encoder as limited-range YUV", async () => {
    const gif = join(root, "palette.gif");
    const made = spawnSync(paths.ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x120:r=1:d=1",
      "-frames:v",
      "1",
      gif,
    ]);
    expect(made.status, made.stderr.toString()).toBe(0);
    const { runner, run } = runOn(gif);
    const still = await runner.exec({
      binary: paths.ffmpeg,
      args: frameAtArgs(run.input.path, "gif", 4096 * 4096, 0, 1568, join(run.path, "f.jpg")),
      run,
      timeoutMs: 10_000,
      stdoutMaxBytes: 1024,
    });
    expect(still.ok, JSON.stringify(still)).toBe(true);
    run.dispose();
  });

  it("tiles a contact sheet, and encodes the probe clip from raw frames", async () => {
    const { runner, run } = runOn(clip);
    const sheet = await runner.exec({
      binary: paths.ffmpeg,
      args: sheetArgs(run.input.path, "mp4", 4096 * 4096, [0.5, 1.5, 2.5, 3.5], 2, 2, 160, join(run.path, "s.jpg")),
      run,
      timeoutMs: 20_000,
      stdoutMaxBytes: 1024,
    });
    expect(sheet.ok, JSON.stringify(sheet)).toBe(true);
    expect(statSync(join(run.path, "s.jpg")).size).toBeGreaterThan(1000);
    const raw = Buffer.alloc(320 * 240 * 3 * 16, 128);
    const clipRun = runner.scratch("clip.rgb", raw);
    const encoded = await runner.exec({
      binary: paths.ffmpeg,
      args: encodeClipArgs(clipRun.input.path, 320, 240, 4, true, join(clipRun.path, "probe.mp4")),
      run: clipRun,
      timeoutMs: 20_000,
      stdoutMaxBytes: 1024,
    });
    expect(encoded.ok, JSON.stringify(encoded)).toBe(true);
    expect(sniffVideo(readFileSync(join(clipRun.path, "probe.mp4")).subarray(0, 64))).toBe("mp4");
    run.dispose();
    clipRun.dispose();
  });
});
