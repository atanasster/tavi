import { PDF_FRAME } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import {
  ChunkReader,
  encodeInit,
  encodeOcrRequest,
  encodeRequest,
  encodeResponse,
  FrameError,
  readInit,
  readOcrRequest,
  readRequest,
  readResponse,
  StreamEndedError,
} from "../src/protocol.js";

/** A reader fed `bytes` in small chunks, as a pipe delivers them. */
function feed(bytes: Uint8Array, chunk = 7): ChunkReader {
  const reader = new ChunkReader();
  for (let at = 0; at < bytes.length; at += chunk) reader.push(bytes.subarray(at, at + chunk));
  reader.end();
  return reader;
}

const u32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

describe("the child's framing", () => {
  it("carries wasm, a request with two fonts, and an answer with images and a document, without base64", async () => {
    const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 2, 3);
    const document = new Uint8Array(1_000).fill(9);
    const fonts = [Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)];
    const inbound = feed(new Uint8Array([...encodeInit(wasm), ...encodeRequest({ op: "facts" }, document, fonts)]));
    expect(await readInit(inbound)).toEqual(wasm);
    expect(await readRequest(inbound, 2_000)).toEqual({ header: { op: "facts" }, document, fonts });
    const png = new Uint8Array(500).fill(7);
    const answer = feed(
      encodeResponse(
        { ok: true },
        [
          { page: 3, png },
          { page: 300, png },
        ],
        document,
      ),
    );
    expect(await readResponse(answer, 1_000)).toEqual({
      json: { ok: true },
      pngs: [
        { page: 3, png },
        { page: 300, png },
      ],
      document,
    });
  });

  it("refuses a section from its length prefix, before reading it", async () => {
    // A prefix claiming 2 GiB, followed by nothing: refused at once rather than awaited.
    const lying = feed(Uint8Array.of(...u32(2 ** 31)));
    await expect(readResponse(lying, 1_000)).rejects.toThrow(FrameError);
    const document = feed(encodeResponse({ ok: true }, [], new Uint8Array(10)));
    await expect(readResponse(document, 9)).rejects.toThrow(/filled document of 10 bytes is over its 9-byte cap/);
  });

  it("caps the images: their count, and their bytes together", async () => {
    const many = encodeResponse(
      {},
      Array.from({ length: PDF_FRAME.maxPngFrames + 1 }, (_, page) => ({ page, png: Uint8Array.of(1) })),
      new Uint8Array(0),
    );
    await expect(readResponse(feed(many), 0)).rejects.toThrow(/frame cap/);
    const big = new Uint8Array(PDF_FRAME.maxPngBytes / 2 + 1);
    await expect(
      readResponse(
        feed(
          encodeResponse(
            {},
            [
              { page: 1, png: big },
              { page: 2, png: big },
            ],
            new Uint8Array(0),
          ),
          65_536,
        ),
        0,
      ),
    ).rejects.toThrow(/images/);
  });

  it("carries an OCR request's pages as images, within the image caps", async () => {
    const png = new Uint8Array(300).fill(4);
    const header = { op: "ocr", language: "eng", pages: [2, 7] };
    expect(
      await readOcrRequest(
        feed(
          encodeOcrRequest(header, [
            { page: 2, png },
            { page: 7, png },
          ]),
        ),
      ),
    ).toEqual({
      header,
      images: [
        { page: 2, png },
        { page: 7, png },
      ],
    });
    // A parser's request is no OCR request.
    await expect(readOcrRequest(feed(encodeRequest({ op: "facts" }, new Uint8Array(0), [])))).rejects.toThrow(/not an OCR request frame/);
    const many = Array.from({ length: PDF_FRAME.maxPngFrames + 1 }, (_, page) => ({ page, png: Uint8Array.of(1) }));
    expect(() => encodeOcrRequest(header, many)).toThrow(FrameError);
    const big = new Uint8Array(PDF_FRAME.maxPngBytes / 2 + 1);
    expect(() =>
      encodeOcrRequest(header, [
        { page: 1, png: big },
        { page: 2, png: big },
      ]),
    ).toThrow(/over their cap together/);
  });

  it("stops on a stream that ends mid-frame, and on a frame that is not one", async () => {
    await expect(readInit(feed(Uint8Array.of(0x50, 0x44)))).rejects.toThrow(StreamEndedError);
    await expect(readInit(feed(new TextEncoder().encode("NOPE\u0001")))).rejects.toThrow(/not an initialization frame/);
  });
});

describe("the chunk reader", () => {
  it("stops buffering past its cap and drops what waits", async () => {
    const reader = new ChunkReader(10);
    reader.push(new Uint8Array(8));
    reader.push(new Uint8Array(8));
    expect(reader.buffered).toBe(0);
    await expect(reader.take(1)).rejects.toThrow(/unread bytes/);
  });

  it("tells an ended stream from a broken frame", async () => {
    const reader = new ChunkReader();
    reader.end();
    await expect(reader.take(1)).rejects.toThrow(StreamEndedError);
  });
});
