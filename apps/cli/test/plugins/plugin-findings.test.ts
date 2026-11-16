import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema, type PluginVersionRecord } from "@tavi/contracts";
import { PluginHost, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { loadExternalPlugins, type ExternalPluginFindings } from "../../src/features/plugins/external.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/** A plugin tool's `taviFindings`: kept with the task, out of the model's view. */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const ENTRY = `export function register({ registerTool, z }) {
  registerTool({ name: "search", inputSchema: z.object({ findings: z.unknown().optional(), shape: z.string().optional() }), handler: async ({ findings, shape }) =>
    shape === "array" ? [1, 2] : shape === "text" ? "plain" : { postings: 2, ...(findings === undefined ? {} : { taviFindings: findings }) } });
}
`;

async function loaded(findings: ExternalPluginFindings | undefined) {
  const directory = directories.create("tavi-plugin-findings-");
  const entryPath = join(directory, "index.mjs");
  writeFileSync(entryPath, ENTRY);
  const manifest = PluginManifestSchema.parse({
    schemaVersion: 2,
    abi: "tavi.providers/1",
    provenance: { format: "bundled-esm", packages: [] },
    id: "acme.jobs",
    version: "1.0.0",
    name: "Jobs fixture",
    entry: "index.mjs",
    tools: [{ name: "search", effect: "read-only", description: "Search", sink: "search" }],
    config: {},
  });
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    findings,
  );
  const host = new PluginHost([foundationPlugin(), ...load.definitions], { buildId: "findings-test" });
  await host.start();
  const call = (input: Record<string, unknown>) =>
    tools.get("acme.jobs.search")?.handler({
      input,
      context: { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" },
      signal: new AbortController().signal,
    } as never);
  return { call, host };
}

function store() {
  const added: unknown[] = [];
  const findings: ExternalPluginFindings = {
    add: async (input) => {
      added.push(input);
      return [];
    },
    now: () => "2026-10-16T12:00:00.000Z",
  };
  return { findings, added };
}

describe("a plugin tool's taviFindings", () => {
  it("are kept with the calling task and left out of the result", async () => {
    const { findings, added } = store();
    const { call, host } = await loaded(findings);
    try {
      const taviFindings = [
        { kind: "job", records: [{ title: "Backend Engineer", company: "Acme" }], sourceUrl: "https://boards.greenhouse.io/acme/jobs/1" },
        { kind: "job", records: [{ title: "SRE", company: "Beta" }] },
      ];
      expect(await call({ findings: taviFindings })).toEqual({ postings: 2 });
      expect(added).toEqual([
        {
          taskId: "task-1",
          workspaceId: "default",
          kind: "job",
          records: [{ title: "Backend Engineer", company: "Acme" }],
          sourceUrl: "https://boards.greenhouse.io/acme/jobs/1",
          createdAt: "2026-10-16T12:00:00.000Z",
        },
        {
          taskId: "task-1",
          workspaceId: "default",
          kind: "job",
          records: [{ title: "SRE", company: "Beta" }],
          sourceUrl: undefined,
          createdAt: "2026-10-16T12:00:00.000Z",
        },
      ]);
    } finally {
      await host.stop();
    }
  });

  it("leave any other result as it was", async () => {
    const { findings, added } = store();
    const { call, host } = await loaded(findings);
    try {
      expect(await call({})).toEqual({ postings: 2 });
      expect(await call({ shape: "array" })).toEqual([1, 2]);
      expect(await call({ shape: "text" })).toBe("plain");
      expect(added).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  it.each([
    ["not a list", { kind: "job", records: [{}] }],
    ["a bad kind", [{ kind: "Job Posting", records: [{ a: 1 }] }]],
    ["no records", [{ kind: "job", records: [] }]],
    ["too many entries", Array.from({ length: 9 }, () => ({ kind: "job", records: [{ a: 1 }] }))],
    ["a record past its bound", [{ kind: "job", records: [{ text: "x".repeat(8_001) }] }]],
  ])("fail the call when %s, keeping nothing", async (_name, taviFindings) => {
    const { findings, added } = store();
    const { call, host } = await loaded(findings);
    try {
      await expect(call({ findings: taviFindings })).rejects.toMatchObject({ code: "TOOL_FAILED" });
      expect(added).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  it("are still left out of the result where no findings store is given", async () => {
    const { call, host } = await loaded(undefined);
    try {
      expect(await call({ findings: [{ kind: "job", records: [{ a: 1 }] }] })).toEqual({ postings: 2 });
    } finally {
      await host.stop();
    }
  });
});
