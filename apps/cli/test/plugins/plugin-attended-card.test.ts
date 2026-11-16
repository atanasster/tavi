import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PluginManifestSchema,
  cardRows,
  clipText,
  describePluginTool,
  evaluateGate,
  inputAtPointer,
  pluginToolViews,
  unattendedDenial,
  type PluginVersionRecord,
} from "@tavi/contracts";
import { PluginHost, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { loadExternalPlugins } from "../../src/features/plugins/external.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/** A plugin tool a person decides every call of, and its card's input rows. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const manifestOf = (tools: readonly Record<string, unknown>[]) => ({
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "bundled-esm", packages: [] },
  id: "acme.jobs",
  version: "1.0.0",
  name: "Jobs fixture",
  entry: "index.mjs",
  tools,
  config: {},
});
const WATCH = {
  name: "watch",
  effect: "mutating",
  description: "Watch",
  sink: "persist",
  attendedOnly: true,
  card: { fields: ["/name", "/query/keywords", "/cadence", "/missing"] },
};

async function loaded() {
  const directory = directories.create("tavi-plugin-attended-");
  const entryPath = join(directory, "index.mjs");
  writeFileSync(
    entryPath,
    "export function register({ registerTool, z }) { for (const name of ['watch', 'plain']) registerTool({ name, inputSchema: z.object({}).passthrough(), handler: async () => name }); }\n",
  );
  const manifest = PluginManifestSchema.parse(
    manifestOf([WATCH, { name: "plain", effect: "mutating", description: "Plain", sink: "persist" }]),
  );
  const record: PluginVersionRecord = {
    pluginId: "acme.jobs",
    version: "1.0.0",
    contentHash: "a".repeat(64),
    manifest,
    reviewState: "approved",
    installedBy: "test",
    installedAt: "2026-10-16T00:00:00.000Z",
  };
  const tools = new ToolRegistry();
  const load = await loadExternalPlugins(
    [{ ok: true, record, directory, entryPath, config: {}, instances: [] }],
    tools,
    silentLog,
    async () => null,
    { bind: () => async () => {} },
  );
  const host = new PluginHost([foundationPlugin(), ...load.definitions], { buildId: "attended-test" });
  await host.start();
  return { tools, host, manifest };
}

const CONTEXT = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" } as never;

describe("a manifest's attendedOnly and card", () => {
  it("takes attendedOnly only as true, and card fields only as JSON pointers, at most 8", () => {
    expect(PluginManifestSchema.safeParse(manifestOf([{ ...WATCH, attendedOnly: false }])).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestOf([{ ...WATCH, card: { fields: ["query"] } }])).success).toBe(false);
    expect(
      PluginManifestSchema.safeParse(
        manifestOf([{ ...WATCH, card: { fields: Array.from({ length: 9 }, (_, index) => `/f${String(index)}`) } }]),
      ).success,
    ).toBe(false);
  });

  it("shows both at review", () => {
    const manifest = PluginManifestSchema.parse(manifestOf([WATCH]));
    const [view] = pluginToolViews({ pluginId: "acme.jobs", manifest });
    expect(view).toMatchObject({ attendedOnly: true, cardFields: WATCH.card.fields });
    expect(describePluginTool(view as never)).toBe(
      "acme.jobs.watch (mutating, sends to persist, a person decides every call, its card shows /name /query/keywords /cadence /missing)",
    );
  });

  it("reads a JSON pointer into an input, and nothing where the input has none", () => {
    const input = { query: { keywords: ["go", "rust"] }, list: ["a"], "a/b": 1 };
    expect(inputAtPointer(input, "/query/keywords")).toEqual(["go", "rust"]);
    expect(inputAtPointer(input, "/list/0")).toBe("a");
    expect(inputAtPointer(input, "/a~1b")).toBe(1);
    expect(inputAtPointer(input, "/query/nope")).toBeUndefined();
    expect(inputAtPointer(input, "/toString")).toBeUndefined();
  });

  it("puts the card's input values on the call's card, and has a person decide every call", async () => {
    const { tools, host } = await loaded();
    try {
      const watch = tools.get("acme.jobs.watch");
      const assessment = watch?.assess?.({ name: "Backend, US", query: { keywords: ["backend", "go"] }, cadence: "hourly" }, CONTEXT);
      expect(assessment).toMatchObject({
        display: {
          title: "Run acme.jobs.watch",
          // A field the call does not give has no row.
          detail: 'name: Backend, US\nquery/keywords: ["backend","go"]\ncadence: hourly',
        },
        attendedOnly: true,
        risk: "medium",
        subjects: [],
      });
      // A long value is cut to its row's share of the card: three given rows of (2,000 - 2) / 3.
      const long = { name: "x".repeat(1_000), query: { keywords: ["go"] }, cadence: "hourly" };
      expect(watch?.assess?.(long, CONTEXT)?.display.detail?.split("\n")[0]?.length).toBe(666);
      // A value with a line break is one row, quoted: it cannot draw a row of its own.
      const forged = watch?.assess?.({ name: "Backend\ncadence: never" }, CONTEXT)?.display.detail?.split("\n");
      expect(forged).toEqual(['name: "Backend\\ncadence: never"']);
      // A tool with neither keeps the loader's default: no assessor of its own.
      expect(tools.get("acme.jobs.plain")?.assess).toBeUndefined();
    } finally {
      await host.stop();
    }
  });

  it("shows an object one row per top-level field, so a long one never hides another", () => {
    const criteria = {
      skills: Array.from({ length: 40 }, (_, index) => ({ label: `forecasting skill ${String(index)}`, years: 5 })),
      salaryFloor: { amount: 90_000, currency: "USD" },
      seniority: ["mid"],
      "employmentTypes\nminScore": ["FULL_TIME"],
    };
    const rows = cardRows({ action: "create", criteria }, ["/action", "/watchId", "/criteria"], clipText);
    expect(rows.map((row) => row.split(": ")[0])).toEqual([
      "action",
      "criteria/skills",
      "criteria/salaryFloor",
      "criteria/seniority",
      // A model-written key with a line break is quoted: it cannot draw a row of its own.
      'criteria/"employmentTypes\\nminScore"',
    ]);
    expect(rows).toContain('criteria/salaryFloor: {"amount":90000,"currency":"USD"}');
    expect(rows.join("\n").length).toBeLessThanOrEqual(2_000);
  });

  it("shows every one of 8 rows after the gate, however long the first values", () => {
    const fields = Array.from({ length: 8 }, (_, index) => `/${"f".repeat(60)}${String(index)}`);
    const input = Object.fromEntries(fields.map((field) => [field.slice(1), "v".repeat(5_000)]));
    const verdict = evaluateGate({
      toolId: "acme.jobs.watch",
      effect: "mutating",
      rules: [],
      sessionGrants: [],
      gatedEffects: new Set(["mutating", "external"]),
      tainted: false,
      assessment: {
        display: { title: "Run acme.jobs.watch", detail: cardRows(input, fields, clipText).join("\n") },
        subjects: [],
        risk: "medium",
        reasons: [],
      },
    });
    expect(verdict.display.detail?.split("\n").map((row) => row.slice(0, 62))).toEqual(
      fields.map((field) => `${field.slice(1)}:`.slice(0, 62)),
    );
  });

  it("asks a person even under an allow rule, and is refused in a run nobody attends", async () => {
    const { tools, host } = await loaded();
    try {
      const watch = tools.get("acme.jobs.watch");
      const assessment = watch?.assess?.({ name: "n" }, CONTEXT);
      if (watch?.sink === undefined || assessment === undefined) throw new Error("the watch tool has no sink or assessor");
      const verdict = evaluateGate({
        toolId: "acme.jobs.watch",
        effect: "mutating",
        rules: [{ id: "allow", toolPattern: "acme.jobs.watch", decision: "allow", createdAt: "2026-10-16T00:00:00.000Z" } as never],
        sessionGrants: [],
        gatedEffects: new Set(["mutating", "external"]),
        tainted: false,
        sink: watch.sink,
        assessment,
      });
      expect(verdict.decision).toBe("ask");
      expect(unattendedDenial({ attendedOnly: true })).toMatch(/a person reviews this call themselves/);
    } finally {
      await host.stop();
    }
  });
});
