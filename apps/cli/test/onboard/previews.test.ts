import { describe, expect, it } from "vitest";

import { chatGptPreviewEnabled } from "../../src/features/onboard/previews.js";

describe("previews", () => {
  it("offers Sign in with ChatGPT only with TAVI_PREVIEW_CHATGPT=1", () => {
    expect(chatGptPreviewEnabled({})).toBe(false);
    expect(chatGptPreviewEnabled({ TAVI_PREVIEW_CHATGPT: "0" })).toBe(false);
    expect(chatGptPreviewEnabled({ TAVI_PREVIEW_CHATGPT: "true" })).toBe(false);
    expect(chatGptPreviewEnabled({ TAVI_PREVIEW_CHATGPT: "1" })).toBe(true);
  });
});
