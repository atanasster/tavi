import { SKELETONS, type Joint, type SkeletonId } from "@tavi/contracts";

/**
 * Joint angles from named keypoints: Tavi's own arithmetic, in the owner, whatever analyser found the
 * keypoints. A skeleton's keypoints are mapped by name, never by index; a
 * keypoint scored under 0.5 is a gap. The frames are upright already (FFmpeg
 * auto-rotates before scaling), so nothing is rotated here again by the
 * video's rotation: angles are in the image as it is shown, which is why the
 * result says the camera must be level.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

export type Joints = Partial<Record<Joint, Point>>;

/** A keypoint scored under this is not there. */
export const MIN_KEYPOINT_SCORE = 0.5;

/** The side of the body a measure is about. */
export type Side = "left" | "right";

/** The joints a template measures, one side's (`movement-templates.ts`). */
export type MeasuredJoint = "knee" | "hip" | "ankle" | "elbow" | "shoulder";

function mean(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, score: Math.min(a.score, b.score) };
}

/** A person's keypoints by name, scored ones only; `neck` and `mid_hip` derived as means where the skeleton lacks them. */
export function jointsOf(skeleton: SkeletonId, keypoints: readonly (readonly [number, number, number])[]): Joints {
  const joints: Partial<Record<Joint, Point>> = {};
  SKELETONS[skeleton].forEach((name, index) => {
    const keypoint = keypoints[index];
    if (name === null || keypoint === undefined) return;
    const [x, y, score] = keypoint;
    if (score >= MIN_KEYPOINT_SCORE && Number.isFinite(x) && Number.isFinite(y)) joints[name] = { x, y, score };
  });
  if (joints.neck === undefined && joints.left_shoulder !== undefined && joints.right_shoulder !== undefined)
    joints.neck = mean(joints.left_shoulder, joints.right_shoulder);
  if (joints.mid_hip === undefined && joints.left_hip !== undefined && joints.right_hip !== undefined)
    joints.mid_hip = mean(joints.left_hip, joints.right_hip);
  return joints;
}

/** The interior angle at `b` of `a`-`b`-`c`, in degrees (0 to 180); undefined when two points coincide. */
export function interiorAngle(a: Point, b: Point, c: Point): number | undefined {
  const ux = a.x - b.x;
  const uy = a.y - b.y;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (lengths === 0) return undefined;
  const cosine = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / lengths));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/** One side's joint, by its name without the side. */
export type SidedJoint = "shoulder" | "elbow" | "wrist" | "hip" | "knee" | "ankle" | "heel" | "big_toe";

/** One side's joint from a person's joints. */
export const jointAt = (joints: Joints, side: Side, name: SidedJoint): Point | undefined => joints[`${side}_${name}`];
const at = jointAt;

/** The three joints a flexion is measured across, the angle's vertex in the middle. */
export const FLEXION_JOINTS: Readonly<
  Record<
    MeasuredJoint,
    readonly [
      "shoulder" | "elbow" | "wrist" | "hip" | "knee" | "ankle" | "big_toe",
      "shoulder" | "elbow" | "hip" | "knee" | "ankle",
      "shoulder" | "elbow" | "wrist" | "hip" | "knee" | "ankle" | "big_toe",
    ]
  >
> = {
  knee: ["hip", "knee", "ankle"],
  hip: ["shoulder", "hip", "knee"],
  elbow: ["shoulder", "elbow", "wrist"],
  shoulder: ["hip", "shoulder", "elbow"],
  ankle: ["knee", "ankle", "big_toe"],
};

/**
 * A joint's flexion, in degrees, from one side's keypoints:
 * - knee: 180° less the hip-knee-ankle angle (0° straight);
 * - hip: 180° less the shoulder-hip-knee angle (0° upright);
 * - elbow: 180° less the shoulder-elbow-wrist angle (0° straight);
 * - shoulder: the hip-shoulder-elbow angle (0° with the arm along the trunk);
 * - ankle: 90° less the knee-ankle-big toe angle (0° with the shin square to the foot, positive as the knee goes
 *   forward), only with a skeleton that has toes.
 */
export function flexion(joints: Joints, side: Side, joint: MeasuredJoint): number | undefined {
  const [first, vertex, last] = FLEXION_JOINTS[joint];
  const a = at(joints, side, first);
  const b = at(joints, side, vertex);
  const c = at(joints, side, last);
  if (a === undefined || b === undefined || c === undefined) return undefined;
  const angle = interiorAngle(a, b, c);
  if (angle === undefined) return undefined;
  if (joint === "shoulder") return angle;
  if (joint === "ankle") return 90 - angle;
  return 180 - angle;
}

/** The hip-to-shoulder line's angle from the upright image vertical, in degrees (0° upright, 90° flat). */
export function trunkLean(joints: Joints, side: Side): number | undefined {
  const shoulder = at(joints, side, "shoulder");
  const hip = at(joints, side, "hip");
  if (shoulder === undefined || hip === undefined) return undefined;
  const dx = shoulder.x - hip.x;
  // Image y grows downwards: a shoulder above its hip has a negative dy.
  const dy = shoulder.y - hip.y;
  if (dx === 0 && dy === 0) return undefined;
  return (Math.atan2(Math.abs(dx), -dy) * 180) / Math.PI;
}

/** The trunk-thigh angle, shoulder-hip-knee, in degrees: what the pelvis proxy follows. */
export function trunkThigh(joints: Joints, side: Side): number | undefined {
  const shoulder = at(joints, side, "shoulder");
  const hip = at(joints, side, "hip");
  const knee = at(joints, side, "knee");
  return shoulder === undefined || hip === undefined || knee === undefined ? undefined : interiorAngle(shoulder, hip, knee);
}

/** 1 when the hip is lower in the image than the knee, 0 when not. */
export function hipBelowKnee(joints: Joints, side: Side): number | undefined {
  const hip = at(joints, side, "hip");
  const knee = at(joints, side, "knee");
  return hip === undefined || knee === undefined ? undefined : hip.y > knee.y ? 1 : 0;
}

/**
 * How far the knee passes the big toe along the way the foot points, as a
 * fraction of the shin's length: positive past the toe. Needs a skeleton with
 * toes.
 */
export function kneePastToe(joints: Joints, side: Side): number | undefined {
  const knee = at(joints, side, "knee");
  const ankle = at(joints, side, "ankle");
  const toe = at(joints, side, "big_toe");
  if (knee === undefined || ankle === undefined || toe === undefined) return undefined;
  const shin = Math.hypot(knee.x - ankle.x, knee.y - ankle.y);
  const facing = Math.sign(toe.x - ankle.x);
  if (shin === 0 || facing === 0) return undefined;
  return ((knee.x - toe.x) * facing) / shin;
}

/** Whether a skeleton can give a joint at all (`heel`, `big_toe` are not in every one). */
export function skeletonHas(skeleton: SkeletonId, joint: Joint): boolean {
  if (joint === "neck")
    return (
      SKELETONS[skeleton].includes("neck") ||
      (SKELETONS[skeleton].includes("left_shoulder") && SKELETONS[skeleton].includes("right_shoulder"))
    );
  if (joint === "mid_hip")
    return (
      SKELETONS[skeleton].includes("mid_hip") || (SKELETONS[skeleton].includes("left_hip") && SKELETONS[skeleton].includes("right_hip"))
    );
  return SKELETONS[skeleton].includes(joint);
}
