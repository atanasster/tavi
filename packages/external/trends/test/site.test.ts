import { temporaryDirectories } from "@tavi/test-support";
import { HATENA_HOT, TrendsSourceRecordSchema, listAdapter, type ListSpec, type TrendsAdapter } from "@tavi/trends-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEngine } from "../src/engine.js";
import { workerFetcher } from "../src/index.js";
import { startTrendsSite } from "./fixture-site/server.mjs";

/**
 * The list adapter over real HTTP, with the
 * worker's own fetch against the local trending site: RSS, JSON and both
 * embedded-JSON markers read; robots.txt asked first, its sub-paths refused
 * while its root and lists are read; a redirect followed hop by hop; a 429
 * leaving the list until tomorrow.
 */
let site: Awaited<ReturnType<typeof startTrendsSite>>;
const temp = temporaryDirectories();
beforeAll(async () => {
  site = await startTrendsSite();
});
afterAll(async () => {
  await site.close();
  temp.cleanup();
});

const list = (id: string, spec: Omit<ListSpec, "recordId" | "settings" | "cookies" | "refusedWhen">): TrendsAdapter => {
  const record = TrendsSourceRecordSchema.parse({
    ...HATENA_HOT,
    id,
    name: id,
    countries: ["*"],
    hosts: [`127.0.0.1:${String(site.port)}`],
    budget: { perSecond: 10, perDay: 1_000 },
  });
  return listAdapter(record, { ...spec, recordId: id, settings: [], cookies: [], refusedWhen: [] });
};
const operator = { scope: { principalId: "operator", workspaceId: "default" }, unattended: false };

function radar(lists: readonly TrendsAdapter[]) {
  const home = temp.create("tavi-trends-site-");
  return createEngine({
    home,
    fetcher: workerFetcher,
    config: { enabledSources: lists.map((adapter) => adapter.record.id).join(",") },
    version: "test",
    adapters: [],
    lists,
    now: () => "2026-10-17T12:00:00.000Z",
  });
}

describe("the list adapter against the local site", () => {
  it("reads an RSS list, a JSON list and both embedded-JSON lists, robots.txt asked once", async () => {
    const lists = [
      list("fixture-rss", { url: `${site.origin}/hot.rss`, extract: { mode: "rss" }, map: { title: "title" } }),
      list("fixture-json", {
        url: `${site.origin}/api/hot`,
        extract: { mode: "json", path: "$.data.cards[0].content[0].content[*]" },
        map: { title: "word", url: "url", rank: "index" },
      }),
      list("fixture-sdata", {
        url: `${site.origin}/s-data`,
        extract: { mode: "embedded-json", marker: "<!--s-data:", path: "$.data.list[*]" },
        map: { title: "word", url: "url", metric: "hot" },
      }),
      list("fixture-tiller", {
        url: `${site.origin}/tiller`,
        extract: { mode: "embedded-json", marker: "window.tillerInitData=", path: "$..contents.data[*]" },
        map: { title: "title", url: "url" },
      }),
    ];
    const engine = radar(lists);
    const asked = site.asked.length;
    const snapshot = await engine.snapshot({ country: "TW" }, new AbortController().signal, operator);
    expect(snapshot.sources.every((source) => source.outcome === "ok")).toBe(true);
    expect(snapshot.lists.map((each) => [each.source, each.entries.map((entry) => entry.title)])).toEqual(
      lists.map((adapter) => [adapter.record.id, ["Typhoon Koinu nears Taiwan", "Solid-state battery pilot line", "Night market prices"]]),
    );
    expect(snapshot.lists.find((each) => each.source === "fixture-sdata")?.entries[0]).toMatchObject({
      url: `${site.origin}/topic/1`,
      volume: "980000",
    });
    expect(site.asked.slice(asked)).toEqual(["/robots.txt", "/hot.rss", "/api/hot", "/s-data", "/tiller"]);
    engine.close();
  });

  it("refuses a sub-path robots.txt disallows, follows a redirect it allows, and leaves a 429 until tomorrow", async () => {
    const engine = radar([
      list("fixture-dom", { url: `${site.origin}/dom`, extract: { mode: "anchors", href: "^/topic/\\d$" }, map: { title: "title" } }),
      list("fixture-moved", { url: `${site.origin}/moved`, extract: { mode: "rss" }, map: { title: "title" } }),
    ]);
    const asked = site.asked.length;
    const snapshot = await engine.snapshot({ country: "TW" }, new AbortController().signal, operator);
    expect(snapshot.sources).toEqual([
      { source: "fixture-dom", outcome: "skipped", why: "its robots.txt disallows /dom" },
      { source: "fixture-moved", outcome: "ok" },
    ]);
    expect(snapshot.lists.map((each) => each.entries.length)).toEqual([3]);
    expect(site.asked.slice(asked)).toEqual(["/robots.txt", "/moved", "/hot.rss"]);
    engine.close();

    const busy = radar([list("fixture-busy", { url: `${site.origin}/busy`, extract: { mode: "rss" }, map: { title: "title" } })]);
    expect((await busy.snapshot({ country: "TW" }, new AbortController().signal, operator)).sources).toEqual([
      { source: "fixture-busy", outcome: "failed", why: "quota" },
    ]);
    // Its Retry-After asks two minutes; an open page that asks to slow down is left until tomorrow.
    expect((await busy.sources({})).sources[0]).toMatchObject({
      id: "fixture-busy",
      health: "quota",
      pausedUntil: "2026-10-18T00:00:00.000Z",
    });
    busy.close();
  });
});
