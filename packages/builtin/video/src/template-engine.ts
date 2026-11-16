import {
  MOVEMENT_TEMPLATES,
  SKELETONS,
  VIDEO_LIMITS,
  type Movement,
  type MeasureSpec,
  type MovementTemplate,
  type PoseTrack,
  type SetupProblem,
  type SkeletonId,
} from "@tavi/contracts";

import {
  flexion,
  hipBelowKnee,
  jointsOf,
  kneePastToe,
  skeletonHas,
  trunkLean,
  trunkThigh,
  type Joints,
  type MeasuredJoint,
  type Side,
} from "./angles.js";
import { findReps } from "./reps.js";
import { smoothSeries } from "./smooth.js";

/**
 * The owner's one engine over the movement templates: from any analyser's
 * `PoseTrack@1`, the subject followed frame to frame, each series smoothed,
 * the reps found on the template's signal, its measures taken at each rep's
 * key frame, its faults named only once the template is validated, and the
 * setup checked (the view, the whole body, other people, the light, a moving
 * camera, a skeleton without a joint the template needs).
 */

export type SeriesJoint = MeasuredJoint | "trunk";

export interface PoseEvaluationInput {
  readonly track: PoseTrack;
  /** The frames' size, in the track's pixels. */
  readonly frameSize: { readonly width: number; readonly height: number };
  readonly movement: Movement;
  readonly side: Side | "auto";
  /** The decoder's timeline says the camera moves. */
  readonly cameraMoving?: boolean;
}

export interface EvaluatedRep {
  readonly startSec: number;
  readonly bottomSec: number;
  readonly endSec: number;
  /** The key frame's index in the track. */
  readonly bottomIndex: number;
  readonly atBottom: Readonly<Record<string, number>>;
  readonly faults: readonly string[];
}

export interface PoseEvaluation {
  readonly side: Side;
  /** The subject's keypoints in each frame, by name; undefined where it was not found. */
  readonly subject: readonly (Joints | undefined)[];
  /** The subject's box in each frame, `[x, y, width, height]`. */
  readonly boxes: readonly (readonly [number, number, number, number] | undefined)[];
  readonly setup: {
    readonly view: "side" | "oblique" | "front" | "unknown";
    readonly fullBody: boolean;
    readonly personCount: number;
    readonly meanKeypointScore: number;
    readonly problems: readonly SetupProblem[];
  };
  readonly series: readonly {
    readonly joint: SeriesJoint;
    readonly side: Side;
    readonly samples: readonly (readonly [number, number])[];
  }[];
  readonly reps: readonly EvaluatedRep[];
  readonly validated: boolean;
}

/** The view, from the shoulders' spread against the torso's length: side below 0.35, front from 0.7. */
export const VIEW_SIDE_BELOW = 0.35;
export const VIEW_FRONT_FROM = 0.7;

/** The series a movement without a template reports. */
const GENERIC_SERIES: readonly SeriesJoint[] = ["knee", "hip", "elbow", "shoulder", "trunk"];

type Box = readonly [number, number, number, number];

function overlap(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const shared = x * y;
  const union = a[2] * a[3] + b[2] * b[3] - shared;
  return union <= 0 ? 0 : shared / union;
}

/**
 * The subject in each frame: on the first frame with anyone, the largest,
 * most central person; after it, whoever overlaps the subject's last box
 * most. Others are counted, never followed or drawn.
 */
function followSubject(
  track: PoseTrack,
  frameSize: PoseEvaluationInput["frameSize"],
): { readonly index: (number | undefined)[]; readonly people: number[] } {
  const chosen: (number | undefined)[] = [];
  const counts: number[] = [];
  let last: Box | undefined;
  const centre = { x: frameSize.width / 2, y: frameSize.height / 2 };
  const diagonal = Math.hypot(frameSize.width, frameSize.height) || 1;
  for (const frame of track.frames) {
    counts.push(frame.people.length);
    let best: number | undefined;
    let bestScore = -Infinity;
    frame.people.forEach((person, index) => {
      const box = person.bbox;
      const score =
        last === undefined
          ? (box[2] * box[3]) / (frameSize.width * frameSize.height || 1) -
            Math.hypot(box[0] + box[2] / 2 - centre.x, box[1] + box[3] / 2 - centre.y) / diagonal
          : overlap(last, box);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    // Once followed, a frame whose people do not overlap the subject has lost it.
    if (best !== undefined && last !== undefined && bestScore <= 0) best = undefined;
    chosen.push(best);
    if (best !== undefined) last = frame.people[best]?.bbox;
  }
  return { index: chosen, people: counts };
}

const SIDE_JOINTS = ["shoulder", "hip", "knee", "ankle"] as const;

function sideScore(subject: readonly (Joints | undefined)[], side: Side): number {
  let total = 0;
  for (const joints of subject) for (const name of SIDE_JOINTS) total += joints?.[`${side}_${name}`]?.score ?? 0;
  return total;
}

function seriesValue(joints: Joints | undefined, side: Side, joint: SeriesJoint): number | undefined {
  if (joints === undefined) return undefined;
  return joint === "trunk" ? trunkLean(joints, side) : flexion(joints, side, joint);
}

/** At most `most` samples, evenly through the series, measured points only, rounded to 0.1°. */
function downsample(times: readonly number[], values: readonly (number | undefined)[], most: number): (readonly [number, number])[] {
  const points = times.flatMap((time, index) => (values[index] === undefined ? [] : [[time, values[index] as number] as const]));
  if (points.length <= most) return points.map(([time, value]) => [time, Math.round(value * 10) / 10] as const);
  return Array.from(
    { length: most },
    (_, index) => points[Math.round((index * (points.length - 1)) / (most - 1))] as readonly [number, number],
  ).map(([time, value]) => [time, Math.round(value * 10) / 10] as const);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2 : sorted[middle];
}

/** A measure the skeleton cannot give: knee-over-toe and ankle flexion need toes. */
function measureNeedsToes(measure: MeasureSpec): boolean {
  return measure.kind === "knee-over-toe" || (measure.kind === "flexion" && measure.joint === "ankle");
}

/**
 * A measure's value in each frame, as the reps were found: continuous ones
 * gap-filled and smoothed like the signal, so a key frame that was filled has
 * its measures too, and they agree with the series at that time.
 */
function measureSeries(measure: MeasureSpec, subject: readonly (Joints | undefined)[], side: Side): (number | undefined)[] {
  const raw = (read: (joints: Joints) => number | undefined): (number | undefined)[] =>
    subject.map((joints) => (joints === undefined ? undefined : read(joints)));
  switch (measure.kind) {
    case "flexion":
      return smoothSeries(raw((joints) => flexion(joints, side, measure.joint)));
    case "trunk-lean":
      return smoothSeries(raw((joints) => trunkLean(joints, side)));
    case "knee-over-toe":
      return smoothSeries(raw((joints) => kneePastToe(joints, side)));
    case "trunk-thigh-change":
      return smoothSeries(raw((joints) => trunkThigh(joints, side)));
    case "hip-below-knee":
      // Yes or no: the nearest measured frame's, never an average of the two.
      return raw((joints) => hipBelowKnee(joints, side));
  }
}

/** The value at `index`, or failing that the nearest measured one within two frames. */
function near(values: readonly (number | undefined)[], index: number): number | undefined {
  for (const offset of [0, -1, 1, -2, 2]) {
    const value = values[index + offset];
    if (value !== undefined) return value;
  }
  return undefined;
}

function measureAt(
  measure: MeasureSpec,
  values: readonly (number | undefined)[],
  rep: { readonly startIndex: number; readonly bottomIndex: number },
): number | undefined {
  if (measure.kind !== "trunk-thigh-change") return near(values, rep.bottomIndex);
  // Over the last `fraction` of the descent: how far the trunk-thigh angle closed.
  const from = Math.round(rep.bottomIndex - (rep.bottomIndex - rep.startIndex) * measure.fraction);
  const before = near(values, from);
  const after = near(values, rep.bottomIndex);
  return before === undefined || after === undefined ? undefined : Math.abs(before - after);
}

/** The raw scores of one side's joints as the analyser gave them, under 0.5 included: how sure it was. */
function rawSideScores(skeleton: SkeletonId, keypoints: readonly (readonly [number, number, number])[], side: Side): number[] {
  const names = new Set<string>(SIDE_JOINTS.map((name) => `${side}_${name}`));
  return SKELETONS[skeleton].flatMap((name, index) => (name !== null && names.has(name) ? [keypoints[index]?.[2] ?? 0] : []));
}

export function evaluatePose(input: PoseEvaluationInput): PoseEvaluation {
  const { track } = input;
  const skeleton: SkeletonId = track.skeleton;
  const template: MovementTemplate | undefined = input.movement === "generic" ? undefined : MOVEMENT_TEMPLATES[input.movement];
  const followed = followSubject(track, input.frameSize);
  const subject = track.frames.map((frame, index) => {
    const chosen = followed.index[index];
    const person = chosen === undefined ? undefined : frame.people[chosen];
    return person === undefined ? undefined : jointsOf(skeleton, person.keypoints);
  });
  const boxes = track.frames.map((frame, index) => {
    const chosen = followed.index[index];
    return chosen === undefined ? undefined : frame.people[chosen]?.bbox;
  });
  const side: Side = input.side !== "auto" ? input.side : sideScore(subject, "left") >= sideScore(subject, "right") ? "left" : "right";
  const times = track.frames.map((frame) => frame.timeSec);

  // The series: the template's (its signal first), or the general ones; each gap-filled and smoothed.
  const wanted: SeriesJoint[] =
    template === undefined ? [...GENERIC_SERIES] : [...new Set<SeriesJoint>([template.repSignal.joint, ...template.series])];
  const smoothed = new Map<SeriesJoint, (number | undefined)[]>(
    wanted.map((joint) => [joint, smoothSeries(subject.map((joints) => seriesValue(joints, side, joint)))]),
  );
  const series = wanted
    .slice(0, VIDEO_LIMITS.poseSeriesPerCall)
    .map((joint) => ({ joint, side, samples: downsample(times, smoothed.get(joint) ?? [], VIDEO_LIMITS.poseSamplesPerSeries) }));

  // The setup: what the frames let one say.
  const problems = new Set<SetupProblem>();
  const present = subject.filter((joints) => joints !== undefined).length;
  const frames = Math.max(1, track.frames.length);
  if (present / frames < 0.8) problems.add("tracking-lost");
  // The shoulders' and the hips' spread against the torso's length, each where both of a pair are seen.
  const ratios = subject.flatMap((joints) => {
    const hip = joints?.mid_hip ?? joints?.[`${side}_hip`];
    const shoulder = joints?.neck ?? joints?.[`${side}_shoulder`];
    if (shoulder === undefined || hip === undefined) return [];
    const torso = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y);
    if (torso === 0) return [];
    const spreads = [
      [joints?.left_shoulder, joints?.right_shoulder],
      [joints?.left_hip, joints?.right_hip],
    ].flatMap(([left, right]) => (left === undefined || right === undefined ? [] : [Math.abs(left.x - right.x) / torso]));
    return spreads.length === 0 ? [] : [spreads.reduce((sum, spread) => sum + spread, 0) / spreads.length];
  });
  // A side view often hides the far shoulder: no spread to measure, with the near side seen, is side-on.
  const nearSeen = subject.filter((joints) => joints?.[`${side}_shoulder`] !== undefined && joints[`${side}_hip`] !== undefined).length;
  const ratio = median(ratios);
  const view =
    ratio !== undefined
      ? ratio < VIEW_SIDE_BELOW
        ? "side"
        : ratio < VIEW_FRONT_FROM
          ? "oblique"
          : "front"
      : nearSeen / frames >= 0.5
        ? "side"
        : "unknown";
  if (template !== undefined && template.view === "side" && view !== "side") problems.add("not-side-on");
  // How sure the analyser was of the near side's joints: their raw scores, those under 0.5 included.
  const scores = track.frames.flatMap((frame, index) => {
    const chosen = followed.index[index];
    const person = chosen === undefined ? undefined : frame.people[chosen];
    return person === undefined ? [] : rawSideScores(skeleton, person.keypoints, side);
  });
  const meanKeypointScore =
    scores.length === 0 ? 0 : Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 1000) / 1000;
  const dim = present > 0 && meanKeypointScore < 0.5;
  if (dim) problems.add("low-light-or-blur");
  // The frame's edge: a joint seen there, or one missing while the subject's box reaches it, is cut off; one missing
  // inside the frame is hidden behind something.
  const edge = 0.01;
  const atEdge = (x: number, y: number): boolean =>
    x <= input.frameSize.width * edge ||
    x >= input.frameSize.width * (1 - edge) ||
    y <= input.frameSize.height * edge ||
    y >= input.frameSize.height * (1 - edge);
  let cut = 0;
  let hidden = 0;
  subject.forEach((joints, index) => {
    if (joints === undefined) return;
    const box = boxes[index];
    const boxAtEdge = box !== undefined && (atEdge(box[0], box[1]) || atEdge(box[0] + box[2], box[1] + box[3]));
    const seen = SIDE_JOINTS.map((name) => joints[`${side}_${name}`]);
    if (seen.some((point) => point !== undefined && atEdge(point.x, point.y)) || (boxAtEdge && seen.includes(undefined))) cut += 1;
    else if (seen.includes(undefined)) hidden += 1;
  });
  const fullBody = present > 0 && cut / present < 0.2;
  if (!fullBody && present > 0) problems.add("body-cut-off");
  // Missing joints in dim frames are the light's, said once.
  if (present > 0 && !dim && hidden / present > 0.3) problems.add("occluded");
  const personCount = Math.max(0, ...followed.people);
  if (followed.people.filter((count) => count > 1).length / frames >= 0.2) problems.add("several-people");
  if (input.cameraMoving === true) problems.add("camera-moving");
  if (
    template?.measures.some(
      (measure) => measureNeedsToes(measure) && !(skeletonHas(skeleton, `${side}_big_toe`) && skeletonHas(skeleton, `${side}_ankle`)),
    ) === true
  )
    problems.add("skeleton-lacks-joint");

  // The reps, on the template's signal; the measures at each key frame; the faults once validated.
  const measured = new Map<string, (number | undefined)[]>(
    (template?.measures ?? []).map((measure) => [measure.id, measureSeries(measure, subject, side)]),
  );
  const reps: EvaluatedRep[] =
    template === undefined
      ? []
      : findReps(smoothed.get(template.repSignal.joint) ?? [], template.repSignal.minRangeDeg)
          .slice(0, 20)
          .map((rep) => {
            const atBottom: Record<string, number> = {};
            for (const measure of template.measures) {
              if (measureNeedsToes(measure) && !skeletonHas(skeleton, `${side}_big_toe`)) continue;
              const value = measureAt(measure, measured.get(measure.id) ?? [], rep);
              if (value !== undefined) atBottom[measure.id] = Math.round(value * 100) / 100;
            }
            const faults = !template.validated
              ? []
              : template.faults
                  .filter((fault) => {
                    const value = atBottom[fault.measure];
                    if (value === undefined) return false;
                    return (fault.below !== undefined && value < fault.below) || (fault.above !== undefined && value > fault.above);
                  })
                  .map((fault) => fault.id);
            return {
              startSec: times[rep.startIndex] ?? 0,
              bottomSec: times[rep.bottomIndex] ?? 0,
              endSec: times[rep.endIndex] ?? 0,
              bottomIndex: rep.bottomIndex,
              atBottom,
              faults,
            };
          });

  return {
    side,
    subject,
    boxes,
    setup: { view, fullBody, personCount, meanKeypointScore, problems: [...problems] },
    series,
    reps,
    validated: template?.validated ?? false,
  };
}
