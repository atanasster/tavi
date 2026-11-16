import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema } from "@tavi/contracts";
import { domainSourceProblems } from "@tavi/domain-kit";
import { cmsDcRecord, npiRecord, payerRecord } from "@tavi/places-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { register } from "../src/index.js";
import { PAYERS } from "../src/payers.js";

const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "tavi-plugin.json"), "utf8")));

describe("the places.care manifest", () => {
  it("is a confined worker with a Personal app: the household rule offers it only in its operator's own chats", () => {
    expect(manifest).toMatchObject({
      id: "places.care",
      isolation: "process",
      apps: { apps: [{ id: "places-health", category: "search", dataClass: "personal" }] },
    });
  });

  it("declares in_network external, high risk, its card showing payer, plan and providers; the rest read-only", () => {
    expect(
      manifest.tools.map((tool) => [tool.name, tool.effect, tool.sink, tool.minRisk, tool.card?.fields, tool.untrustedOutput]),
    ).toEqual([
      ["providers", "read-only", "search", undefined, undefined, undefined],
      ["registry_check", "read-only", "search", undefined, undefined, undefined],
      ["in_network", "external", "network", "high", ["/payer", "/plan", "/providers"], undefined],
      ["sources", "read-only", "none", undefined, undefined, false],
    ]);
  });

  it("covers every source's and Plan-Net payer's host, with terms reviewed within 180 days", () => {
    const records = [
      npiRecord,
      cmsDcRecord,
      ...PAYERS.flatMap((payer) => {
        const record = payerRecord(payer);
        return record === undefined ? [] : [record];
      }),
    ];
    expect(records.map((record) => record.id)).toEqual(["npi", "cms-dc", "plannet-humana"]);
    expect(
      domainSourceProblems(
        records,
        { networkDomains: manifest.network?.domains ?? [], credentials: [], rawSecrets: manifest.rawSecrets ?? [] },
        new Date().toISOString().slice(0, 10),
      ),
    ).toEqual([]);
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
});
