import { describe, expect, it } from "vitest";

import { coreFont, pdfiumWasm } from "../src/host.js";

describe("the parser's assets", () => {
  it("reads PDFium's wasm once, as wasm", () => {
    const bytes = pdfiumWasm();
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(pdfiumWasm()).toBe(bytes);
  });

  it("reads the core font from the package's assets", () => {
    expect([...coreFont().subarray(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
  });
});
