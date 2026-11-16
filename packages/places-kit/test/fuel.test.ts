import { readFileSync } from "node:fs";
import { join } from "node:path";

import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  atEcontrol,
  bulletinDue,
  bulletinFileUrl,
  bulletinTable,
  esGeoportal,
  euOilBulletin,
  FuelWatchInputSchema,
  excelDate,
  frCarburants,
  readXlsxRows,
  itMimit,
  mimitRows,
  nswFuelcheck,
  tankerkoenig,
  usEia,
  waFuelwatch,
  zonedIso,
  type FuelFetch,
  type FuelQuery,
  type SourceCall,
} from "../src/index.js";
import type { PlacesRequest } from "../src/sources/types.js";

const NOW = "2026-10-17T10:00:00.000Z";
const fixture = (name: string): string => readFileSync(join(domainFixtures("places"), "fuel", name), "utf8");
const json = (name: string): unknown => JSON.parse(fixture(name));
const call = (secrets: Record<string, string> = {}): SourceCall => ({
  credential: (key) => secrets[key],
  userAgent: "Tavi-places/test",
  now: NOW,
});

/** Answers by URL prefix, in order; every request asked. */
function fetcher(routes: readonly (readonly [string, unknown])[]): { readonly fetch: FuelFetch; readonly asked: PlacesRequest[] } {
  const asked: PlacesRequest[] = [];
  return {
    asked,
    fetch: async (request) => {
      asked.push(request);
      const route = routes.find(([prefix]) => request.url.startsWith(prefix));
      return route === undefined ? { status: 404, body: null } : { status: 200, body: route[1] };
    },
  };
}
const query = (point: { lat: number; lon: number }, _country: string, extra: Partial<FuelQuery> = {}): FuelQuery => ({
  point,
  radiusKm: 5,
  fuel: "diesel",
  limit: 10,
  ...extra,
});
const priced = (outcome: Awaited<ReturnType<FuelFetch>> | { kind: string; stations?: readonly { price?: { amount: number } }[] }) =>
  "stations" in outcome
    ? (outcome.stations ?? []).filter((station) => station.price !== undefined).map((station) => station.price?.amount)
    : [];

describe("fuel sources", () => {
  it("Tankerkönig: only with the person's key, in the query, the point rounded; the demo key's prices read", async () => {
    const net = fetcher([["https://creativecommons.tankerkoenig.de/", json("tankerkoenig-berlin-demo.json")]]);
    expect(await tankerkoenig.run(query({ lat: 52.5201, lon: 13.4049 }, "DE"), call(), net.fetch)).toEqual({
      kind: "skipped",
      reason: expect.stringMatching(/tankerkoenigKey/),
    });
    expect(
      await tankerkoenig.run(query({ lat: 52.52, lon: 13.4 }, "DE", { fuel: "lpg" }), call({ tankerkoenigKey: "k" }), net.fetch),
    ).toMatchObject({ kind: "skipped" });
    expect(net.asked).toEqual([]);
    const outcome = await tankerkoenig.run(
      query({ lat: 52.5201, lon: 13.4049 }, "DE"),
      call({ tankerkoenigKey: "00000000-0000-0000-0000-000000000002" }),
      net.fetch,
    );
    expect(net.asked[0]?.url).toMatch(/lat=52\.52&lng=13\.4&rad=5&sort=dist&type=all&apikey=00000000/);
    expect(outcome.kind === "ok" ? outcome.stations[0] : undefined).toMatchObject({
      candidate: { source: "tankerkoenig", name: "Aral Tankstelle", country: "DE", categories: ["fuel"] },
      price: { currency: "EUR", fuel: "diesel", reportedAt: NOW },
    });
    expect(
      (
        await tankerkoenig.run(
          query({ lat: 52.52, lon: 13.4 }, "DE"),
          call({ tankerkoenigKey: "k" }),
          fetcher([
            ["https://creativecommons", { ok: false, status: "error", message: "apikey nicht angegeben, falsch, oder im falschen Format" }],
          ]).fetch,
        )
      ).kind,
    ).toBe("unauthorized");
  });

  it("France: within a distance of the rounded point, cheapest first, each price with its own update time", async () => {
    const net = fetcher([["https://data.economie.gouv.fr/", json("fr-lyon-gazole.json")]]);
    const outcome = await frCarburants.run(query({ lat: 45.7601, lon: 4.8402 }, "FR"), call(), net.fetch);
    expect(decodeURIComponent(net.asked[0]?.url ?? "")).toContain(
      "within_distance(geom, geom'POINT(4.84 45.76)', 5km) and gazole_prix is not null&order_by=gazole_prix",
    );
    expect(outcome).toMatchObject({
      kind: "ok",
      stations: expect.arrayContaining([
        expect.objectContaining({
          candidate: expect.objectContaining({ source: "fr-carburants", name: expect.stringMatching(/^Station, /) }),
          price: {
            amount: 2.25,
            currency: "EUR",
            fuel: "gazole",
            reportedAt: "2026-10-17T00:01:00.000Z",
            basis: "changed",
            source: "fr-carburants",
          },
        }),
      ]),
    });
  });

  it("Spain: its two nearest provinces' lists, no point sent, each station within the radius; the feed's local time read", async () => {
    const net = fetcher([["https://sedeaplicaciones.minetur.gob.es/", json("es-madrid-province-28.json")]]);
    const outcome = await esGeoportal.run(query({ lat: 40.42, lon: -3.7 }, "ES"), call(), net.fetch);
    expect(net.asked.map((request) => request.url.split("/").at(-1))).toEqual(["28", "45"]);
    expect(net.asked.every((request) => request.area === undefined)).toBe(true);
    expect(priced(outcome as never)).toContain(1.879);
    // 17/10/2026 9:05:33 in Madrid (CEST) is 07:05:33 UTC.
    expect(outcome).toMatchObject({
      kind: "ok",
      stations: expect.arrayContaining([
        expect.objectContaining({ price: expect.objectContaining({ reportedAt: "2026-10-17T07:05:33.000Z", fuel: "Gasoleo A" }) }),
      ]),
    });
  });

  it("Italy: the two daily files, a station's self-service price first, and only stations within the radius", async () => {
    const net = fetcher([
      ["https://www.mimit.gov.it/images/exportCSV/anagrafica", fixture("it-anagrafica-synthetic.csv")],
      ["https://www.mimit.gov.it/images/exportCSV/prezzo", fixture("it-prezzo-synthetic.csv")],
    ]);
    const outcome = await itMimit.run(query({ lat: 41.88, lon: 12.52 }, "IT"), call(), net.fetch);
    expect(outcome.kind).toBe("ok");
    const stations = outcome.kind === "ok" ? outcome.stations : [];
    expect(stations.map((station) => [station.candidate.name, station.price?.amount, station.price?.fuel])).toEqual([
      ["ENI VIA APPIA", 1.789, "Gasolio (self)"],
      ["Q8 TUSCOLANA", 1.769, "Gasolio (self)"],
      ["Pompe Bianche", 1.749, "Gasolio"],
    ]);
    expect(stations[0]?.price?.reportedAt).toBe("2026-10-16T05:45:00.000Z");
    expect(mimitRows("idImpianto;descCarburante\n1;Gasolio")).toEqual([{ idImpianto: "1", descCarburante: "Gasolio" }]);
    expect(await itMimit.run(query({ lat: 41.88, lon: 12.52 }, "IT", { fuel: "e85" }), call(), net.fetch)).toMatchObject({
      kind: "skipped",
    });
  });

  it("Austria: diesel near the rounded point; a station without a price stays, unpriced", async () => {
    const net = fetcher([["https://api.e-control.at/", json("at-wien-die.json")]]);
    const outcome = await atEcontrol.run(query({ lat: 48.2082, lon: 16.3738 }, "AT"), call(), net.fetch);
    expect(net.asked[0]?.url).toContain("latitude=48.21&longitude=16.37&fuelType=DIE");
    expect(outcome.kind === "ok" ? outcome.stations.length : 0).toBe(10);
    expect(priced(outcome as never)).toEqual([2.069, 2.107, 2.121, 2.169, 2.179]);
  });

  it("Western Australia: the state's list, cents as dollars, near the point only, the day's price from 06:00", async () => {
    const net = fetcher([["https://www.fuelwatch.wa.gov.au/", fixture("wa-fuelwatch-diesel.xml")]]);
    const outcome = await waFuelwatch.run(query({ lat: -31.95, lon: 115.86 }, "AU", { radiusKm: 10 }), call(), net.fetch);
    expect(net.asked[0]?.url).toBe("https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS?Product=4");
    const stations = outcome.kind === "ok" ? outcome.stations : [];
    expect(stations.length).toBeGreaterThan(0);
    expect(
      stations.every(
        (station) =>
          station.price !== undefined &&
          station.price.currency === "AUD" &&
          station.price.amount < 5 &&
          station.price.reportedAt === "2026-10-16T22:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("NSW FuelCheck: a token with the key and secret, then the nearby prices with it; cents as dollars", async () => {
    const net = fetcher([
      ["https://api.onegov.nsw.gov.au/oauth/", json("nsw-token-synthetic.json")],
      ["https://api.onegov.nsw.gov.au/FuelPriceCheck/", json("nsw-nearby-synthetic.json")],
    ]);
    expect(await nswFuelcheck.run(query({ lat: -33.89, lon: 151.21 }, "AU"), call(), net.fetch)).toMatchObject({
      kind: "skipped",
      reason: expect.stringMatching(/nswKey/),
    });
    const outcome = await nswFuelcheck.run(
      query({ lat: -33.8915, lon: 151.2099 }, "AU"),
      call({ nswKey: "key", nswSecret: "secret" }),
      net.fetch,
    );
    expect(net.asked[0]?.headers).toEqual({ Authorization: `Basic ${Buffer.from("key:secret").toString("base64")}` });
    expect(net.asked[1]).toMatchObject({
      method: "POST",
      headers: { apikey: "key", Authorization: "Bearer nsw-access-token", requesttimestamp: "17/10/2026 10:00:00 AM" },
    });
    expect(JSON.parse(net.asked[1]?.payload ?? "")).toMatchObject({ fueltype: "DL", latitude: "-33.89", longitude: "151.21" });
    expect(outcome).toMatchObject({
      kind: "ok",
      stations: [
        { price: { amount: 1.899, currency: "AUD", reportedAt: "2026-10-16T21:15:00.000Z", basis: "changed" } },
        { price: { amount: 1.929 } },
      ],
    });
    // The token is kept for the next lookup.
    await nswFuelcheck.run(query({ lat: -33.8915, lon: 151.2099 }, "AU"), call({ nswKey: "key", nswSecret: "secret" }), net.fetch);
    expect(net.asked.filter((request) => request.url.includes("/oauth/"))).toHaveLength(1);
    expect([
      nswFuelcheck.covers?.({ lat: -33.89, lon: 151.21 }),
      nswFuelcheck.covers?.({ lat: -42.88, lon: 147.33 }),
      nswFuelcheck.covers?.({ lat: -31.95, lon: 115.86 }),
      waFuelwatch.covers?.({ lat: -31.95, lon: 115.86 }),
    ]).toEqual([true, true, false, true]);
  });

  it("the US: EIA's weekly average for the state the area names, else the nation's; never station prices", async () => {
    const net = fetcher([["https://api.eia.gov/", json("eia-texas-diesel-synthetic.json")]]);
    const outcome = await usEia.run(
      query({ lat: 30.27, lon: -97.74 }, "US", { areaLabel: "78701, Austin, Travis County, Texas, United States" }),
      call({ eiaKey: "k" }),
      net.fetch,
    );
    expect(net.asked[0]?.url).toContain("facets[duoarea][]=STX&facets[product][]=EPD2D");
    expect(net.asked[0]?.area).toBeUndefined();
    expect(outcome).toEqual({
      kind: "ok",
      stations: [],
      average: {
        amount: 3.512,
        currency: "USD",
        unit: "gallon",
        fuel: "No 2 Diesel",
        area: "TEXAS",
        reportedAt: "2026-10-12T00:00:00.000Z",
        basis: "published",
        source: "us-eia",
      },
    });
    // A county named for another state is not that state; a label without its state reads the nation's.
    await usEia.run(
      query({ lat: 29.7, lon: -96.5 }, "US", { areaLabel: "Columbus, Colorado County, Texas, United States" }),
      call({ eiaKey: "k" }),
      net.fetch,
    );
    expect(net.asked[1]?.url).toContain("facets[duoarea][]=STX");
    await usEia.run(query({ lat: 35.2, lon: -101.8 }, "US", { areaLabel: "Amarillo, Potter County" }), call({ eiaKey: "k" }), net.fetch);
    expect(net.asked[2]?.url).toContain("facets[duoarea][]=NUS");
  });

  it("keeps a province already read when its neighbour's request fails, and calls a changed answer drift", async () => {
    const net = fetcher([
      [
        "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/FiltroProvincia/28",
        json("es-madrid-province-28.json"),
      ],
    ]);
    const outcome = await esGeoportal.run(query({ lat: 40.42, lon: -3.7 }, "ES"), call(), net.fetch);
    expect(outcome.kind === "ok" ? outcome.stations.length : 0).toBeGreaterThan(0);
    expect(
      await atEcontrol.run(
        query({ lat: 48.21, lon: 16.37 }, "AT"),
        call(),
        fetcher([["https://api.e-control.at/", [{ nope: 1 }, { nope: 2 }]]]).fetch,
      ),
    ).toMatchObject({ kind: "drift" });
    expect(
      await frCarburants.run(
        query({ lat: 45.76, lon: 4.84 }, "FR"),
        call(),
        fetcher([
          [
            "https://data.economie.gouv.fr/",
            { results: [{ id: 1, geom: { lat: 45.76, lon: 4.84 }, adresse: "1 rue", gazole_prix: 2.1, gazole_maj: "not a time" }] },
          ],
        ]).fetch,
      ),
    ).toMatchObject({ kind: "ok", stations: [{ candidate: { name: "Station, 1 rue" } }] });
  });

  it("reads a zone's wall clock as an instant, across daylight saving", () => {
    expect(zonedIso(2026, 1, 15, 12, 0, 0, "Europe/Madrid")).toBe("2026-01-15T11:00:00.000Z");
    expect(zonedIso(2026, 7, 15, 12, 0, 0, "Europe/Madrid")).toBe("2026-07-15T10:00:00.000Z");
    // Madrid's clocks go forward at 01:00 UTC on 2026-03-29: 01:30 that night is still CET.
    expect(zonedIso(2026, 3, 29, 1, 30, 0, "Europe/Madrid")).toBe("2026-03-29T00:30:00.000Z");
    expect(zonedIso(2026, 3, 29, 3, 30, 0, "Europe/Madrid")).toBe("2026-03-29T01:30:00.000Z");
  });
});

describe("the EU's Weekly Oil Bulletin", () => {
  const workbook = new Uint8Array(readFileSync(join(domainFixtures("places"), "fuel", "eu-oil-bulletin-2026-10-12.xlsx")));
  const page = fixture("eu-oil-bulletin-page.html");
  const fileUrl =
    "https://energy.ec.europa.eu/document/download/264c2d0f-f161-4ea3-a777-78faae59bea0_en?filename=Weekly%20Oil%20Bulletin%20Weekly%20prices%20with%20Taxes%20-%202026-09-21.xlsx";

  it("reads the recorded workbook's sheet: its header, its week and every member state", () => {
    const rows = readXlsxRows(workbook);
    expect(rows?.[0]?.[0]).toBe("in EUR");
    expect(excelDate(rows?.[1]?.[0])).toBe("2026-10-12");
    expect(rows?.find((row) => row[0] === "Bulgaria")?.slice(0, 3)).toEqual(["Bulgaria", "1649.1", "1873.8"]);
    expect(readXlsxRows(new TextEncoder().encode("not a zip"))).toBeUndefined();
    // A character reference past Unicode, as a changed file might hold, is text, not a throw.
    const stored = (name: string, data: string) => ({ name: new TextEncoder().encode(name), data: new TextEncoder().encode(data) });
    const parts = [
      stored(
        "xl/worksheets/sheet1.xml",
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&#x110000;&amp;</t></is></c></row></sheetData></worksheet>',
      ),
    ];
    const local: number[] = [];
    const central: number[] = [];
    const u16 = (value: number) => [value & 0xff, value >> 8];
    const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
    for (const part of parts) {
      const offset = local.length;
      local.push(
        ...u32(0x04034b50),
        ...u16(20),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ...u32(0),
        ...u32(part.data.length),
        ...u32(part.data.length),
        ...u16(part.name.length),
        ...u16(0),
        ...part.name,
        ...part.data,
      );
      central.push(
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ...u32(0),
        ...u32(part.data.length),
        ...u32(part.data.length),
        ...u16(part.name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...part.name,
      );
    }
    const zip = new Uint8Array([
      ...local,
      ...central,
      ...u32(0x06054b50),
      0,
      0,
      0,
      0,
      ...u16(parts.length),
      ...u16(parts.length),
      ...u32(central.length),
      ...u32(local.length),
      ...u16(0),
    ]);
    expect(readXlsxRows(zip)).toEqual([["&#x110000;&"]]);
  });

  it("links the latest prices with taxes from its page, never the prices without them", () => {
    expect(bulletinFileUrl(page)).toBe(fileUrl);
    expect(
      bulletinFileUrl(
        '<a href="https://elsewhere.example/document/download/x" data-untranslated-label="Prices with taxes latest prices (xlsx)">',
      ),
    ).toBeUndefined();
  });

  it("reads the week's table, a litre in EUR by member state; drift when the sheet changes shape", () => {
    const rows = readXlsxRows(workbook) ?? [];
    const table = bulletinTable(rows, NOW);
    if ("drift" in table) throw new Error(table.drift);
    expect(table.week).toBe("2026-10-12");
    expect(Object.keys(table.prices.diesel)).toHaveLength(27);
    expect([table.prices.diesel["BG"], table.prices.petrol["PL"], table.prices.lpg["BG"]]).toEqual([1.874, 1.57, 0.598]);
    expect(bulletinTable([["in USD"], ...rows.slice(1)], NOW)).toEqual({ drift: "the sheet does not say its prices are in EUR" });
  });

  /** A cache as the engine keeps one, in memory. */
  const memory = () => {
    let kept: unknown;
    return {
      read: () => kept,
      write: (value: unknown) => {
        kept = value;
      },
      get kept() {
        return kept;
      },
    };
  };
  const at = (iso: string, cache: ReturnType<typeof memory>): SourceCall => ({ ...call(), now: iso, cache });
  const bg = query({ lat: 42.7, lon: 23.32 }, "BG", { country: "BG" });

  it("asks the page, then its file, keyless, and keeps the week; Bulgaria's diesel is its national average", async () => {
    const net = fetcher([
      ["https://energy.ec.europa.eu/data-and-analysis/", page],
      ["https://energy.ec.europa.eu/document/", workbook],
    ]);
    const cache = memory();
    const outcome = await euOilBulletin.run(bg, at(NOW, cache), net.fetch);
    expect(net.asked.map((request) => [request.url, request.body])).toEqual([
      ["https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en", "text"],
      [fileUrl, "bytes"],
    ]);
    expect(outcome).toEqual({
      kind: "ok",
      stations: [],
      average: {
        amount: 1.874,
        currency: "EUR",
        unit: "litre",
        fuel: "Automotive gas oil (diesel)",
        area: "Bulgaria",
        reportedAt: "2026-10-12T00:00:00.000Z",
        basis: "published",
        source: "eu-oil-bulletin",
      },
    });
    expect(cache.kept).toMatchObject({ week: "2026-10-12", fetchedAt: NOW, checkedAt: NOW });
    // The kept week answers the next asks, any fuel, any member state, with no request.
    expect(await euOilBulletin.run({ ...bg, fuel: "e5", country: "PL" }, at("2026-10-19T09:00:00.000Z", cache), net.fetch)).toMatchObject({
      average: { amount: 1.57, area: "Poland" },
    });
    expect(net.asked).toHaveLength(2);
    expect(await euOilBulletin.run({ ...bg, fuel: "super98" }, at(NOW, cache), net.fetch)).toMatchObject({ kind: "skipped" });
    expect(await euOilBulletin.run(query({ lat: 51.5, lon: -0.1 }, "GB", { country: "GB" }), at(NOW, cache), net.fetch)).toMatchObject({
      kind: "skipped",
      reason: "the Oil Bulletin covers the EU's member states only",
    });
    const changed = fetcher([
      ["https://energy.ec.europa.eu/data-and-analysis/", page],
      ["https://energy.ec.europa.eu/document/", new TextEncoder().encode("<html>")],
    ]);
    expect(await euOilBulletin.run(bg, at(NOW, memory()), changed.fetch)).toEqual({
      kind: "drift",
      detail: "the Bulletin's file is not a workbook Tavi reads",
    });
  });

  it("asks for a newer week once one is due, at most every 6 hours while the page still links the old one", async () => {
    const net = fetcher([
      ["https://energy.ec.europa.eu/data-and-analysis/", page],
      ["https://energy.ec.europa.eu/document/", workbook],
    ]);
    const cache = memory();
    await euOilBulletin.run(bg, at(NOW, cache), net.fetch);
    // 8 days after the week's Monday the next is due: the page is asked, links the same file, and the kept week stands.
    expect(bulletinDue(cache.kept as never, "2026-10-19T23:59:00.000Z")).toBe(false);
    await euOilBulletin.run(bg, at("2026-10-20T10:00:00.000Z", cache), net.fetch);
    expect(net.asked).toHaveLength(4);
    expect(cache.kept).toMatchObject({ week: "2026-10-12", fetchedAt: NOW, checkedAt: "2026-10-20T10:00:00.000Z" });
    await euOilBulletin.run(bg, at("2026-10-20T15:00:00.000Z", cache), net.fetch);
    expect(net.asked).toHaveLength(4);
    await euOilBulletin.run(bg, at("2026-10-20T16:00:00.000Z", cache), net.fetch);
    expect(net.asked).toHaveLength(6);
  });

  it("answers from the kept week when a newer one cannot be read, and says a week past 15 days is stale", async () => {
    const cache = memory();
    await euOilBulletin.run(
      bg,
      at(NOW, cache),
      fetcher([
        ["https://energy.ec.europa.eu/data-and-analysis/", page],
        ["https://energy.ec.europa.eu/document/", workbook],
      ]).fetch,
    );
    const asked: PlacesRequest[] = [];
    const down = {
      asked,
      fetch: async (request: PlacesRequest) => {
        asked.push(request);
        return { status: 503, body: null };
      },
    };
    expect(await euOilBulletin.run(bg, at("2026-10-21T10:00:00.000Z", cache), down.fetch)).toMatchObject({
      kind: "ok",
      average: { amount: 1.874 },
    });
    expect(down.asked).toHaveLength(1);
    const stale = await euOilBulletin.run(bg, at("2026-10-28T10:00:00.000Z", cache), down.fetch);
    expect(stale).toMatchObject({ kind: "ok", average: { amount: 1.874, staleDays: 16 } });
    // Kept 30 days from its read, then dropped: with nothing to answer from, the failure is the answer.
    expect(await euOilBulletin.run(bg, at("2026-11-17T13:00:00.000Z", cache), down.fetch)).toEqual({ kind: "failed", status: 503 });
  });

  it("reads a newer week in the background only where one is kept and due", async () => {
    const net = fetcher([
      ["https://energy.ec.europa.eu/data-and-analysis/", page],
      ["https://energy.ec.europa.eu/document/", workbook],
    ]);
    expect(await euOilBulletin.refresh?.(at(NOW, memory()), net.fetch)).toBeUndefined();
    expect(net.asked).toHaveLength(0);
    const cache = memory();
    await euOilBulletin.run(bg, at(NOW, cache), net.fetch);
    expect(await euOilBulletin.refresh?.(at("2026-10-18T12:00:00.000Z", cache), net.fetch)).toBeUndefined();
    expect(net.asked).toHaveLength(2);
    expect(await euOilBulletin.refresh?.(at("2026-10-21T12:00:00.000Z", cache), net.fetch)).toBeUndefined();
    expect(net.asked).toHaveLength(4);
    expect(await euOilBulletin.refresh?.(at("2026-10-22T12:00:00.000Z", cache), async () => ({ status: 503, body: null }))).toEqual({
      kind: "failed",
      status: 503,
    });
  });
});

describe("a fuel watch's input", () => {
  const watchId = "fw_0123456789ab";
  const add = { op: "add", area: { text: "Lyon" }, fuel: "diesel", threshold: 1.7, currency: "EUR" } as const;

  it("is one object per op: an add needs its area and price, an update takes no area or country", () => {
    expect(FuelWatchInputSchema.safeParse(add).success).toBe(true);
    expect(FuelWatchInputSchema.safeParse({ op: "add", area: { text: "Lyon" } }).success).toBe(false);
    expect(FuelWatchInputSchema.safeParse({ op: "update", watchId, threshold: 1.6 }).success).toBe(true);
    const moved = FuelWatchInputSchema.safeParse({ op: "update", watchId, area: { text: "Paris" } });
    expect(moved.error?.issues.map((issue) => issue.message)).toEqual([expect.stringMatching(/area is set when it is added/)]);
    expect(FuelWatchInputSchema.safeParse({ op: "pause", watchId, country: "FR" }).success).toBe(false);
    expect(FuelWatchInputSchema.safeParse({ op: "remove" }).success).toBe(false);
  });

  it("is sent to a model as one object whose op names each form", () => {
    const schema = z.toJSONSchema(FuelWatchInputSchema, { io: "input", target: "draft-7", unrepresentable: "any" }) as {
      oneOf?: readonly { readonly properties: Record<string, unknown>; readonly additionalProperties?: unknown }[];
    };
    const update = schema.oneOf?.find((branch) => (branch.properties["op"] as { const?: string }).const === "update");
    expect(schema.oneOf).toHaveLength(5);
    expect(update?.additionalProperties).toBe(false);
    expect(Object.keys(update?.properties ?? {})).not.toContain("area");
  });
});
