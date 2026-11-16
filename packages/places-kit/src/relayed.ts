import { definedOnly } from "@tavi/contracts/util";
import { z } from "zod";

import { CandidateSchema, type Candidate, type Place } from "./contracts.js";
import { formatWeek, parseOpeningHours, weekFromSpecification } from "./hours.js";

/**
 * What the agent relays to `reconcile`: a business's own JSON-LD from `browser.structured`, or a record it
 * extracted, read as a candidate from that page. Untrusted third-party text:
 * it is bounded, compared, and never stored.
 */

/** A relayed candidate's source: the page's host, so it never passes for a source Tavi keeps. */
export const relayedSource = (url: string): string => `page:${new URL(url).hostname.slice(0, 34)}`;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined;
const number = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
};

export const RelayedItemSchema = z.union([
  z.strictObject({ kind: z.literal("jsonld"), url: z.string().url().max(2_048), data: z.record(z.string(), z.unknown()) }),
  z.strictObject({
    kind: z.literal("record"),
    url: z.string().url().max(2_048),
    name: z.string().min(1).max(200),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    address: z.string().max(300).optional(),
    phone: z.string().max(60).optional(),
    hours: z.string().max(500).optional().describe("OSM opening_hours syntax"),
  }),
]);
export type RelayedItem = z.infer<typeof RelayedItemSchema>;

/** A relayed item as a candidate from its page, or `undefined` when it names no place with a position. */
export function candidateFromRelayed(item: RelayedItem): Candidate | undefined {
  const source = relayedSource(item.url);
  const base = { source, sourceId: item.url, licence: "page", attribution: `the page at ${new URL(item.url).hostname}`, url: item.url };
  if (item.kind === "record") {
    const parsed = CandidateSchema.safeParse({
      ...base,
      name: item.name,
      lat: item.lat,
      lon: item.lon,
      ...definedOnly({ address: item.address, phone: item.phone, hours: item.hours }),
    });
    return parsed.success ? parsed.data : undefined;
  }
  const data = item.data;
  const geo = (data["geo"] ?? {}) as Record<string, unknown>;
  const lat = number(geo["latitude"]);
  const lon = number(geo["longitude"]);
  const name = text(data["name"], 200);
  if (name === undefined || lat === undefined || lon === undefined) return undefined;
  const address = data["address"];
  const addressText =
    typeof address === "string"
      ? text(address, 300)
      : address !== null && typeof address === "object"
        ? text(
            [(address as Record<string, unknown>)["streetAddress"], (address as Record<string, unknown>)["addressLocality"]]
              .filter((part) => typeof part === "string")
              .join(", "),
            300,
          )
        : undefined;
  const postcode =
    address !== null && typeof address === "object" ? text((address as Record<string, unknown>)["postalCode"], 20) : undefined;
  const specification = data["openingHoursSpecification"];
  const week = Array.isArray(specification)
    ? weekFromSpecification(specification)
    : specification !== undefined
      ? weekFromSpecification([specification])
      : typeof data["openingHours"] === "string"
        ? parseOpeningHours(data["openingHours"])
        : undefined;
  const types = Array.isArray(data["@type"]) ? data["@type"] : [data["@type"]];
  const telephone = text(data["telephone"], 60);
  const website = text(data["url"], 2_048);
  const parsed = CandidateSchema.safeParse({
    ...base,
    name,
    categories: types
      .filter((type): type is string => typeof type === "string")
      .map((type) => type.slice(0, 80))
      .slice(0, 8),
    ...(addressText === undefined ? {} : { address: addressText }),
    ...(postcode === undefined ? {} : { postcode }),
    lat,
    lon,
    ...(telephone === undefined ? {} : { phone: telephone }),
    ...(website === undefined ? {} : { website }),
    ...(week === undefined ? {} : { hours: formatWeek({ ...week, holidaysDiffer: false }) }),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * A stored place as a candidate, so what the agent relays can be compared
 * with it: its fields under the source `stored`, its hours in OSM's syntax.
 */
export function candidateFromPlace(place: Place): Candidate {
  const hours = place.hours === undefined ? undefined : place.hours.spec.replace(/; PH differs$/, "");
  return CandidateSchema.parse({
    source: "stored",
    sourceId: place.placeId,
    licence:
      [
        ...new Set(
          Object.values(place.provenance)
            .flat()
            .map((entry) => entry.licence),
        ),
      ]
        .join(", ")
        .slice(0, 60) || "stored",
    attribution: place.attribution.join("; ").slice(0, 200),
    name: place.name,
    categories: place.categories,
    ...(place.address === undefined ? {} : { address: place.address }),
    lat: place.location.lat,
    lon: place.location.lon,
    ...definedOnly({ phone: place.phone, website: place.website, hours }),
    status: place.status,
    confidence: place.confidence,
  });
}
