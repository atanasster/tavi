import { describe, expect, it } from "vitest";

import { partialFake } from "../src/index.js";

interface Greeter {
  greet(name: string): string;
  wave(): void;
}

describe("partialFake", () => {
  it("answers with the members it was given and leaves the others absent", () => {
    const greeter = partialFake<Greeter>({ greet: (name) => `hello ${name}` });
    expect(greeter.greet("ada")).toBe("hello ada");
    expect("wave" in greeter).toBe(false);
  });
});
