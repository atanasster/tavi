import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema } from "@tavi/contracts";
import { domainSourceProblems } from "@tavi/domain-kit";
import {
  bnetzaRecord,
  CIVIC_SOURCES,
  EV_SOURCES,
  FUEL_SOURCES,
  nominatimRecord,
  open311Adapter,
  orsRecord,
  overpassRecord,
  overtureRecord,
  photonRecord,
  tdlrRecord,
} from "@tavi/places-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { register } from "../src/index.js";
import { LICENSING } from "../src/licensing.js";
import { OPEN311_CITIES } from "../src/open311.js";

const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "tavi-plugin.json"), "utf8")));

describe("the places.open manifest", () => {
  it("is a confined worker with a Shared app (no data class)", () => {
    expect(manifest).toMatchObject({ id: "places.open", isolation: "process", apps: { apps: [{ id: "places", category: "search" }] } });
    expect(manifest.apps?.apps[0]?.dataClass).toBeUndefined();
    expect(manifest.network?.domains.length).toBeLessThanOrEqual(64);
  });

  it("declares each tool with its effect and sink: queries read-only with sink search, local work sink none", () => {
    expect(manifest.tools.map((tool) => [tool.name, tool.effect, tool.sink, tool.untrustedOutput, tool.browserWorker])).toEqual([
      ["search", "read-only", "search", undefined, undefined],
      ["details", "read-only", "search", undefined, undefined],
      ["reconcile", "read-only", "none", undefined, true],
      ["availability", "read-only", "none", undefined, true],
      ["booking_status", "read-only", "none", undefined, true],
      ["compare", "read-only", "none", undefined, undefined],
      ["route_stops", "read-only", "search", undefined, undefined],
      ["area_report", "read-only", "search", undefined, undefined],
      ["ev_chargers", "read-only", "search", undefined, undefined],
      ["fuel_prices", "read-only", "search", undefined, undefined],
      ["verify_license", "read-only", "search", undefined, undefined],
      ["watch", "mutating", "persist", undefined, undefined],
      ["digest", "read-only", "none", undefined, undefined],
      // Trusted: it shows records, counters and rounded areas, never text a model or a source wrote.
      ["sources", "read-only", "none", false, undefined],
    ]);
  });

  it("declares its fuel watch as designed: attended only, medium risk, its card showing every field agreed to; and its heartbeat source", () => {
    expect(manifest.tools.find((tool) => tool.name === "watch")).toMatchObject({
      attendedOnly: true,
      minRisk: "medium",
      card: { fields: ["/op", "/watchId", "/area", "/country", "/fuel", "/threshold", "/currency", "/cadence"] },
    });
    expect(manifest).toMatchObject({
      provides: ["heartbeat-signals"],
      heartbeatSignals: { abi: "tavi.heartbeat/1", sources: ["watches"] },
    });
  });

  it("covers every source's hosts, with terms reviewed within 180 days; excludes the sources whose terms ban a model", () => {
    const records = [
      overpassRecord,
      photonRecord,
      nominatimRecord,
      overtureRecord,
      orsRecord,
      tdlrRecord,
      ...FUEL_SOURCES.map((source) => source.record),
      ...EV_SOURCES.map((source) => source.record),
      bnetzaRecord,
      ...CIVIC_SOURCES.map((source) => source.record),
      ...OPEN311_CITIES.map((city) => open311Adapter(city).record),
    ];
    const credentials = Object.entries(manifest.config)
      .filter(([, field]) => field.type === "credential")
      .map(([key]) => key);
    expect(credentials).toEqual(["afdcKey", "ocmKey", "tankerkoenigKey", "eiaKey", "nswKey", "nswSecret", "socrataAppToken", "orsKey"]);
    expect(manifest.rawSecrets).toEqual(["tankerkoenigKey", "eiaKey", "nswKey", "nswSecret"]);
    expect(
      domainSourceProblems(
        records,
        { networkDomains: manifest.network?.domains ?? [], credentials, rawSecrets: manifest.rawSecrets ?? [] },
        new Date().toISOString().slice(0, 10),
      ),
    ).toEqual([]);
    for (const host of manifest.network?.domains ?? [])
      expect(host, host).not.toMatch(/yelp|here\.com|hereapi|googleapis|maps\.google|mapbox|router\.project-osrm|routing\.openstreetmap/);
  });

  it("registers exactly the tools it declares, and refuses to open its store outside a confined worker", async () => {
    const tools = new Map<string, (input: unknown, options: { signal: AbortSignal }, context?: unknown) => Promise<unknown>>();
    register({
      z,
      config: {},
      secret: async () => null,
      registerTool: (tool: { name: string; handler: never }) => void tools.set(tool.name, tool.handler),
    } as never);
    expect([...tools.keys()]).toEqual(manifest.tools.map((tool) => tool.name));
    await expect(Promise.resolve().then(() => tools.get("sources")?.({}, { signal: new AbortController().signal }))).rejects.toThrow(
      /only as a confined worker/,
    );
  });

  it("ships a licensing matrix for its jurisdictions, each row reviewed within 180 days and each api row's source a known one", () => {
    expect(LICENSING.map((file) => file.country)).toEqual(["US", "GB", "DE", "FR"]);
    const today = Date.parse(new Date().toISOString().slice(0, 10));
    for (const row of LICENSING.flatMap((file) => file.rows)) {
      expect(today - Date.parse(row.reviewedAt), `${row.jurisdiction}/${row.profession}`).toBeLessThanOrEqual(180 * 86_400_000);
      if (row.access === "api") expect(row.source).toBe("tdlr");
    }
    expect(new Set(LICENSING.flatMap((file) => file.rows.map((row) => row.jurisdiction.slice(0, 5))))).toEqual(
      new Set(["US-TX", "US-CA", "US-FL", "US-NY", "US-MI", "GB", "GB-EN", "GB-WL", "DE"]),
    );
  });
});
