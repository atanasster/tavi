import { describe, expect, it } from "vitest";

import { composerName } from "../../../src/features/chat/Composer.js";

describe("composerName", () => {
  it("names the message box as its placeholder says, without the ellipsis, and never prompt", () => {
    expect(composerName("Message Home…")).toBe("Message Home");
    expect(composerName("Start a side chat...")).toBe("Start a side chat");
    expect(composerName(undefined)).toBe("Message");
    expect(composerName("")).toBe("Message");
  });
});
