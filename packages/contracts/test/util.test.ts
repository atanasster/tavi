import { describe, expect, expectTypeOf, it } from "vitest";

import {
  HeartbeatProviderError,
  IdeasProviderError,
  MemoryProviderError,
  RouterProviderError,
  heartbeatProviderFailure,
  ideasProviderFailure,
  memoryProviderFailure,
  nowTimestamp as barrelNowTimestamp,
  routerProviderFailure,
} from "../src/index.js";
import {
  clip,
  csvList,
  defineProviderError,
  definedOnly,
  errorMessage,
  isRecord,
  jsonObjectIn,
  retryAfterMs,
  nowTimestamp,
  plural,
} from "../src/util.js";
import * as viaExport from "@tavi/contracts/util";

describe("errorMessage", () => {
  it("reads an Error's message, a subclass's included, even when empty", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
    expect(errorMessage(new Error(""))).toBe("");
    expect(errorMessage(new Error(""), "fallback")).toBe("");
  });

  it("stringifies anything else without a fallback", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage({ message: "not an Error" })).toBe("[object Object]");
  });

  it("gives the fallback for anything but an Error", () => {
    expect(errorMessage("plain", "fallback")).toBe("fallback");
    expect(errorMessage({ message: "not an Error" }, "fallback")).toBe("fallback");
    expect(errorMessage(undefined, "")).toBe("");
  });
});

describe("isRecord", () => {
  it("accepts plain objects, null-prototype objects and class instances", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date(0))).toBe(true);
  });

  it("refuses null, arrays, functions and primitives", () => {
    for (const value of [null, undefined, [], [1], () => 1, "x", 0, true, Symbol("s"), 1n])
      expect(isRecord(value), String(typeof value)).toBe(false);
  });

  it("narrows to a string-keyed record", () => {
    const value: unknown = { a: 1 };
    if (isRecord(value)) expectTypeOf(value).toEqualTypeOf<Record<string, unknown>>();
  });
});

describe("jsonObjectIn", () => {
  it("reads the object past prose and a code fence", () => {
    expect(jsonObjectIn('Sure:\n```json\n{"a": {"b": 1}}\n```\nDone.')).toEqual({ a: { b: 1 } });
  });

  it("is undefined when there is no object or it does not parse", () => {
    expect(jsonObjectIn("no json here")).toBeUndefined();
    expect(jsonObjectIn("} backwards {")).toBeUndefined();
    expect(jsonObjectIn('{"cut": "off at the tok')).toBeUndefined();
    expect(jsonObjectIn("{not: json}")).toBeUndefined();
  });
});

describe("nowTimestamp", () => {
  it("is the current instant as ISO-8601 UTC with milliseconds", () => {
    const before = Date.now();
    const stamp = nowTimestamp();
    const after = Date.now();
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stamp)).toBeLessThanOrEqual(after);
  });

  it("is the one the barrel exports", () => {
    expect(barrelNowTimestamp).toBe(nowTimestamp);
  });
});

describe("csvList", () => {
  it("splits on commas, trims each item and drops the empty ones", () => {
    expect(csvList("a,b,c")).toEqual(["a", "b", "c"]);
    expect(csvList(" a , b ,c ")).toEqual(["a", "b", "c"]);
    expect(csvList("a,,b, ,")).toEqual(["a", "b"]);
    expect(csvList(",")).toEqual([]);
    expect(csvList("")).toEqual([]);
    expect(csvList("   ")).toEqual([]);
  });

  it("keeps inner white space, case and duplicates", () => {
    expect(csvList("New York, new york ,New York")).toEqual(["New York", "new york", "New York"]);
  });

  it("gives none for anything but a string", () => {
    for (const value of [undefined, null, 1, ["a,b"], { a: "b" }]) expect(csvList(value)).toEqual([]);
  });
});

describe("plural", () => {
  it("uses the singular for exactly one and the plural otherwise", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(2, "file")).toBe("2 files");
    expect(plural(-1, "file")).toBe("-1 files");
    expect(plural(1.5, "hour")).toBe("1.5 hours");
  });

  it("takes an irregular plural", () => {
    expect(plural(1, "thing to remember", "things to remember")).toBe("1 thing to remember");
    expect(plural(3, "thing to remember", "things to remember")).toBe("3 things to remember");
    expect(plural(2, "entry", "entries")).toBe("2 entries");
  });

  it("writes the count without grouping", () => {
    expect(plural(12345, "row")).toBe("12345 rows");
  });
});

describe("clip", () => {
  it("returns short text unchanged, the exact length included", () => {
    expect(clip("hello", 10)).toBe("hello");
    expect(clip("hello", 5)).toBe("hello");
    expect(clip("", 0)).toBe("");
  });

  it("cuts long text to max characters, the ellipsis included", () => {
    expect(clip("hello world", 5)).toBe("hell…");
    expect(clip("hello world", 5)).toHaveLength(5);
    expect(clip("hello", 1)).toBe("…");
  });

  it("gives the ellipsis alone for a max under one", () => {
    expect(clip("hello", 0)).toBe("…");
    expect(clip("hello", -3)).toBe("…");
  });

  it("never ends a code-unit cut on half of a surrogate pair", () => {
    // "ab😀cd": the emoji is code units 2 and 3; max 4 keeps 3 units, which would split it.
    expect(clip("ab😀cd", 4)).toBe("ab…");
    expect(clip("ab😀cd", 5)).toBe("ab😀…");
    expect(clip("😀😀😀", 2)).toBe("…");
  });

  it("counts code points when asked", () => {
    expect(clip("😀😀😀", 3, { codePoints: true })).toBe("😀😀😀");
    expect(clip("😀😀😀😀", 3, { codePoints: true })).toBe("😀😀…");
    expect(clip("ab😀cd", 4, { codePoints: true })).toBe("ab😀…");
    expect(clip("abc", 0, { codePoints: true })).toBe("…");
  });

  it("squeezes white space before measuring when asked", () => {
    expect(clip("  a \n\t b  ", 10, { squeeze: true })).toBe("a b");
    expect(clip("a    b    c    d", 5, { squeeze: true })).toBe("a b …");
    expect(clip("a    b", 10)).toBe("a    b");
    expect(clip(" 😀  😀 😀 ", 3, { squeeze: true, codePoints: true })).toBe("😀 …");
  });
});

describe("definedOnly", () => {
  it("drops undefined fields and keeps the rest in order", () => {
    const value = definedOnly({ a: 1, b: undefined, c: "x", d: undefined });
    expect(value).toEqual({ a: 1, c: "x" });
    expect(Object.keys(value)).toEqual(["a", "c"]);
    expect("b" in value).toBe(false);
  });

  it("keeps null, false, zero and the empty string", () => {
    expect(definedOnly({ a: null, b: false, c: 0, d: "" })).toEqual({ a: null, b: false, c: 0, d: "" });
  });

  it("gives a fresh object, empty when every field is undefined", () => {
    const source = { a: 1 };
    expect(definedOnly(source)).not.toBe(source);
    expect(definedOnly({ a: undefined })).toEqual({});
    expect(definedOnly({})).toEqual({});
  });

  it("types a field that may be undefined as optional and never undefined", () => {
    const maybe = (value: number | undefined) => definedOnly({ id: "x", count: value });
    expectTypeOf(maybe).returns.toEqualTypeOf<{ id: string; count?: number }>();
    const target: { readonly id: string; readonly count?: number; readonly note?: string } = {
      ...maybe(undefined),
      ...definedOnly({ note: undefined as string | undefined }),
    };
    expect(target).toEqual({ id: "x" });
  });
});

describe("defineProviderError", () => {
  it("builds an Error whose message is its reason", () => {
    const TestProviderError = defineProviderError<"transport" | "invalid">();
    const error = new TestProviderError("invalid");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TestProviderError);
    expect(error.reason).toBe("invalid");
    expect(error.message).toBe("invalid");
    expect(error.name).toBe("Error");
    expect(Object.keys(error)).toEqual(["reason"]);
  });

  it("makes a distinct class for each call", () => {
    const First = defineProviderError<"transport">();
    const Second = defineProviderError<"transport">();
    expect(new First("transport")).not.toBeInstanceOf(Second);
  });

  it("keeps the four provider errors' names, fields, messages and instanceof", () => {
    const classes = [
      [HeartbeatProviderError, new HeartbeatProviderError("budget"), "budget"],
      [IdeasProviderError, new IdeasProviderError("invalid"), "invalid"],
      [MemoryProviderError, new MemoryProviderError("transport"), "transport"],
      [RouterProviderError, new RouterProviderError("credentials"), "credentials"],
    ] as const;
    for (const [type, error, reason] of classes) {
      expect(type.name).toMatch(/ProviderError$/);
      expect(error).toBeInstanceOf(type);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(reason);
      expect(error.reason).toBe(reason);
      expect(error.name).toBe("Error");
      expect(error.stack).toContain(reason);
      for (const [other] of classes) if (other !== type) expect(error).not.toBeInstanceOf(other);
    }
    expect(Object.keys(new HeartbeatProviderError("budget"))).toEqual(["reason"]);
  });

  it("keeps the router's usage field after the reason", () => {
    const usage = { inputTokens: 3, outputTokens: 1 };
    const billed = new RouterProviderError("transport", usage);
    expect(billed.usage).toBe(usage);
    expect(Object.keys(billed)).toEqual(["reason", "usage"]);
    const unbilled = new RouterProviderError("invalid");
    expect(unbilled.usage).toBeUndefined();
    expect(Object.keys(unbilled)).toEqual(["reason", "usage"]);
  });

  it("is still classified by its reason", () => {
    expect(routerProviderFailure(new RouterProviderError("credentials"))).toBe("credentials");
    expect(heartbeatProviderFailure(new HeartbeatProviderError("budget"))).toBe("budget");
    expect(ideasProviderFailure(new IdeasProviderError("invalid"))).toBe("invalid");
    expect(memoryProviderFailure(new MemoryProviderError("budget"))).toBe("budget");
  });
});

it("resolves through the package's ./util subpath", () => {
  expect(viaExport.clip).toBe(clip);
  expect(viaExport.definedOnly).toBe(definedOnly);
});

describe("Retry-After", () => {
  const NOW = "2026-10-17T13:10:00.000Z";
  it("reads seconds or a date, a minute when it says nothing, held to its bounds", () => {
    expect(retryAfterMs("30", NOW)).toBe(30_000);
    expect(retryAfterMs("Sat, 17 Oct 2026 13:11:30 GMT", NOW)).toBe(90_000);
    expect(retryAfterMs(undefined, NOW)).toBe(60_000);
    expect(retryAfterMs("soon", NOW)).toBe(60_000);
    expect(retryAfterMs("0", NOW)).toBe(1_000);
    expect(retryAfterMs("999999", NOW)).toBe(24 * 3_600_000);
    expect(retryAfterMs("0", NOW, { minMs: 0, maxMs: Number.POSITIVE_INFINITY })).toBe(0);
    expect(retryAfterMs("2.5", NOW, { minMs: 0, maxMs: Number.POSITIVE_INFINITY })).toBe(2_500);
  });
});
