import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PluginManifestSchema,
  evaluateGate,
  joinLabels,
  unattendedDenial,
  untrustedLabel,
  type ContentLabel,
  type GateEvaluationInput,
  type PluginVersionRecord,
} from "@tavi/contracts";
import { PluginHost, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { loadExternalPlugins } from "../../src/features/plugins/external.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/**
 * jobs.finder on the shared seam: its approved manifest's tools, as the registry and the gate
 * read them. The module is a stand-in that registers the declared tools; what
 * is tested is what the manifest makes of them.
 */
const manifest = PluginManifestSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "packages", "external", "jobs", "tavi-plugin.json"), "utf8")),
);
const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

async function loaded() {
  const directory = directories.create("tavi-jobs-seam-");
  const entryPath = join(directory, "index.mjs");
  writeFileSync(
    entryPath,
    `export function register({ registerTool, z }) { for (const name of ${JSON.stringify(manifest.tools.map((tool) => tool.name))}) registerTool({ name, inputSchema: z.object({}).passthrough(), handler: async () => ({ ok: name }) }); }\n`,
  );
  const record: PluginVersionRecord = {
    pluginId: manifest.id,
    version: manifest.version,
    contentHash: "a".repeat(64),
    manifest,
    reviewState: "approved",
    installedBy: "test",
    installedAt: "2026-10-16T00:00:00.000Z",
    reviewedAt: "2026-10-16T00:00:00.000Z",
  };
  const tools = new ToolRegistry();
  const household = {
    personal: async (_pluginId: string, declared: "public" | "personal" | undefined) => declared === "personal",
    operatorOf: () => "operator",
  };
  const load = await loadExternalPlugins(
    [{ ok: true, record, directory, entryPath, config: {}, instances: [] }],
    tools,
    silentLog,
    async () => null,
    { bind: () => async () => {} },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    household,
  );
  const host = new PluginHost([foundationPlugin(), ...load.definitions], { buildId: "jobs-seam" });
  await host.start();
  return { tools, host };
}

/** The gate's verdict on a jobs.finder tool, allowed by a rule, in a turn with `label`. */
function verdict(tools: ToolRegistry, name: string, label: ContentLabel | undefined) {
  const tool = tools.get(`jobs.finder.${name}`);
  if (tool === undefined) throw new Error(`no jobs.finder.${name}`);
  const input: GateEvaluationInput = {
    toolId: tool.id,
    effect: tool.effect,
    rules: [{ id: "allow", toolPattern: tool.id, decision: "allow", createdAt: "2026-10-16T00:00:00.000Z" } as never],
    sessionGrants: [],
    gatedEffects: new Set(["mutating", "external"]),
    tainted: label?.integrity === "untrusted",
    ...(label === undefined ? {} : { label }),
    sink: tool.sink,
    urlOnly: tool.urlOnly,
  };
  return evaluateGate(input);
}

/** What a turn holds after a tool's result: its source, untrusted, at its confidentiality (as the workflow labels it). */
const after = (source: Parameters<typeof untrustedLabel>[0], confidentiality: "public" | "personal") =>
  untrustedLabel(source, { confidentiality });

describe("jobs.finder on the seam", () => {
  it("registers its tools with the manifest's sinks and its results as personal, untrusted data", async () => {
    const { tools, host } = await loaded();
    try {
      expect(
        ["search", "get", "match", "pipeline", "track", "sources", "watch", "digest", "ingest", "fill_plan", "tailor_check"].map((name) => [
          name,
          tools.get(`jobs.finder.${name}`)?.sink,
        ]),
      ).toEqual([
        ["search", "search"],
        ["get", "search"],
        ["match", "none"],
        ["pipeline", "none"],
        ["track", "persist"],
        ["sources", "none"],
        ["watch", "persist"],
        ["digest", "none"],
        ["ingest", "persist"],
        ["fill_plan", "none"],
        ["tailor_check", "none"],
      ]);
      expect(tools.get("jobs.finder.search")).toMatchObject({ outputConfidentiality: "personal", untrustedOutput: true });
      expect(tools.get("jobs.finder.sources")?.untrustedOutput).toBe(true);
    } finally {
      await host.stop();
    }
  });

  it("search runs without asking in a fresh turn and after public taint, and asks once after personal data in a tainted turn", async () => {
    const { tools, host } = await loaded();
    try {
      expect(verdict(tools, "search", undefined).gateReason).toBeUndefined();
      expect(verdict(tools, "search", after("web", "public")).gateReason).toBeUndefined();
      // A jobs.finder result, or memory.get of jobs.profile.*, puts personal data in the tainted turn.
      const personal = joinLabels(after("web", "public"), after("plugin", "personal"));
      const asked = verdict(tools, "search", personal);
      expect(asked).toMatchObject({ decision: "ask", gateReason: "private-search", allowedScopes: ["once"] });
      // A schedule nobody attends refuses it.
      expect(unattendedDenial({ ...(asked.gateReason === undefined ? {} : { gateReason: asked.gateReason }), risk: asked.risk })).toMatch(
        /private-search/,
      );
      expect(verdict(tools, "get", personal).gateReason).toBe("private-search");
    } finally {
      await host.stop();
    }
  });

  it("match, pipeline and sources never ask under taint, even with personal data; track asks as a tainted write", async () => {
    const { tools, host } = await loaded();
    try {
      const personal = after("plugin", "personal");
      for (const name of ["match", "pipeline", "sources"]) expect(verdict(tools, name, personal).gateReason).toBeUndefined();
      expect(verdict(tools, "track", personal)).toMatchObject({ decision: "ask", gateReason: "tainted-persist" });
    } finally {
      await host.stop();
    }
  });

  it("watch asks a person every call, even under an allow rule, with its card showing what it will sweep; a run nobody attends refuses it", async () => {
    const { tools, host } = await loaded();
    try {
      const watch = tools.get("jobs.finder.watch");
      const input = {
        action: "create",
        name: "Backend, US",
        query: { keywords: ["backend"], countries: ["US"] },
        criteria: { titles: ["Backend Engineer"] },
        cadence: 6,
      };
      const assessment = watch?.assess?.(input, {
        workspaceId: "default",
        principalId: "operator",
        runId: "task-1",
        caller: "test",
      } as never);
      expect(assessment).toMatchObject({
        attendedOnly: true,
        risk: "medium",
        display: {
          detail:
            'action: create\nname: Backend, US\nquery/keywords: ["backend"]\nquery/countries: ["US"]\ncriteria/titles: ["Backend Engineer"]\ncadence: 6',
        },
      });
      if (watch === undefined || assessment === undefined) throw new Error("no watch assessor");
      const ruled = evaluateGate({
        toolId: watch.id,
        effect: watch.effect,
        rules: [{ id: "allow", toolPattern: watch.id, decision: "allow", createdAt: "2026-10-16T00:00:00.000Z" } as never],
        sessionGrants: [],
        gatedEffects: new Set(["mutating", "external"]),
        tainted: false,
        sink: watch.sink,
        assessment,
      });
      expect(ruled.decision).toBe("ask");
      expect(
        unattendedDenial({
          ...(ruled.gateReason === undefined ? {} : { gateReason: ruled.gateReason }),
          risk: ruled.risk,
          attendedOnly: true,
        }),
      ).toMatch(/a person reviews this call themselves/);
    } finally {
      await host.stop();
    }
  });

  it("ingest asks as a tainted write, a person decides every call, and a run nobody attends refuses it", async () => {
    const { tools, host } = await loaded();
    try {
      const ingest = tools.get("jobs.finder.ingest");
      const assessment = ingest?.assess?.({ items: [{ kind: "email", from: "jobalerts-noreply@linkedin.com", body: "…" }] }, {
        workspaceId: "default",
        principalId: "operator",
        runId: "task-1",
        caller: "test",
      } as never);
      // A mutating plugin tool's floor is medium: the manifest's minRisk only raises it.
      expect(assessment).toMatchObject({ attendedOnly: true, risk: "medium", display: { detail: expect.stringMatching(/^items: /) } });
      if (ingest === undefined || assessment === undefined) throw new Error("no ingest assessor");
      const ruled = evaluateGate({
        toolId: ingest.id,
        effect: ingest.effect,
        rules: [{ id: "allow", toolPattern: ingest.id, decision: "allow", createdAt: "2026-10-16T00:00:00.000Z" } as never],
        sessionGrants: [],
        gatedEffects: new Set(["mutating", "external"]),
        tainted: true,
        label: after("email", "personal"),
        sink: ingest.sink,
        assessment,
      });
      expect(ruled).toMatchObject({ decision: "ask", gateReason: "tainted-persist" });
      // Refused unattended: for the untrusted mail it read, and for its person-only decision.
      expect(
        unattendedDenial({
          ...(ruled.gateReason === undefined ? {} : { gateReason: ruled.gateReason }),
          risk: ruled.risk,
          attendedOnly: true,
        }),
      ).toMatch(/untrusted/);
      expect(unattendedDenial({ risk: ruled.risk, attendedOnly: true })).toMatch(/a person reviews this call themselves/);
    } finally {
      await host.stop();
    }
  });

  it("a digest schedule auto-approving digest, match and pipeline runs unattended, under personal taint", async () => {
    const { tools, host } = await loaded();
    try {
      const personal = after("plugin", "personal");
      for (const name of ["digest", "match", "pipeline", "fill_plan", "tailor_check"]) {
        const ruled = verdict(tools, name, personal);
        expect(ruled.decision, name).toBe("allow");
        expect(
          unattendedDenial({ ...(ruled.gateReason === undefined ? {} : { gateReason: ruled.gateReason }), risk: ruled.risk }),
          name,
        ).toBeUndefined();
      }
    } finally {
      await host.stop();
    }
  });

  it("is offered to its operator only, outside a chat whose memory is the chat's own (household rule)", async () => {
    const { tools, host } = await loaded();
    try {
      const offered = async (context: Record<string, unknown>) =>
        (await tools.listOffered({ workspaceId: "default", principalId: "operator", ...context } as never)).some(
          (tool) => tool.id === "jobs.finder.search",
        );
      expect(await offered({ operator: true })).toBe(true);
      expect(await offered({ operator: false })).toBe(false);
      expect(await offered({ operator: true, memoryReach: "chat-only" })).toBe(false);
    } finally {
      await host.stop();
    }
  });
});
