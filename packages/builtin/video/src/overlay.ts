import { BONES } from "@tavi/contracts";

import { encodePng } from "@tavi/child-kit";

import { FLEXION_JOINTS, jointAt, type Joints, type MeasuredJoint, type Point, type Side } from "./angles.js";

/**
 * A rep's overlay: drawn by the
 * owner on the decoder's upright `rgb24` key frame, never on a parsed image.
 * The subject's bones and joints, an arc at each measured joint with its
 * value in degrees, cropped to the subject's box and 15% around it, written
 * as a PNG. Only the subject is drawn, and only the subject is kept: a box
 * outside the frame falls back to the subject's own keypoints, and with
 * neither there is no overlay, never the whole frame with everyone in it.
 */

export interface OverlayAngle {
  readonly joint: MeasuredJoint | "trunk";
  readonly side: Side;
  readonly degrees: number;
}

export interface OverlayInput {
  /** The key frame, `width` × `height` × 3 bytes of RGB. */
  readonly frame: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly joints: Joints;
  /** The subject's box, `[x, y, width, height]`: the crop is it and 15% around it. */
  readonly box?: readonly [number, number, number, number];
  readonly angles: readonly OverlayAngle[];
}

export interface Overlay {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

type Colour = readonly [number, number, number];
const BONE: Colour = [64, 224, 120];
const JOINT: Colour = [255, 255, 255];
const ARC: Colour = [255, 200, 40];
const LABEL_TEXT: Colour = [255, 255, 255];
const LABEL_BACK: Colour = [24, 24, 24];

/** 5 × 7 glyphs for what a label needs: digits, a point, a minus and a degree sign. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "°": ["01100", "10010", "10010", "01100", "00000", "00000", "00000"],
};

class Canvas {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  constructor(pixels: Uint8Array, width: number, height: number) {
    this.pixels = pixels;
    this.width = width;
    this.height = height;
  }

  set(x: number, y: number, colour: Colour): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const at = (py * this.width + px) * 3;
    this.pixels[at] = colour[0];
    this.pixels[at + 1] = colour[1];
    this.pixels[at + 2] = colour[2];
  }

  disc(x: number, y: number, radius: number, colour: Colour): void {
    for (let dy = -radius; dy <= radius; dy += 1)
      for (let dx = -radius; dx <= radius; dx += 1) if (dx * dx + dy * dy <= radius * radius) this.set(x + dx, y + dy, colour);
  }

  line(a: Point, b: Point, thickness: number, colour: Colour): void {
    // Clipped to the canvas, with room for the stroke, before it is stepped: a keypoint far off the frame costs nothing.
    const clipped = clip(a, b, -thickness, -thickness, this.width + thickness, this.height + thickness);
    if (clipped === undefined) return;
    const [from, to] = clipped;
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)));
    for (let step = 0; step <= steps; step += 1)
      this.disc(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps, thickness, colour);
  }

  /** An arc of `radius` around `centre`, from angle `from` to `to` (radians, the shorter way). */
  arc(centre: Point, radius: number, from: number, to: number, colour: Colour): void {
    let sweep = to - from;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const steps = Math.max(8, Math.ceil(Math.abs(sweep) * radius));
    for (let step = 0; step <= steps; step += 1) {
      const angle = from + (sweep * step) / steps;
      this.disc(centre.x + Math.cos(angle) * radius, centre.y + Math.sin(angle) * radius, 1, colour);
    }
  }

  /** `text` at `(x, y)` (its top left), each glyph pixel `scale` × `scale`, on a dark plate. */
  text(text: string, x: number, y: number, scale: number): void {
    const glyphs = [...text].map((character) => GLYPHS[character]).filter((glyph): glyph is readonly string[] => glyph !== undefined);
    const width = glyphs.length * 6 * scale + scale;
    for (let dy = -scale; dy < 8 * scale; dy += 1) for (let dx = -scale; dx < width; dx += 1) this.set(x + dx, y + dy, LABEL_BACK);
    glyphs.forEach((glyph, index) => {
      glyph.forEach((row, rowIndex) => {
        [...row].forEach((bit, column) => {
          if (bit !== "1") return;
          for (let sy = 0; sy < scale; sy += 1)
            for (let sx = 0; sx < scale; sx += 1) this.set(x + (index * 6 + column) * scale + sx, y + rowIndex * scale + sy, LABEL_TEXT);
        });
      });
    });
  }
}

/** The part of `a`-`b` inside the rectangle (Liang-Barsky), or nothing when none of it is. */
function clip(a: Point, b: Point, left: number, top: number, right: number, bottom: number): readonly [Point, Point] | undefined {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return undefined;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let enter = 0;
  let leave = 1;
  for (const [p, q] of [
    [-dx, a.x - left],
    [dx, right - a.x],
    [-dy, a.y - top],
    [dy, bottom - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    if (enter > leave) return undefined;
  }
  return [
    { x: a.x + dx * enter, y: a.y + dy * enter, score: a.score },
    { x: a.x + dx * leave, y: a.y + dy * leave, score: b.score },
  ];
}

/**
 * The vertex and the two directions an angle's arc spans, so the arc is the
 * angle its label prints: a flexion from the proximal segment carried on past
 * the joint to the distal one (0° straight); the ankle's from the line square
 * to the shin, on the toe's side, to the foot; the shoulder's between the
 * trunk and the arm; the trunk's from the upright vertical.
 */
function anglePoints(joints: Joints, angle: OverlayAngle): { readonly vertex: Point; readonly a: Point; readonly b: Point } | undefined {
  if (angle.joint === "trunk") {
    const hip = jointAt(joints, angle.side, "hip");
    const shoulder = jointAt(joints, angle.side, "shoulder");
    return hip === undefined || shoulder === undefined
      ? undefined
      : { vertex: hip, a: { x: hip.x, y: hip.y - 100, score: 1 }, b: shoulder };
  }
  const [first, vertex, last] = FLEXION_JOINTS[angle.joint];
  const p = jointAt(joints, angle.side, first);
  const v = jointAt(joints, angle.side, vertex);
  const d = jointAt(joints, angle.side, last);
  if (p === undefined || v === undefined || d === undefined) return undefined;
  if (angle.joint === "shoulder") return { vertex: v, a: p, b: d };
  if (angle.joint === "ankle") {
    // Square to the shin (ankle to knee turned a quarter), whichever way the toe points.
    const ux = p.x - v.x;
    const uy = p.y - v.y;
    const one = { x: v.x - uy, y: v.y + ux, score: 1 };
    const other = { x: v.x + uy, y: v.y - ux, score: 1 };
    const toward = (q: Point): number => (q.x - v.x) * (d.x - v.x) + (q.y - v.y) * (d.y - v.y);
    return { vertex: v, a: toward(one) >= toward(other) ? one : other, b: d };
  }
  // The proximal segment carried on past the joint: straight is no arc at all.
  return { vertex: v, a: { x: 2 * v.x - p.x, y: 2 * v.y - p.y, score: 1 }, b: d };
}

/** The subject's crop: the box and 15% around it inside the frame, else its keypoints' extent and 15%, else none. */
function cropOf(
  input: OverlayInput,
): { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | undefined {
  const expand = (x: number, y: number, w: number, h: number) => {
    const left = Math.max(0, Math.floor(x - w * 0.15));
    const top = Math.max(0, Math.floor(y - h * 0.15));
    const right = Math.min(input.width, Math.ceil(x + w * 1.15));
    const bottom = Math.min(input.height, Math.ceil(y + h * 1.15));
    return right - left >= 2 && bottom - top >= 2 ? { left, top, right, bottom } : undefined;
  };
  const box = input.box;
  const fromBox = box !== undefined && box.every(Number.isFinite) ? expand(box[0], box[1], box[2], box[3]) : undefined;
  if (fromBox !== undefined) return fromBox;
  const points = Object.values(input.joints).filter(
    (point): point is Point =>
      point !== undefined &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < input.width &&
      point.y < input.height,
  );
  if (points.length === 0) return undefined;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  // A single point still gets a crop around it.
  return expand(x - 20, y - 20, Math.max(...xs) - x + 40, Math.max(...ys) - y + 40);
}

/** The overlay, or undefined when nothing in the frame says where the subject is (no box inside it, no keypoint on it). */
export function drawOverlay(input: OverlayInput): Overlay | undefined {
  if (input.frame.length !== input.width * input.height * 3) throw new RangeError("the frame is not width × height × 3 bytes");
  const crop = cropOf(input);
  if (crop === undefined) return undefined;
  const canvas = new Canvas(new Uint8Array(input.frame), input.width, input.height);
  const thickness = Math.max(1, Math.round(Math.min(input.width, input.height) / 240));
  for (const [from, to] of BONES) {
    const a = input.joints[from];
    const b = input.joints[to];
    if (a !== undefined && b !== undefined) canvas.line(a, b, thickness, BONE);
  }
  for (const point of Object.values(input.joints))
    if (point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y)) canvas.disc(point.x, point.y, thickness + 2, JOINT);
  const scale = Math.max(1, Math.round(Math.min(input.width, input.height) / 200));
  for (const angle of input.angles) {
    const points = anglePoints(input.joints, angle);
    if (points === undefined) continue;
    const radius = Math.max(12, Math.min(input.width, input.height) / 16);
    canvas.arc(
      points.vertex,
      radius,
      Math.atan2(points.a.y - points.vertex.y, points.a.x - points.vertex.x),
      Math.atan2(points.b.y - points.vertex.y, points.b.x - points.vertex.x),
      ARC,
    );
    canvas.text(`${String(Math.round(angle.degrees))}°`, points.vertex.x + radius + 4, points.vertex.y - 4 * scale, scale);
  }
  const { left, top, right, bottom } = crop;
  const width = right - left;
  const height = bottom - top;
  const cropped = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row += 1)
    cropped.set(canvas.pixels.subarray(((top + row) * input.width + left) * 3, ((top + row) * input.width + right) * 3), row * width * 3);
  return { png: encodePng(cropped, width, height, { channels: 3 }), width, height };
}
