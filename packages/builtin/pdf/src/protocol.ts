import { PDF_FRAME } from "@tavi/contracts";

/**
 * Binary framing on the parser child's stdio. Bytes travel as length-prefixed sections, never base64.
 *
 * - stdin, first: `"PDF0" 0x01 len:u32be wasm`
 * - stdin, then: `0x02 jsonLen:u32be json docLen:u32be doc fontCount:u8 (fontLen:u32be font)*`
 * - stdout: `jsonLen:u32be json pngCount:u8 (page:u16be pngLen:u32be png)* docLen:u32be doc`
 *
 * Every section's length is checked against its cap from the prefix, before
 * a byte of it is read. A reader fed a prefix over its cap stops with an
 * error; the owner then kills the child.
 */

/** A frame broke a rule: a section over its cap, a wrong type byte. */
export class FrameError extends Error {}

/** The stream ended before a frame did: the other side exited or crashed. */
export class StreamEndedError extends Error {}

const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeInit(wasm: Uint8Array): Uint8Array {
  return concat([encoder.encode(PDF_FRAME.magic), Uint8Array.of(PDF_FRAME.wasm), u32(wasm.length), wasm]);
}

export function encodeRequest(header: unknown, document: Uint8Array, fonts: readonly Uint8Array[]): Uint8Array {
  if (fonts.length > PDF_FRAME.maxFonts) throw new FrameError("too many fonts");
  const json = encoder.encode(JSON.stringify(header));
  return concat([
    Uint8Array.of(PDF_FRAME.request),
    u32(json.length),
    json,
    u32(document.length),
    document,
    Uint8Array.of(fonts.length),
    ...fonts.flatMap((font) => [u32(font.length), font]),
  ]);
}

export interface ResponseParts {
  readonly json: unknown;
  readonly pngs: readonly { readonly page: number; readonly png: Uint8Array }[];
  readonly document: Uint8Array;
}

export function encodeResponse(
  json: unknown,
  pngs: readonly { readonly page: number; readonly png: Uint8Array }[],
  document: Uint8Array,
): Uint8Array {
  const body = encoder.encode(JSON.stringify(json));
  const page = (value: number): Uint8Array => Uint8Array.of((value >> 8) & 0xff, value & 0xff);
  return concat([
    u32(body.length),
    body,
    Uint8Array.of(pngs.length),
    ...pngs.flatMap((frame) => [page(frame.page), u32(frame.png.length), frame.png]),
    u32(document.length),
    document,
  ]);
}

/**
 * A pull reader over chunks as they arrive: each `take` resolves once its
 * bytes are in. Chunks are kept as they came and joined only for the bytes
 * a section needs.
 */
export class ChunkReader {
  readonly #chunks: Uint8Array[] = [];
  readonly #maxBuffered: number;
  #buffered = 0;
  #ended = false;
  #error: Error | undefined;
  #waiter: (() => void) | undefined;

  /** `maxBuffered` bounds what may wait unread: a writer past it ends the reader with a `FrameError`. */
  constructor(maxBuffered = Number.POSITIVE_INFINITY) {
    this.#maxBuffered = maxBuffered;
  }

  push(chunk: Uint8Array): void {
    if (this.#ended) return;
    if (this.#buffered + chunk.length > this.#maxBuffered) {
      this.end(new FrameError(`more than ${this.#maxBuffered} unread bytes`));
      return;
    }
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    this.#wake();
  }

  end(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error;
    // Nothing more is read: what waits is dropped.
    if (error !== undefined) {
      this.#chunks.length = 0;
      this.#buffered = 0;
    }
    this.#wake();
  }

  /** Bytes buffered and not yet taken. */
  get buffered(): number {
    return this.#buffered;
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  }

  async take(length: number): Promise<Uint8Array> {
    while (this.#buffered < length) {
      if (this.#ended) throw this.#error ?? new StreamEndedError("the stream ended mid-frame");
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const head = this.#chunks[0] as Uint8Array;
      const used = Math.min(head.length, length - offset);
      out.set(head.subarray(0, used), offset);
      offset += used;
      if (used === head.length) this.#chunks.shift();
      else this.#chunks[0] = head.subarray(used);
    }
    this.#buffered -= length;
    return out;
  }

  async u8(): Promise<number> {
    return (await this.take(1))[0] as number;
  }

  async u16(): Promise<number> {
    const bytes = await this.take(2);
    return ((bytes[0] as number) << 8) | (bytes[1] as number);
  }

  async u32(): Promise<number> {
    const bytes = await this.take(4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  }

  /** A length-prefixed section, refused from its prefix when over `cap`. */
  async section(cap: number, what: string): Promise<Uint8Array> {
    const length = await this.u32();
    if (length > cap) throw new FrameError(`${what} of ${length} bytes is over its ${cap}-byte cap`);
    return this.take(length);
  }
}

/** The child's side: the initialization frame's wasm. */
export async function readInit(reader: ChunkReader): Promise<Uint8Array> {
  const magic = decoder.decode(await reader.take(4));
  if (magic !== PDF_FRAME.magic || (await reader.u8()) !== PDF_FRAME.wasm) throw new FrameError("not an initialization frame");
  return reader.section(PDF_FRAME.maxWasmBytes, "wasm");
}

/** The child's side: a request's header, document and fonts. */
export async function readRequest(
  reader: ChunkReader,
  maxDocumentBytes: number,
): Promise<{ readonly header: unknown; readonly document: Uint8Array; readonly fonts: Uint8Array[] }> {
  if ((await reader.u8()) !== PDF_FRAME.request) throw new FrameError("not a request frame");
  const header = JSON.parse(decoder.decode(await reader.section(PDF_FRAME.maxJsonBytes, "request header"))) as unknown;
  const document = await reader.section(maxDocumentBytes, "document");
  const count = await reader.u8();
  if (count > PDF_FRAME.maxFonts) throw new FrameError("too many fonts");
  const fonts: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) fonts.push(await reader.section(PDF_FRAME.maxFontBytes, "font"));
  return { header, document, fonts };
}

/** The owner's side of an OCR request: its header, then each page's PNG. */
export function encodeOcrRequest(header: unknown, images: readonly { readonly page: number; readonly png: Uint8Array }[]): Uint8Array {
  if (images.length > PDF_FRAME.maxPngFrames) throw new FrameError("too many images");
  if (images.reduce((sum, image) => sum + image.png.length, 0) > PDF_FRAME.maxPngBytes)
    throw new FrameError("the images are over their cap together");
  const json = encoder.encode(JSON.stringify(header));
  const page = (value: number): Uint8Array => Uint8Array.of((value >> 8) & 0xff, value & 0xff);
  return concat([
    Uint8Array.of(PDF_FRAME.ocrRequest),
    u32(json.length),
    json,
    Uint8Array.of(images.length),
    ...images.flatMap((image) => [page(image.page), u32(image.png.length), image.png]),
  ]);
}

/** The OCR child's side: the request's header and images, within the image caps. */
export async function readOcrRequest(
  reader: ChunkReader,
): Promise<{ readonly header: unknown; readonly images: { readonly page: number; readonly png: Uint8Array }[] }> {
  if ((await reader.u8()) !== PDF_FRAME.ocrRequest) throw new FrameError("not an OCR request frame");
  const header = JSON.parse(decoder.decode(await reader.section(PDF_FRAME.maxJsonBytes, "request header"))) as unknown;
  const count = await reader.u8();
  if (count > PDF_FRAME.maxPngFrames) throw new FrameError(`${count} images is over the ${PDF_FRAME.maxPngFrames}-frame cap`);
  const images: { page: number; png: Uint8Array }[] = [];
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    const page = await reader.u16();
    const png = await reader.section(PDF_FRAME.maxPngBytes - bytes, "images");
    bytes += png.length;
    images.push({ page, png });
  }
  return { header, images };
}

/** The owner's side: a response, each section within its cap. */
export async function readResponse(reader: ChunkReader, maxDocumentBytes: number): Promise<ResponseParts> {
  const json = JSON.parse(decoder.decode(await reader.section(PDF_FRAME.maxJsonBytes, "answer"))) as unknown;
  const count = await reader.u8();
  if (count > PDF_FRAME.maxPngFrames) throw new FrameError(`${count} images is over the ${PDF_FRAME.maxPngFrames}-frame cap`);
  const pngs: { page: number; png: Uint8Array }[] = [];
  let pngBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const page = await reader.u16();
    const png = await reader.section(PDF_FRAME.maxPngBytes - pngBytes, "images");
    pngBytes += png.length;
    pngs.push({ page, png });
  }
  const document = await reader.section(maxDocumentBytes, "filled document");
  return { json, pngs, document };
}
