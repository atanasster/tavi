import { foldText, latinText } from "../normalize.js";

/**
 * What a query's words ask for, in OSM's tags: "independent BMW
 * mechanic" is `shop=car_repair` with the words "independent" and "bmw" left
 * for names. A query no category matches is searched by name alone.
 */
interface Category {
  readonly label: string;
  /** Matched against the folded query as whole words. */
  readonly words: RegExp;
  /**
   * Matched against a source's own category names (Overture's taxonomy,
   * underscores as spaces), when they say it more narrowly than the query
   * words would: "garage" in a query is car repair, a "garage door service" is not.
   */
  readonly sourceWords?: RegExp;
  readonly tags: readonly (readonly [string, string])[];
}

/** Most specific first: a phrase one category takes ("dental clinic") is gone before a broader one ("clinic") is tried. */
const CATEGORIES: readonly Category[] = [
  {
    label: "dentist",
    words: /\b(?:dentists?|dental(?: clinics?)?|orthodontists?)\b/,
    sourceWords: /\b(?:dentist|dental clinic|general dentistry|cosmetic dentistry|pediatric dentistry|orthodontist)\b/,
    tags: [
      ["amenity", "dentist"],
      ["healthcare", "dentist"],
    ],
  },
  { label: "vet", words: /\b(?:vets?|veterinar(?:y|ians?)|animal (?:clinics?|hospitals?))\b/, tags: [["amenity", "veterinary"]] },
  {
    label: "kennel",
    words: /\b(?:kennels?|dog boarding|pet boarding|cattery|catteries|dog daycare)\b/,
    tags: [["amenity", "animal_boarding"]],
  },
  { label: "groomer", words: /\b(?:groomers?|dog grooming|pet grooming)\b/, tags: [["shop", "pet_grooming"]] },
  { label: "beauty", words: /\b(?:beauty(?: salons?)?|nail salons?|nails|spas?)\b/, tags: [["shop", "beauty"]] },
  {
    label: "physiotherapist",
    words: /\b(?:physio(?:therap(?:y|ists?))?|physical therap(?:y|ists?))\b/,
    tags: [["healthcare", "physiotherapist"]],
  },
  { label: "bike shop", words: /\b(?:bike shops?|bicycle shops?|bike repairs?|cycle shops?)\b/, tags: [["shop", "bicycle"]] },
  {
    label: "car repair",
    words: /\b(?:(?:car |auto |vehicle )?mechanics?|car repairs?|auto(?:motive)? repairs?|car garages?|garages?|auto shops?|body shops?)\b/,
    sourceWords: /\b(?:car repair|automotive repair|auto repair|auto body shop|tire dealer and repair|diy auto shop)\b/,
    tags: [
      ["shop", "car_repair"],
      ["craft", "car_repair"],
    ],
  },
  { label: "tyres", words: /\b(?:tyres?|tires?)(?: shops?)?\b/, tags: [["shop", "tyres"]] },
  {
    label: "tailor",
    sourceWords: /\b(?:tailor|sewing and alterations|dressmaker|clothes repair)\b/,
    words: /\b(?:tailors?|alterations?|seamstress(?:es)?|dressmakers?|clothes repairs?)\b/,
    tags: [
      ["craft", "tailor"],
      ["shop", "tailor"],
      ["craft", "dressmaker"],
    ],
  },
  { label: "bakery", words: /\b(?:bakery|bakeries|boulangeries?|baker)\b/, tags: [["shop", "bakery"]] },
  { label: "cafe", words: /\b(?:cafes?|coffee(?: shops?)?)\b/, tags: [["amenity", "cafe"]] },
  {
    label: "restaurant",
    words: /\b(?:restaurants?|bistros?|diners?|brasseries?|places to eat|dinner|lunch)\b/,
    tags: [["amenity", "restaurant"]],
  },
  {
    label: "doctor",
    sourceWords: /\b(?:doctors?|primary care or general clinic|family practice|general practitioner|urgent care clinic|clinic)\b/,
    words: /\b(?:doctors?|gps?|general practitioners?|clinics?|physicians?)\b/,
    tags: [
      ["amenity", "doctors"],
      ["healthcare", "doctor"],
      ["amenity", "clinic"],
    ],
  },
  {
    label: "pharmacy",
    words: /\b(?:pharmac(?:y|ies)|chemists?|drugstores?|apotheke)\b/,
    tags: [
      ["amenity", "pharmacy"],
      ["healthcare", "pharmacy"],
    ],
  },
  { label: "hairdresser", words: /\b(?:hairdressers?|hair salons?|salons?|barbers?|hairdressing)\b/, tags: [["shop", "hairdresser"]] },
  { label: "fuel", words: /\b(?:gas stations?|petrol stations?|fuel(?: stations?)?|filling stations?)\b/, tags: [["amenity", "fuel"]] },
  { label: "charging", words: /\b(?:ev chargers?|charging stations?|chargers?|ev charging)\b/, tags: [["amenity", "charging_station"]] },
  {
    label: "laundry",
    words: /\b(?:laundr(?:y|ies)|laundromats?|dry cleaners?|dry cleaning)\b/,
    tags: [
      ["shop", "laundry"],
      ["shop", "dry_cleaning"],
    ],
  },
  {
    label: "museum",
    words: /\b(?:museums?|galler(?:y|ies))\b/,
    tags: [
      ["tourism", "museum"],
      ["tourism", "gallery"],
    ],
  },
  {
    label: "hotel",
    words: /\b(?:hotels?|hostels?|guest houses?)\b/,
    tags: [
      ["tourism", "hotel"],
      ["tourism", "hostel"],
      ["tourism", "guest_house"],
    ],
  },
  {
    label: "supermarket",
    words: /\b(?:supermarkets?|grocer(?:y|ies)|grocers?)\b/,
    tags: [
      ["shop", "supermarket"],
      ["shop", "greengrocer"],
    ],
  },
  {
    label: "locksmith",
    words: /\b(?:locksmiths?)\b/,
    tags: [
      ["shop", "locksmith"],
      ["craft", "locksmith"],
    ],
  },
  { label: "electrician", words: /\b(?:electricians?)\b/, tags: [["craft", "electrician"]] },
  { label: "plumber", words: /\b(?:plumbers?|plumbing)\b/, tags: [["craft", "plumber"]] },
];

/** Words that ask for a kind of place, not a name: "near me", "good", "best". */
const FILLER = new Set([
  "independent",
  "specialist",
  "specialists",
  "family",
  "owned",
  "run",
  "friendly",
  "reputable",
  "reliable",
  "trusted",
  "affordable",
  "near",
  "me",
  "nearby",
  "around",
  "in",
  "the",
  "a",
  "an",
  "best",
  "good",
  "top",
  "rated",
  "cheap",
  "open",
  "now",
  "local",
  "places",
  "place",
  "find",
  "with",
  "for",
  "and",
  "or",
  "of",
  "certified",
  "dedicated",
  "100",
]);

export interface QueryPlan {
  readonly label?: string;
  readonly tags: readonly (readonly [string, string])[];
  /** What is left for names: "independent", "bmw". */
  readonly words: readonly string[];
  /** The same words as the query wrote them, marks kept ("двойка", "café"), for a source that matches names itself. */
  readonly nameWords: readonly string[];
  /** The categories' patterns for a source's own category names (Overture's `sewing_and_alterations`). */
  readonly patterns: readonly RegExp[];
}

/** A query's category and its remaining words. */
export function planQuery(query: string): QueryPlan {
  let folded = foldText(query);
  const matched: Category[] = [];
  for (const category of CATEGORIES) {
    if (!category.words.test(folded)) continue;
    matched.push(category);
    folded = folded.replace(new RegExp(category.words.source, "g"), " ");
  }
  const words = folded.split(" ").filter((word) => word.length >= 2 && !FILLER.has(word));
  const kept = new Set(words);
  const written = query
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => kept.has(foldText(word)));
  const nameWords = [...new Set(written)];
  return {
    ...(matched[0] === undefined ? {} : { label: matched.map((category) => category.label).join(", ") }),
    tags: matched.flatMap((category) => category.tags),
    words,
    nameWords,
    patterns: matched.map((category) => category.sourceWords ?? category.words),
  };
}

/**
 * Whether a place a source names with its own categories answers a plan: a
 * category's words in its categories, or, for a plan with none, every
 * remaining word in its name.
 */
export function planMatches(plan: QueryPlan, place: { readonly name: string; readonly categories: readonly string[] }): boolean {
  if (plan.patterns.length > 0) {
    const categories = foldText(place.categories.join(" ").replace(/_/g, " "));
    return plan.patterns.some((pattern) => pattern.test(categories));
  }
  const name = latinText(place.name);
  // The words as written: folded ones have lost "й", which Latin letters write "y".
  const words = plan.nameWords.length > 0 ? plan.nameWords : plan.words;
  return words.length > 0 && words.every((word) => name.includes(latinText(word)));
}
