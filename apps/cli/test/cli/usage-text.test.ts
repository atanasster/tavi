import { describe, expect, it } from "vitest";

import { planningReferences } from "../support/planning-reference.js";
import { usages } from "../support/usages.js";

describe("usage text", () => {
  it("covers every command's usage", () => {
    expect(usages.length).toBeGreaterThan(40);
  });

  it.each(usages)("%s cites no internal planning record", (_name, text) => {
    expect(planningReferences(text)).toEqual([]);
  });
});
