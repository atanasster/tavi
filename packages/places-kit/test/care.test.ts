import { readFileSync } from "node:fs";
import { join } from "node:path";

import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import {
  cmsDcRequest,
  InNetworkInputSchema,
  networkMatch,
  networkMatchesPlan,
  npiRequest,
  parseBundle,
  parseCmsDc,
  parseNpi,
  PayerSchema,
  planNetRequests,
  planWords,
  roleNetworkIds,
} from "../src/index.js";

const NOW = "2026-10-17T10:00:00.000Z";
const json = (name: string): unknown => JSON.parse(readFileSync(join(domainFixtures("places"), "care", name), "utf8"));
const humana = PayerSchema.parse({
  id: "humana",
  name: "Humana",
  fhirBase: "https://fhir.humana.com/api",
  directoryUrl: "https://www.humana.com/finder/search",
  reviewedAt: "2026-10-17",
});

describe("health providers", () => {
  it("NPPES: a place filters on the practice LOCATION, never a mailing address; the answer shows only where they practise", () => {
    const request = npiRequest({ specialty: "Dentist", postcode: "78701" }, 10);
    expect(request.url).toBe(
      "https://npiregistry.cms.hhs.gov/api/?version=2.1&taxonomy_description=Dentist&postal_code=78701&address_purpose=LOCATION&limit=10",
    );
    expect(npiRequest({ number: "1003268079" }, 1).url).not.toContain("address_purpose");
    const outcome = parseNpi({ status: 200, body: json("npi-dentists-78701.json") }, NOW);
    expect(outcome.kind).toBe("ok");
    const providers = outcome.kind === "ok" ? outcome.providers : [];
    expect(providers[0]).toMatchObject({
      npi: "1841845989",
      kind: "individual",
      name: "Alex Rivera",
      credential: "DDS, MPH",
      status: "active",
      taxonomies: [{ description: "Dentist, Dental Public Health", primary: true, state: "TX", licence: "22414" }],
      location: { city: "Austin", state: "TX", postcode: "78701" },
    });
    expect(parseNpi({ status: 200, body: { Errors: [{ description: "No valid search criteria provided" }] } }, NOW)).toEqual({
      kind: "refused",
      detail: "No valid search criteria provided",
    });
  });

  it("CMS Doctors and Clinicians: Medicare assignment and telehealth for a list of NPIs", () => {
    expect(decodeURIComponent(cmsDcRequest(["1003268079", "not-an-npi"])?.url ?? "")).toContain(
      "conditions[0][property]=npi&conditions[0][operator]=in&conditions[0][value][0]=1003268079&properties[0]=npi",
    );
    expect(cmsDcRequest(["x"])).toBeUndefined();
    const outcome = parseCmsDc({ status: 200, body: json("cms-dc-npis.json") }, NOW);
    expect(outcome.kind === "ok" ? Object.fromEntries(outcome.byNpi) : {}).toEqual({
      "1003268079": { specialty: "Cardiac Electrophysiology", telehealth: true, acceptsAssignment: true },
      "1003000126": { specialty: "Hospitalist", acceptsAssignment: true },
    });
  });

  it("Plan-Net: a practitioner by NPI, their roles' networks, and the networks' names", () => {
    expect(planNetRequests.practitioner(humana, "1003268079").url).toBe(
      "https://fhir.humana.com/api/Practitioner?identifier=http%3A%2F%2Fhl7.org%2Ffhir%2Fsid%2Fus-npi%7C1003268079&_count=5",
    );
    const practitioner = parseBundle({ status: 200, body: json("humana-practitioner-1003268079.json") }, NOW, "Practitioner");
    expect(practitioner.kind === "ok" ? practitioner.resources.map((resource) => resource["id"]) : []).toEqual([
      "095b72d91a2522f9edcfe106d79f9c02ce16bf538e52b46c34e59c16e7bcd6c8",
    ]);
    const roles = parseBundle({ status: 200, body: json("humana-roles-1003268079.json") }, NOW, "PractitionerRole");
    const ids = roleNetworkIds(roles.kind === "ok" ? roles.resources : []);
    expect(ids).toHaveLength(15);
    const networks = parseBundle({ status: 200, body: json("humana-networks-1003268079.json") }, NOW, "Organization");
    const names = networks.kind === "ok" ? networks.resources.map((resource) => String(resource["name"])) : [];
    // A dual-eligible (DSNP) network matches only a plan that names it.
    expect(names.filter((name) => networkMatchesPlan(name, "Humana Gold Plus", "Humana"))).toEqual([
      "Gold Plus HMO and SNP H0028",
      "Gold Plus HMO27",
      "Gold Plus HMO and SNP H4461",
      "Gold Plus HMO/SNP H446127",
      "Gold Plus HMO",
    ]);
    expect(names.filter((name) => networkMatchesPlan(name, "Humana Gold Plus DSNP", "Humana"))).toEqual(["Gold Plus DSNP H002827"]);
    expect(names.filter((name) => networkMatchesPlan(name, "Humana Value Plus", "Humana"))).toEqual([]);
    // A plan named only by its type is matched by those words, and only as possible.
    expect(names.filter((name) => networkMatch(name, "Humana Medicare PPO", "Humana").kind === "possible")).toEqual([
      "Medicare PPO27",
      "Group Medicare PPO+",
      "Medicare PPO",
    ]);
    expect(names.filter((name) => networkMatchesPlan(name, "Humana Medicare PPO", "Humana"))).toEqual([]);
    expect(planWords("HumanaGoldChoice Ntwk PFFS27", "Humana")).toEqual(["gold", "choice"]);
    // A next page is followed only on the payer's own host.
    expect(planNetRequests.next(humana, "https://fhir.humana.com/api/PractitionerRole?_skip=50")?.url).toBe(
      "https://fhir.humana.com/api/PractitionerRole?_skip=50",
    );
    expect(planNetRequests.next(humana, "https://attacker.example/PractitionerRole")).toBeUndefined();
  });

  it("a network naming another state, or dental or vision cover, is not the plan's; GOLDPLUS and Gold Plus are one name (QA-20261106-1652)", () => {
    // A Texas medical plan is not listed through Florida's dental network.
    expect(networkMatchesPlan("Florida GoldPlus Dental", "Humana Gold Plus", "Humana", "TX")).toBe(false);
    expect(networkMatchesPlan("Florida GoldPlus HMO", "Humana Gold Plus", "Humana", "TX")).toBe(false);
    expect(networkMatchesPlan("FL Gold Plus HMO", "Humana Gold Plus", "Humana", "TX")).toBe(false);
    expect(networkMatchesPlan("Florida GoldPlus HMO", "Humana Gold Plus", "Humana", "FL")).toBe(true);
    expect(networkMatchesPlan("Gold Plus Dental", "Humana Gold Plus HMO", "Humana", "TX")).toBe(false);
    expect(networkMatchesPlan("Gold Plus Vision", "Humana Gold Plus", "Humana", "TX")).toBe(false);
    expect(networkMatchesPlan("Florida GoldPlus Dental", "Humana Gold Plus Dental", "Humana", "FL")).toBe(true);
    // The plan as printed on the card and as the model rewrote it give one answer, both ways.
    expect(networkMatchesPlan("Gold Plus HMO", "GOLDPLUS HMO", "Humana", "TX")).toBe(true);
    expect(networkMatchesPlan("GOLDPLUS HMO", "Humana Gold Plus", "Humana", "TX")).toBe(true);
    expect(networkMatchesPlan("HumanaGoldChoice Ntwk PFFS", "GOLDPLUS HMO", "Humana", "TX")).toBe(false);
    // A network naming a state, with the provider's state not given, is only possible; so is a match on plan-type words alone.
    expect(networkMatch("Florida GoldPlus HMO", "Humana Gold Plus", "Humana")).toEqual({
      kind: "possible",
      why: "state",
      state: "Florida",
    });
    expect(networkMatch("Group Medicare PPO+", "Humana Medicare PPO", "Humana", "FL")).toEqual({
      kind: "possible",
      why: "type-only",
      words: ["medicare", "ppo"],
    });
    expect(networkMatch("FL Medicare HIDE PPO27", "Humana Medicare PPO", "Humana", "TX")).toEqual({ kind: "none" });
    expect(networkMatch("Gold Plus HMO27", "Humana Gold Plus", "Humana", "TX")).toEqual({ kind: "match" });
  });

  it("refuses a plan that reads as a member id", () => {
    expect(InNetworkInputSchema.safeParse({ payer: "humana", plan: "Humana Gold Plus", providers: ["1003268079"] }).success).toBe(true);
    expect(InNetworkInputSchema.safeParse({ payer: "humana", plan: "H12345678", providers: ["1003268079"] }).success).toBe(false);
    expect(InNetworkInputSchema.safeParse({ payer: "humana", plan: "Member 0012345678", providers: ["1003268079"] }).success).toBe(false);
    for (const plan of ["Gold Plus 123-45-6789", "W1234-5678", "ID 1234 5678"])
      expect(InNetworkInputSchema.safeParse({ payer: "humana", plan, providers: ["1003268079"] }).success, plan).toBe(false);
    for (const plan of ["Blue Advantage 2026", "Gold Plus HMO H0028"])
      expect(InNetworkInputSchema.safeParse({ payer: "humana", plan, providers: ["1003268079"] }).success, plan).toBe(true);
  });
});
