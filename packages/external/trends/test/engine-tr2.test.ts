import { readFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { domainFixtures } from "@tavi/test-support/fixtures";
import {
  HN_ALGOLIA,
  REDDIT,
  THREADS,
  bucketsOf,
  failureOf,
  type AdapterTopic,
  type RawItem,
  type TrendsAdapter,
  type TrendsSourceRecord,
} from "@tavi/trends-kit";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Fetcher } from "../src/engine.js";

/**
 * The keyed sources in the engine: keys, no paid service, an OAuth
 * client's token, Reddit's sunset, and Wikidata's names for a topic across
 * languages. Fake sources on a clock the test moves.
 */
const SPIKE = "2026-10-17T00:00:00.000Z";
const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

/** A source counting `base` an hour, `spiked` from `SPIKE`; it remembers the topics it was asked. */
function fake(
  record: TrendsSourceRecord,
  metric: string,
  base: number,
  spiked: number,
  items: readonly RawItem[] = [],
  seen: AdapterTopic[] = [],
): TrendsAdapter {
  const host = record.hosts.at(-1) ?? "example.org";
  return {
    record,
    counts: {
      request: ({ topic, window }, call) => {
        seen.push(topic);
        return [
          {
            url: `https://${host}/counts?from=${window.from}`,
            expect: "json",
            headers: { Authorization: `Bearer ${call.token ?? call.credential(record.credential?.[0] ?? "") ?? ""}` },
          },
        ];
      },
      parse: (response, _request, { window }) =>
        failureOf(response, window.to) ?? {
          kind: "ok",
          value: [
            {
              metric,
              points: bucketsOf(window).map((start) => ({ start, value: start >= SPIKE ? spiked : base, quality: "ok" as const })),
            },
          ],
        },
    },
    sample: {
      request: ({ limit }) => [{ url: `https://${host}/sample?limit=${String(limit)}`, expect: "json" }],
      parse: (response, _request, { limit }) => failureOf(response, SPIKE) ?? { kind: "ok", value: items.slice(0, limit) },
    },
  };
}

function network(
  answers: Record<string, unknown> = {},
  statuses: Record<string, number> = {},
): { readonly fetcher: Fetcher; readonly asked: { url: string; headers: Record<string, string> }[] } {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  return {
    asked,
    fetcher: async (request) => {
      asked.push({ url: request.url, headers: { ...request.headers } });
      const status = Object.entries(statuses).find(([prefix]) => request.url.startsWith(prefix))?.[1] ?? 200;
      const body = Object.entries(answers).find(([prefix]) => request.url.startsWith(prefix))?.[1] ?? {};
      return { status, retryAfter: null, body, bytes: 2 };
    },
  };
}

function engine(
  fetcher: Fetcher,
  adapters: readonly TrendsAdapter[],
  config: Record<string, unknown>,
  keys: Record<string, string>,
  at = "2026-10-17T00:30:00.000Z",
) {
  const directory = temp.create("tavi-trends-tr2-");
  const clock = { ms: Date.parse(at) };
  const created = createEngine({
    home: directory,
    fetcher,
    config,
    version: "test",
    adapters,
    credential: async (key) => keys[key] ?? null,
    now: () => new Date(clock.ms).toISOString(),
    sleep: async (ms) => void (clock.ms += ms),
  });
  return Object.assign(created, { clock });
}
const operator = { scope: { principalId: "operator", workspaceId: "default" }, unattended: false };
const signal = () => new AbortController().signal;
const topic = { label: "Solid-state batteries", terms: { en: ["solid-state battery"] } };

describe("keys, and no paid service", () => {
  it("skips a keyed source until its key is set, then sends it as the source asks", async () => {
    const adapters = [fake(THREADS, "authors", 5, 50)];
    const keyless = engine(network().fetcher, adapters, { enabledSources: "threads" }, {});
    keyless.watch({ op: "add", topic }, operator);
    expect((await keyless.sweep({}, signal(), operator)).topics[0]?.sources).toEqual([
      { source: "threads", outcome: "skipped", why: "it needs its key: set threadsToken" },
    ]);
    expect((await keyless.sources({})).sources[0]).toMatchObject({ id: "threads", needs: "key" });
    keyless.close();

    const net = network();
    const radar = engine(net.fetcher, adapters, { enabledSources: "threads" }, { threadsToken: "THREADS-PLACEHOLDER" });
    radar.watch({ op: "add", topic }, operator);
    expect((await radar.sweep({}, signal(), operator)).topics[0]?.sources).toEqual([{ source: "threads", outcome: "ok" }]);
    expect(net.asked.map((request) => request.headers["Authorization"])).toEqual(["Bearer THREADS-PLACEHOLDER"]);
    // No key's value is ever in what sources says.
    expect(JSON.stringify(await radar.sources({}))).not.toContain("THREADS-PLACEHOLDER");
    radar.close();
  });

  it("never asks a source with a price, whatever it is given", async () => {
    const priced = fake(
      { ...THREADS, id: "priced-source", trends: { ...THREADS.trends, cost: { unit: "request", usdPerUnit: 0.005, freeUnitsPerDay: 0 } } },
      "authors",
      5,
      50,
    );
    const net = network();
    const radar = engine(net.fetcher, [priced], { enabledSources: "priced-source" }, { threadsToken: "t" });
    radar.watch({ op: "add", topic }, operator);
    expect((await radar.sweep({}, signal(), operator)).topics[0]?.sources).toEqual([
      { source: "priced-source", outcome: "skipped", why: "it is a paid service, which Tavi does not use" },
    ]);
    expect(net.asked).toEqual([]);
    radar.close();
  });
});

describe("an OAuth client's token, and a source's sunset", () => {
  const withToken = (): TrendsAdapter => ({
    ...fake(REDDIT, "authors", 2, 2),
    authorize: {
      request: (_input, call) => [
        {
          url: "https://www.reddit.com/api/v1/access_token",
          method: "POST",
          body: "grant_type=client_credentials",
          headers: {
            Authorization: `Basic ${Buffer.from(`${call.credential("redditClientId") ?? ""}:${call.credential("redditSecret") ?? ""}`).toString("base64")}`,
          },
          expect: "json",
        },
      ],
      parse: (response, _request, _input, call) =>
        failureOf(response, call.now) ?? {
          kind: "ok",
          value: { token: String((response.body as { access_token?: string }).access_token), expiresInMs: 3_600_000 },
        },
    },
  });

  it("asks for a token once while it holds, uses it, and asks again after the source refuses it", async () => {
    const net = network({ "https://www.reddit.com/api/v1/access_token": { access_token: "tok-1", expires_in: 3600 } });
    const radar = engine(
      net.fetcher,
      [withToken()],
      { enabledSources: "reddit", contact: "me@example.org" },
      { redditClientId: "rid", redditSecret: "rsecret" },
    );
    radar.watch({ op: "add", topic }, operator);
    await radar.sweep({}, signal(), operator);
    radar.clock.ms += 30 * 60_000;
    await radar.sweep({}, signal(), operator);
    expect(net.asked.map((request) => [new URL(request.url).pathname, request.headers["Authorization"]])).toEqual([
      ["/api/v1/access_token", `Basic ${Buffer.from("rid:rsecret").toString("base64")}`],
      ["/counts", "Bearer tok-1"],
      ["/counts", "Bearer tok-1"],
    ]);
    radar.close();

    const refusing = network(
      { "https://www.reddit.com/api/v1/access_token": { access_token: "tok-2" } },
      { "https://oauth.reddit.com/": 401 },
    );
    const again = engine(
      refusing.fetcher,
      [withToken()],
      { enabledSources: "reddit", contact: "me@example.org" },
      { redditClientId: "rid", redditSecret: "rsecret" },
    );
    again.watch({ op: "add", topic }, operator);
    expect((await again.sweep({}, signal(), operator)).topics[0]?.sources[0]).toEqual({ source: "reddit", outcome: "failed", why: "auth" });
    again.clock.ms += 10 * 60_000;
    await again.sweep({}, signal(), operator);
    expect(refusing.asked.filter((request) => request.url.endsWith("/access_token"))).toHaveLength(2);
    again.close();
  });

  it("reads Reddit for nobody from its sunset on", async () => {
    const net = network();
    const radar = engine(
      net.fetcher,
      [withToken()],
      { enabledSources: "reddit", contact: "me@example.org" },
      { redditClientId: "rid", redditSecret: "rsecret" },
      "2027-03-01T08:00:00.000Z",
    );
    radar.watch({ op: "add", topic }, operator);
    expect((await radar.sweep({}, signal(), operator)).topics[0]?.sources).toEqual([
      { source: "reddit", outcome: "skipped", why: "its access ended on 2027-03-01" },
    ]);
    expect(net.asked).toEqual([]);
    radar.close();
  });
});

describe("Wikidata's names for a topic across languages", () => {
  const entity = {
    entities: {
      Q7569: {
        labels: { en: { value: "solid-state battery" }, ja: { value: "全固体電池" }, de: { value: "Festkörperbatterie" } },
        aliases: { de: [{ value: "Feststoffakku" }] },
        sitelinks: {
          enwiki: { title: "Solid-state battery" },
          dewiki: { title: "Festkörperakkumulator" },
          frwiki: { title: "Batterie à électrolyte solide" },
        },
      },
    },
  };

  it("asks the sources in every language the topic's countries speak, with each edition's article, cached 30 days", async () => {
    const seen: AdapterTopic[] = [];
    const net = network({
      "https://www.wikidata.org/w/api.php?action=wbsearchentities": { search: [{ id: "Q7569" }] },
      "https://www.wikidata.org/w/api.php?action=wbgetentities": entity,
    });
    const radar = engine(net.fetcher, [fake(HN_ALGOLIA, "stories", 2, 2, [], seen)], { contact: "me@example.org" }, {});
    radar.watch({ op: "add", topic: { ...topic, countries: ["US", "DE"] } }, operator);
    await radar.sweep({}, signal(), operator);
    expect(seen[0]).toMatchObject({
      termsByLanguage: { en: ["solid-state battery"], de: ["Festkörperbatterie", "Feststoffakku"] },
      articles: { "en.wikipedia": "Solid-state battery", "de.wikipedia": "Festkörperakkumulator" },
    });
    // The person's own term is asked first.
    expect(seen[0]?.terms[0]).toBe("solid-state battery");
    const wikidata = net.asked.filter((request) => request.url.startsWith("https://www.wikidata.org/"));
    expect(wikidata.map((request) => new URL(request.url).searchParams.get("action"))).toEqual(["wbsearchentities", "wbgetentities"]);
    radar.clock.ms += 3_600_000;
    await radar.sweep({}, signal(), operator);
    expect(net.asked.filter((request) => request.url.startsWith("https://www.wikidata.org/"))).toHaveLength(2);
    radar.close();
  });

  it("expands an English and a Japanese topic through one entity's recorded labels to the same articles, and so the same series", async () => {
    const recorded = (file: string): unknown => JSON.parse(readFileSync(join(domainFixtures("trends"), "wikidata", file), "utf8"));
    const seen: AdapterTopic[] = [];
    const net = network({
      "https://www.wikidata.org/w/api.php?action=wbsearchentities": recorded("search.json"),
      "https://www.wikidata.org/w/api.php?action=wbgetentities": recorded("entity.json"),
    });
    const radar = engine(net.fetcher, [fake(HN_ALGOLIA, "stories", 2, 2, [], seen)], { contact: "me@example.org" }, {});
    radar.watch(
      { op: "add", topic: { label: "Solid-state batteries", terms: { en: ["solid-state battery"] }, countries: ["US", "JP"] } },
      operator,
    );
    radar.watch({ op: "add", topic: { label: "全固体電池", terms: { ja: ["全固体電池"] }, countries: ["JP", "US"] } }, operator);
    await radar.sweep({}, signal(), operator);
    const [english, japanese] = seen;
    expect(english?.termsByLanguage).toMatchObject({
      en: expect.arrayContaining(["solid-state battery"]),
      ja: expect.arrayContaining(["全固体電池"]),
    });
    expect(japanese?.termsByLanguage).toMatchObject({
      en: expect.arrayContaining(["solid-state battery"]),
      ja: expect.arrayContaining(["全固体電池"]),
    });
    expect(japanese?.articles).toEqual(english?.articles);
    expect(Object.keys(english?.articles ?? {})).toEqual(expect.arrayContaining(["en.wikipedia", "ja.wikipedia"]));
    radar.close();
  });

  it("asks nothing of Wikidata without the operator's contact, or for a topic in one language", async () => {
    const seen: AdapterTopic[] = [];
    const net = network();
    const radar = engine(net.fetcher, [fake(HN_ALGOLIA, "stories", 2, 2, [], seen)], {}, {});
    radar.watch({ op: "add", topic: { ...topic, countries: ["US", "DE"] } }, operator);
    await radar.sweep({}, signal(), operator);
    const single = engine(net.fetcher, [fake(HN_ALGOLIA, "stories", 2, 2, [], seen)], { contact: "me@example.org" }, {});
    single.watch({ op: "add", topic: { ...topic, countries: ["US"] } }, operator);
    await single.sweep({}, signal(), operator);
    expect(net.asked.filter((request) => request.url.startsWith("https://www.wikidata.org/"))).toEqual([]);
    expect(seen.map((each) => each.termsByLanguage)).toEqual([{ en: ["solid-state battery"] }, { en: ["solid-state battery"] }]);
    radar.close();
    single.close();
  });
});
