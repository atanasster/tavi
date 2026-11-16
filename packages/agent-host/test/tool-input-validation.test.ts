import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ToolRegistryPort } from "@tavi/contracts";

import { validateToolInput } from "../src/workflow/dispatch.js";

/** A registry that knows one tool's schema. */
const registry = {
  inputSchemaOf: (name: string) => (name === "memory.propose" ? z.object({ title: z.string(), keywords: z.array(z.string()) }) : undefined),
} as unknown as ToolRegistryPort;

describe("a tool call's arguments", () => {
  it("are validated as the object the tool declares", () => {
    expect(validateToolInput(registry, "memory.propose", { title: "Tea", keywords: ["tea"] })).toEqual({
      ok: true,
      value: { title: "Tea", keywords: ["tea"] },
    });
    const wrong = validateToolInput(registry, "memory.propose", { title: "Tea", keywords: "tea" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.detail).toContain("keywords");
  });

  it("that are not JSON say so, with where they broke, never 'expected object, received string'", () => {
    // What a model sent: a list without its brackets or quotes, so the provider SDK handed over the raw text.
    const raw = '{"title": "Tea", "keywords": tea, genmaicha, drink}';
    const refused = validateToolInput(registry, "memory.propose", raw);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.detail).toMatch(/^the arguments are not one JSON object: .+; send them again as a single JSON object/);
    expect(refused.detail).not.toContain("expected object");
    expect(refused.issues).toEqual([refused.detail]);
  });

  it("that are a JSON string, not an object, are refused the same way, without a parser's reason", () => {
    const refused = validateToolInput(registry, "memory.propose", '"just text"');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.detail).toMatch(/^the arguments are not one JSON object; send them again/);
  });
});
