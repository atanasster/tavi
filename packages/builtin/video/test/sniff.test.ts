import { describe, expect, it } from "vitest";

import { demuxerOf, sniffVideo } from "../src/sniff.js";

const bytes = (...parts: (string | readonly number[])[]): Uint8Array =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : [...part])));
const ftyp = (brand: string): Uint8Array => bytes([0, 0, 0, 0x18], "ftyp", brand, [0, 0, 0, 0], "isom", "mp41");
/** An EBML header: id, size, then DocTypeVersion and DocType children. */
const ebml = (docType: string): Uint8Array => {
  const children = bytes([0x42, 0x87, 0x81, 0x04], [0x42, 0x82, 0x80 | docType.length], docType);
  return bytes([0x1a, 0x45, 0xdf, 0xa3, 0x80 | children.length], [...children]);
};

describe("sniffing a video from its bytes", () => {
  it("names each container by its own signature", () => {
    expect(sniffVideo(ftyp("isom"))).toBe("mp4");
    expect(sniffVideo(ftyp("mp42"))).toBe("mp4");
    expect(sniffVideo(ftyp("qt  "))).toBe("mov");
    expect(sniffVideo(ftyp("3gp5"))).toBe("3gp");
    expect(sniffVideo(ftyp("3g2a"))).toBe("3gp");
    expect(sniffVideo(ebml("webm"))).toBe("webm");
    expect(sniffVideo(ebml("matroska"))).toBe("matroska");
    expect(sniffVideo(bytes("GIF89a", [1, 0, 1, 0]))).toBe("gif");
    expect(sniffVideo(bytes("GIF87a"))).toBe("gif");
  });

  it("refuses ISO files that are not video, and keeps other MP4 brands as intake does", () => {
    for (const brand of ["crx ", "jp2 ", "M4A ", "M4B ", "heic", "avif", "mif1"]) expect(sniffVideo(ftyp(brand)), brand).toBeUndefined();
    for (const brand of ["dash", "XAVC", "f4v ", "avc1", "M4V "]) expect(sniffVideo(ftyp(brand)), brand).toBe("mp4");
  });

  it("refuses what FFmpeg must never be handed: playlists, concat lists, SDP, text, an EBML of another kind", () => {
    expect(sniffVideo(bytes("#EXTM3U\n#EXT-X-VERSION:3\n"))).toBeUndefined();
    expect(sniffVideo(bytes("ffconcat version 1.0\nfile 'a.mp4'\n"))).toBeUndefined();
    expect(sniffVideo(bytes("v=0\no=- 0 0 IN IP4 127.0.0.1\n"))).toBeUndefined();
    expect(sniffVideo(bytes("just some text named .mp4"))).toBeUndefined();
    expect(sniffVideo(new Uint8Array(0))).toBeUndefined();
    expect(sniffVideo(ebml("other"))).toBeUndefined();
    // A truncated EBML header is not a guess.
    expect(sniffVideo(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBeUndefined();
  });

  it("fixes the demuxer from the container", () => {
    expect(demuxerOf("mp4")).toBe("mov");
    expect(demuxerOf("3gp")).toBe("mov");
    expect(demuxerOf("webm")).toBe("matroska");
    expect(demuxerOf("gif")).toBe("gif");
  });
});
