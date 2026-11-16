import { z } from "zod";

import { TaviError, type ArtifactRepositoryPort, type ClockPort, type DeclaredToolDefinition } from "@tavi/contracts";
import type { ToolRegistry } from "@tavi/runtime";

/**
 * The fixture tool: one read-only tool.
 *
 * It exists to prove the model → tool → model round trip and direct Zod schema
 * compatibility. It reads nothing outside the process and performs no external
 * effect, so the spike cannot touch real data.
 */

const FIXTURE_TOOL_ID = "fixture.echo";

const EchoInputSchema = z
  .object({
    message: z.string().min(1).max(2000).describe("Text to echo back"),
    uppercase: z.boolean().optional().describe("Return the message upper-cased"),
  })
  .describe("Echo a bounded message back to the model");

const echoToolDefinition: DeclaredToolDefinition = {
  id: FIXTURE_TOOL_ID,
  sink: "none",
  version: "1.0.0",
  description: "Echo a bounded message back to the caller. Read-only fixture tool.",
  effect: "read-only",
  requiredPermissions: ["tools.invoke"],
};

/** Deterministic, side-effect-free read-only tool used by the stack spike. */
export function registerFixtureEchoTool(registry: ToolRegistry, clock: ClockPort): void {
  registry.register({
    ...echoToolDefinition,
    inputSchema: EchoInputSchema,
    handler: async ({ input, signal }) => {
      const parsed = EchoInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "fixture.echo received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      if (signal.aborted) throw new TaviError("CANCELLED", "fixture.echo was cancelled");
      const { message, uppercase } = parsed.data;
      return {
        echoed: uppercase === true ? message.toUpperCase() : message,
        length: message.length,
        observedAt: clock.now(),
        readOnly: true,
      };
    },
  });
}

/**
 * A second fixture tool, beside `fixture.echo` and only where it is: one that
 * makes an artifact a person must review, as `browser.capture` does, so a
 * suite can drive the artifact review flow through the CLI without a browser.
 */
export function registerFixtureCaptureTool(registry: ToolRegistry, artifacts: () => Pick<ArtifactRepositoryPort, "putArtifact">): void {
  registry.register({
    id: "fixture.capture",
    sink: "none",
    version: "1.0.0",
    description: "Make a stand-in screenshot a person must review before anyone sees it. Fixture tool.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: z.object({}).describe("Take a stand-in screenshot"),
    handler: async ({ context, signal }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "fixture.capture was cancelled");
      const record = await artifacts().putArtifact({
        workspaceId: context.workspaceId,
        runId: context.runId,
        contentType: "image/png",
        body: new TextEncoder().encode("fixture-png"),
        reviewState: "pending",
      });
      return { artifactId: record.artifactId };
    },
  });
}
