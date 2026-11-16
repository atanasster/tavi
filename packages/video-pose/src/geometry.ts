/**
 * The pose add-on's image arithmetic: a frame's raw RGB letterboxed for the detector and cropped around a
 * person for RTMPose, both bilinear into normalised CHW floats, and the
 * models' answers mapped back to the frame's pixels: the detector's boxes,
 * and RTMPose's SimCC keypoints.
 */

/** A box in a frame's pixels: `[x, y, width, height]`. */
export type Box = readonly [number, number, number, number];

/** RTMPose's ImageNet normalisation, on RGB (mmpose's data preprocessor). */
export const POSE_MEAN = [123.675, 116.28, 103.53] as const;
export const POSE_STD = [58.395, 57.12, 57.375] as const;
/** RTMDet's, on BGR (mmdet's data preprocessor; mmdeploy's end-to-end export leaves it to the caller). */
const DETECTOR_MEAN = [103.53, 116.28, 123.675] as const;
const DETECTOR_STD = [57.375, 57.12, 58.395] as const;

/** The pixel at `(x, y)` of `rgb`, bilinear, channel `c`; outside the frame, `pad`. */
function sample(rgb: Uint8Array, width: number, height: number, x: number, y: number, c: number, pad: number): number {
  if (x < -0.5 || y < -0.5 || x > width - 0.5 || y > height - 0.5) return pad;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const at = (px: number, py: number): number => rgb[(py * width + px) * 3 + c] as number;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

interface Sampling {
  /** The model's channels in BGR order (mmdet's detectors), not RGB. */
  readonly bgr: boolean;
  /**
   * How an output pixel maps to the frame: `centre` as a resize does (pixel
   * centres to pixel centres, mmdet's `cv2.resize`), `corner` as an affine
   * warp does (pixel to pixel, mmpose's `cv2.warpAffine`).
   */
  readonly grid: "centre" | "corner";
}

/** A region of the frame resampled to `outWidth` × `outHeight`, as CHW floats, each channel `(value − mean) / std`. */
function resample(
  rgb: Uint8Array,
  width: number,
  height: number,
  region: { readonly x: number; readonly y: number; readonly scaleX: number; readonly scaleY: number },
  outWidth: number,
  outHeight: number,
  mean: readonly number[],
  std: readonly number[],
  pad: number,
  sampling: Sampling,
): Float32Array {
  const out = new Float32Array(3 * outWidth * outHeight);
  const plane = outWidth * outHeight;
  for (let oy = 0; oy < outHeight; oy += 1) {
    for (let ox = 0; ox < outWidth; ox += 1) {
      const x = sampling.grid === "centre" ? region.x + (ox + 0.5) * region.scaleX - 0.5 : region.x + ox * region.scaleX;
      const y = sampling.grid === "centre" ? region.y + (oy + 0.5) * region.scaleY - 0.5 : region.y + oy * region.scaleY;
      for (let c = 0; c < 3; c += 1)
        out[c * plane + oy * outWidth + ox] =
          (sample(rgb, width, height, x, y, sampling.bgr ? 2 - c : c, pad) - (mean[c] as number)) / (std[c] as number);
    }
  }
  return out;
}

export interface Letterbox {
  readonly tensor: Float32Array;
  /** Frame pixels per input pixel. */
  readonly scale: number;
}

/**
 * The frame fitted into a `size` × `size` square for the detector, kept to
 * its aspect at the top left, the rest grey (114, as mmdet pads), in BGR,
 * normalised as RTMDet was trained.
 */
export function letterbox(rgb: Uint8Array, width: number, height: number, size: number): Letterbox {
  const scale = Math.max(width, height) / size;
  return {
    tensor: resample(rgb, width, height, { x: 0, y: 0, scaleX: scale, scaleY: scale }, size, size, DETECTOR_MEAN, DETECTOR_STD, 114, {
      bgr: true,
      grid: "centre",
    }),
    scale,
  };
}

export interface PoseCrop {
  readonly tensor: Float32Array;
  /** The crop's top left and size, in frame pixels: what maps keypoints back. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A person's box, 25% larger and widened or heightened to the model's aspect
 * (as mmpose's top-down affine does, without rotation), resampled to the
 * pose model's `inputWidth` × `inputHeight` and normalised.
 */
export function cropPerson(rgb: Uint8Array, width: number, height: number, box: Box, inputWidth: number, inputHeight: number): PoseCrop {
  const [bx, by, bw, bh] = box;
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  let w = Math.max(1, bw * 1.25);
  let h = Math.max(1, bh * 1.25);
  const aspect = inputWidth / inputHeight;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  const x = cx - w / 2;
  const y = cy - h / 2;
  return {
    tensor: resample(
      rgb,
      width,
      height,
      { x, y, scaleX: w / inputWidth, scaleY: h / inputHeight },
      inputWidth,
      inputHeight,
      POSE_MEAN,
      POSE_STD,
      0,
      { bgr: false, grid: "corner" },
    ),
    x,
    y,
    width: w,
    height: h,
  };
}

/**
 * RTMPose's SimCC answer as keypoints in the frame's pixels: for each joint,
 * the best bin along x and along y (each `splitRatio` bins a pixel), its
 * score the lesser of the two maxima, clamped to [0, 1], as mmpose's
 * `get_simcc_maximum` does.
 */
export function decodeSimcc(
  simccX: ArrayLike<number>,
  simccY: ArrayLike<number>,
  joints: number,
  crop: Pick<PoseCrop, "x" | "y" | "width" | "height">,
  inputWidth: number,
  inputHeight: number,
  splitRatio = 2,
): [number, number, number][] {
  const binsX = Math.round(inputWidth * splitRatio);
  const binsY = Math.round(inputHeight * splitRatio);
  if (simccX.length !== joints * binsX || simccY.length !== joints * binsY)
    throw new RangeError(
      `the model answered ${String(simccX.length)} and ${String(simccY.length)} values, not ${String(joints)} joints of ${String(binsX)} and ${String(binsY)} bins`,
    );
  const best = (values: ArrayLike<number>, offset: number, count: number): readonly [number, number] => {
    let index = 0;
    let value = -Infinity;
    for (let bin = 0; bin < count; bin += 1) {
      const candidate = values[offset + bin] as number;
      if (candidate > value) {
        value = candidate;
        index = bin;
      }
    }
    return [index, value];
  };
  const keypoints: [number, number, number][] = [];
  for (let joint = 0; joint < joints; joint += 1) {
    const [ix, vx] = best(simccX, joint * binsX, binsX);
    const [iy, vy] = best(simccY, joint * binsY, binsY);
    const x = crop.x + (ix / splitRatio) * (crop.width / inputWidth);
    const y = crop.y + (iy / splitRatio) * (crop.height / inputHeight);
    const score = Math.max(0, Math.min(1, Math.min(vx, vy)));
    keypoints.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(score * 1000) / 1000]);
  }
  return keypoints;
}

/**
 * The people an mmdeploy end-to-end detector found (`dets`: `[x1, y1, x2,
 * y2, score]` per detection in the letterboxed input; `labels`: class 0 is
 * a person), scored at least `minScore`, as boxes in the frame's pixels,
 * largest score first, at most `most`.
 */
export function peopleIn(
  dets: ArrayLike<number>,
  labels: ArrayLike<number | bigint>,
  scale: number,
  frame: { readonly width: number; readonly height: number },
  minScore = 0.3,
  most = 10,
): { readonly box: Box; readonly score: number }[] {
  const found: { readonly box: Box; readonly score: number }[] = [];
  const count = Math.min(Math.floor(dets.length / 5), labels.length);
  for (let index = 0; index < count; index += 1) {
    if (Number(labels[index]) !== 0) continue;
    const score = dets[index * 5 + 4] as number;
    if (!(score >= minScore)) continue;
    const x1 = Math.max(0, Math.min(frame.width, (dets[index * 5] as number) * scale));
    const y1 = Math.max(0, Math.min(frame.height, (dets[index * 5 + 1] as number) * scale));
    const x2 = Math.max(0, Math.min(frame.width, (dets[index * 5 + 2] as number) * scale));
    const y2 = Math.max(0, Math.min(frame.height, (dets[index * 5 + 3] as number) * scale));
    if (x2 - x1 < 2 || y2 - y1 < 2) continue;
    found.push({ box: [x1, y1, x2 - x1, y2 - y1], score: Math.min(1, score) });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, most);
}

function overlap(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const union = a[2] * a[3] + b[2] * b[3] - x * y;
  return union <= 0 ? 0 : (x * y) / union;
}

/**
 * The subject among a frame's people: on the first frame, the largest and
 * most central; after it, whoever overlaps the subject's last box most, or,
 * when nobody does, a crop around the last box (the tracker's own guess).
 */
export function subjectBox(
  people: readonly { readonly box: Box }[],
  last: Box | undefined,
  frame: { readonly width: number; readonly height: number },
): Box | undefined {
  if (last !== undefined) {
    let best: Box | undefined;
    let most = 0;
    for (const person of people) {
      const shared = overlap(last, person.box);
      if (shared > most) {
        most = shared;
        best = person.box;
      }
    }
    return best ?? last;
  }
  const diagonal = Math.hypot(frame.width, frame.height) || 1;
  let best: Box | undefined;
  let score = -Infinity;
  for (const person of people) {
    const [x, y, w, h] = person.box;
    const value =
      (w * h) / (frame.width * frame.height || 1) - Math.hypot(x + w / 2 - frame.width / 2, y + h / 2 - frame.height / 2) / diagonal;
    if (value > score) {
      score = value;
      best = person.box;
    }
  }
  return best;
}
