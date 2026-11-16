import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deferAttendedFamilies, discoverTools, documentTools, mentionsReminder, shortlistTools } from "@tavi/agent-host/workflow";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LEAD_IN_TOOLS, matchesTool } from "../../../../evals/tool-choice/eval.js";
import { runSelectionEval, type SelectionCasesFile, type SelectionReport } from "../../../../evals/tool-selection/selection.js";
import { registerWebSearchTool } from "../../src/features/search/web-search.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The offline tool-selection eval over the real registry: every case's
 * expected tools are registered, and the rankers' recall is no lower than the
 * committed baseline (`evals/tool-selection/README.md`).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const casesPath = join(root, "evals", "tool-selection", "cases.json");
const baselinePath = join(root, "evals", "tool-selection", "baseline.json");
const choiceCasesPath = join(root, "evals", "tool-choice", "cases.json");

/** Tools the live tool-choice cases expect that are planned, not yet built: a step that builds one takes it off. */
const PLANNED_TOOLS = new Set<string>([]);
/** Families a live case may expect that a fixture registry never holds: an account's mailbox, a connected server's. */
const CONNECTED_FAMILIES = new Set(["gmail", "mcp"]);
/** Tools registered only once something can be connected, which a fixture registry has not. */
const CONNECTED_TOOLS = new Set(["apps.request_connect"]);
const directories = temporaryDirectories();
let runtime: TaviRuntime;

beforeAll(async () => {
  runtime = await composeTaviRuntime(fixtureRuntimeOptions(directories.create("tavi-tool-selection-"), { scheduleSweepEnabled: false }), {
    modelOverride: createFixtureModel({ turns: [] }),
    // The video tools are offered once a decoder exists, as on a host with ffmpeg: the eval names them whether or not this one has it.
    videoDecoderOverride: { close: async () => undefined } as never,
  });
  // `web_search` is registered once a search provider exists; the eval reads its description, never calls it.
  const provider = { id: "fixture-search", available: () => true };
  await registerWebSearchTool(runtime.tools, () => [provider as never], { resolve: async () => ({ provider }) as never } as never);
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  directories.cleanup();
});

describe("the offline tool-selection eval", () => {
  it("names only registered tools, and ranks at least as well as the committed baseline", () => {
    const { cases } = JSON.parse(readFileSync(casesPath, "utf8")) as SelectionCasesFile;
    const tools = runtime.tools.list();
    const ids = new Set(tools.map((tool) => tool.id));
    expect(cases.flatMap((entry) => entry.expected.filter((id) => !ids.has(id)).map((id) => `${entry.id}: ${id}`))).toEqual([]);

    // The shortlist as an attended chat builds it, its families deferred. The tools every list holds stay in:
    // a case they serve is served, and taking them out would score a tool joining every list as a loss.
    const attended = deferAttendedFamilies(tools);
    const report = runSelectionEval(cases, {
      discover: (query) => discoverTools(query, tools, 8).map((tool) => tool.id),
      shortlist: (query) =>
        // A reminder turn's words bring its deferred reminder tools in, as the model node does (`documentTools`).
        shortlistTools(attended, query, [], documentTools(false, false, mentionsReminder([query]))).map((tool) => tool.id),
    });
    if (process.env["TAVI_UPDATE_TOOL_SELECTION_BASELINE"] === "1") writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as SelectionReport;
    expect(report.recallAt1).toBeGreaterThanOrEqual(baseline.recallAt1);
    expect(report.recallAt5).toBeGreaterThanOrEqual(baseline.recallAt5);
    expect(report.shortlistRecall).toBeGreaterThanOrEqual(baseline.shortlistRecall);
    // A case the baseline found in the top five is never lost, even when another gained hides it in the share.
    expect(report.missedAt5.filter((id) => !baseline.missedAt5.includes(id))).toEqual([]);
  });

  it("lets the tool-choice scorer pass only read-only look-ups before the expected call", () => {
    const { cases } = JSON.parse(readFileSync(choiceCasesPath, "utf8")) as {
      cases: readonly { id: string; leadIn?: readonly string[] }[];
    };
    const tools = runtime.tools.list();
    const ids = new Set(tools.map((tool) => tool.id));
    // Every registered tool a look-up pattern matches only reads: one that writes or sends would score as a look-up.
    const lookUps = [...LEAD_IN_TOOLS, ...cases.flatMap((entry) => entry.leadIn ?? [])];
    const writing = tools
      .filter((tool) => lookUps.some((pattern) => matchesTool(pattern, tool.id)) && tool.effect !== "read-only")
      .map((tool) => `${tool.id} (${tool.effect})`);
    expect(writing).toEqual([]);
    // A case's own look-up names a tool there is.
    const unknown = cases.flatMap((entry) =>
      (entry.leadIn ?? []).filter((id) => !id.includes("*") && !ids.has(id)).map((id) => `${entry.id}: ${id}`),
    );
    expect(unknown).toEqual([]);
  });

  it("names in the live tool-choice cases only tools that exist or are planned, and arguments their schemas take", () => {
    const { cases } = JSON.parse(readFileSync(choiceCasesPath, "utf8")) as {
      cases: readonly { id: string; expect: readonly string[]; args?: Readonly<Record<string, string>> }[];
    };
    const ids = new Set(runtime.tools.list().map((tool) => tool.id));
    const families = new Set([...ids].map((id) => id.slice(0, id.indexOf("."))));
    const problems: string[] = [];
    for (const entry of cases) {
      for (const pattern of entry.expect) {
        const family = pattern.slice(0, pattern.indexOf("."));
        const known = pattern.endsWith(".*")
          ? families.has(family) || CONNECTED_FAMILIES.has(family)
          : ids.has(pattern) || PLANNED_TOOLS.has(pattern) || CONNECTED_TOOLS.has(pattern);
        if (!known) problems.push(`${entry.id}: ${pattern}`);
      }
      for (const field of Object.keys(entry.args ?? {})) {
        const fields = entry.expect
          .filter((id) => ids.has(id))
          .map((id) => runtime.tools.inputJsonSchemaOf(id) as { properties?: Record<string, unknown> } | undefined);
        if (!fields.some((schema) => schema?.properties?.[field] !== undefined))
          problems.push(`${entry.id}: no expected tool takes ${field}`);
      }
    }
    expect(problems).toEqual([]);
    // A planned tool that now exists comes off the list.
    expect([...PLANNED_TOOLS].filter((id) => ids.has(id))).toEqual([]);
  });
});
