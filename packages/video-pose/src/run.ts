import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { PoseTrack, SkeletonId } from "@tavi/contracts";

import { cropPerson, decodeSimcc, letterbox, peopleIn, subjectBox, type Box } from "./geometry.js";

/**
 * One pose request, in the add-on's child: the frames the owner decoded, read from their directory; the
 * detector (when given) finds the people, the subject is followed frame to
 * frame, RTMPose finds the subject's keypoints, and the answer is written as
 * the command analyser's `result.json`. Others in a frame are counted, their
 * boxes kept and their keypoints never estimated.
 */

/**
 * Each skeleton's keypoint count, as `SKELETONS` in contracts has them (a
 * test holds them equal): the child imports nothing but onnxruntime, so it
 * reads only its own package, the run and the model.
 */
export const JOINT_COUNTS: Readonly<Record<SkeletonId, number>> = { coco17: 17, halpe26: 26, body25: 25, mp33: 33 };

/** What of onnxruntime the child uses: a session per model, and float tensors in. */
export interface OrtLike {
  readonly InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<SessionLike> };
  readonly Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => unknown;
}
export interface SessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { readonly data: ArrayLike<number | bigint>; readonly dims: readonly number[] }>>;
}

export interface PoseRun {
  readonly framesDir: string;
  readonly outDir: string;
  readonly model: string;
  readonly detector?: string;
  readonly skeleton: SkeletonId;
  /** RTMPose's input, width × height (192 × 256 for RTMPose-s). */
  readonly poseSize: readonly [number, number];
  /** The detector's square input (320 for RTMDet-nano). */
  readonly detectorSize: number;
}

interface IndexedFrame {
  readonly file: string;
  readonly timeSec: number;
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

/** The answer file: the result, or the analyser's own error by kind. */
function answer(outDir: string, body: unknown): void {
  writeFileSync(join(outDir, "result.json"), JSON.stringify(body));
}

export function fail(outDir: string, code: "unavailable" | "model-load" | "bad-input" | "internal", message: string): void {
  answer(outDir, { error: { code, message: message.slice(0, 1_000) } });
}

const numbers = (data: ArrayLike<number | bigint>): number[] => Array.from(data, (value) => Number(value));

export async function runPose(request: PoseRun, ort: OrtLike): Promise<void> {
  const joints = JOINT_COUNTS[request.skeleton];
  let frames: readonly IndexedFrame[];
  try {
    frames = (JSON.parse(readFileSync(join(request.framesDir, "frames.json"), "utf8")) as { readonly frames: readonly IndexedFrame[] })
      .frames;
  } catch {
    fail(request.outDir, "bad-input", "the frames' index could not be read");
    return;
  }
  if (frames.some((frame) => frame.format !== "rgb24")) {
    fail(request.outDir, "bad-input", "the pose analyser reads raw rgb24 frames only");
    return;
  }
  let pose: SessionLike;
  let detector: SessionLike | undefined;
  try {
    const options = { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: "sequential", graphOptimizationLevel: "all" };
    pose = await ort.InferenceSession.create(request.model, options);
    detector = request.detector === undefined ? undefined : await ort.InferenceSession.create(request.detector, options);
  } catch (error) {
    fail(request.outDir, "model-load", `the model could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const [inputWidth, inputHeight] = request.poseSize;
  const track: PoseTrack["frames"][number][] = [];
  let last: Box | undefined;
  for (const frame of frames) {
    const path = join(request.framesDir, basename(frame.file));
    // A frame is exactly its pixels: anything else is not the owner's.
    if (statSync(path).size !== frame.width * frame.height * 3) {
      fail(request.outDir, "bad-input", "a frame is not its size's raw pixels");
      return;
    }
    const rgb = new Uint8Array(readFileSync(path));
    const size = { width: frame.width, height: frame.height };
    let people: { readonly box: Box; readonly score: number }[];
    if (detector === undefined) people = [{ box: [0, 0, frame.width, frame.height], score: 1 }];
    else {
      const boxed = letterbox(rgb, frame.width, frame.height, request.detectorSize);
      try {
        const out = await detector.run({
          [detector.inputNames[0] as string]: new ort.Tensor("float32", boxed.tensor, [1, 3, request.detectorSize, request.detectorSize]),
        });
        const [dets, labels] = detector.outputNames.map((name) => out[name]);
        if (dets === undefined || labels === undefined) throw new RangeError("it answers no dets and labels");
        people = peopleIn(dets.data as ArrayLike<number>, labels.data, boxed.scale, size);
      } catch (error) {
        fail(
          request.outDir,
          "model-load",
          `the detector does not take ${String(request.detectorSize)}×${String(request.detectorSize)} input or answer mmdeploy's dets and labels: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
    const subject = subjectBox(people, last, size);
    // From here a failure is the model's: one of another input size or shape answers what this child cannot read.
    if (subject === undefined) {
      track.push({ timeSec: frame.timeSec, people: [] });
      continue;
    }
    last = subject;
    const crop = cropPerson(rgb, frame.width, frame.height, subject, inputWidth, inputHeight);
    let keypoints: [number, number, number][];
    try {
      const out = await pose.run({
        [pose.inputNames[0] as string]: new ort.Tensor("float32", crop.tensor, [1, 3, inputHeight, inputWidth]),
      });
      const [simccX, simccY] = pose.outputNames.map((name) => out[name]);
      if (simccX === undefined || simccY === undefined || simccX.dims[1] !== joints)
        throw new RangeError(`it does not answer ${String(joints)} ${request.skeleton} keypoints as SimCC`);
      keypoints = decodeSimcc(numbers(simccX.data), numbers(simccY.data), joints, crop, inputWidth, inputHeight);
    } catch (error) {
      fail(
        request.outDir,
        "model-load",
        `the model does not take ${String(inputWidth)}×${String(inputHeight)} input or answer ${String(joints)} ${request.skeleton} keypoints as SimCC: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const score = keypoints.reduce((sum, [, , value]) => sum + value, 0) / Math.max(1, keypoints.length);
    // The others: counted and boxed, never measured.
    const others = people
      .filter((person) => person.box !== subject)
      .map((person) => ({
        bbox: [...person.box] as [number, number, number, number],
        score: person.score,
        keypoints: Array.from({ length: joints }, () => [0, 0, 0] as [number, number, number]),
      }));
    track.push({
      timeSec: frame.timeSec,
      people: [
        { bbox: [...subject] as [number, number, number, number], score: Math.round(score * 1000) / 1000, keypoints },
        ...others,
      ].slice(0, 10),
    });
  }
  answer(request.outDir, { result: { skeleton: request.skeleton, coordSpace: "pixels", frames: track }, model: basename(request.model) });
}
