import { describe, expect, it } from "vitest";

import { capture, quietIo } from "../src/capture.js";

describe("capture", () => {
  it("records each stream, by either name", () => {
    const captured = capture();
    captured.io.stdout("one ");
    captured.io.stdout("two\n");
    captured.io.stderr("warning\n");
    expect(captured.stdout()).toBe("one two\n");
    expect(captured.out()).toBe("one two\n");
    expect(captured.stderr()).toBe("warning\n");
    expect(captured.err()).toBe("warning\n");
    expect(captured.io.isTty).toBe(false);
  });

  it("says it is a terminal when asked to", () => {
    expect(capture(true).io.isTty).toBe(true);
  });

  it("offers an io that drops everything", () => {
    expect(() => quietIo.stdout("x")).not.toThrow();
    expect(quietIo.isTty).toBe(false);
  });
});
