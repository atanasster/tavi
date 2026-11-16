import { z } from "zod";

import { PlacesSourceRecordSchema } from "../contracts.js";
import type { LicenceMatch, LicensingRow } from "../licensing.js";
import { statusOutcome } from "./common.js";
import type { Failure, PlacesRequest, SourceCall, SourceResponse } from "./types.js";

/**
 * Texas's Department of Licensing and Regulation, through its "All Licenses"
 * dataset on the state's Socrata portal: electricians and A/C
 * contractors among others. Keyless; an app token (`socrataAppToken`), when
 * set, goes in the `X-App-Token` header for Socrata's higher limits.
 */

export const TDLR_DATASET = "https://data.texas.gov/resource/7358-krk7.json";

export const tdlrRecord = PlacesSourceRecordSchema.parse({
  id: "tdlr",
  name: "Texas TDLR licences",
  countries: ["US"],
  hosts: ["data.texas.gov"],
  auth: "none",
  credential: ["socrataAppToken"],
  terms: {
    url: "https://catalog.data.gov/dataset/tdlr-all-licenses",
    reviewedAt: "2026-10-17",
    licence: "public",
    llmUse: "silent",
    cache: { mode: "none" },
    attribution: "Texas Department of Licensing and Regulation, data.texas.gov",
    displayRules: ["Say a licence's status is as of the dataset's last update; TDLR's own license search is the record"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 1_000 },
  kind: "registry",
  precisionDecimals: 2,
  fields: [],
});

/** Answers one query returns. */
const MATCHES_MAX = 10;

/** A name as SoQL takes it: letters, digits and a few marks, quotes doubled. */
function soqlText(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9 &'.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/'/g, "''");
}

/** The query for a subject's licences of the row's types, or `undefined` with no subject to look for. */
export function tdlrRequest(
  row: LicensingRow,
  subject: { readonly name?: string | undefined; readonly licenceNumber?: string | undefined },
  call: SourceCall,
): PlacesRequest | undefined {
  const types = (row.licenseTypes ?? []).map((type) => `upper(license_type) like '%${type.replace(/'/g, "''")}%'`);
  const name = subject.name === undefined ? "" : soqlText(subject.name);
  const number = subject.licenceNumber === undefined ? "" : subject.licenceNumber.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
  const who = [
    ...(number === "" ? [] : [`license_number = '${number}'`]),
    ...(name === "" ? [] : [`upper(business_name) like '%${name}%'`, `upper(owner_name) like '%${name}%'`]),
  ];
  if (who.length === 0 || types.length === 0) return undefined;
  const where = `(${types.join(" OR ")}) AND (${who.join(" OR ")})`;
  const select = "license_type,license_number,business_name,owner_name,business_city_state_zip,license_expiration_date_mmddccyy";
  const token = call.credential("socrataAppToken");
  return {
    source: tdlrRecord.id,
    url: `${TDLR_DATASET}?$select=${encodeURIComponent(select)}&$where=${encodeURIComponent(where)}&$limit=${String(MATCHES_MAX)}`,
    ...(token === undefined ? {} : { headers: { "X-App-Token": token } }),
    body: "json",
  };
}

const RowSchema = z.looseObject({
  license_type: z.string(),
  license_number: z.string(),
  business_name: z.string().optional(),
  owner_name: z.string().optional(),
  business_city_state_zip: z.string().optional(),
  license_expiration_date_mmddccyy: z.string().optional(),
});

/** `MMDDCCYY` as an ISO date, or `undefined`. */
function expiry(value: string | undefined): string | undefined {
  const match = /^(\d{2})(\d{2})(\d{4})$/.exec(value ?? "");
  return match === null ? undefined : `${match[3] as string}-${match[1] as string}-${match[2] as string}`;
}

/**
 * The licences found, each with its type and when it expires. Only the
 * licensee's name, number, city and dates are read: the dataset's phones and
 * mailing addresses are left where they are.
 */
export function parseTdlr(response: SourceResponse, now: string): { readonly kind: "ok"; readonly matches: LicenceMatch[] } | Failure {
  const status = statusOutcome(response, now);
  if (status !== undefined) return status;
  if (!Array.isArray(response.body)) return { kind: "drift", detail: "the answer is not a list of rows" };
  const matches: LicenceMatch[] = [];
  for (const item of response.body.slice(0, MATCHES_MAX)) {
    const row = RowSchema.safeParse(item);
    if (!row.success) continue;
    const expires = expiry(row.data.license_expiration_date_mmddccyy);
    const lapsed = expires !== undefined && expires < now.slice(0, 10);
    const city = row.data.business_city_state_zip?.replace(/\s+\d{5}(-\d{4})?$/, "").trim();
    matches.push({
      name: [row.data.business_name ?? row.data.owner_name ?? "", city === undefined || city === "" ? "" : `(${city})`].join(" ").trim(),
      number: row.data.license_number,
      status: `${row.data.license_type}: ${expires === undefined ? "listed" : lapsed ? `expired ${expires}` : `listed, expires ${expires}`}`,
      actions: [],
      asOf: now,
    });
  }
  if (response.body.length > 0 && matches.length * 2 < Math.min(response.body.length, MATCHES_MAX))
    return { kind: "drift", detail: "the rows are not the shape Tavi reads" };
  return { kind: "ok", matches };
}
