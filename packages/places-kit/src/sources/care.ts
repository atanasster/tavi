import { z } from "zod";

import { PlacesSourceRecordSchema, type PlacesSourceRecord } from "../contracts.js";
import { foldText } from "../normalize.js";
import { statusOutcome } from "./common.js";
import type { Failure, PlacesRequest, SourceResponse } from "./types.js";

/**
 * Health providers for `places.care`: the NPPES NPI Registry (identity, taxonomy, state
 * licence; never an insurance network), CMS's Doctors and Clinicians file
 * (Medicare assignment, telehealth), and payers' Da Vinci Plan-Net provider
 * directories, which CMS-9115-F requires to answer without authentication.
 */

const careRecord = (
  record: Omit<z.input<typeof PlacesSourceRecordSchema>, "kind" | "precisionDecimals" | "fields">,
  kind: "registry" | "payer",
): PlacesSourceRecord => PlacesSourceRecordSchema.parse({ ...record, kind, precisionDecimals: 2, fields: [] });

export const npiRecord = careRecord(
  {
    id: "npi",
    name: "NPPES NPI Registry",
    countries: ["US"],
    hosts: ["npiregistry.cms.hhs.gov"],
    auth: "none",
    terms: {
      url: "https://npiregistry.cms.hhs.gov/api-page",
      reviewedAt: "2026-10-17",
      licence: "public",
      llmUse: "silent",
      cache: { mode: "none" },
      attribution: "CMS NPPES NPI Registry",
      displayRules: ["The NPI Registry is what providers submitted, often years ago; it is not an insurance network"],
      userTriggeredOnly: false,
    },
    budget: { perSecond: 1, perDay: 1_000 },
  },
  "registry",
);

export const cmsDcRecord = careRecord(
  {
    id: "cms-dc",
    name: "CMS Doctors and Clinicians",
    countries: ["US"],
    hosts: ["data.cms.gov"],
    auth: "none",
    terms: {
      url: "https://data.cms.gov/provider-data/dataset/mj5m-pzi6",
      reviewedAt: "2026-10-17",
      licence: "public",
      llmUse: "silent",
      cache: { mode: "none" },
      attribution: "CMS Provider Data Catalog, Doctors and Clinicians",
      displayRules: ["Medicare enrolment, not other insurance"],
      userTriggeredOnly: false,
    },
    budget: { perSecond: 1, perDay: 1_000 },
  },
  "registry",
);

/** One provider as the registry has them: never their mailing address, only where they practise. */
export interface ProviderRecord {
  readonly npi: string;
  readonly kind: "individual" | "organization";
  readonly name: string;
  readonly credential?: string;
  readonly status: string;
  readonly lastUpdated?: string;
  readonly taxonomies: readonly {
    readonly description: string;
    readonly primary: boolean;
    readonly state?: string;
    readonly licence?: string;
  }[];
  readonly location?: {
    readonly address: string;
    readonly city: string;
    readonly state: string;
    readonly postcode: string;
    readonly phone?: string;
  };
  readonly medicare?: { readonly specialty?: string; readonly telehealth?: boolean; readonly acceptsAssignment?: boolean };
}

/** Field values NPPES takes: letters, digits, spaces and a few marks; `*` only at a word's end, as its wildcard. */
const npiText = (value: string): string =>
  value
    .replace(/[^A-Za-z0-9 ,.'&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/** An NPPES query: a specialty in a place, or a number or name. A place filters on the practice LOCATION, never a mailing address. */
export function npiRequest(
  query: {
    readonly specialty?: string;
    readonly postcode?: string;
    readonly city?: string;
    readonly state?: string;
    readonly number?: string;
    readonly firstName?: string;
    readonly lastName?: string;
    readonly organization?: string;
  },
  limit: number,
): PlacesRequest {
  const params = new URLSearchParams({ version: "2.1" });
  if (query.number !== undefined) params.set("number", query.number);
  if (query.specialty !== undefined) params.set("taxonomy_description", npiText(query.specialty));
  if (query.firstName !== undefined) params.set("first_name", npiText(query.firstName));
  if (query.lastName !== undefined) params.set("last_name", npiText(query.lastName));
  if (query.organization !== undefined) params.set("organization_name", npiText(query.organization));
  if (query.postcode !== undefined) params.set("postal_code", query.postcode);
  if (query.city !== undefined) params.set("city", npiText(query.city));
  if (query.state !== undefined) params.set("state", query.state);
  if (query.postcode !== undefined || query.city !== undefined || query.state !== undefined) params.set("address_purpose", "LOCATION");
  params.set("limit", String(Math.min(200, Math.max(1, limit))));
  return { source: npiRecord.id, url: `https://npiregistry.cms.hhs.gov/api/?${params.toString()}`, body: "json" };
}

const NpiAddress = z.looseObject({
  address_purpose: z.string(),
  address_1: z.string().optional(),
  address_2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  telephone_number: z.string().optional(),
});
const NpiResult = z.looseObject({
  number: z.union([z.string(), z.number()]),
  enumeration_type: z.string(),
  basic: z.looseObject({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    organization_name: z.string().optional(),
    credential: z.string().optional(),
    status: z.string().optional(),
    last_updated: z.string().optional(),
  }),
  addresses: z.array(NpiAddress).optional(),
  taxonomies: z
    .array(
      z.looseObject({
        desc: z.string().optional(),
        primary: z.boolean().optional(),
        state: z.string().nullable().optional(),
        license: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
const NpiAnswer = z.looseObject({
  results: z.array(z.unknown()).optional(),
  Errors: z.array(z.looseObject({ description: z.string().optional() })).optional(),
});
const title = (text: string): string => text.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());

export function parseNpi(
  response: SourceResponse,
  now: string,
): { readonly kind: "ok"; readonly providers: ProviderRecord[] } | { readonly kind: "refused"; readonly detail: string } | Failure {
  const status = statusOutcome(response, now);
  if (status !== undefined) return status;
  const answer = NpiAnswer.safeParse(response.body);
  if (!answer.success) return { kind: "drift", detail: "the answer is not NPPES's" };
  // NPPES answers a query it will not run (too broad, a bad field) with Errors, not a status.
  if (answer.data.Errors !== undefined && answer.data.Errors.length > 0)
    return { kind: "refused", detail: (answer.data.Errors[0]?.description ?? "the registry refused the query").slice(0, 200) };
  const providers: ProviderRecord[] = [];
  let dropped = 0;
  for (const item of answer.data.results ?? []) {
    const result = NpiResult.safeParse(item);
    if (!result.success) {
      dropped += 1;
      continue;
    }
    const row = result.data;
    const organization = row.enumeration_type === "NPI-2";
    const name = organization
      ? (row.basic.organization_name ?? "")
      : [row.basic.first_name, row.basic.last_name].filter((part) => part !== undefined).join(" ");
    const location = (row.addresses ?? []).find((address) => address.address_purpose === "LOCATION");
    providers.push({
      npi: String(row.number),
      kind: organization ? "organization" : "individual",
      name: title(name),
      ...(row.basic.credential === undefined || row.basic.credential === "" ? {} : { credential: row.basic.credential }),
      status: row.basic.status === "A" ? "active" : row.basic.status === "D" ? "deactivated" : (row.basic.status ?? "unknown"),
      ...(row.basic.last_updated === undefined ? {} : { lastUpdated: row.basic.last_updated }),
      taxonomies: (row.taxonomies ?? []).flatMap((taxonomy) =>
        taxonomy.desc === undefined
          ? []
          : [
              {
                description: taxonomy.desc,
                primary: taxonomy.primary === true,
                ...(taxonomy.state === null || taxonomy.state === undefined || taxonomy.state === "" ? {} : { state: taxonomy.state }),
                ...(taxonomy.license === null || taxonomy.license === undefined || taxonomy.license === ""
                  ? {}
                  : { licence: taxonomy.license }),
              },
            ],
      ),
      ...(location === undefined
        ? {}
        : {
            location: {
              address: title([location.address_1, location.address_2].filter((part) => part !== undefined && part !== "").join(", ")),
              city: title(location.city ?? ""),
              state: location.state ?? "",
              postcode: (location.postal_code ?? "").slice(0, 5),
              ...(location.telephone_number === undefined ? {} : { phone: location.telephone_number }),
            },
          }),
    });
  }
  const total = (answer.data.results ?? []).length;
  if (total > 0 && dropped * 2 > total)
    return { kind: "drift", detail: `${String(dropped)} of ${String(total)} results did not have the expected shape` };
  return { kind: "ok", providers };
}

/** CMS's Medicare record for some NPIs, by the DKAN datastore's `in` condition. */
export function cmsDcRequest(npis: readonly string[]): PlacesRequest | undefined {
  const wanted = npis.filter((npi) => /^\d{10}$/.test(npi)).slice(0, 50);
  if (wanted.length === 0) return undefined;
  const params = new URLSearchParams();
  params.set("conditions[0][property]", "npi");
  params.set("conditions[0][operator]", "in");
  wanted.forEach((npi, index) => params.set(`conditions[0][value][${String(index)}]`, npi));
  ["npi", "pri_spec", "telehlth", "ind_assgn"].forEach((property, index) => params.set(`properties[${String(index)}]`, property));
  params.set("limit", "200");
  return {
    source: cmsDcRecord.id,
    url: `https://data.cms.gov/provider-data/api/1/datastore/query/mj5m-pzi6/0?${params.toString()}`,
    body: "json",
  };
}

const CmsAnswer = z.looseObject({
  results: z.array(
    z.looseObject({ npi: z.string(), pri_spec: z.string().optional(), telehlth: z.string().optional(), ind_assgn: z.string().optional() }),
  ),
});

export function parseCmsDc(
  response: SourceResponse,
  now: string,
): { readonly kind: "ok"; readonly byNpi: ReadonlyMap<string, NonNullable<ProviderRecord["medicare"]>> } | Failure {
  const status = statusOutcome(response, now);
  if (status !== undefined) return status;
  const answer = CmsAnswer.safeParse(response.body);
  if (!answer.success) return { kind: "drift", detail: "the answer has no results list" };
  const byNpi = new Map<string, NonNullable<ProviderRecord["medicare"]>>();
  for (const row of answer.data.results) {
    if (byNpi.has(row.npi)) continue;
    byNpi.set(row.npi, {
      ...(row.pri_spec === undefined || row.pri_spec === "" ? {} : { specialty: title(row.pri_spec) }),
      ...(row.telehlth === "Y" ? { telehealth: true } : {}),
      ...(row.ind_assgn === "Y" ? { acceptsAssignment: true } : row.ind_assgn === "N" ? { acceptsAssignment: false } : {}),
    });
  }
  return { kind: "ok", byNpi };
}

/** A payer in the curated list (`data/payers.json`): its Plan-Net directory, or only its own directory page. */
export const PayerSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  name: z.string().min(1).max(80),
  /** Its Plan-Net FHIR base when it answers a practitioner by NPI; absent sends the person to `directoryUrl`. */
  fhirBase: z
    .string()
    .url()
    .regex(/^https:\/\//)
    .optional(),
  directoryUrl: z.string().url(),
  reviewedAt: z.iso.date(),
});
export type Payer = z.infer<typeof PayerSchema>;

export function payerRecord(payer: Payer): PlacesSourceRecord | undefined {
  if (payer.fhirBase === undefined) return undefined;
  return careRecord(
    {
      id: `plannet-${payer.id}`,
      name: `${payer.name} provider directory (Plan-Net)`,
      countries: ["US"],
      hosts: [new URL(payer.fhirBase).host],
      auth: "none",
      terms: {
        url: "https://www.cms.gov/priorities/key-initiatives/burden-reduction/interoperability/faqs/provider-directory-api",
        reviewedAt: payer.reviewedAt,
        licence: "public",
        llmUse: "silent",
        cache: { mode: "none" },
        attribution: `${payer.name} provider directory`,
        displayRules: ["A directory listing is what the payer published; confirm with the office and the payer before relying on it"],
        userTriggeredOnly: false,
      },
      budget: { perSecond: 2, perDay: 500 },
    },
    "payer",
  );
}

const FHIR_JSON = { Accept: "application/fhir+json" };
const NPI_SYSTEM = "http://hl7.org/fhir/sid/us-npi";
const NETWORK_REFERENCE = "http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/network-reference";
/** Roles and networks one provider reads at most. */
const ROLES_MAX = 50;

export const planNetRequests = {
  practitioner: (payer: Payer, npi: string): PlacesRequest => ({
    source: `plannet-${payer.id}`,
    url: `${(payer.fhirBase ?? "").replace(/\/+$/, "")}/Practitioner?identifier=${encodeURIComponent(`${NPI_SYSTEM}|${npi}`)}&_count=5`,
    headers: FHIR_JSON,
    body: "json",
  }),
  /** A next page the directory linked, when it is on the payer's own host. */
  next: (payer: Payer, url: string): PlacesRequest | undefined => {
    let link: URL;
    try {
      link = new URL(url);
    } catch {
      return undefined;
    }
    return link.protocol === "https:" && link.host === new URL(payer.fhirBase ?? "https://invalid.invalid").host
      ? { source: `plannet-${payer.id}`, url: link.toString(), headers: FHIR_JSON, body: "json" }
      : undefined;
  },
  roles: (payer: Payer, practitionerId: string): PlacesRequest => ({
    source: `plannet-${payer.id}`,
    url: `${(payer.fhirBase ?? "").replace(/\/+$/, "")}/PractitionerRole?practitioner=${encodeURIComponent(practitionerId)}&_count=${String(ROLES_MAX)}`,
    headers: FHIR_JSON,
    body: "json",
  }),
  networks: (payer: Payer, ids: readonly string[]): PlacesRequest => ({
    source: `plannet-${payer.id}`,
    url: `${(payer.fhirBase ?? "").replace(/\/+$/, "")}/Organization?_id=${ids.map(encodeURIComponent).join(",")}&_count=${String(ROLES_MAX)}`,
    headers: FHIR_JSON,
    body: "json",
  }),
};

const Bundle = z.looseObject({
  entry: z.array(z.looseObject({ resource: z.looseObject({ resourceType: z.string(), id: z.string() }) })).optional(),
  link: z.array(z.looseObject({ relation: z.string(), url: z.string() })).optional(),
});

/** A FHIR search answer's resources of one type and its next page's link, or a failure. */
export function parseBundle(
  response: SourceResponse,
  now: string,
  type: string,
): { readonly kind: "ok"; readonly resources: readonly Record<string, unknown>[]; readonly next?: string } | Failure {
  const status = statusOutcome(response, now);
  if (status !== undefined) return status;
  const bundle = Bundle.safeParse(response.body);
  if (!bundle.success) return { kind: "drift", detail: "the answer is not a FHIR bundle" };
  const next = bundle.data.link?.find((link) => link.relation === "next")?.url;
  return {
    kind: "ok",
    resources: (bundle.data.entry ?? []).map((entry) => entry.resource).filter((resource) => resource.resourceType === type),
    ...(next === undefined ? {} : { next }),
  };
}

/** The network ids a provider's roles name, from Plan-Net's network-reference extension. */
export function roleNetworkIds(roles: readonly Record<string, unknown>[]): string[] {
  const ids = new Set<string>();
  for (const role of roles) {
    const extensions = z
      .array(z.looseObject({ url: z.string(), valueReference: z.looseObject({ reference: z.string() }).optional() }))
      .safeParse(role["extension"]);
    for (const extension of extensions.success ? extensions.data : []) {
      const id =
        extension.url === NETWORK_REFERENCE
          ? /Organization\/([A-Za-z0-9\-.]{1,64})$/.exec(extension.valueReference?.reference ?? "")?.[1]
          : undefined;
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids];
}

/** Plan types and filler: words every plan or network name may carry. */
const PLAN_TYPES = new Set(["hmo", "ppo", "pos", "epo", "pffs", "snp", "medicare", "advantage", "group", "employer"]);
const FILLER = new Set(["plan", "plans", "network", "ntwk", "and", "the", "of", "with"]);
/** Special needs networks for people with Medicaid, a chronic condition or in an institution: matched only when the plan says so. */
const SPECIAL_NEEDS = new Set(["dsnp", "csnp", "isnp"]);

/** A plan or network name's words: its payer's name, filler, contract codes and a glued-on year (`HMO27`) left out. */
function nameWords(name: string, payerName: string): string[] {
  const payer = new Set(foldText(payerName).split(/\s+/));
  return foldText(name.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .split(/[^a-z0-9]+/)
    .map((word) => word.replace(/^([a-z]{2,})\d{2}$/, "$1"))
    .filter((word) => word.length > 1 && !FILLER.has(word) && !payer.has(word) && !/^[a-z]?\d+$/.test(word));
}

/** A plan or network name's distinctive words: its payer's name, plan types, contract codes and numbers left out. */
export function planWords(name: string, payerName: string): string[] {
  return nameWords(name, payerName).filter((word) => !PLAN_TYPES.has(word));
}

/** US states and DC by their two-letter code, for a network whose name says which state it serves. */
const US_STATES: Readonly<Record<string, string>> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};
/** Words of a network for teeth or eyes: never a medical plan's unless the plan says so. */
const DENTAL_VISION = new Set(["dental", "dhmo", "dppo", "vision"]);

/** The states a name names: in full ("Florida"), or by its code in capitals ("FL Medicare"). */
function statesNamed(name: string): string[] {
  const words = ` ${foldText(name.replace(/([a-z])([A-Z])/g, "$1 $2"))} `;
  const codes = new Set(name.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z]+/));
  return (
    Object.entries(US_STATES)
      .filter(([code, state]) => codes.has(code) || words.includes(` ${foldText(state)} `))
      .map(([code]) => code)
      // "West Virginia" holds "Virginia": the longer name is the one named.
      .filter(
        (code, _, all) =>
          !all.some((other) => other !== code && foldText(US_STATES[other] ?? "").endsWith(` ${foldText(US_STATES[code] ?? "")}`)),
      )
  );
}

/** Whether `have` carries every one of `wanted`, a compound written as one word ("GoldPlus") or two ("Gold Plus") on either side. */
function carries(have: readonly string[], wanted: readonly string[]): boolean {
  const known = new Set(have);
  for (let index = 0; index + 1 < have.length; index += 1) known.add(`${have[index] ?? ""}${have[index + 1] ?? ""}`);
  for (let index = 0; index < wanted.length; index += 1) {
    if (known.has(wanted[index] ?? "")) continue;
    if (index + 1 < wanted.length && known.has(`${wanted[index] ?? ""}${wanted[index + 1] ?? ""}`)) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * How a network's name stands to the plan's: `match` when it carries the
 * plan's distinctive words; `possible` when it carries only the plan's type
 * words ("Humana Medicare PPO"), or names a state while the provider's
 * state is not given; `none` otherwise. A special needs, dental or vision
 * network matches only a plan that names it, and a network naming another
 * state than the provider's (`state`, a two-letter code) or the plan's never
 * matches.
 */
export type NetworkMatch =
  | { readonly kind: "match" }
  | { readonly kind: "possible"; readonly why: "type-only"; readonly words: readonly string[] }
  | { readonly kind: "possible"; readonly why: "state"; readonly state: string }
  | { readonly kind: "none" };

export function networkMatch(network: string, plan: string, payerName: string, state?: string): NetworkMatch {
  const distinctive = planWords(plan, payerName);
  const wanted = distinctive.length > 0 ? distinctive : nameWords(plan, payerName);
  const have = nameWords(network, payerName);
  const all = nameWords(plan, payerName);
  if (have.some((word) => SPECIAL_NEEDS.has(word) && !all.includes(word))) return { kind: "none" };
  if (have.some((word) => DENTAL_VISION.has(word)) && !all.some((word) => DENTAL_VISION.has(word))) return { kind: "none" };
  if (wanted.length === 0 || !carries(have, wanted)) return { kind: "none" };
  const planStates = statesNamed(plan);
  const ours = state === undefined ? planStates : [state.toUpperCase(), ...planStates];
  const named = statesNamed(network);
  if (named.length > 0 && !named.some((code) => ours.includes(code))) {
    if (ours.length > 0) return { kind: "none" };
    return { kind: "possible", why: "state", state: US_STATES[named[0] ?? ""] ?? "" };
  }
  return distinctive.length > 0 ? { kind: "match" } : { kind: "possible", why: "type-only", words: wanted };
}

/** Whether a network's name is the plan's (`networkMatch`'s `match`): a weaker match is not. */
export function networkMatchesPlan(network: string, plan: string, payerName: string, state?: string): boolean {
  return networkMatch(network, plan, payerName, state).kind === "match";
}

/** Whether a plan's name has any word to match at all, once the payer's name and filler are left out. */
export function planHasWords(plan: string, payerName: string): boolean {
  return nameWords(plan, payerName).length > 0;
}
