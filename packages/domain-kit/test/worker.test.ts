import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { retryAfterMs as sharedRetryAfterMs } from "@tavi/contracts/util";

import { KIT_ZOD, createWorkerFetcher, minhashBands, minhashSignature, minhashSimilarity, objectsOf, retryAfterMs } from "../src/index.js";

describe("a worker's request", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads JSON when asked, its text when it is not JSON, and keeps the headers it names", async () => {
    const asked: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      asked.push({ url, init });
      return new Response(url.endsWith("json") ? '{"a":1}' : "not json", { status: 200, headers: { "retry-after": "5", etag: '"v1"' } });
    });
    const fetcher = createWorkerFetcher<{ readonly url: string; readonly read: "json" | "text" }>({
      timeoutMs: 1_000,
      init: () => ({ headers: { Accept: "application/json" } }),
      read: (request) => request.read,
      keep: { etag: "etag" },
    });
    const signal = new AbortController().signal;
    expect(await fetcher({ url: "https://a.example/json", read: "json" }, signal)).toEqual({
      status: 200,
      retryAfter: "5",
      etag: '"v1"',
      body: { a: 1 },
      bytes: 7,
    });
    expect(await fetcher({ url: "https://a.example/other", read: "json" }, signal)).toMatchObject({ body: "not json" });
    expect(await fetcher({ url: "https://a.example/json", read: "text" }, signal)).toMatchObject({ body: '{"a":1}' });
    expect(asked[0]?.init.headers).toEqual({ Accept: "application/json" });
    expect(asked[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses an answer past its bound rather than cutting it", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
    const fetcher = createWorkerFetcher<{ readonly url: string }>({ timeoutMs: 1_000, init: () => ({}), read: () => "bytes" });
    await expect(fetcher({ url: "https://a.example/" }, new AbortController().signal)).rejects.toThrow(/over 8388608 bytes/);
  });
});

describe("Retry-After", () => {
  it("is the contracts' reading, on the kit's surface for its sources", () => {
    expect(retryAfterMs).toBe(sharedRetryAfterMs);
  });
});

describe("MinHash", () => {
  it("agrees with itself, bands a signature, and refuses a signature of another length", () => {
    const hash = (shingle: number, index: number): number => Math.imul(shingle ^ (index + 1), 0x9e3779b1) >>> 0;
    const signature = minhashSignature([1, 2, 3, 4], 8, hash);
    expect(signature).toHaveLength(8);
    expect(minhashSimilarity(signature, minhashSignature([4, 3, 2, 1], 8, hash), 8)).toBe(1);
    expect(minhashSimilarity(signature, signature.subarray(1), 8)).toBe(0);
    const bands = minhashBands(signature, 4);
    expect(bands).toHaveLength(4);
    expect(bands[0]).toBe(`0:${(signature[0] ?? 0).toString(36)}.${(signature[1] ?? 0).toString(36)}`);
    // A malformed signature has no bands, and compares with nothing.
    expect(minhashBands(signature.subarray(1), 4)).toEqual([]);
    expect(minhashBands([], 4)).toEqual([]);
    expect(minhashSimilarity(signature.subarray(1), signature.subarray(1), 8)).toBe(0);
  });
});

describe("a schema drawn with a given Zod", () => {
  it("refuses an unknown key when strict, and strips it when open", () => {
    const shape = (zod: typeof KIT_ZOD) => ({ name: zod.string() });
    expect(objectsOf(KIT_ZOD, "strict")(shape(KIT_ZOD)).safeParse({ name: "a", extra: 1 }).success).toBe(false);
    expect(objectsOf(z, "open")(shape(z)).parse({ name: "a", extra: 1 })).toEqual({ name: "a" });
  });
});
