import { afterEach, describe, expect, it, vi } from "vitest";

import { workerLines } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A response whose body arrives in the given chunks. */
function chunked(chunks: readonly Uint8Array[], status = 200): { readonly response: Response; readonly cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body, { status }), cancelled: () => cancelled };
}
const collect = async (lines: AsyncIterable<string>): Promise<string[]> => {
  const all: string[] = [];
  for await (const line of lines) all.push(line);
  return all;
};

describe("workerLines (P2.4)", () => {
  it("yields whole lines across chunk edges, a character split between chunks included", async () => {
    const bytes = new TextEncoder().encode("a;Straße\nb;Ort\nlast");
    const split = bytes.indexOf(0xc3) + 1;
    const { response } = chunked([bytes.slice(0, 3), bytes.slice(3, split), bytes.slice(split)]);
    vi.stubGlobal("fetch", async () => response);
    expect(await collect(workerLines("https://example.org/file.csv", {}, new AbortController().signal))).toEqual([
      "a;Straße",
      "b;Ort",
      "last",
    ]);
  });

  it("refuses an answer that is not a 200, cancelling its body", async () => {
    const answer = chunked([new TextEncoder().encode("not found")], 404);
    vi.stubGlobal("fetch", async () => answer.response);
    await expect(collect(workerLines("https://example.org/file.csv", {}, new AbortController().signal))).rejects.toThrow("HTTP 404");
    expect(answer.cancelled()).toBe(true);
  });

  it("refuses a line that never ends", async () => {
    const { response } = chunked([new Uint8Array(1024 * 1024 + 10).fill(0x61)]);
    vi.stubGlobal("fetch", async () => response);
    await expect(collect(workerLines("https://example.org/file.csv", {}, new AbortController().signal))).rejects.toThrow(/a line is over/);
  });
});
