import { describe, expect, it } from "vitest";

import { outputCollector } from "../src/runtime.js";

/** A run's output kept to its bound: the head and the tail, with how much was left out between them. */
describe("outputCollector", () => {
  it("keeps all of an output within its bound", () => {
    const out = outputCollector(16);
    out.add(Buffer.from("hello "));
    out.add(Buffer.from("world"));
    expect(out.text()).toBe("hello world");
    expect(out.dropped()).toBe(0);
  });

  it("keeps the head and the tail of a long output, saying how much it left out", () => {
    const out = outputCollector(8);
    for (const chunk of ["AAAA", "xxxxxxxx", "xxxxxxxx", "ZZ", "ZZ"]) out.add(Buffer.from(chunk));
    expect(out.text()).toBe("AAAA\n…[16 bytes left out]…\nZZZZ");
    expect(out.dropped()).toBe(16);
  });

  it("keeps a character whole across the halves when nothing was left out", () => {
    const out = outputCollector(8);
    out.add(Buffer.from("abcéxyz"));
    expect(out.text()).toBe("abcéxyz");
    expect(out.dropped()).toBe(0);
  });

  it("cuts both edges at character boundaries, counting what that drops", () => {
    const out = outputCollector(8);
    // é is two bytes; the head ends inside the first, the tail starts inside the last.
    out.add(Buffer.from(`abcé${"x".repeat(20)}é123`));
    const text = out.text();
    expect(text).not.toContain("\uFFFD");
    expect(text.startsWith("abc\n")).toBe(true);
    expect(text.endsWith("\n123")).toBe(true);
  });

  it("keeps a single chunk that spans head and tail, and many small chunks, to the bound", () => {
    const one = outputCollector(6);
    one.add(Buffer.from("0123456789"));
    expect(one.text()).toBe("012\n…[4 bytes left out]…\n789");
    const many = outputCollector(7);
    for (let index = 0; index < 10_000; index += 1) many.add(Buffer.from("z"));
    expect(many.text()).toBe("zzzz\n…[9993 bytes left out]…\nzzz");
    expect(outputCollector(1).text()).toBe("");
  });
});
