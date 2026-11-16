import { describe, expect, it } from "vitest";

import {
  GTRENDS_API,
  REDDIT,
  TR1_RECORDS,
  TR2_RECORDS,
  TR3_RECORDS,
  gtrendsApi,
  naverDatalab,
  reddit,
  threads,
  youtube,
  type AdapterTopic,
  type SourceCall,
  type SourceRequest,
  type Window,
} from "../src/index.js";

/**
 * The keyed adapters. Their sources need the operator's keys or
 * approval, which this repository has none of, so each answer here is built
 * from the source's published reference (cited per case), not recorded: the
 * shapes are the documentation's, the values the test's.
 */
const NOW = "2026-10-17T12:00:00.000Z";
const topic: AdapterTopic = {
  label: "Solid-state batteries",
  terms: ["solid-state battery", "全固体電池"],
  termsByLanguage: { en: ["solid-state battery"], ja: ["全固体電池"] },
  exclude: ["phone"],
  articles: {},
  countries: ["US"],
};
const keys: Record<string, string> = {
  youtubeKey: "yt-key",
  naverClientId: "nid",
  naverClientSecret: "nsecret",
  redditClientId: "rid",
  redditSecret: "rsecret",
  threadsToken: "THREADS-PLACEHOLDER",
};
const call = (extra: Partial<SourceCall> = {}): SourceCall => ({ now: NOW, credential: (key) => keys[key], settings: {}, ...extra });
const hours: Window = { from: "2026-10-16T12:00:00.000Z", to: "2026-10-17T12:00:00.000Z", bucket: "hour" };
const days: Window = { from: "2026-10-10T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z", bucket: "day" };
const ok = (body: unknown) => ({ status: 200, body });

describe("the keyed records", () => {
  it("are off until keyed, with their auth, and Reddit ends on its sunset", () => {
    expect(TR2_RECORDS.map((record) => [record.id, record.auth, record.defaultOn])).toEqual([
      ["youtube", "key-query", false],
      ["naver-datalab", "key-header", false],
      ["gtrends-api", "key-query", false],
      ["reddit", "oauth-client", false],
      ["threads", "key-header", false],
    ]);
    expect(REDDIT.trends).toMatchObject({ sunset: "2027-03-01", needsContact: true, deletionOnRequest: true });
    expect(TR2_RECORDS.find((record) => record.id === "youtube")?.trends.seriesMaxDays).toBe(30);
  });

  it("are none of them paid: Tavi uses no paid service", () => {
    for (const record of [...TR1_RECORDS, ...TR2_RECORDS, ...TR3_RECORDS])
      expect(record.trends.cost, record.id).toEqual({ unit: "none", usdPerUnit: 0, freeUnitsPerDay: 0 });
    for (const id of ["x-counts", "x-search", "yandex-wordstat", "tavily-news"])
      expect([...TR1_RECORDS, ...TR2_RECORDS, ...TR3_RECORDS].map((record) => record.id)).not.toContain(id);
  });
});

describe("YouTube (developers.google.com/youtube/v3: search.list, videos.list, errors)", () => {
  it("counts a page of videos and their channels, keeps the key in the query, and reads a spent quota as quota", () => {
    const [request] = youtube.counts?.request({ topic, window: hours }, call()) ?? [];
    expect(new URL(request?.url ?? "").searchParams.get("key")).toBe("yt-key");
    const body = {
      items: [
        {
          id: { kind: "youtube#video", videoId: "abcDEF12345" },
          snippet: {
            publishedAt: "2026-10-17T10:15:00Z",
            channelId: "UCchannelA",
            title: "Solid-state battery explained",
            description: "A look &amp; a test",
          },
        },
        {
          id: { videoId: "zzzZZZ99999" },
          snippet: { publishedAt: "2026-10-17T10:45:00Z", channelId: "UCchannelA", title: "Battery news" },
        },
      ],
    };
    const read = youtube.counts?.parse(ok(body), request as SourceRequest, { topic, window: hours }, call());
    if (read?.kind !== "ok") throw new Error(JSON.stringify(read));
    expect(
      read.value.map((series) => [series.metric, series.points.find((point) => point.start === "2026-10-17T10:00:00.000Z")?.value]),
    ).toEqual([
      ["videos", 2],
      ["channels", 1],
    ]);
    const quota = {
      error: {
        code: 403,
        message: "The request cannot be completed because you have exceeded your quota.",
        errors: [{ reason: "quotaExceeded", domain: "youtube.quota" }],
      },
    };
    expect(youtube.counts?.parse({ status: 403, body: quota }, request as SourceRequest, { topic, window: hours }, call())).toMatchObject({
      kind: "failed",
      class: "quota",
    });
    expect(
      youtube.counts?.parse(
        { status: 403, body: { error: { errors: [{ reason: "forbidden" }] } } },
        request as SourceRequest,
        { topic, window: hours },
        call(),
      ),
    ).toMatchObject({ kind: "failed", class: "blocked" });
  });

  it("lists a region's most popular, with views", () => {
    const [request] = youtube.trending?.request({ country: "US" }, call()) ?? [];
    expect(new URL(request?.url ?? "").searchParams.get("chart")).toBe("mostPopular");
    const body = {
      items: [
        {
          id: "abcDEF12345",
          snippet: { title: "Top video", publishedAt: "2026-10-16T00:00:00Z", channelId: "UCchannelB" },
          statistics: { viewCount: "123456" },
        },
      ],
    };
    expect(youtube.trending?.parse(ok(body), request as SourceRequest, { country: "US" }, call())).toEqual({
      kind: "ok",
      value: [
        { title: "Top video", url: "https://www.youtube.com/watch?v=abcDEF12345", rank: 1, volume: 123_456, volumeLabel: "123,456 views" },
      ],
    });
  });
});

describe("Naver DataLab (POST /v1/datalab/search, ratio)", () => {
  it("asks the whole backfill span on one scale, with both header credentials, and reads each day's ratio", () => {
    const [request] = naverDatalab.counts?.request({ topic, window: days }, call()) ?? [];
    expect(request).toMatchObject({
      url: "https://openapi.naver.com/v1/datalab/search",
      method: "POST",
      headers: { "X-Naver-Client-Id": "nid", "X-Naver-Client-Secret": "nsecret" },
    });
    const body = JSON.parse(request?.body ?? "{}") as {
      startDate: string;
      endDate: string;
      timeUnit: string;
      keywordGroups: { keywords: string[] }[];
    };
    expect(body).toMatchObject({ startDate: "2026-07-19", endDate: "2026-10-16", timeUnit: "date" });
    const answer = {
      startDate: "2026-07-19",
      endDate: "2026-10-16",
      timeUnit: "date",
      results: [
        {
          title: "Solid-state batteries",
          keywords: body.keywordGroups[0]?.keywords,
          data: [
            { period: "2026-10-15", ratio: 40.5 },
            { period: "2026-10-16", ratio: 100 },
          ],
        },
      ],
    };
    const read = naverDatalab.counts?.parse(ok(answer), request as SourceRequest, { topic, window: days }, call());
    if (read?.kind !== "ok") throw new Error(JSON.stringify(read));
    const points = read.value[0]?.points ?? [];
    expect(points).toHaveLength(90);
    expect(points.slice(-2)).toEqual([
      { start: "2026-10-15T00:00:00.000Z", value: 40.5, quality: "approximate" },
      { start: "2026-10-16T00:00:00.000Z", value: 100, quality: "approximate" },
    ]);
    expect(points[0]).toMatchObject({ quality: "missing" });
    // Hourly windows ask nothing: DataLab is daily.
    expect(naverDatalab.counts?.request({ topic, window: hours }, call())).toEqual([]);
  });
});

describe("Reddit (github.com/reddit-archive/reddit/wiki/OAuth2: client credentials)", () => {
  it("exchanges the client's id and secret by Basic auth for a token, then searches with it", () => {
    const [token] = reddit.authorize?.request({}, call()) ?? [];
    expect(token).toMatchObject({
      url: "https://www.reddit.com/api/v1/access_token",
      method: "POST",
      body: "grant_type=client_credentials",
      headers: { Authorization: `Basic ${Buffer.from("rid:rsecret").toString("base64")}` },
    });
    expect(
      reddit.authorize?.parse(
        ok({ access_token: "tok", token_type: "bearer", expires_in: 86_400, scope: "*" }),
        token as SourceRequest,
        {},
        call(),
      ),
    ).toEqual({ kind: "ok", value: { token: "tok", expiresInMs: 86_400_000 } });
    const [search] = reddit.counts?.request({ topic, window: hours }, call({ token: "tok" })) ?? [];
    expect(search).toMatchObject({ headers: { Authorization: "Bearer tok" } });
    expect(new URL(search?.url ?? "").host).toBe("oauth.reddit.com");
    const listing = {
      kind: "Listing",
      data: {
        children: [
          {
            kind: "t3",
            data: {
              id: "abc",
              title: "Solid-state battery breakthrough?",
              selftext: "",
              author: "someone",
              created_utc: 1_760_695_200,
              permalink: "/r/technology/comments/abc/x/",
              score: 10,
              num_comments: 4,
            },
          },
          { kind: "t3", data: { id: "def", title: "x", author: "[deleted]", created_utc: 1_760_695_300, permalink: "/r/a/comments/def/" } },
        ],
      },
    };
    const sample = reddit.sample?.parse(ok(listing), search as SourceRequest, { topic, window: hours, limit: 10 }, call());
    expect(sample).toMatchObject({
      kind: "ok",
      value: [
        { ref: "abc", url: "https://www.reddit.com/r/technology/comments/abc/x/", author: "someone", metrics: { score: 10, comments: 4 } },
        { ref: "def" },
      ],
    });
    if (sample?.kind === "ok") expect(sample.value[1]).not.toHaveProperty("author");
    expect(reddit.counts?.parse({ status: 403, body: "blocked" }, search as SourceRequest, { topic, window: hours }, call())).toMatchObject(
      { kind: "failed", class: "blocked" },
    );
  });
});

describe("Threads (developers.facebook.com/docs/threads/keyword-search)", () => {
  it("searches recent posts with the token in a bearer header and keeps only Threads' own links", () => {
    const [request] = threads.sample?.request({ topic, window: hours, limit: 25 }, call()) ?? [];
    expect(request?.headers).toEqual({ Authorization: "Bearer THREADS-PLACEHOLDER" });
    expect(new URL(request?.url ?? "").searchParams.get("search_type")).toBe("RECENT");
    const body = {
      data: [
        {
          id: "1",
          text: "solid-state battery",
          timestamp: "2026-10-17T10:00:00+0000",
          permalink: "https://www.threads.net/@someone/post/abc",
          username: "someone",
        },
        { id: "2", text: "spam", permalink: "https://evil.example/x" },
      ],
    };
    expect(threads.sample?.parse(ok(body), request as SourceRequest, { topic, window: hours, limit: 25 }, call())).toMatchObject({
      kind: "ok",
      value: [{ ref: "1", url: "https://www.threads.net/@someone/post/abc", author: "someone", publishedAt: "2026-10-17T10:00:00.000Z" }],
    });
  });
});

describe("Google Trends API (alpha)", () => {
  it("has a record and reads nothing, saying why", () => {
    expect(GTRENDS_API.standing).toBe("undocumented");
    expect(gtrendsApi.counts).toBeUndefined();
    expect(gtrendsApi.unconfigured?.(call())).toMatch(/no reference/);
  });
});
