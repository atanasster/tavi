import { crc32, inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { encodePng } from "../src/png.js";

/** The engines' one PNG encoder: RGB and RGBA, read back here byte for byte, each chunk's CRC checked. */

function decodePng(png: Uint8Array): {
  readonly width: number;
  readonly height: number;
  readonly colourType: number;
  readonly pixels: Uint8Array;
} {
  const bytes = Buffer.from(png);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    expect(bytes.readUInt32BE(offset + 8 + length)).toBe(crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colourType = body[9] as number;
      expect(body[8]).toBe(8);
    }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const channels = colourType === 6 ? 4 : 3;
  const rows = inflateSync(Buffer.concat(data));
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    expect(rows[y * (width * channels + 1)]).toBe(0);
    pixels.set(rows.subarray(y * (width * channels + 1) + 1, (y + 1) * (width * channels + 1)), y * width * channels);
  }
  return { width, height, colourType, pixels };
}

describe("a PNG from raw pixels", () => {
  it("holds RGB and RGBA pixels as given, rows a stride apart, and refuses too few bytes", () => {
    const rgb = new Uint8Array(4 * 3 * 3).map((_, index) => index * 7);
    expect(decodePng(encodePng(rgb, 4, 3, { channels: 3 }))).toEqual({ width: 4, height: 3, colourType: 2, pixels: rgb });
    const rgba = new Uint8Array(2 * 2 * 4).map((_, index) => index * 11);
    expect(decodePng(encodePng(rgba, 2, 2, { channels: 4 }))).toEqual({ width: 2, height: 2, colourType: 6, pixels: rgba });
    // Rows 12 bytes apart, 8 of them the image's.
    const strided = new Uint8Array(24).map((_, index) => index);
    expect(decodePng(encodePng(strided, 2, 2, { channels: 4, stride: 12 })).pixels).toEqual(
      Uint8Array.of(...strided.subarray(0, 8), ...strided.subarray(12, 20)),
    );
    expect(() => encodePng(new Uint8Array(5), 2, 2, { channels: 3 })).toThrow(RangeError);
  });
});
