import { describe, expect, it } from "vitest";

import { reduceModelName } from "../../src/lib/model-name.js";

describe("a model's short name", () => {
  it("keeps what follows a vendor label or the last slash", () => {
    expect(reduceModelName("OpenAI: GPT-4.1 Mini")).toBe("GPT-4.1 Mini");
    expect(reduceModelName("openrouter/gpt-5")).toBe("gpt-5");
    expect(reduceModelName("openrouter/google/gemini-3.8-flash")).toBe("gemini-3.8-flash");
  });

  it("leaves a bare name, a trailing slash and nothing as they are", () => {
    expect(reduceModelName("ollama")).toBe("ollama");
    expect(reduceModelName("openrouter/")).toBe("openrouter/");
    expect(reduceModelName("  ")).toBe("");
  });
});
