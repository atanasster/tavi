import { TrendsSourceRecordSchema, type TrendsSourceRecord } from "./contracts.js";

/**
 * The keyless sources: free, keyless, documented except
 * where marked. Each record's terms were read on the date it carries; the
 * shared release test fails it 180 days later.
 */
const REVIEWED = "2026-10-16";

const record = (value: unknown): TrendsSourceRecord => TrendsSourceRecordSchema.parse(value);

const free = { unit: "none", usdPerUnit: 0, freeUnitsPerDay: 0 } as const;

export const HN_ALGOLIA = record({
  id: "hn-algolia",
  name: "Hacker News (Algolia search)",
  kind: "community",
  countries: ["*"],
  hosts: ["hn.algolia.com"],
  auth: "none",
  terms: {
    url: "https://hn.algolia.com/api",
    reviewedAt: REVIEWED,
    licence: "unspecified",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 72 },
    attribution: "Hacker News, searched through Algolia",
    displayRules: [],
    userTriggeredOnly: false,
  },
  // 10,000 requests an hour per IP; Tavi keeps far under it.
  budget: { perSecond: 2, perDay: 2_000 },
  trends: {
    languages: ["en"],
    shape: { counts: true, samples: true, fullText: true },
    backfillDays: 3_650,
    lagMinutes: 15,
    cost: free,
    seriesMaxDays: 400,
    deletionOnRequest: false,
    commercial: "permission",
  },
});

export const WIKIPEDIA_PAGEVIEWS = record({
  id: "wikipedia-pageviews",
  name: "Wikipedia pageviews",
  kind: "attention",
  countries: ["*"],
  hosts: ["wikimedia.org"],
  auth: "none",
  terms: {
    url: "https://dumps.wikimedia.org/legal.html",
    reviewedAt: REVIEWED,
    licence: "CC0-1.0",
    llmUse: "allowed",
    cache: { mode: "keep" },
    attribution: "Wikimedia Foundation pageview data (CC0)",
    displayRules: [],
    userTriggeredOnly: false,
  },
  // Wikimedia's 2026 limits: 200 a minute with an identifying User-Agent, at most 3 at once.
  budget: { perSecond: 3, perDay: 20_000 },
  trends: {
    languages: "*",
    shape: { counts: true, samples: false, fullText: false },
    backfillDays: 3_650,
    lagMinutes: 1_440,
    cost: free,
    seriesMaxDays: 400,
    deletionOnRequest: false,
    commercial: "allowed",
    needsContact: true,
  },
});

export const WIKIDATA = record({
  id: "wikidata",
  name: "Wikidata (topic names in each language)",
  kind: "reference",
  countries: ["*"],
  hosts: ["www.wikidata.org"],
  auth: "none",
  terms: {
    url: "https://www.wikidata.org/wiki/Wikidata:Licensing",
    reviewedAt: REVIEWED,
    licence: "CC0-1.0",
    llmUse: "allowed",
    cache: { mode: "ttl", days: 30 },
    attribution: "Wikidata (CC0)",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  trends: {
    languages: "*",
    shape: { counts: false, samples: false, fullText: false },
    backfillDays: 0,
    lagMinutes: 0,
    cost: free,
    seriesMaxDays: 30,
    deletionOnRequest: false,
    commercial: "allowed",
    needsContact: true,
  },
});

export const GDELT_DOC = record({
  id: "gdelt-doc",
  name: "GDELT news volume",
  kind: "news",
  countries: ["*"],
  hosts: ["api.gdeltproject.org"],
  auth: "none",
  terms: {
    url: "https://www.gdeltproject.org/about.html",
    reviewedAt: REVIEWED,
    licence: "GDELT (free use with citation)",
    llmUse: "allowed",
    cache: { mode: "ttl-hours", hours: 72 },
    attribution: "GDELT Project, https://www.gdeltproject.org/",
    displayRules: ["Cite the GDELT Project with a link to https://www.gdeltproject.org/"],
    userTriggeredOnly: false,
  },
  // One request every 5 seconds per IP, enforced with 429; answers take 10–36 s.
  budget: { perSecond: 0.2, perDay: 2_000 },
  trends: {
    languages: "*",
    shape: { counts: true, samples: true, fullText: false },
    backfillDays: 90,
    lagMinutes: 150,
    cost: free,
    seriesMaxDays: 400,
    deletionOnRequest: false,
    commercial: "allowed",
  },
});

export const GTRENDS_RSS = record({
  id: "gtrends-rss",
  name: "Google Trends: trending now",
  kind: "search",
  countries: ["*"],
  hosts: ["trends.google.com"],
  auth: "none",
  terms: {
    url: "https://support.google.com/trends/answer/3076011",
    reviewedAt: REVIEWED,
    licence: "Google Terms of Service",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 72 },
    attribution: "Google Trends",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.2, perDay: 300 },
  trends: {
    languages: "*",
    shape: { counts: false, samples: true, fullText: false },
    backfillDays: 0,
    lagMinutes: 10,
    cost: free,
    seriesMaxDays: 400,
    deletionOnRequest: false,
    commercial: "permission",
  },
});

export const BLUESKY_TRENDS = record({
  id: "bluesky-trends",
  name: "Bluesky trends",
  kind: "social",
  countries: ["*"],
  hosts: ["public.api.bsky.app"],
  auth: "none",
  // `app.bsky.unspecced.getTrends`: unspecced, so it may change without notice and is off by default.
  standing: "undocumented",
  defaultOn: false,
  terms: {
    url: "https://docs.bsky.app/docs/developer-guidelines",
    reviewedAt: REVIEWED,
    licence: "unspecified",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 24 },
    attribution: "Bluesky",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 1_000 },
  trends: {
    languages: "*",
    shape: { counts: true, samples: true, fullText: false },
    backfillDays: 0,
    lagMinutes: 1,
    cost: free,
    seriesMaxDays: 400,
    deletionOnRequest: true,
    commercial: "permission",
  },
});

export const BLUESKY_SEARCH = record({
  id: "bluesky-search",
  name: "Bluesky post search",
  kind: "social",
  countries: ["*"],
  hosts: ["api.bsky.app"],
  auth: "none",
  terms: {
    url: "https://docs.bsky.app/docs/developer-guidelines",
    reviewedAt: REVIEWED,
    licence: "unspecified",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 24 },
    attribution: "Bluesky",
    displayRules: [],
    userTriggeredOnly: false,
  },
  // The first page only: a cursor is refused without a session.
  budget: { perSecond: 1, perDay: 1_000 },
  trends: {
    languages: "*",
    shape: { counts: true, samples: true, fullText: true },
    backfillDays: 0,
    lagMinutes: 1,
    cost: free,
    seriesMaxDays: 400,
    deletionOnRequest: true,
    commercial: "permission",
  },
});

/** The Mastodon instances the manifest reaches; the operator picks a subset (`mastodonInstances`). */
export const MASTODON_INSTANCES = ["mastodon.social", "mastodon.online", "mstdn.jp", "fosstodon.org", "chaos.social"] as const;

export const MASTODON_TRENDS = record({
  id: "mastodon-trends",
  name: "Mastodon trending tags",
  kind: "social",
  countries: ["*"],
  hosts: [...MASTODON_INSTANCES],
  auth: "none",
  terms: {
    url: "https://docs.joinmastodon.org/methods/trends/",
    reviewedAt: REVIEWED,
    licence: "per instance",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 72 },
    attribution: "Mastodon",
    displayRules: [],
    userTriggeredOnly: false,
  },
  // 300 requests in 5 minutes per IP and instance.
  budget: { perSecond: 0.5, perDay: 3_000 },
  trends: {
    languages: "*",
    shape: { counts: true, samples: true, fullText: false },
    backfillDays: 7,
    lagMinutes: 30,
    cost: free,
    seriesMaxDays: 400,
    deletionOnRequest: false,
    commercial: "permission",
  },
});

export const ARXIV = record({
  id: "arxiv",
  name: "arXiv",
  kind: "research",
  countries: ["*"],
  hosts: ["export.arxiv.org"],
  auth: "none",
  terms: {
    url: "https://info.arxiv.org/help/api/tou.html",
    reviewedAt: REVIEWED,
    licence: "CC0-1.0 (metadata)",
    llmUse: "allowed",
    cache: { mode: "ttl-hours", hours: 72 },
    attribution: "arXiv",
    displayRules: ["Thank you to arXiv for use of its open access interoperability."],
    userTriggeredOnly: false,
  },
  // One request every three seconds, on one connection.
  budget: { perSecond: 0.33, perDay: 500 },
  trends: {
    languages: ["en"],
    shape: { counts: true, samples: true, fullText: false },
    backfillDays: 3_650,
    lagMinutes: 1_440,
    cost: free,
    seriesMaxDays: 400,
    deletionOnRequest: false,
    commercial: "allowed",
  },
});

/** The broadcasters' feeds: a host each, at most 8 a record. */
export const RSS_FEEDS = {
  "rss-europe": [
    { url: "https://feeds.bbci.co.uk/news/rss.xml", country: "GB", language: "en", outlet: "BBC News" },
    { url: "https://www.tagesschau.de/api2u/homepage/", country: "DE", language: "de", outlet: "tagesschau" },
    { url: "https://www.francetvinfo.fr/titres.rss", country: "FR", language: "fr", outlet: "franceinfo" },
    { url: "https://www.rainews.it/rss/tutti", country: "IT", language: "it", outlet: "RaiNews" },
    { url: "https://api2.rtve.es/rss/temas_noticias.xml", country: "ES", language: "es", outlet: "RTVE" },
    { url: "https://feeds.nos.nl/nosnieuwsalgemeen", country: "NL", language: "nl", outlet: "NOS" },
  ],
  "rss-americas": [
    { url: "https://g1.globo.com/rss/g1/", country: "BR", language: "pt", outlet: "g1" },
    { url: "https://feeds.folha.uol.com.br/emcimadahora/rss091.xml", country: "BR", language: "pt", outlet: "Folha de S.Paulo" },
  ],
} as const;

/** A feed group's hosts, countries and languages, as its record declares them. */
const feedsOf = (group: keyof typeof RSS_FEEDS) => ({
  hosts: [...new Set(RSS_FEEDS[group].map((feed) => new URL(feed.url).hostname))],
  countries: [...new Set(RSS_FEEDS[group].map((feed) => feed.country))],
  languages: [...new Set(RSS_FEEDS[group].map((feed) => feed.language))],
});
const EUROPE = feedsOf("rss-europe");
const AMERICAS = feedsOf("rss-americas");

export const RSS_EUROPE = record({
  // franceinfo's feed redirects from francetvinfo.fr to franceinfo.fr.
  id: "rss-europe",
  name: "European public broadcasters' news feeds",
  kind: "news",
  countries: EUROPE.countries,
  hosts: [...EUROPE.hosts, "www.franceinfo.fr"],
  auth: "none",
  // tagesschau's robots.txt permits RAG with attribution; the others' feeds are silent.
  terms: {
    url: "https://www.tagesschau.de/robots.txt",
    reviewedAt: REVIEWED,
    licence: "publisher copyright",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 72 },
    attribution: "Each item's broadcaster, linked",
    displayRules: ["Show each headline with its broadcaster and a link to it"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.5, perDay: 600 },
  trends: {
    languages: EUROPE.languages,
    shape: { counts: true, samples: true, fullText: false },
    backfillDays: 0,
    lagMinutes: 15,
    cost: free,
    seriesMaxDays: 400,
    deletionOnRequest: false,
    commercial: "permission",
  },
});

export const RSS_AMERICAS = record({
  id: "rss-americas",
  name: "Brazilian news feeds",
  kind: "news",
  countries: AMERICAS.countries,
  hosts: AMERICAS.hosts,
  auth: "none",
  terms: {
    url: "https://g1.globo.com/robots.txt",
    reviewedAt: REVIEWED,
    licence: "publisher copyright",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 72 },
    attribution: "Each item's publisher, linked",
    displayRules: ["Show each headline with its publisher and a link to it"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.5, perDay: 300 },
  trends: {
    languages: AMERICAS.languages,
    shape: { counts: true, samples: true, fullText: false },
    backfillDays: 0,
    lagMinutes: 15,
    cost: free,
    seriesMaxDays: 400,
    deletionOnRequest: false,
    commercial: "permission",
  },
});

/** The keyless records, in the order `sources` lists them. */
export const TR1_RECORDS: readonly TrendsSourceRecord[] = [
  HN_ALGOLIA,
  WIKIPEDIA_PAGEVIEWS,
  WIKIDATA,
  GDELT_DOC,
  GTRENDS_RSS,
  BLUESKY_TRENDS,
  BLUESKY_SEARCH,
  MASTODON_TRENDS,
  ARXIV,
  RSS_EUROPE,
  RSS_AMERICAS,
];

/**
 * The keyed sources: gated by a key or an
 * approval, each off until the operator keys it, and none paid: Tavi uses no
 * paid service, so X, Yandex Wordstat and Tavily have no record.
 */
const REVIEWED_TR2 = "2026-10-17";

export const YOUTUBE = record({
  id: "youtube",
  name: "YouTube Data API",
  kind: "social",
  countries: ["*"],
  hosts: ["www.googleapis.com"],
  auth: "key-query",
  credential: ["youtubeKey"],
  defaultOn: false,
  terms: {
    url: "https://developers.google.com/youtube/terms/developer-policies",
    reviewedAt: REVIEWED_TR2,
    licence: "YouTube API Services Terms",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 72 },
    attribution: "YouTube",
    displayRules: ["Keep YouTube statistics no longer than 30 days", "Label velocity as computed by Tavi, never as YouTube's"],
    userTriggeredOnly: false,
  },
  // search.list has its own 100 a day since 2026-06-01.
  budget: { perSecond: 1, perDay: 100 },
  trends: {
    languages: "*",
    shape: { counts: true, samples: true, fullText: false },
    backfillDays: 0,
    lagMinutes: 10,
    cost: { unit: "none", usdPerUnit: 0, freeUnitsPerDay: 0 },
    seriesMaxDays: 30,
    deletionOnRequest: false,
    commercial: "permission",
  },
});

export const NAVER_DATALAB = record({
  id: "naver-datalab",
  name: "Naver DataLab search trend",
  kind: "search",
  countries: ["KR"],
  hosts: ["openapi.naver.com"],
  auth: "key-header",
  credential: ["naverClientId", "naverClientSecret"],
  defaultOn: false,
  terms: {
    url: "https://developers.naver.com/products/terms",
    reviewedAt: REVIEWED_TR2,
    licence: "Naver Developers terms",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 24 },
    attribution: "Naver DataLab",
    displayRules: ["A ratio is relative: 100 is the period's highest"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 1_000 },
  trends: {
    languages: ["ko"],
    shape: { counts: true, samples: false, fullText: false },
    backfillDays: 90,
    lagMinutes: 1_440,
    cost: { unit: "none", usdPerUnit: 0, freeUnitsPerDay: 0 },
    seriesMaxDays: 400,
    deletionOnRequest: false,
    commercial: "permission",
  },
});

export const GTRENDS_API = record({
  // Alpha, by application: Google publishes no reference, so the host is unconfirmed and no adapter reads it yet.
  id: "gtrends-api",
  name: "Google Trends API (alpha)",
  kind: "search",
  countries: ["*"],
  hosts: ["trends.googleapis.com"],
  auth: "key-query",
  credential: ["googleTrendsKey"],
  standing: "undocumented",
  defaultOn: false,
  terms: {
    url: "https://developers.google.com/search/apis/trends",
    reviewedAt: REVIEWED_TR2,
    licence: "Google APIs Terms of Service",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 72 },
    attribution: "Google Trends",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 100 },
  trends: {
    languages: "*",
    shape: { counts: true, samples: false, fullText: false },
    backfillDays: 1_825,
    lagMinutes: 1_440,
    cost: { unit: "none", usdPerUnit: 0, freeUnitsPerDay: 0 },
    seriesMaxDays: 400,
    deletionOnRequest: false,
    commercial: "permission",
  },
});

export const REDDIT = record({
  id: "reddit",
  name: "Reddit (approved credentials)",
  kind: "community",
  countries: ["*"],
  hosts: ["www.reddit.com", "oauth.reddit.com"],
  auth: "oauth-client",
  credential: ["redditClientId", "redditSecret"],
  defaultOn: false,
  terms: {
    url: "https://redditinc.com/policies/data-api-terms",
    reviewedAt: REVIEWED_TR2,
    licence: "Reddit Data API Terms",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 24 },
    attribution: "Reddit",
    displayRules: ["Never use Reddit content to train a model", "Keep no data the approved use does not need"],
    userTriggeredOnly: false,
  },
  // 100 queries a minute a client.
  budget: { perSecond: 1, perDay: 1_000 },
  trends: {
    languages: "*",
    shape: { counts: true, samples: true, fullText: true },
    backfillDays: 0,
    lagMinutes: 5,
    cost: { unit: "none", usdPerUnit: 0, freeUnitsPerDay: 0 },
    seriesMaxDays: 400,
    deletionOnRequest: true,
    commercial: "permission",
    sunset: "2027-03-01",
    needsContact: true,
  },
});

export const THREADS = record({
  id: "threads",
  name: "Threads keyword search",
  kind: "social",
  countries: ["*"],
  hosts: ["graph.threads.net"],
  auth: "key-header",
  credential: ["threadsToken"],
  defaultOn: false,
  terms: {
    url: "https://developers.facebook.com/docs/threads/keyword-search",
    reviewedAt: REVIEWED_TR2,
    licence: "Meta Platform Terms",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 24 },
    attribution: "Threads",
    displayRules: ["Without threads_keyword_search approved, it reads only your own posts"],
    userTriggeredOnly: false,
  },
  // 2,200 queries a user a rolling day.
  budget: { perSecond: 0.5, perDay: 2_000 },
  trends: {
    languages: "*",
    shape: { counts: true, samples: true, fullText: true },
    backfillDays: 0,
    lagMinutes: 5,
    cost: { unit: "none", usdPerUnit: 0, freeUnitsPerDay: 0 },
    seriesMaxDays: 400,
    deletionOnRequest: true,
    commercial: "permission",
  },
});

/** The keyed records, in the order `sources` lists them after the keyless ones. */
export const TR2_RECORDS: readonly TrendsSourceRecord[] = [YOUTUBE, NAVER_DATALAB, GTRENDS_API, REDDIT, THREADS];

/**
 * The open-page lists: each site's own hot
 * list, read over plain HTTP under its robots.txt, `unofficial` and so off
 * until the operator turns it on. Read 2026-10-17. Kaskus's and ShareChat's
 * lists are drawn in the browser, so neither has a list record.
 */
const REVIEWED_TR3 = "2026-10-17";
const list = {
  languages: "*",
  shape: { counts: true, samples: false, fullText: false },
  backfillDays: 0,
  lagMinutes: 10,
  cost: free,
  seriesMaxDays: 400,
  deletionOnRequest: false,
  commercial: "permission",
} as const;

export const BAIDU_HOT = record({
  id: "baidu-hot",
  name: "Baidu hot search",
  kind: "search",
  countries: ["CN"],
  hosts: ["top.baidu.com"],
  auth: "none",
  standing: "unofficial",
  defaultOn: false,
  // No robots.txt; its general terms may bar automated access (unverified): read only when a person asks.
  terms: {
    url: "https://top.baidu.com/board?tab=realtime",
    reviewedAt: REVIEWED_TR3,
    licence: "Baidu terms",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 24 },
    attribution: "Baidu hot search",
    displayRules: ["Baidu's terms may bar automated access: read only at a person's request"],
    userTriggeredOnly: true,
  },
  budget: { perSecond: 0.1, perDay: 30 },
  trends: { ...list, languages: ["zh"] },
});

export const HATENA_HOT = record({
  id: "hatena-hot",
  name: "Hatena Bookmark hot entries",
  kind: "community",
  countries: ["JP"],
  hosts: ["b.hatena.ne.jp"],
  auth: "none",
  standing: "unofficial",
  defaultOn: false,
  // Its terms license distribution as an RSS feed; its robots.txt asks a Crawl-delay of 5.
  terms: {
    url: "https://www.hatena.ne.jp/rule/rule",
    reviewedAt: REVIEWED_TR3,
    licence: "Hatena terms (RSS distribution)",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 24 },
    attribution: "Hatena Bookmark",
    displayRules: ["Link each entry to its page"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.2, perDay: 200 },
  trends: { ...list, languages: ["ja"] },
});

export const PTT_BOARD = record({
  id: "ptt-board",
  name: "PTT board",
  kind: "community",
  countries: ["TW"],
  hosts: ["www.ptt.cc"],
  auth: "none",
  standing: "unofficial",
  defaultOn: false,
  // No robots.txt; its home page says it is non-commercial and readable without an account. An 18+ board needs the operator's own age assertion.
  terms: {
    url: "https://www.ptt.cc/index.html",
    reviewedAt: REVIEWED_TR3,
    licence: "PTT (non-commercial)",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 24 },
    attribution: "PTT",
    displayRules: ["Link each thread to its page"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.2, perDay: 200 },
  trends: { ...list, languages: ["zh-Hant"] },
});

export const PANTIP_HOT = record({
  id: "pantip-hot",
  name: "Pantip hot topics",
  kind: "community",
  countries: ["TH"],
  hosts: ["pantip.com"],
  auth: "none",
  standing: "unofficial",
  defaultOn: false,
  terms: {
    url: "https://pantip.com/robots.txt",
    reviewedAt: REVIEWED_TR3,
    licence: "Pantip terms",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 24 },
    attribution: "Pantip",
    displayRules: ["Link each topic to its page"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.2, perDay: 200 },
  trends: { ...list, languages: ["th"] },
});

export const DAUM_TOP = record({
  id: "daum-top",
  name: "Daum front page",
  kind: "news",
  countries: ["KR"],
  hosts: ["www.daum.net"],
  auth: "none",
  standing: "unofficial",
  defaultOn: false,
  // Its robots.txt allows the root page only (`Allow : /$`); the stories its front page carries, not the live trend widget, which needs a browser.
  terms: {
    url: "https://www.daum.net/robots.txt",
    reviewedAt: REVIEWED_TR3,
    licence: "Kakao terms",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 24 },
    attribution: "Daum, and each story's publisher",
    displayRules: ["Link each story to its page"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 0.1, perDay: 100 },
  trends: { ...list, languages: ["ko"] },
});

/** The open-page list records, in the order `sources` lists them after the keyed ones. */
export const TR3_RECORDS: readonly TrendsSourceRecord[] = [BAIDU_HOT, HATENA_HOT, PTT_BOARD, PANTIP_HOT, DAUM_TOP];
