import { describe, expect, it } from "vitest";

import { BROWSER_READ_MAX_CHARS, MAX_TOOL_RESULT_BYTES, pageTextPiece } from "../src/index.js";

const page = { sessionId: "s", url: "https://example.com/a", title: "A" };

describe("a page's text, in pieces (browser.read)", () => {
  it("answers a short page whole, with no next piece", () => {
    expect(pageTextPiece(page, "Hello")).toEqual({ ...page, text: "Hello", offset: 0, totalLength: 5 });
  });

  it("reads a long page piece by piece, each continuing where the last stopped", () => {
    const text = "x".repeat(BROWSER_READ_MAX_CHARS * 2 + 10);
    const first = pageTextPiece(page, text);
    expect(first).toMatchObject({ offset: 0, nextOffset: BROWSER_READ_MAX_CHARS, totalLength: text.length });
    expect(first.text).toHaveLength(BROWSER_READ_MAX_CHARS);
    const second = pageTextPiece(page, text, first.nextOffset);
    const third = pageTextPiece(page, text, second.nextOffset);
    expect(third).toMatchObject({ offset: BROWSER_READ_MAX_CHARS * 2, text: "x".repeat(10) });
    expect(third.nextOffset).toBeUndefined();
    expect(first.text + second.text + third.text).toBe(text);
  });

  it("never splits a surrogate pair across two pieces", () => {
    const text = `${"a".repeat(BROWSER_READ_MAX_CHARS - 1)}😀tail`;
    const first = pageTextPiece(page, text);
    expect(first.text).toBe("a".repeat(BROWSER_READ_MAX_CHARS - 1));
    expect(pageTextPiece(page, text, first.nextOffset).text).toBe("😀tail");
  });

  it("answers an empty piece past the end, as a page that shrank since the last read", () => {
    expect(pageTextPiece(page, "short", 10_000)).toEqual({ ...page, text: "", offset: 5, totalLength: 5 });
  });

  it("fits a piece of three-byte text inside the inline tool-result bound, so a read is never archived for review", () => {
    const piece = pageTextPiece(page, "界".repeat(BROWSER_READ_MAX_CHARS * 2));
    expect(new TextEncoder().encode(JSON.stringify(piece)).byteLength).toBeLessThan(MAX_TOOL_RESULT_BYTES);
  });
});
