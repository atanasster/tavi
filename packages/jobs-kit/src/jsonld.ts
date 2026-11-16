import { decodeEntities } from "@tavi/contracts";
import { isRecord } from "@tavi/contracts/util";

import type { Place, Salary } from "./contracts.js";
import type { RawPosting } from "./normalize.js";
import { countryCode, parsePlace } from "./places.js";

/**
 * A schema.org JobPosting, as a page's JSON-LD states it (Workday's job pages,
 * `browser.structured` and `ingest`). Each script block is read
 * on its own, so one malformed block costs only itself; `@graph` and arrays
 * are walked. Every value is the page's: untrusted, and read by shape.
 */
const SCRIPT_OPEN = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>/gi;
const SCRIPT_CLOSE = /<\/script/gi;
/** The most JSON-LD blocks one page is read for. */
const BLOCKS_MAX = 20;

/** Every JobPosting object a page's JSON-LD holds. */
export function jobPostingsInHtml(html: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  SCRIPT_OPEN.lastIndex = 0;
  for (let open = SCRIPT_OPEN.exec(html), blocks = 0; open !== null && blocks < BLOCKS_MAX; open = SCRIPT_OPEN.exec(html), blocks += 1) {
    const start = open.index + open[0].length;
    SCRIPT_CLOSE.lastIndex = start;
    const end = SCRIPT_CLOSE.exec(html)?.index ?? -1;
    if (end === -1) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(html.slice(start, end));
    } catch {
      continue;
    }
    collect(parsed, found, 0);
    SCRIPT_OPEN.lastIndex = end;
  }
  return found;
}

function collect(value: unknown, into: Record<string, unknown>[], depth: number): void {
  if (depth > 4 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) collect(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) into.push(record);
  if (Array.isArray(record["@graph"])) collect(record["@graph"], into, depth + 1);
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : typeof value === "number" ? String(value) : undefined;
const object = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

const UNITS: Readonly<Record<string, Salary["period"]>> = { HOUR: "HOUR", DAY: "DAY", WEEK: "WEEK", MONTH: "MONTH", YEAR: "YEAR" };

function salaryOf(base: unknown): Salary | undefined {
  const salary = object(base);
  const currency = text(salary?.["currency"])?.toUpperCase();
  const value = object(salary?.["value"]);
  const unit = text(value?.["unitText"] ?? salary?.["unitText"])?.toUpperCase();
  const number = (raw: unknown): number | undefined => {
    const parsed = typeof raw === "string" ? Number(raw.replace(/[, ]/g, "")) : raw;
    return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const min = number(value?.["minValue"]) ?? number(value?.["value"]) ?? number(salary?.["value"]);
  const max = number(value?.["maxValue"]);
  const period = unit === undefined ? undefined : UNITS[unit];
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency) || period === undefined || (min === undefined && max === undefined))
    return undefined;
  return {
    currency,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined || (min !== undefined && max < min) ? {} : { max }),
    period,
    basis: "unknown",
    origin: "stated",
  };
}

/** A country's code from its name, with Workday's "United States of America". */
const countryOf = (name: string): string | undefined => countryCode(name) ?? (/^united states of america$/i.test(name) ? "US" : undefined);

function placeOf(location: unknown): Place | undefined {
  const address = object(object(location)?.["address"]) ?? object(location);
  if (address === undefined) return undefined;
  const country = text(address["addressCountry"]) ?? text(object(address["addressCountry"])?.["name"]);
  const locality = text(address["addressLocality"]);
  const region = text(address["addressRegion"]);
  const code = country === undefined ? undefined : countryOf(country);
  // Workday writes "US, CA, Santa Clara" as the locality.
  const parsed =
    locality === undefined
      ? undefined
      : parsePlace(
          locality
            .split(",")
            .map((part) => part.trim())
            .reverse()
            .join(", "),
        );
  return {
    ...(code === undefined ? (parsed?.country === undefined ? {} : { country: parsed.country }) : { country: code }),
    ...(region === undefined ? (parsed?.region === undefined ? {} : { region: parsed.region }) : { region: region.slice(0, 80) }),
    ...(parsed?.city === undefined ? {} : { city: parsed.city }),
  };
}

/** One JobPosting object as a raw posting of `source`, at `url`; undefined when it names no title. */
export function rawPostingFromJsonLd(
  record: Record<string, unknown>,
  source: string,
  sourceRef: string,
  url: string,
  extra: { readonly tenant?: string; readonly attribution: (company: string) => string },
): RawPosting | undefined {
  const title = text(record["title"]);
  if (title === undefined) return undefined;
  const organization = object(record["hiringOrganization"]);
  const remote = text(record["jobLocationType"])?.toUpperCase() === "TELECOMMUTE";
  const regions = list(record["applicantLocationRequirements"])
    .map((place) => text(object(place)?.["name"]) ?? text(place))
    .filter((name): name is string => name !== undefined)
    .map(countryOf)
    .filter((code): code is string => code !== undefined);
  const places = list(record["jobLocation"])
    .slice(0, 16)
    .map(placeOf)
    .filter((place): place is Place => place !== undefined && Object.keys(place).length > 0);
  const salary = salaryOf(record["baseSalary"]);
  const description = text(record["description"]);
  const company = decodeEntities(text(organization?.["name"]) ?? "");
  return {
    source,
    sourceRef,
    ...(extra.tenant === undefined ? {} : { tenant: extra.tenant }),
    url,
    title: decodeEntities(title),
    company,
    places,
    ...(remote ? { workplace: "remote" as const, remoteRegions: regions } : {}),
    // JSON-LD descriptions are HTML, sometimes escaped once more.
    descriptionHtml: description === undefined ? "" : /&lt;\/?[a-z]/i.test(description) ? decodeEntities(description) : description,
    ...(salary === undefined ? {} : { salary }),
    employmentType: list(record["employmentType"])
      .map(text)
      .find((type) => type !== undefined),
    postedAt: text(record["datePosted"]),
    validThrough: text(record["validThrough"]),
    reqId: text(object(record["identifier"])?.["value"]) ?? text(record["identifier"]),
    attribution: extra.attribution(company),
  };
}
