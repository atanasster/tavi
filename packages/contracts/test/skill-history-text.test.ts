import { describe, expect, it } from "vitest";

import { skillActivationHistoryText } from "../src/index.js";

describe("skillActivationHistoryText", () => {
  it("says what each activation-history entry did, in words", () => {
    expect(skillActivationHistoryText({ reason: "activate", newVersion: "1.0.0" })).toBe("Activated 1.0.0");
    expect(skillActivationHistoryText({ reason: "activate", previousVersion: "1.0.0", newVersion: "2.0.0" })).toBe(
      "Activated 2.0.0 (was 1.0.0)",
    );
    expect(skillActivationHistoryText({ reason: "rollback", previousVersion: "2.0.0", newVersion: "1.0.0" })).toBe(
      "Rolled back to 1.0.0 (was 2.0.0)",
    );
    expect(skillActivationHistoryText({ reason: "disable", previousVersion: "1.0.0" })).toBe("Disabled (was 1.0.0)");
  });
});
