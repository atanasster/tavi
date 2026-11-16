import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AnalyzerEntrySchema,
  rawFrameBudget,
  SETUP_PROBLEMS,
  VIDEO_LIMITS,
  type AnalyzerEntry,
  type PoseTrack,
  type VideoAnalyzerPort,
  type VideoAnalyzerRegistry,
  type VideoDecoderPort,
} from "@tavi/contracts";
import { createAnalyzerRegistry, createCommandAnalyzer, createFfmpegDecoder } from "@tavi/plugin-video";
import { evaluatePose, flexion, smoothSeries, trunkLean, type Joints, type PoseEvaluation } from "@tavi/plugin-video/internals";

// Loaded by URL: Node runs these files as they are, so the import names the `.ts` file.
const { groupedAngleErrors, CLAIM_MAE_DEG } = (await import(
  new URL("./pose-metrics.ts", import.meta.url).href
)) as typeof import("./pose-metrics.js");

/**
 * The pose eval on a dataset the person holds: `node evals/video/pose-eval.ts --dataset <dir> --analyzer
 * <entry.json> [--data-dir <tavi data>] [--fps 10] [--label <name>]`.
 *
 * `<dir>/manifest.json` names each clip, its camera setup, the movement and
 * side, the setup problems it should be flagged with, and its reference
 * joint angles per frame (from annotation, a goniometer or motion capture):
 *
 *   { "clips": [{ "file": "squat-1.mp4", "setup": "side-hip-height", "asInstructed": true, "movement": "squat",
 *                 "side": "left", "expectedProblems": [],
 *                 "reference": [{ "timeSec": 1.2, "joint": "knee", "side": "left", "degrees": 92.1 }] }] }
 *
 * `asInstructed` marks a clip filmed as `video.pose` asks (side-on, whole
 * body, level camera): the ±5° angle claim is judged on those alone; the bad
 * setups are there to be flagged.
 *
 * `--analyzer` is one `analyzers.json` entry (a command, or `rtmpose` on a
 * model in `<data-dir>/video/models`). Each clip is decoded and measured as
 * `video.pose` does it — the same frames, chunks, engine and smoothing — and
 * its angles compared: MAE, 95th percentile, ICC(2,1) and Bland-Altman per
 * analyser, setup and joint. The clips are the person's own, read on their
 * machine without the sandbox; the results stay in `results/` with them.
 */

interface Reference {
  readonly timeSec: number;
  readonly joint: "knee" | "hip" | "ankle" | "elbow" | "shoulder" | "trunk";
  readonly side: "left" | "right";
  readonly degrees: number;
}
interface Clip {
  readonly file: string;
  readonly setup: string;
  readonly asInstructed?: boolean;
  readonly movement: "generic" | "squat" | "push-up" | "lunge" | "hip-hinge";
  readonly side: "left" | "right" | "auto";
  readonly expectedProblems?: readonly string[];
  readonly reference: readonly Reference[];
}

/** The dataset's manifest, checked: a malformed one is refused before any clip is read. */
export function parseDataset(json: unknown): readonly Clip[] {
  const clips = (json as { readonly clips?: unknown } | null)?.clips;
  if (!Array.isArray(clips) || clips.length === 0) throw new Error("manifest.json has no clips");
  return clips.map((entry: unknown, index) => {
    const clip = entry as Clip | null;
    // A clip is a file of the dataset's own directory: no absolute path, no way out of it.
    if (
      clip === null ||
      typeof clip !== "object" ||
      typeof clip.file !== "string" ||
      clip.file === "" ||
      isAbsolute(clip.file) ||
      clip.file.split(/[/\\]/).includes("..") ||
      typeof clip.setup !== "string" ||
      !["generic", "squat", "push-up", "lunge", "hip-hinge"].includes(clip.movement) ||
      !["left", "right", "auto"].includes(clip.side) ||
      !Array.isArray(clip.reference) ||
      (clip.asInstructed !== undefined && typeof clip.asInstructed !== "boolean")
    )
      throw new Error(`clip ${String(index)} is not a clip`);
    if (
      clip.expectedProblems !== undefined &&
      (!Array.isArray(clip.expectedProblems) ||
        clip.expectedProblems.some((problem) => !(SETUP_PROBLEMS as readonly string[]).includes(problem)))
    )
      throw new Error(`clip ${clip.file} expects a setup problem that is not one`);
    for (const row of clip.reference)
      if (
        row === null ||
        typeof row !== "object" ||
        !Number.isFinite(row.timeSec) ||
        !Number.isFinite(row.degrees) ||
        !["knee", "hip", "ankle", "elbow", "shoulder", "trunk"].includes(row.joint) ||
        !["left", "right"].includes(row.side)
      )
        throw new Error(`clip ${clip.file} has a reference row that is not one`);
    return clip;
  });
}

/** A clip's mean scene score past which the camera moved throughout: `video.pose`'s. */
const CAMERA_MOVING_MEAN_SCORE = 8;

/**
 * One clip measured as `video.pose` measures it (apps/cli/src/features/video/tools.ts):
 * at most 60 s, chunks that fit a run, one frame answered per frame handed,
 * one analyser and skeleton for the whole clip, camera motion from the scene
 * scores, the owner's engine. Anything `video.pose` refuses is refused here.
 */
export async function measureClip(
  decoder: VideoDecoderPort,
  registry: VideoAnalyzerRegistry,
  file: string,
  clip: Pick<Clip, "movement" | "side">,
  fps: number,
): Promise<{ readonly evaluated: PoseEvaluation; readonly times: readonly number[]; readonly fps: number }> {
  const opened = decoder.open({ file });
  if (!opened.ok) throw new Error(`${file} could not be opened`);
  const run = opened.value;
  try {
    const probed = await decoder.probe(run.input);
    if (!probed.ok) throw new Error(`${file} could not be read`);
    const to = Math.min(probed.value.durationSec, VIDEO_LIMITS.poseMaxDurationSec);
    if (to <= 0) throw new Error(`${file} has no frames to measure`);
    const rate = Math.max(1, Math.min(fps, Math.floor(VIDEO_LIMITS.poseMaxFrames / to)));
    const chunk = Math.max(1, Math.min(60, rawFrameBudget(probed.value.video, VIDEO_LIMITS.poseFrameWidth).frames - 1)) / rate;
    const frames: PoseTrack["frames"][number][] = [];
    let skeleton: PoseTrack["skeleton"] | undefined;
    let analyzer: string | undefined;
    let size: { readonly width: number; readonly height: number } | undefined;
    for (let start = 0; start < to - 1e-6; start += chunk) {
      const out = mkdtempSync(join(run.directory, "pose-"));
      try {
        const decoded = await decoder.frames(
          run.input,
          { kind: "rate", fps: rate, range: { from: start, to: Math.min(to, start + chunk) }, maxWidth: VIDEO_LIMITS.poseFrameWidth },
          out,
        );
        if (!decoded.ok) throw new Error(`${file}: frames from ${start.toFixed(1)} s could not be decoded`);
        if (decoded.value.length === 0) continue;
        size ??= { width: decoded.value[0]?.width ?? 0, height: decoded.value[0]?.height ?? 0 };
        const outcome = await registry.analyze({
          capability: "pose",
          frames: decoded.value,
          runDirectory: run.directory,
          options: {},
          limits: { timeoutMs: VIDEO_LIMITS.poseTimeoutMs, maxOutputBytes: 4 * 1024 * 1024 },
          signal: new AbortController().signal,
        });
        if (!outcome.ok) throw new Error(`${file}: the analyser answered ${outcome.error.code}`);
        if (outcome.result.frames.length !== decoded.value.length)
          throw new Error(
            `${file}: the analyser answered ${String(outcome.result.frames.length)} frames for ${String(decoded.value.length)}`,
          );
        if (skeleton !== undefined && (outcome.result.skeleton !== skeleton || outcome.analyzer !== analyzer))
          throw new Error(`${file}: the analysers answered parts of the clip differently`);
        skeleton = outcome.result.skeleton;
        analyzer = outcome.analyzer;
        outcome.result.frames.forEach((frame, index) =>
          frames.push({ ...frame, timeSec: (decoded.value[index] as { readonly timeSec: number }).timeSec }),
        );
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }
    if (skeleton === undefined || size === undefined) throw new Error(`${file}: no frames could be read`);
    const build = decoder.facts();
    let cameraMoving = false;
    if (!("missing" in build) && build.features.includes("scdet")) {
      const scores = await decoder.timeline(run.input, { from: 0, to });
      if (scores.ok && scores.value.length > 0)
        cameraMoving = scores.value.reduce((sum, [, score]) => sum + score, 0) / scores.value.length > CAMERA_MOVING_MEAN_SCORE;
    }
    const evaluated = evaluatePose({
      track: { skeleton, coordSpace: "pixels", frames },
      frameSize: size,
      movement: clip.movement,
      side: clip.side,
      cameraMoving,
    });
    return { evaluated, times: frames.map((frame) => frame.timeSec), fps: rate };
  } finally {
    run.dispose();
  }
}

/** A joint's angle in each frame, smoothed as the engine smooths its series. */
export function angleSeries(
  subject: readonly (Joints | undefined)[],
  joint: Reference["joint"],
  side: Reference["side"],
): (number | undefined)[] {
  return smoothSeries(
    subject.map((joints) =>
      joints === undefined ? undefined : joint === "trunk" ? trunkLean(joints, side) : flexion(joints, side, joint),
    ),
  );
}

/** The measured angle nearest a reference time, within half a frame; undefined when the frame there has none. */
export function predictedAt(
  times: readonly number[],
  series: readonly (number | undefined)[],
  timeSec: number,
  fps: number,
): number | undefined {
  let best = -1;
  for (let index = 0; index < times.length; index += 1)
    if (best < 0 || Math.abs((times[index] as number) - timeSec) < Math.abs((times[best] as number) - timeSec)) best = index;
  if (best < 0 || Math.abs((times[best] as number) - timeSec) > 0.5 / fps + 1e-6) return undefined;
  return series[best];
}

async function analyzerFrom(entry: AnalyzerEntry, dataDirectory: string | undefined): Promise<VideoAnalyzerPort> {
  if (entry.type === "command") return createCommandAnalyzer({ entry, sandbox: { kind: "none" } });
  if (entry.type === "builtin" && entry.id === "rtmpose") {
    if (dataDirectory === undefined) throw new Error("--data-dir is needed for rtmpose: its model is read from <data-dir>/video/models");
    const { poseAnalyzerEntry } = await import("@tavi/video-pose");
    const made = poseAnalyzerEntry(entry.model, { dataDirectory });
    if ("missing" in made) throw new Error(made.missing);
    return createCommandAnalyzer({ entry: made.entry, sandbox: { kind: "none" } });
  }
  throw new Error("the eval runs a command analyser or rtmpose");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index < 0 ? undefined : args[index + 1];
  };
  const dataset = value("dataset");
  const entryFile = value("analyzer");
  if (dataset === undefined || entryFile === undefined)
    throw new Error("usage: pose-eval.ts --dataset <dir> --analyzer <entry.json> [--data-dir <dir>] [--fps 10] [--label <name>]");
  const fps = Number(value("fps") ?? "10");
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) throw new Error("--fps is a whole number from 1 to 30");
  const label = value("label") ?? "pose";
  const clips = parseDataset(JSON.parse(readFileSync(join(dataset, "manifest.json"), "utf8")));
  const entry = AnalyzerEntrySchema.parse(JSON.parse(readFileSync(entryFile, "utf8")));
  const analyzer = await analyzerFrom(entry, value("data-dir"));
  const analyserId = analyzer.manifest().id;
  const registry = createAnalyzerRegistry({ pose: [analyzer] });
  const runs = mkdtempSync(join(tmpdir(), "tavi-pose-eval-"));
  const decoder = await createFfmpegDecoder({ sandbox: { kind: "none" }, runsDirectory: runs });
  const rows: {
    readonly joint: string;
    readonly setup: string;
    readonly analyser: string;
    readonly clip: string;
    readonly asInstructed: boolean;
    readonly predicted: number;
    readonly reference: number;
  }[] = [];
  const setups: {
    readonly clip: string;
    readonly expected: readonly string[];
    readonly flagged: readonly string[];
    readonly missed: readonly string[];
  }[] = [];
  try {
    for (const clip of clips) {
      const measured = await measureClip(decoder, registry, resolve(dataset, clip.file), clip, fps);
      const series = new Map<string, (number | undefined)[]>();
      for (const row of clip.reference) {
        const key = `${row.joint}:${row.side}`;
        if (!series.has(key)) series.set(key, angleSeries(measured.evaluated.subject, row.joint, row.side));
        const predicted = predictedAt(measured.times, series.get(key) ?? [], row.timeSec, measured.fps);
        if (predicted !== undefined)
          rows.push({
            joint: `${row.side} ${row.joint}`,
            setup: clip.setup,
            analyser: analyserId,
            clip: clip.file,
            asInstructed: clip.asInstructed === true,
            predicted,
            reference: row.degrees,
          });
      }
      const expected = clip.expectedProblems ?? [];
      setups.push({
        clip: clip.file,
        expected,
        flagged: measured.evaluated.setup.problems,
        missed: expected.filter((problem) => !measured.evaluated.setup.problems.includes(problem as never)),
      });
    }
  } finally {
    await decoder.close();
    await registry.close();
    rmSync(runs, { recursive: true, force: true });
  }
  const errors = groupedAngleErrors(rows);
  // The ±5° angle claim as written: on the clips filmed as instructed, every joint within CLAIM_MAE_DEG.
  const instructed = rows.filter((row) => row.asInstructed);
  const claimErrors = groupedAngleErrors(instructed);
  const report = {
    label,
    analyser: analyserId,
    clips: clips.length,
    pairs: rows.length,
    errors,
    // Nothing measured as instructed claims nothing.
    claimHolds: instructed.length > 0 && Object.values(claimErrors).every((group) => group.maeDeg <= CLAIM_MAE_DEG),
    claimPairs: instructed.length,
    setups,
    everyBadSetupFlagged: setups.every((entry) => entry.missed.length === 0),
  };
  const results = join(dirname(fileURLToPath(import.meta.url)), "results");
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, `${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.everyBadSetupFlagged) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
