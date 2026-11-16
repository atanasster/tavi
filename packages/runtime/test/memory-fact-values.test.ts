import { describe, expect, it } from "vitest";

import { factValuesDiffer } from "../src/memory/rules.js";

describe("factValuesDiffer", () => {
  it("does not read a paraphrase's sentence-initial word as a proper noun", () => {
    expect(
      factValuesDiffer(
        "Works at Acme as a senior engineer on the platform team",
        "Currently works at Acme as a senior engineer on the platform team",
      ),
    ).toBe(false);
    expect(factValuesDiffer("Does not drink coffee after noon", "Doesn't drink coffee after noon")).toBe(false);
  });

  it("does not count a case change of a name the other text holds", () => {
    expect(factValuesDiffer("Alice works at Acme on the platform team", "alice works at Acme on the platform team")).toBe(false);
    expect(factValuesDiffer("Uses VS Code for every project", "Uses vs code for every project")).toBe(false);
  });

  it("reads ambiguous date words as dates only beside a digit", () => {
    expect(factValuesDiffer("May prefer tea in the morning", "Prefers tea in the morning")).toBe(false);
    expect(factValuesDiffer("Sat the exam already", "Took the exam already")).toBe(false);
    expect(factValuesDiffer("Birthday is 3 May", "Birthday is 3 June")).toBe(true);
    expect(factValuesDiffer("Moved on May 4", "Moved on 4")).toBe(true);
  });

  it("reads small number words as their digits", () => {
    expect(factValuesDiffer("Has 2 cats at home", "Has two cats at home")).toBe(false);
    expect(factValuesDiffer("Has 2 cats at home", "Has three cats at home")).toBe(true);
  });

  it("keeps the value updates", () => {
    expect(factValuesDiffer("The dev server runs on port 8080", "The dev server runs on port 8443")).toBe(true);
    expect(factValuesDiffer("Lives in Lisbon", "Lives in Porto")).toBe(true);
    // Naming more on one side is detail, not a new value.
    expect(factValuesDiffer("The person lives in Lisbon.", "The person lives in Lisbon, Portugal.")).toBe(false);
    expect(factValuesDiffer("Drinks coffee every morning", "Does not drink coffee every morning")).toBe(true);
  });
});
