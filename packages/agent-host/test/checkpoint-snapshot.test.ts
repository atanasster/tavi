import { expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { captureCheckpoint, captureCheckpointWithFootprint } from "../src/workflow/checkpoint-snapshot.js";

it.each([
  new URL("https://example.com/path?q=hello"),
  new URLSearchParams("a=b"),
  Object(42),
  Object("hello"),
  Object(true),
  /abc/gi,
  new Map([["key", new Set([1, 2])]]),
  new Date("2026-09-28T00:00:00Z"),
])("preserves pinned serialization for native value %s", async (value) => {
  const serde = new MemorySaver().serde;
  const original = { value };
  const expected = await serde.dumpsTyped(original);
  expect(await serde.dumpsTyped(captureCheckpoint(original))).toEqual(expected);
});

it("copies aliased bytes once and captures native state before caller mutation", () => {
  const bytes = new Uint8Array(1024 * 1024);
  const url = new URL("https://example.com/accepted");
  const input = { values: Array.from({ length: 40 }, () => bytes), url };
  const snapshot = captureCheckpoint(input);
  bytes[0] = 42;
  url.pathname = "/mutated";
  expect(new Set(snapshot.values).size).toBe(1);
  expect(snapshot.values[0]?.[0]).toBe(0);
  expect(snapshot.url.href).toBe("https://example.com/accepted");
  expect(captureCheckpointWithFootprint(input).bytes).toBeLessThan(2 * 1024 * 1024);
});

it("counts retained bytes in the copying walk", () => {
  const shared = { b: "xy" };
  // Object 64, key "a" 34, nested object 64, key "b" 34, "xy" 36, key "c" 34, repeated reference 16, key "d" 34, 1 is 32.
  const { value, bytes } = captureCheckpointWithFootprint({ a: shared, c: shared, d: 1 });
  expect(bytes).toBe(64 + 34 + 64 + 34 + 36 + 34 + 16 + 34 + 32);
  expect(value.a).toBe(value.c);
  expect(value.a).not.toBe(shared);
});

it.each([
  [new Map([["k", 1]]), 64 + 34 + 32],
  [new Set(["ab"]), 64 + 36],
  [new Uint8Array(10), 64 + 10],
  [new ArrayBuffer(8), 64 + 8],
  [new Date(0), 64],
  [Object("abc"), 64 + 6],
])("counts retained bytes of %o", (input, expected) => {
  expect(captureCheckpointWithFootprint(input).bytes).toBe(expected);
});

it("stops the walk as soon as the byte budget is passed", () => {
  const input: Record<string, unknown> = { big: new Uint8Array(4096) };
  Object.defineProperty(input, "later", { enumerable: true, get: () => 1 });
  // The accessor after the oversized value is never reached: the budget refusal comes first.
  expect(() => captureCheckpointWithFootprint(input, 1024)).toThrow(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
  expect(() => captureCheckpointWithFootprint(input)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
});
