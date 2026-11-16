import { describe, expect, it } from "vitest";

import {
  MAX_EVENT_PAYLOAD_BYTES,
  PLAN_MAX_ITEMS,
  PLAN_MAX_ITEM_CHARS,
  PLAN_TOOL_ID,
  PlanUpdateInputSchema,
  boundEventPayload,
} from "../src/index.js";

/** The largest plan the schema admits still reaches the card whole, not as a truncated preview. */
describe(PLAN_TOOL_ID, () => {
  it("keeps the worst-case plan under the event payload cap", () => {
    // `\u0001` is the costliest character to encode: JSON writes it as six bytes.
    for (const char of ["\u0001", '"', "語", "😀".slice(0, 1)]) {
      const plan = PlanUpdateInputSchema.parse({
        items: Array.from({ length: PLAN_MAX_ITEMS }, () => ({ content: char.repeat(PLAN_MAX_ITEM_CHARS), status: "in_progress" })),
      });
      expect(new TextEncoder().encode(JSON.stringify(plan)).byteLength).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
      expect(boundEventPayload(plan)).toEqual(plan);
    }
  });

  it("refuses a plan past the bounds", () => {
    expect(
      PlanUpdateInputSchema.safeParse({ items: Array.from({ length: PLAN_MAX_ITEMS + 1 }, () => ({ content: "x", status: "pending" })) })
        .success,
    ).toBe(false);
    expect(PlanUpdateInputSchema.safeParse({ items: [{ content: "x".repeat(PLAN_MAX_ITEM_CHARS + 1), status: "pending" }] }).success).toBe(
      false,
    );
  });
});
