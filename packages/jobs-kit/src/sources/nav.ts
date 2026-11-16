import { z } from "zod";

import { JobSourceRecordSchema } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { optionalString, readList, statusOutcome, titleCase } from "./common.js";
import type { JobSourceAdapter, SourceOutcome, SourceRequest } from "./types.js";

/**
 * NAV's job vacancy feed: Norway's ads as a feed
 * read forward from `If-Modified-Since`, with the person's feed token as a
 * bearer. Republishing is allowed; an ad the feed marks `INACTIVE` is removed
 * at once; a posting links back to its source.
 */
export const navRecord = JobSourceRecordSchema.parse({
  id: "nav",
  name: "NAV (arbeidsplassen.no)",
  countries: ["NO"],
  hosts: ["pam-stilling-feed.nav.no"],
  auth: "key-header",
  credential: ["navToken"],
  kind: "government",
  tenancy: "global",
  removeInactive: true,
  personalUse: "permitted",
  terms: {
    url: "https://navikt.github.io/pam-stilling-feed/",
    reviewedAt: "2026-10-16",
    licence: "NAV job feed terms",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "Ads from arbeidsplassen.no (NAV)",
    displayRules: ["Link each posting back to its source"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 1_000 },
  fields: { salary: "none", remote: "none", posted: true, reqId: false, fullDescription: true },
});

const HOST = "https://pam-stilling-feed.nav.no";
/** How far back a first read starts, when there is no cursor yet: about 3,000 ads a day change. */
const FIRST_READ_HOURS = 24;
/** A cursor is a feed page's own path; on the feed's last page, with the page's ETag after a space. */
const FEED_PAGE = /^\/api\/v1\/feed\/[0-9a-f-]{36}$/;
const ETAG = /^(W\/)?"[\x21\x23-\x7e]{1,200}"$/;
const cursorOf = (cursor: string | undefined): { readonly path: string; readonly etag?: string } | undefined => {
  const [path = "", etag, ...rest] = (cursor ?? "").split(" ");
  if (!FEED_PAGE.test(path) || rest.length > 0 || (etag !== undefined && !ETAG.test(etag))) return undefined;
  return { path, ...(etag === undefined ? {} : { etag }) };
};

const ItemSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  date_modified: optionalString,
  _feed_entry: z.looseObject({ status: optionalString, businessName: optionalString, municipal: optionalString }).nullish(),
});
const EntrySchema = z.looseObject({
  uuid: z.string().min(1),
  status: optionalString,
  ad_content: z
    .looseObject({
      title: z.string().min(1),
      description: optionalString,
      published: optionalString,
      expires: optionalString,
      applicationUrl: optionalString,
      link: optionalString,
      engagementtype: optionalString,
      extent: optionalString,
      employer: z.looseObject({ name: optionalString }).nullish(),
      workLocations: z.array(z.looseObject({ city: optionalString, county: optionalString, municipal: optionalString })).nullish(),
    })
    .nullish(),
});

const adUrl = (uuid: string): string => `https://arbeidsplassen.nav.no/stillinger/stilling/${uuid}`;
const city = (name: string | undefined): string | undefined => (name === undefined ? undefined : titleCase(name));

function itemOf(item: unknown): RawPosting {
  const parsed = ItemSchema.parse(item);
  const entry = parsed._feed_entry;
  return {
    source: "nav",
    sourceRef: parsed.id,
    url: adUrl(parsed.id),
    title: parsed.title,
    company: entry?.businessName ?? "",
    places: [{ country: "NO", ...(city(entry?.municipal) === undefined ? {} : { city: city(entry?.municipal) }) }],
    descriptionText: "",
    postedAt: parsed.date_modified,
    attribution: "Ads from arbeidsplassen.no (NAV)",
  };
}

function entryOf(item: unknown): RawPosting | undefined {
  const parsed = EntrySchema.parse(item);
  const ad = parsed.ad_content;
  if (parsed.status !== "ACTIVE" || ad === null || ad === undefined) return undefined;
  const locations = ad.workLocations ?? [];
  const applyUrl = ad.applicationUrl;
  return {
    source: "nav",
    sourceRef: parsed.uuid,
    url: ad.link ?? adUrl(parsed.uuid),
    ...(applyUrl !== undefined && /^https?:\/\/\S+$/.test(applyUrl) ? { applyUrl } : {}),
    title: ad.title,
    company: ad.employer?.name ?? "",
    places: (locations.length === 0 ? [{ city: undefined, county: undefined, municipal: undefined }] : locations).map((place) => ({
      country: "NO",
      ...(city(place.city ?? place.municipal) === undefined ? {} : { city: city(place.city ?? place.municipal) }),
      ...(place.county === undefined ? {} : { region: city(place.county) }),
    })),
    descriptionHtml: ad.description ?? "",
    employmentType: /deltid/i.test(ad.extent ?? "")
      ? "PART_TIME"
      : /frilans|selvstendig/i.test(ad.engagementtype ?? "")
        ? "CONTRACTOR"
        : /vikariat|engasjement|sesong/i.test(ad.engagementtype ?? "")
          ? "TEMPORARY"
          : /heltid/i.test(ad.extent ?? "")
            ? "FULL_TIME"
            : undefined,
    postedAt: ad.published,
    validThrough: ad.expires,
    attribution: "Ads from arbeidsplassen.no (NAV)",
  };
}

export const nav: JobSourceAdapter = {
  record: navRecord,
  // Read forward from where the last read ended (its cursor); a first read starts a day back, so it reads the newest ads.
  search: (query, call) => {
    const token = call.credential("navToken");
    if (token === undefined || (query.countries.length > 0 && !query.countries.includes("NO"))) return [];
    // The last page read again: unchanged since its ETag, the feed answers 304 with nothing.
    const cursor = cursorOf(call.cursor);
    if (cursor !== undefined)
      return [
        {
          url: `${HOST}${cursor.path}`,
          headers: { Authorization: `Bearer ${token}`, ...(cursor.etag === undefined ? {} : { "If-None-Match": cursor.etag }) },
          body: "json",
          purpose: "search",
        },
      ];
    const hours = Math.min(FIRST_READ_HOURS, query.postedWithinDays * 24);
    const since = new Date(Date.parse(call.now) - hours * 3_600_000).toUTCString();
    return [
      {
        url: `${HOST}/api/v1/feed`,
        headers: { Authorization: `Bearer ${token}`, "If-Modified-Since": since },
        body: "json",
        purpose: "search",
      },
    ];
  },
  // An ad's own page on arbeidsplassen.no names its id.
  refFromUrl: (url) => /^https:\/\/arbeidsplassen\.nav\.no\/stillinger\/stilling\/([0-9a-f-]{36})(?:[/?#]|$)/.exec(url)?.[1],
  detail: (ref, call) => {
    const token = call.credential("navToken");
    return token === undefined || !/^[0-9a-f-]{36}$/.test(ref)
      ? undefined
      : { url: `${HOST}/api/v1/feedentry/${ref}`, headers: { Authorization: `Bearer ${token}` }, body: "json", purpose: "detail" };
  },
  parse: (response, request, call): SourceOutcome => {
    // Nothing changed since the date asked: no postings, not a failure.
    if (response.status === 304) return { kind: "ok", postings: [], dropped: 0 };
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    if (request.purpose === "detail") {
      const entry = response.body as { readonly status?: unknown; readonly uuid?: unknown } | null;
      if (entry?.status === "INACTIVE" && typeof entry.uuid === "string")
        return { kind: "ok", postings: [], dropped: 0, removed: [entry.uuid] };
      return readList([response.body], entryOf, "entries");
    }
    const body = response.body as { readonly items?: unknown; readonly next_url?: unknown } | null;
    const items = Array.isArray(body?.items) ? body.items : undefined;
    const statusOf = (item: unknown): unknown =>
      (item as { readonly _feed_entry?: { readonly status?: unknown } } | null)?._feed_entry?.status;
    // An inactive ad is gone at once (the feed's terms); only the active ones are postings.
    const removed = (items ?? [])
      .filter((item: unknown) => statusOf(item) === "INACTIVE")
      .map((item: unknown) => String((item as { readonly id?: unknown }).id));
    const outcome = readList(items?.filter((item: unknown) => statusOf(item) === "ACTIVE") ?? body?.items, itemOf, "items");
    if (outcome.kind !== "ok") return outcome;
    // The next page is also where the next read starts: the cursor the engine keeps.
    const nextPath = typeof body?.next_url === "string" && FEED_PAGE.test(body.next_url) ? body.next_url : undefined;
    // On the last page, the read starts there next time, asking only for what changed since its ETag.
    const page = new URL(request.url).pathname;
    const lastPage =
      nextPath === undefined && FEED_PAGE.test(page) && typeof response.etag === "string" && ETAG.test(response.etag)
        ? `${page} ${response.etag}`
        : undefined;
    const cursor = nextPath ?? lastPage;
    const kept = { ...outcome, ...(removed.length === 0 ? {} : { removed }), ...(cursor === undefined ? {} : { cursor }) };
    if (nextPath === undefined || (items?.length ?? 0) === 0) return kept;
    const next: SourceRequest = {
      url: `${HOST}${nextPath}`,
      headers: { Authorization: request.headers?.["Authorization"] ?? "" },
      body: "json",
      purpose: "search",
    };
    return { ...kept, next };
  },
};
