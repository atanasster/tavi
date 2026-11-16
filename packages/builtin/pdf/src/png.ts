import { encodePng as encode } from "@tavi/child-kit";

/**
 * RGBA pixels as a PNG. `EPDF_PNG_EncodeRGBA` returns no image under Node,
 * so a small `node:zlib` encoder is
 * the encoder: the child kit's, the
 * one the video owner's overlays use too.
 */

/** An 8-bit RGBA PNG of `width × height` pixels, rows `stride` bytes apart in `pixels`. */
export function encodePng(pixels: Uint8Array, width: number, height: number, stride = width * 4): Uint8Array {
  return encode(pixels, width, height, { channels: 4, stride });
}
