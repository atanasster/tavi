# Trends (`trends.radar`)

`trends.radar` is an external plugin that tracks the topics you name across
free public sources, tests in code whether one is spiking, and tells your
heartbeat when one is. It never watches a person, and never posts or sends
anything.

This guide covers the free sources, the store, the
velocity engine, the brief checker and the heartbeat's spikes source; then the
free sources that need your keys, and Wikidata's names for a topic in each
language; then open-page hot
lists and browser profiles; then clustering what people say, and a routine's
daily digest.

## Install

Build the plugin, then install, approve and enable it like any external plugin
([PLUGINS.md](PLUGINS.md)):

```bash
pnpm --filter @tavi/plugin-trends build
```

```bash
tavi plugins install packages/external/trends/dist-plugin
```

```bash
tavi plugins approve trends.radar 0.1.0
```

```bash
tavi plugins enable trends.radar
```

It runs only as a confined worker: its approval shows the 33 hosts it may
reach, the settings it holds as themselves (`rawSecrets`: YouTube's and Google
Trends' keys, which go in a request's query, and Reddit's client id and
secret, which go Base64-encoded in its token request), and the heartbeat
signal source it adds (`spikes`). Every other key reaches the worker only as
the proxy's placeholder. It refuses to start beside the owner.

It appears in Connected apps as **Trends** (category Search), a Shared app:
what it reads is public data. Its results are still untrusted third-party
text, so a send or a save a result asks for is asked first. Your topics are
kept apart by person and workspace.

## Settings

Every setting is optional.

| Setting | What it does |
| --- | --- |
| `contact` | An email or URL sent in every request's User-Agent, `Tavi-trends/<version> (+contact)`. Wikimedia's policy asks for one, so Wikipedia pageviews and Wikidata stay off until it is set. |
| `countries` | Countries a topic covers when it names none, comma-separated ISO codes (`US,DE`). A country decides which regional sources a topic reads, and in what order (`routing/<CC>.json`). A topic with no country, and no setting, reads every source, the regional feeds included. |
| `languages` | Languages a search covers when it names none (`en,de`). English by default. |
| `mastodonInstances` | Mastodon servers to read trends from, among those the plugin may reach: mastodon.social (the default), mastodon.online, mstdn.jp, fosstodon.org, chaos.social. |
| `enabledSources` | Source ids to turn on besides the default ones (`bluesky-trends`). |
| `disabledSources` | Source ids to turn off. A source that is off is read for nobody, whatever a topic or a search names. |
| `sweepMinutes` | How often the heartbeat starts a sweep: 60 by default, at least 30. |
| `forget` | Empties both stores once, at the next start; later starts keep what is added since. Set it back to `false` and on again to empty them again. |
| `youtubeKey` | A YouTube Data API key. |
| `naverClientId`, `naverClientSecret` | Your Naver Developers app's id and secret, for DataLab. |
| `googleTrendsKey` | Google's Trends API alpha key, if you have one (see below). |
| `redditClientId`, `redditSecret` | Your approved Reddit OAuth app's id and secret. |
| `threadsToken` | A Threads access token. |
| `pttBoard` | The PTT board the `ptt-board` list reads: Stock by default. |
| `pttAdultBoards` | Your own assertion that you are 18 or older, so Tavi may read PTT's 18+ boards (Gossiping, C_Chat …) with PTT's age cookie. Off by default. |

## Sources

| Source | Family | Reads | On by default |
| --- | --- | --- | --- |
| Hacker News (Algolia) | community | stories an hour, with 35 days of history; a sample; the front page | yes |
| Wikipedia pageviews | attention | a topic's articles' daily views; the most-read list of a country's edition | once `contact` is set |
| Wikidata | reference | a topic's names in other languages (it never votes) | once `contact` is set |
| GDELT | news | articles an hour, with history; a sample of headlines | yes |
| Google Trends: trending now | search | whether a topic is on a country's trending list now | yes |
| Bluesky post search | social | posts and distinct authors an hour; a sample: one page of up to 100 posts, newest first | yes |
| Bluesky trends | social | Bluesky's trending topics (an undocumented endpoint) | no |
| Mastodon trending tags | social | a hashtag's daily uses and accounts over a week | yes |
| arXiv | research | papers a day; a sample | yes |
| European public broadcasters' feeds | news | BBC, tagesschau, franceinfo, RaiNews, RTVE, NOS: stories an hour that name a topic | yes, for their countries |
| Brazilian news feeds | news | g1, Folha | yes, for Brazil |
| YouTube | social | videos and channels an hour (one page of 50); a region's most popular. Statistics kept 30 days | with `youtubeKey` |
| Naver DataLab | search | Korea's daily search ratio for a topic (100 is the 90 days' highest) | with Naver's id and secret |
| Reddit | community | posts and authors an hour from a search's newest 100; until 2027-03-01, when its public API ends | with an approved client and `contact` |
| Threads | social | posts and authors an hour from a search's newest 100. Without `threads_keyword_search` approved, only your own posts | with `threadsToken` |
| Google Trends API | search | nothing yet: Google publishes no reference for its alpha | — |

**Open-page lists** (`unofficial`, so each off until you add it to
`enabledSources`): a site's own hot list, read by the worker over plain HTTP,
never a browser. The worker reads the site's robots.txt first (once a day),
and reads nothing it disallows or whose `Content-Signal` says `ai-input=no`;
a refusal, a challenge page or a request to slow down leaves the source until
the next UTC day. A list counts, each sweep, how many of its entries name a
topic now; `snapshot` shows it.

| List | Family | Reads |
| --- | --- | --- |
| `baidu-hot` | search | Baidu's hot search (China). Its terms may bar automated access, so only when a person asks, never in a sweep the heartbeat starts |
| `hatena-hot` | community | Hatena Bookmark's hot entries (Japan), with bookmark counts; RSS, which its terms license |
| `ptt-board` | community | a PTT board's latest threads (Taiwan): `pttBoard`; an 18+ board only with `pttAdultBoards` |
| `pantip-hot` | community | Pantip's hot topics (Thailand), with views |
| `daum-top` | news | the stories on Daum's front page (Korea), the one path its robots.txt allows |

Kaskus's and ShareChat's lists are drawn in the browser, with no list in the
page for the worker to read, so neither is read (`sources` lists them with
the reason).

A keyed source is off until you add it to `enabledSources` and set its key;
`sources` says `needs: "key"` until then. Naver's search ratio spikes when its day is
twice its baseline as well as significant.

`trends.radar.sources` lists each source's terms, attribution, health
(`ok`, `auth`, `quota`, `blocked`, `schema`, `network`), today's requests
against its budget, and the sources left out with the reason (`excluded.json`:
Zhihu, Xiaohongshu, Telegram, LINE NEWS, Naver's news ranking and search API,
TikTok and LinkedIn; and Hacker News' Firebase API, left out only because
Algolia reads the same stories with counts and history).

**No paid service.** Tavi uses no source it would pay for: X, Yandex Wordstat
and Tavily's news search have no record (`sources` lists them as excluded,
with that reason), and the plugin refuses to ask any source that carries a
price. Every source here is free, keyed or not.

**Names in other languages.** With `contact` set, a topic across several
languages (its terms', and its countries') is looked up in Wikidata once a
month: its labels and aliases in each language widen what the sources are
asked, and its article in each edition is the one Wikipedia's pageviews read
when the topic names none. Your own terms are always asked first.

Every request goes through its source's budget, kept in the store across the
worker's idle stops: GDELT one request every five seconds, for example. A 429
pauses the source for the wait it asks; five failures in a row, or more than
half of a day's answers (of at least four) in a shape the plugin cannot read,
pause it for a day. A source whose daily budget is spent is said to be
exhausted, with when it refills, never answered as empty.

## Tools

| Tool | Does | Sends |
| --- | --- | --- |
| `trends.radar.sources` | The sources, their terms, health and budgets | nothing |
| `trends.radar.topics` | Your topics and their states | nothing |
| `trends.radar.watch` | Adds, updates, pauses, resumes or removes a topic. You approve every call, and the card shows the topic's label, terms, countries, sources and alert rule | nothing; it stores the topic |
| `trends.radar.sweep` | Reads the sources for your topics now and tests each | each source's query |
| `trends.radar.velocity` | A topic's series, baselines and every test's numbers | nothing |
| `trends.radar.compare` | Up to five topics' counts, by hour over 24 hours or by day over a week or a month, scaled to 100 at each series' peak | nothing |
| `trends.radar.snapshot` | What is trending now in a country | a country code |
| `trends.radar.search` | A dated sample for a phrase, with hourly counts where a source has them. A source read from a capped page (Bluesky's 100 posts) gives no count: it is listed under `samples`, with the hour the sample starts, so a week and a month are never compared on the same posts | the phrase |
| `trends.radar.brief` | Checks a brief before it is shown or sent | nothing |
| `trends.radar.cluster` | What a topic's items, or a set you relayed, say: themes with their shares and quotes | nothing |
| `trends.radar.profile` | A trending site's browser profile, and how to read it in your session | nothing |
| `trends.radar.ingest` | Keeps rows read in your browser for a day, after you approve every call | nothing; it stores the rows |

A topic is a subject: `{label, terms: {en: ["solid-state battery"]}}`, with
optional exclusions, Wikipedia articles, countries, sources and an alert rule.
A handle, an account, a mention, or the name of an author a read saw today is
refused as a term or a query. Up to 50
topics a person.

## Sites this app may browse

Some trending lists exist only in a browser. The plugin ships a profile for
each, every one off until you turn it on in Connected apps under *Sites this
app may browse*.

Two are read for you: `baidu-index` (you sign in) and `daum-realtime` (Daum's
live trend widget). Each is read only in your session, at your request: never
by a sweep, the heartbeat or a schedule, at most 3 pages a task and 10 a day,
10 seconds apart. The agent reads a page's JSON-LD first
(`browser.structured`), then the page with the profile's result schema
(`browser.extract`); a sign-in or a check is yours to pass in the live view.
It relays what it read with `trends.radar.ingest`, which you approve, naming
the profile they were read under: a row is kept only if its link is on that
site, so a page cannot name another outlet for a brief to cite. Those rows are
kept a day, cited "as read in the browser on <date>", and never counted toward
a spike, so nothing a page says can raise one.

Five are *assist-only*, because their terms bar reading them by program even
in your session: `weibo-hot` (Weibo's hot search), `douyin-hot`,
`bilibili-popular`, `dcard-popular` and `yahoojp-realtime` (not served in the
EEA or the UK). Turn a profile on and Tavi's browser refuses to open that
site; if you open one of its pages yourself, Tavi reads it for the chat only
and keeps nothing from it. Whether on or off, `trends.radar.ingest` refuses
rows read there, and the agent is told never to open them.

## What people say

`trends.radar.cluster` reads a topic's items of the last three days, or a set
the agent relayed with `ingest` from a site Trends has a profile for (rows from
any other host are dropped, so a comment page elsewhere is not taken in), and:

- sets aside exact copies, near-copies (MinHash at Jaccard 0.8 for a long
  text, SimHash within 3 bits for a short post), and coordinated bursts (the
  same text from 5 or more accounts within 10 minutes, said as "possible
  coordinated amplification"), and anything that names none of the topic's
  terms, counting each;
- groups the rest into themes by their words (TF-IDF, average-linkage
  clustering), a theme being at least 5 items or 2% of them;
- gives each theme its share of the valid items, its distinguishing words,
  and up to five quotes, verbatim, from different authors or outlets; and
  Other for what fits no theme. Themes and Other add up to every valid item.

It names no theme and scores no sentiment: the model names each theme from
its quotes, and `brief` checks what it then says. Nothing is said about a
person.

## How a spike is tested

Each sweep, for each topic and source, the engine:

1. takes the last 24 hours (a daily source's last full day);
2. draws a baseline from the same 24 hours of earlier weeks, scaled by how the
   last week ran, or else from the previous seven days' median;
3. tests the count against it: a negative binomial below a median of 50, a
   robust z above;
4. computes the growth over the previous seven days' median, smoothed:
   `(x + 5)/(b + 5) − 1`;
5. checks the family's floor (news 10, community 5, social 20, research 5;
   pageviews 1,000 and twice their 30-day median);
6. corrects every test of the sweep together (Benjamini–Hochberg, q = 0.05);
7. requires the count to beat the same hours yesterday and last week.

A topic is raised when a passing test grows past its rule (`growth`, 3 by
default: +300%), or it appears on Google's trending list. It is **signal**
with one family passing and **confirmed** with two or more. It falls quiet
after two calm sweeps, and is not raised again for 12 hours. `velocity` shows
every number. On the recorded spike set it confirms every two-family event,
three of five within 30 hours of onset, with no false confirmed alert.

## The heartbeat

The plugin adds the heartbeat signal source **spikes**. Each collection
answers at once with your topics that are confirmed (or signal, for a topic
whose rule is `allow_single_with_caveat`), titled like "Solid-state
batteries: +412% vs 7-day baseline (community, news)". It then starts the
next sweep in the background, at most every `sweepMinutes`; that sweep's
spikes are in the next collection. Nothing sweeps when the heartbeat is
quiet.

For a daily brief, add `trends.radar.velocity` and `trends.radar.brief` to
the heartbeat's extra tools: both read only the store. A check reads a
spiking topic's velocity, drafts up to five bullets citing the items behind
it, and passes them through `brief`.

## A daily digest

The simplest digest is a schedule that may call the four reads below and
delivers to Home, as in [Track a trend over weeks](use-cases/automation/trend-routine.md#4-get-a-digest-every-morning).

A routine (see [Agent routines](AUTOMATION.md#agent-routines)) can research your topics instead. Neither the
canvas's **New routine** form nor a chat can choose a plugin's report template, so it is made through the
owner's `routines` IPC command (`create` with a full snapshot): give its
revision `report.templateVersion: "trends-v1"` (the template this plugin's manifest contributes, copied into the revision when it is saved with the plugin running) and grant its research step
`trends.radar.sweep`, `trends.radar.velocity`, `trends.radar.cluster` and
`trends.radar.brief` in `permissions.researchTools` (each a read-only plugin
read, so a routine may be granted it). A run sweeps, looks at what is said
about each spiking topic, and selects claims that are sentences copied word
for word from the items `sweep` or `search` returned as `routineSources`;
Tavi records those as the run's evidence, says in the report that it did not
fetch those pages itself, and counts each plugin tool's sources as one source
toward `two_independent`, so a spike seen through one tool alone is not
reported as corroborated. The report is titled "Trends digest" and its PDF
is delivered as `trends-digest.pdf`.

Without a routine, a plain schedule gives a simpler daily digest in Home: at
the time you choose, auto-approving `trends.radar.sweep`,
`trends.radar.velocity`, `trends.radar.cluster` and `trends.radar.brief`. It
has no routine's evidence ledger or PDF; `brief` is what checks its bullets.
Ask for one in a chat ("every morning at 8, give me the trends digest") and
the agent creates it with `schedules.create`, after your approval; it lists,
pauses, resumes or cancels it the same way (`schedules.*`, see
[AUTOMATION.md](AUTOMATION.md#schedules)), or use `tavi schedules`.

## The brief checker

`trends.radar.brief` passes a brief only when every bullet:

- is one line of at most 280 characters, and cites items still kept;
- declares every quotation it shows, and each is verbatim in its item (a
  translation carries the item's own words);
- shows only growths a test computed, as `velocity` shows them;
- names where its claim comes from: a cited outlet ("Reuters reported"), a
  source ("per GDELT"), or "posts claim" for people's posts;
- if marked corroborated, cites two publishers (never an aggregator or a
  post).

It answers the brief with each bullet's sources (`outlet (date): URL`) and a
`briefId`, or the problems to fix.

## What it keeps

- `home/trends.db`: your topics, the counts per hour (35 days) and per day
  (400 days; YouTube's 30), every test (35 days), each source's health and
  budget, and Wikidata's names (30 days). It is
  backed up with the plugin's data.
- `home/cache/items.db`: the items read, for each source's cache window (at
  most three days; one day for Bluesky, Reddit and Threads). Backups leave
  `home/cache/` out. An author is kept only as a hash salted once a day, and
  the names a read gave for its authors that day (an id or a handle) only as such hashes, so that `watch` and `search` can
  refuse a term that is one.

## Architecture

`trends.radar` is built on `@tavi/domain-kit`, the statistical/clustering engine in `@tavi/trends-kit`, and the confined external plugin in `@tavi/plugin-trends`:

| Layer | Module / Path | Responsibility |
| :--- | :--- | :--- |
| **Domain Kit (`@tavi/domain-kit`)** | `packages/domain-kit/src/{worker,sqlite,budget,source-health,minhash,terms-test,xml,schema}.ts` | Shared confined-worker runtime helpers, SQLite store wrapper, per-source request budgets, circuit-breaker health tracking, and MinHash deduplication. |
| **Trends Kit (`@tavi/trends-kit`)** | `packages/trends-kit/src/{contracts,brief,records}.ts`, `packages/trends-kit/src/engine/*`, `packages/trends-kit/src/cluster/*`, `packages/trends-kit/src/sources/*`, `packages/trends-kit/src/store/*` | Negative-binomial / robust-z spike test with Benjamini–Hochberg FDR correction, MinHash/SimHash deduplication and TF-IDF average-linkage theme clustering, verbatim quote/corroboration `brief` checker, Wikidata cross-language alias expansion, source adapters, and `trends.db` / `items.db` stores. |
| **External Plugin (`@tavi/plugin-trends`)** | `packages/external/trends/src/{index,engine}.ts`, `packages/external/trends/tavi-plugin.json` | Registers the `trends.radar.*` tools, `spikes` heartbeat signal source, and trending-site browser profiles inside a confined plugin worker. |

See [PLUGINS.md#architecture](PLUGINS.md#architecture) and [ARCHITECTURE.md](ARCHITECTURE.md) for how confined external plugins run.
