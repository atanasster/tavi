import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema, SiteProfileSchema } from "@tavi/contracts";
import { domainSourceProblems } from "@tavi/domain-kit";
import { J1_SOURCES, J2_SOURCES } from "@tavi/jobs-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { register } from "../src/index.js";

const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "tavi-plugin.json"), "utf8")));

describe("the jobs.finder manifest", () => {
  it("is a valid manifest for a confined worker with a personal app", () => {
    expect(manifest).toMatchObject({
      id: "jobs.finder",
      isolation: "process",
      apps: { apps: [{ id: "jobs", category: "search", dataClass: "personal" }] },
    });
    expect(manifest.network?.domains.length).toBeLessThanOrEqual(64);
  });

  it("declares each tool with its effect and sink", () => {
    expect(manifest.tools.map((tool) => [tool.name, tool.effect, tool.sink, tool.untrustedOutput])).toEqual([
      ["search", "read-only", "search", undefined],
      ["get", "read-only", "search", undefined],
      ["match", "read-only", "none", undefined],
      ["pipeline", "read-only", "none", undefined],
      ["track", "mutating", "persist", undefined],
      // Untrusted too: its request log repeats the keywords a model wrote.
      ["sources", "read-only", "none", undefined],
      ["watch", "mutating", "persist", undefined],
      ["digest", "read-only", "none", undefined],
      ["ingest", "mutating", "persist", undefined],
      ["fill_plan", "read-only", "none", undefined],
      ["tailor_check", "read-only", "none", undefined],
    ]);
  });

  it("ships its board profiles, each a valid profile, and asks the person for every ingest, which the browser worker may call", () => {
    expect(manifest.tools.find((tool) => tool.name === "ingest")).toMatchObject({ attendedOnly: true, browserWorker: true });
    const profiles = (manifest.sites ?? []).map((path) =>
      SiteProfileSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", path), "utf8"))),
    );
    expect(profiles.map((profile) => profile.id).sort()).toEqual(
      readdirSync(join(import.meta.dirname, "..", "sites"))
        .map((file) => file.replace(/\.json$/, ""))
        .sort(),
    );
    // LinkedIn, Indeed, the BA and France Travail are never browsed by Tavi; nothing shipped is on by default.
    for (const id of ["linkedin-jobs", "indeed", "arbeitsagentur", "francetravail"])
      expect(profiles.find((profile) => profile.id === id)?.access).toMatchObject({ mode: "assist-only", navigate: false });
    // The ATS profiles stage: each stops before its final control, every day's count bounded.
    for (const profile of profiles.filter((each) => each.id.startsWith("ats-"))) expect(profile.access.mode, profile.id).toBe("stage");
    expect(profiles.find((profile) => profile.id === "ats-workday")?.stage?.finalStep).toMatchObject({
      labels: ["Submit", "Absenden", "Senden"],
      stepHeadings: ["Review"],
    });
    expect(profiles.find((profile) => profile.id === "ats-lever")?.stage?.finalStep.selectors).toEqual(["#btn-submit"]);
    // No board is read unattended until its site's terms are reviewed.
    expect(profiles.filter((profile) => profile.access.watchable)).toEqual([]);
  });

  it("asks the person for every watch, showing what it will sweep, and adds the heartbeat's Jobs source", () => {
    expect(manifest.tools.find((tool) => tool.name === "watch")).toMatchObject({
      minRisk: "medium",
      attendedOnly: true,
      card: { fields: ["/action", "/watchId", "/name", "/query", "/criteria", "/cadence", "/minScore", "/digest"] },
    });
    expect(manifest.provides).toEqual(["heartbeat-signals"]);
    expect(manifest.heartbeatSignals).toEqual({ abi: "tavi.heartbeat/1", sources: ["watches"] });
  });

  it("covers every source's hosts and credentials, with terms reviewed within 180 days (the release check)", () => {
    const credentials = Object.entries(manifest.config)
      .filter(([, field]) => field.type === "credential")
      .map(([key]) => key);
    expect(
      domainSourceProblems(
        [...J1_SOURCES, ...J2_SOURCES].map((source) => source.record),
        { networkDomains: manifest.network?.domains ?? [], credentials, rawSecrets: manifest.rawSecrets ?? [] },
        new Date().toISOString().slice(0, 10),
      ),
    ).toEqual([]);
    // Every credential setting is optional: the keyless sources work without any.
    expect(Object.values(manifest.config).every((field) => field.required !== true)).toBe(true);
  });

  it("has no adapter or host for a source its terms or status exclude", () => {
    const ids = [...J1_SOURCES, ...J2_SOURCES].map((source) => source.record.id);
    for (const excluded of ["arbeitsagentur", "ba", "mycareersfuture", "mcf", "francetravail", "indeed", "linkedin", "jsearch"])
      expect(ids).not.toContain(excluded);
    const hosts = [...(manifest.network?.domains ?? []), ...[...J1_SOURCES, ...J2_SOURCES].flatMap((source) => source.record.hosts)];
    for (const host of hosts)
      expect(host, host).not.toMatch(
        /arbeitsagentur\.de|mycareersfuture\.gov\.sg|francetravail\.(io|fr)|pole-emploi|indeed\.com|linkedin\.com|rapidapi\.com/,
      );
    // Workday is read through its sitemaps and job pages, never its cxs search API.
    expect(
      JSON.stringify(
        [...J1_SOURCES, ...J2_SOURCES].map((source) =>
          source.search(
            { keywords: ["x"], countries: ["US"], postedWithinDays: 14 },
            { credential: () => "k", userAgent: "t", now: "2026-10-16T00:00:00Z", contact: "a@b.c" },
            "acme",
          ),
        ),
      ),
    ).not.toContain("/wday/cxs/");
  });

  it("registers exactly the tools it declares", () => {
    const names: string[] = [];
    register({ z, config: {}, secret: async () => null, registerTool: (tool: { name: string }) => void names.push(tool.name) } as never);
    expect(names).toEqual(manifest.tools.map((tool) => tool.name));
  });

  it("takes one watch object per action, refusing what that action does not take", () => {
    const schemas = new Map<string, { safeParse: (input: unknown) => { success: boolean; data?: unknown } }>();
    register({
      z,
      config: {},
      secret: async () => null,
      registerTool: (tool: { name: string; inputSchema: never }) => void schemas.set(tool.name, tool.inputSchema),
      provideSignals: () => undefined,
    } as never);
    const watch = schemas.get("watch");
    expect(watch?.safeParse({ action: "update", watchId: "w1", minScore: 0.5 }).success).toBe(true);
    expect(watch?.safeParse({ action: "create", watchId: "w1" }).success).toBe(false);
    expect(watch?.safeParse({ action: "pause", watchId: "w1", minScore: 0.5, name: "old" }).success).toBe(false);
    // The worker reports one form per action, which the owner sends a model as one object.
    const schema = z.toJSONSchema(watch as never, { io: "input", target: "draft-7", unrepresentable: "any" }) as { oneOf?: unknown[] };
    expect(schema.oneOf).toHaveLength(5);
  });

  it("refuses to open its store outside a confined worker", async () => {
    const tools = new Map<string, (input: unknown, options: { signal: AbortSignal }, context?: unknown) => Promise<unknown>>();
    register({
      z,
      config: {},
      secret: async () => null,
      registerTool: (tool: { name: string; handler: never }) => void tools.set(tool.name, tool.handler),
    } as never);
    await expect(Promise.resolve().then(() => tools.get("sources")?.({}, { signal: new AbortController().signal }))).rejects.toThrow(
      /only as a confined worker/,
    );
  });
});
