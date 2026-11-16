import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deferAttendedFamilies, deferredFamilyLines, toolSearchDefinitionFor, toolSearchDescriptorFor } from "@tavi/agent-host/workflow";
import type { ToolDefinition } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schemaTokenCount } from "../../src/features/mcp/review.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * What the tool schemas of a default attended turn cost, held to a committed
 * ceiling. Every model call sends them, so a description or schema that grows
 * is a cost on every turn: this test fails when the total passes the ceiling.
 * Tokens are counted as `tavi doctor` counts them (`schemaTokenCount`, over
 * the name the model is sent), and v2 includes the `tools.search` its turn adds,
 * whose description lists the deferred families. A change that shrinks the list lowers the ceiling in the same
 * commit (`TAVI_UPDATE_TOOL_SCHEMA_BUDGET=1`); one that must grow it raises it
 * there, where review sees it.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const budgetPath = join(root, "evals", "tool-selection", "schema-budget.json");
const directories = temporaryDirectories();
let runtime: TaviRuntime;

interface SchemaBudget {
  /** Every offered tool sent in full (`models.promptLayout` `v1`). */
  readonly v1: { readonly tools: number; readonly tokens: number };
  /** The attended families deferred behind `tools.search` (`v2`). */
  readonly v2: { readonly tools: number; readonly tokens: number };
}

/** Headroom over the measured size before the ceiling trips: room for a one-line description fix. */
const HEADROOM = 1.02;

beforeAll(async () => {
  runtime = await composeTaviRuntime(fixtureRuntimeOptions(directories.create("tavi-tool-budget-"), { scheduleSweepEnabled: false }), {
    modelOverride: createFixtureModel({ turns: [] }),
  });
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  directories.cleanup();
});

describe("the tool schemas a default turn sends", () => {
  it("stay under the committed token ceiling, with every family sent and with the attended families deferred", async () => {
    const offered = await runtime.tools.listOffered({
      workspaceId: "default",
      principalId: "operator",
      operator: true,
      outsideConversation: true,
    });
    const sent = (tools: readonly ToolDefinition[]) => {
      const shown = tools.filter((tool) => tool.deferred !== true);
      const tokens = shown.reduce(
        (total, tool) =>
          total +
          schemaTokenCount({
            name: runtime.tools.modelNameOf(tool.id) ?? tool.id,
            description: tool.description,
            parameters: runtime.tools.inputJsonSchemaOf(tool.id),
          }),
        0,
      );
      // A turn that holds tools back offers tools.search, which lists what waits behind it.
      if (shown.length === tools.length) return { tools: shown.length, tokens };
      const search = toolSearchDescriptorFor(toolSearchDefinitionFor(deferredFamilyLines(tools)));
      return {
        tools: shown.length + 1,
        tokens: tokens + schemaTokenCount({ name: search.name, description: search.description, parameters: search.inputJsonSchema }),
      };
    };
    const measured: SchemaBudget = { v1: sent(offered), v2: sent(deferAttendedFamilies(offered)) };
    if (process.env["TAVI_UPDATE_TOOL_SCHEMA_BUDGET"] === "1") {
      const ceiling = (size: { readonly tools: number; readonly tokens: number }) => ({
        tools: size.tools,
        tokens: Math.ceil(size.tokens * HEADROOM),
      });
      writeFileSync(budgetPath, `${JSON.stringify({ v1: ceiling(measured.v1), v2: ceiling(measured.v2) }, null, 2)}\n`);
    }
    const budget = JSON.parse(readFileSync(budgetPath, "utf8")) as SchemaBudget;
    expect(measured.v1.tokens, `v1 sends ${measured.v1.tokens} tokens of tool schemas`).toBeLessThanOrEqual(budget.v1.tokens);
    expect(measured.v2.tokens, `v2 sends ${measured.v2.tokens} tokens of tool schemas`).toBeLessThanOrEqual(budget.v2.tokens);
    expect(measured.v2.tokens).toBeLessThan(measured.v1.tokens);
  });
});
