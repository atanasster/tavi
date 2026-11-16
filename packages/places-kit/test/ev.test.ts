import { readFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { domainFixtures } from "@tavi/test-support/fixtures";
import { afterEach, describe, expect, it } from "vitest";

import {
  afdc,
  bnetzaCsvUrl,
  createBnetzaReader,
  licenceId,
  ocm,
  openEvPack,
  semicolonFields,
  writeEvPack,
  type EvFetch,
  type EvRead,
  type SourceCall,
} from "../src/index.js";
import type { PlacesRequest } from "../src/sources/types.js";

const NOW = "2026-10-17T10:00:00.000Z";
const fixture = (name: string): string => readFileSync(join(domainFixtures("places"), "ev", name), "utf8");
const call = (secrets: Record<string, string> = {}): SourceCall => ({
  credential: (key) => secrets[key],
  userAgent: "Tavi-places/test",
  now: NOW,
});
function fetcher(body: unknown): { readonly fetch: EvFetch; readonly asked: PlacesRequest[] } {
  const asked: PlacesRequest[] = [];
  return { asked, fetch: async (request) => (asked.push(request), { status: 200, body }) };
}
const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

describe("EV sources", () => {
  it("AFDC: the key in its header, the point rounded, miles for kilometres, connectors as AFDC names them", async () => {
    const net = fetcher(JSON.parse(fixture("afdc-austin-public.json")));
    expect(await afdc.run({ point: { lat: 30.27, lon: -97.74 }, radiusKm: 3, limit: 5 }, call(), net.fetch)).toMatchObject({
      kind: "skipped",
      reason: expect.stringMatching(/afdcKey/),
    });
    expect(
      await afdc.run(
        { point: { lat: 30.27, lon: -97.74 }, radiusKm: 3, connectors: ["CCS2"], limit: 5 },
        call({ afdcKey: "k" }),
        net.fetch,
      ),
    ).toMatchObject({ kind: "skipped" });
    const outcome = await afdc.run(
      { point: { lat: 30.2712, lon: -97.7433 }, radiusKm: 3.2, connectors: ["CCS1", "J1772"], limit: 5 },
      call({ afdcKey: "placeholder" }),
      net.fetch,
    );
    expect(net.asked[0]).toMatchObject({ headers: { "X-Api-Key": "placeholder" }, area: { point: { lat: 30.27, lon: -97.74 } } });
    expect(net.asked[0]?.url).toContain(
      "latitude=30.27&longitude=-97.74&radius=2&fuel_type=ELEC&status=E&access=public&limit=15&ev_connector_type=J1772COMBO,J1772",
    );
    expect(net.asked[0]?.url).not.toContain("placeholder");
    const sites = outcome.kind === "ok" ? outcome.sites : [];
    expect(sites[0]).toMatchObject({
      candidate: {
        source: "afdc",
        name: "301 E 8th St",
        brand: "CHARGELAB",
        checkedAt: "2026-10-17T00:00:00.000Z",
        categories: ["charging station"],
      },
      connectors: ["CCS1"],
      points: 8,
    });
    expect(sites.every((site) => site.candidate.licence === "public")).toBe(true);
  });

  it("Open Charge Map: each site under its data provider's licence, its connectors and power, a closed one marked", async () => {
    const net = fetcher((JSON.parse(fixture("ocm-berlin-synthetic.json")) as { pois: unknown[] }).pois);
    const outcome = await ocm.run(
      { point: { lat: 52.5201, lon: 13.4049 }, radiusKm: 2, connectors: ["CCS2"], limit: 10 },
      call({ ocmKey: "k" }),
      net.fetch,
    );
    expect(net.asked[0]?.url).toContain(
      "latitude=52.52&longitude=13.4&distance=2&distanceunit=KM&maxresults=30&compact=false&verbose=false&connectiontypeid=33",
    );
    expect(net.asked[0]?.headers).toEqual({ "X-API-Key": "k" });
    expect(outcome).toMatchObject({
      kind: "ok",
      sites: [
        {
          candidate: { name: "Alexanderplatz Charging", licence: "CC-BY-4.0", brand: "Allego", status: "open" },
          connectors: ["CCS2", "TYPE2"],
          maxKw: 150,
          points: 4,
        },
        { candidate: { name: "Rosenthaler Platz", licence: "ODbL-1.0" }, connectors: ["TYPE2"], maxKw: 11, points: 2 },
        { candidate: { name: "Closed charger", status: "temporarily_closed" }, connectors: ["CCS2"] },
      ],
    });
  });

  it("the Bundesnetzagentur register: its newest CSV found on its page, the notes above the header skipped, each site read", () => {
    expect(bnetzaCsvUrl(fixture("bnetza-page-excerpt.html"))).toEqual({
      url: "https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenregister_BNetzA_2026-09-01.csv",
      release: "2026-09-01",
    });
    expect(semicolonFields('1;"a;b";"say ""hi""";')).toEqual(["1", "a;b", 'say "hi"', ""]);
    const reader = createBnetzaReader();
    const sites = fixture("bnetza-head-2026-09-01.csv")
      .split("\n")
      .map(reader.line)
      .filter((site) => site !== undefined);
    expect(reader.header()).toBe(true);
    expect(sites.length).toBeGreaterThan(10);
    // A record whose public keys run over several lines is read whole, with all its plugs.
    expect(sites.find((site) => site.candidate.sourceId === "1157322")).toMatchObject({ connectors: ["CCS2"], maxKw: 300, points: 2 });
    expect(reader.records()).toBeGreaterThanOrEqual(sites.length);
    // The register is downloaded with CRLF endings (the fixture is kept LF): each line's CR is dropped, multi-line keys included.
    const crlf = createBnetzaReader();
    const fromCrlf = fixture("bnetza-head-2026-09-01.csv")
      .replace(/\r?\n/g, "\r\n")
      .split("\n")
      .map(crlf.line)
      .filter((site) => site !== undefined);
    expect(fromCrlf).toEqual(sites);
    expect(sites[0]).toMatchObject({
      candidate: {
        source: "de-bnetza",
        sourceId: "1010338",
        name: "Albwerk Elektro- und Kommunikationstechnik GmbH",
        address: "Am Berg 1, Heroldstatt",
        postcode: "72535",
        lat: 48.442398,
        lon: 9.659075,
        licence: "CC-BY-4.0",
      },
      connectors: ["TYPE2"],
      maxKw: 22,
      points: 2,
    });
  });

  it("names a data provider's licence by its id where it is a known one", () => {
    expect([
      licenceId("CC BY 4.0"),
      licenceId("Creative Commons Attribution-ShareAlike 4.0 International"),
      licenceId("Open Database License"),
      licenceId("Some local terms"),
    ]).toEqual(["CC-BY-4.0", "CC-BY-SA-4.0", "ODbL-1.0", "Some local terms"]);
    expect(licenceId("A very long data provider licence text that goes on and on past sixty characters").length).toBeLessThanOrEqual(60);
  });

  it("keeps the register in a pack, read back by distance and connector", () => {
    const directory = temp.create("tavi-ev-pack-");
    const reader = createBnetzaReader();
    const writer = writeEvPack(join(directory, "pack.db"));
    let written = 0;
    for (const line of fixture("bnetza-head-2026-09-01.csv").split("\n")) {
      const site = reader.line(line);
      if (site !== undefined) {
        writer.add(site);
        written += 1;
      }
    }
    expect(writer.finish("2026-09-01", NOW)).toBe(written);
    const pack = openEvPack(join(directory, "pack.db"));
    try {
      expect(pack).toMatchObject({ release: "2026-09-01", sites: written });
      const near: EvRead[] = pack.near({ lat: 48.44, lon: 9.66 }, 3, undefined, 5);
      expect(near.length).toBeGreaterThan(0);
      expect(near[0]?.candidate.source).toBe("de-bnetza");
      expect(pack.near({ lat: 48.44, lon: 9.66 }, 3, ["CHADEMO"], 50).every((site) => site.connectors.includes("CHADEMO"))).toBe(true);
    } finally {
      pack.close();
    }
  });
});
