import { describe, expect, it } from "vitest";

import { DisplayNameSchema, SchedulesPayloadSchema } from "../src/index.js";

/** A name given to a schedule or an agent: one line of text (Mac mini adversarial tests). */
describe("DisplayNameSchema", () => {
  it("takes words, punctuation and emoji, and refuses a tab, a line break or an escape sequence", () => {
    for (const name of ["desk-check", "Morning brief · weekdays", "Café ☀️ 👩‍💻"])
      expect(DisplayNameSchema.safeParse(name).success).toBe(true);
    for (const name of ["adv\ttab", "two\nlines", "red\u001b[31m", "sep arated", ""])
      expect(DisplayNameSchema.safeParse(name).success, JSON.stringify(name)).toBe(false);
    expect(DisplayNameSchema.safeParse("x\u001b[2J").error?.issues[0]?.message).toContain("no tab, line break or other control character");
  });

  it("holds a schedule's new name to it", () => {
    expect(SchedulesPayloadSchema.safeParse({ action: "add", name: "adv\ttab\u001b[31mred" }).success).toBe(false);
    expect(SchedulesPayloadSchema.safeParse({ action: "add", name: "desk-check" }).success).toBe(true);
  });
});
