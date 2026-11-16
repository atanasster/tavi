import { CandidateSchema, type Candidate } from "../contracts.js";
import type { OsmElement } from "../store/store.js";
import { isoOf } from "./common.js";

/**
 * OSM elements as candidates: the name, the trade's tags, the address,
 * phone, website, hours and their check dates, diet and wheelchair tags. An
 * element without a name is not a place anyone searches for.
 */

export const OSM_LICENCE = "ODbL-1.0";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

/** The tags that say which trade a place is. */
const CATEGORY_KEYS = ["amenity", "shop", "craft", "healthcare", "office", "tourism", "leisure"] as const;
/** Each diet Tavi filters on, and the OSM tag that says it. */
export const DIET_TAGS: ReadonlyMap<string, string> = new Map([
  ["gluten_free", "diet:gluten_free"],
  ["vegan", "diet:vegan"],
  ["vegetarian", "diet:vegetarian"],
  ["halal", "diet:halal"],
  ["kosher", "diet:kosher"],
]);
const OSM_TYPES: ReadonlyMap<string, string> = new Map([
  ["node", "node"],
  ["way", "way"],
  ["relation", "relation"],
  ["N", "node"],
  ["W", "way"],
  ["R", "relation"],
]);

const tag = (tags: Readonly<Record<string, string>>, ...keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = tags[key]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
};

/** OSM's element types as Overpass and Photon name them. */
export function osmIdOf(type: string, id: number | string): string | undefined {
  const kind = OSM_TYPES.get(type);
  return kind === undefined || !/^\d+$/.test(String(id)) ? undefined : `${kind}/${String(id)}`;
}

/** An element as a candidate, or `undefined` for one with no name. */
export function candidateFromOsm(element: OsmElement): Candidate | undefined {
  const { tags } = element;
  const name = tag(tags, "name", "brand");
  if (name === undefined) return undefined;
  const categories = CATEGORY_KEYS.flatMap((key) => (tags[key] === undefined ? [] : [tags[key].replace(/_/g, " ")])).slice(0, 8);
  const street = [tag(tags, "addr:housenumber"), tag(tags, "addr:street")].filter((part) => part !== undefined).join(" ");
  const address = [street, tag(tags, "addr:city")].filter((part) => part !== undefined && part !== "").join(", ");
  const closed =
    Object.keys(tags).some((key) => key.startsWith("disused:") || key.startsWith("was:") || key.startsWith("abandoned:")) &&
    CATEGORY_KEYS.every((key) => tags[key] === undefined);
  const diet = [...DIET_TAGS].filter(([, key]) => tags[key] === "yes" || tags[key] === "only").map(([diet]) => diet);
  const wheelchair = tags["wheelchair"];
  const postcode = tag(tags, "addr:postcode");
  const phone = tag(tags, "phone", "contact:phone");
  const website = tag(tags, "website", "contact:website", "url");
  const hours = tag(tags, "opening_hours");
  const brand = tag(tags, "brand");
  const checkedAt = isoOf(tag(tags, "check_date", "survey:date"));
  const hoursCheckedAt = isoOf(tag(tags, "check_date:opening_hours", "opening_hours:check_date"));
  return CandidateSchema.parse({
    source: "osm",
    sourceId: element.osmId,
    licence: OSM_LICENCE,
    attribution: OSM_ATTRIBUTION,
    name: name.slice(0, 200),
    categories,
    ...(address === "" ? {} : { address: address.slice(0, 300) }),
    ...(postcode === undefined ? {} : { postcode: postcode.slice(0, 20) }),
    ...(/^[A-Z]{2}$/.test(tags["addr:country"] ?? "") ? { country: tags["addr:country"] } : {}),
    lat: element.lat,
    lon: element.lon,
    ...(phone === undefined ? {} : { phone: (phone.split(";")[0] ?? phone).slice(0, 60) }),
    ...(website === undefined ? {} : { website: (website.split(";")[0] ?? website).slice(0, 2_048) }),
    ...(hours === undefined ? {} : { hours: hours.slice(0, 500) }),
    status: closed ? "permanently_closed" : "unknown",
    ...(brand === undefined ? {} : { brand: brand.slice(0, 120) }),
    diet,
    ...(wheelchair === "yes" || wheelchair === "limited" || wheelchair === "no" ? { wheelchair } : {}),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(hoursCheckedAt === undefined ? {} : { hoursCheckedAt }),
    url: `https://www.openstreetmap.org/${element.osmId}`,
  });
}

/** Whether an element is a chain's: a brand OSM knows by its Wikidata id. */
export function isChain(tags: Readonly<Record<string, string>>): boolean {
  return tags["brand:wikidata"] !== undefined || tags["operator:wikidata"] !== undefined;
}
