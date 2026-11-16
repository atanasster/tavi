import { z } from "zod";

import { PlacesSourceRecordSchema } from "../contracts.js";
import { drifted, safeWords, statusOutcome } from "./common.js";
import { OSM_ATTRIBUTION } from "./osm.js";
import type { GeocoderAdapter } from "./types.js";

/**
 * Nominatim (the OSMF's public geocoder): at most one request a
 * second for the whole app, an identifying User-Agent, no autocomplete and no
 * scheduled bulk use. Tavi asks it only for what a person typed, so it is
 * `userTriggeredOnly`: a schedule or sweep geocodes with Photon instead.
 */
export const nominatimRecord = PlacesSourceRecordSchema.parse({
  id: "nominatim",
  name: "Nominatim (OpenStreetMap)",
  countries: ["*"],
  hosts: ["nominatim.openstreetmap.org"],
  auth: "none",
  terms: {
    url: "https://operations.osmfoundation.org/policies/nominatim/",
    reviewedAt: "2026-10-17",
    licence: "ODbL-1.0",
    llmUse: "allowed",
    cache: { mode: "keep" },
    attribution: OSM_ATTRIBUTION,
    displayRules: ["Credit OpenStreetMap where results are shown: © OpenStreetMap contributors, openstreetmap.org/copyright"],
    userTriggeredOnly: true,
  },
  budget: { perSecond: 1, perDay: 500 },
  kind: "geocode",
  precisionDecimals: 2,
  // A public OpenStreetMap service, busy at times: paused an hour, not a day, after five failures in a row.
  failurePauseHours: 1,
  fields: [],
});

const ResultSchema = z.looseObject({
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
  address: z.looseObject({ country_code: z.string().optional() }).optional(),
});

export const nominatim: GeocoderAdapter = {
  record: nominatimRecord,
  geocode: (text, _call, country) => {
    const words = safeWords(text.split(/,/)).join(", ");
    if (words === "") return undefined;
    return {
      source: "nominatim",
      url: `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(words)}&format=jsonv2&limit=1&addressdetails=1${country !== undefined && /^[A-Z]{2}$/.test(country) ? `&countrycodes=${country.toLowerCase()}` : ""}`,
      body: "json",
    };
  },
  parseGeocode: (response, _request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    if (!Array.isArray(response.body)) return { kind: "drift", detail: "the answer is not a list" };
    const points = response.body.flatMap((item) => {
      const result = ResultSchema.safeParse(item);
      const lat = result.success ? Number(result.data.lat) : Number.NaN;
      const lon = result.success ? Number(result.data.lon) : Number.NaN;
      if (!result.success || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const country = result.data.address?.country_code?.toUpperCase();
      return [{ lat, lon, label: result.data.display_name.slice(0, 200), ...(country === undefined ? {} : { country }) }];
    });
    if (drifted(response.body.length - points.length, response.body.length))
      return { kind: "drift", detail: "most results did not have the expected shape" };
    return { kind: "ok", points };
  },
};
