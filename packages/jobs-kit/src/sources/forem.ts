import { z } from "zod";

import { JobSourceRecordSchema } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { optionalString, readList, statusOutcome, titleCase } from "./common.js";
import type { JobSourceAdapter, SourceRequest } from "./types.js";

/** Le Forem's job offers on ODWB: Wallonia's offers as open data, keyless; Forem keeps ownership. */
export const foremRecord = JobSourceRecordSchema.parse({
  id: "forem",
  name: "Le Forem (ODWB)",
  countries: ["BE"],
  hosts: ["www.odwb.be"],
  auth: "none",
  kind: "government",
  tenancy: "global",
  removeInactive: false,
  personalUse: "permitted",
  terms: {
    url: "https://www.leforem.be/open-data.html",
    reviewedAt: "2026-10-16",
    licence: "ODWB open data, Forem owns",
    llmUse: "silent",
    cache: { mode: "ttl", days: 30 },
    attribution: "Offres du Forem (ODWB)",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  fields: { salary: "none", remote: "none", posted: true, reqId: true, fullDescription: false },
});

const PAGE = 100;
export const FOREM_MAX_PAGES = 3;

const RecordSchema = z.looseObject({
  numerooffreforem: z.union([z.string(), z.number()]),
  titreoffre: z.string().min(1),
  url: z.string(),
  nomemployeur: optionalString,
  lieuxtravaillocalite: z.array(z.string()).nullish(),
  lieuxtravailregionnuts: z.array(z.string()).nullish(),
  lieuxtravailgeo: z
    .array(z.looseObject({ lat: z.union([z.number(), z.string()]).nullish(), lon: z.union([z.number(), z.string()]).nullish() }).nullable())
    .nullish(),
  typecontrat: optionalString,
  regimetravail: optionalString,
  metier: optionalString,
  secteurs: z.array(z.string()).nullish(),
  referenceexterne: optionalString,
  datedebutdiffusion: optionalString,
  datefindiffusion: optionalString,
});

const coordinate = (value: number | string | null | undefined): number | undefined => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return parsed === null || parsed === undefined || !Number.isFinite(parsed) ? undefined : parsed;
};

function postingOf(item: unknown): RawPosting {
  const offer = RecordSchema.parse(item);
  const geo = offer.lieuxtravailgeo ?? [];
  return {
    source: "forem",
    sourceRef: String(offer.numerooffreforem),
    url: offer.url,
    title: offer.titreoffre,
    company: offer.nomemployeur ?? "",
    places: (offer.lieuxtravaillocalite ?? []).slice(0, 16).map((town, index) => {
      const lat = coordinate(geo[index]?.lat);
      const lon = coordinate(geo[index]?.lon);
      return { country: "BE", city: titleCase(town), ...(lat === undefined || lon === undefined ? {} : { lat, lon }) };
    }),
    // The dataset carries no description: the trade and its sectors stand in.
    descriptionText: [offer.metier, ...(offer.secteurs ?? [])].filter((part): part is string => part !== undefined).join("\n"),
    employmentType: /partiel/i.test(offer.regimetravail ?? "")
      ? "PART_TIME"
      : /déterminée|intérim|remplacement/i.test(offer.typecontrat ?? "") && !/indéterminée/i.test(offer.typecontrat ?? "")
        ? "TEMPORARY"
        : /indépendant|freelance/i.test(offer.typecontrat ?? "")
          ? "CONTRACTOR"
          : /plein/i.test(offer.regimetravail ?? "")
            ? "FULL_TIME"
            : undefined,
    postedAt: offer.datedebutdiffusion === undefined ? undefined : `${offer.datedebutdiffusion}T00:00:00Z`,
    validThrough: offer.datefindiffusion === undefined ? undefined : `${offer.datefindiffusion}T23:59:59Z`,
    reqId: offer.referenceexterne,
    attribution: "Offres du Forem (ODWB)",
  };
}

/** A keyword as an ODSQL string literal, its quotes and backslashes escaped: searched for, never read as a clause. */
const literal = (text: string): string => `"${text.replace(/["\\]/g, (char) => `\\${char}`)}"`;

export const forem: JobSourceAdapter = {
  record: foremRecord,
  search: (query, call) => {
    if (query.countries.length > 0 && !query.countries.includes("BE")) return [];
    const since = new Date(Date.parse(call.now) - query.postedWithinDays * 86_400_000).toISOString().slice(0, 10);
    const where = [`datedebutdiffusion >= date'${since}'`, ...query.keywords.map((keyword) => literal(keyword))].join(" AND ");
    const params = new URLSearchParams({ limit: String(PAGE), offset: "0", where, order_by: "datedebutdiffusion DESC" });
    return [
      {
        url: `https://www.odwb.be/api/explore/v2.1/catalog/datasets/offres-d-emploi-forem/records?${params.toString()}`,
        body: "json",
        purpose: "search",
      },
    ];
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const body = response.body as { readonly results?: unknown; readonly total_count?: unknown } | null;
    const outcome = readList(body?.results, postingOf, "records");
    if (outcome.kind !== "ok") return outcome;
    const url = new URL(request.url);
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const total = typeof body?.total_count === "number" ? body.total_count : 0;
    if (offset + PAGE >= total || offset / PAGE + 1 >= FOREM_MAX_PAGES) return outcome;
    url.searchParams.set("offset", String(offset + PAGE));
    const next: SourceRequest = { ...request, url: url.toString() };
    return { ...outcome, next };
  },
};
