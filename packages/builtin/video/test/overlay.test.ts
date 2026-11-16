import { crc32, inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { Joints } from "../src/angles.js";
import { drawOverlay, type Overlay } from "../src/overlay.js";

/** A rep's overlay: drawn on raw RGB, read back here byte for byte. */

function decode(png: Uint8Array): { readonly width: number; readonly height: number; readonly rgb: Uint8Array } {
  const bytes = Buffer.from(png);
  let offset = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    expect(bytes.readUInt32BE(offset + 8 + length)).toBe(crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect(body[9]).toBe(2);
    }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(data));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) rgb.set(rows.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1)), y * width * 3);
  return { width, height, rgb };
}

const pixel = (image: { readonly width: number; readonly rgb: Uint8Array }, x: number, y: number): string =>
  [...image.rgb.subarray((y * image.width + x) * 3, (y * image.width + x) * 3 + 3)].join();
const count = (image: ReturnType<typeof decode>, colour: string): number => {
  let found = 0;
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) if (pixel(image, x, y) === colour) found += 1;
  return found;
};
const ARC = "255,200,40";
const BONE = "64,224,120";

const width = 320;
const height = 240;
const grey = new Uint8Array(width * height * 3).fill(90);
const at = (x: number, y: number) => ({ x, y, score: 0.9 });
const drawn = (overlay: Overlay | undefined): Overlay => {
  if (overlay === undefined) throw new Error("no overlay");
  return overlay;
};

describe("a rep's overlay", () => {
  const joints: Joints = { left_hip: at(150, 120), left_knee: at(200, 140), left_ankle: at(180, 200), left_shoulder: at(170, 50) };

  it("draws the subject's bones and an angle's arc on the frame, leaves the rest of it as it was, and crops to the subject", () => {
    const overlay = drawn(
      drawOverlay({
        frame: grey,
        width,
        height,
        joints,
        box: [140, 40, 80, 170],
        angles: [{ joint: "knee", side: "left", degrees: 92.4 }],
      }),
    );
    const image = decode(overlay.png);
    expect([overlay.width, overlay.height]).toEqual([image.width, image.height]);
    expect(image.width).toBe(Math.ceil(140 + 80 * 1.15) - Math.floor(140 - 80 * 0.15));
    expect(image.height).toBe(Math.min(height, Math.ceil(40 + 170 * 1.15)) - Math.floor(40 - 170 * 0.15));
    const left = Math.floor(140 - 80 * 0.15);
    const top = Math.floor(40 - 170 * 0.15);
    expect(pixel(image, 175 - left, 130 - top)).toBe(BONE);
    expect(pixel(image, 0, 0)).toBe("90,90,90");
    expect(count(image, ARC)).toBeGreaterThan(10);
    expect(grey.every((value) => value === 90)).toBe(true);
  });

  it("draws an arc as wide as the flexion its label prints: none for a straight knee, a quarter for 90°", () => {
    const straight = { left_hip: at(160, 40), left_knee: at(160, 120), left_ankle: at(160, 200) };
    const bent = { left_hip: at(100, 120), left_knee: at(160, 120), left_ankle: at(160, 200) };
    const arcOf = (pose: Joints, degrees: number): number =>
      count(
        decode(
          drawn(
            drawOverlay({
              frame: grey,
              width,
              height,
              joints: pose,
              box: [60, 20, 200, 200],
              angles: [{ joint: "knee", side: "left", degrees }],
            }),
          ).png,
        ),
        ARC,
      );
    const quarter = arcOf(bent, 90);
    expect(arcOf(straight, 0)).toBeLessThan(quarter / 4);
    expect(quarter).toBeGreaterThan(20);
  });

  it("crops to the keypoints when the box is outside the frame or not a number, and makes none with nothing in it", () => {
    for (const box of [
      [50_000, 50_000, 10, 10],
      [Number.NaN, 0, 10, 10],
    ] as const) {
      const overlay = drawn(drawOverlay({ frame: grey, width, height, joints, box, angles: [] }));
      // Around the keypoints (150-200 × 50-200) and 15%, never the whole frame.
      expect(overlay.width).toBeLessThan(width);
      expect(overlay.height).toBeLessThanOrEqual(height);
    }
    expect(
      drawOverlay({ frame: grey, width, height, joints: { left_hip: at(-500, -500) }, box: [50_000, 0, 10, 10], angles: [] }),
    ).toBeUndefined();
    expect(() => drawOverlay({ frame: new Uint8Array(3), width, height, joints, angles: [] })).toThrow(RangeError);
  });

  it("draws the part of a bone that crosses the frame from far off it, quickly", () => {
    const far = { left_hip: at(-100_000, 120), left_knee: at(100_000, 120), left_shoulder: at(160, 60) };
    const started = performance.now();
    const overlay = drawn(
      drawOverlay({
        frame: grey,
        width,
        height,
        joints: far,
        box: [0, 0, width, height],
        angles: [{ joint: "hip", side: "left", degrees: 10 }],
      }),
    );
    expect(performance.now() - started).toBeLessThan(200);
    expect(pixel(decode(overlay.png), 160, 120)).toBe(BONE);
  });
});
