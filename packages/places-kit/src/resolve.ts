import { createHash } from "node:crypto";

import { definedOnly } from "@tavi/contracts/util";

import {
  CandidateSchema,
  type Candidate,
  type CandidateInput,
  type FieldProvenance,
  type Place,
  type PlaceFlag,
  type PlaceStatus,
} from "./contracts.js";
import { distanceKm } from "./geo.js";
import { formatWeek, hoursConfidence, openAt, parseOpeningHours, placeLocalTime, type HoursReading } from "./hours.js";
import { nameTokens, normalizePhone, PO_BOX, siteKey } from "./normalize.js";

/**
 * Entity resolution:
 * candidates from several sources become places, each field with the
 * sources that said it. Pairs near each other, or sharing a phone or a
 * website, are scored on name, phone, distance, website and category; a
 * score of 0.80 merges, 0.60 merges with low confidence, below stays apart.
 */

export const MERGE_SCORE = 0.8;
export const WEAK_MERGE_SCORE = 0.6;
/** How near two candidates must be to be compared, unless a phone or website ties them. */
export const PAIR_RADIUS_KM = 0.15;
const LARGE_VENUE_RADIUS_KM = 0.25;
/** Categories whose one place spans a site: a hospital's entrances, a park's gates. */
const LARGE_VENUES =
  /\b(?:hospital|university|college|campus|park|mall|shopping centre|shopping center|airport|stadium|zoo|museum|station|cemetery)\b/i;
/** Storefront trades where one number behind many listings is a known lead-generation pattern. */
const LEAD_GEN = /\b(?:locksmith|garage door|towing|tow truck|roadside|pest control|water damage)\b/i;
/** Three or more listings with different names sharing one number in those trades is `shared_phone`. */
const SHARED_PHONE_MIN = 3;

const WEIGHTS = { name: 0.35, phone: 0.25, distance: 0.2, website: 0.1, category: 0.1 } as const;

/** Jaro-Winkler similarity, 0–1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j += 1) {
      if (bMatched[j] === true || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (aMatched[i] !== true) continue;
    while (bMatched[k] !== true) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** A name's two comparable forms: its words in order, and sorted. */
interface NameForms {
  readonly inOrder: string;
  readonly sorted: string;
}
const nameForms = (name: string): NameForms => {
  const tokens = nameTokens(name);
  return { inOrder: tokens.join(" "), sorted: [...tokens].sort().join(" ") };
};
const formsSimilarity = (a: NameForms, b: NameForms): number =>
  Math.max(jaroWinkler(a.inOrder, b.inOrder), jaroWinkler(a.sorted, b.sorted));

/** Two names' likeness: their words compared in order and sorted, the better of the two, so word order does not matter. */
export function nameSimilarity(a: string, b: string): number {
  return formsSimilarity(nameForms(a), nameForms(b));
}

/** A candidate with its comparable forms worked out once. */
interface Prepared {
  readonly candidate: Candidate;
  /** `source:sourceId`: the tie-break that makes resolution independent of input order. */
  readonly key: string;
  readonly name: NameForms;
  readonly phone?: string;
  readonly site?: string;
  readonly categories: ReadonlySet<string>;
  readonly large: boolean;
}

function prepare(candidate: Candidate): Prepared {
  const phone = candidate.phone === undefined ? undefined : normalizePhone(candidate.phone, candidate.country);
  const site = candidate.website === undefined ? undefined : siteKey(candidate.website);
  return {
    candidate,
    key: `${candidate.source}:${candidate.sourceId}`,
    name: nameForms(candidate.name),
    ...(phone === undefined ? {} : { phone }),
    ...(site === undefined ? {} : { site }),
    categories: categoryWords(new Set(candidate.categories)),
    large: candidate.categories.some((category) => LARGE_VENUES.test(category)),
  };
}

/** Category words that say nothing about the trade. */
const GENERIC_CATEGORY_WORDS = new Set([
  "car",
  "auto",
  "shop",
  "store",
  "service",
  "services",
  "center",
  "centre",
  "house",
  "place",
  "spot",
  "local",
  "business",
  "and",
  "the",
]);
/** Words that name one trade, as OSM's tags and Overture's taxonomy say it differently. */
const CATEGORY_SYNONYMS: Readonly<Record<string, string>> = {
  diner: "restaurant",
  bistro: "restaurant",
  eatery: "restaurant",
  brasserie: "restaurant",
  food: "restaurant",
  coffee: "cafe",
  gas: "fuel",
  petrol: "fuel",
  filling: "fuel",
  doctor: "doctors",
  clinic: "doctors",
  medical: "doctors",
  physician: "doctors",
  dental: "dentist",
  tire: "tyre",
  hairdresser: "hair",
  barber: "hair",
  salon: "hair",
  veterinarian: "veterinary",
  vet: "veterinary",
};
/** A category's words in one vocabulary: generic ones out, synonyms mapped, each cut to five letters so "physiotherapist" meets "physiotherapy". */
function categoryWords(categories: ReadonlySet<string>): Set<string> {
  // JSON-LD's types are camelCase ("AutoRepair"): split them into words first.
  const words = [...categories].flatMap((category) =>
    category
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z]+/),
  );
  return new Set(
    words
      .filter((word) => word.length > 2 && !GENERIC_CATEGORY_WORDS.has(word))
      .map((word) => (CATEGORY_SYNONYMS[word] ?? word).slice(0, 5)),
  );
}

/** Whether two candidates' trade words can be one place: either says nothing, or they share one. */
function categoriesCompatible(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size === 0 || right.size === 0) return true;
  return [...right].some((word) => left.has(word));
}

/**
 * How likely two candidates are one place, 0–1: a weighted mean over the
 * signals both have. Name, distance and category are always there; a phone
 * or website counts only when both give one, and then it can lift or sink
 * the score.
 */
export function pairScore(a: Prepared, b: Prepared): number {
  const km = distanceKm(a.candidate, b.candidate);
  const radius = a.large || b.large ? LARGE_VENUE_RADIUS_KM : PAIR_RADIUS_KM;
  // Close is the strong signal: 0 m scores 1, the radius about 0.02.
  const distance = Math.exp((-4 * km) / radius);
  let total =
    WEIGHTS.name * formsSimilarity(a.name, b.name) +
    WEIGHTS.distance * distance +
    WEIGHTS.category * (categoriesCompatible(a.categories, b.categories) ? 1 : 0);
  let weight = WEIGHTS.name + WEIGHTS.distance + WEIGHTS.category;
  if (a.phone !== undefined && b.phone !== undefined) {
    total += WEIGHTS.phone * (a.phone === b.phone ? 1 : 0);
    weight += WEIGHTS.phone;
  }
  if (a.site !== undefined && b.site !== undefined) {
    total += WEIGHTS.website * (a.site === b.site ? 1 : 0);
    weight += WEIGHTS.website;
  }
  return total / weight;
}

/** Candidates this far apart are never one place, whatever ties them: one hotline behind many listings is the lead-generation pattern, not a merge. */
export const MERGE_MAX_KM = 1;

/** Below this name likeness two candidates are two places, unless a phone or a website ties them. */
export const NAME_GATE = 0.7;

/**
 * Whether two candidates may be one place, and so worth scoring: within
 * `MERGE_MAX_KM`, and near each other or tied by a phone or a website. Two
 * trades that cannot be one (a dentist and a doctor sharing a building), or
 * names too unlike, stay apart unless a phone ties them.
 */
function comparable(a: Prepared, b: Prepared): boolean {
  const km = distanceKm(a.candidate, b.candidate);
  if (km > MERGE_MAX_KM) return false;
  const samePhone = a.phone !== undefined && a.phone === b.phone;
  const sameSite = a.site !== undefined && a.site === b.site;
  if (!samePhone && !categoriesCompatible(a.categories, b.categories)) return false;
  if (!samePhone && !sameSite && formsSimilarity(a.name, b.name) < NAME_GATE) return false;
  return samePhone || sameSite || km <= (a.large || b.large ? LARGE_VENUE_RADIUS_KM : PAIR_RADIUS_KM);
}

/** A cluster's id: a hash of its first source id in sort order. The store keeps a place's earlier id when any of its source ids already has one. */
export function placeIdOf(sourceIds: readonly string[]): string {
  const first = [...sourceIds].sort()[0] ?? "";
  return `pl_${createHash("sha256").update(first).digest("hex").slice(0, 16)}`;
}

export interface ResolveOptions {
  readonly now: string;
  /** Sources in the order their fields win: earlier first. Unlisted sources come after, in their own order. */
  readonly priority?: readonly string[];
  /** `filters.openAt`: whether each place is open then. */
  readonly openAt?: string | undefined;
}

const SEVERITY: Readonly<Record<PlaceStatus, number>> = { unknown: 0, open: 1, temporarily_closed: 2, permanently_closed: 3 };

function merge(members: readonly Prepared[], weak: boolean, options: ResolveOptions): Place {
  const rank = (source: string): number => {
    const index = options.priority?.indexOf(source) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const ordered = [...members].sort(
    (a, b) => rank(a.candidate.source) - rank(b.candidate.source) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const lead = ordered[0] as Prepared;
  const provenance: Record<string, FieldProvenance[]> = {};
  const note = (field: string, candidate: Candidate, checkedAt?: string) => {
    const entry: FieldProvenance = {
      source: candidate.source,
      licence: candidate.licence,
      ...(checkedAt === undefined ? {} : { checkedAt }),
      ...(candidate.url === undefined ? {} : { url: candidate.url }),
    };
    (provenance[field] ??= []).push(entry);
  };
  const first = <T>(read: (member: Prepared) => T | undefined, field: string): T | undefined => {
    let found: T | undefined;
    for (const member of ordered) {
      const value = read(member);
      if (value === undefined) continue;
      note(
        field,
        member.candidate,
        field === "hours" ? (member.candidate.hoursCheckedAt ?? member.candidate.checkedAt) : member.candidate.checkedAt,
      );
      found ??= value;
    }
    return found;
  };
  const name = first((member) => member.candidate.name, "name") as string;
  first(() => true, "location");
  const address = first((member) => member.candidate.address, "address");
  const phone = first((member) => member.phone, "phone");
  const website = first((member) => {
    const url = member.candidate.website;
    if (url === undefined) return undefined;
    try {
      return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).toString();
    } catch {
      return undefined;
    }
  }, "website");
  const flags = new Set<PlaceFlag>();
  const sources = new Set(members.map((member) => member.candidate.source));
  if (sources.size === 1) flags.add("single_source");
  if (new Set(members.map((member) => member.phone).filter((value) => value !== undefined)).size > 1) flags.add("phone_conflict");
  // Hours: every source's reading, compared.
  const readings: (HoursReading & { readonly candidate: Candidate })[] = [];
  for (const member of ordered) {
    const week = member.candidate.hours === undefined ? undefined : parseOpeningHours(member.candidate.hours);
    if (week === undefined) continue;
    readings.push({ week, checkedAt: member.candidate.hoursCheckedAt ?? member.candidate.checkedAt, candidate: member.candidate });
    note("hours", member.candidate, member.candidate.hoursCheckedAt ?? member.candidate.checkedAt);
  }
  let hours: Place["hours"];
  if (readings.length > 0) {
    const judged = hoursConfidence(readings, options.now);
    if (judged.conflict) flags.add("hours_conflict");
    if (judged.stale) flags.add("stale_hours");
    const week = (readings[0] as HoursReading).week;
    const open =
      options.openAt === undefined || judged.confidence !== "high"
        ? undefined
        : openAt(week, placeLocalTime(options.openAt, members.find((member) => member.candidate.country !== undefined)?.candidate.country));
    hours = { spec: formatWeek(week), openNow: open === undefined ? "unknown" : open ? "yes" : "no", confidence: judged.confidence };
  }
  // Status: the gravest any source says; a closure one source reports is flagged either way.
  const statuses = members.map((member) => member.candidate.status);
  const gravest = statuses.reduce<PlaceStatus>((worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst), "unknown");
  if (statuses.some((status) => status === "permanently_closed" || status === "temporarily_closed")) flags.add("reported_closed");
  if (address !== undefined && PO_BOX.test(address)) flags.add("residential_address");
  // Confidence: the source's own where it gives one, more for each independent source, less for a single one or a weak merge.
  const base = Math.max(0.5, ...members.map((member) => member.candidate.confidence ?? 0));
  let confidence = Math.min(1, base + 0.15 * (sources.size - 1));
  if (sources.size === 1) confidence *= 0.8;
  if (weak) confidence *= 0.85;
  if (gravest === "permanently_closed") confidence = 0;
  const ids: Record<string, string> = {};
  for (const member of ordered) ids[member.candidate.source] ??= member.candidate.sourceId;
  const categories = [...new Set(ordered.flatMap((member) => member.candidate.categories))].slice(0, 8);
  return {
    placeId: placeIdOf(members.map((member) => member.key)),
    name,
    categories,
    ...(address === undefined ? {} : { address }),
    location: { lat: lead.candidate.lat, lon: lead.candidate.lon },
    ...definedOnly({ phone, website, hours }),
    status: gravest,
    confidence: Math.round(confidence * 100) / 100,
    ids,
    provenance,
    flags: [...flags],
    attribution: [...new Set(ordered.map((member) => member.candidate.attribution).filter((text) => text !== ""))].slice(0, 6),
  };
}

/**
 * Places from candidates: each pair worth comparing scored, merged at
 * `WEAK_MERGE_SCORE` or more while the cluster stays within `MERGE_MAX_KM`,
 * every cluster one place. Candidates are sorted by source and id first, so
 * the input order does not change the result.
 */
export function resolvePlaces(inputs: readonly CandidateInput[], options: ResolveOptions): Place[] {
  return resolveClusters(inputs, options).map((cluster) => cluster.place);
}

/** Each resolved place with every candidate merged into it: what a caller needs to combine fields `Place` keeps one of. */
export function resolveClusters(
  inputs: readonly CandidateInput[],
  options: ResolveOptions,
): { readonly place: Place; readonly members: readonly Candidate[] }[] {
  // Sorted by key, so the input order changes nothing.
  const prepared = inputs
    .map((input) => prepare(CandidateSchema.parse(input)))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const parent = prepared.map((_, index) => index);
  const members = new Map<number, number[]>(prepared.map((_, index) => [index, [index]]));
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    parent[index] = root;
    return root;
  };
  const weakEdge = new Set<number>();
  const edges: { readonly i: number; readonly j: number; readonly score: number }[] = [];
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const a = prepared[i] as Prepared;
      const b = prepared[j] as Prepared;
      if (!comparable(a, b)) continue;
      const score = pairScore(a, b);
      if (score >= WEAK_MERGE_SCORE) edges.push({ i, j, score });
    }
  }
  // Strongest first, so a weak edge never decides a cluster a strong one would; ties in index order.
  edges.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  for (const edge of edges) {
    const left = find(edge.i);
    const right = find(edge.j);
    if (left === right) continue;
    const leftMembers = members.get(left) ?? [];
    const rightMembers = members.get(right) ?? [];
    // `MERGE_MAX_KM` holds across the whole cluster, not only for each pair: a chain of listings never spans a town.
    if (
      leftMembers.some((l) =>
        rightMembers.some((r) => distanceKm((prepared[l] as Prepared).candidate, (prepared[r] as Prepared).candidate) > MERGE_MAX_KM),
      )
    )
      continue;
    parent[right] = left;
    members.set(left, [...leftMembers, ...rightMembers]);
    members.delete(right);
    if (edge.score < MERGE_SCORE || weakEdge.has(right)) weakEdge.add(left);
  }
  const clusters = new Map<number, Prepared[]>();
  prepared.forEach((member, index) => {
    const root = find(index);
    clusters.set(root, [...(clusters.get(root) ?? []), member]);
  });
  // One number behind listings with several names in a lead-generation trade, counted before merging so a merge cannot hide it.
  const namesByPhone = new Map<string, Set<string>>();
  for (const member of prepared) {
    if (member.phone === undefined || !member.candidate.categories.some((category) => LEAD_GEN.test(category))) continue;
    namesByPhone.set(member.phone, (namesByPhone.get(member.phone) ?? new Set()).add(member.name.sorted));
  }
  const sharedPhones = new Set([...namesByPhone.entries()].filter(([, names]) => names.size >= SHARED_PHONE_MIN).map(([phone]) => phone));
  return [...clusters.entries()]
    .map(([root, cluster]) => {
      const merged = merge(cluster, weakEdge.has(root), options);
      const place = cluster.some((member) => member.phone !== undefined && sharedPhones.has(member.phone))
        ? { ...merged, flags: [...merged.flags, "shared_phone" as const] }
        : merged;
      return { place, members: cluster.map((member) => member.candidate) };
    })
    .sort((a, b) => b.place.confidence - a.place.confidence || a.place.name.localeCompare(b.place.name));
}
