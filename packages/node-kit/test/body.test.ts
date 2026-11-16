import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { BodyTooLargeError, readBoundedBody } from "../src/index.js";

const encoder = new TextEncoder();

/** A web stream of `parts`, recording whether it was cancelled. */
function webStream(parts: readonly string[]): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly cancelled: () => boolean;
  readonly pulled: () => number;
} {
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const part = parts[index];
        index += 1;
        if (part === undefined) controller.close();
        else controller.enqueue(encoder.encode(part));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, cancelled: () => cancelled, pulled: () => index };
}

describe("readBoundedBody", () => {
  it("reads a body under the limit whole", async () => {
    const read = await readBoundedBody(new Response("hello world"), 64);
    expect(read.bytes.toString("utf8")).toBe("hello world");
    expect(read).toMatchObject({ total: 11, truncated: false });
  });

  it("reads a body of exactly the limit", async () => {
    const read = await readBoundedBody(webStream(["ab", "cd"]).stream, 4);
    expect(read.bytes.toString("utf8")).toBe("abcd");
    expect(read.truncated).toBe(false);
  });

  it("reads no body as empty", async () => {
    for (const source of [null, undefined, new Response(null)]) {
      const read = await readBoundedBody(source, 4);
      expect(read.bytes.byteLength).toBe(0);
      expect(read.total).toBe(0);
    }
  });

  it("stops at the chunk that passes the limit, cancels the stream and throws", async () => {
    const source = webStream(["abc", "def", "ghi", "jkl"]);
    const error = await readBoundedBody(source.stream, 5).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BodyTooLargeError);
    expect(error).toMatchObject({ limit: 5, declared: undefined });
    expect(source.cancelled()).toBe(true);
    expect(source.pulled()).toBe(2);
  });

  it("refuses a declared Content-Length over the limit before reading", async () => {
    const source = webStream(["0123456789"]);
    const response = new Response(source.stream, { headers: { "content-length": "10" } });
    const error = await readBoundedBody(response, 5).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "BodyTooLargeError", limit: 5, declared: 10 });
    expect(source.pulled()).toBe(0);
  });

  it("keeps the first maxBytes when truncating, and counts what was read", async () => {
    const source = webStream(["abc", "def", "ghi"]);
    const read = await readBoundedBody(source.stream, 5, { overflow: "truncate" });
    expect(read.bytes.toString("utf8")).toBe("abcde");
    expect(read).toMatchObject({ total: 6, truncated: true });
    expect(source.cancelled()).toBe(true);
  });

  it("truncates a response whose Content-Length is over the limit rather than refusing it", async () => {
    const read = await readBoundedBody(new Response("0123456789", { headers: { "content-length": "10" } }), 4, { overflow: "truncate" });
    expect(read.bytes.toString("utf8")).toBe("0123");
    expect(read.truncated).toBe(true);
  });

  it("reads a Node stream, and destroys it past the limit", async () => {
    const small = await readBoundedBody(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), 8);
    expect(small.bytes.toString("utf8")).toBe("abcd");
    const large = Readable.from([Buffer.from("abcd"), Buffer.from("efgh"), Buffer.from("ijkl")]);
    await expect(readBoundedBody(large, 6)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(large.destroyed).toBe(true);
  });

  it("rejects with the signal's reason when aborted mid-read, and cancels the source", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const reading = readBoundedBody(stream, 1_000, { signal: controller.signal });
    const reason = new Error("gave up");
    setTimeout(() => controller.abort(reason), 10);
    await expect(reading).rejects.toBe(reason);
    expect(cancelled).toBe(true);
  });

  it("rejects when a Node stream stalls and the signal aborts", async () => {
    const stalled = new Readable({ read() {} });
    stalled.push(Buffer.from("x"));
    const controller = new AbortController();
    const reading = readBoundedBody(stalled, 1_000, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("timeout")), 10);
    await expect(reading).rejects.toThrow("timeout");
    expect(stalled.destroyed).toBe(true);
  });

  it("rejects when a Response read is aborted, and cancels its body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("part"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const reading = readBoundedBody(new Response(stream), 1_000, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("aborted")), 10);
    await expect(reading).rejects.toThrow("aborted");
    expect(cancelled).toBe(true);
  });

  it("reads a Response-shaped object that is not the global class", async () => {
    const lookalike = {
      headers: new Headers({ "content-length": "9" }),
      body: webStream(["123456789"]).stream,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    await expect(readBoundedBody(lookalike as unknown as Response, 4)).rejects.toMatchObject({ declared: 9 });
    const fits = { headers: new Headers(), body: webStream(["ab"]).stream, arrayBuffer: async () => new ArrayBuffer(0) };
    expect((await readBoundedBody(fits as unknown as Response, 4)).bytes.toString("utf8")).toBe("ab");
  });

  it("refuses a Node request whose Content-Length is over the limit before reading", async () => {
    const request = Object.assign(Readable.from([Buffer.from("0123456789")]), { headers: { "content-length": "10" } });
    await expect(readBoundedBody(request, 5)).rejects.toMatchObject({ declared: 10 });
    expect(request.destroyed).toBe(true);
  });

  it("counts a string chunk in bytes", async () => {
    // "é" is two bytes in UTF-8: five characters, six bytes.
    await expect(readBoundedBody(Readable.from(["héllo"]), 5)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect((await readBoundedBody(Readable.from(["héllo"]), 6)).bytes.toString("utf8")).toBe("héllo");
  });

  it("rejects at once on a signal already aborted", async () => {
    await expect(readBoundedBody(new Response("x"), 4, { signal: AbortSignal.abort(new Error("early")) })).rejects.toThrow("early");
  });
});
