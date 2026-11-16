import { describe, expect, it } from "vitest";

import { modelFailure } from "../src/models/provider-stream.js";

describe("modelFailure", () => {
  it("marks a provider's context-window refusal as a context overflow", () => {
    expect(modelFailure({ code: "CONTEXT_WINDOW_EXCEEDED", message: "too big" }, false)).toMatchObject({
      code: "invalid_request",
      contextOverflow: true,
    });
    expect(modelFailure({ code: "INVALID_REQUEST", message: "prompt is too long: 9000 tokens" }, false)).toMatchObject({
      contextOverflow: true,
    });
    expect(modelFailure({ code: "INVALID_REQUEST", message: "bad tool schema" }, false).contextOverflow).toBeUndefined();
  });

  it("reads how many output tokens a key can afford", () => {
    expect(modelFailure({ code: "QUOTA", message: "You requested up to 16384 tokens, but can only afford 900." }, false)).toMatchObject({
      code: "quota_exceeded",
      affordableTokens: 900,
    });
  });
});
