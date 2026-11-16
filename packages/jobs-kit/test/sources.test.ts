import { readFileSync } from "node:fs";
import { join } from "node:path";

import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import {
  J1_SOURCES,
  adzuna,
  ashby,
  greenhouse,
  himalayas,
  lever,
  normalizePosting,
  personio,
  postingAnswersQuery,
  recruitee,
  retryAfterMs,
  smartrecruiters,
  type JobSourceAdapter,
  type SourceCall,
  type SourceRequest,
  type SourceResponse,
} from "../src/index.js";

const NOW = "2026-10-16T12:00:00.000Z";
const fixture = (path: string): unknown => JSON.parse(readFileSync(join(domainFixtures("jobs"), path), "utf8"));
const text = (path: string): string => readFileSync(join(domainFixtures("jobs"), path), "utf8");
const call = (credentials: Record<string, string> = {}): SourceCall => ({
  credential: (key) => credentials[key],
  userAgent: "Tavi-jobs/test (+ops@example.com)",
  now: NOW,
});
const query = { keywords: [], countries: [], postedWithinDays: 60 };
const ok = (body: unknown): SourceResponse => ({ status: 200, body });

/** The first request of an adapter's search, for a board. */
function firstRequest(
  adapter: JobSourceAdapter,
  tenant?: string,
  credentials?: Record<string, string>,
  countries: string[] = [],
): SourceRequest {
  const [request] = adapter.search({ ...query, countries }, call(credentials), tenant);
  if (request === undefined) throw new Error(`${adapter.record.id} made no request`);
  return request;
}

/** An adapter's postings, normalised, as a snapshot reads them. */
function normalised(adapter: JobSourceAdapter, request: SourceRequest, body: unknown) {
  const outcome = adapter.parse(ok(body), request, call());
  if (outcome.kind !== "ok") throw new Error(`${adapter.record.id}: ${outcome.kind}`);
  return outcome.postings.map((raw) => normalizePosting(raw, NOW).posting);
}

describe("each board adapter on its recorded answer", () => {
  it.each([
    ["greenhouse", greenhouse, firstRequest(greenhouse, "gitlab"), fixture("greenhouse/board.json")],
    ["lever", lever, firstRequest(lever, "leverdemo"), fixture("lever/postings.json")],
    ["ashby", ashby, firstRequest(ashby, "ashby"), fixture("ashby/board.json")],
    ["smartrecruiters", smartrecruiters, firstRequest(smartrecruiters, "ServiceNow"), fixture("smartrecruiters/list.json")],
    ["recruitee", recruitee, firstRequest(recruitee, "bunq"), fixture("recruitee/offers.json")],
    ["personio", personio, firstRequest(personio, "personio"), text("personio/positions.xml")],
    ["adzuna", adzuna, firstRequest(adzuna, undefined, { adzunaAppId: "id", adzunaAppKey: "key" }, ["DE"]), fixture("adzuna/search.json")],
    ["himalayas", himalayas, firstRequest(himalayas), fixture("himalayas/search.json")],
  ] as const)("%s matches its snapshot", (_name, adapter, request, body) => {
    const postings = normalised(adapter, request, body);
    expect(postings.length).toBeGreaterThan(0);
    expect(postings).toMatchSnapshot();
  });

  it("reads one posting's detail: Greenhouse's pay in cents, SmartRecruiters' description", () => {
    const pay = greenhouse.detail?.("figma/5426468004", call());
    expect(pay?.url).toBe("https://boards-api.greenhouse.io/v1/boards/figma/jobs/5426468004?pay_transparency=true");
    const [posting] = normalised(greenhouse, pay as SourceRequest, fixture("greenhouse/job-pay.json"));
    expect(posting?.salary).toEqual({ currency: "USD", min: 165_000, max: 190_000, period: "YEAR", basis: "gross", origin: "stated" });
    const detail = smartrecruiters.detail?.("ServiceNow/744000156052424", call());
    const [described] = normalised(smartrecruiters, detail as SourceRequest, fixture("smartrecruiters/posting.json"));
    expect(described?.excerpt.length).toBeGreaterThan(200);
  });
});

describe("salary as each source states it", () => {
  it("reads Lever's interval, Ashby's salary component and Adzuna's predicted flag", () => {
    expect(normalised(lever, firstRequest(lever, "leverdemo"), fixture("lever/postings.json"))[0]?.salary).toMatchObject({
      currency: "USD",
      min: 85_000,
      max: 175_000,
      period: "YEAR",
      origin: "stated",
    });
    expect(normalised(ashby, firstRequest(ashby, "ashby"), fixture("ashby/board.json"))[0]?.salary).toMatchObject({
      currency: "EUR",
      min: 110_000,
      max: 185_000,
      period: "YEAR",
      origin: "stated",
    });
    const [stated, predicted] = normalised(
      adzuna,
      firstRequest(adzuna, undefined, { adzunaAppId: "id", adzunaAppKey: "key" }, ["DE"]),
      fixture("adzuna/search.json"),
    );
    expect(stated?.salary).toMatchObject({ currency: "EUR", min: 80_000, origin: "stated" });
    expect(predicted?.salary).toMatchObject({ origin: "predicted" });
  });

  it("maps Lever's other intervals", () => {
    const [posting] = fixture("lever/postings.json") as Record<string, unknown>[];
    const hourly = { ...posting, salaryRange: { min: 40, max: 55, currency: "USD", interval: "per-hour-wage" } };
    expect(normalised(lever, firstRequest(lever, "leverdemo"), [hourly])[0]?.salary).toMatchObject({ min: 40, max: 55, period: "HOUR" });
  });
});

describe("what every adapter does with an answer that is not a list of postings", () => {
  const requests: readonly (readonly [JobSourceAdapter, SourceRequest])[] = [
    [greenhouse, firstRequest(greenhouse, "acme")],
    [lever, firstRequest(lever, "acme")],
    [ashby, firstRequest(ashby, "acme")],
    [smartrecruiters, firstRequest(smartrecruiters, "Acme")],
    [recruitee, firstRequest(recruitee, "acme")],
    [personio, firstRequest(personio, "acme")],
    [adzuna, firstRequest(adzuna, undefined, { adzunaAppId: "id", adzunaAppKey: "key" }, ["GB"])],
    [himalayas, firstRequest(himalayas)],
  ];

  it.each(requests.map(([adapter, request]) => [adapter.record.id, adapter, request] as const))(
    "%s: 404, 429 with Retry-After, and a changed shape",
    (_id, adapter, request) => {
      expect(adapter.parse({ status: 404, body: null }, request, call())).toEqual({ kind: "not-found" });
      expect(adapter.parse({ status: 429, retryAfter: "120", body: null }, request, call())).toEqual({
        kind: "rate-limited",
        retryAfterMs: 120_000,
      });
      expect(adapter.parse({ status: 503, body: null }, request, call())).toEqual({ kind: "failed", status: 503 });
      const drifted = adapter.parse(
        ok(request.body === "text" ? "<workzag-jobs-v2/>" : { results: "moved", jobs: 7, content: {}, offers: null }),
        request,
        call(),
      );
      expect(drifted.kind).toBe("drift");
    },
  );

  it("reads an empty board as no postings, not as drift", () => {
    expect(greenhouse.parse(ok({ jobs: [], meta: { total: 0 } }), firstRequest(greenhouse, "acme"), call())).toEqual({
      kind: "ok",
      postings: [],
      dropped: 0,
    });
    expect(lever.parse(ok([]), firstRequest(lever, "acme"), call())).toEqual({ kind: "ok", postings: [], dropped: 0 });
    // SmartRecruiters answers an unknown company with 200 and nothing.
    expect(
      smartrecruiters.parse(ok({ offset: 0, limit: 100, totalFound: 0, content: [] }), firstRequest(smartrecruiters, "Nobody"), call()),
    ).toEqual({ kind: "ok", postings: [], dropped: 0 });
    expect(personio.parse(ok('<?xml version="1.0"?><workzag-jobs></workzag-jobs>'), firstRequest(personio, "acme"), call())).toEqual({
      kind: "ok",
      postings: [],
      dropped: 0,
    });
    expect(ashby.parse(ok({ apiVersion: "1", jobs: [] }), firstRequest(ashby, "acme"), call())).toEqual({
      kind: "ok",
      postings: [],
      dropped: 0,
    });
    expect(recruitee.parse(ok({ offers: [] }), firstRequest(recruitee, "acme"), call())).toEqual({ kind: "ok", postings: [], dropped: 0 });
    // An empty search is the last page: no next request.
    expect(
      adzuna.parse(
        ok({ results: [], count: 0 }),
        firstRequest(adzuna, undefined, { adzunaAppId: "id", adzunaAppKey: "key" }, ["GB"]),
        call(),
      ),
    ).toEqual({ kind: "ok", postings: [], dropped: 0 });
    expect(himalayas.parse(ok({ jobs: [], totalCount: 0 }), firstRequest(himalayas), call())).toEqual({
      kind: "ok",
      postings: [],
      dropped: 0,
    });
  });

  it("reads Personio's page-not-found page as an unknown company", () => {
    expect(personio.parse(ok("<!DOCTYPE html><html><title>Page Not Found</title></html>"), firstRequest(personio, "acme"), call())).toEqual(
      { kind: "not-found" },
    );
  });

  it("drops one malformed record of many, counting it, and calls more than half drift", () => {
    const [good] = (fixture("greenhouse/board.json") as { jobs: unknown[] }).jobs;
    expect(greenhouse.parse(ok({ jobs: [good, good, { id: "x" }] }), firstRequest(greenhouse, "acme"), call())).toMatchObject({
      kind: "ok",
      dropped: 1,
    });
    expect(greenhouse.parse(ok({ jobs: [good, { id: "x" }, { id: "y" }] }), firstRequest(greenhouse, "acme"), call()).kind).toBe("drift");
  });

  it("reads Retry-After as seconds or a date, bounded", () => {
    expect(retryAfterMs("30", NOW)).toBe(30_000);
    expect(retryAfterMs(new Date(Date.parse(NOW) + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(retryAfterMs(undefined, NOW)).toBe(60_000);
    expect(retryAfterMs("999999", NOW)).toBe(24 * 3_600_000);
  });
});

describe("paging and pay periods", () => {
  it("pages SmartRecruiters by offset to its cap, and stops at the board's total", () => {
    const request = firstRequest(smartrecruiters, "ServiceNow");
    const first = smartrecruiters.parse(
      ok({ ...(fixture("smartrecruiters/list.json") as object), offset: 0, limit: 100, totalFound: 369 }),
      request,
      call(),
    );
    expect(first.kind === "ok" ? new URL(first.next?.url ?? "").searchParams.get("offset") : undefined).toBe("100");
    const last = smartrecruiters.parse(ok({ content: [], offset: 300, limit: 100, totalFound: 369 }), request, call());
    expect(last.kind === "ok" ? last.next : "none").toBeUndefined();
    const capped = smartrecruiters.parse(ok({ content: [], offset: 400, limit: 100, totalFound: 5_000 }), request, call());
    expect(capped.kind === "ok" ? capped.next : "none").toBeUndefined();
  });

  it("pages Adzuna to its cap while the count says there are more", () => {
    const request = firstRequest(adzuna, undefined, { adzunaAppId: "id", adzunaAppKey: "key" }, ["DE"]);
    const more = adzuna.parse(ok({ ...(fixture("adzuna/search.json") as object), count: 400 }), request, call());
    expect(more.kind === "ok" ? new URL(more.next?.url ?? "").pathname : undefined).toBe("/v1/api/jobs/de/search/2");
    const done = adzuna.parse(ok(fixture("adzuna/search.json")), request, call());
    expect(done.kind === "ok" ? done.next : "none").toBeUndefined();
  });

  it("reads a Greenhouse pay range's period from its title", () => {
    const job = fixture("greenhouse/job-pay.json") as Record<string, unknown>;
    const hourly = { ...job, pay_input_ranges: [{ min_cents: 2_500, max_cents: 3_500, currency_type: "USD", title: "Hourly Pay Range" }] };
    expect(normalised(greenhouse, greenhouse.detail?.("figma/5426468004", call()) as SourceRequest, hourly)[0]?.salary).toMatchObject({
      min: 25,
      max: 35,
      period: "HOUR",
    });
  });
});

describe("the requests each adapter makes", () => {
  it("names the board in the path or host, refusing a board name that is not one", () => {
    expect(firstRequest(lever, "eu:acme").url).toBe("https://api.eu.lever.co/v0/postings/acme?mode=json");
    expect(firstRequest(personio, "com:acme").url).toBe("https://acme.jobs.personio.com/xml?language=en");
    expect(firstRequest(recruitee, "acme").url).toBe("https://acme.recruitee.com/api/offers/");
    for (const adapter of [greenhouse, lever, ashby, smartrecruiters, recruitee, personio]) {
      expect(adapter.search(query, call(), "../admin")).toEqual([]);
      expect(adapter.search(query, call(), undefined)).toEqual([]);
    }
    expect(recruitee.search(query, call(), "evil.example.com#")).toEqual([]);
    expect(lever.search(query, call(), "us:acme")).toEqual([]);
  });

  it("asks Adzuna only with the person's key and only for a country it covers, one request a country", () => {
    expect(adzuna.search({ ...query, countries: ["DE"] }, call())).toEqual([]);
    const requests = adzuna.search(
      { ...query, keywords: ["backend engineer"], countries: ["DE", "JP", "GB"] },
      call({ adzunaAppId: "id", adzunaAppKey: "key" }),
    );
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/v1/api/jobs/de/search/1", "/v1/api/jobs/gb/search/1"]);
    expect(new URL(requests[0]?.url ?? "").searchParams.get("what")).toBe("backend engineer");
  });

  it("sends Himalayas' key as a bearer header only when the person set one", () => {
    expect(firstRequest(himalayas).headers).toBeUndefined();
    expect(firstRequest(himalayas, undefined, { himalayasKey: "k" }).headers).toEqual({ Authorization: "Bearer k" });
  });

  it("keeps every source's hosts its own", () => {
    for (const adapter of J1_SOURCES) {
      for (const request of adapter.search(
        { ...query, keywords: ["x"], countries: ["GB"] },
        call({ adzunaAppId: "i", adzunaAppKey: "k" }),
        "acme",
      )) {
        const host = new URL(request.url).hostname;
        expect(
          adapter.record.hosts.some((pattern) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern)),
        ).toBe(true);
      }
    }
  });
});

describe("a query on an employer's board", () => {
  const posting = (title: string, extra: Record<string, unknown> = {}) =>
    normalizePosting(
      {
        source: "greenhouse",
        sourceRef: title,
        url: "https://boards.greenhouse.io/acme/jobs/1",
        title,
        company: "Acme",
        locations: ["Berlin, Germany"],
        descriptionText: "We use Go and Postgres.",
        postedAt: "2026-10-10T00:00:00Z",
        attribution: "Acme via Greenhouse",
        ...extra,
      },
      NOW,
    );

  it("keeps a posting whose title or words answer a keyword, as words", () => {
    const { posting: go, description } = posting("Backend Engineer");
    expect(postingAnswersQuery(go, description, { ...query, keywords: ["backend"] }, NOW)).toBe(true);
    expect(postingAnswersQuery(go, description, { ...query, keywords: ["go postgres"] }, NOW)).toBe(true);
    expect(postingAnswersQuery(go, description, { ...query, keywords: ["golang"] }, NOW)).toBe(false);
    const google = posting("Google Ads Specialist", { descriptionText: "Ads." });
    expect(postingAnswersQuery(google.posting, google.description, { ...query, keywords: ["go"] }, NOW)).toBe(false);
  });

  it("keeps a country's postings, a remote one open to it, and one with no place at all", () => {
    const berlin = posting("Engineer");
    expect(postingAnswersQuery(berlin.posting, berlin.description, { ...query, countries: ["DE"] }, NOW)).toBe(true);
    expect(postingAnswersQuery(berlin.posting, berlin.description, { ...query, countries: ["US"] }, NOW)).toBe(false);
    const remote = posting("Engineer", { locations: ["Remote, Worldwide"] });
    expect(postingAnswersQuery(remote.posting, remote.description, { ...query, countries: ["US"] }, NOW)).toBe(true);
    const emea = posting("Engineer", { locations: ["Remote (EMEA)"] });
    expect(postingAnswersQuery(emea.posting, emea.description, { ...query, countries: ["DE"] }, NOW)).toBe(true);
    expect(postingAnswersQuery(emea.posting, emea.description, { ...query, countries: ["US"] }, NOW)).toBe(false);
    const nowhere = posting("Engineer", { locations: [] });
    expect(postingAnswersQuery(nowhere.posting, nowhere.description, { ...query, countries: ["US"] }, NOW)).toBe(true);
  });

  it("leaves out a posting older than the query asks", () => {
    const old = posting("Engineer", { postedAt: "2026-08-01T00:00:00Z" });
    expect(postingAnswersQuery(old.posting, old.description, { ...query, postedWithinDays: 14 }, NOW)).toBe(false);
  });
});
