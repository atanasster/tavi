import { describe, expect, it } from "vitest";
import { z } from "zod";

import { TaviError } from "../src/errors.js";
import { parseOrThrow, zodIssues } from "../src/zod-util.js";

const Schema = z.object({ name: z.string().min(1), tags: z.array(z.string()) });

describe("zodIssues", () => {
  it("writes one path: message line per issue, labelling the root when asked", () => {
    const nested = Schema.safeParse({ name: "", tags: [1] });
    expect(nested.success).toBe(false);
    if (nested.success) return;
    expect(zodIssues(nested.error)).toEqual([expect.stringMatching(/^name: /), expect.stringMatching(/^tags\.0: /)]);

    const root = z.string().safeParse(3);
    if (root.success) throw new Error("unreachable");
    expect(zodIssues(root.error, "<root>")).toEqual([expect.stringMatching(/^<root>: /)]);
    expect(zodIssues(root.error)[0]).not.toMatch(/^:/);
  });
});

describe("parseOrThrow", () => {
  it("answers the parsed value", () => {
    expect(parseOrThrow(Schema, { name: "a", tags: [] }, "bad")).toEqual({ name: "a", tags: [] });
  });

  it("throws INVALID_INPUT with the message and every issue in details", () => {
    let caught: unknown;
    try {
      parseOrThrow(Schema, { name: "" }, "The thing is not valid", { details: { what: "thing" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaviError);
    expect(caught).toMatchObject({
      code: "INVALID_INPUT",
      message: "The thing is not valid",
      details: { what: "thing", issues: [expect.stringMatching(/^name: /), expect.stringMatching(/^tags: /)] },
    });
  });

  it("derives the message from the issues when given a function", () => {
    expect(() => parseOrThrow(Schema, {}, (issues) => `bad: ${issues.join("; ")}`)).toThrowError(/^bad: name: .*; tags: /);
  });
});
