import type { Movement } from "./video.js";

/**
 * Movement templates: data,
 * evaluated by the owner's one engine. A template names the view it needs,
 * the joint whose angle finds its reps, the measures taken at each rep's key
 * frame, and its faults as thresholds on those measures.
 *
 * A template is `validated` only once its own owner-recorded fixtures pass
 * (evals/video/RECORDING.md); until then `video.pose` reports its measures
 * and names no faults. The thresholds below are starting points, tuned when
 * the fixtures exist; none is a clinical figure.
 */

/** The joints a series and a measure are about: one side's, chosen by the call. */
export type TemplateJoint = "knee" | "hip" | "ankle" | "elbow" | "shoulder";

export type MeasureSpec =
  /**
   * The joint's flexion (`packages/builtin/video/src/angles.ts`): knee, 180° less hip-knee-ankle; hip, 180° less
   * shoulder-hip-knee; elbow, 180° less shoulder-elbow-wrist; shoulder, the hip-shoulder-elbow angle itself (0° with
   * the arm along the trunk); ankle, 90° less knee-ankle-big toe (dorsiflexion, positive as the knee goes forward),
   * which needs a skeleton with toes.
   */
  | { readonly id: string; readonly kind: "flexion"; readonly joint: TemplateJoint }
  /** The shoulder-hip line's angle from the upright image vertical. */
  | { readonly id: string; readonly kind: "trunk-lean" }
  /** 1 when the hip keypoint is lower in the image than the knee, else 0. */
  | { readonly id: string; readonly kind: "hip-below-knee" }
  /** How much the trunk-thigh angle changes over the last `fraction` of the descent: a low-confidence pelvis proxy, never "lumbar flexion". */
  | { readonly id: string; readonly kind: "trunk-thigh-change"; readonly fraction: number }
  /** How far the knee passes the big toe, as a fraction of shin length; needs a skeleton with toes. */
  | { readonly id: string; readonly kind: "knee-over-toe" };

export interface FaultSpec {
  readonly id: string;
  /** A measure's id. */
  readonly measure: string;
  /** The fault holds when the measure is below this, or above `above`. */
  readonly below?: number;
  readonly above?: number;
}

export interface MovementTemplate {
  readonly id: Exclude<Movement, "generic">;
  readonly view: "side";
  /** The joint whose flexion finds reps: a rep is a rise and fall of at least `minRangeDeg`, its key frame the peak. */
  readonly repSignal: { readonly joint: TemplateJoint; readonly minRangeDeg: number };
  /** The series reported besides the signal's. */
  readonly series: readonly (TemplateJoint | "trunk")[];
  readonly measures: readonly MeasureSpec[];
  readonly faults: readonly FaultSpec[];
  readonly validated: boolean;
}

export const MOVEMENT_TEMPLATES: Readonly<Record<MovementTemplate["id"], MovementTemplate>> = {
  squat: {
    id: "squat",
    view: "side",
    repSignal: { joint: "knee", minRangeDeg: 30 },
    series: ["knee", "hip", "trunk"],
    measures: [
      { id: "kneeFlexionDeg", kind: "flexion", joint: "knee" },
      { id: "hipFlexionDeg", kind: "flexion", joint: "hip" },
      { id: "trunkLeanDeg", kind: "trunk-lean" },
      { id: "hipBelowKnee", kind: "hip-below-knee" },
      { id: "trunkThighChangeDeg", kind: "trunk-thigh-change", fraction: 0.2 },
      { id: "kneePastToe", kind: "knee-over-toe" },
    ],
    faults: [
      { id: "above-parallel", measure: "hipBelowKnee", below: 1 },
      { id: "forward-lean", measure: "trunkLeanDeg", above: 50 },
      { id: "late-trunk-thigh-change", measure: "trunkThighChangeDeg", above: 15 },
    ],
    validated: false,
  },
  "push-up": {
    id: "push-up",
    view: "side",
    repSignal: { joint: "elbow", minRangeDeg: 30 },
    series: ["elbow", "hip"],
    measures: [
      { id: "elbowFlexionDeg", kind: "flexion", joint: "elbow" },
      { id: "hipFlexionDeg", kind: "flexion", joint: "hip" },
    ],
    faults: [
      { id: "shallow", measure: "elbowFlexionDeg", below: 70 },
      { id: "hips-out-of-line", measure: "hipFlexionDeg", above: 20 },
    ],
    validated: false,
  },
  lunge: {
    id: "lunge",
    view: "side",
    repSignal: { joint: "knee", minRangeDeg: 30 },
    series: ["knee", "hip", "trunk"],
    measures: [
      { id: "kneeFlexionDeg", kind: "flexion", joint: "knee" },
      { id: "hipFlexionDeg", kind: "flexion", joint: "hip" },
      { id: "trunkLeanDeg", kind: "trunk-lean" },
    ],
    faults: [
      { id: "shallow", measure: "kneeFlexionDeg", below: 70 },
      { id: "forward-lean", measure: "trunkLeanDeg", above: 30 },
    ],
    validated: false,
  },
  "hip-hinge": {
    id: "hip-hinge",
    view: "side",
    repSignal: { joint: "hip", minRangeDeg: 30 },
    series: ["hip", "knee", "trunk"],
    measures: [
      { id: "hipFlexionDeg", kind: "flexion", joint: "hip" },
      { id: "kneeFlexionDeg", kind: "flexion", joint: "knee" },
      { id: "trunkLeanDeg", kind: "trunk-lean" },
    ],
    faults: [
      { id: "shallow-hinge", measure: "hipFlexionDeg", below: 45 },
      { id: "squatting-not-hinging", measure: "kneeFlexionDeg", above: 45 },
    ],
    validated: false,
  },
};
