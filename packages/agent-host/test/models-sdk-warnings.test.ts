import { describe, expect, it } from "vitest";

describe("the model library's own warnings", () => {
  it("are off once the models module is loaded, so a terminal command prints none (QA 1836)", async () => {
    await import("../src/models/models.js");
    expect((globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS).toBe(false);
  });
});
