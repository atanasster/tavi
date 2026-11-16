import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { BUDGETS_TABLE_SQL, createBudgetLedger } from "@tavi/domain-kit";
import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import {
  DICE_DISCLOSURE,
  J2_SOURCES,
  JobProfileInputSchema,
  breezy,
  dice,
  mcpToolCall,
  snagajob,
  type McpHttpAnswer,
  type McpPost,
  convertCurrency,
  forem,
  jobtech,
  matchPosting,
  nav,
  normalizePosting,
  parseEcbRates,
  reed,
  robotsAllows,
  usajobs,
  workable,
  workday,
  type JobSourceAdapter,
  type SourceCall,
  type SourceRequest,
} from "../src/index.js";

const NOW = "2026-10-16T12:00:00.000Z";
const fixture = (path: string): unknown => JSON.parse(readFileSync(join(domainFixtures("jobs"), path), "utf8"));
const text = (path: string): string => readFileSync(join(domainFixtures("jobs"), path), "utf8");
const call = (credentials: Record<string, string> = {}, contact?: string): SourceCall => ({
  credential: (key) => credentials[key],
  userAgent: "Tavi-jobs/test",
  now: NOW,
  ...(contact === undefined ? {} : { contact }),
});
const query = { keywords: [], countries: [], postedWithinDays: 14 };
const first = (adapter: JobSourceAdapter, tenant?: string, credentials?: Record<string, string>, contact?: string): SourceRequest => {
  const [request] = adapter.search(query, call(credentials, contact), tenant);
  if (request === undefined) throw new Error(`${adapter.record.id} made no request`);
  return request;
};
const ok = (body: unknown) => ({ status: 200, body });
function normalised(adapter: JobSourceAdapter, request: SourceRequest, body: unknown) {
  const outcome = adapter.parse(ok(body), request, call());
  if (outcome.kind !== "ok") throw new Error(`${adapter.record.id}: ${outcome.kind}`);
  return outcome.postings.map((raw) => normalizePosting(raw, NOW).posting);
}

describe("each further adapter on its recorded or documented answer", () => {
  it.each([
    ["usajobs", usajobs, first(usajobs, undefined, { usajobsKey: "k" }, "ops@example.com"), fixture("usajobs/search.json")],
    ["jobtech", jobtech, first(jobtech), fixture("jobtech/search.json")],
    ["nav", nav, first(nav, undefined, { navToken: "t" }), fixture("nav/feed.json")],
    ["forem", forem, first(forem), fixture("forem/records.json")],
    ["reed", reed, first(reed, undefined, { reedKey: "k" }), fixture("reed/search.json")],
    ["breezy", breezy, first(breezy, "breezy"), fixture("breezy/positions.json")],
    ["workable", workable, first(workable, "huggingface"), fixture("workable/account.json")],
  ] as const)("%s matches its snapshot", (_name, adapter, request, body) => {
    const postings = normalised(adapter, request, body);
    expect(postings.length).toBeGreaterThan(0);
    expect(postings).toMatchSnapshot();
  });

  it("reads a NAV entry's full ad, and an entry gone inactive as removed", () => {
    const detail = nav.detail?.("e3a0f7c4-33ac-45dd-8934-21193d1a2b79", call({ navToken: "t" })) as SourceRequest;
    const [posting] = normalised(nav, detail, fixture("nav/entry.json"));
    expect(posting).toMatchObject({ company: "00SMART AS", places: [{ country: "NO", city: "Oslo" }], employmentType: "CONTRACTOR" });
    expect(posting?.excerpt.length).toBeGreaterThan(100);
    expect(nav.parse(ok({ uuid: "aacf9c18-bcef-48c0-968e-238c5b88eff4", status: "INACTIVE" }), detail, call())).toEqual({
      kind: "ok",
      postings: [],
      dropped: 0,
      removed: ["aacf9c18-bcef-48c0-968e-238c5b88eff4"],
    });
  });
});

describe("what those adapters ask, and what they read", () => {
  it("asks USAJOBS only with the person's key and their contact as User-Agent", () => {
    expect(usajobs.search(query, call({ usajobsKey: "k" }))).toEqual([]);
    expect(usajobs.search(query, call({}, "ops@example.com"))).toEqual([]);
    expect(first(usajobs, undefined, { usajobsKey: "k" }, "ops@example.com").headers).toEqual({
      "Authorization-Key": "k",
      "User-Agent": "ops@example.com",
    });
  });

  it("reads USAJOBS' hourly pay and remote flag", () => {
    const [onsite, remote] = normalised(
      usajobs,
      first(usajobs, undefined, { usajobsKey: "k" }, "ops@example.com"),
      fixture("usajobs/search.json"),
    );
    expect(onsite).toMatchObject({
      salary: { currency: "USD", min: 120_000, max: 165_000, period: "YEAR", origin: "stated" },
      places: [{ country: "US", city: "Washington" }],
    });
    expect(remote).toMatchObject({ workplace: "remote", remoteRegions: ["US"], salary: { min: 52.4, max: 68.1, period: "HOUR" } });
  });

  it("asks NAV from a date, with the person's token, and hides inactive ads at once", () => {
    const request = first(nav, undefined, { navToken: "t" });
    // A first read starts a day back, so it reads the newest ads, not the oldest of a long window.
    expect(request.headers).toMatchObject({
      Authorization: "Bearer t",
      "If-Modified-Since": new Date(Date.parse(NOW) - 86_400_000).toUTCString(),
    });
    const outcome = nav.parse(ok(fixture("nav/feed.json")), request, call());
    expect(outcome).toMatchObject({
      kind: "ok",
      removed: [expect.any(String)],
      cursor: expect.stringMatching(/^\/api\/v1\/feed\/[0-9a-f-]{36}$/),
    });
    expect(outcome.kind === "ok" ? outcome.postings.length : 0).toBe(3);
    expect(outcome.kind === "ok" ? outcome.next?.url : "").toBe(
      `https://pam-stilling-feed.nav.no${outcome.kind === "ok" ? (outcome.cursor ?? "") : ""}`,
    );
    // The next read starts at the cursor, with no date of its own.
    const [resumed] = nav.search(query, { ...call({ navToken: "t" }), cursor: outcome.kind === "ok" ? outcome.cursor : undefined });
    expect(resumed).toMatchObject({
      url: `https://pam-stilling-feed.nav.no${outcome.kind === "ok" ? (outcome.cursor ?? "") : ""}`,
      headers: { Authorization: "Bearer t" },
    });
    expect(resumed?.headers?.["If-Modified-Since"]).toBeUndefined();
    // A cursor that is not a feed page's path is ignored.
    expect(nav.search(query, { ...call({ navToken: "t" }), cursor: "https://evil.example/x" })[0]?.url).toBe(
      "https://pam-stilling-feed.nav.no/api/v1/feed",
    );
    expect(nav.parse({ status: 304, body: null }, request, call())).toEqual({ kind: "ok", postings: [], dropped: 0 });
    expect(nav.search(query, call())).toEqual([]);
  });

  it("reads NAV's last page again with its ETag, and takes 304 as nothing new", () => {
    const page = "/api/v1/feed/8396f19a-f959-47b9-a266-aac2f9958bc8";
    const [request] = nav.search(query, { ...call({ navToken: "t" }), cursor: page });
    const last = { items: [], next_url: null };
    const outcome = nav.parse({ status: 200, etag: '"abc-1"', body: last }, request as SourceRequest, call());
    expect(outcome).toMatchObject({ kind: "ok", postings: [], cursor: `${page} "abc-1"` });
    const [again] = nav.search(query, { ...call({ navToken: "t" }), cursor: outcome.kind === "ok" ? outcome.cursor : undefined });
    expect(again).toMatchObject({
      url: `https://pam-stilling-feed.nav.no${page}`,
      headers: { Authorization: "Bearer t", "If-None-Match": '"abc-1"' },
    });
    expect(nav.parse({ status: 304, etag: '"abc-1"', body: null }, again as SourceRequest, call())).toEqual({
      kind: "ok",
      postings: [],
      dropped: 0,
    });
    // An ETag that is not one, or a header in it, is not kept.
    expect(nav.parse({ status: 200, etag: '"a"\r\nX: 1', body: last }, request as SourceRequest, call())).not.toHaveProperty("cursor");
    expect(nav.search(query, { ...call({ navToken: "t" }), cursor: `${page} "a" "b"` })[0]?.url).toBe(
      "https://pam-stilling-feed.nav.no/api/v1/feed",
    );
  });

  it("hides a JobTech ad marked removed", () => {
    const body = fixture("jobtech/search.json") as { hits: Record<string, unknown>[] };
    const outcome = jobtech.parse(
      ok({ ...body, hits: [...body.hits, { ...body.hits[0], id: "999", removed: true }] }),
      first(jobtech),
      call(),
    );
    expect(outcome).toMatchObject({ kind: "ok", removed: ["999"] });
  });

  it("puts Reed's key in Basic auth and reads a day rate", () => {
    expect(first(reed, undefined, { reedKey: "k" }).headers).toEqual({ Authorization: `Basic ${Buffer.from("k:").toString("base64")}` });
    const [, contract] = normalised(reed, first(reed, undefined, { reedKey: "k" }), fixture("reed/search.json"));
    expect(contract?.salary).toMatchObject({ currency: "GBP", min: 500, max: 600, period: "DAY" });
  });

  it("searches Le Forem for a keyword as a quoted string, never a clause", () => {
    const [request] = forem.search({ ...query, keywords: [`dev" OR 1=1 OR "`] }, call());
    expect(new URL(request?.url ?? "").searchParams.get("where")).toBe(`datedebutdiffusion >= date'2026-10-02' AND "dev\\" OR 1=1 OR \\""`);
  });

  it("asks only for a country each national source covers", () => {
    for (const adapter of [jobtech, forem]) expect(adapter.search({ ...query, countries: ["US"] }, call())).toEqual([]);
    expect(reed.search({ ...query, countries: ["DE"] }, call({ reedKey: "k" }))).toEqual([]);
  });

  it("keeps each source's requests on its own hosts", () => {
    for (const adapter of J2_SOURCES) {
      for (const request of adapter.search(
        { ...query, keywords: ["x"] },
        call({ usajobsKey: "k", navToken: "t", reedKey: "k" }, "ops@example.com"),
        "acme",
      )) {
        const host = new URL(request.url).hostname;
        expect(
          adapter.record.hosts.some((pattern) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern)),
          `${adapter.record.id} ${host}`,
        ).toBe(true);
      }
    }
  });
});

describe("what each of those adapters does with an answer that is not a list of postings", () => {
  const requests: readonly (readonly [JobSourceAdapter, SourceRequest])[] = [
    [usajobs, first(usajobs, undefined, { usajobsKey: "k" }, "ops@example.com")],
    [jobtech, first(jobtech)],
    [nav, first(nav, undefined, { navToken: "t" })],
    [forem, first(forem)],
    [reed, first(reed, undefined, { reedKey: "k" })],
    [breezy, first(breezy, "acme")],
    [workable, first(workable, "acme")],
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
      expect(
        adapter.parse(
          ok({ SearchResult: { SearchResultItems: "moved" }, hits: 7, items: {}, results: "moved", jobs: null }),
          request,
          call(),
        ).kind,
      ).toBe("drift");
    },
  );
});

describe("Workday's request spacing", () => {
  it("lets one Workday request go every 2 s at most, across all its tenants, as the engine's budget ledger takes them", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(BUDGETS_TABLE_SQL);
    const ledger = createBudgetLedger(db);
    let now = Date.parse(NOW);
    const sent: number[] = [];
    // Twelve requests as fast as the budget lets them. The ledger keys on the source, as the engine does, so every tenant shares this spacing.
    while (sent.length < 12) {
      const decision = ledger.take(workday.record.id, workday.record.budget, now);
      if (decision.ok) sent.push(now);
      else now += decision.retryAfterMs;
    }
    const gaps = sent.slice(1).map((at, index) => at - (sent[index] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2_000);
    // And right after one goes, the next is refused.
    expect(ledger.take(workday.record.id, workday.record.budget, now + 1_999).ok).toBe(false);
    db.close();
  });
});

describe("Workday, through its sitemap", () => {
  const TENANT = "nvidia.wd5/NVIDIAExternalCareerSite";
  const answer = (request: SourceRequest, body: string, status = 200, at = call()) => workday.parse({ status, body }, request, at);
  const search = (keywords: string[], cursor?: string) =>
    workday.search({ ...query, keywords }, { ...call(), ...(cursor === undefined ? {} : { cursor }) }, TENANT);

  it("reads robots.txt, then the sitemap, then the job pages whose address answers the keywords", () => {
    const [robots] = search(["software"]);
    expect(robots?.url).toBe("https://nvidia.wd5.myworkdayjobs.com/robots.txt");
    const allowed = answer(robots as SourceRequest, text("workday/robots.txt"));
    if (allowed.kind !== "ok") throw new Error(allowed.kind);
    const [sitemap] = allowed.more ?? [];
    expect(sitemap?.url).toBe("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/siteMap.xml");
    const listed = answer(sitemap as SourceRequest, text("workday/siteMap.xml"));
    if (listed.kind !== "ok") throw new Error(listed.kind);
    expect(listed.more?.map((request) => request.purpose)).toEqual(["detail", "detail", "detail"]);
    expect(listed.more?.every((request) => /software/i.test(request.url))).toBe(true);
    const page = answer(listed.more?.[0] as SourceRequest, text("workday/job.html"));
    if (page.kind !== "ok") throw new Error(page.kind);
    const [posting] = page.postings.map((raw) => normalizePosting(raw, NOW).posting);
    expect(posting).toMatchObject({
      source: "workday",
      title: "Senior System Software Engineer, NPI Data Center Diagnostics",
      reqId: "JR2025370",
      attribution: "2100 NVIDIA USA via Workday",
    });
    expect(posting?.places[0]).toMatchObject({ country: "US", city: "Santa Clara" });
  });

  it("stops at a robots.txt that disallows the site", () => {
    const [robots] = search(["software"]);
    expect(answer(robots as SourceRequest, "User-agent: *\nDisallow: /\n")).toEqual({
      kind: "disallowed",
      why: "nvidia.wd5.myworkdayjobs.com's robots.txt disallows NVIDIAExternalCareerSite",
    });
    expect(robotsAllows(text("workday/robots.txt"), "/talentcommunity/siteMap.xml")).toBe(false);
  });

  it("reads the sitemap at most once a day: the same day's search reads its pages from the cursor", () => {
    const sitemap: SourceRequest = {
      url: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/siteMap.xml",
      body: "text",
      purpose: "search",
      tenant: TENANT,
      keywords: [],
    };
    const listed = answer(sitemap, text("workday/siteMap.xml"));
    if (listed.kind !== "ok" || listed.cursor === undefined) throw new Error("no cursor");
    const sameDay = search(["software"], listed.cursor);
    expect(sameDay.length).toBe(3);
    expect(
      sameDay.every((request) => request.purpose === "detail" && !request.url.endsWith(".xml") && !request.url.endsWith("robots.txt")),
    ).toBe(true);
    // The next day starts at robots.txt again.
    const nextDay = workday.search(
      { ...query, keywords: ["software"] },
      { ...call(), now: "2026-10-17T08:00:00.000Z", cursor: listed.cursor },
      TENANT,
    );
    expect(nextDay.map((request) => request.url)).toEqual(["https://nvidia.wd5.myworkdayjobs.com/robots.txt"]);
  });

  it("reads robots.txt's groups, longest match, `*` and a final `$` as Google does", () => {
    const robots = "User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\n\nUser-agent: tavi\nDisallow: /tavi-only\n";
    expect(robotsAllows(robots, "/private/x", "googlebot")).toBe(false);
    expect(robotsAllows(robots, "/private/open/x", "googlebot")).toBe(true);
    expect(robotsAllows(robots, "/files/a.pdf", "googlebot")).toBe(false);
    expect(robotsAllows(robots, "/files/a.pdf?x", "googlebot")).toBe(true);
    // Tavi-jobs reads tavi's group, and only it.
    expect(robotsAllows(robots, "/tavi-only")).toBe(false);
    expect(robotsAllows(robots, "/private/x")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /a*b$\n", "/ab")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /a*b$\n", "/abc")).toBe(true);
  });

  it("goes on to the sitemap when robots.txt is missing, and passes over a bad escape or a closed job page", () => {
    const [robots] = search(["software"]);
    const missing = answer(robots as SourceRequest, "", 404);
    expect(missing.kind === "ok" ? missing.more?.[0]?.url : missing.kind).toBe(
      "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/siteMap.xml",
    );
    const sitemap: SourceRequest = {
      url: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/siteMap.xml",
      body: "text",
      purpose: "search",
      tenant: TENANT,
      keywords: ["software"],
    };
    const bad =
      "<urlset><url><loc>https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Software-100%_JR1</loc></url><url><loc>https://elsewhere.example/NVIDIAExternalCareerSite/job/Software_JR2</loc></url></urlset>";
    const listed = answer(sitemap, bad);
    expect(listed.kind === "ok" ? listed.more?.map((request) => request.url) : listed.kind).toEqual([
      "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Software-100%_JR1",
    ]);
    expect(
      answer(
        { ...sitemap, url: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/X_JR1", purpose: "detail" },
        "<html>closed</html>",
      ),
    ).toEqual({ kind: "ok", postings: [], dropped: 1 });
  });

  it("refuses a tenant not shaped like a Workday careers address, and never its cxs API", () => {
    for (const tenant of ["acme", "nvidia.wd5", "evil.example/x", "nvidia.wd5/../../x"])
      expect(workday.search(query, call(), tenant)).toEqual([]);
    const listed = answer(
      { url: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/siteMap.xml", body: "text", purpose: "search", tenant: TENANT },
      text("workday/siteMap.xml"),
    );
    expect(JSON.stringify(listed)).not.toContain("/wday/cxs/");
  });
});

describe("the boards' official MCP servers", () => {
  type Recorded = { readonly status: number; readonly text: string };
  /** A server replaying a recorded exchange: `initialize`, `initialized` (202), then the call; every message it was sent. */
  function server(
    recording: { readonly initialize: Recorded; readonly call: Recorded },
    overrides: Partial<Record<"initialize" | "initialized" | "call", McpHttpAnswer>> = {},
  ) {
    const sent: { method: string; headers: Readonly<Record<string, string>> }[] = [];
    const post: McpPost = async (body, headers) => {
      const method = body === undefined ? "DELETE" : String((JSON.parse(body) as { method: string }).method);
      if (body === undefined) {
        sent.push({ method, headers });
        return { status: 204, retryAfter: null, session: null, text: "" };
      }
      sent.push({ method, headers });
      const step = method === "initialize" ? "initialize" : method === "notifications/initialized" ? "initialized" : "call";
      const fallback = step === "initialized" ? { status: 202, text: "" } : recording[step];
      return (
        overrides[step] ?? { status: fallback.status, retryAfter: null, session: step === "initialize" ? "s-1" : null, text: fallback.text }
      );
    };
    return { post, sent };
  }
  const recorded = (path: string) => fixture(path) as { initialize: Recorded; call: Recorded };
  const viaMcp = async (adapter: JobSourceAdapter, request: SourceRequest, path: string, overrides?: Parameters<typeof server>[1]) => {
    const replay = server(recorded(path), overrides);
    const answer = await mcpToolCall(
      replay.post,
      request.mcp?.tool ?? "",
      request.mcp?.arguments ?? {},
      { name: "tavi-jobs", version: "test" },
      new AbortController().signal,
    );
    return { outcome: adapter.parse(answer, request, call()), sent: replay.sent };
  };
  const diceSearch = (): SourceRequest =>
    dice.search({ ...query, keywords: ["backend engineer"], postedWithinDays: 7 }, call())[0] as SourceRequest;

  it("initializes, says so, then calls the tool, keeping the server's session", async () => {
    const { outcome, sent } = await viaMcp(dice, diceSearch(), "dice/search.json");
    // The session the server gave is ended after the call.
    expect(sent.map((message) => message.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);
    expect(sent[0]?.headers["Mcp-Session-Id"]).toBeUndefined();
    expect(sent[2]?.headers["Mcp-Session-Id"]).toBe("s-1");
    expect(sent[3]?.headers["Mcp-Session-Id"]).toBe("s-1");
    expect(outcome.kind).toBe("ok");
  });

  it("reads Dice's event-stream answer, with its company link and the AI disclosure in each attribution", async () => {
    expect(diceSearch().mcp).toEqual({
      tool: "search_jobs",
      arguments: { keyword: "backend engineer", jobs_per_page: 50, sort: "datePosted", posted_date: "SEVEN" },
    });
    const { outcome } = await viaMcp(dice, diceSearch(), "dice/search.json");
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    const postings = outcome.postings.map((raw) => normalizePosting(raw, NOW).posting);
    expect(postings.length).toBe(5);
    for (const posting of postings) {
      expect(posting.attribution).toContain(DICE_DISCLOSURE);
      expect(posting.attribution).toMatch(/via Dice \(https:\/\/www\.dice\.com\/company\/\w+\)/);
      expect(posting.url).toMatch(/^https:\/\/www\.dice\.com\//);
    }
    expect(postings).toMatchSnapshot();
    // Its tool forbids fetching each posting's details unasked.
    expect(dice.detail).toBeUndefined();
  });

  it("keeps Dice's disclosure whole, cutting only the company to fit", () => {
    const outcome = dice.parse(
      {
        status: 200,
        body: {
          kind: "result",
          isError: false,
          value: {
            data: [
              {
                guid: "g-1",
                title: "Engineer",
                detailsPageUrl: "https://www.dice.com/job-detail/g-1",
                companyPageUrl: `https://www.dice.com/company/${"a".repeat(40)}`,
                companyName: "C".repeat(80),
              },
            ],
          },
        },
      },
      diceSearch(),
      call(),
    );
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    const [raw] = outcome.postings;
    expect(raw?.attribution.length).toBeLessThanOrEqual(200);
    expect(raw?.attribution.endsWith(DICE_DISCLOSURE)).toBe(true);
  });

  it("reads Snagajob's jobs near a place with their stated pay, and a job's details", async () => {
    expect(snagajob.search({ ...query, keywords: ["cook"] }, call())).toEqual([]);
    const [search] = snagajob.search({ ...query, keywords: ["cook"], place: { city: "Austin, TX", radiusKm: 16 } }, call());
    expect(search?.mcp).toEqual({
      tool: "search_jobs",
      arguments: { location: "Austin, TX", limit: 25, query: "cook", radius_miles: 10, date_posted: "last_30_days" },
    });
    const { outcome } = await viaMcp(snagajob, search as SourceRequest, "snagajob/search.json");
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    const [first] = outcome.postings.map((raw) => normalizePosting(raw, NOW).posting);
    expect(first).toMatchObject({
      source: "snagajob",
      sourceRef: "1303671022",
      salary: { currency: "USD", min: 11.69, max: 15.59, period: "HOUR", origin: "stated" },
      employmentType: "FULL_TIME",
    });
    expect(first?.places[0]).toMatchObject({ country: "US", region: "TX", city: "Austin" });
    const detail = snagajob.detail?.("1303671022", call()) as SourceRequest;
    const read = await viaMcp(snagajob, detail, "snagajob/detail.json");
    if (read.outcome.kind !== "ok") throw new Error(read.outcome.kind);
    expect(read.outcome.postings[0]).toMatchObject({ sourceRef: "1303671022", validThrough: expect.any(String) });
    expect(normalizePosting(read.outcome.postings[0] as never, NOW).description.length).toBeGreaterThan(200);
  });

  it("pauses on a 429 at any step, with its Retry-After", async () => {
    const limited = { status: 429, retryAfter: "120", session: null, text: "Too Many Requests" };
    for (const [step, asked] of [
      ["initialize", 1],
      ["initialized", 2],
      ["call", 3],
    ] as const) {
      const { outcome, sent } = await viaMcp(dice, diceSearch(), "dice/search.json", { [step]: limited });
      expect(outcome).toEqual({ kind: "rate-limited", retryAfterMs: 120_000 });
      expect(sent.filter((message) => message.method !== "DELETE")).toHaveLength(asked);
    }
  });

  it("reads a tool the server no longer has, or whose arguments changed, as drift; a failed tool as a failure", async () => {
    const error = (code: number) => ({
      status: 200,
      retryAfter: null,
      session: null,
      text: JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code, message: "Unknown tool: search_jobs" } }),
    });
    expect((await viaMcp(dice, diceSearch(), "dice/search.json", { call: error(-32602) })).outcome).toMatchObject({ kind: "drift" });
    expect((await viaMcp(dice, diceSearch(), "dice/search.json", { call: error(-32603) })).outcome).toEqual({
      kind: "failed",
      status: 502,
    });
    const failed = {
      status: 200,
      retryAfter: null,
      session: null,
      text: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "upstream timeout" }], isError: true } }),
    };
    expect((await viaMcp(dice, diceSearch(), "dice/search.json", { call: failed })).outcome).toEqual({ kind: "failed", status: 502 });
    // A server that will not start a session failed; it did not change.
    const refused = {
      status: 200,
      retryAfter: null,
      session: null,
      text: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unsupported protocol version" } }),
    };
    expect((await viaMcp(dice, diceSearch(), "dice/search.json", { initialize: refused })).outcome).toEqual({
      kind: "failed",
      status: 502,
    });
    // Not JSON-RPC, or an answer to another request: not MCP.
    const html = { status: 200, retryAfter: null, session: null, text: "<html>maintenance</html>" };
    expect((await viaMcp(dice, diceSearch(), "dice/search.json", { call: html })).outcome).toMatchObject({ kind: "drift" });
    const other = {
      status: 200,
      retryAfter: null,
      session: null,
      text: JSON.stringify({ jsonrpc: "2.0", id: 9, result: { structuredContent: { data: [] } } }),
    };
    expect((await viaMcp(dice, diceSearch(), "dice/search.json", { call: other })).outcome).toMatchObject({ kind: "drift" });
    // The server's error text is not kept.
    const drift = await viaMcp(dice, diceSearch(), "dice/search.json", { call: error(-32602) });
    expect(JSON.stringify(drift.outcome)).not.toContain("Unknown tool");
    // A result whose list changed shape is drift too.
    const reshaped = {
      status: 200,
      retryAfter: null,
      session: null,
      text: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { structuredContent: { jobs: [] } } }),
    };
    expect((await viaMcp(dice, diceSearch(), "dice/search.json", { call: reshaped })).outcome).toMatchObject({ kind: "drift" });
  });
});

describe("ECB rates", () => {
  const rates = parseEcbRates(text("ecb/eurofxref-daily.xml"));

  it("reads the day's euro reference rates", () => {
    expect(rates?.date).toBe("2026-10-16");
    expect(rates?.perEuro).toMatchObject({ EUR: 1, USD: 1.1253, GBP: 0.84385 });
    expect(parseEcbRates("<html/>")).toBeUndefined();
  });

  it("converts through the euro, and knows no currency it is not given", () => {
    if (rates === undefined) throw new Error("no rates");
    expect(convertCurrency(100, "EUR", "USD", rates)).toBeCloseTo(112.53);
    expect(convertCurrency(84.385, "GBP", "EUR", rates)).toBeCloseTo(100);
    expect(convertCurrency(100, "XAU", "EUR", rates)).toBeUndefined();
  });

  it("lets matching hold a stated salary in another currency against the floor", () => {
    const profile = JobProfileInputSchema.parse({
      titles: ["Engineer"],
      skills: [],
      places: [],
      remote: "open",
      remoteRegions: [],
      salaryFloor: { currency: "EUR", amount: 90_000, period: "YEAR" },
      employmentTypes: [],
      exclusions: { companies: [], keywords: [] },
      needsSponsorship: [],
    });
    const posting = (min: number) =>
      normalizePosting(
        {
          source: "f",
          sourceRef: String(min),
          url: "https://jobs.example.com/1",
          title: "Engineer",
          company: "Acme",
          workplace: "remote",
          remoteRegions: ["world"],
          salary: { currency: "USD", min, period: "YEAR", basis: "gross", origin: "stated" },
          attribution: "f",
        },
        NOW,
      ).posting;
    expect(matchPosting(posting(80_000), profile, "", { now: NOW, rates }).reasons[0]).toMatch(
      /about 71092 EUR at the ECB's rate of 2026-10-16, under your floor/,
    );
    expect(matchPosting(posting(120_000), profile, "", { now: NOW, rates })).toMatchObject({ outcome: "fits", flags: [] });
    expect(matchPosting(posting(80_000), profile, "", { now: NOW }).flags).toContain("salary-unknown");
  });
});
