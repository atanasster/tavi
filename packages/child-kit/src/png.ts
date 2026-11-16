import { crc32, deflateSync } from "node:zlib";

/**
 * Raw pixels as a PNG, by `node:zlib` alone: what both engines write their
 * images with, the PDF engine's rendered pages (RGBA; its own encoder
 * returned none under Node) and the
 * video owner's pose overlays (RGB). No image
 * is parsed: only pixels the engine made are written.
 */

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0);
  return out;
}

export interface PngLayout {
  /** 3 for RGB, 4 for RGBA. */
  readonly channels: 3 | 4;
  /** Bytes from one row's start to the next's in `pixels`; by default `width × channels`. */
  readonly stride?: number;
}

/** An 8-bit RGB or RGBA PNG of `width × height` pixels. */
export function encodePng(pixels: Uint8Array, width: number, height: number, layout: PngLayout): Uint8Array {
  const rowBytes = width * layout.channels;
  const stride = layout.stride ?? rowBytes;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    stride < rowBytes ||
    pixels.length < stride * (height - 1) + rowBytes
  )
    throw new RangeError(`the pixels are not ${String(width)} × ${String(height)} × ${String(layout.channels)} bytes`);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = layout.channels === 4 ? 6 : 2; // RGBA or truecolour
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const at = row * (rowBytes + 1);
    raw[at] = 0; // no filter
    raw.set(pixels.subarray(row * stride, row * stride + rowBytes), at + 1);
  }
  const parts = [SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
