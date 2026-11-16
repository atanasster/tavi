import { checkDomainSourceRecord, DomainSourceRecordSchema } from "@tavi/contracts";
import { KIT_ZOD, objectsOf, type ObjectMode, type Zod } from "@tavi/domain-kit";
import { z } from "zod";

/**
 * The places tools' contracts. A source's record is the shared domain record
 * with the places fields;
 * a place is a cluster of what several sources said, each field with where it
 * came from.
 */

export const PLACES_SOURCE_KINDS = ["poi", "geocode", "registry", "fuel", "ev", "route", "civic", "payer"] as const;
export const PLACE_FIELDS = ["hours", "phone", "website", "rating", "price", "accessibility", "status", "diet"] as const;

export const PlacesSourceRecordSchema = DomainSourceRecordSchema.extend({
  kind: z.enum(PLACES_SOURCE_KINDS),
  /** How coarse a coordinate is when it leaves the worker: 2 is about 1.1 km, 3 about 110 m. */
  precisionDecimals: z.number().int().min(1).max(4),
  fields: z.array(z.enum(PLACE_FIELDS)),
  /** Hours a source is paused after five failures in a row; a day when unset (domain-kit's source health). */
  failurePauseHours: z.number().positive().max(24).optional(),
}).superRefine(checkDomainSourceRecord);
export type PlacesSourceRecord = z.infer<typeof PlacesSourceRecordSchema>;

/**
 * The tools' inputs are drawn with a given Zod (`objectsOf`): strict, the
 * kit's check of each input; open, the tool's input schema the plugin
 * declares with the host's Zod. The descriptions are what the model reads.
 */

/** Where to look: a place's text, or a point and a radius. */
export const areaInput = (zod: Zod, mode: ObjectMode) => {
  const object = objectsOf(zod, mode);
  return zod.union([
    object({
      text: zod.string().min(2).max(200).describe("A city, postcode or district the person named; never a street address for 'near me'"),
    }),
    object({
      lat: zod.number().min(-90).max(90),
      lon: zod.number().min(-180).max(180),
      radiusKm: zod.number().min(0.1).max(50).default(5),
    }),
  ]);
};
export const AreaSchema = areaInput(KIT_ZOD, "strict");
export type Area = z.infer<typeof AreaSchema>;

export const DIETS = ["gluten_free", "vegan", "vegetarian", "halal", "kosher"] as const;

export const placesQueryInput = (zod: Zod, mode: ObjectMode) => {
  const object = objectsOf(zod, mode);
  return object({
    query: zod
      .string()
      .min(2)
      .max(200)
      .describe(
        "What to find, in English whatever language the person wrote in (a business's own name as written): 'independent BMW mechanic', 'tailor', 'gluten-free bakery'",
      ),
    area: areaInput(zod, mode),
    country: zod
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional()
      .describe("ISO country code"),
    filters: object({
      openAt: zod
        .string()
        .datetime({ offset: true })
        .optional()
        .describe(
          "A time with its UTC offset: in a country with one time zone it is read as that zone's local time; elsewhere give the place's own offset",
        ),
      diet: zod.array(zod.enum(DIETS)).max(5).optional(),
      wheelchair: zod.boolean().optional(),
      excludeChains: zod.boolean().optional(),
    }).optional(),
    sources: zod.array(zod.string().min(1).max(40)).max(8).optional(),
    limit: zod.number().int().min(1).max(30).default(10),
  });
};
export const PlacesQuerySchema = placesQueryInput(KIT_ZOD, "strict");
export type PlacesQuery = z.infer<typeof PlacesQuerySchema>;

export const FieldProvenanceSchema = z.strictObject({
  source: z.string().min(1).max(40),
  licence: z.string().min(1).max(60),
  observedAt: z.string().datetime({ offset: true }).optional(),
  /** When the source last checked the fact: OSM `check_date`, FSQ `date_refreshed`, NPI `last_updated`. */
  checkedAt: z.string().datetime({ offset: true }).optional(),
  /** A page the agent read (JSON-LD), for a candidate it relayed. */
  url: z.string().url().optional(),
});
export type FieldProvenance = z.infer<typeof FieldProvenanceSchema>;

export const PLACE_FLAGS = [
  "single_source",
  "phone_conflict",
  "hours_conflict",
  "stale_hours",
  "reported_closed",
  "residential_address",
  "shared_phone",
] as const;
export type PlaceFlag = (typeof PLACE_FLAGS)[number];
export const PLACE_STATUSES = ["open", "temporarily_closed", "permanently_closed", "unknown"] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];

export const PlaceSchema = z.strictObject({
  /** `pl_` and a stable hash of the cluster's first source id. */
  placeId: z.string().max(80),
  name: z.string().max(200),
  categories: z.array(z.string().max(80)).max(8),
  address: z.string().max(300).optional(),
  location: z.strictObject({ lat: z.number(), lon: z.number() }),
  /** E.164. */
  phone: z.string().max(32).optional(),
  website: z.string().url().optional(),
  hours: z
    .strictObject({ spec: z.string().max(500), openNow: z.enum(["yes", "no", "unknown"]), confidence: z.enum(["high", "medium", "low"]) })
    .optional(),
  status: z.enum(PLACE_STATUSES),
  confidence: z.number().min(0).max(1),
  /** Each source's own id: `{ osm: "node/123", overture: "…" }`. */
  ids: z.record(z.string(), z.string()),
  provenance: z.record(z.string(), z.array(FieldProvenanceSchema)),
  flags: z.array(z.enum(PLACE_FLAGS)).max(PLACE_FLAGS.length),
  attribution: z.array(z.string().max(200)).max(6),
});
export type Place = z.infer<typeof PlaceSchema>;

/**
 * One source's account of a place, before resolution: what an adapter reads,
 * or a candidate the agent relayed (JSON-LD it read in the browser).
 */
export const CandidateSchema = z.strictObject({
  source: z.string().min(1).max(40),
  /** The source's own id for it. */
  sourceId: z.string().min(1).max(200),
  licence: z.string().min(1).max(60),
  attribution: z.string().max(200),
  name: z.string().min(1).max(200),
  categories: z.array(z.string().max(80)).max(8).default([]),
  address: z.string().max(300).optional(),
  postcode: z.string().max(20).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  phone: z.string().max(60).optional(),
  website: z.string().max(2_048).optional(),
  /** OSM `opening_hours` syntax, as the source has it. */
  hours: z.string().max(500).optional(),
  status: z.enum(PLACE_STATUSES).default("unknown"),
  /** The source's own existence confidence (Overture's), 0–1. */
  confidence: z.number().min(0).max(1).optional(),
  brand: z.string().max(120).optional(),
  diet: z.array(z.enum(DIETS)).max(5).default([]),
  wheelchair: z.enum(["yes", "limited", "no"]).optional(),
  checkedAt: z.string().datetime({ offset: true }).optional(),
  hoursCheckedAt: z.string().datetime({ offset: true }).optional(),
  url: z.string().url().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;
export type CandidateInput = z.input<typeof CandidateSchema>;

export const FUELS = ["diesel", "e5", "e10", "super98", "lpg", "e85"] as const;
export const CONNECTORS = ["J1772", "CCS1", "CCS2", "NACS", "CHADEMO", "TYPE2"] as const;

export const fuelPricesInput = (zod: Zod, mode: ObjectMode) =>
  objectsOf(
    zod,
    mode,
  )({
    area: areaInput(zod, mode),
    fuel: zod.enum(FUELS),
    /** A text area's geocoder gives it. */
    country: zod
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional()
      .describe("ISO country code; needed with a point"),
    maxAgeHours: zod.number().min(0.5).max(168).default(12).describe("Prices older than this are left out and counted"),
    limit: zod.number().int().min(1).max(30).default(10),
  });
export const FuelPricesInputSchema = fuelPricesInput(KIT_ZOD, "strict");
export type FuelPricesInput = z.infer<typeof FuelPricesInputSchema>;

/** A station: a place, with a price when a source reports one. The US is `regional_average`. */
export const FuelStationSchema = PlaceSchema.extend({
  price: z
    .strictObject({
      amount: z.number(),
      currency: z.string().length(3),
      fuel: z.string(),
      reportedAt: z.string().datetime({ offset: true }),
      source: z.string(),
    })
    .optional(),
  priceKind: z.enum(["station", "regional_average", "none"]),
});
export type FuelStation = z.infer<typeof FuelStationSchema>;

export const routeStopsInput = (zod: Zod, mode: ObjectMode) =>
  objectsOf(
    zod,
    mode,
  )({
    from: zod.string().min(2).max(200).describe("Where the trip starts: a city, postcode or district"),
    to: zod.string().min(2).max(200).describe("Where it ends"),
    via: zod.array(zod.string().min(2).max(200)).max(5).optional(),
    kind: zod.enum(["fuel", "ev"]),
    fuel: zod.enum(FUELS).optional(),
    maxDetourKm: zod.number().min(0.5).max(20).default(3.2).describe("How far off the route a stop may be (default 2 miles)"),
    rangeKm: zod.number().min(50).max(1500).optional().describe("The vehicle's range: stops are spaced within it"),
    stops: zod.number().int().min(1).max(6).default(2),
    connectors: zod.array(zod.enum(CONNECTORS)).max(6).optional(),
  });
export const RouteStopsInputSchema = routeStopsInput(KIT_ZOD, "strict");
export type RouteStopsInput = z.infer<typeof RouteStopsInputSchema>;

/** A stop on a route: its station, how far along the route and how far off it. */
export const RouteStopSchema = FuelStationSchema.extend({
  alongKm: z.number().nonnegative(),
  offRouteKm: z.number().nonnegative(),
});
export type RouteStop = z.infer<typeof RouteStopSchema>;

export const RouteStopsResultSchema = z.strictObject({
  routeGeometry: z.enum(["road_network", "corridor_estimate"]),
  routingSource: z.enum(["ors", "custom", "corridor_estimate"]),
  distanceKm: z.number().nonnegative(),
  stops: z.array(RouteStopSchema).max(30),
  note: z.string().max(500).optional(),
});
export type RouteStopsResult = z.infer<typeof RouteStopsResultSchema>;

export const evChargersInput = (zod: Zod, mode: ObjectMode) =>
  objectsOf(
    zod,
    mode,
  )({
    area: areaInput(zod, mode),
    /** A text area's geocoder gives it. */
    country: zod
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional()
      .describe("ISO country code; needed with a point"),
    connectors: zod.array(zod.enum(CONNECTORS)).max(6).optional(),
    minKw: zod.number().min(1).max(400).optional().describe("The least power a charger must offer, in kW"),
    limit: zod.number().int().min(1).max(30).default(10),
  });
export const EvChargersInputSchema = evChargersInput(KIT_ZOD, "strict");
export type EvChargersInput = z.infer<typeof EvChargersInputSchema>;

/** A charging site: a place, with its connectors, the most power one offers and how many points it has. */
export const ChargerSchema = PlaceSchema.extend({
  connectors: z.array(z.enum(CONNECTORS)).max(CONNECTORS.length),
  maxKw: z.number().positive().optional(),
  points: z.number().int().positive().optional(),
});
export type Charger = z.infer<typeof ChargerSchema>;

export const CIVIC_TOPICS = ["complaints", "permits", "crime"] as const;

export const areaReportInput = (zod: Zod, mode: ObjectMode) => {
  const object = objectsOf(zod, mode);
  return object({
    /** A point's radius is a neighbourhood's: 500 m unless given, at most 2 km. */
    area: zod.union([
      object({ text: zod.string().min(2).max(200).describe("An area, postcode or address the person named for this report") }),
      object({
        lat: zod.number().min(-90).max(90),
        lon: zod.number().min(-180).max(180),
        radiusKm: zod.number().min(0.1).max(2).default(0.5),
      }),
    ]),
    country: zod
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    topics: zod.array(zod.enum(CIVIC_TOPICS)).min(1).max(CIVIC_TOPICS.length).optional(),
    days: zod.number().int().min(1).max(90).default(30).describe("How far back to look"),
  });
};
export const AreaReportInputSchema = areaReportInput(KIT_ZOD, "strict");
export type AreaReportInput = z.infer<typeof AreaReportInputSchema>;

/** A token that reads as a member or subscriber id: six digits in a row, or eight or more letters and digits mixed. */
const MEMBER_ID_SHAPED = /\d{6,}|\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}\b/;
/** Whether a plan's text holds a member id, written plainly or split by dashes and spaces (`123-45-6789`, `W1234 5678`). */
const holdsMemberId = (plan: string): boolean =>
  MEMBER_ID_SHAPED.test(plan) || MEMBER_ID_SHAPED.test(plan.replace(/(?<=\d)[\s-](?=\d)/g, ""));

export const providersInput = (zod: Zod, mode: ObjectMode) =>
  objectsOf(
    zod,
    mode,
  )({
    specialty: zod
      .string()
      .min(2)
      .max(80)
      .describe("A taxonomy as the NPI Registry names it: dentist, family medicine, pediatrics, physical therapist"),
    postcode: zod
      .string()
      .regex(/^\d{5}$/)
      .optional()
      .describe("A US ZIP code"),
    city: zod.string().min(2).max(60).optional(),
    state: zod
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    limit: zod.number().int().min(1).max(30).default(10),
  });
export const ProvidersInputSchema = providersInput(KIT_ZOD, "strict").refine(
  (input) => input.postcode !== undefined || (input.city !== undefined && input.state !== undefined),
  { message: "give a postcode, or a city and its state" },
);
export type ProvidersInput = z.infer<typeof ProvidersInputSchema>;

export const registryCheckInput = (zod: Zod, mode: ObjectMode) =>
  objectsOf(
    zod,
    mode,
  )({
    npi: zod
      .string()
      .regex(/^\d{10}$/)
      .optional(),
    firstName: zod.string().min(1).max(60).optional(),
    lastName: zod.string().min(2).max(60).optional(),
    organization: zod.string().min(2).max(120).optional(),
    state: zod
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  });
export const RegistryCheckInputSchema = registryCheckInput(KIT_ZOD, "strict").refine(
  (input) => input.npi !== undefined || input.lastName !== undefined || input.organization !== undefined,
  { message: "give an NPI, a last name or an organization" },
);
export type RegistryCheckInput = z.infer<typeof RegistryCheckInputSchema>;

export const InNetworkInputSchema = z.strictObject({
  payer: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  plan: z
    .string()
    .min(2)
    .max(120)
    .refine((plan) => !holdsMemberId(plan), { message: "the plan or network name as printed on the card, never the member id" }),
  providers: z
    .array(z.string().regex(/^\d{10}$/))
    .min(1)
    .max(20),
  /** The two-letter US state the providers practise in: a network naming another state is not the plan's. */
  state: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((code) => code.toUpperCase())
    .optional(),
});
export type InNetworkInput = z.infer<typeof InNetworkInputSchema>;

export const AVAILABILITY_MODES = ["read", "assist-only", "stage", "none", "deeplink", "phone"] as const;

/** One way to book a place: a platform and what Tavi may do there, its link, and slots read on its page this task. */
export const AvailabilityRouteSchema = z.strictObject({
  platform: z.string().max(80),
  profileId: z.string().optional(),
  mode: z.enum(AVAILABILITY_MODES),
  url: z.string().url().optional(),
  slots: z
    .array(z.string().datetime({ offset: true }))
    .max(20)
    .optional(),
  slotsReadAt: z.string().datetime({ offset: true }).optional(),
  reason: z.string().max(300),
});
export type AvailabilityRoute = z.infer<typeof AvailabilityRouteSchema>;

export const AvailabilitySchema = z.strictObject({
  placeId: z.string(),
  routes: z.array(AvailabilityRouteSchema).max(6),
});
export type Availability = z.infer<typeof AvailabilitySchema>;

/** What the agent read on a place's pages this task: each page's address, its ReserveAction targets, and slots it showed. */
export const availabilityInput = (zod: Zod, mode: ObjectMode) => {
  const object = objectsOf(zod, mode);
  return object({
    placeId: zod.string().regex(/^pl_[0-9a-f]{16}$/),
    pages: zod
      .array(
        object({
          url: zod.string().url().describe("A page about the place the agent read this task"),
          reserveUrls: zod
            .array(zod.string().url())
            .max(4)
            .optional()
            .describe("ReserveAction targets from its JSON-LD (browser.structured)"),
          slots: zod
            .array(zod.string().datetime({ offset: true }))
            .max(20)
            .optional()
            .describe("Free slots the page showed, with their UTC offset"),
          readAt: zod.string().datetime({ offset: true }).optional(),
        }),
      )
      .max(6)
      .default([]),
  });
};
export const AvailabilityInputSchema = availabilityInput(KIT_ZOD, "strict");
export type AvailabilityInput = z.infer<typeof AvailabilityInputSchema>;

/** What the agent saw of a booking it staged: the stage page, and any later evidence that it went through. */
export const bookingStatusInput = (zod: Zod, mode: ObjectMode) => {
  const object = objectsOf(zod, mode);
  return object({
    place: zod.string().min(1).max(200).describe("The place's name"),
    staged: object({
      url: zod.string().url().describe("The booking page Tavi filled and stopped on"),
      slot: zod.string().datetime({ offset: true }).optional(),
      partySize: zod.number().int().min(1).max(30).optional(),
    }),
    /** Its address, title and headings. */
    observed: object({
      url: zod.string().url(),
      title: zod.string().max(300).optional(),
      headings: zod.array(zod.string().max(300)).max(20).default([]),
    })
      .optional()
      .describe("A page observed after the person pressed the final step"),
    /** One the person received. */
    email: object({
      from: zod.string().max(320),
      subject: zod.string().max(300),
      receivedAt: zod.string().datetime({ offset: true }).optional(),
    })
      .optional()
      .describe("A confirmation email's sender and subject"),
  });
};
export const BookingStatusInputSchema = bookingStatusInput(KIT_ZOD, "strict");
export type BookingStatusInput = z.infer<typeof BookingStatusInputSchema>;

export const CalendarHoldSchema = z.strictObject({
  title: z.string().max(200),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  location: z.string().max(300).optional(),
  description: z.string().max(500),
});
export type CalendarHold = z.infer<typeof CalendarHoldSchema>;

export const BookingStatusSchema = z.strictObject({
  status: z.enum(["booked", "staged", "not_staged"]),
  evidence: z.string().max(300).optional(),
  /** What the agent may say. */
  say: z.string().max(300),
  /** A calendar hold to propose, only for a staged booking with a slot; never called a booking. */
  calendarHold: CalendarHoldSchema.optional(),
});
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const WATCH_CADENCES = { hourly: 1, "every-6h": 6, daily: 24 } as const;

/** The refusal of an area on a watch that has one: it is set when the watch is added. */
const AREA_IS_SET = "a watch's area is set when it is added: remove this watch and add one for the new area";

/**
 * A fuel-price watch, `watch`: add, change, pause, resume or remove one. One
 * object per op, each refusing a field it does not take, so an
 * update cannot carry an area or a country.
 */
export const fuelWatchInput = (zod: Zod, mode: ObjectMode) => {
  const watchId = zod.string().regex(/^fw_[0-9a-f]{12}$/);
  const fuel = zod.enum(FUELS);
  const threshold = zod.number().positive().max(100).describe("Tell me at or under this price per litre");
  const currency = zod.string().regex(/^[A-Z]{3}$/);
  const cadence = zod.enum(["hourly", "every-6h", "daily"]);
  // An area or a country on a watch that has one gets the reason, not only "unrecognized key".
  const areaRefused = {
    error: (issue: { readonly code?: string; readonly keys?: readonly string[] }) =>
      issue.code === "unrecognized_keys" && issue.keys?.some((key) => key === "area" || key === "country") ? AREA_IS_SET : undefined,
  };
  const byId = <Op extends "pause" | "resume" | "remove">(op: Op, label: string) =>
    zod.strictObject({ op: zod.literal(op).describe(label), watchId }, areaRefused);
  return zod.discriminatedUnion("op", [
    zod.strictObject({
      op: zod.literal("add").describe("watch an area's prices"),
      area: areaInput(zod, mode),
      country: zod
        .string()
        .regex(/^[A-Z]{2}$/)
        .optional(),
      fuel,
      threshold,
      currency,
      cadence: cadence.optional(),
    }),
    zod.strictObject(
      {
        op: zod.literal("update").describe("change its fuel, threshold, currency or cadence; the area stays"),
        watchId,
        fuel: fuel.optional(),
        threshold: threshold.optional(),
        currency: currency.optional(),
        cadence: cadence.optional(),
      },
      areaRefused,
    ),
    byId("pause", "stop checking"),
    byId("resume", "check again"),
    byId("remove", "delete it"),
  ]);
};
export const FuelWatchInputSchema = fuelWatchInput(KIT_ZOD, "strict");
export type FuelWatchInput = z.infer<typeof FuelWatchInputSchema>;

/** A watch as stored: its area as geocoded when it was added. */
export interface FuelWatch {
  readonly watchId: string;
  readonly area: {
    readonly lat: number;
    readonly lon: number;
    readonly radiusKm: number;
    readonly country: string;
    readonly label?: string;
  };
  readonly fuel: (typeof FUELS)[number];
  readonly threshold: number;
  readonly currency: string;
  readonly cadenceHours: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastRunAt?: string;
  readonly lastOutcome?: string;
  readonly nextRunAt: string;
}

/** A station a watch found at or under its threshold. */
export interface FuelHit {
  readonly watchId: string;
  readonly stationKey: string;
  readonly price: number;
  readonly currency: string;
  readonly station: string;
  readonly reportedAt: string;
  readonly firstSeen: string;
}
