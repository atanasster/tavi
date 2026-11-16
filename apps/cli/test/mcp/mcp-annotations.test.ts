import { describe, expect, it } from "vitest";

import { mcpAnnotations } from "../../src/features/mcp/bridge.js";

/** An MCP tool's hints on Tavi's annotations, held to the effect the operator approved. */
describe("MCP annotations", () => {
  it("is destructive for an unhinted write, as the spec defaults one, and read-only only as approved", () => {
    expect(mcpAnnotations(undefined, "external")).toEqual({ readOnly: false, destructive: true, idempotent: false, openWorld: true });
    expect(mcpAnnotations(undefined, "read-only")).toMatchObject({ readOnly: true, destructive: false });
    expect(mcpAnnotations({ destructiveHint: false, idempotentHint: true, openWorldHint: false }, "mutating")).toEqual({
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
  });

  it("reads a read-only claim the operator reclassified as a write as destructive", () => {
    expect(mcpAnnotations({ readOnlyHint: true }, "mutating")).toMatchObject({ readOnly: false, destructive: true });
  });
});
