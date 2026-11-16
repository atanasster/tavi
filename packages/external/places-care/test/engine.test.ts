import { readFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { domainFixtures } from "@tavi/test-support/fixtures";
import { afterEach, describe, expect, it } from "vitest";

import { createCareEngine, type Fetched, type Fetcher } from "../src/engine.js";

const NOW = "2026-10-17T12:00:00.000Z";
const fixtures = join(domainFixtures("places"), "care");
const json = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), "utf8"));
const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

/** Recorded answers by URL prefix, in order; every request asked. */
function network(routes: Record<string, unknown>): { readonly fetcher: Fetcher; readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetcher: async (request) => {
      asked.push(request.url);
      const route = Object.entries(routes).find(([prefix]) => request.url.startsWith(prefix));
      const body = route?.[1];
      return route === undefined
        ? { status: 404, retryAfter: null, body: null, bytes: 0 }
        : ({ status: 200, retryAfter: null, body, bytes: JSON.stringify(body).length } satisfies Fetched);
    },
  };
}
function engine(fetcher: Fetcher) {
  const directory = temp.create("tavi-care-engine-");
  const clock = { ms: Date.parse(NOW) };
  return createCareEngine({
    storePath: join(directory, "care.db"),
    fetcher,
    config: {},
    version: "test",
    now: () => new Date(clock.ms).toISOString(),
    sleep: async (ms) => {
      clock.ms += ms;
    },
  });
}
const signal = () => new AbortController().signal;
const attended = { unattended: false };
const humana = {
  "https://fhir.humana.com/api/Practitioner?": json("humana-practitioner-1003268079.json"),
  "https://fhir.humana.com/api/PractitionerRole?": json("humana-roles-1003268079.json"),
  "https://fhir.humana.com/api/Organization?": json("humana-networks-1003268079.json"),
};

describe("providers and registry_check (P2.6)", () => {
  it("finds dentists at a ZIP code by where they practise, with Medicare's record, said not to be a network", async () => {
    const net = network({ "https://npiregistry.cms.hhs.gov/": json("npi-dentists-78701.json"), "https://data.cms.gov/": { results: [] } });
    const answer = await engine(net.fetcher).providers({ specialty: "Dentist", postcode: "78701" }, signal(), attended);
    expect(net.asked[0]).toContain("address_purpose=LOCATION");
    expect(answer.providers[0]).toMatchObject({ npi: "1841845989", location: { postcode: "78701" } });
    expect(answer.note).toMatch(/not which insurance networks/);
    expect(answer.attribution).toContain("CMS NPPES NPI Registry");
  });

  it("checks a provider by NPI, and a query the registry refuses is not a failure of the registry", async () => {
    const places = engine(
      network({
        "https://npiregistry.cms.hhs.gov/api/?version=2.1&number=": json("npi-number-1003268079.json"),
        "https://data.cms.gov/": json("cms-dc-npis.json"),
        "https://npiregistry.cms.hhs.gov/api/?version=2.1&last_name=": { Errors: [{ description: "No valid search criteria provided" }] },
      }).fetcher,
    );
    expect(await places.registryCheck({ npi: "1003268079" }, signal(), attended)).toMatchObject({
      providers: [
        {
          npi: "1003268079",
          status: "active",
          medicare: { specialty: "Cardiac Electrophysiology", telehealth: true, acceptsAssignment: true },
        },
      ],
    });
    expect(await places.registryCheck({ lastName: "Zz" }, signal(), attended)).toMatchObject({
      providers: [],
      sources: [{ source: "npi", outcome: "refused: No valid search criteria provided" }],
    });
    expect(places.sources().sources.find((source) => source.id === "npi")?.health).toMatchObject({ consecutiveFailures: 0 });
  });
});

describe("in_network (P2.6)", () => {
  it("Humana: the provider's networks from its Plan-Net directory, those carrying the plan's words listed", async () => {
    const net = network(humana);
    const answer = await engine(net.fetcher).inNetwork(
      { payer: "humana", plan: "Humana Gold Plus", providers: ["1003268079"] },
      signal(),
      attended,
    );
    expect(answer.rows).toEqual([
      {
        npi: "1003268079",
        status: "listed",
        matchedNetworks: [
          "Gold Plus HMO",
          "Gold Plus HMO and SNP H0028",
          "Gold Plus HMO and SNP H4461",
          "Gold Plus HMO/SNP H446127",
          "Gold Plus HMO27",
        ],
        otherNetworks: expect.arrayContaining(["Gold Plus DSNP H002827", "Medicare PPO", "Employer HMO Austin"]),
      },
    ]);
    expect(answer.note).toMatch(/confirm with the office and the payer/);
    // The plan's name never leaves: only NPIs and the directory's own ids are asked.
    expect(net.asked.some((url) => /gold|plus/i.test(decodeURIComponent(url)))).toBe(false);
    expect(net.asked).toHaveLength(3);
    // No contact of the person's rides with a health lookup.
    expect(answer.sources).toEqual([{ source: "plannet-humana", outcome: "ok", found: 1 }]);
  });

  it("a plan named only by its type is only a possible match (QA-20261106-1652); one naming only the payer asks for the plan's name", async () => {
    const places = engine(network(humana).fetcher);
    expect(
      (await places.inNetwork({ payer: "humana", plan: "Humana Medicare PPO", providers: ["1003268079"] }, signal(), attended)).rows[0],
    ).toMatchObject({
      status: "possible",
      matchedNetworks: ["Group Medicare PPO+", "Medicare PPO", "Medicare PPO27"],
      note: expect.stringMatching(/by plan type alone \(Medicare, PPO\).*not the directory confirming your plan/),
    });
    const net = network(humana);
    expect(
      await engine(net.fetcher).inNetwork({ payer: "humana", plan: "Humana", providers: ["1003268079"] }, signal(), attended),
    ).toMatchObject({ rows: [], note: expect.stringMatching(/names only the payer/) });
    expect(net.asked).toEqual([]);
  });

  it("a network naming another state or dental cover is not listed for a medical plan in the provider's state (QA-20261106-1652)", async () => {
    const networks = {
      resourceType: "Bundle",
      entry: ["Florida GoldPlus Dental", "Florida GoldPlus HMO", "Gold Plus HMO"].map((name, index) => ({
        resource: { resourceType: "Organization", id: `n${String(index)}`, name },
      })),
    };
    const routes = { ...humana, "https://fhir.humana.com/api/Organization?": networks };
    const rows = async (plan: string, state?: string) =>
      (
        await engine(network(routes).fetcher).inNetwork(
          { payer: "humana", plan, providers: ["1003268079"], ...(state === undefined ? {} : { state }) },
          signal(),
          attended,
        )
      ).rows[0];
    // With no state given, a network naming one is said to be possible only, never listed.
    const only = { ...routes, "https://fhir.humana.com/api/Organization?": { ...networks, entry: networks.entry.slice(0, 2) } };
    expect(
      (await engine(network(only).fetcher).inNetwork({ payer: "humana", plan: "Gold Plus", providers: ["1003268079"] }, signal(), attended))
        .rows[0],
    ).toMatchObject({ status: "possible", matchedNetworks: ["Florida GoldPlus HMO"], note: expect.stringMatching(/names Florida/) });
    // As the model rewrote the plan and as printed on the card: one answer.
    for (const plan of ["Humana Gold Plus", "GOLDPLUS HMO"])
      expect(await rows(plan, "TX"), plan).toMatchObject({
        status: "listed",
        matchedNetworks: ["Gold Plus HMO"],
        otherNetworks: ["Florida GoldPlus Dental", "Florida GoldPlus HMO"],
      });
  });

  it("a practitioner listed with no network is unknown, and a next page off the payer's host is not followed", async () => {
    const roles = {
      resourceType: "Bundle",
      entry: [{ resource: { resourceType: "PractitionerRole", id: "r1" } }],
      link: [{ relation: "next", url: "https://attacker.example/PractitionerRole?page=2" }],
    };
    const net = network({
      "https://fhir.humana.com/api/Practitioner?": json("humana-practitioner-1003268079.json"),
      "https://fhir.humana.com/api/PractitionerRole?": roles,
    });
    const answer = await engine(net.fetcher).inNetwork(
      { payer: "humana", plan: "Humana Gold Plus", providers: ["1003268079"] },
      signal(),
      attended,
    );
    expect(answer.rows).toEqual([
      {
        npi: "1003268079",
        status: "unknown",
        matchedNetworks: [],
        otherNetworks: [],
        note: "The directory lists this practitioner with no network",
      },
    ]);
    expect(net.asked.some((url) => url.includes("attacker"))).toBe(false);
  });

  it("other networks only, and a provider the directory does not list, each said", async () => {
    const answer = await engine(
      network({
        "https://fhir.humana.com/api/Practitioner?identifier=http%3A%2F%2Fhl7.org%2Ffhir%2Fsid%2Fus-npi%7C1999999999": {
          resourceType: "Bundle",
          entry: [],
        },
        ...humana,
      }).fetcher,
    ).inNetwork({ payer: "humana", plan: "Humana Value Plus", providers: ["1999999999", "1003268079"] }, signal(), attended);
    expect(answer.rows.map((row) => [row.npi, row.status])).toEqual([
      ["1999999999", "not_listed"],
      ["1003268079", "other_networks"],
    ]);
  });

  it("a payer whose directory cannot answer by NPI is sent to its own page, with no request", async () => {
    const net = network({});
    expect(
      await engine(net.fetcher).inNetwork({ payer: "cigna", plan: "Open Access Plus", providers: ["1003268079"] }, signal(), attended),
    ).toMatchObject({
      rows: [],
      verifyUrl: "https://hcpdirectory.cigna.com/",
      note: expect.stringMatching(/does not answer a provider by NPI/),
    });
    expect(net.asked).toEqual([]);
  });

  it("refuses a member-id-shaped plan before any request", async () => {
    const net = network(humana);
    await expect(
      engine(net.fetcher).inNetwork({ payer: "humana", plan: "XQZ123456789", providers: ["1003268079"] }, signal(), attended),
    ).rejects.toThrow(/never the member id/);
    expect(net.asked).toEqual([]);
  });
});
