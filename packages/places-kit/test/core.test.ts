import { readFileSync } from "node:fs";
import { join } from "node:path";

import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import {
  boxAround,
  coarsenPoint,
  distanceKm,
  foldText,
  formatWeek,
  hoursConfidence,
  nameSimilarity,
  nameTokens,
  normalizePhone,
  openAt,
  parseOpeningHours,
  placeLocalTime,
  PlacesSourceRecordSchema,
  registrableDomain,
  resolvePlaces,
  weekFromSpecification,
  weeksAgree,
  type CandidateInput,
} from "../src/index.js";

const NOW = "2026-10-17T12:00:00Z";

describe("normalisation", () => {
  it("folds case, accents, punctuation and legal forms out of a name", () => {
    expect(foldText("  Café   de Flore! ")).toBe("cafe de flore");
    expect(nameTokens("Eurohaus Autowerkstatt GmbH")).toEqual(["eurohaus", "autowerkstatt"]);
    expect(nameTokens("The Golden Fork, LLC")).toEqual(["golden", "fork"]);
    // A name that is only filler keeps its words.
    expect(nameTokens("The Co")).toEqual(["the", "co"]);
  });

  it("reads phones into E.164 in the record's country, and refuses what is not a phone", () => {
    expect(normalizePhone("(512) 555-0101", "US")).toBe("+15125550101");
    expect(normalizePhone("030 1234567", "DE")).toBe("+49301234567");
    expect(normalizePhone("+44 20 7946 0011")).toBe("+442079460011");
    expect(normalizePhone("call us", "US")).toBeUndefined();
  });

  it("keeps a website's registrable domain, with three labels under a second-level suffix", () => {
    expect(registrableDomain("https://www.riversidedental.example.com/book")).toBe("example.com");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("mailto:a@b.c")).toBeUndefined();
  });
});

describe("geography and coarsening", () => {
  it("measures distance and rounds a point to the decimals a source sends", () => {
    expect(distanceKm({ lat: 30.2672, lon: -97.7431 }, { lat: 30.2672, lon: -97.7431 })).toBe(0);
    expect(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111.2, 0);
    expect(coarsenPoint({ lat: 30.267153, lon: -97.743061 }, 2)).toEqual({ lat: 30.27, lon: -97.74 });
    const box = boxAround({ lat: 30.27, lon: -97.74 }, 1);
    expect(box.north - box.south).toBeCloseTo(0.018, 3);
  });
});

describe("opening hours", () => {
  it("reads the common OSM forms, later rules overriding earlier days", () => {
    const week = parseOpeningHours("Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off");
    expect(week && formatWeek(week)).toBe("Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off");
    const split = parseOpeningHours("Mo-Su 08:00-12:00,13:00-17:00; We off");
    expect(split && formatWeek(split)).toBe("Mo-Tu 08:00-12:00,13:00-17:00; We off; Th-Su 08:00-12:00,13:00-17:00");
    expect(parseOpeningHours("24/7") && formatWeek(parseOpeningHours("24/7") as never)).toBe("Mo-Su 00:00-24:00");
    // Public holidays are a caveat, not a guess.
    expect(parseOpeningHours("Mo-Fr 09:00-17:00; PH off")?.holidaysDiffer).toBe(true);
    // A bare `off` closes every day, alone or after other rules.
    expect(formatWeek(parseOpeningHours("off") as never)).toBe("Mo-Su off");
    expect(formatWeek(parseOpeningHours("Mo-Fr 09:00-17:00; closed") as never)).toBe("Mo-Su off");
  });

  it("leaves what it cannot read unknown instead of half read", () => {
    for (const value of [
      "Jan-Mar Mo-Fr 09:00-17:00",
      'Mo-Fr 09:00-17:00 || "by appointment"',
      "sunrise-sunset",
      "2026 Dec 25 off",
      "Mo-Fr nine to five",
      "",
    ])
      expect(parseOpeningHours(value), value).toBeUndefined();
  });

  it("is open across midnight, in the time's own offset", () => {
    const week = parseOpeningHours("Fr-Sa 18:00-02:00") as NonNullable<ReturnType<typeof parseOpeningHours>>;
    // Saturday 01:00 is Friday night's.
    expect(openAt(week, "2026-10-17T01:00:00+02:00")).toBe(true);
    expect(openAt(week, "2026-10-17T03:00:00+02:00")).toBe(false);
    expect(openAt(week, "2026-10-16T17:59:00+02:00")).toBe(false);
    expect(openAt(week, "2026-10-16T18:00:00")).toBeUndefined();
  });

  it("reads JSON-LD OpeningHoursSpecification, and compares it with OSM's", () => {
    const fromPage = weekFromSpecification([
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["https://schema.org/Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
        opens: "09:00:00",
        closes: "18:00:00",
      },
      { dayOfWeek: "Saturday", opens: "10:00", closes: "14:00" },
      { dayOfWeek: "Sunday", opens: "00:00", closes: "00:00" },
      { dayOfWeek: "Monday", opens: "08:00", closes: "12:00", validFrom: "2026-12-24" },
    ]);
    const fromOsm = parseOpeningHours("Mo-Fr 09:00-18:00; Sa 10:00-14:00");
    expect(fromPage && fromOsm && weeksAgree(fromPage, fromOsm)).toBe(true);
    expect(weekFromSpecification([{ dayOfWeek: "Monday" }])).toBeUndefined();
  });

  it("is high only when two sources agree and one is fresh; low on a conflict or a stale check", () => {
    const a = parseOpeningHours("Mo-Fr 09:00-18:00") as NonNullable<ReturnType<typeof parseOpeningHours>>;
    const b = parseOpeningHours("Mo-Fr 08:00-17:00") as NonNullable<ReturnType<typeof parseOpeningHours>>;
    expect(hoursConfidence([{ week: a, checkedAt: "2026-09-01T00:00:00Z" }, { week: a }], NOW).confidence).toBe("high");
    expect(hoursConfidence([{ week: a, checkedAt: "2026-09-01T00:00:00Z" }], NOW).confidence).toBe("medium");
    expect(hoursConfidence([{ week: a, checkedAt: "2025-01-01T00:00:00Z" }, { week: a }], NOW).confidence).toBe("medium");
    expect(hoursConfidence([{ week: a }, { week: b, checkedAt: "2026-09-01T00:00:00Z" }], NOW)).toEqual({
      confidence: "low",
      conflict: true,
      stale: false,
    });
    expect(hoursConfidence([{ week: a, checkedAt: "2023-01-01T00:00:00Z" }, { week: a }], NOW)).toMatchObject({
      confidence: "low",
      stale: true,
    });
  });
});

describe("entity resolution", () => {
  const pairs = JSON.parse(readFileSync(join(domainFixtures("places"), "resolution-pairs.json"), "utf8")) as {
    note: string;
    same: boolean;
    a: CandidateInput;
    b: CandidateInput;
  }[];

  it("meets its bar on 40 hand-labelled pairs: precision ≥ 0.95, recall ≥ 0.85", () => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    const misses: string[] = [];
    for (const pair of pairs) {
      const merged = resolvePlaces([pair.a, pair.b], { now: NOW }).length === 1;
      if (merged && pair.same) truePositive += 1;
      else if (merged) {
        falsePositive += 1;
        misses.push(`merged: ${pair.note}`);
      } else if (pair.same) {
        falseNegative += 1;
        misses.push(`apart: ${pair.note}`);
      }
    }
    const precision = truePositive / (truePositive + falsePositive);
    const recall = truePositive / (truePositive + falseNegative);
    expect(pairs).toHaveLength(40);
    expect(precision, misses.join("; ")).toBeGreaterThanOrEqual(0.95);
    expect(recall, misses.join("; ")).toBeGreaterThanOrEqual(0.85);
  });

  it("merges into one place with each field's sources, ids, attributions and confidence", () => {
    const pair = pairs.find((each) => each.note.startsWith("same tailor")) as (typeof pairs)[number];
    const [place, ...rest] = resolvePlaces([pair.a, pair.b], { now: NOW, priority: ["osm", "overture"] });
    expect(rest).toEqual([]);
    expect(place).toMatchObject({ name: "Stitch & Mend", phone: "+442079460011", ids: { osm: "node/4", overture: "ov4" }, flags: [] });
    expect(place?.provenance["phone"]?.map((entry) => entry.source)).toEqual(["osm", "overture"]);
    expect(place?.attribution).toEqual(["© OpenStreetMap contributors", "Overture Maps Foundation"]);
    expect(place?.placeId).toMatch(/^pl_[0-9a-f]{16}$/);
    // The same candidates in another order give the same place.
    expect(resolvePlaces([pair.b, pair.a], { now: NOW, priority: ["osm", "overture"] })[0]?.placeId).toBe(place?.placeId);
  });

  const osm = (id: string, extra: Partial<CandidateInput> = {}): CandidateInput => ({
    source: "osm",
    sourceId: id,
    licence: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    name: "Lucky Star",
    lat: 40.715,
    lon: -73.997,
    categories: ["restaurant"],
    ...extra,
  });

  it("flags one source, a phone conflict, a closure and a PO box; a permanent closure leaves no confidence", () => {
    expect(resolvePlaces([osm("node/1")], { now: NOW })[0]).toMatchObject({ flags: ["single_source"], confidence: 0.4 });
    const conflict = resolvePlaces(
      [
        osm("node/1", { phone: "+12125550101" }),
        {
          ...osm("ov1", { phone: "+12125550102" }),
          source: "overture",
          licence: "CDLA-Permissive-2.0",
          attribution: "Overture",
          confidence: 0.9,
          lat: 40.7151,
        },
      ],
      { now: NOW },
    );
    // The names, places and categories agree but the phones do not: a weak merge, flagged.
    expect(conflict).toHaveLength(1);
    expect(conflict[0]?.flags).toContain("phone_conflict");
    const closed = resolvePlaces(
      [
        osm("node/1"),
        { ...osm("ov1", { status: "permanently_closed" }), source: "overture", licence: "CDLA-Permissive-2.0", attribution: "Overture" },
      ],
      { now: NOW },
    )[0];
    expect(closed).toMatchObject({ status: "permanently_closed", confidence: 0 });
    expect(closed?.flags).toContain("reported_closed");
    expect(resolvePlaces([osm("node/2", { address: "P.O. Box 12, New York" })], { now: NOW })[0]?.flags).toContain("residential_address");
  });

  it("says open now only at high confidence, and flags hours two sources disagree on", () => {
    const fresh = { hours: "Mo-Su 11:00-23:00", hoursCheckedAt: "2026-09-30T00:00:00Z" };
    const both = resolvePlaces(
      [
        osm("node/1", fresh),
        { ...osm("ov1", { hours: "Mo-Su 11:00-23:00" }), source: "overture", licence: "CDLA-Permissive-2.0", attribution: "Overture" },
      ],
      { now: NOW, openAt: "2026-10-17T20:00:00-04:00" },
    );
    expect(both[0]?.hours).toEqual({ spec: "Mo-Su 11:00-23:00", openNow: "yes", confidence: "high" });
    const one = resolvePlaces([osm("node/1", fresh)], { now: NOW, openAt: "2026-10-17T20:00:00-04:00" });
    expect(one[0]?.hours).toMatchObject({ openNow: "unknown", confidence: "medium" });
    const disagree = resolvePlaces(
      [
        osm("node/1", fresh),
        { ...osm("ov1", { hours: "Mo-Su 09:00-17:00" }), source: "overture", licence: "CDLA-Permissive-2.0", attribution: "Overture" },
      ],
      { now: NOW },
    );
    expect(disagree[0]?.flags).toContain("hours_conflict");
    expect(disagree[0]?.hours?.confidence).toBe("low");
  });

  it("reads a time where a Bulgarian place is: 16:00Z is 19:00 in Sofia in October, 18:00 in December", () => {
    expect(placeLocalTime("2026-10-17T16:00:00Z", "BG")).toBe("2026-10-17T19:00:00+03:00");
    expect(placeLocalTime("2026-12-01T16:00:00+00:00", "BG")).toBe("2026-12-01T18:00:00+02:00");
    // A country in several zones keeps the offset given, taken as the place's own.
    expect(placeLocalTime("2026-10-17T16:00:00Z", "US")).toBe("2026-10-17T16:00:00Z");
    const bakery = (id: string, source: "osm" | "overture") => ({
      ...osm(id, { hours: "Mo-Su 07:00-18:00", hoursCheckedAt: "2026-09-30T00:00:00Z", country: "BG", lat: 42.6977, lon: 23.3219 }),
      source,
      ...(source === "overture" ? { licence: "CDLA-Permissive-2.0", attribution: "Overture" } : {}),
    });
    // 16:30Z is 19:30 in Sofia: closed, though 16:30 on the clock would be open.
    expect(
      resolvePlaces([bakery("node/1", "osm"), bakery("ov1", "overture")], { now: NOW, openAt: "2026-10-17T16:30:00Z" })[0]?.hours?.openNow,
    ).toBe("no");
  });

  it("compares a Cyrillic name with its Latin spelling, a Bulgarian legal form left out", () => {
    expect(nameTokens("Аптека Ерудита ЕООД")).toEqual(["apteka", "erudita"]);
    expect(nameTokens("Хлебарница Двойка")).toEqual(["hlebarnitsa", "dvoyka"]);
    expect(nameSimilarity("Аптека Ерудита", "Apteka Erudita")).toBe(1);
    // A final "-ия" is "ia": София is Sofia.
    expect(nameSimilarity("Аптека София", "Apteka Sofia")).toBe(1);
    // A short Latin word is never taken for a legal form.
    expect(nameTokens("Ad Astra")).toEqual(["ad", "astra"]);
    // A phone written the Bulgarian way, read in BG.
    expect(normalizePhone("02 987 6543", "BG")).toBe("+35929876543");
  });

  it("keeps two businesses apart whose pages sit on one shared host", () => {
    const page = (id: string, name: string, website: string, lat: number): CandidateInput =>
      osm(id, { name, website, lat, categories: ["cafe"] });
    expect(
      resolvePlaces(
        [
          page("node/1", "Blue Door Coffee", "https://www.facebook.com/bluedoorcoffee", 40.715),
          page("node/2", "Corner Bean Cafe", "https://facebook.com/cornerbean", 40.7153),
        ],
        { now: NOW },
      ),
    ).toHaveLength(2);
    // The same page is the same business.
    expect(
      resolvePlaces(
        [
          page("node/1", "Blue Door Coffee", "https://www.facebook.com/bluedoorcoffee", 40.715),
          { ...page("ov1", "Blue Door", "https://m.facebook.com/BlueDoorCoffee/about", 40.7152), source: "overture" },
        ],
        { now: NOW },
      ),
    ).toHaveLength(1);
  });

  it("reads a JSON-LD type's words, so a page's AutoRepair is the car repair shop OSM knows", () => {
    const page = {
      ...osm("https://shop.example/", { name: "Lucky Star", categories: ["AutoRepair"] }),
      source: "page:shop.example",
      licence: "page",
      attribution: "the page",
    };
    expect(resolvePlaces([osm("node/1", { categories: ["car repair"] }), page], { now: NOW })).toHaveLength(1);
  });

  it("gives the same places whatever the input order, with no source priority", () => {
    const a = osm("node/1", { name: "Lucky Star", lat: 40.715 });
    const b = {
      ...osm("ov1", { name: "Lucky Star Restaurant", lat: 40.7151, lon: -73.9971 }),
      source: "overture",
      licence: "CDLA-Permissive-2.0",
      attribution: "Overture",
    };
    expect(resolvePlaces([a, b], { now: NOW })).toEqual(resolvePlaces([b, a], { now: NOW }));
  });

  it("keeps a chain of listings sharing a phone within a kilometre, and still flags the shared number", () => {
    const listing = (index: number): CandidateInput =>
      osm(`node/${String(index)}`, {
        name: `Speedy Locksmith ${String(index)}`,
        categories: ["locksmith"],
        phone: "+15125550999",
        lat: 30.2 + index * 0.006,
        lon: -97.7,
      });
    const places = resolvePlaces([listing(1), listing(2), listing(3), listing(4)], { now: NOW });
    for (const place of places) {
      const ids = Object.values(place.ids);
      expect(place.flags, ids.join()).toContain("shared_phone");
    }
    expect(places.length).toBeGreaterThan(1);
  });

  it("never merges listings a kilometre apart, and flags one number behind many in a lead-generation trade", () => {
    const listing = (index: number): CandidateInput =>
      osm(`node/${String(index)}`, {
        name: `Speedy Locksmith ${String(index)}`,
        categories: ["locksmith"],
        phone: "+15125550999",
        lat: 30.2 + index * 0.05,
        lon: -97.7,
      });
    const places = resolvePlaces([listing(1), listing(2), listing(3)], { now: NOW });
    expect(places).toHaveLength(3);
    for (const place of places) expect(place.flags).toContain("shared_phone");
  });
});

describe("the places source record", () => {
  const record = {
    id: "overpass",
    name: "OpenStreetMap (Overpass)",
    countries: ["*"],
    hosts: ["overpass-api.de"],
    auth: "none",
    terms: {
      url: "https://wiki.openstreetmap.org/wiki/Overpass_API",
      reviewedAt: "2026-10-17",
      licence: "ODbL-1.0",
      llmUse: "allowed",
      cache: { mode: "keep" },
      attribution: "© OpenStreetMap contributors",
      displayRules: [],
      userTriggeredOnly: false,
    },
    budget: { perSecond: 0.5, perDay: 100 },
    kind: "poi",
    precisionDecimals: 2,
    fields: ["hours", "phone", "website"],
  };

  it("extends the shared base and refuses a source whose terms ban a model", () => {
    expect(PlacesSourceRecordSchema.parse(record)).toMatchObject({
      id: "overpass",
      standing: "documented",
      defaultOn: true,
      transport: "http",
    });
    expect(() => PlacesSourceRecordSchema.parse({ ...record, terms: { ...record.terms, llmUse: "banned" } })).toThrow(/ban use by a model/);
    expect(() => PlacesSourceRecordSchema.parse({ ...record, auth: "key-header" })).toThrow(/names the config keys/);
  });
});
