import { readFileSync } from "node:fs";
import { join } from "node:path";

import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import {
  findLicensingRow,
  LicensingFileSchema,
  licensingProblems,
  parseTdlr,
  tdlrRequest,
  type LicensingRow,
  type SourceCall,
} from "../src/index.js";

const NOW = "2026-10-17T12:00:00.000Z";
const call: SourceCall = { credential: () => undefined, userAgent: "Tavi-places/test", now: NOW };
const electricians: LicensingRow = {
  jurisdiction: "US-TX",
  profession: "electrician",
  regime: "licensed",
  access: "api",
  source: "tdlr",
  licenseTypes: ["ELECTRIC"],
  note: "TDLR licenses electricians.",
  reviewedAt: "2026-10-17",
};
const files = [
  LicensingFileSchema.parse({
    country: "US",
    rows: [
      electricians,
      {
        jurisdiction: "US-TX",
        profession: "auto_repair",
        regime: "not_licensed",
        access: "none",
        note: "Not licensed.",
        reviewedAt: "2026-10-17",
      },
    ],
  }),
  LicensingFileSchema.parse({
    country: "GB",
    rows: [
      {
        jurisdiction: "GB",
        profession: "gas_engineer",
        regime: "licensed",
        access: "web",
        verifyUrl: "https://www.gassaferegister.co.uk/",
        note: "Gas Safe.",
        reviewedAt: "2026-10-17",
      },
    ],
  }),
];

describe("the licensing matrix", () => {
  it("finds a jurisdiction's row, else its country's, with where it came from", () => {
    expect(findLicensingRow(files, "US-TX", "auto_repair")).toMatchObject({
      row: { regime: "not_licensed" },
      ref: "data/licensing/us.json#US-TX/auto_repair",
    });
    expect(findLicensingRow(files, "GB-ENG", "gas_engineer")).toMatchObject({
      row: { jurisdiction: "GB" },
      ref: "data/licensing/gb.json#GB/gas_engineer",
    });
    expect(findLicensingRow(files, "US-CA", "auto_repair")).toBeUndefined();
    expect(findLicensingRow(files, "JP", "auto_repair")).toBeUndefined();
  });

  it("refuses an api row without its source, a row outside its file's country, and a row twice", () => {
    expect(() => LicensingFileSchema.parse({ country: "US", rows: [{ ...electricians, source: undefined }] })).toThrow(/names its source/);
    expect(licensingProblems([{ country: "US", rows: [electricians, electricians, { ...electricians, jurisdiction: "GB" }] }])).toEqual([
      "US: US-TX/electrician twice",
      "US: GB/electrician is not in US",
    ]);
  });
});

describe("Texas TDLR", () => {
  it("asks for the row's licence types and the subject's name or number, quoted for SoQL", () => {
    expect(tdlrRequest(electricians, {}, call)).toBeUndefined();
    const request = tdlrRequest(electricians, { name: "O'Brien Electric; DROP", licenceNumber: "123 45'" }, call);
    const url = decodeURIComponent(request?.url ?? "");
    expect(url).toContain(
      "$where=(upper(license_type) like '%ELECTRIC%') AND (license_number = '12345' OR upper(business_name) like '%O''BRIEN ELECTRIC DROP%' OR upper(owner_name) like '%O''BRIEN ELECTRIC DROP%')",
    );
    // Only what the answer shows is selected: no phones or mailing addresses.
    expect(url).toContain(
      "$select=license_type,license_number,business_name,owner_name,business_city_state_zip,license_expiration_date_mmddccyy",
    );
    expect(request?.headers).toBeUndefined();
    expect(
      tdlrRequest(
        electricians,
        { name: "Lone Star" },
        { ...call, credential: (key) => (key === "socrataAppToken" ? "token-placeholder" : undefined) },
      )?.headers,
    ).toEqual({ "X-App-Token": "token-placeholder" });
  });

  it("reads each licence's type, number, city and expiry, never its phones or addresses", () => {
    const body = JSON.parse(readFileSync(join(domainFixtures("places"), "tdlr", "electricians-synthetic.json"), "utf8")) as unknown;
    const outcome = parseTdlr({ status: 200, body }, NOW);
    expect(outcome).toEqual({
      kind: "ok",
      matches: [
        {
          name: "LONE STAR SPARK ELECTRIC LLC (AUSTIN TX)",
          number: "33333",
          status: "Electrical Contractor: listed, expires 2027-03-31",
          actions: [],
          asOf: NOW,
        },
        { name: "DOE, JANE (AUSTIN TX)", number: "44444", status: "Master Electrician: expired 2026-01-15", actions: [], asOf: NOW },
      ],
    });
    expect(JSON.stringify(outcome)).not.toMatch(/555|PO BOX/);
    expect(parseTdlr({ status: 200, body: { error: true } }, NOW)).toMatchObject({ kind: "drift" });
    expect(parseTdlr({ status: 200, body: [{ nope: 1 }, { nope: 2 }] }, NOW)).toMatchObject({ kind: "drift" });
    expect(parseTdlr({ status: 200, body: [] }, NOW)).toEqual({ kind: "ok", matches: [] });
  });
});
