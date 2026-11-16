import { describe, expect, it } from "vitest";

import { MOVEMENT_TEMPLATES, SKELETONS, SKELETON_IDS, type Joint, type PoseTrack, type SkeletonId } from "@tavi/contracts";

import { flexion, hipBelowKnee, interiorAngle, jointsOf, kneePastToe, trunkLean, type Joints } from "../src/angles.js";
import { findReps } from "../src/reps.js";
import { fillGaps, savitzkyGolay, smoothSeries } from "../src/smooth.js";
import { evaluatePose } from "../src/template-engine.js";

/**
 * The owner's pose arithmetic: angles from named keypoints to 0.01° whatever the skeleton, the
 * smoothing, reps on synthetic trajectories, and the setup check.
 */

type Pose = Partial<Record<Joint, readonly [number, number]>>;

/** A person's keypoints in `skeleton`'s own index order, from named points; unnamed keypoints scored 0. */
function keypoints(skeleton: SkeletonId, pose: Pose, score = 0.9): [number, number, number][] {
  return SKELETONS[skeleton].map((name) => {
    const point = name === null ? undefined : pose[name];
    return point === undefined ? [0, 0, 0] : [point[0], point[1], score];
  });
}

const rad = (degrees: number): number => (degrees * Math.PI) / 180;
/** A point `length` from `from`, at `degrees` clockwise from straight down the image. */
const toward = (from: readonly [number, number], degrees: number, length: number): [number, number] => [
  from[0] + Math.sin(rad(degrees)) * length,
  from[1] + Math.cos(rad(degrees)) * length,
];

/**
 * A side-on figure facing right (+x): the thigh `hipDeg` forward of
 * vertical-down, the shin `shinDeg` back from it, the trunk leaning `leanDeg` forward, both sides on
 * top of each other (the far side hidden behind the near one).
 */
function figure(hipDeg: number, shinDeg: number, leanDeg: number, hipAt: readonly [number, number] = [320, 300]): Pose {
  const knee = toward(hipAt, hipDeg, 100);
  const ankle = toward(knee, -shinDeg, 100);
  const shoulder: [number, number] = [hipAt[0] + Math.sin(rad(leanDeg)) * 150, hipAt[1] - Math.cos(rad(leanDeg)) * 150];
  const elbow = toward(shoulder, 0, 70);
  const wrist = toward(elbow, 0, 60);
  const toe: [number, number] = [ankle[0] + 40, ankle[1]];
  const heel: [number, number] = [ankle[0] - 10, ankle[1]];
  const sides = (name: string, point: readonly [number, number]): Pose => ({ [`left_${name}`]: point, [`right_${name}`]: point }) as Pose;
  return {
    ...sides("hip", hipAt),
    ...sides("knee", knee),
    ...sides("ankle", ankle),
    ...sides("shoulder", shoulder),
    ...sides("elbow", elbow),
    ...sides("wrist", wrist),
    ...sides("big_toe", toe),
    ...sides("heel", heel),
    nose: [shoulder[0] + 10, shoulder[1] - 40],
  };
}

describe("angles from named keypoints", () => {
  it("measures the same flexion to 0.01° in every skeleton, mapped by name", () => {
    // Thigh 70° forward of vertical, shin 20° back: the knee bends 90°, the hip 70°.
    const pose = figure(70, 20, 30);
    for (const skeleton of SKELETON_IDS) {
      const joints = jointsOf(skeleton, keypoints(skeleton, pose));
      expect(flexion(joints, "left", "knee"), skeleton).toBeCloseTo(90, 2);
      expect(flexion(joints, "left", "hip"), skeleton).toBeCloseTo(180 - (180 - 70 - 30), 2);
      expect(trunkLean(joints, "left"), skeleton).toBeCloseTo(30, 2);
      expect(flexion(joints, "left", "elbow"), skeleton).toBeCloseTo(0, 2);
      // Toes: in every skeleton but COCO-17.
      expect(kneePastToe(joints, "left") === undefined, skeleton).toBe(skeleton === "coco17");
    }
  });

  it("is unchanged by a frame turned a quarter, as FFmpeg's upright frames already are, and never turns it again", () => {
    const pose = figure(60, 10, 20);
    // The same figure turned 90° in the image: interior angles are the same; nothing rotates it back by the video's rotation.
    const turned = Object.fromEntries(Object.entries(pose).map(([name, [x, y]]) => [name, [480 - y, x] as const])) as Pose;
    const upright = jointsOf("coco17", keypoints("coco17", pose));
    const sideways = jointsOf("coco17", keypoints("coco17", turned));
    for (const joint of ["knee", "hip", "elbow"] as const)
      expect(flexion(sideways, "left", joint)).toBeCloseTo(flexion(upright, "left", joint) as number, 6);
    // Trunk lean is from the image's vertical: a turned image reads as lying down, which is why the camera must be level.
    expect(trunkLean(sideways, "left")).toBeCloseTo(90 + 20 - 0, 0);
  });

  it("leaves out a keypoint scored under 0.5, derives the neck and mid-hip, and says hip below knee", () => {
    const pose = figure(100, 10, 30);
    const low = jointsOf("coco17", keypoints("coco17", pose, 0.4));
    expect(flexion(low, "left", "knee")).toBeUndefined();
    const joints = jointsOf("coco17", keypoints("coco17", pose));
    expect(joints.mid_hip).toMatchObject({ x: 320, y: 300 });
    expect(joints.neck).toBeDefined();
    expect(hipBelowKnee(joints, "left")).toBe(1);
    expect(hipBelowKnee(jointsOf("coco17", keypoints("coco17", figure(60, 10, 30))), "left")).toBe(0);
    expect(interiorAngle({ x: 0, y: 0, score: 1 }, { x: 0, y: 0, score: 1 }, { x: 1, y: 0, score: 1 })).toBeUndefined();
  });
});

describe("smoothing", () => {
  it("fills gaps of up to three frames between measured ones, and leaves longer ones and the ends open", () => {
    expect(fillGaps([1, undefined, undefined, 4])).toEqual([1, 2, 3, 4]);
    expect(fillGaps([1, undefined, undefined, undefined, undefined, 6])).toEqual([1, undefined, undefined, undefined, undefined, 6]);
    expect(fillGaps([undefined, 2, 3])).toEqual([undefined, 2, 3]);
  });

  it("keeps a line and a parabola as they are, and evens out noise", () => {
    const line = Array.from({ length: 9 }, (_, index) => 2 * index + 1);
    savitzkyGolay(line).forEach((value, index) => expect(value).toBeCloseTo(line[index] as number, 9));
    const parabola = Array.from({ length: 9 }, (_, index) => index * index);
    savitzkyGolay(parabola).forEach((value, index) => expect(value).toBeCloseTo(parabola[index] as number, 9));
    const noisy = [10, 12, 8, 12, 8, 12, 10];
    const smoothed = smoothSeries(noisy) as number[];
    expect(Math.abs((smoothed[3] as number) - 10)).toBeLessThan(Math.abs((noisy[3] as number) - 10));
  });
});

describe("reps", () => {
  const wave = (cycles: number, depth: number, frames = 20): number[] =>
    Array.from({ length: cycles * frames + 1 }, (_, index) => (depth / 2) * (1 - Math.cos((2 * Math.PI * index) / frames)));

  it("finds each rise and fall of the range, its key frame at the peak", () => {
    const reps = findReps(wave(3, 100), 30);
    expect(reps).toHaveLength(3);
    expect(reps.map((rep) => rep.bottomIndex)).toEqual([10, 30, 50]);
    expect(reps[0]).toMatchObject({ startIndex: 0, endIndex: 20 });
  });

  it("starts a rep where the rise begins and ends it where the fall comes back, the pauses either side not its own", () => {
    const paused = [...Array<number>(30).fill(0), ...wave(1, 100), ...Array<number>(30).fill(0)];
    expect(findReps(paused, 30)).toEqual([{ startIndex: 30, bottomIndex: 40, endIndex: 50 }]);
    // A wobble on the pause, under a tenth of the range, is still the pause.
    const wobbly = paused.map((value, index) => (index < 30 || index > 50 ? value + (index % 2) * 2 : value));
    expect(findReps(wobbly, 30)[0]).toMatchObject({ bottomIndex: 40 });
    expect(findReps(wobbly, 30)[0]?.startIndex).toBeGreaterThanOrEqual(28);
    expect(findReps(wobbly, 30)[0]?.endIndex).toBeLessThanOrEqual(52);
  });

  it("keeps a bounce at the bottom smaller than the range inside one rep", () => {
    const bounced = [0, 25, 50, 75, 100, 85, 100, 75, 50, 25, 0, 0];
    expect(findReps(bounced, 30)).toEqual([{ startIndex: 0, bottomIndex: 4, endIndex: 10 }]);
  });

  it("counts no rep too shallow, nor one that never comes back up", () => {
    expect(findReps(wave(3, 20), 30)).toEqual([]);
    expect(findReps([0, 20, 40, 60, 80, 90, 90], 30)).toEqual([]);
    // A gap in the middle of a rep does not split it.
    const gapped: (number | undefined)[] = wave(1, 100);
    gapped[9] = undefined;
    expect(findReps(gapped, 30)).toHaveLength(1);
  });
});

describe("the setup check and the template engine", () => {
  const frameSize = { width: 640, height: 480 };
  const box = [200, 100, 250, 350] as [number, number, number, number];
  /** A squat over `frames` frames at 10 fps, side-on, in `skeleton`. */
  function squat(skeleton: SkeletonId, frames = 41, extra: (index: number) => PoseTrack["frames"][number]["people"] = () => []): PoseTrack {
    return {
      skeleton,
      coordSpace: "pixels",
      frames: Array.from({ length: frames }, (_, index) => {
        const depth = (1 - Math.cos((2 * Math.PI * index) / 20)) / 2;
        // The hip drops as the thighs go from upright to past parallel.
        const pose = figure(10 + depth * 95, 5 + depth * 30, 10 + depth * 30, [320, 230 + depth * 80]);
        return { timeSec: index / 10, people: [{ bbox: box, score: 0.9, keypoints: keypoints(skeleton, pose) }, ...extra(index)] };
      }),
    };
  }

  it("finds a squat's reps and measures each at its bottom, naming no fault until the template is validated", () => {
    const evaluated = evaluatePose({ track: squat("halpe26"), frameSize, movement: "squat", side: "auto" });
    expect(evaluated.validated).toBe(MOVEMENT_TEMPLATES.squat.validated);
    expect(evaluated.reps).toHaveLength(2);
    const [first] = evaluated.reps;
    expect(first?.bottomSec).toBeCloseTo(1, 5);
    expect(first?.atBottom).toMatchObject({ hipBelowKnee: 1, kneeFlexionDeg: expect.any(Number), kneePastToe: expect.any(Number) });
    expect(first?.faults).toEqual([]);
    expect(evaluated.setup).toMatchObject({ view: "side", fullBody: true, personCount: 1, problems: [] });
    expect(evaluated.series.map((entry) => entry.joint)).toEqual(["knee", "hip", "trunk"]);
    expect(evaluated.series[0]?.samples.length).toBeLessThanOrEqual(60);
  });

  it("measures a key frame the analyser missed from the filled series, as the reps were found, and the trunk-thigh change", () => {
    const track = squat("halpe26");
    // The first rep's bottom frame has nobody in it: filled, it still has its measures.
    const missed: PoseTrack = { ...track, frames: track.frames.map((frame, index) => (index === 10 ? { ...frame, people: [] } : frame)) };
    const evaluated = evaluatePose({ track: missed, frameSize, movement: "squat", side: "left" });
    expect(evaluated.reps[0]?.bottomIndex).toBe(10);
    expect(evaluated.reps[0]?.atBottom).toMatchObject({
      kneeFlexionDeg: expect.any(Number),
      hipFlexionDeg: expect.any(Number),
      hipBelowKnee: 1,
      trunkThighChangeDeg: expect.any(Number),
    });
    // The knee's measure at the bottom is the series' value at that time.
    const knee = evaluated.series.find((entry) => entry.joint === "knee")?.samples.find(([time]) => Math.abs(time - 1) < 1e-9)?.[1];
    expect(evaluated.reps[0]?.atBottom["kneeFlexionDeg"]).toBeCloseTo(knee as number, 0);
    expect(evaluated.reps[0]?.atBottom["trunkThighChangeDeg"]).toBeGreaterThan(0);
  });

  it("measures ankle and shoulder flexion with a skeleton that has them", () => {
    const pose = figure(70, 20, 30);
    const joints = jointsOf("mp33", keypoints("mp33", pose));
    // The shin 20° forward of the foot's square: 20° of dorsiflexion; the arm hanging along a 30°-leaning trunk: 30°.
    expect(flexion(joints, "left", "ankle")).toBeCloseTo(20, 2);
    expect(flexion(joints, "left", "shoulder")).toBeCloseTo(30, 2);
  });

  it("says a hidden joint inside the frame is occluded, not cut off, and low scores are the light", () => {
    const track = squat("coco17");
    const hidden: PoseTrack = {
      ...track,
      frames: track.frames.map((frame) => ({
        ...frame,
        people: frame.people.map((person) => ({
          ...person,
          keypoints: person.keypoints.map((point, index) => (SKELETONS.coco17[index] === "left_ankle" ? [point[0], point[1], 0.1] : point)),
        })),
      })),
    };
    const evaluated = evaluatePose({ track: hidden, frameSize, movement: "generic", side: "left" });
    expect(evaluated.setup.problems).toContain("occluded");
    expect(evaluated.setup.problems).not.toContain("body-cut-off");
    // Every score at 0.45: the analyser's own doubt, said as the light, and the mean it reports is that doubt.
    const dim: PoseTrack = {
      ...track,
      frames: track.frames.map((frame) => ({
        ...frame,
        people: frame.people.map((person) => ({
          ...person,
          keypoints: person.keypoints.map((point) => [point[0], point[1], point[2] === 0 ? 0 : 0.45] as [number, number, number]),
        })),
      })),
    };
    const dark = evaluatePose({ track: dim, frameSize, movement: "generic", side: "left" });
    expect(dark.setup.meanKeypointScore).toBeLessThan(0.5);
    expect(dark.setup.problems).toContain("low-light-or-blur");
    expect(dark.setup.problems).not.toContain("occluded");
  });

  it("says a skeleton without toes cannot give knee-over-toe, and nothing else", () => {
    const evaluated = evaluatePose({ track: squat("coco17"), frameSize, movement: "squat", side: "left" });
    expect(evaluated.setup.problems).toEqual(["skeleton-lacks-joint"]);
    expect(evaluated.reps[0]?.atBottom).not.toHaveProperty("kneePastToe");
    expect(evaluated.reps[0]?.atBottom).toHaveProperty("kneeFlexionDeg");
  });

  it("tells a side, an oblique and a front view apart, and flags other people, a cut-off body and a moving camera", () => {
    const facing = (spread: number): PoseTrack => ({
      skeleton: "coco17",
      coordSpace: "pixels",
      frames: [0, 1, 2].map((index) => ({
        timeSec: index,
        people: [
          {
            bbox: box,
            score: 0.9,
            keypoints: keypoints("coco17", {
              ...figure(10, 5, 0),
              left_shoulder: [320 - spread / 2, 150],
              right_shoulder: [320 + spread / 2, 150],
              left_hip: [320 - spread / 2, 300],
              right_hip: [320 + spread / 2, 300],
            }),
          },
        ],
      })),
    });
    expect(evaluatePose({ track: facing(20), frameSize, movement: "squat", side: "left" }).setup.view).toBe("side");
    expect(evaluatePose({ track: facing(75), frameSize, movement: "squat", side: "left" }).setup).toMatchObject({
      view: "oblique",
      problems: expect.arrayContaining(["not-side-on"]),
    });
    expect(evaluatePose({ track: facing(140), frameSize, movement: "squat", side: "left" }).setup.view).toBe("front");
    const crowded = evaluatePose({
      track: squat("coco17", 41, () => [
        { bbox: [10, 10, 50, 100], score: 0.8, keypoints: keypoints("coco17", figure(10, 5, 0, [30, 60])) },
      ]),
      frameSize,
      movement: "generic",
      side: "left",
      cameraMoving: true,
    });
    expect(crowded.setup).toMatchObject({ personCount: 2, problems: expect.arrayContaining(["several-people", "camera-moving"]) });
    // The subject stays the large central one, never the passer-by.
    expect(crowded.boxes.every((entry) => entry?.[0] === 200)).toBe(true);
    expect(crowded.reps).toEqual([]);
    const cut = evaluatePose({ track: squat("coco17"), frameSize: { width: 640, height: 380 }, movement: "squat", side: "left" });
    expect(cut.setup).toMatchObject({ fullBody: false, problems: expect.arrayContaining(["body-cut-off"]) });
  });

  it("says the subject was lost when few frames have anyone, and the light when scores are low", () => {
    const empty: PoseTrack = {
      skeleton: "coco17",
      coordSpace: "pixels",
      frames: [0, 1, 2, 3, 4].map((index) => ({
        timeSec: index,
        people: index === 0 ? [{ bbox: box, score: 0.6, keypoints: keypoints("coco17", figure(10, 5, 0), 0.45) }] : [],
      })),
    };
    expect(evaluatePose({ track: empty, frameSize, movement: "generic", side: "left" }).setup.problems).toEqual(
      expect.arrayContaining(["tracking-lost", "low-light-or-blur"]),
    );
    const joints: Joints = jointsOf("coco17", keypoints("coco17", figure(10, 5, 0)));
    expect(Object.keys(joints).length).toBeGreaterThan(0);
  });
});
